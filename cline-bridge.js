#!/usr/bin/env node
const http = require('http');
const https = require('https');

const PORT = 4000;
const RULES_URL = 'https://raw.githubusercontent.com/AMAMazing/cline-x/main/unified_rules.txt';
const FENCE = String.fromCharCode(96).repeat(3);

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

  if (cleaned.startsWith(FENCE)) {
    const firstNewline = cleaned.indexOf('\n');
    cleaned = firstNewline !== -1 ? cleaned.slice(firstNewline + 1) : cleaned.slice(3);
  }
  if (cleaned.endsWith(FENCE)) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  let thinkingBlock = '';
  const thinkingMatch = cleaned.match(/<thinking>[\s\S]*?<\/thinking>/);
  if (thinkingMatch) {
    thinkingBlock = thinkingMatch[0];
    cleaned = cleaned.replace(thinkingMatch[0], '').trim();
  }

  const toolNames = [
    'execute_command',
    'read_file',
    'write_to_file',
    'replace_in_file',
    'search_files',
    'list_files',
    'list_code_definition_names',
    'browser_action',
    'use_mcp_tool',
    'access_mcp_resource',
    'ask_followup_question',
    'attempt_completion',
    'plan_mode_respond'
  ];

  const toolRegex = new RegExp(`<(${toolNames.join('|')})>[\\s\\S]*?<\\/\\1>`, 'g');
  const matches = [...cleaned.matchAll(toolRegex)];

  if (matches.length <= 1) {
    const full = [thinkingBlock, cleaned].filter(Boolean).join('\n\n');
    return [full];
  }

  const steps = matches.map((m, idx) => {
    if (idx === 0 && thinkingBlock) {
      return `${thinkingBlock}\n${m[0]}`;
    }
    return m[0];
  });

  console.log(
    `\n⚡ [MULTI-TOOL COMPILER] Detected ${steps.length} batched tool calls! Queuing ${steps.length - 1} follow-up tool(s) automatically.`
  );
  return steps;
}

// Send OpenAI-compatible response (supports both streaming SSE and JSON)
function sendOpenAIResponse(res, isStream, content, model = 'cline-headless-bridge') {
  const id = 'chatcmpl-' + Date.now();
  const created = Math.floor(Date.now() / 1000);

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);

    const endChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
    };
    res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
      })
    );
  }
}

const WEB_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Cline Manual Clipboard Bridge</title>
  <style>
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    body { background: #0d1117; color: #e6edf3; margin: 0; padding: 24px; max-width: 1100px; margin-inline: auto; }
    h1 { margin-top: 0; font-size: 22px; display: flex; align-items: center; gap: 12px; }
    .badge { padding: 4px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
    .waiting { background: #238636; color: #fff; animation: pulse 1.5s infinite; }
    .idle { background: #30363d; color: #8b949e; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.65; } }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 16px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .btn { border: none; border-radius: 8px; padding: 14px 18px; font-size: 15px; font-weight: 700; cursor: pointer; transition: 0.15s; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .btn-copy { background: #1f6feb; color: white; }
    .btn-copy:hover { background: #388bfd; }
    .btn-send { background: #238636; color: white; }
    .btn-send:hover { background: #2ea043; }
    .btn-secondary { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; font-size: 13px; padding: 10px; }
    .btn-secondary:hover { background: #30363d; }
    textarea { width: 100%; height: 340px; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 10px; font-family: monospace; font-size: 12px; resize: vertical; }
    .toast { font-size: 13px; color: #58a6ff; min-height: 20px; }
  </style>
</head>
<body>
  <h1>
    <span>⚡ Cline Headless Clipboard Bridge</span>
    <span id="statusBadge" class="badge idle">Idle (Waiting for Cline request)</span>
  </h1>
  <div class="toast" id="toast">Ready. Configure Cline to use OpenAI Compatible -> Base URL: http://localhost:4000/v1</div>

  <div class="grid">
    <div class="card">
      <h3 style="margin:0">1. Incoming Prompt from Cline (+ unified_rules.txt)</h3>
      <button class="btn btn-copy" onclick="copyPrompt()">📋 Copy Full Prompt to Clipboard</button>
      <textarea id="promptBox" readonly placeholder="When you send a message in Cline, the full harness + unified_rules.txt will appear here and auto-copy..."></textarea>
    </div>

    <div class="card">
      <h3 style="margin:0">2. Send LLM Response Back to Cline</h3>
      <button class="btn btn-send" onclick="pasteAndSend()">🚀 Read My Clipboard & Send to Cline</button>
      <textarea id="responseBox" placeholder="Or manually paste the LLM's response here and click 'Send Textarea Content to Cline' below..."></textarea>
      <button class="btn btn-secondary" onclick="sendManualText()">Send Textarea Content to Cline</button>
    </div>
  </div>

  <script>
    let currentVersion = 0;

    async function pollState() {
      try {
        const res = await fetch('/api/state');
        const data = await res.json();
        const badge = document.getElementById('statusBadge');

        if (data.waiting) {
          badge.className = 'badge waiting';
          badge.textContent = '🟢 Cline is Waiting for LLM Response! (Prompt #' + data.version + ')';
        } else {
          badge.className = 'badge idle';
          badge.textContent = 'Idle (Queued batched tools: ' + data.queuedTools + ')';
        }

        if (data.version > currentVersion && data.prompt) {
          currentVersion = data.version;
          document.getElementById('promptBox').value = data.prompt;
          try {
            await navigator.clipboard.writeText(data.prompt);
            showToast('✅ New Cline prompt intercepted & AUTOMATICALLY copied to your clipboard!');
          } catch (err) {
            showToast('⚠️ New Cline prompt ready! Click "Copy Full Prompt to Clipboard" button.');
          }
        }
      } catch (e) {}
    }

    function showToast(msg) {
      document.getElementById('toast').textContent = msg;
    }

    async function copyPrompt() {
      const text = document.getElementById('promptBox').value;
      if (!text) return showToast('❌ No prompt received from Cline yet.');
      await navigator.clipboard.writeText(text);
      showToast('✅ Full Cline Prompt + Protocol copied to clipboard!');
    }

    async function pasteAndSend() {
      try {
        const clipText = await navigator.clipboard.readText();
        if (!clipText.trim()) {
          return showToast('❌ Clipboard is empty! Paste into the box manually if browser blocked clipboard read.');
        }
        document.getElementById('responseBox').value = clipText;
        await submitToServer(clipText);
      } catch (err) {
        showToast('⚠️ Browser requested permission or blocked clipboard read. Paste into the right box and click "Send Textarea Content".');
      }
    }

    async function sendManualText() {
      const text = document.getElementById('responseBox').value;
      if (!text.trim()) return showToast('❌ Textarea is empty!');
      await submitToServer(text);
    }

    async function submitToServer(text) {
      const res = await fetch('/api/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: text })
      });
      const data = await res.json();
      if (data.ok) {
        showToast('🚀 Sent to Cline! (' + data.batchCount + ' tool call(s) parsed & queued)');
        document.getElementById('responseBox').value = '';
      } else {
        showToast('❌ ' + (data.error || 'Failed to send'));
      }
    }

    setInterval(pollState, 800);
    pollState();
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(WEB_UI_HTML);
  }

  if (req.method === 'GET' && req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        waiting: Boolean(pendingResolver),
        version: promptVersion,
        prompt: latestCompiledPrompt,
        queuedTools: toolBatchQueue.length
      })
    );
  }

  if (req.method === 'POST' && req.url === '/api/respond') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const { response } = JSON.parse(body);
        if (!pendingResolver) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Cline is not currently waiting for a response.' }));
        }

        const steps = parseAndQueueLLMResponse(response);
        const firstStep = steps.shift();
        toolBatchQueue = steps;

        const resolve = pendingResolver;
        pendingResolver = null;
        resolve(firstStep);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, batchCount: steps.length + 1 }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'cline-headless-bridge', object: 'model', created: 1700000000, owned_by: 'user' }]
      })
    );
  }

  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const messages = payload.messages || [];
        const isStream = Boolean(payload.stream);

        const lastMsg = messages[messages.length - 1];
        const lastContentStr = JSON.stringify(lastMsg?.content || '');
        const hasError = lastContentStr.includes('Error executing') || lastContentStr.includes('The user denied');

        if (toolBatchQueue.length > 0 && !hasError) {
          const nextToolXml = toolBatchQueue.shift();
          console.log(
            `⚡ [MULTI-TOOL COMPILER] Auto-sending next queued tool (${toolBatchQueue.length} remaining in batch)...`
          );
          return sendOpenAIResponse(res, isStream, nextToolXml, payload.model);
        } else if (hasError && toolBatchQueue.length > 0) {
          console.log(
            `⚠️ [MULTI-TOOL COMPILER] Tool error or denial detected. Clearing remaining ${toolBatchQueue.length} queued tool(s).`
          );
          toolBatchQueue = [];
        }

        latestCompiledPrompt = await formatMessagesToPrompt(messages);
        promptVersion++;

        copyViaOSC52(latestCompiledPrompt);

        console.log(`\n============================================================`);
        console.log(`📥 [PROMPT #${promptVersion} INTERCEPTED FROM CLINE]`);
        console.log(`📋 Copied via OSC 52 & sent to Web Control Panel (http://localhost:${PORT})`);
        console.log(`⏳ Waiting for you to click "Read My Clipboard & Send to Cline"...`);
        console.log(`============================================================\n`);

        if (pendingResolver) {
          pendingResolver = null;
        }

        const llmResponseText = await new Promise((resolve) => {
          pendingResolver = resolve;
        });

        console.log(`✅ [PROMPT #${promptVersion}] Response sent back to Cline!`);
        sendOpenAIResponse(res, isStream, llmResponseText, payload.model);
      } catch (err) {
        console.error('Error handling chat completion:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

fetchUnifiedRules().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Cline Headless Clipboard Bridge running on http://localhost:${PORT}`);
    console.log(`🔗 Open Control Panel: http://localhost:${PORT}`);
    console.log(`⚙️  In Cline Settings:`);
    console.log(`   - API Provider: OpenAI Compatible`);
    console.log(`   - Base URL:     http://localhost:${PORT}/v1`);
    console.log(`   - API Key:      any-key`);
    console.log(`   - Model ID:     cline-headless-bridge\n`);
  });
});
