<p align="center">
  <img src="Ai-Context-Bridge-Icon.png" alt="AI Context Bridge icon" width="128" height="128">
</p>

# AI Context Bridge

A file-first memory layer for AI agents, exposed as an [MCP](https://modelcontextprotocol.io) server. Your agent reads and writes `~/.ai-context/memory/`; nothing else — no vector DB, no cloud service, no model-specific code.

This repo is the **framework**, not the contents: your own memory stays in `~/.ai-context/memory/` on your machine.

> **Installing? → [INSTALL.md](INSTALL.md)** — complete zero-to-working steps,
> requirements, verification, and troubleshooting. Read it first.

---

## What are we working with?

**Four pieces:**

| Piece | Where | What it is |
|---|---|---|
| **MCP server** | `server.js` | ~35 tools: memory read/write/search, project context, skills, build/Obsidian helpers |
| **Memory store** | `~/.ai-context/memory/` | Plain `.json` + `.md` files, addressed by URI. The source of truth. |
| **FTS index** | `~/.ai-context/memory-index.sqlite` | Derived cache for fast `memory_search`. Rebuilt automatically; safe to delete. |
| **Skills** | `skills/` | Reusable instruction modules the agent loads on demand (`list_skills` / `read_skill`) — e.g. `resume-project` for cross-machine continuity |

**Memory addresses** — every URI maps to a folder:

| Kind | URI prefix | On-disk folder |
|---|---|---|
| Chat/notes | `ctx://memory/...` | `~/.ai-context/memory/conversations/` |
| Knowledge | `ctx://knowledge/...` | `~/.ai-context/memory/knowledge/` |
| Session/context | `ctx://context/...` | `~/.ai-context/memory/context/` |
| Skill | `ctx://skill/...` | `~/.ai-context/memory/skills/` |

`ctx://knowledge/projects/myapp/architecture` →
`~/.ai-context/memory/knowledge/projects/myapp/architecture.json` + companion `.md`.

Every entry carries `project`, `type`, `timestamp`, and (new) `machine` — so you can pull it back by project, keyword, kind, or *which computer wrote it*.

**Works with any model and any MCP client.** The bridge never inspects or constrains the LLM driving it — Claude, GPT, Gemini, Qwen, DeepSeek, local GGUF/MLX models, all behave identically. Register the server once in your client (Claude Code, opencode, Cursor, Warp, LM Studio, Qwen Code, …) and it works with every model that client supports.

---

## How are we supposed to work with it?

The bridge has **no chat UI**. You talk to your agent; the agent calls the tools. So there are two sides: what *you* do once, and what happens every session.

### One-time setup

Full steps, verification, and troubleshooting: **[INSTALL.md](INSTALL.md)**.
The short version:

```bash
git clone <this repo> && cd ai-context-bridge
npm install          # creates node_modules/ — gitignored, expected, required
node server.js       # sanity check — it speaks MCP over stdio
```

Then register the server in your MCP client (config is in
[INSTALL.md](INSTALL.md) — use an absolute path), **fully restart the
chat program** (clients read MCP config only at launch), and confirm with
"list my active contexts".

> This repo ships **source only** — `node_modules/` and `package-lock.json` are
> gitignored by design. Their absence after cloning is normal, not a fault.

Paths resolve from `$HOME` or env vars — no hardcoded usernames:
`AI_GITHUB_ROOT` (default `~/Documents/GitHub`), `OBSIDIAN_REST_API_KEY`, `WHISPERKIT_SWITCH_SCRIPT`.

**Then do the important part:** add [CONTEXT-SAVING-RULES.md](CONTEXT-SAVING-RULES.md) to your agent's configuration. The bridge only pays off if agents actually save. These rules make them (1) read context at session start, (2) save decisions/todos/errors/session updates as they work, (3) save a summary at session end. Skip this and your knowledge base will be incomplete.

### Every session — say it in plain language

You never hand-type tool JSON. Two steps:

1. **Ask.** "Search memory for anything about the Tailscale plan." → `memory_search { "query": "Tailscale integration" }`
2. **Tell.** "Log a decision: use SQLite, it's file-first." → `add_decision`

**Save tools** (each picks its own location and tags):

| Tool | You say | Writes to |
|---|---|---|
| `memory_write` | "Save this under project X…" | any URI you specify |
| `add_decision` | "We chose SQLite because it's file-first." | `ctx://knowledge/projects/<p>/decisions` |
| `add_todo` | "High priority: implement the settings tab." | `ctx://knowledge/projects/<p>/todos` |
| `report_error` | "Build failed with code 65." | `ctx://knowledge/projects/<p>/errors` |
| `update_session` | "Deploy state is: v1.2 live on prod." | `ctx://context/projects/<p>/session` |
| `update_sync_state` | "Note I'm on commit abc123, mid-way through the indexing fix." | `ctx://context/projects/<p>/sync-state` |
| `set_active_project` | "Active project is FooApp." | `ctx://context/active-project` |

**Recall tools:**

| Tool | You say |
|---|---|
| `memory_search` | "Anything about the Tailscale integration plan." — full-text, across all projects and time |
| `memory_read` | "Read the inference-backend decision from SwiftMaestro." — by URI |
| `memory_list` | "List all knowledge entries for FooApp." |
| `list_active_contexts` | "What projects do we have context for?" — best first call of a session |
| `search_conversation_history` | "Find when we discussed the OAuth loopback server." — old chat transcripts, verbatim |
| `memory_index` | "Is the index built? Force a rebuild." |

**Round trip:** save a decision in one project → open a different project next week → ask "what license did we settle on?" → `memory_search` finds it, because search covers the whole store, not the current project.

### Optional: multiple machines

Single-machine by default. **Ask the user whether they want this before doing
any of it** — it moves their memory into a cloud folder. If they say yes, the
installing agent does three things per machine:

```bash
# 1. Share memory — symlink to iCloud Drive (Dropbox/Syncthing/network share work too)
STORE=~/Library/Mobile\ Documents/com~apple~CloudDocs/AgentMemory/memory
mkdir -p "$STORE"
mv ~/.ai-context/memory/* "$STORE" 2>/dev/null   # first machine only — seed existing memory
ln -s "$STORE" ~/.ai-context/memory              # other machines: this line only

# 2. Name the machine — stamped on every write so provenance works
echo "desktop" > ~/.ai-context/.machine-name     # laptop, workstation, …

# 3. Install the resume skill — "continue with X" / "where was I?"
mkdir -p ~/.ai-context/skills && cp -R skills/resume-project ~/.ai-context/skills/
```

The resume skill reconciles memory with git: reads `ctx://context/projects/<name>/sync-state`, detects which machine last worked, compares local commits to the recorded one, and **asks before pulling or pushing**.

The FTS index is a per-machine cache rebuilt from the shared files — never sync or commit it. If something's off (broken link, iCloud not caught up, skill not discovered), diagnose and fix it directly.

---

## Background

Grew out of ideas from OpenViking, PAL, and other context-memory projects, but it's its own thing — lightweight, file-first, model-agnostic.

## Fork and adapt

Intentionally a framework, not a product. Fork it, rip out the tools you don't need, point the paths at your own directories.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE)

Free for noncommercial use, including personal projects, hobby use, research, and education. Commercial use requires a separate license. See [LICENSE](LICENSE) for details.
