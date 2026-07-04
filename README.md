# AI Context Bridge

A personal AI-agent context framework. This is the glue layer I built to give my agents persistent memory, project awareness, and access to my local tools.

It is **not** my actual memory contents — those stay in `~/.ai-context/memory/` on my machine. This repo is the framework so you can run your own.

## What it does

- **Project context tracking** — active project, decisions, todos, errors, session state
- **Unified memory system** — reads/writes `~/.ai-context/memory/` using simple file-based addressing
- **Build bridge** — run Xcode builds and capture errors/warnings
- **Obsidian vault access** — read/write notes via the Local REST API plugin
- **WhisperKit control** — start/stop transcription streams
- **PAL memory helpers** — ingest and query compiled knowledge

## Background

This grew out of ideas from OpenViking, PAL, and a few other context-memory projects, but it is its own thing: a lightweight, file-first MCP server tailored to my workflow. It does not require a vector database or cloud service.

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

All user-specific paths are resolved from `os.homedir()` or environment variables, so it works on any Mac without hardcoded usernames:

- `AI_GITHUB_ROOT` — where your projects live (default: `~/Documents/GitHub`)
- `OBSIDIAN_REST_API_KEY` — only needed if you use Obsidian vault tools
- `WHISPERKIT_SWITCH_SCRIPT` — path to your WhisperKit switch script

## Fork and adapt

This is intentionally a framework, not a product. Fork it, rip out the tools you do not need, and point the paths at your own directories.

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
