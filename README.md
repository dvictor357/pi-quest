# pi-quest

Proactive AI project manager for [pi](https://pi.dev). Give it a goal and it **plans, delegates, verifies, and pushes forward autonomously** — no hand-holding needed.

Built on top of pi's sub-agent system. Quest orchestrates the entire flow: scout the codebase, plan the work, delegate to specialized agents, verify results, and keep going until the job is done.

```
YOU: /quest create "Add user auth to the app"
         │
         ▼
    ┌─────────────────────────────┐
    │       QUEST ORCHESTRATOR     │
    │                             │
    │  1. Scout explores codebase │
    │  2. Planner creates tasks   │
    │  3. Auto-pilot fires tasks  │
    │     one by one via steering │
    │  4. Agent + sub-agents work │
    │  5. Verifier checks results │
    │  6. Done — conventions saved│
    └─────────────────────────────┘
```

## How it works

### Auto-pilot loop

After each agent turn, Quest checks for pending tasks. If found, it injects a **steering message** — the agent never stops until all tasks are done or you hit pause.

### Proactive web research

During the planning phase, Quest instructs agents to research the latest information online using `web_search` and save findings with `quest_memory_save`. The current UTC date/time is injected into every planning and steering context so agents can search for the most recent and relevant information. Saved research is surfaced in future awareness blocks across all quests.

### Safety guards

| Guard | Behavior |
|-------|----------|
| **Max burst** | Auto-pauses after 6 consecutive tasks — `/quest resume` to continue |
| **Stall detection** | Same task 3 times without progress → pauses |
| **Retry limit** | 2 retries per task, then auto-marked failed |
| **Re-entry lock** | Prevents double-firing of steering messages |

### Lifecycle

```
planning → active → (auto-pilot loop) → done
                                    ↘ paused → resumed → active
```

## Install

```bash
pi install git:github.com/dvictor357/pi-quest
```

**Requires:** `pi-subagent-bundle` (pi's built-in sub-agent system), `pi-todo`, `pi-memory` (optional, for status bar and convention saving).

## Usage

### Commands

| Command | Does |
|---------|------|
| `/quest` | Show current quest status |
| `/quest create <name>: <goal>` | Create a new quest + auto-inject planning prompt |
| `/quest start` | Manually start a quest (if not auto-started) |
| `/quest pause` | Pause auto-pilot |
| `/quest resume` | Resume auto-pilot |
| `/quest status` | Full quest progress with task list |
| `/quest history [N]` | Browse past completed quests |

### Agent tools

| Tool | Used by agent to |
|------|-----------------|
| `quest_create` | Create a new quest from a goal |
| `quest_plan` | Save a task breakdown (after scout + planner) |
| `quest_update` | Mark a task done/failed/skipped with result |
| `quest_status` | Show current quest progress |
| `quest_history` | Browse past quests |
| `quest_memory_save` | Save research findings to quest + project memory |

### Example workflow

```
1. /quest create "Add auth": Add JWT-based authentication to the API
2. Agent notes current date, web-searches for latest JWT best practices
3. Agent auto-explores → scout finds the codebase structure
4. Agent calls quest_plan with 8 tasks:
   ☐ #1 Install jsonwebtoken [quick-worker]
   ☐ #2 Create auth middleware [worker]
   ☐ #3 Add login endpoint [worker]
   ...
4. Auto-pilot fires task #1 → agent calls subagent("quick-worker")
5. Quick-worker finishes → agent calls quest_update(index=0, status="done")
6. Auto-pilot fires task #2 → continues...
7. [... 6 more tasks ...]
8. All done! Quest archives + agent saves conventions to memory
```

## Integration

- **pi-subagent** — Quest tells the agent which sub-agent to use for each task
- **pi-todo** — Quest syncs tasks directly to the todo JSON store; todo detects changes and reloads automatically. The status bar reflects quest progress without the agent needing to call `todo_write`.
- **pi-memory** — On quest completion, conventions are merged directly into the project memory profile (deduped via Set). Planner and worker turns receive a compact project-awareness block with language, framework, conventions, and todo counts.

See the [cross-extension cohesion contract](docs/cross-extension-cohesion.md) for the full storage contract and status semantics.

## Storage

```
~/.pi/agent/quests/
├── active.json              # Current quest (one at a time)
└── archive/
    ├── archive-index.json    # Lightweight manifest for fast history
    └── <ts>-<name>.json     # Completed quests
```

## Requirements

- **pi** `>=0.79`
- pi's built-in sub-agent system (`subagent` tool)
- `pi-todo` and `pi-memory` (optional, for enhanced integration)

## License

MIT
