<p align="center">
  <img src="Ai-Context-Bridge-Icon.png" alt="AI Context Bridge icon" width="128" height="128">
</p>

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

## Works with any model and any MCP client

This bridge is **model-agnostic**. It speaks the standard [MCP](https://modelcontextprotocol.io) protocol and never inspects or constrains which LLM is driving it, so the shared memory and tools work identically for essentially every model available today — you do **not** need per-model code changes.

**Popular models it works with** (any MCP-capable client, any provider):

| Model family | Providers / examples |
|---|---|
| Claude | Anthropic Claude (Sonnet, Opus, Haiku) |
| GPT | OpenAI GPT-4o, GPT-4.1, o-series |
| Gemini | Google Gemini (Pro, Flash) |
| Gemma | Google Gemma / Gemma 3 |
| DeepSeek | DeepSeek V3, R1 |
| Kimi | Moonshot Kimi |
| Qwen | Alibaba Qwen / Qwen3.5 |
| Open | Llama, Mistral, and any local GGUF/MLX model |

**MCP-capable clients/apps** — register the server in any of these (or any other MCP client):

Claude Code · opencode · Cursor · VS Code Copilot (agent mode) · Continue · Cline · Warp · LM Studio · Qwen Code/CLI · QwenAgent · custom agents

**How model support works:** because every read/write goes through the bridge's tools over MCP, the memory store behaves the same for every model. To add a model you only need to register this server in that model's MCP client config (see [MCP config example](#mcp-config-example)) — there is no model-specific wiring and no client-code change. The single optional model reference in the server is the `PAL_FALLBACK_MODEL` used only by the `pal_memory_query` recall helper; it is configurable via the `PAL_FALLBACK_MODEL` environment variable and defaults to the model configured in SwiftMaestro.

> **Note for SwiftMaestro users:** SwiftMaestro's in-app memory already uses this store, and its own multi-model catalog is independent of the bridge. No SwiftMaestro code change is required to use the bridge with Kimi, Gemini, Gemma, DeepSeek, or any other model — the memory works with all of them.

## How to use it

### The two-step mental model

The bridge itself has **no chat UI**. You talk to an agent, and the agent invokes the bridge's tools on your behalf over MCP. That means:

1. **Register the server** in your MCP client (Claude Code, opencode, continue, Cline, etc. — see [MCP config example](#mcp-config-example)).
2. **Ask in plain language.** You never hand-type tool JSON — you say what you want, and the agent calls the right tool.

Everything below is written two ways: the **plain-English thing you say**, and the **tool call the agent actually makes** (useful to know what is happening, and handy if your client shows you the tool payloads).

### How saving to memory works

Memory is addressed with **QwenURIs** (`qwen://<kind>/<path>`). The four kinds map directly onto folders in `~/.ai-context/memory/`:

| Kind | URI prefix | On-disk folder |
|---|---|---|
| Chat/notes | `qwen://memory/...` | `~/.ai-context/memory/conversations/` |
| Knowledge | `qwen://knowledge/...` | `~/.ai-context/memory/knowledge/` |
| Session/context | `qwen://context/...` | `~/.ai-context/memory/context/` |
| Skill | `qwen://skill/...` | `~/.ai-context/memory/skills/` |

So a URI like `qwen://knowledge/projects/myapp/architecture` becomes
`~/.ai-context/memory/knowledge/projects/myapp/architecture.json` plus a companion `.md` file.

Every entry also carries `project`, `type` (decision, note, session-update, fact, preference, todo, error), and `timestamp`. That is what lets you pull it back up later — by **project**, by **keyword**, or by **kind**.

**Generic save — `memory_write`:**

> "Save this decision to memory under the SwiftMaestro project: we're switching the inference backend to MLX."

The agent calls:

```json
memory_write {
  "content": "Switching the inference backend to MLX.",
  "uri": "qwen://knowledge/projects/swiftmaestro/inference-backend",
  "source": "chat",
  "type": "decision",
  "project": "SwiftMaestro",
  "tags": ["backend", "mlx"]
}
```

**Convenience tools** — faster than remembering URIs; each one picks its own location and tags for you:

| Tool | What you say | Where it writes |
|---|---|---|
| `add_decision` | "Log a decision: use SQLite for storage, because it's file-first." | `qwen://knowledge/projects/<project>/decisions` |
| `add_todo` | "Add a high-priority todo: implement the settings tab." | `qwen://knowledge/projects/<project>/todos` |
| `report_error` | "Log an error: build failed with code 65; severity high." | `qwen://knowledge/projects/<project>/errors` |
| `update_session` | "Note that deploy state is: v1.2 live on prod." | `qwen://context/projects/<project>/session` |
| `set_active_project` | "Set active project to FooApp." | `qwen://context/active-project` |

### How recalling memory works

Because the whole store is file-based and full-text searchable, recall works across **any earlier time and any project**. There are four recall tools:

**1. Recall by keyword (most common) — `memory_search`:**

> "Search memory for anything about the Tailscale integration plan."

```json
memory_search { "query": "Tailscale integration", "max_results": 10 }
```

This searches every `.md`/`.json` file under `~/.ai-context/memory/` and returns file paths, line numbers, and the surrounding snippet. Behind the scenes it uses a **SQLite FTS5 index** (a port of SwiftMaestro's `MemorySearchEngine`) so keyword recall is sub-millisecond; it transparently falls back to a folder scan while the index warms. It does **not** care which project or which session wrote it — if it is in the store, you can find it.

**2. Recall a specific entry by address — `memory_read`:**

> "Read the inference-backend decision from the SwiftMaestro project."

```json
memory_read { "uri": "qwen://knowledge/projects/swiftmaestro/inference-backend" }
```
or equivalently:
```json
memory_read { "kind": "knowledge", "path": "projects/swiftmaestro/inference-backend" }
```

**3. Browse by kind/project — `memory_list`:**

> "List all knowledge entries for the FooApp project."

```json
memory_list { "kind": "knowledge", "project": "FooApp" }
```

**4. See which projects exist — `list_active_contexts`:**

> "What projects do we have context for?"

```json
list_active_contexts {}
```

This lists every project folder in memory with its last-modified time and entry names — useful at the start of a session to remember what you were working on.

**Bonus — recall past chat history:** `search_conversation_history` searches SwiftMaestro's saved chat transcripts (not just the curated memory), so you can recover an earlier discussion verbatim:

> "Search my old chats for when we discussed the OAuth loopback server."

```json
search_conversation_history { "query": "OAuth loopback server", "max_results": 30 }
```

#### The fast SQLite FTS5 search index

`memory_search` gets its speed from a local SQLite full-text-search index (a port of
SwiftMaestro's `MemorySearchEngine`). It keeps the **same** `memory-index.sqlite`
schema — `memory_files` + an FTS5 virtual table with incremental-reindex triggers —
so SwiftMaestro and this server can even share the same index file.

- The index lives at `~/.ai-context/memory-index.sqlite` (override with `AI_MEMORY_INDEX`).
- The memory files under `~/.ai-context/memory/` remain the **source of truth**; the
  index is only a derived cache and is rebuilt incrementally as files change.
- On first run the index builds in the background; until it finishes, `memory_search`
  falls back to the folder scan so answers are still immediate and correct.
- Recent writes are picked up within a short cooldown (mirroring SwiftMaestro's
  `MemorySearchService`), so a brand-new entry may not appear for a few seconds.
- It runs on a worker thread and uses WAL mode, so searches never block reindexing.
- If `better-sqlite3` isn't installed, the server degrades gracefully to the folder scan.

Inspect or rebuild it anytime with `memory_index`:

> "Is the memory index built? Force a rebuild."

```json
memory_index {}              // status: path, ready flag, indexed file count
memory_index { "rebuild": true }   // force a full reindex (background for large stores)
```

### Example: a full save→recall round trip

1. **Save.** You tell the agent: "Record that we chose PolyForm Noncommercial as the license for the new repo." → the agent calls `add_decision` (or `memory_write`), writing `qwen://knowledge/projects/<project>/decisions`.
2. **Later, in a different project.** You open a new session for a different repo and ask: "What license did we settle on for that new repo?" → the agent calls `memory_search { "query": "license" }`.
3. Because `memory_search` scans the **entire** store, it finds the comment in the other project's folder, and the projects/timestamps in the result tell you where and when it was recorded.

## Mandatory context saving

**This is critical:** ai-context-bridge only works if your agents actually save their work. Without explicit rules, agents will do work but forget to save decisions, errors, and session state — causing knowledge loss between sessions.

See [CONTEXT-SAVING-RULES.md](CONTEXT-SAVING-RULES.md) for the mandatory behavior rules you must add to your agent configuration. These rules enforce that agents:

1. Read context at session start
2. Save decisions, todos, errors, and session updates as they work
3. Save a final session summary at session end

Without these rules, your agents will treat context saving as optional and your knowledge base will be incomplete.

## Background

This grew out of ideas from OpenViking, PAL, and a few other context-memory projects, but it is its own thing: a lightweight, file-first MCP server tailored to my workflow. It does not require a vector database or cloud service.

## Install

```bash
cd ai-context-bridge
npm install
```

`better-sqlite3` is the only native dependency — it compiles on install and needs a
C/C++ toolchain (Xcode Command Line Tools on macOS: `xcode-select --install`). If it
fails to build, the server still runs; `memory_search` falls back to the folder scan
until the dependency is installed.

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

[PolyForm Noncommercial License 1.0.0](LICENSE)

This software is free for noncommercial use, including personal projects, hobby use, research, and education. Commercial use requires a separate license. See the full [LICENSE](LICENSE) file for details.
