#!/usr/bin/env node
const http = require('http');
const https = require('https');

const PORT = 4000;
const RULES_URL = 'https://raw.githubusercontent.com/AMAMazing/cline-x/main/unified_rules.txt';

let cachedRules = '';
let pendingResolver = null;
let latestCompiledPrompt = '';
let promptVersion = 0;
let toolBatchQueue = [];

// Fetch unified_rules.txt from GitHub
function fetchUnifiedRules() {
  return new Promise((resolve) => {
    https
      .get(RULES_URL, (res) => {
        if (res.statusCode !== 200) {
          console.warn(`⚠️ Failed to fetch rules (HTTP ${res.statusCode}). Using cached/fallback rules.`);
          return resolve(cachedRules);
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          cachedRules = data.trim();
          console.log(`📜 Loaded unified_rules.txt from GitHub (${cachedRules.length} chars)`);
          resolve(cachedRules);
        });
      })
      .on('error', (err) => {
        console.warn(`⚠️ Error fetching rules: ${err.message}`);
        resolve(cachedRules);
      });
  });
}

// Copy to VS Code / Codespaces terminal clipboard via OSC 52 escape sequence
function copyViaOSC52(text) {
  try {
    const base64 = Buffer.from(text, 'utf8').toString('base64');
    process.stdout.write(`\x1b]52;c;${base64}\x07`);
  } catch (e) {}
}

// Format OpenAI messages array from Cline + unified_rules.txt into a single prompt
async function formatMessagesToPrompt(messages) {
  const rulesText = cachedRules || (await fetchUnifiedRules());
  let out = [];

  for (const msg of messages) {
    const role = (msg.role || 'user').toUpperCase();
    let contentText = '';
    if (typeof msg.content === 'string') {
      contentText = msg.content;
    } else if (Array.isArray(msg.content)) {
      contentText = msg.content
        .map((part) => (part.type === 'text' ? part.text : JSON.stringify(part)))
        .join('\n');
    }
    out.push(
      `================================================================================\n[${role}]\n================================================================================\n${contentText}`
    );
  }

  out.push(
    `================================================================================\n[CRITICAL OUTPUT PROTOCOL & OVERRIDE INSTRUCTIONS]\n================================================================================\n${rulesText}`
  );

  return out.join('\n\n');
}

// Parse and split batched XML tool calls from the LLM's single-codeblock response
function parseAndQueueLLMResponse(rawText) {
  let cleaned = rawText.trim();

  if (cleaned.startsWith('