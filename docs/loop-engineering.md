# Loop Engineering for pi-quest

> Working thesis: **pi-quest is already a loop-engineering runtime for pi.**
> The next step is to make the loop explicit, observable, safer, and easier to extend.

## What Loop Engineering means here

Loop Engineering is the practice of designing the system that prompts, checks, retries, and stops AI agents — instead of manually prompting an agent turn by turn.

For `pi-quest`, the loop is:

```text
User goal
  → quest_create
  → planning / research
  → quest_plan
  → auto-pilot steering
  → sub-agent execution
  → verification
  → quest_update
  → next pending task or completion
  → memory/archive/git summary
```

The important shift is that **the unit of work is not a prompt; it is a controlled feedback loop**.

## Why this matters for pi-quest

`pi-quest` should not just be “a task list plus sub-agents.” Its value is that it becomes a proactive project manager that can:

- discover or receive work,
- decompose it into bounded tasks,
- dispatch the right agent,
- verify results,
- persist state,
- continue without hand-holding,
- pause safely when confidence is low,
- record what happened for future quests.

That is exactly the Loop Engineering pattern.

## Current alignment

| Loop primitive | pi-quest implementation today | Notes |
|---|---|---|
| Goal | `quest_create(name, goal)` | Starts the control loop from a high-level objective. |
| Planning | `quest_plan` via planner/scout agents | Converts goal into executable tasks. |
| Work queue | `Quest.tasks` + dependency graph | Stores pending/done/failed/verifying tasks. |
| Dispatch | auto-pilot steering + recommended sub-agent | Injects the next task after each agent turn. |
| Execution | pi `subagent` tool | Work is delegated to focused agents. |
| Verification | `verifyOnComplete`, verifier tasks, verify retries | Maker/checker split exists; deterministic gates should be strengthened. |
| State | `~/.pi/agent/quests/<cwdHash>/active.json` | Loop state survives sessions. |
| Human control | pause/resume/approve/decide/cancel | Human can approve plans or resolve ambiguity. |
| Memory | `quest_memory_save`, pi-memory sync | Research and conventions carry forward. |
| Safety | burst limit, stall detection, retry limits, cycle/depth checks | Good start; future work should add budgets and stronger policy gates. |
| Audit trail | archive, task details, git commits | Supports review and PR summaries. |

## Target loop shape

A healthy pi-quest loop should follow this contract:

```text
1. Intake
   Receive a goal, issue, failure, or scheduled trigger.

2. Clarify
   Ask `quest_decide` only when ambiguity changes implementation or risk.

3. Plan
   Create bounded tasks with agents, dependencies, acceptance criteria, and verification notes.

4. Execute
   Dispatch one ready task at a time, or safely parallelize independent tasks in isolated contexts.

5. Verify
   Prefer deterministic checks first: tests, typecheck, lint, build, security scan.
   Use verifier agents for semantic review, risk review, and spec conformance.

6. Decide
   If pass: mark done and continue.
   If fail: retry with evidence.
   If repeated failure or high risk: pause and escalate.

7. Record
   Save result, evidence, conventions, research findings, commits, and summary.

8. Stop
   Complete only when all required tasks are done and verification is satisfied.
```

## What “improving pi-quest with Loop Engineering” means

### 1. Make stop conditions explicit

Every task should ideally include an acceptance condition:

```text
Task: Add auth middleware
Done when:
- middleware validates JWT signature,
- protected route test passes,
- invalid token test passes,
- TypeScript check passes.
```

This turns “agent says it is done” into “loop can prove enough to stop.”

### 2. Strengthen verification tiers

Use two verification layers:

1. **Deterministic gate** — tests, lint, typecheck, build, static analysis.
2. **LLM verifier** — checks intent, scope creep, maintainability, missing edge cases.

The deterministic gate should be the final hard stop whenever available.

### 3. Track loop health

Add metrics or run summaries such as:

- task attempts,
- verifier failures,
- stall count,
- elapsed time,
- estimated token/tool cost,
- human escalations,
- tasks completed per burst,
- most common failure reason.

These make the loop debuggable instead of magical.

### 4. Add triggerable/scheduled loops later

Today, quests are mostly user-started. Future Loop Engineering could add recurring triggers:

- daily issue triage,
- CI failure sweeper,
- dependency update sweeper,
- stale TODO scanner,
- changelog drafter,
- post-merge cleanup,
- documentation drift checker.

This would move pi-quest from “goal runner” toward “project maintenance loop engine.”

### 5. Improve state and auditability

For each task, store enough evidence to answer:

- What did the agent change?
- Why did it believe the task was complete?
- What checks passed or failed?
- What did the verifier say?
- What should the next quest remember?

This supports trust, review, and future automation.

### 6. Keep humans in high-impact decisions

Loop Engineering does not mean full autonomy everywhere. pi-quest should pause for:

- production-impacting changes,
- ambiguous product decisions,
- security-sensitive work,
- repeated verification failure,
- destructive commands,
- dependency conflicts,
- unclear ownership.

The right direction is **bounded autonomy**, not blind autonomy.

## Proposed roadmap

### Phase A — Document and expose the loop model

- Keep this document current.
- Link it from the README.
- Describe pi-quest as a Loop Engineering runtime.
- Add examples for common loop patterns.

### Phase B — Improve task schema

Add optional task fields over time:

```ts
acceptanceCriteria?: string[];
verificationCommands?: string[];
risk?: "low" | "medium" | "high";
requiresHumanApproval?: boolean;
```

This lets the loop reason about “done” more concretely.

### Phase C — Verification gates

Add first-class support for deterministic verification commands:

```text
quest_plan task → verificationCommands: ["npm test", "npm run typecheck"]
```

The loop should feed failures back to the worker and stop after retry limits.

### Phase D — Loop observability

Add a run log per quest:

```text
~/.pi/agent/quests/<cwdHash>/runs/<questId>.jsonl
```

Each event could record:

- task dispatched,
- agent selected,
- tool/sub-agent result,
- verification result,
- retry decision,
- pause reason,
- completion summary.

### Phase E — Recurring loop patterns

Add built-in templates:

| Pattern | Trigger | Output |
|---|---|---|
| Daily triage | schedule | prioritized quest plan or report |
| CI sweeper | CI failure | proposed fix PR |
| Dependency sweeper | schedule | update PR with tests |
| Changelog drafter | release/tag | draft changelog |
| Docs drift checker | schedule | doc update tasks |

## Design principles

1. **The loop owns process; the human owns judgment.**
2. **No task is done without evidence.**
3. **The worker should not be the only checker.**
4. **Prefer deterministic checks over vibes.**
5. **State must live outside the chat.**
6. **Every autonomous action needs a budget, limit, or stop condition.**
7. **Escalation is a feature, not a failure.**
8. **A loop should be inspectable after it runs.**

## Practical example

```text
Goal: Keep dependencies fresh without breaking the app.

Loop:
1. Scheduled trigger runs weekly.
2. Scout checks outdated packages.
3. Planner creates one task per safe update group.
4. Worker updates package in isolated branch/worktree.
5. Verification runs install, tests, typecheck, build.
6. Verifier agent reviews diff for risky changes.
7. If pass, quest opens PR and records commit.
8. If fail twice, quest pauses with evidence.
```

## Bottom line

`pi-quest` is on the right path if we treat it as a **bounded autonomous control loop**:

```text
plan → act → verify → decide → record → continue/stop
```

The highest-leverage improvements are not bigger prompts. They are better stop conditions, stronger verification, clearer state, safer escalation, and richer observability.
