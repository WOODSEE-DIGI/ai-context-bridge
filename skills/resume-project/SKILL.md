---
name: resume-project
description: |
  Continue work on a project from any machine. Use when the user says
  "continue with X", "resume X", "pick up where I left off", "where was I",
  "what was I doing on X", or asks to sync work done on another computer.
  Detects which machine last worked on the project, compares local git to
  the recorded state, and offers to sync before resuming. Works across
  multiple machines via iCloud-synced memory and GitHub-synced code.
---

# Resume Project — cross-machine continuity

When the user wants to continue a project — especially after switching
machines — follow this protocol instead of guessing from chat history.

## Why this exists

Work happens on multiple computers. Memory syncs via iCloud Drive; code
syncs via GitHub. This protocol reconciles the two so you know what was
happening, where, and whether local state matches the other machine.

## The protocol

### 1. Identify the project

Map the user's phrasing to a project name known to memory:
`list_active_contexts`, or `memory_search` for the topic. If ambiguous,
ask which project they mean rather than guessing.

### 2. Read sync state

Read `ctx://context/projects/<name>/sync-state` with `memory_read`.

Fields: `machine`, `machine_id`, `updated`, `last_commit`, `branch`,
`in_progress`, `dirty`, `note`.

- **Present** → this is authoritative cross-machine state.
- **Missing** → no sync state recorded yet. Fall back to the latest
  session / todo / decision entries for the project, report what memory
  knows, and offer to start recording sync state (call `update_sync_state`).

### 3. Compare machines

- `machine` == current machine name → **same machine**. Report last
  activity and continue; no cross-machine sync needed.
- `machine` != current machine name → **different computer**. Say so
  explicitly: "Last worked on `<machine>` at `<time>`."

### 4. Compare git state (if the project has a repo)

From the project root:

```bash
git status -sb
git log -1 --format='%h %s'
git rev-list --count HEAD..origin/<branch>   # behind
git rev-list --count origin/<branch>..HEAD   # ahead
```

Classify:
- **behind** → remote has newer work
- **ahead** → local has unpushed work
- **diverged** → both
- **in sync** → nothing to do
- **no remote** → say so; offer to add one instead of pretending sync happened

### 5. Ask before syncing

**NEVER auto-pull or auto-push.** Present the situation and ask:

- Remote ahead → "Local is N commits behind `<machine>`'s work. Sync
  local to match?" On yes: `git pull --rebase`, then verify (build/test
  if the project has one).
- Local ahead → "Local has N unpushed commits. Push them so other
  machines can pull?" On yes: `git push`.
- Diverged → explain both sides, offer rebase or merge, ask which.

### 6. Update sync state after any change

After pulling, pushing, or starting new work, call `update_sync_state`
with the current commit, branch, a one-line `in_progress`, and `dirty`.
This is what the next machine will read.

### 7. Resume

With state reconciled, pick up the work: read the latest todos and
session entries, confirm the in-progress item against what the user
says, and continue.

## Rules

- **Ask first.** Syncing changes files on disk; never do it silently.
- **Provenance matters.** Every memory write is stamped with `machine`.
  Use it to answer "where was this done?" without guessing.
- **Machine names** resolve from `~/.ai-context/.machine-name` (if set),
  else the OS computer name, else the hostname. On a new machine, create
  that file with a short name you'll recognize (e.g. `desktop`, `laptop`,
  or any label you like) so provenance reads correctly.
- **Memory is iCloud-synced; code is GitHub-synced.** Do not try to git
  the memory store — it lives behind a symlink.
- **Update sync state when you stop**, not just when you start. The next
  machine reads it cold.
- If the user is on a single machine and nothing diverged, keep it short —
  report where things left off and get to work.

## Example

> User (on laptop): "continue with myapp"

1. `memory_read` → `ctx://context/projects/myapp/sync-state`
   → `machine: desktop`, `last_commit: abc123`,
   `in_progress: "fixing the indexing bug"`
2. Current machine is `laptop` → different computer.
3. `git status -sb` → local `def456`, `origin/main` at `abc123`, 3 behind.
4. Say: "Last worked on desktop — you were fixing the indexing bug
   (abc123). Local is 3 commits behind. Sync local to match?"
5. Yes → `git pull --rebase`, verify, then continue the bug fix.
6. Call `update_sync_state` with the new commit and in-progress note.
