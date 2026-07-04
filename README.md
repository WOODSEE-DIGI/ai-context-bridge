# AI Context Bridge MCP Server

Cross-project context, memory, build bridge, and Obsidian vault access for AI agents.

## What it does

- Project context tracking (active project, decisions, todos, errors, session state)
- Unified memory system under `~/.ai-context/memory/`
- Build/test bridge for Xcode projects
- Obsidian vault read/write access (requires Local REST API plugin)
- WhisperKit transcription control
- PAL memory ingest/query helpers

## Install

```bash
cd ai-context-bridge
npm install
```

## Run

```bash
node server.js
```

## Configure

All user-specific paths are resolved from `os.homedir()` or environment variables:

- `AI_GITHUB_ROOT` — override where your GitHub projects live (default: `~/Documents/GitHub`)
- `OBSIDIAN_REST_API_KEY` — only needed if you use Obsidian vault tools
- `WHISPERKIT_SWITCH_SCRIPT` — override WhisperKit control script path

## MCP config example

```json
{
  "mcpServers": {
    "ai-context-bridge": {
      "command": "node",
      "args": ["/path/to/ai-context-bridge/server.js"]
    }
  }
}
```

## License

MIT
