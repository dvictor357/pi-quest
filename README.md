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

### Example workflow

```
1. /quest create "Add auth": Add JWT-based authentication to the API
2. Agent auto-explores → scout finds the codebase structure
3. Agent calls quest_plan with 8 tasks:
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
- **pi-todo** — Quest status syncs to the todo list for footer badge visibility
- **pi-memory** — On completion, Quest prompts the agent to save project conventions

## Storage

```
~/.pi/agent/quests/
├── active.json              # Current quest (one at a time)
└── archive/
    └── <ts>-<name>.json     # Completed quests
```

## Requirements

- **pi** `>=0.79`
- pi's built-in sub-agent system (`subagent` tool)
- `pi-todo` and `pi-memory` (optional, for enhanced integration)

## License

MIT
