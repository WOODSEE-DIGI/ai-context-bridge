# Context Saving Rules — MANDATORY BEHAVIOR

This document defines the mandatory context-saving behavior that all AI agents using ai-context-bridge must follow. Without these rules, agents tend to do work but forget to save it, causing knowledge loss between sessions.

## Core Principle

You MUST save your work to ai-context-bridge as you go. This is not optional. Do not wait to be asked.

## When to Save

### Decisions (use `ai-context-bridge_add_decision`)

Save IMMEDIATELY when you:
- Make an architectural choice (e.g., "use PostgreSQL instead of SQLite")
- Choose a specific approach over alternatives (e.g., "use OAuth2 instead of API keys")
- Configure a system in a particular way (e.g., "set SMTP to use STARTTLS on port 465")
- Resolve a design question with rationale

**Format:**
```
title: Short descriptive title
decision: What was decided
rationale: Why this choice was made (optional but recommended)
```

### Todos (use `ai-context-bridge_add_todo`)

Save when you:
- Identify a task that needs to be done (even if you're doing it now)
- Break work into steps
- Discover follow-up work

**Format:**
```
task: Clear description of what needs to be done
priority: low | medium | high
assignee: (optional) who should do it
```

### Errors (use `ai-context-bridge_report_error`)

Save IMMEDIATELY when you:
- Encounter a failure, bug, or unexpected behavior
- Hit a permission or access issue
- Discover something that doesn't work as expected

**Format:**
```
error: What went wrong
severity: low | medium | high | critical
context: (optional) what you were trying to do
```

### Session State (use `ai-context-bridge_update_session`)

Save when you:
- Change configuration or settings
- Update deployment state
- Record current system state for future reference

**Format:**
```
key: Short identifier (e.g., "peertube-deployment-state")
value: Current state description
```

## Session Lifecycle

### At Session Start

1. Call `ai-context-bridge_read_context` with `section: "all"` for the active project
2. Review decisions, todos, errors, and session state
3. Acknowledge what's been done and what's pending

### During Session

- Save decisions as you make them
- Save todos as you identify them
- Save errors as you encounter them
- Update session state as you change things

### At Session End

- Save a final session update summarizing what was accomplished
- Ensure all open todos are recorded
- Do NOT end without saving your work

## Examples

### Good: Saving a decision

```
User: "Set up the database"
Agent: I'll use PostgreSQL with connection pooling.
[IMMEDIATELY calls ai-context-bridge_add_decision]
title: Database choice
decision: PostgreSQL with pgBouncer connection pooling
rationale: Better performance under load, mature ecosystem
```

### Bad: Not saving

```
User: "Set up the database"
Agent: I'll use PostgreSQL with connection pooling.
[Does the work but never saves the decision]
[Next session, another agent has to figure out what was chosen]
```

### Good: Saving an error

```
Agent: The SMTP connection failed with "wrong version number".
[IMMEDIATELY calls ai-context-bridge_report_error]
error: SMTP connection failed - port 465 requires STARTTLS, not implicit TLS
severity: medium
context: Configuring PeerTube SMTP
```

### Bad: Not saving

```
Agent: The SMTP connection failed. Let me try a different port.
[Fixes it but never records the error or the solution]
[Next time this happens, the agent has to debug from scratch]
```

## Enforcement

If you complete significant work and do not save to context, you have failed your core responsibility. The user relies on context to maintain continuity across sessions and agents. Every decision, every error, every state change must be recorded.

**Remember:** You are not just doing work. You are building a persistent knowledge base that future agents will use. If you don't save your work, that knowledge is lost.

## Integration with OpenCode

For OpenCode users, add these instructions to your `opencode.jsonc`:

```json
{
  "instructions": [
    "Never assume prior state. Always check the ai-context-bridge shared context for the active project (decisions, todos, errors, session, prompts) before acting.",
    "MANDATORY: After completing any significant work (decisions made, code written, configs changed, deployments done, errors encountered), immediately save to ai-context-bridge using the appropriate tool: decisions for architectural choices, todos for tasks, errors for failures, session for state updates. Do NOT wait to be asked. Do NOT end a session without saving your work.",
    "When starting a session: read context FIRST. When ending a session: save context LAST. This is non-negotiable."
  ]
}
```

And add this section to your agent files:

```markdown
## Context Management (MANDATORY)

You MUST use ai-context-bridge to maintain continuity across sessions:

1. **At session start:** Read context for the active project using `ai-context-bridge_read_context` with `section: "all"`. Review decisions, todos, errors, and session state before acting.

2. **During work:** Save decisions, todos, errors, and session updates AS YOU GO. Do not wait to be asked. Do not end a session without saving your work.

3. **At session end:** Save a final session update summarizing what was accomplished.

This is non-negotiable. You are building a persistent knowledge base that future agents will use. If you don't save your work, that knowledge is lost.
```
