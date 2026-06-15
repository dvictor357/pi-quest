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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────────────

type QuestStatus = "planning" | "active" | "paused" | "done" | "idle";
type TaskStatus = "pending" | "running" | "verifying" | "done" | "failed" | "skipped";

interface QuestTask {
	content: string;
	status: TaskStatus;
	agent: string;
	context: string;
	dependencies: number[];
	result: string | null;
	attempts: number;
	startedAt: number | null;
	completedAt: number | null;
	verified: boolean;
	verifyResult: string | null;
	verifyRetries: number;
	commitHash: string | null;
	branchName: string | null;
}

interface GitIntegration {
	autoCommit: boolean;
	autoBranch: boolean;
	autoPR: boolean;
	branchPrefix: string;
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
	team?: string;
	planningMode: "auto" | "approve";
	planApproved: boolean;
	verifyOnComplete: boolean;
	gitIntegration?: GitIntegration;
	commits: { taskIndex: number; hash: string; message: string; branch?: string; timestamp: number }[];
	createdAt: number;
	completedAt: number | null;
	updatedAt: number;
}

interface TeamConfig {
	name: string;
	description: string;
	lead: string;
	members: { role: string; agent: string }[];
	defaultAgent: string;
	verification: boolean;
	agents?: { name: string; description: string; markdown: string }[];
}

const MAX_BURST = 6; // auto-pause after this many consecutive tasks
const MAX_RETRIES = 2; // per task, before marking failed
const MAX_VERIFY_RETRIES = 2; // verification retries before marking task failed
const MAX_DEPENDENCY_DEPTH = 3; // sanity check
const ACTIVE_PATH = join(homedir(), ".pi", "agent", "quests", "active.json");
const ARCHIVE_DIR = join(homedir(), ".pi", "agent", "quests", "archive");

const ICON: Record<TaskStatus, string> = {
	pending: "☐",
	running: "▶",
	verifying: "🔍",
	done: "☑",
	failed: "✗",
	skipped: "⏭",
};

const TEAMS_DIR = join(homedir(), ".pi", "agent", "quests", "teams");

const BUILT_IN_TEAMS: Record<string, TeamConfig> = {
	engineering: {
		name: "engineering",
		description: "Balanced team for feature development with code review and testing",
		lead: "worker",
		members: [
			{ role: "developer", agent: "worker" },
			{ role: "reviewer", agent: "reviewer" },
			{ role: "tester", agent: "verifier" },
		],
		defaultAgent: "worker",
		verification: true,
	},
	research: {
		name: "research",
		description: "Exploration-first team with scout, planner, and worker support",
		lead: "scout",
		members: [
			{ role: "explorer", agent: "scout" },
			{ role: "planner", agent: "planner" },
			{ role: "implementer", agent: "worker" },
			{ role: "reviewer", agent: "reviewer" },
		],
		defaultAgent: "scout",
		verification: true,
	},
	content: {
		name: "content",
		description: "Content creation team with writer, editor, and reviewer roles",
		lead: "worker",
		members: [
			{ role: "writer", agent: "worker" },
			{ role: "editor", agent: "reviewer" },
			{ role: "fact-checker", agent: "scout" },
		],
		defaultAgent: "worker",
		verification: true,
	},
	devops: {
		name: "devops",
		description: "Infrastructure and deployment team with CI/CD, cloud, and security roles",
		lead: "worker",
		members: [
			{ role: "infra", agent: "worker" },
			{ role: "security", agent: "reviewer" },
			{ role: "monitoring", agent: "scout" },
			{ role: "release", agent: "verifier" },
		],
		defaultAgent: "worker",
		verification: true,
	},
};

// ── Storage ──────────────────────────────────────────────────────────────────

function emptyQuest(name: string, goal: string, team?: string, planningMode: "auto" | "approve" = "auto", verifyOnComplete = true, gitIntegration?: GitIntegration): Quest {
	const quest: Quest = {
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
		commits: [],
		planningMode,
		planApproved: false,
		verifyOnComplete,
		gitIntegration: gitIntegration ?? { autoCommit: true, autoBranch: true, autoPR: false, branchPrefix: "quest/" },
		createdAt: Date.now(),
		completedAt: null,
		updatedAt: Date.now(),
	};
	if (team) {
		ensureBuiltInTeams();
		const config = loadTeams()[team];
		if (config) {
			quest.team = team;
		}
	}
	return quest;
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
				verified: typeof t.verified === "boolean" ? t.verified : false,
				verifyResult: t.verifyResult || null,
				verifyRetries: typeof t.verifyRetries === "number" ? t.verifyRetries : 0,
				commitHash: t.commitHash || null,
				branchName: t.branchName || null,
				startedAt: typeof t.startedAt === "number" ? t.startedAt : null,
			}));
			// Coerce new fields for backward compatibility
			if (raw.planningMode !== "auto" && raw.planningMode !== "approve") {
				raw.planningMode = "auto";
			}
			if (typeof raw.planApproved !== "boolean") {
				raw.planApproved = false;
			}
			if (typeof raw.verifyOnComplete !== "boolean") {
				raw.verifyOnComplete = false;
			}
			if (!raw.commits || !Array.isArray(raw.commits)) {
				raw.commits = [];
			}
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

// ── Team config helpers ──────────────────────────────────────────────────────

function loadTeams(): Record<string, TeamConfig> {
	try {
		if (!existsSync(TEAMS_DIR)) return {};
		const teams: Record<string, TeamConfig> = {};
		for (const f of readdirSync(TEAMS_DIR)) {
			if (!f.endsWith(".json")) continue;
			try {
				const raw = JSON.parse(readFileSync(join(TEAMS_DIR, f), "utf8"));
				if (raw && raw.name) {
					teams[raw.name] = raw as TeamConfig;
				}
			} catch { /* skip corrupt files */ }
		}
		return teams;
	} catch { return {}; }
}

function saveTeam(team: TeamConfig): void {
	try {
		mkdirSync(TEAMS_DIR, { recursive: true });
		writeFileSync(join(TEAMS_DIR, `${team.name}.json`), `${JSON.stringify(team, null, 2)}\n`, "utf8");
	} catch { /* best-effort */ }
}

function ensureBuiltInTeams(): void {
	try {
		const existing = loadTeams();
		for (const key of Object.keys(BUILT_IN_TEAMS)) {
			if (!existing[key]) {
				saveTeam(BUILT_IN_TEAMS[key]);
			}
		}
	} catch { /* best-effort */ }
}

function teamInstallFromGit(url: string): { success: boolean; team?: TeamConfig; error?: string } {
	const tmpDir = join(homedir(), ".pi", "agent", "quests", "teams", ".tmp");
	try {
		// Clean up any previous temp
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }

		// Clone the repo
		const cloneOutput = execSync(`git clone --depth 1 "${url}" "${tmpDir}"`, {
			encoding: "utf8",
			timeout: 30000,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Look for team.json or quest-team.json in the root
		const candidates = ["team.json", "quest-team.json", "quest.team.json"];
		let raw: any = null;
		for (const c of candidates) {
			const p = join(tmpDir, c);
			if (existsSync(p)) {
				raw = JSON.parse(readFileSync(p, "utf8"));
				break;
			}
		}

		if (!raw) {
			return { success: false, error: `No team.json, quest-team.json, or quest.team.json found in repository root.` };
		}

		// Validate required fields
		if (!raw.name || !raw.description || !Array.isArray(raw.members)) {
			return { success: false, error: "Team config must have name, description, and members array." };
		}

		const team: TeamConfig = {
			name: raw.name,
			description: raw.description,
			lead: raw.lead || raw.members[0]?.agent || "worker",
			members: raw.members.map((m: any) => ({
				role: m.role || m.agent || "member",
				agent: m.agent || "worker",
			})),
			defaultAgent: raw.defaultAgent || raw.members[0]?.agent || "worker",
			verification: typeof raw.verification === "boolean" ? raw.verification : true,
		};

		// Handle custom agent markdown files
		if (Array.isArray(raw.agents)) {
			team.agents = raw.agents.map((a: any) => ({
				name: a.name || "",
				description: a.description || "",
				markdown: a.markdown || a.file ? (() => {
					const mdPath = join(tmpDir, a.file || `${a.name}.md`);
					try { return readFileSync(mdPath, "utf8"); } catch { return a.markdown || ""; }
				})() : "",
			}));
		}

		// Install custom agent markdown files to agent config dir
		if (team.agents && team.agents.length > 0) {
			const agentsDir = join(homedir(), ".pi", "agent", "agents");
			mkdirSync(agentsDir, { recursive: true });
			for (const agent of team.agents) {
				if (agent.markdown) {
					writeFileSync(join(agentsDir, `${agent.name}.md`), agent.markdown, "utf8");
				}
			}
		}

		// Save the team
		saveTeam(team);

		return { success: true, team };
	} catch (e: any) {
		return { success: false, error: e?.message || String(e) };
	} finally {
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
	}
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

function formatTaskTime(t: QuestTask): string {
	if (!t.startedAt) return "";
	const end = t.completedAt ?? Date.now();
	const ms = end - t.startedAt;
	if (ms < 60000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
	return `${Math.round(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
}

function formatQuestStatus(quest: Quest): string {
	const total = quest.tasks.length;
	const todo = quest.tasks.filter(t => t.status === "pending");
	const doing = quest.tasks.filter(t => t.status === "running" || t.status === "verifying");
	const completed = quest.tasks.filter(t => t.status === "done");
	const done = completed.length;
	const verified = completed.filter(t => t.verified).length;
	const failed = quest.tasks.filter(t => t.status === "failed");
	const skipped = quest.tasks.filter(t => t.status === "skipped");
	const verifying = quest.tasks.filter(t => t.status === "verifying");

	// Progress bar
	const barWidth = 20;
	const doneW = Math.round((done / Math.max(total, 1)) * barWidth);
	const vfyW = Math.round((verifying.length / Math.max(total, 1)) * barWidth);
	const failW = Math.round((failed.length / Math.max(total, 1)) * barWidth);
	const pendW = barWidth - doneW - vfyW - failW;
	const pbar = `${"█".repeat(doneW)}${"◎".repeat(vfyW)}${"░".repeat(Math.max(pendW, 0))}${"✗".repeat(failW)}`;

	const modeTag = quest.planningMode === "approve" ? ` · mode: ${quest.planningMode}` : "";
	const approveTag = (quest.planningMode === "approve" && !quest.planApproved) ? ` · ⚠ AWAITING` : "";
	const verifyTag = quest.verifyOnComplete ? ` · verify: on` : "";
	const gitTag = quest.gitIntegration?.autoCommit ? ` · git: ${quest.commits.length}c` : "";

	const lines: string[] = [
		`**Quest: ${quest.name}**  [${quest.status.toUpperCase()}${modeTag}${approveTag}${verifyTag}${gitTag}]`,
		`Goal: ${quest.goal}`,
		``,
		`\`${pbar}\`  ${done}/${total} done${verified > 0 ? ` (${verified} verified)` : ""}`,
		`${todo.length} todo · ${doing.length} in progress · ${failed.length} failed · ${skipped.length} skipped`,
	];

	if (quest.tasks.length === 0) {
		lines.push(``);
		lines.push("No tasks yet. Use quest_plan to create a task breakdown.");
	} else {
		const fmtDep = (t: QuestTask) => t.dependencies.length
			? ` ← #${t.dependencies.map(d => d + 1).join(",#")}`
			: "";

		// ── TODO ─────────────────────────────────────────────────────────
		if (todo.length > 0) {
			lines.push(``, `━━━ 📋 TODO (${todo.length}) ━━━━━━━━━━━━━━━━━━━━━━━`);
			for (const t of todo) {
				const i = quest.tasks.indexOf(t);
				lines.push(`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${fmtDep(t)}`);
			}
		}

		// ── IN PROGRESS ──────────────────────────────────────────────────
		if (doing.length > 0) {
			lines.push(``, `━━━ 🔄 IN PROGRESS (${doing.length}) ━━━━━━━━━━━━━━━`);
			for (const t of doing) {
				const i = quest.tasks.indexOf(t);
				const time = formatTaskTime(t);
				const timeStr = time ? ` ⏱ ${t.status === "verifying" ? "verifying " : ""}${time}` : "";
				const vInfo = t.status === "verifying"
					? (t.verifyResult ? ` — ${t.verifyResult.slice(0, 40)}` : ` — verifying...`)
					: "";
				lines.push(`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${timeStr}${vInfo}${fmtDep(t)}`);
			}
		}

		// ── DONE ─────────────────────────────────────────────────────────
		if (completed.length > 0) {
			lines.push(``, `━━━ ✅ DONE (${completed.length}) ━━━━━━━━━━━━━━━━━━━━━`);
			for (const t of completed) {
				const i = quest.tasks.indexOf(t);
				const time = formatTaskTime(t);
				const timeStr = time ? ` ⏱ ${time}` : "";
				const verifiedStr = t.verified ? ` ✅` : "";
				const resultSnippet = t.result ? ` — ${t.result.slice(0, 50)}` : "";
				lines.push(`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${verifiedStr}${timeStr}${resultSnippet}`);
			}
		}

		// ── FAILED / SKIPPED ─────────────────────────────────────────────
		if (failed.length > 0 || skipped.length > 0) {
			lines.push(``, `━━━ ❌ FAILED / SKIPPED (${failed.length + skipped.length}) ━━━`);
			for (const t of [...failed, ...skipped]) {
				const i = quest.tasks.indexOf(t);
				const info = t.status === "failed"
					? ` — attempts ${t.attempts}/${MAX_RETRIES + 1}${t.verifyResult ? ` · ${t.verifyResult.slice(0, 30)}` : ""}`
					: "";
				lines.push(`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${info}`);
			}
		}
	}

	// Warnings
	if (quest.pauseReason) {
		lines.push(``, `⚠ ${quest.pauseReason}`);
	}
	if (quest.planningMode === "approve" && !quest.planApproved && quest.tasks.length > 0) {
		lines.push(``, `📋 Plan needs approval. Use /quest approve or quest_approve to start execution.`);
	}
	if (quest.status === "active") {
		lines.push(``, `Auto-pilot: task ${quest.tasksSincePause}/${MAX_BURST} before auto-pause. /quest pause to stop.`);
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
			team: Type.Optional(Type.String({ description: "Team configuration name (e.g. 'engineering', 'research')" })),
			planningMode: Type.Optional(StringEnum(["auto", "approve"] as const, { description: "'auto' skips approval and starts immediately after planning. 'approve' waits for quest_approve before executing tasks." })),
			verifyOnComplete: Type.Optional(Type.Boolean({ description: "Auto-verify completed tasks with a verifier sub-agent (default: true)", default: true })),
			gitIntegration: Type.Optional(Type.Object({
				autoCommit: Type.Optional(Type.Boolean({ description: "Auto-commit on task completion (default: true)", default: true })),
				autoBranch: Type.Optional(Type.Boolean({ description: "Auto-create branches per task (default: true)", default: true })),
				autoPR: Type.Optional(Type.Boolean({ description: "Open PR on quest completion (default: false)", default: false })),
				branchPrefix: Type.Optional(Type.String({ description: "Branch name prefix (default: 'quest/')", default: "quest/" })),
			})),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (getQuest()?.status === "active") {
				return {
					content: [{ type: "text", text: "A quest is already active. Pause or complete it first with /quest pause." }],
					details: {},
				};
			}

			const quest = emptyQuest(params.name, params.goal, params.team, params.planningMode ?? "auto", params.verifyOnComplete ?? true, params.gitIntegration);
			saveQuest(quest);
			questCache = quest;
			renderStatus(ctx, quest);

			const modeNote = params.planningMode === "approve"
				? `\n⚠ **Approval mode** — after the plan is created, it must be approved with **quest_approve** before execution begins.`
				: "";
			return {
				content: [{
					type: "text",
					text: [
						`Quest created: **${params.name}**`,
						``,
						`Next: Plan the quest. Use subagent(agent="scout") to explore the codebase,`,
						`then subagent(agent="planner") to create a task breakdown. Save the plan`,
						`with **quest_plan** — pass the tasks array and set autoStart: true.`,
						modeNote,
					].filter(Boolean).join("\n"),
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
				startedAt: null,
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

			const needsApproval = quest.planningMode === "approve" && !quest.planApproved;

			if (params.autoStart !== false) {
				if (needsApproval) {
					// Stay in planning, wait for quest_approve
					quest.status = "planning";
					quest.pauseReason = "Plan ready — awaiting approval. Use quest_approve or /quest approve to start.";
				} else {
					quest.status = "active";
					quest.tasksSincePause = 0;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					quest.pauseReason = null;
					quest.planApproved = true;
				}
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

			const approvalMsg = needsApproval
				? [
					``,
					`---`,
					``,
					`## Plan Review`,
					``,
					quest.tasks.map((t, i) => {
						const deps = t.dependencies.length ? ` (requires: ${t.dependencies.map(d => quest.tasks[d].content).join(", ")})` : "";
						return `${i + 1}. **${t.content}** [${t.agent}]${deps}\n   ${t.context}`;
					}).join("\n\n"),
					``,
					`---`,
					``,
					`⚠ **Plan needs your approval.** Review the tasks above.`,
					`- Approve: call **quest_approve()** or type /quest approve`,
					`- Edit tasks: call **quest_approve(edits=[...])** with task modifications`,
					`- Reject: call quest_plan with a new set of tasks`,
				].join("\n")
				: "";

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
							: needsApproval
								? `Awaiting approval. Review the plan above and call quest_approve to start.`
								: `Quest in planning mode. Call quest_start or /quest start to begin.`,
						approvalMsg,
					].filter(Boolean).join("\n"),
				}],
				details: { tasks: quest.tasks, status: quest.status, needsApproval },
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
			"To report verification results: pass verifyOutcome='PASS'|'FAIL' and verifyEvidence.",
		].join(" "),
		parameters: Type.Object({
			index: Type.Number({ description: "Task index (0-based)" }),
			status: StringEnum(["done", "failed", "skipped"] as const, { description: "New status for the task" }),
			result: Type.Optional(Type.String({ description: "Brief summary of what happened" })),
			verifyOutcome: Type.Optional(StringEnum(["PASS", "FAIL"] as const, { description: "Verification outcome. Use on a 'verifying' task to report PASS or FAIL." })),
			verifyEvidence: Type.Optional(Type.String({ description: "Evidence/details from the verifier for PASS or FAIL" })),
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

			// ── Verification outcome ──────────────────────────────────────────
			if (params.verifyOutcome) {
				if (task.status !== "verifying") {
					return { content: [{ type: "text", text: `Task #${params.index + 1} is not in verifying state. Current: ${task.status}.` }], details: {} };
				}

				task.verifyResult = `[${params.verifyOutcome}] ${params.verifyEvidence || ""}`.trim();
				task.verified = true;

				if (params.verifyOutcome === "PASS") {
					task.status = "done";
					task.completedAt = Date.now();

					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);

					const done = quest.tasks.filter(t => t.status === "done").length;
					const next = nextPendingTask(quest);
					const git = quest.gitIntegration;
					const gitPrompt = git?.autoCommit
						? [
							``,
							`📝 **Git:** After committing, record with quest_commit(taskIndex=${params.index}, commitHash="...", commitMessage="[quest/${quest.name}] task #${params.index + 1}: ${task.content}", ...)`,
						].join("\n")
						: "";
					return {
						content: [{
							type: "text",
							text: [
								`✅ Task #${params.index + 1} **VERIFIED PASS**: ${task.content}`,
								params.verifyEvidence ? `  Evidence: ${params.verifyEvidence}` : "",
								``,
								`Task marked done. Progress: ${done}/${quest.tasks.length} done`,
								next ? `Next: ${next.task.content} [${next.task.agent}]` : "All tasks done or blocked!",
								gitPrompt,
							].filter(Boolean).join("\n"),
						}],
						details: { task, verified: true, outcome: "PASS", progress: `${done}/${quest.tasks.length}` },
					};
				}

				// FAIL
				task.verifyRetries++;
				const retriesLeft = MAX_VERIFY_RETRIES - task.verifyRetries;

				if (retriesLeft > 0) {
					// Retry: reset to pending with fix context
					task.status = "pending";
					task.attempts = 0;
					task.startedAt = null;
					task.result = `Verification FAIL #${task.verifyRetries}: ${params.verifyEvidence || "no details"}. Fix and retry (${retriesLeft} retries left).`;
					task.context = `${task.context}\n\n[Verification FAIL #${task.verifyRetries}]: ${params.verifyEvidence || "see above"}. Fix the issues and try again.`;
					task.completedAt = null;

					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);

					return {
						content: [{
							type: "text",
							text: [
								`❌ Task #${params.index + 1} **VERIFICATION FAIL**: ${task.content}`,
								params.verifyEvidence ? `  Evidence: ${params.verifyEvidence}` : "",
								``,
								`Retry ${task.verifyRetries}/${MAX_VERIFY_RETRIES}. Task reset to pending with fix context.`,
								`${retriesLeft} verification retries remaining before auto-fail.`,
							].join("\n"),
						}],
						details: { task, verified: false, outcome: "FAIL", retriesLeft },
					};
				}

				// No retries left: auto-fail
				task.status = "failed";
				task.completedAt = Date.now();
				task.result = `Verification FAIL after ${MAX_VERIFY_RETRIES} retries: ${params.verifyEvidence || "no details"}`;

				quest.lastFiredTaskIndex = -1;
				quest.sameTaskCount = 0;
				saveQuest(quest);
				questCache = quest;
				renderStatus(ctx, quest);

				return {
					content: [{
						type: "text",
						text: [
							`❌ Task #${params.index + 1} **AUTO-FAILED** (${MAX_VERIFY_RETRIES} verification retries exhausted): ${task.content}`,
							params.verifyEvidence ? `  Last evidence: ${params.verifyEvidence}` : "",
						].join("\n"),
					}],
					details: { task, verified: false, outcome: "FAIL", exhausted: true },
				};
			}

			// ── Normal completion — check if verification needed ─────────────
			if (params.status === "done" && quest.verifyOnComplete) {
				// Check if team has a verifier configured
				const team = quest.team ? loadTeams()[quest.team] : null;
				const hasVerifier = team?.verification ?? true; // default true for unteamed quests

				if (hasVerifier) {
					task.status = "verifying";
					if (params.result) task.result = params.result;
					task.verifyRetries = 0;
					task.verified = false;
					task.verifyResult = null;

					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);

					const verifierAgent = team?.members.find(m => m.agent === "verifier" || m.role === "tester")?.agent ?? "verifier";
					return {
						content: [{
							type: "text",
							text: [
								`🔍 Task #${params.index + 1} **entered verification**: ${task.content}`,
								``,
								`**Task result to verify:**`,
								`> ${params.result || task.result || "(no result provided)"}`,
								``,
								`**Verification step:** Spawn a \`subagent(agent="${verifierAgent}")\` to verify this task.`,
								`The verifier should check:`,
								`1. Does the result match the task requirements?`,
								`2. Is the implementation correct and complete?`,
								`3. Are there any issues or missing pieces?`,
								``,
								`**After verification, call quest_update with:**`,
								`- **verifyOutcome="PASS"** and verifyEvidence if the result is correct`,
								`- **verifyOutcome="FAIL"** and verifyEvidence explaining what needs fixing`,
								``,
								`Task context: ${task.context}`,
								`${MAX_VERIFY_RETRIES} verification retries available before auto-fail.`,
							].join("\n"),
						}],
						details: { task, verifying: true, verifierAgent },
					};
				}
			}

			// ── Normal status update (no verification, or FAIL/skipped) ──────
			task.status = params.status;
			if (params.result) task.result = params.result;
			if (params.status === "done" || params.status === "failed") {
				task.completedAt = Date.now();
			}

			// Git integration: prompt for commit on task completion
			const git = quest.gitIntegration;
			const gitPrompt = (params.status === "done" && git?.autoCommit)
				? [
					``,
					`---`,
					``,
					`## Git Integration`,
					``,
					git.autoBranch
						? `**Recommended branch:** \`${git.branchPrefix || "quest/"}task-${params.index + 1}-${quest.tasks[params.index].content.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40)}\``
						: "",
					`**Commit message prefix:** \`[quest/${quest.name}] task #${params.index + 1}: ${quest.tasks[params.index].content}\``,
					``,
					`After committing, record the commit with **quest_commit**:`,
					`\`quest_commit(taskIndex=${params.index}, commitHash="...", commitMessage="...", branchName="...")\``,
					`Or call quest_git_summary() to review all quest commits.`,
				].filter(Boolean).join("\n")
				: "";

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
						gitPrompt,
					].filter(Boolean).join("\n"),
				}],
				details: { task, progress: `${done}/${total}`, nextTask: next?.task.content ?? null },
			};
		},
	});

	pi.registerTool({
		name: "quest_approve",
		label: "Quest Approve",
		description: [
			"Approve the current quest plan and start execution.",
			"Only needed when planningMode is 'approve'.",
			"Optionally pass edits to modify tasks before starting.",
		].join(" "),
		parameters: Type.Object({
			edits: Type.Optional(Type.Array(Type.Object({
				index: Type.Number({ description: "Task index to edit (0-based)" }),
				content: Type.Optional(Type.String({ description: "New task content" })),
				agent: Type.Optional(Type.String({ description: "New sub-agent type" })),
				context: Type.Optional(Type.String({ description: "New context/instructions" })),
				dependencies: Type.Optional(Type.Array(Type.Number(), { description: "New dependency indices" })),
			}), { description: "Optional task edits to apply before starting" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const quest = getQuest();
			if (!quest) {
				return { content: [{ type: "text", text: "No active quest. Use quest_create first." }], details: {} };
			}

			if (quest.planApproved) {
				return { content: [{ type: "text", text: "Plan already approved. Quest is in progress or completed." }], details: {} };
			}

			if (quest.tasks.length === 0) {
				return { content: [{ type: "text", text: "No tasks to approve. Use quest_plan to create a task breakdown first." }], details: {} };
			}

			// Apply edits if provided
			if (params.edits) {
				for (const edit of params.edits) {
					if (edit.index < 0 || edit.index >= quest.tasks.length) {
						return { content: [{ type: "text", text: `Invalid edit index ${edit.index}. Valid: 0-${quest.tasks.length - 1}.` }], details: {} };
					}
					const task = quest.tasks[edit.index];
					if (edit.content !== undefined) task.content = edit.content;
					if (edit.agent !== undefined) task.agent = edit.agent;
					if (edit.context !== undefined) task.context = edit.context;
					if (edit.dependencies !== undefined) task.dependencies = edit.dependencies;
				}
			}

			// Transition to active
			quest.planApproved = true;
			quest.status = "active";
			quest.tasksSincePause = 0;
			quest.lastFiredTaskIndex = -1;
			quest.sameTaskCount = 0;
			quest.pauseReason = null;

			saveQuest(quest);
			questCache = quest;
			renderStatus(ctx, quest);

			const next = nextPendingTask(quest);
			return {
				content: [{
					type: "text",
					text: [
						`✅ Plan approved: **${quest.name}**`,
						``,
						`${quest.tasks.length} tasks queued. Quest is now **ACTIVE**.`,
						next ? `First task: ${next.task.content} [${next.task.agent}]` : "All tasks ready.",
						``,
						"Auto-pilot will fire the first task on the next turn.",
					].join("\n"),
				}],
				details: { approved: true, tasks: quest.tasks.length, nextTask: next?.task.content ?? null },
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
		name: "quest_commit",
		label: "Quest Commit",
		description: [
			"Record a git commit as a deliverable for a completed quest task.",
			"Use this after committing code changes for a specific task.",
			"Each commit is tracked and included in the quest's git summary.",
		].join(" "),
		parameters: Type.Object({
			taskIndex: Type.Number({ description: "Task index (0-based) that this commit belongs to" }),
			commitHash: Type.String({ description: "Git commit hash (short or full SHA)" }),
			commitMessage: Type.String({ description: "Commit message" }),
			branchName: Type.Optional(Type.String({ description: "Branch name where the commit was made" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const quest = getQuest();
			if (!quest) {
				return { content: [{ type: "text", text: "No active quest. Use quest_create first." }], details: {} };
			}

			if (params.taskIndex < 0 || params.taskIndex >= quest.tasks.length) {
				return { content: [{ type: "text", text: `Invalid task index ${params.taskIndex}. Valid: 0-${quest.tasks.length - 1}.` }], details: {} };
			}

			const task = quest.tasks[params.taskIndex];
			task.commitHash = params.commitHash;
			if (params.branchName) task.branchName = params.branchName;

			// Add to quest commit log
			quest.commits.push({
				taskIndex: params.taskIndex,
				hash: params.commitHash,
				message: params.commitMessage,
				branch: params.branchName,
				timestamp: Date.now(),
			});

			saveQuest(quest);
			questCache = quest;
			renderStatus(ctx, quest);

			return {
				content: [{
					type: "text",
					text: [
						`📝 Commit recorded for task #${params.taskIndex + 1}: **${task.content}**`,
						`  Hash: \`${params.commitHash.slice(0, 8)}\``,
						`  Message: ${params.commitMessage}`,
						params.branchName ? `  Branch: ${params.branchName}` : "",
						``,
						`Total quest commits: ${quest.commits.length}`,
					].filter(Boolean).join("\n"),
				}],
				details: { taskIndex: params.taskIndex, commitHash: params.commitHash, totalCommits: quest.commits.length },
			};
		},
	});

	pi.registerTool({
		name: "quest_git_summary",
		label: "Quest Git Summary",
		description: [
			"Show a summary of all git commits associated with this quest.",
			"Also generates a PR-ready summary of all changes.",
		].join(" "),
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			const quest = getQuest();
			if (!quest) {
				return { content: [{ type: "text", text: "No active quest." }], details: {} };
			}

			const git = quest.gitIntegration;
			if (!quest.commits || quest.commits.length === 0) {
				return {
					content: [{ type: "text", text: "No commits recorded for this quest yet. Use quest_commit to record them." }],
					details: { commits: [], gitConfig: git },
				};
			}

			const commitsByTask = quest.commits.reduce((acc, c) => {
				const task = quest.tasks[c.taskIndex];
				const key = `#${c.taskIndex + 1} ${task?.content || "unknown"}`;
				if (!acc[key]) acc[key] = [];
				acc[key].push(c);
				return acc;
			}, {} as Record<string, typeof quest.commits>);

			const lines: string[] = [
				`## Git Summary: ${quest.name}`,
				``,
				`**${quest.commits.length} commit(s)** across **${Object.keys(commitsByTask).length} task(s)**`,
				``,
			];

			for (const [taskLabel, commits] of Object.entries(commitsByTask)) {
				lines.push(`### ${taskLabel}`);
				for (const c of commits) {
					lines.push(`- \`${c.hash.slice(0, 8)}\` ${c.message}${c.branch ? ` *(branch: ${c.branch})*` : ""}`);
				}
				lines.push(``);
			}

			// PR-ready summary
			if (git?.autoPR) {
				lines.push(`---`);
				lines.push(``);
				lines.push(`### PR Summary (auto-generated)`);
				lines.push(``);
				lines.push(`**Goal:** ${quest.goal}`);
				lines.push(``);
				lines.push(`**Changes:**`);
				for (const c of quest.commits) {
					lines.push(`- ${c.message}`);
				}
				lines.push(``);
				lines.push(`**Tasks completed:** ${quest.tasks.filter(t => t.status === "done").length}/${quest.tasks.length}`);
				lines.push(`**Commits:** ${quest.commits.length}`);
				if (git.autoBranch) {
					const branches = [...new Set(quest.commits.map(c => c.branch).filter(Boolean))];
					lines.push(`**Branches:** ${branches.join(", ") || "default"}`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { commits: quest.commits, tasksWithCommits: Object.keys(commitsByTask).length, gitConfig: git },
			};
		},
	});

	pi.registerTool({
		name: "quest_team",
		label: "Quest Team",
		description: [
			"List available team configurations and their member agents.",
			"Teams define which sub-agents are used for different roles in a quest.",
			"Use the team parameter in quest_create to assign a team.",
		].join(" "),
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			ensureBuiltInTeams();
			const teams = loadTeams();
			const names = Object.keys(teams);
			if (names.length === 0) {
				return { content: [{ type: "text", text: "No teams configured. Built-in teams will be created on first run." }], details: { teams: [] } };
			}
			const lines = names.map(n => {
				const t = teams[n]!;
				const members = t.members.map(m => `${m.role} → ${m.agent}`).join(", ");
				const agentsInfo = t.agents?.length ? `\n  Custom agents: ${t.agents.map(a => a.name).join(", ")}` : "";
				return [
					`**${t.name}** — ${t.description}`,
					`  Lead: ${t.lead}  |  Default agent: ${t.defaultAgent}  |  Verification: ${t.verification ? "on" : "off"}`,
					`  Members: ${members}${agentsInfo}`,
				].join("\n");
			});
			return {
				content: [{ type: "text", text: `## Quest Teams\n\n${lines.join("\n\n")}` }],
				details: { teams: names },
			};
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
			// Check for stuck verification tasks
			const verifyingTasks = quest.tasks.filter(t => t.status === "verifying");
			if (verifyingTasks.length > 0) {
				// If only verifying tasks remain (all others done/skipped/failed)
				const allResolved = quest.tasks.every(t =>
					t.status === "done" || t.status === "skipped" || t.status === "failed" || t.status === "verifying"
				);
				if (allResolved) {
					quest.status = "paused";
					quest.pauseReason = `Waiting for verification on ${verifyingTasks.length} task(s): ${verifyingTasks.map(t => t.content).join(", ")}. Resolve with quest_update(verifyOutcome=...).`;
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);

					autoPilotLocked = true;
					pi.sendUserMessage(
						[
							`## Verification Pending ⏳`,
							``,
							`${verifyingTasks.length} task(s) awaiting verification:`,
							verifyingTasks.map((t, i) => {
								const idx = quest.tasks.indexOf(t);
								return `- #${idx + 1} **${t.content}** — call quest_update(index=${idx}, verifyOutcome="PASS"|"FAIL", verifyEvidence=...)`;
							}).join("\n"),
							``,
							`/quest resume after resolving verification.`,
						].join("\n"),
						{ deliverAs: "steer", triggerTurn: true },
					);
					autoPilotLocked = false;
					return;
				}
			}

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

				const git = quest.gitIntegration;
				const gitSection = (quest.commits.length > 0)
					? [
						``,
						`## Git Summary`,
						``,
						`**${quest.commits.length} commit(s)** recorded.`,
						quest.commits.slice(0, 5).map(c => `- \`${c.hash.slice(0, 8)}\` ${c.message}`).join("\n"),
						quest.commits.length > 5 ? `- ... and ${quest.commits.length - 5} more` : "",
						git?.autoPR ? [
							``,
							`**🔀 Auto-PR enabled.** Generate a PR with quest_git_summary().`,
						].join("\n") : "",
					].filter(Boolean).join("\n")
					: (git?.autoCommit ? `\n\n⚠ No commits were recorded for this quest. Use quest_commit to track deliverables.` : "");

				autoPilotLocked = true;
				pi.sendUserMessage(
					[
						`## Quest Complete: ${quest.name} 🎉`,
						``,
						`${quest.tasks.filter(t => t.status === "done").length}/${quest.tasks.length} tasks done.`,
						gitSection,
						``,
						`Save any conventions you discovered to **memory_project**.`,
						`Example: memory_project(convention="uses JWT auth middleware pattern")`,
						``,
						`Start a new quest with /quest create, or review with quest_history.`,
					].filter(Boolean).join("\n"),
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
		if (!next.task.startedAt) next.task.startedAt = Date.now();
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
		} else if (questCache?.planningMode === "approve" && !questCache.planApproved && questCache.tasks.length > 0) {
			ctx.ui.notify(
				`Quest awaiting approval: ${questCache.name} — ${questCache.tasks.length} tasks planned. /quest approve to start.`,
				"warning",
			);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		renderStatus(ctx, questCache);
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("quest", {
		description: "Quest: proactive AI project manager. /quest create|start|pause|resume|approve|kanban|status|history|git|team [list|create]",
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
				case "team": {
				const args = rest.split(/\s+/).filter(Boolean);
				const subCmd = args[0] || "list";
				const subRest = args.slice(1).join(" ");

				if (subCmd === "list" || !rest) {
					ensureBuiltInTeams();
					const teams = loadTeams();
					const names = Object.keys(teams);
					if (names.length === 0) {
						ctx.ui.notify("No teams found. Built-in teams will be created on next load.", "info");
						return;
					}
					const lines = names.map(n => {
						const t = teams[n]!;
						const members = t.members.map(m => `${m.role}:${m.agent}`).join(", ");
						const agentInfo = t.agents?.length ? `\n  Custom agents: ${t.agents.map(a => a.name).join(", ")}` : "";
						return `**${t.name}** — ${t.description}\n  Lead: ${t.lead} · Default: ${t.defaultAgent} · Verify: ${t.verification}\n  Members: ${members}${agentInfo}`;
					});
					ctx.ui.notify(`Teams:\n\n${lines.join("\n\n")}`, "info");
					return;
				}

				if (subCmd === "install") {
					const gitUrl = subRest;
					if (!gitUrl || !gitUrl.startsWith("http")) {
						ctx.ui.notify("Usage: /quest team install <git-url>\n\nExample: /quest team install https://github.com/user/quest-team-content", "error");
						return;
					}
					ctx.ui.notify(`Installing team from ${gitUrl}...`, "info");

					const result = teamInstallFromGit(gitUrl);
					if (result.success) {
						const t = result.team!;
						const members = t.members.map(m => `${m.role}:${m.agent}`).join(", ");
						ctx.ui.notify(
							`✅ Team installed: **${t.name}**\n\n${t.description}\nLead: ${t.lead} · Default: ${t.defaultAgent}\nMembers: ${members}`,
							"info",
						);
					} else {
						ctx.ui.notify(`❌ Install failed: ${result.error}`, "error");
					}
					return;
				}

				if (subCmd === "create") {
					ctx.ui.notify(
						[
							`## Create a Team Template`,
							``,
							`To create a custom team, create a JSON file in:`,
							`\`${TEAMS_DIR}/your-team-name.json\``,
							``,
							`**Required fields:**`,
							`\`\`\`json`,
							JSON.stringify({
								name: "my-team",
								description: "My custom team description",
								lead: "worker",
								members: [
									{ role: "developer", agent: "worker" },
									{ role: "reviewer", agent: "reviewer" },
								],
								defaultAgent: "worker",
								verification: true,
							}, null, 2),
							`\`\`\``,
							``,
							`**Optional: custom agents** — add agent markdown files to:`,
							`\`${join(homedir(), ".pi", "agent", "agents")}/<agent-name>.md\``,
							``,
							`Then reference them in \`members\`. To share, push your team JSON +`,
							`agent markdown files to a GitHub repo and others can install with:`,
							`\`/quest team install <git-url>\``,
						].join("\n"),
						"info",
					);
					return;
				}

				ctx.ui.notify("Usage: /quest team [list|install <git-url>|create]", "error");
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
					// Check approval gate
					if (quest.planningMode === "approve" && !quest.planApproved) {
						ctx.ui.notify(
							"This quest requires plan approval before starting.\n\nUse /quest approve to review and approve the plan.",
							"warning",
						);
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
				case "approve": {
					const quest = getQuest();
					if (!quest) {
						ctx.ui.notify("No quest created. /quest create first.", "error");
						return;
					}
					if (quest.planApproved) {
						ctx.ui.notify("Plan already approved. Quest is in progress.", "info");
						return;
					}
					if (quest.tasks.length === 0) {
						ctx.ui.notify("No tasks to approve. Use quest_plan to create a plan first.", "error");
						return;
					}

					quest.planApproved = true;
					quest.status = "active";
					quest.tasksSincePause = 0;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					quest.pauseReason = null;
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);

					const next = nextPendingTask(quest);
					ctx.ui.notify(
						`✅ Plan approved: "${quest.name}" — ${quest.tasks.length} tasks. Auto-pilot engaged.${next ? ` First: ${next.task.content}` : ""}`,
						"info",
					);
					return;
				}
			case "kanban": {
				const quest = getQuest();
				if (!quest) {
					ctx.ui.notify("No active quest.", "info");
					return;
				}
				ctx.ui.notify(formatQuestStatus(quest), "info");
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
				case "git": {
				const quest = getQuest();
				if (!quest) {
					ctx.ui.notify("No active quest.", "info");
					return;
				}
				const git = quest.gitIntegration;
				if (!git) {
					ctx.ui.notify("Git integration not configured for this quest.", "info");
					return;
				}
				const config = [
					`## Git Integration: ${quest.name}`,
					``,
					`- Auto-commit: ${git.autoCommit ? "✅ on" : "❌ off"}`,
					`- Auto-branch: ${git.autoBranch ? "✅ on" : "❌ off"}${git.autoBranch ? ` (prefix: \`${git.branchPrefix}\`)` : ""}`,
					`- Auto-PR: ${git.autoPR ? "✅ on" : "❌ off"}`,
					``,
					`Commits recorded: ${quest.commits.length}`,
				].join("\n");

				let commitList = "";
				if (quest.commits.length > 0) {
					commitList = "\n\n" + quest.commits.map(c => {
						const task = quest.tasks[c.taskIndex];
						return `- \`${c.hash.slice(0, 8)}\` #${c.taskIndex + 1}: ${c.message}`;
					}).join("\n");
				}
				ctx.ui.notify(config + commitList, "info");
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
						"Usage: /quest [create <name>: <goal>|start|pause|resume|approve|kanban|status|history|git|team [list|install <url>|create]]",
						"error",
					);
			}
		},
	});
}
