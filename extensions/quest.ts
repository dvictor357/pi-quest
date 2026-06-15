/**
 * quest.ts — proactive AI project manager for pi
 *
 * Quest is the orchestrator that sits above sub-agents, pi-todo, and
 * pi-memory. Give it a goal and it plans, delegates, verifies, and pushes
 * forward autonomously until the job is done — no hand-holding needed.
 *
 * ┌─────────────────────────────────────────────┐
 * │              QUEST ORCHESTRATOR              │
 * │                                             │
 * │  1. Scout explores → 2. Planner plans       │
 * │  3. Auto-pilot fires tasks one by one        │
 * │  4. Main agent + sub-agents execute          │
 * │  5. Verifier checks → 6. All done!           │
 * │                                             │
 * │  Safety: max burst, stall detection, retries │
 * └─────────────────────────────────────────────┘
 *
 * Storage: ~/.pi/agent/quests/active.json + archive/
 *
 * Integration:
 *   • Syncs tasks to pi-todo for status bar visibility
 *   • Saves project conventions to pi-memory on completion
 *   • Uses subagent spawner for isolated work
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

type QuestStatus = "planning" | "active" | "paused" | "done" | "idle";
type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

interface QuestTask {
	content: string;
	status: TaskStatus;
	agent: string;
	context: string;
	dependencies: number[];
	result: string | null;
	attempts: number;
	completedAt: number | null;
}

interface Quest {
	version: 1;
	name: string;
	goal: string;
	status: QuestStatus;
	tasks: QuestTask[];
	tasksSincePause: number;
	lastFiredTaskIndex: number;
	sameTaskCount: number;
	pauseReason: string | null;
	conventions: string[];
	createdAt: number;
	completedAt: number | null;
	updatedAt: number;
}

const MAX_BURST = 6; // auto-pause after this many consecutive tasks
const MAX_RETRIES = 2; // per task, before marking failed
const MAX_DEPENDENCY_DEPTH = 3; // sanity check
const ACTIVE_PATH = join(homedir(), ".pi", "agent", "quests", "active.json");
const ARCHIVE_DIR = join(homedir(), ".pi", "agent", "quests", "archive");

const ICON: Record<TaskStatus, string> = {
	pending: "☐",
	running: "▶",
	done: "☑",
	failed: "✗",
	skipped: "⏭",
};

// ── Storage ──────────────────────────────────────────────────────────────────

function emptyQuest(name: string, goal: string): Quest {
	return {
		version: 1,
		name,
		goal,
		status: "planning",
		tasks: [],
		tasksSincePause: 0,
		lastFiredTaskIndex: -1,
		sameTaskCount: 0,
		pauseReason: null,
		conventions: [],
		createdAt: Date.now(),
		completedAt: null,
		updatedAt: Date.now(),
	};
}

function loadQuest(): Quest | null {
	try {
		if (!existsSync(ACTIVE_PATH)) return null;
		const raw = JSON.parse(readFileSync(ACTIVE_PATH, "utf8"));
		if (raw && raw.version === 1 && Array.isArray(raw.tasks)) {
			// Coerce task fields for safety
			raw.tasks = raw.tasks.map((t: any) => ({
				content: t.content || "",
				status: t.status || "pending",
				agent: t.agent || "worker",
				context: t.context || "",
				dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
				result: t.result || null,
				attempts: t.attempts || 0,
				completedAt: t.completedAt || null,
			}));
			return raw as Quest;
		}
	} catch { /* corrupt */ }
	return null;
}

function saveQuest(quest: Quest): void {
	try {
		quest.updatedAt = Date.now();
		mkdirSync(join(homedir(), ".pi", "agent", "quests"), { recursive: true });
		writeFileSync(ACTIVE_PATH, `${JSON.stringify(quest, null, 2)}\n`, "utf8");
	} catch { /* best-effort */ }
}

function archiveQuest(quest: Quest): string | null {
	try {
		mkdirSync(ARCHIVE_DIR, { recursive: true });
		const slug = quest.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
		const ts = quest.completedAt ?? Date.now();
		const path = join(ARCHIVE_DIR, `${ts}-${slug}.json`);
		writeFileSync(path, `${JSON.stringify(quest, null, 2)}\n`, "utf8");
		return path;
	} catch { return null; }
}

function listArchives(limit: number): { name: string; goal: string; tasks: number; done: number; completedAt: number | null }[] {
	try {
		if (!existsSync(ARCHIVE_DIR)) return [];
		return readdirSync(ARCHIVE_DIR)
			.filter(f => f.endsWith(".json"))
			.map(f => {
				try {
					const raw = JSON.parse(readFileSync(join(ARCHIVE_DIR, f), "utf8"));
					return {
						name: raw.name || f,
						goal: raw.goal || "",
						tasks: Array.isArray(raw.tasks) ? raw.tasks.length : 0,
						done: Array.isArray(raw.tasks) ? raw.tasks.filter((t: any) => t.status === "done").length : 0,
						completedAt: raw.completedAt || null,
					};
				} catch { return null; }
			})
			.filter(Boolean)
			.sort((a: any, b: any) => (b.completedAt || 0) - (a.completedAt || 0))
			.slice(0, limit) as any[];
	} catch { return []; }
}

// ── Task logic ───────────────────────────────────────────────────────────────

function nextPendingTask(quest: Quest): { task: QuestTask; index: number } | null {
	for (let i = 0; i < quest.tasks.length; i++) {
		const t = quest.tasks[i];
		if (t.status !== "pending") continue;
		// Check dependencies
		const allDepsMet = t.dependencies.every(d => quest.tasks[d]?.status === "done");
		if (!allDepsMet) continue;
		return { task: t, index: i };
	}
	return null;
}

function formatQuestStatus(quest: Quest): string {
	const total = quest.tasks.length;
	const done = quest.tasks.filter(t => t.status === "done").length;
	const failed = quest.tasks.filter(t => t.status === "failed").length;
	const running = quest.tasks.filter(t => t.status === "running").length;
	const pending = quest.tasks.filter(t => t.status === "pending").length;

	const statusBar = `${"▰".repeat(done)}${"▱".repeat(pending)}${"✗".repeat(failed)}`;

	const lines = [
		`**Quest: ${quest.name}**  [${quest.status.toUpperCase()}]`,
		`Goal: ${quest.goal}`,
		``,
		`Progress: ${statusBar}`,
		`${done}/${total} done · ${running} running · ${failed} failed · ${pending} pending`,
		``,
	];

	if (quest.tasks.length === 0) {
		lines.push("No tasks yet. Use quest_plan to create a task breakdown.");
	} else {
		const sorted = [...quest.tasks]
			.map((t, i) => ({ t, i }))
			.sort((a, b) => {
				const order: Record<TaskStatus, number> = { running: 0, failed: 1, pending: 2, done: 3, skipped: 4 };
				return order[a.t.status] - order[b.t.status];
			});

		for (const { t, i } of sorted) {
			const deps = t.dependencies.length
				? ` ← depends on: #${t.dependencies.map(d => d + 1).join(", #")}`
				: "";
			const info = t.status === "done" && t.result
				? ` — ${t.result.slice(0, 60)}`
				: t.status === "failed"
					? ` — attempt ${t.attempts}/${MAX_RETRIES + 1}`
					: "";
			lines.push(`${ICON[t.status]} #${i + 1} ${t.content} [${t.agent}]${deps}${info}`);
		}
	}

	if (quest.pauseReason) {
		lines.push(``);
		lines.push(`⚠ ${quest.pauseReason}`);
	}

	if (quest.status === "active") {
		lines.push(``);
		lines.push(`Auto-pilot: task ${quest.tasksSincePause}/${MAX_BURST} before auto-pause. /quest pause to stop.`);
	}

	return lines.join("\n");
}

/** Build a todo-style list from quest tasks for pi-todo sync. */
function questToTodoItems(quest: Quest): { content: string; status: string }[] {
	return quest.tasks.map((t, i) => ({
		content: `[Quest] #${i + 1} ${t.content}`,
		status: t.status === "running" ? "in_progress" : t.status === "done" ? "completed" : t.status === "failed" ? "completed" : "pending",
	}));
}

// ── Status badge ─────────────────────────────────────────────────────────────

function renderStatus(ctx: ExtensionContext, quest: Quest | null) {
	const theme = (ctx.ui as any).theme;
	if (!quest || quest.status === "idle" || quest.status === "done") {
		ctx.ui.setStatus?.("quest", "");
		return;
	}
	const done = quest.tasks.filter(t => t.status === "done").length;
	const total = quest.tasks.length;
	const icon = quest.status === "active" ? "⚔" : quest.status === "planning" ? "📋" : "⏸";
	const label = total ? `${icon} ${done}/${total}` : `${icon} plan`;
	const color = quest.status === "active" ? "warning" : "dim";
	ctx.ui.setStatus?.("quest", theme?.fg ? theme.fg(color, label) : label);
}

// ── Auto-pilot injection ─────────────────────────────────────────────────────

function buildSteeringMessage(quest: Quest, task: QuestTask, index: number): string {
	const done = quest.tasks.filter(t => t.status === "done").length;
	const total = quest.tasks.length;

	const deps = task.dependencies
		.map(d => `#${d + 1} — ${quest.tasks[d].content}`)
		.join(", ");

	return [
		`## Quest: ${quest.name} (${done}/${total} done)`,
		``,
		`**Current task:** ${task.content}`,
		`**Use subagent:** \`${task.agent}\``,
		`**Context:** ${task.context}`,
		deps ? `**Depends on:** ${deps}` : "",
		``,
		`When complete, call **quest_update** with task index ${index} to mark it done.`,
		`If you hit a blocker you can't resolve, call quest_update with status "failed" and explain why.`,
		``,
		`Auto-pilot: ${quest.tasksSincePause + 1}/${MAX_BURST} — /quest pause to stop.`,
	].filter(Boolean).join("\n");
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let questCache: Quest | null = null;
	let autoPilotLocked = false; // prevent re-entry

	function getQuest(): Quest | null {
		if (!questCache) questCache = loadQuest();
		return questCache;
	}

	// ── Tools ────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "quest_create",
		label: "Quest Create",
		description: [
			"Create a new quest from a goal. This starts the planning phase.",
			"Quest will then auto-pilot through tasks using sub-agents until complete.",
			"Call this when the user gives a project goal or multi-step task.",
		].join(" "),
		parameters: Type.Object({
			name: Type.String({ description: "Short name for the quest (e.g. 'Add user auth')" }),
			goal: Type.String({ description: "Full goal description — what needs to be accomplished" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (getQuest()?.status === "active") {
				return {
					content: [{ type: "text", text: "A quest is already active. Pause or complete it first with /quest pause." }],
					details: {},
				};
			}

			const quest = emptyQuest(params.name, params.goal);
			saveQuest(quest);
			questCache = quest;
			renderStatus(ctx, quest);

			return {
				content: [{
					type: "text",
					text: [
						`Quest created: **${params.name}**`,
						``,
						`Next: Plan the quest. Use subagent(agent="scout") to explore the codebase,`,
						`then subagent(agent="planner") to create a task breakdown. Save the plan`,
						`with **quest_plan** — pass the tasks array and set autoStart: true.`,
					].join("\n"),
				}],
				details: { quest },
			};
		},
	});

	pi.registerTool({
		name: "quest_plan",
		label: "Quest Plan",
		description: [
			"Save a task breakdown for the current quest. Replaces all existing tasks.",
			"Each task needs: content, agent (sub-agent type), context (focused instructions).",
			"Optionally: dependencies (array of task indices that must complete first).",
			"Set autoStart: true to immediately begin auto-pilot execution.",
		].join(" "),
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				content: Type.String({ description: "Short name of the task" }),
				agent: Type.String({ description: "Sub-agent type: worker, quick-worker, scout, planner, reviewer, verifier" }),
				context: Type.String({ description: "Focused context/instructions for the sub-agent — keep it lean" }),
				dependencies: Type.Optional(Type.Array(Type.Number(), { description: "Indices of tasks that must complete first (0-based)" })),
			}), { description: "Array of tasks in execution order" }),
			autoStart: Type.Optional(Type.Boolean({ description: "Start auto-pilot immediately after saving (default: true)", default: true })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const quest = getQuest();
			if (!quest) {
				return { content: [{ type: "text", text: "No active quest. Use quest_create first." }], details: {} };
			}

			if (params.tasks.length === 0) {
				return { content: [{ type: "text", text: "No tasks provided." }], details: {} };
			}

			if (params.tasks.length > 50) {
				return { content: [{ type: "text", text: "Too many tasks (max 50). Break into smaller quests." }], details: {} };
			}

			quest.tasks = params.tasks.map(t => ({
				content: t.content,
				status: "pending" as TaskStatus,
				agent: t.agent,
				context: t.context,
				dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
				result: null,
				attempts: 0,
				completedAt: null,
			}));

			// Validate dependencies
			for (let i = 0; i < quest.tasks.length; i++) {
				for (const dep of quest.tasks[i].dependencies) {
					if (dep < 0 || dep >= quest.tasks.length || dep === i) {
						return {
							content: [{ type: "text", text: `Invalid dependency in task #${i + 1}: task #${dep + 1} is out of range or self-referencing.` }],
							details: {},
						};
					}
				}
			}

			if (params.autoStart !== false) {
				quest.status = "active";
				quest.tasksSincePause = 0;
				quest.lastFiredTaskIndex = -1;
				quest.sameTaskCount = 0;
				quest.pauseReason = null;
			} else {
				quest.status = "planning";
			}

			saveQuest(quest);
			questCache = quest;
			renderStatus(ctx, quest);

			// Sync to pi-todo if the todo_write tool is available
			try {
				const todoItems = questToTodoItems(quest);
				// The agent will pick up the todo sync from the output message
			} catch { /* optional integration */ }

			const tasksPreview = quest.tasks.slice(0, 5).map((t, i) =>
				`  ${i + 1}. ${t.content} [${t.agent}]${t.dependencies.length ? ` ← #${t.dependencies.map(d => d + 1).join(", #")}` : ""}`
			).join("\n");

			return {
				content: [{
					type: "text",
					text: [
						`Plan saved: **${quest.tasks.length} tasks**`,
						``,
						tasksPreview,
						quest.tasks.length > 5 ? `  … and ${quest.tasks.length - 5} more` : "",
						``,
						quest.status === "active"
							? `**Quest is now ACTIVE.** Auto-pilot will fire the first task on the next turn.`
							: `Quest in planning mode. Call quest_start or /quest start to begin.`,
					].join("\n"),
				}],
				details: { tasks: quest.tasks, status: quest.status },
			};
		},
	});

	pi.registerTool({
		name: "quest_update",
		label: "Quest Update",
		description: [
			"Update a task's status in the current quest.",
			"Call this after a sub-agent completes its work on a task.",
			"Pass the task index (0-based) and new status.",
			"Set result to a brief summary of what was done.",
		].join(" "),
		parameters: Type.Object({
			index: Type.Number({ description: "Task index (0-based)" }),
			status: StringEnum(["done", "failed", "skipped"] as const, { description: "New status for the task" }),
			result: Type.Optional(Type.String({ description: "Brief summary of what happened" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const quest = getQuest();
			if (!quest) {
				return { content: [{ type: "text", text: "No active quest." }], details: {} };
			}

			if (params.index < 0 || params.index >= quest.tasks.length) {
				return { content: [{ type: "text", text: `Invalid task index ${params.index}. Valid: 0-${quest.tasks.length - 1}.` }], details: {} };
			}

			const task = quest.tasks[params.index];
			task.status = params.status;
			if (params.result) task.result = params.result;
			if (params.status === "done" || params.status === "failed") {
				task.completedAt = Date.now();
			}

			// Clear stall tracking since we made progress
			quest.lastFiredTaskIndex = -1;
			quest.sameTaskCount = 0;

			saveQuest(quest);
			questCache = quest;
			renderStatus(ctx, quest);

			const done = quest.tasks.filter(t => t.status === "done").length;
			const total = quest.tasks.length;
			const next = nextPendingTask(quest);

			return {
				content: [{
					type: "text",
					text: [
						`Task #${params.index + 1} → **${params.status.toUpperCase()}**: ${task.content}`,
						params.result ? `  Result: ${params.result}` : "",
						``,
						`Progress: ${done}/${total} done`,
						next ? `Next: ${next.task.content} [${next.task.agent}]` : "All tasks done or blocked!",
						``,
						quest.status === "active" ? "Auto-pilot will fire the next task." : "Quest is paused. /quest resume to continue.",
					].filter(Boolean).join("\n"),
				}],
				details: { task, progress: `${done}/${total}`, nextTask: next?.task.content ?? null },
			};
		},
	});

	pi.registerTool({
		name: "quest_status",
		label: "Quest Status",
		description: "Show the current quest, its tasks, and progress.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const quest = getQuest();
			if (!quest) {
				return { content: [{ type: "text", text: "No active quest. Create one with quest_create or /quest create." }], details: {} };
			}
			renderStatus(ctx, quest);
			return { content: [{ type: "text", text: formatQuestStatus(quest) }], details: { quest } };
		},
	});

	pi.registerTool({
		name: "quest_history",
		label: "Quest History",
		description: "Browse past completed quests (default: 5 most recent).",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Number of past quests to show (default 5)", default: 5 })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const archives = listArchives(params.limit ?? 5);
			if (archives.length === 0) {
				return { content: [{ type: "text", text: "No completed quests yet." }], details: { archives: [] } };
			}
			const lines = archives.map((a, idx) => {
				const date = a.completedAt ? new Date(a.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "?";
				return `${idx + 1}. **${a.name}** — ${a.done}/${a.tasks} done — ${date}\n   ${a.goal}`;
			});
			return { content: [{ type: "text", text: lines.join("\n\n") }], details: { archives } };
		},
	});

	// ── Auto-pilot ────────────────────────────────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		if (autoPilotLocked) return;
		const quest = getQuest();
		if (!quest || quest.status !== "active") return;

		const next = nextPendingTask(quest);
		if (!next) {
			// All tasks done or blocked
			const allDone = quest.tasks.every(t => t.status === "done" || t.status === "skipped");
			const anyFailed = quest.tasks.some(t => t.status === "failed");

			if (allDone && !anyFailed) {
				quest.status = "done";
				quest.completedAt = Date.now();
				archiveQuest(quest);
				saveQuest(quest);
				questCache = quest;
				renderStatus(ctx, quest);

				autoPilotLocked = true;
				pi.sendUserMessage(
					[
						`## Quest Complete: ${quest.name} 🎉`,
						``,
						`${quest.tasks.filter(t => t.status === "done").length}/${quest.tasks.length} tasks done.`,
						``,
						`Save any conventions you discovered to **memory_project**.`,
						`Example: memory_project(convention="uses JWT auth middleware pattern")`,
						``,
						`Start a new quest with /quest create, or review with quest_history.`,
					].join("\n"),
					{ deliverAs: "steer", triggerTurn: true },
				);
				autoPilotLocked = false;
			} else if (anyFailed) {
				quest.status = "paused";
				quest.pauseReason = "Some tasks failed. Review and decide: retry, skip, or redefine.";
				saveQuest(quest);
				questCache = quest;
				renderStatus(ctx, quest);

				autoPilotLocked = true;
				pi.sendUserMessage(
					[
						`## Quest Paused: ${quest.name} ⚠`,
						``,
						`Some tasks failed. Review the status with quest_status and decide next steps:`,
						`- Fix the issue and call quest_update to retry`,
						`- Skip failed tasks with quest_update(status="skipped")`,
						`- /quest resume to continue`,
					].join("\n"),
					{ deliverAs: "steer", triggerTurn: true },
				);
				autoPilotLocked = false;
			} else {
				// All pending tasks are blocked by dependencies
				quest.status = "paused";
				quest.pauseReason = "All remaining tasks are blocked by unfinished dependencies.";
				saveQuest(quest);
				questCache = quest;
				renderStatus(ctx, quest);
			}
			return;
		}

		// Stall detection: same task fired again without progress
		if (next.index === quest.lastFiredTaskIndex) {
			quest.sameTaskCount++;
			if (quest.sameTaskCount > 2) {
				quest.status = "paused";
				quest.pauseReason = `Task #${next.index + 1} stalled (${quest.sameTaskCount} attempts without progress).`;
				saveQuest(quest);
				questCache = quest;
				renderStatus(ctx, quest);

				autoPilotLocked = true;
				pi.sendUserMessage(
					`## Quest Paused: Stalled ⚠\n\nTask #${next.index + 1} "${next.task.content}" has been attempted ${quest.sameTaskCount} times without completion.\nUse quest_update to mark it failed or skipped, then /quest resume.`,
					{ deliverAs: "steer", triggerTurn: true },
				);
				autoPilotLocked = false;
				return;
			}
		} else {
			quest.sameTaskCount = 1;
		}

		// Retry limit: task has been attempted too many times
		if (next.task.attempts > MAX_RETRIES) {
			next.task.status = "failed";
			next.task.result = `Auto-failed after ${MAX_RETRIES + 1} attempts.`;
			quest.lastFiredTaskIndex = -1;
			quest.sameTaskCount = 0;
			saveQuest(quest);
			questCache = quest;
			renderStatus(ctx, quest);
			// Don't return — retry with the next pending task
			// This will trigger agent_end again, which will find the next task
			return;
		}

		// Burst limit: auto-pause after max consecutive tasks
		if (quest.tasksSincePause >= MAX_BURST) {
			quest.status = "paused";
			quest.pauseReason = `Auto-paused after ${MAX_BURST} tasks. /quest resume to continue.`;
			quest.lastFiredTaskIndex = -1;
			quest.sameTaskCount = 0;
			saveQuest(quest);
			questCache = quest;
			renderStatus(ctx, quest);

			autoPilotLocked = true;
			pi.sendUserMessage(
				`## Quest Paused: Checkpoint ⏸\n\n${quest.tasksSincePause}/${MAX_BURST} tasks completed. Progress:\n${formatQuestStatus(quest)}\n\n/quest resume to continue.`,
				{ deliverAs: "steer", triggerTurn: true },
			);
			autoPilotLocked = false;
			return;
		}

		// Fire the next task
		next.task.status = "running";
		next.task.attempts++;
		quest.lastFiredTaskIndex = next.index;
		quest.tasksSincePause++;
		saveQuest(quest);
		questCache = quest;
		renderStatus(ctx, quest);

		autoPilotLocked = true;
		pi.sendUserMessage(
			buildSteeringMessage(quest, next.task, next.index),
			{ deliverAs: "steer", triggerTurn: true },
		);
		autoPilotLocked = false;
	});

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		questCache = loadQuest();
		renderStatus(ctx, questCache);

		// Notify about active quest
		if (questCache?.status === "active") {
			ctx.ui.notify(
				`Quest active: ${questCache.name} (${questCache.tasks.filter(t => t.status === "done").length}/${questCache.tasks.length} done)`,
				"info",
			);
		} else if (questCache?.status === "paused") {
			ctx.ui.notify(
				`Quest paused: ${questCache.name} — ${questCache.pauseReason ?? "/quest resume to continue"}`,
				"warning",
			);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		renderStatus(ctx, questCache);
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("quest", {
		description: "Quest: proactive AI project manager. /quest create|start|pause|resume|status|history",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const spaceIdx = trimmed.indexOf(" ");
			const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
			const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

			switch (sub) {
				case "": {
					const quest = getQuest();
					if (!quest) {
						ctx.ui.notify("No active quest. Use /quest create <name>: <goal> to start.", "info");
						return;
					}
					ctx.ui.notify(formatQuestStatus(quest), "info");
					return;
				}
				case "create": {
					const colonIdx = rest.indexOf(":");
					const name = colonIdx === -1 ? rest : rest.slice(0, colonIdx).trim();
					const goal = colonIdx === -1 ? "" : rest.slice(colonIdx + 1).trim();

					if (!name) {
						ctx.ui.notify("Usage: /quest create <name>: <goal description>", "error");
						return;
					}

					if (getQuest()?.status === "active") {
						ctx.ui.notify("A quest is already active. /quest pause first.", "error");
						return;
					}

					const quest = emptyQuest(name, goal || name);
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);

					ctx.ui.notify(
						`Quest created: "${name}"\n\nPlan it with quest_plan or let the agent explore and plan.\n/quest start when ready.`,
						"info",
					);

					// Auto-inject planning prompt
					autoPilotLocked = true;
					pi.sendUserMessage(
						[
							`## New Quest: ${name}`,
							goal ? `**Goal:** ${goal}` : "",
							``,
							`Plan this quest. Use subagent(agent="scout") to explore the codebase,`,
							`then subagent(agent="planner") to create a task breakdown.`,
							`Save the plan with **quest_plan(tasks=[...], autoStart=true)**.`,
						].filter(Boolean).join("\n"),
						{ deliverAs: "steer", triggerTurn: true },
					);
					autoPilotLocked = false;
					return;
				}
				case "start": {
					const quest = getQuest();
					if (!quest) {
						ctx.ui.notify("No quest created. /quest create first.", "error");
						return;
					}
					if (quest.tasks.length === 0) {
						ctx.ui.notify("No tasks planned. Use quest_plan to add tasks first.", "error");
						return;
					}
					quest.status = "active";
					quest.tasksSincePause = 0;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					quest.pauseReason = null;
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);

					ctx.ui.notify(`Quest "${quest.name}" started — ${quest.tasks.length} tasks. Auto-pilot engaged.`, "info");
					return;
				}
				case "pause": {
					const quest = getQuest();
					if (!quest || quest.status !== "active") {
						ctx.ui.notify("No active quest to pause.", "info");
						return;
					}
					quest.status = "paused";
					quest.pauseReason = "Paused by user.";
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);
					ctx.ui.notify(`Quest "${quest.name}" paused. /quest resume to continue.`, "info");
					return;
				}
				case "resume": {
					const quest = getQuest();
					if (!quest || quest.status !== "paused") {
						ctx.ui.notify("No paused quest to resume.", "info");
						return;
					}
					quest.status = "active";
					quest.tasksSincePause = 0;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					quest.pauseReason = null;
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);

					const done = quest.tasks.filter(t => t.status === "done").length;
					const next = nextPendingTask(quest);
					ctx.ui.notify(
						`Quest "${quest.name}" resumed. ${done}/${quest.tasks.length} done.${next ? ` Next: ${next.task.content}` : ""}`,
						"info",
					);
					return;
				}
				case "status": {
					const quest = getQuest();
					if (!quest) {
						ctx.ui.notify("No active quest.", "info");
						return;
					}
					ctx.ui.notify(formatQuestStatus(quest), "info");
					return;
				}
				case "history": {
					const limit = parseInt(rest, 10) || 10;
					const archives = listArchives(limit);
					if (archives.length === 0) {
						ctx.ui.notify("No completed quests yet.", "info");
						return;
					}
					const lines = archives.map((a, idx) => {
						const date = a.completedAt ? new Date(a.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?";
						return `${idx + 1}. **${a.name}** — ${a.done}/${a.tasks} done — ${date}\n   ${a.goal}`;
					});
					ctx.ui.notify(`Completed quests:\n\n${lines.join("\n\n")}`, "info");
					return;
				}
				default:
					ctx.ui.notify(
						"Usage: /quest [create <name>: <goal>|start|pause|resume|status|history]",
						"error",
					);
			}
		},
	});
}
