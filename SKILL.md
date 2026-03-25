---
name: session-scribe
description: Automatically summarize active OpenClaw session transcripts into daily memory files using a cheap LLM (Haiku/Sonnet). Run as a system cron job — reads new transcript entries since last run, summarizes them via direct Anthropic API call, and appends bullet-point notes to a daily memory file. Designed to pair with the supermemory skill for full memory pipeline automation. Use when you want session context preserved without relying on agent self-reporting.
metadata:
  openclaw:
    emoji: "📝"
    requires:
      bins: ["node"]
      env: ["ANTHROPIC_API_KEY"]
    primaryEnv: "ANTHROPIC_API_KEY"
---

# session-scribe

Reads OpenClaw session transcripts and writes summarized bullet points to a daily memory file — automatically, via system cron.

No gateway involvement. No context bloat. Just cheap, reliable scribing.

## How it works

1. Reads `<sessions-dir>/<session-id>.jsonl` for new entries since last run
2. Extracts user + assistant turns (skips tool calls, system events)
3. POSTs to Anthropic API (claude-haiku-3 by default — cheap)
4. Appends bullet-point summary to `<memory-dir>/YYYY-MM-DD.md`
5. Saves progress in `.scribe-state.json` so next run only processes new entries

## Setup

```bash
# Install dependencies (one-time, in the skill directory)
cd /path/to/skills/session-scribe && npm install

# You need a direct Anthropic API key (not an OpenClaw internal token)
# Get one at: https://console.anthropic.com/settings/keys
export ANTHROPIC_API_KEY=sk-ant-api03-...

# Find your session ID from sessions.json
python3 -c "
import json
sessions = json.load(open(os.path.expanduser('~/.openclaw/agents/main/sessions/sessions.json')))
for k, v in sessions.items():
    print(k, '->', v.get('sessionId'))
"

# Test run (dry-run, no file written)
node scripts/scribe.js \
  --sessions ~/.openclaw/agents/main/sessions \
  --session-id <your-session-id> \
  --memory-dir ~/.openclaw/workspace/memory \
  --dry-run

# Or auto-resolve session by key suffix (e.g. your Discord channel ID)
node scripts/scribe.js \
  --sessions ~/.openclaw/agents/main/sessions \
  --auto-session "discord:channel:1484662353386668173" \
  --memory-dir ~/.openclaw/workspace/memory \
  --dry-run
```

> **Note:** The `ANTHROPIC_API_KEY` must be a direct Anthropic API key from console.anthropic.com — not an OpenClaw internal token. OpenClaw's internal tokens cannot be used for direct API calls.

## System cron setup

Add to crontab (`crontab -e`):

```bash
# Scribe active session every hour
0 * * * * ANTHROPIC_API_KEY=your-key node /path/to/skills/session-scribe/scripts/scribe.js \
  --sessions ~/.openclaw/agents/main/sessions \
  --session-id YOUR_SESSION_ID \
  --memory-dir ~/.openclaw/workspace/memory \
  >> /tmp/scribe.log 2>&1
```

Or use the helper to auto-detect the active session:

```bash
0 * * * * ANTHROPIC_API_KEY=your-key node /path/to/skills/session-scribe/scripts/scribe.js \
  --sessions ~/.openclaw/agents/main/sessions \
  --auto-session "discord:channel:YOUR_CHANNEL_ID" \
  --memory-dir ~/.openclaw/workspace/memory \
  >> /tmp/scribe.log 2>&1
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--sessions <dir>` | Path to OpenClaw sessions directory | required |
| `--session-id <id>` | Specific session UUID to scribe | — |
| `--auto-session <key>` | Auto-resolve session ID from session key suffix | — |
| `--memory-dir <dir>` | Directory to write daily memory files | required |
| `--model <model>` | Anthropic model to use | `claude-haiku-4-5` |
| `--agent <id>` | Agent label in output (cosmetic) | `agent` |
| `--dry-run` | Print summary without writing | false |
| `--min-turns <n>` | Minimum new turns before scribing | `3` |

## References

- [references/transcript-format.md](references/transcript-format.md) — OpenClaw JSONL transcript structure
