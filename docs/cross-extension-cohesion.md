# Cross-extension cohesion contract

This document describes the lightweight contract shared by `pi-memory`, `pi-todo`, and `pi-quest`.

## Design rules

- Each extension remains self-contained. Do not add a shared local `file:` dependency.
- Cross-extension integration is best-effort. Missing files, corrupt JSON, or absent extensions must not break the owning extension.
- Storage is JSON with two-space indentation and a trailing newline.
- Project identity is the first 16 hex chars of `sha256(cwd)`.

## Common helpers

Each extension may carry a small duplicated helper set:

- `cwdHash(cwd)` — `sha256(cwd).slice(0, 16)`.
- `readJSON<T>(path, fallback)` — returns `fallback` on missing/corrupt files.
- `writeJSON(path, data)` — creates parent directories recursively and writes formatted JSON.
- `writeSessionMeta(key, cwd, data)` — merges extension state into `~/.pi/agent/session-meta.json`.

## Storage paths

| Extension | Path | Purpose |
|---|---|---|
| memory | `~/.pi/agent/memory/user.json` | User preferences and conventions |
| memory | `~/.pi/agent/memory/projects/<cwdHash>.json` | Project tech profile and conventions |
| todo | `~/.pi/agent/tmp/todos/<cwdHash>.json` | Active project todo list |
| todo | `~/.pi/agent/tmp/todos/archive/*.json` | Archived todo lists |
| quest | `~/.pi/agent/quests/active.json` | Active quest |
| quest | `~/.pi/agent/quests/archive/*.json` | Completed quest archives |
| shared | `~/.pi/agent/session-meta.json` | Best-effort cross-extension awareness |

## Session meta shape

```json
{
  "cwd": "/Users/example/Projects/app",
  "cwdHash": "0123456789abcdef",
  "updatedAt": 1780000000000,
  "extensions": {
    "memory": { "language": "TypeScript", "framework": "Next.js", "updatedAt": 1780000000000 },
    "todo": { "total": 5, "completed": 2, "inProgress": 1, "updatedAt": 1780000000000 },
    "quest": { "name": "Improve app", "status": "active", "done": 2, "total": 8, "updatedAt": 1780000000000 }
  }
}
```

Fields inside each extension block are optional and version-tolerant. Consumers must ignore unknown fields.

## Status semantics

### Todo

- `pending` — not started.
- `in_progress` — active current work; at most one should exist.
- `delegated` — assigned to a sub-agent.
- `completed` — done.

### Quest

- Quest status: `planning`, `active`, `paused`, `done`, `idle`.
- Task status: `pending`, `running`, `verifying`, `done`, `failed`, `skipped`.
- Quest-to-todo mapping: `running → in_progress`, `done/skipped → completed`, `failed → completed` with failure result marker, otherwise `pending`.

## Optional integration policy

- Quest may write quest-derived todo items into the todo store, but must preserve non-quest todo items.
- Quest may merge completed quest conventions into memory project conventions.
- Quest may write research findings to memory via `quest_memory_save`, stored as `memory.research[key] = { value, category, timestamp }` — writes immediately (best-effort), not just on quest completion.
- Todo should reload from disk when another extension updates its active file.
- Memory should publish compact project facts for Quest steering, not large prompt blocks.

All such integrations must be wrapped in `try/catch` and treated as optional.
