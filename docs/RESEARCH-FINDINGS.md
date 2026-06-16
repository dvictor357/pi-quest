# pi-quest v1.5.1 — Deep Research Findings

> Systematic audit of the `pi-quest` extension across 10 modules, ~1,830 lines of TypeScript.
> **Date:** 2026-06-16 | **Method:** 8 focused sub-agent analyses, each verified against source.

---

## Overall Health

| Dimension | Rating | Notes |
|-----------|--------|-------|
| Architecture | 🟢 Strong | Clean 10-module split, well-defined types, good separation of concerns |
| Security | 🔴 Critical | 3 RCE/path-traversal vectors in `teams.ts` |
| Robustness | 🟡 Moderate | Pervasive silent-failure pattern; auto-pilot lacks error recovery |
| Contract Compliance | 🟢 Strong | ~85% compliant with cross-extension cohesion contract |
| UX Completeness | 🟡 Moderate | Missing 4 commands, verification UX inconsistencies |
| Code Quality | 🟡 Moderate | Dead code (MAX_DEPENDENCY_DEPTH, kanban cache), O(n²) perf, stale comments |

**Total findings:** 85+ issues identified across all categories. Below is the consolidated, prioritized view.

---

## 🔴 Critical — Fix Before Publishing Team Repos

| # | Issue | File:Line | Impact |
|---|-------|-----------|--------|
| C1 | **RCE via shell injection** — `execSync(\`git clone --depth 1 "${url}" ...\`)` allows `$()` command substitution inside double quotes | `teams.ts:52` | Arbitrary code execution when installing a malicious team |
| C2 | **Path traversal in team save** — `join(TEAMS_DIR, \`${team.name}.json\`)` with unsanitized name | `teams.ts:29` | Write arbitrary files outside teams dir |
| C3 | **Path traversal in agent file read** — `join(tmpDir, a.file)` with user-controlled `a.file` | `teams.ts:87` | Read arbitrary files; content installed as agent markdown |

**Remediation:**
- C1: Replace `execSync` with `execFileSync('git', ['clone', '--depth', '1', url, tmpDir])` to bypass shell entirely.
- C2: Validate `team.name` against `/^[a-z0-9_-]+$/i` before using in paths.
- C3: Validate `a.file` with `path.basename()` or restrict to allowed filenames.

---

## 🟡 High Priority — Fix for Reliability

| # | Issue | File:Line |
|---|-------|-----------|
| H1 | **agent_end handler has no outer try/catch** — any exception crashes the auto-pilot permanently | `index.ts:1042` |
| H2 | **autoPilotLocked leak** — not in try/finally; if `pi.sendUserMessage` throws, lock stays locked forever | `index.ts:1440` |
| H3 | **loadQuest normalization missing 9 fields** — `researchFindings`, `gitIntegration`, `team`, `createdAt`, `updatedAt`, `conventions`, `status`, `tasksSincePause`/`lastFiredTaskIndex`/`sameTaskCount` unprotected against corrupt JSON | `storage.ts:46-79` |
| H4 | **all write failures are silent** — disk full, permission errors, corruption all invisible with no logging | `utils.ts:18-21` (and 20+ catch blocks) |
| H5 | **quest_create silently overwrites** paused/planning/done quests — only blocks on `status === "active"` | `index.ts:70` |
| H6 | **quest_approve tool edits skip dependency re-validation** — can introduce out-of-bounds deps | `index.ts:690-698` |
| H7 | **Dependency deadlock** — deps on `failed`/`skipped` tasks never resolve (only checks `"done"`) | `steering.ts:9` |
| H8 | **/quest start on already-active silently resets burst counter** — bypasses MAX_BURST safety | `index.ts:1650` |
| H9 | **/quest approve has no plan review confirmation** — bypasses the tool's confirmation dialog | `index.ts:1710` |
| H10 | **Misleading pause when verifying tasks block dependents** — user sees "blocked by dependencies" instead of "verification needed" | `index.ts:1052-1268` |
| H11 | **No dependency cycle detection** — circular deps cause permanent deadlock | `index.ts:213-219` (bounds check only) |
| H12 | **3 of 4 built-in teams have verification=true but no verifier agent** — content, devops, research teams enter verify state with no configured verifier | `constants.ts:30-90` |

---

## 🟠 Medium Priority — UX & Correctness

| # | Issue | File:Line |
|---|-------|-----------|
| M1 | `"verifying"` task status maps to `"pending"` in todo list — should be `"in_progress"` | `todo-sync.ts:17` |
| M2 | todo sync over-filters: `content.startsWith("[Quest]")` heuristic could false-positive on user todos | `todo-sync.ts:57` |
| M3 | `session_start` missing notifications for `"planning"` and `"done"` quest states | `index.ts:1440-1455` |
| M4 | `renderStatus` uses same dim color for both `planning` and `paused` — poor differentiation | `status.ts:28` |
| M5 | `/quest team install` blocks UI (synchronous `execSync`, 30s timeout) | `index.ts:1595` |
| M6 | `/quest team install` rejects SSH URLs (`git@github.com:...`) — only checks `startsWith("http")` | `index.ts:1572` |
| M7 | `quest_update` can re-mark already-done tasks (no guard) | `index.ts:605` |
| M8 | `quest_commit` records commits for failed/pending tasks (no state validation) | `index.ts:820` |
| M9 | `quest_memory_save` has no limit on findings — unbounded growth in `memory.research` | `index.ts:991` |
| M10 | No archive cleanup — archive directory grows without bound | `storage.ts:90` |
| M11 | `quest_decide` doesn't handle `undefined` return from `ctx.ui.select` (idx=-1) | `index.ts:150` |
| M12 | `MAX_RETRIES=2` naming ambiguous — should be `MAX_RETRIES` = 2 additional attempts (3 total) or rename to `MAX_ATTEMPTS` | `constants.ts:7` |
| M13 | `QuestStatus "idle"` defined but never set by any code — orphaned/orphan state | `types.ts:1` |

---

## 🔵 Low Priority — Code Quality

| # | Issue | File:Line |
|---|-------|-----------|
| L1 | Kanban cache is dead code — outer render wrapper always invalidates before render | `index.ts:1496` + `kanban.ts:59` |
| L2 | Kanban `formatTaskCell` is O(n²) — `indexOf` per task cell | `kanban.ts:55` |
| L3 | Kanban `columns()` called redundantly — every keystroke recomputes 4 filters | `kanban.ts:26` |
| L4 | Stale dev comments in `utils.ts` (lines 47-49) | `utils.ts:47` |
| L5 | `MAX_DEPENDENCY_DEPTH = 3` defined but never enforced — dead code | `constants.ts:8` |
| L6 | `defaultAgent` on `TeamConfig` never used by quest system (only displayed) | `types.ts:53`, `teams.ts` |
| L7 | `quest_create` with only name (no colon) uses name as goal — ambiguous UX | `index.ts:1517` |
| L8 | `SyncedTodoItem.source` typed as `string \| undefined` — should be a union of known sources | `types.ts:69` |
| L9 | No input length limits on result strings, commit messages, or task contexts | multiple |
| L10 | `archiveQuest` return value unchecked in completion path | `index.ts:1144` |
| L11 | Empty `verifyEvidence` produces `"[PASS] "` with trailing space | `index.ts:451` |
| L12 | `quest_create` ignores invalid team name silently | `index.ts:40` |
| L13 | `quest_commit` doesn't validate `commitHash` format | `index.ts:800` |
| L14 | Agent markdown files silently overwrite on collision | `teams.ts:100` |

---

## 🆕 Missing Features

| # | Feature | Priority |
|---|---------|----------|
| F1 | `quest_abort` / `/quest cancel` — permanently abandon/archive a quest | High |
| F2 | `quest_task_detail` — get full task context (currently only via quest_status) | Medium |
| F3 | `/quest verify` — show pending verifications | Medium |
| F4 | `/quest conventions` — view/edit collected conventions | Low |
| F5 | `/quest tasks` — list tasks without opening kanban | Low |
| F6 | Kanban: vertical scroll, Enter to select, Page Up/Down | Medium |
| F7 | Error logging/telemetry for silent write failures | High |
| F8 | `loadQuest` v1→v2 migration path | Medium |

---

## Recommended v1.6 Roadmap

### Phase 1 — Security Hardening (ship immediately)
1. Fix C1-C3: shell injection + path traversals in `teams.ts`
2. Fix H2: `autoPilotLocked` try/finally
3. Fix H6: dependency re-validation in `quest_approve` edits

### Phase 2 — Reliability
4. Fix H1: outer try/catch in `agent_end` handler
5. Fix H3: complete `loadQuest` normalization for all fields
6. Fix H4: add error logging to all silent catch blocks
7. Fix H7/H11: dependency deadlock + cycle detection
8. Fix H10: correct pause reason when verification blocks dependents

### Phase 3 — UX Polish
9. Fix H5/H8/H9: quest_create overwrite warning, start guard, approve confirmation
10. Fix M1: "verifying" → "in_progress" todo mapping
11. Fix M3-M4: session_start notifications, status bar colors
12. Add F1/F2/F3: `quest_abort`, `quest_task_detail`, `/quest verify`

### Phase 4 — Code Quality
13. Fix L1-L3: remove kanban dead cache, O(n²) perf, redundant columns()
14. Fix L5: remove or enforce `MAX_DEPENDENCY_DEPTH`
15. Add F7: error telemetry

---

## Architecture Notes

### Strengths
- **Clean module separation**: types/constants/utils/storage/steering/status/teams/kanban/todo-sync — each ~50-200 lines, single responsibility.
- **Well-typed**: TypeBox schemas for all 11 tools, exhaustive TypeScript types.
- **State machine**: Clear lifecycle (planning→active→paused→done) with safety guards (burst, stall, retry).
- **Cross-extension contract**: Well-documented cohesion with pi-todo and pi-memory.

### Design Patterns Worth Keeping
- `nextPendingTask` — dependency-aware task dispatch
- `emptyQuest` factory — single source of truth for defaults
- `compactAwarenessBlock` — rich context injection without prompt bloat
- Kanban overlay — custom TUI component pattern

### Anti-patterns to Address
- Module-level mutable state (`questCache`, `autoPilotLocked`) — fragile
- Silent failures as design principle — debugging-unfriendly
- Type assertions (`as TaskStatus`, `as TeamConfig`) without runtime guards
- Duplicate data (commit tracking in both `QuestTask` and `Quest.commits`)
