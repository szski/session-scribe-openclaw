#!/usr/bin/env node
/**
 * session-scribe — summarize OpenClaw session transcripts into daily memory files.
 *
 * Usage:
 *   node scribe.js --sessions ~/.openclaw/agents/main/sessions \
 *                  --session-id <uuid> \
 *                  --memory-dir ~/.openclaw/workspace/memory
 *
 *   node scribe.js --sessions ~/.openclaw/agents/main/sessions \
 *                  --auto-session "discord:channel:1234567890" \
 *                  --memory-dir ~/.openclaw/workspace/memory
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has = (flag) => args.includes(flag);

const sessionsDir  = get('--sessions');
const sessionIdArg = get('--session-id');
const autoSession  = get('--auto-session');
const memoryDir    = get('--memory-dir');
const model        = get('--model') || 'gpt-4o-mini';
const agentLabel   = get('--agent') || 'agent';
const dryRun       = has('--dry-run');
const minTurns     = parseInt(get('--min-turns') || '3', 10);

// Provider: anthropic (default) or openai
const provider = get('--provider') || (process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY ? 'openai' : 'anthropic');

// API key resolution: env var, --api-key flag, or --api-key-file
let apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || get('--api-key');
const apiKeyFile = get('--api-key-file');
if (!apiKey && apiKeyFile) {
  try { apiKey = fs.readFileSync(apiKeyFile, 'utf8').trim(); }
  catch (e) { console.error('Failed to read api key file:', e.message); process.exit(1); }
}

if (!sessionsDir) { console.error('Error: --sessions required'); process.exit(1); }
if (!memoryDir)   { console.error('Error: --memory-dir required'); process.exit(1); }
if (!sessionIdArg && !autoSession) { console.error('Error: --session-id or --auto-session required'); process.exit(1); }
if (!apiKey)      { console.error('Error: No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY (or use --api-key / --api-key-file)'); process.exit(1); }

// ── State ─────────────────────────────────────────────────────────────────────

const stateFile = path.join(path.dirname(__filename), '.scribe-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ── Session resolution ────────────────────────────────────────────────────────

function resolveSessionId() {
  if (sessionIdArg) return sessionIdArg;

  // Auto-resolve: read sessions.json, find entry whose key contains autoSession suffix
  const sessionsJson = path.join(sessionsDir, 'sessions.json');
  if (!fs.existsSync(sessionsJson)) {
    console.error('sessions.json not found at', sessionsJson);
    process.exit(1);
  }

  const sessions = JSON.parse(fs.readFileSync(sessionsJson, 'utf8'));
  const match = Object.entries(sessions).find(([key]) => key.includes(autoSession));
  if (!match) {
    console.error(`No session found matching key suffix: ${autoSession}`);
    console.error('Available keys:', Object.keys(sessions).slice(0, 10).join('\n'));
    process.exit(1);
  }

  console.log(`Auto-resolved session: ${match[0]} -> ${match[1].sessionId}`);
  return match[1].sessionId;
}

// ── Transcript reading ────────────────────────────────────────────────────────

function readTranscript(sessionId) {
  const file = path.join(sessionsDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) {
    console.error(`Transcript not found: ${file}`);
    process.exit(1);
  }

  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function extractTurns(entries, afterIndex = 0) {
  const turns = [];
  entries.slice(afterIndex).forEach((entry, i) => {
    const absIndex = afterIndex + i;

    // OpenClaw transcript uses type="message" with message.role = "user"|"assistant"
    if (entry.type !== 'message') return;
    const role = entry.message?.role;
    if (role !== 'user' && role !== 'assistant') return;

    const content = entry.message?.content;
    let text = '';

    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join(' ');
    }

    text = text.trim();
    if (!text) return;
    if (text.startsWith('NO_REPLY')) return;

    // Strip OpenClaw metadata envelope from user messages (untrusted context blocks)
    if (role === 'user') {
      // Remove JSON metadata blocks and EXTERNAL_UNTRUSTED_CONTENT wrappers
      text = text
        .replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\n/g, '')
        .replace(/Sender \(untrusted metadata\):[\s\S]*?```\n/g, '')
        .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?>>>/g, '')
        .replace(/Untrusted context[\s\S]*?>>>/g, '')
        .replace(/Replied message[\s\S]*?```\n/g, '')
        .trim();
      if (!text) return;
      turns.push({ role: 'user', text: text.slice(0, 800), index: absIndex });
    } else {
      turns.push({ role: 'assistant', text: text.slice(0, 1500), index: absIndex });
    }
  });
  return turns;
}

// ── LLM API call (Anthropic or OpenAI) ───────────────────────────────────────

function httpPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Failed to parse response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function llmRequest(prompt) {
  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  let options, response;

  if (provider === 'openai') {
    options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    response = await httpPost(options, body);
    if (response.error) throw new Error(response.error.message);
    return response.choices?.[0]?.message?.content || '';
  } else {
    options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    response = await httpPost(options, body);
    if (response.error) throw new Error(response.error.message);
    return response.content?.[0]?.text || '';
  }
}

async function summarize(turns) {
  const conversation = turns.map(t =>
    `${t.role === 'user' ? 'Kitsune' : 'Agent'}: ${t.text}`
  ).join('\n\n');

  const prompt = `You are a memory scribe for an AI agent. Extract key events, decisions, facts, and actions from this conversation excerpt. Write concise bullet points (10-20 max). Focus on: things created/built, decisions made, problems solved, important facts learned, notable exchanges. Skip small talk. Be specific and factual.

Conversation:
${conversation}

Output ONLY bullet points starting with "- ". No headers, no preamble.`;

  return llmRequest(prompt);
}

// ── Memory file writing ───────────────────────────────────────────────────────

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function appendToMemory(summary, sessionId) {
  const date = todayDate();
  const file = path.join(memoryDir, `${date}.md`);
  const timestamp = new Date().toISOString().slice(11, 16) + ' UTC';

  const header = fs.existsSync(file) ? '' : `# ${date}\n\n`;
  const block = `\n## Scribe update [${timestamp}] (${agentLabel})\n\n${summary}\n`;

  fs.mkdirSync(memoryDir, { recursive: true });
  fs.appendFileSync(file, header + block);
  return file;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const sessionId = resolveSessionId();
  const stateKey = sessionId;
  const state = loadState();
  const lastIndex = state[stateKey]?.lastIndex || 0;

  const entries = readTranscript(sessionId);
  const turns = extractTurns(entries, lastIndex);

  if (turns.length < minTurns) {
    console.log(`Only ${turns.length} new turn(s) (min: ${minTurns}) — skipping.`);
    return;
  }

  console.log(`Scribing ${turns.length} new turn(s) from session ${sessionId}...`);

  console.log(`Using provider: ${provider}, model: ${model}`);
  const summary = await summarize(turns);

  if (!summary.trim()) {
    console.log('No summary generated — nothing to write.');
    return;
  }

  if (dryRun) {
    console.log('\n--- DRY RUN ---');
    console.log(summary);
    console.log('--- END ---');
    return;
  }

  const file = appendToMemory(summary, sessionId);
  const lastEntry = turns[turns.length - 1];
  state[stateKey] = { lastIndex: lastEntry.index + 1, lastRunAt: new Date().toISOString() };
  saveState(state);

  console.log(`✅ Appended ${turns.length} turns → ${file}`);
}

main().catch(e => { console.error('Scribe error:', e.message); process.exit(1); });
