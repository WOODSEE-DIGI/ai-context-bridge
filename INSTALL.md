# Install

Zero to working memory. Every command is copy-paste. If you're an AI agent
installing this for a user, run these in order and verify each step.

## Requirements

| Need | Check | If missing |
|---|---|---|
| Node.js ≥ 18 | `node --version` | `brew install node` or https://nodejs.org |
| npm | `npm --version` | ships with Node |
| C/C++ toolchain (for `better-sqlite3`) | `xcode-select -p` (macOS) | `xcode-select --install` |
| An MCP-capable client | — | Claude Code, opencode, Cursor, Warp, LM Studio, Qwen Code, … |

**About `node_modules/`:** it will not exist after cloning. That is correct —
it is gitignored on purpose and `npm install` creates it. Do not look for it in
the repo, do not commit it, and do not treat its absence as a problem.

## Step 1 — Get the code

```bash
git clone git@github.com:WOODSEE-DIGI/ai-context-bridge.git
cd ai-context-bridge
```

Or download the ZIP from GitHub and `cd` into the extracted folder.

## Step 2 — Install dependencies

```bash
npm install
```

Expected: finishes without errors, `node_modules/` now exists.

If `better-sqlite3` fails to compile, the server **still works** —
`memory_search` falls back to a slower folder scan. Fix it later with
`xcode-select --install` then `npm rebuild better-sqlite3`.

Verify:

```bash
node -e "import('better-sqlite3').then(()=>console.log('search: OK'))"
# → search: OK
```

## Step 3 — Sanity check the server

```bash
node server.js
```

It should start and wait silently (it speaks MCP over stdin/stdout — no output
is normal). Stop it with `Ctrl+C`. If it exits with an error, read the error:
a missing-dependency message means Step 2 didn't complete.

## Step 4 — Register it in your MCP client

Add to your client's MCP config (file location varies per client — Claude Code:
`~/.claude.json`; opencode: `opencode.json`; Warp: `~/.warp/mcp_servers.json`):

```json
{
  "mcpServers": {
    "ai-context-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/ai-context-bridge/server.js"]
    }
  }
}
```

Use an **absolute path**. `command: "node"` must resolve — if your client can't
find Node, use the full path from `which node`.

## Step 5 — Restart the chat program

MCP clients read their config **only at launch**. Quit the client fully and
reopen it. The server starts automatically with the next session.

## Step 6 — Verify it's working

In the chat, ask:

> "List my active contexts"

If the agent calls `list_active_contexts` and gets an answer (even "no projects
yet"), the bridge is live. `memory_search` should also respond to a keyword
query.

## Step 7 — Make agents actually save (required)

The bridge only pays off if agents write to it. Copy
[CONTEXT-SAVING-RULES.md](CONTEXT-SAVING-RULES.md) into your agent's
configuration so agents:

1. Read context at session start
2. Save decisions, todos, errors, session updates as they work
3. Save a session summary at session end

Skip this and your knowledge base will be empty.

## Optional — multiple machines

**Ask the user first** — this moves memory into a cloud folder.

```bash
# 1. Share memory — symlink to iCloud Drive (Dropbox/Syncthing/share work too)
STORE=~/Library/Mobile\ Documents/com~apple~CloudDocs/AgentMemory/memory
mkdir -p "$STORE"
mv ~/.ai-context/memory/* "$STORE" 2>/dev/null   # FIRST machine only — seed existing memory
ln -s "$STORE" ~/.ai-context/memory              # other machines: this line only

# 2. Name the machine — stamped on every memory write
echo "desktop" > ~/.ai-context/.machine-name     # laptop, workstation, …

# 3. Install the resume skill — powers "continue with X" / "where was I?"
mkdir -p ~/.ai-context/skills && cp -R skills/resume-project ~/.ai-context/skills/
```

Verify the link: `ls -l ~/.ai-context/memory` should show `->` pointing into
iCloud. On macOS, `brctl status com~apple~CloudDocs` should say `caught-up`.

The FTS index (`~/.ai-context/memory-index.sqlite`) is a **per-machine cache**
rebuilt from the shared files — never sync or commit it.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Client shows no MCP server | Config read at launch only | Fully quit and reopen the client |
| `command not found: node` | Client can't resolve Node | Use `which node` full path in `command` |
| Server path error | Relative path | Use absolute path in `args` |
| `memory_search` slow / warns about sqlite | `better-sqlite3` not built | `xcode-select --install` then `npm rebuild better-sqlite3` |
| No `node_modules/` in folder | Normal — it's gitignored | `npm install` |
| Skill not discovered | Not in skill root | `cp -R skills/resume-project ~/.ai-context/skills/` |
| Memory not syncing across Macs | Symlink missing or iCloud not caught up | Redo the `ln -s` line; check `brctl status` |

Anything not listed — diagnose directly: read the error, check the client's MCP
log, confirm `node server.js` runs in a terminal.

## Uninstall

```bash
# remove the server registration from your MCP config, then:
rm -rf /path/to/ai-context-bridge
rm -rf ~/.ai-context          # CAUTION: deletes your memory store — back up first
```
