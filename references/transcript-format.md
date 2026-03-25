# OpenClaw Transcript Format

Transcripts are append-only JSONL files at:
`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

## Entry types

Each line is a JSON object with a `type` field:

| type | Description |
|------|-------------|
| `session` | First line — session metadata (id, timestamp, cwd) |
| `model_change` | Model switch event |
| `thinking_level_change` | Thinking level change |
| `user` | User message turn |
| `assistant` | Assistant response turn |
| `tool_use` | Tool call (embedded in assistant turns) |
| `tool_result` | Tool result |
| `compaction` | Compaction summary entry |
| `custom` | System events (model snapshots, etc.) |

## User entry
```json
{
  "type": "user",
  "id": "abc123",
  "parentId": "def456",
  "timestamp": "2026-03-25T03:00:00.000Z",
  "message": {
    "role": "user",
    "content": "Message text here"
  }
}
```

## Assistant entry
```json
{
  "type": "assistant",
  "id": "xyz789",
  "parentId": "abc123",
  "timestamp": "2026-03-25T03:00:01.000Z",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "Response text" },
      { "type": "tool_use", "id": "tool1", "name": "exec", "input": {} }
    ]
  }
}
```

Content can be a plain string or an array of blocks (text + tool_use).

## sessions.json structure

Located at `~/.openclaw/agents/<agentId>/sessions/sessions.json`:

```json
{
  "agent:main:discord:channel:1234567890": {
    "sessionId": "cd7fe3ee-15d2-4b81-83cc-3e4d2da6db01",
    "contextTokens": 1000000,
    "lastActivity": "2026-03-25T03:00:00.000Z"
  }
}
```

Use this to resolve a session key (e.g. `discord:channel:1234`) to a session UUID for reading the transcript.
