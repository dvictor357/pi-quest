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
import { matchesKey, Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
	researchFindings?: { key: string; value: string; category?: string; timestamp: number }[];
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
const AGENT_DIR = join(homedir(), ".pi", "agent");
const ACTIVE_PATH = join(AGENT_DIR, "quests", "active.json");
const ARCHIVE_DIR = join(AGENT_DIR, "quests", "archive");
const MEMORY_PROJECTS_DIR = join(AGENT_DIR, "memory", "projects");
const SESSION_META_PATH = join(AGENT_DIR, "session-meta.json");

const ICON: Record<TaskStatus, string> = {
	pending: "☐",
	running: "▶",
	verifying: "🔍",
	done: "☑",
	failed: "✗",
	skipped: "⏭",
};

const TEAMS_DIR = join(AGENT_DIR, "quests", "teams");

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

function cwdHash(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function readJSON<T>(path: string, fallback: T): T {
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
	} catch { /* corrupt → fallback */ }
	return fallback;
}

function writeJSON(path: string, data: unknown): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	} catch { /* best-effort */ }
}

function writeSessionMeta(key: "memory" | "todo" | "quest", cwd: string, data: Record<string, unknown>): void {
	try {
		const existing = readJSON<{ cwd?: string; cwdHash?: string; updatedAt?: number; extensions?: Record<string, unknown> }>(SESSION_META_PATH, { extensions: {} });
		const next = {
			...existing,
			cwd,
			cwdHash: cwdHash(cwd),
			updatedAt: Date.now(),
			extensions: {
				...(existing.extensions ?? {}),
				[key]: { ...data, updatedAt: Date.now() },
			},
		};
		writeJSON(SESSION_META_PATH, next);
	} catch { /* best-effort cross-extension metadata */ }
}

function projectMemoryPath(cwd: string): string {
	return join(MEMORY_PROJECTS_DIR, `${cwdHash(cwd)}.json`);
}

function loadProjectMemory(cwd: string): Record<string, any> | null {
	return readJSON<Record<string, any> | null>(projectMemoryPath(cwd), null);
}

function syncConventionsToMemory(quest: Quest, cwd: string): void {
	try {
		if (!quest.conventions.length) return;
		const existing = loadProjectMemory(cwd) ?? {
			name: basename(cwd),
			conventions: [],
			lastScanned: 0,
		};
		const conventions = Array.isArray(existing.conventions) ? existing.conventions : [];
		const merged = [...new Set([...conventions, ...quest.conventions])];
		writeJSON(projectMemoryPath(cwd), { ...existing, conventions: merged, lastModified: Date.now() });
	} catch { /* optional — pi-memory may not be installed */ }
}

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
	quest.updatedAt = Date.now();
	writeJSON(ACTIVE_PATH, quest);
}

function archiveQuest(quest: Quest): string | null {
	try {
		const slug = quest.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
		const ts = quest.completedAt ?? Date.now();
		const path = join(ARCHIVE_DIR, `${ts}-${slug}.json`);
		writeJSON(path, quest);
		updateArchiveIndex({
			path,
			name: quest.name,
			goal: quest.goal,
			completedAt: quest.completedAt ?? Date.now(),
			taskCount: quest.tasks.length,
			doneCount: quest.tasks.filter(t => t.status === "done").length,
		});
		return path;
	} catch { return null; }
}

const ARCHIVE_INDEX_PATH = join(ARCHIVE_DIR, "archive-index.json");

function updateArchiveIndex(entry: { path: string; name: string; goal: string; completedAt: number; taskCount: number; doneCount: number }): void {
	try {
		const index = readJSON<{ version: 1; entries: any[] }>(ARCHIVE_INDEX_PATH, { version: 1, entries: [] });
		index.entries = index.entries.filter((e: any) => e.path !== entry.path);
		index.entries.push(entry);
		index.entries.sort((a: any, b: any) => (b.completedAt || 0) - (a.completedAt || 0));
		writeJSON(ARCHIVE_INDEX_PATH, index);
	} catch { /* best-effort */ }
}

function rebuildArchiveIndex(): void {
	try {
		if (!existsSync(ARCHIVE_DIR)) return;
		const entries: any[] = [];
		const files = readdirSync(ARCHIVE_DIR)
			.filter(f => f.endsWith(".json") && f !== "archive-index.json");
		for (const f of files) {
			try {
				const raw = JSON.parse(readFileSync(join(ARCHIVE_DIR, f), "utf8"));
				entries.push({
					path: join(ARCHIVE_DIR, f),
					name: raw.name || f,
					goal: raw.goal || "",
					completedAt: raw.completedAt || null,
					taskCount: Array.isArray(raw.tasks) ? raw.tasks.length : 0,
					doneCount: Array.isArray(raw.tasks) ? raw.tasks.filter((t: any) => t.status === "done").length : 0,
				});
			} catch { /* skip corrupt */ }
		}
		entries.sort((a: any, b: any) => (b.completedAt || 0) - (a.completedAt || 0));
		writeJSON(ARCHIVE_INDEX_PATH, { version: 1, entries });
	} catch { /* best-effort */ }
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
		// Try index first
		const index = readJSON<{ version: 1; entries: any[] } | null>(ARCHIVE_INDEX_PATH, null);
		if (index && Array.isArray(index.entries)) {
			return index.entries.slice(0, limit).map((e: any) => ({
				name: e.name || "?",
				goal: e.goal || "",
				tasks: e.taskCount || 0,
				done: e.doneCount || 0,
				completedAt: e.completedAt || null,
			}));
		}
		// Fallback: rebuild index from archive files
		rebuildArchiveIndex();
		const rebuilt = readJSON<{ version: 1; entries: any[] }>(ARCHIVE_INDEX_PATH, { version: 1, entries: [] });
		return rebuilt.entries.slice(0, limit).map((e: any) => ({
			name: e.name || "?",
			goal: e.goal || "",
			tasks: e.taskCount || 0,
			done: e.doneCount || 0,
			completedAt: e.completedAt || null,
		}));
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

// ═══════════════════════════════════════════════════════════════
// Kanban Board Component
// ═══════════════════════════════════════════════════════════════

class QuestKanban {
	private quest: Quest;
	private theme: any;
	private selectedCol = 0;
	private selectedRow = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	public onClose?: () => void;

	constructor(quest: Quest, theme: any) {
		this.quest = quest;
		this.theme = theme;
	}

	private columns(): { title: string; tasks: QuestTask[]; color: string }[] {
		const tasks = this.quest.tasks;
		return [
			{ title: "TODO", tasks: tasks.filter(t => t.status === "pending"), color: "muted" },
			{ title: "DOING", tasks: tasks.filter(t => t.status === "running" || t.status === "verifying"), color: "accent" },
			{ title: "DONE", tasks: tasks.filter(t => t.status === "done"), color: "success" },
			{ title: "FAILED", tasks: tasks.filter(t => t.status === "failed" || t.status === "skipped"), color: "error" },
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onClose?.();
			return;
		}
		const cols = this.columns();
		if (matchesKey(data, Key.left)) {
			if (this.selectedCol > 0) { this.selectedCol--; this.selectedRow = 0; this.invalidate(); }
		} else if (matchesKey(data, Key.right)) {
			if (this.selectedCol < cols.length - 1) { this.selectedCol++; this.selectedRow = 0; this.invalidate(); }
		} else if (matchesKey(data, Key.up)) {
			if (this.selectedRow > 0) { this.selectedRow--; this.invalidate(); }
		} else if (matchesKey(data, Key.down)) {
			if (this.selectedRow < cols[this.selectedCol].tasks.length - 1) { this.selectedRow++; this.invalidate(); }
		}
	}

	private formatTaskCell(task: QuestTask, colWidth: number): string {
		const idx = this.quest.tasks.indexOf(task);
		const maxContent = colWidth - 5;
		const content = task.content.length > maxContent
			? task.content.slice(0, maxContent - 1) + "…"
			: task.content;
		return ` ${ICON[task.status]}#${idx + 1} ${content}`;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const theme = this.theme;
		const cols = this.columns();
		const numCols = 4;
		const gap = 2;
		const colWidth = Math.floor((width - (numCols - 1) * gap) / numCols);
		const maxRows = Math.max(...cols.map(c => c.tasks.length), 1);
		const totalTasks = cols.reduce((sum, c) => sum + c.tasks.length, 0);

		const lines: string[] = [];

		// Title bar
		const statusTag = this.quest.status.toUpperCase();
		const title = `Quest: ${this.quest.name} [${statusTag}] — ${totalTasks} tasks`;
		lines.push(theme.fg("accent", theme.bold(title)));
		lines.push("");

		// Empty quest
		if (totalTasks === 0) {
			lines.push(theme.fg("muted", "  No tasks yet. Create a plan with quest_plan."));
			lines.push("");
			lines.push(theme.fg("dim", "esc close"));
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		// Column headers
		const headerLine = cols.map((c, ci) => {
			const hdr = ` ${c.title} (${c.tasks.length}) `;
			const padded = hdr.padEnd(colWidth).slice(0, colWidth);
			const colored = theme.fg(c.color, padded);
			return ci === this.selectedCol
				? theme.bg("selectedBg", colored)
				: colored;
		}).join(" ".repeat(gap));
		lines.push(headerLine);

		// Header separator
		const sep = cols.map(() => "─".repeat(colWidth)).join(" ".repeat(gap));
		lines.push(theme.fg("dim", sep));

		// Task rows
		for (let r = 0; r < maxRows; r++) {
			const rowParts = cols.map((c, ci) => {
				const task = c.tasks[r];
				const isSelected = ci === this.selectedCol && r === this.selectedRow;
				let cell = task ? this.formatTaskCell(task, colWidth) : "";
				cell = cell.padEnd(colWidth).slice(0, colWidth);
				if (isSelected && task) {
					return theme.bg("selectedBg", theme.fg("text", cell));
				} else if (task) {
					return theme.fg(c.color, cell);
				} else {
					return theme.fg("dim", cell || " ".repeat(colWidth));
				}
			});
			lines.push(rowParts.join(" ".repeat(gap)));
		}

		// Help bar
		lines.push("");
		lines.push(theme.fg("dim", "←→ columns  ↑↓ tasks  esc close"));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

type SyncedTodoStatus = "pending" | "in_progress" | "completed" | "delegated";

interface SyncedTodoItem {
	content: string;
	status: SyncedTodoStatus;
	agent?: string;
	context?: string;
	result?: string;
	source?: string;
	sourceId?: string;
	sourceIndex?: number;
	createdAt: number;
	completedAt: number | null;
}

interface SyncedTodoList {
	cwd: string;
	title?: string;
	items: SyncedTodoItem[];
	version: 1;
}

function todoPath(cwd: string): string {
	return join(AGENT_DIR, "tmp", "todos", `${cwdHash(cwd)}.json`);
}

function questTaskToTodo(quest: Quest, task: QuestTask, index: number, previous?: SyncedTodoItem): SyncedTodoItem {
	const now = Date.now();
	const failed = task.status === "failed";
	const completed = task.status === "done" || task.status === "skipped" || failed;
	const status: SyncedTodoStatus = task.status === "running"
		? "in_progress"
		: completed
			? "completed"
			: "pending";
	const result = failed
		? `[failed] ${task.result ?? task.verifyResult ?? "Task failed"}`
		: task.result ?? undefined;

	return {
		content: `[Quest] #${index + 1} ${task.content}`,
		status,
		agent: task.agent,
		context: task.context,
		result,
		source: "quest",
		sourceId: quest.name,
		sourceIndex: index,
		createdAt: previous?.createdAt ?? task.startedAt ?? now,
		completedAt: completed ? (previous?.completedAt ?? task.completedAt ?? now) : null,
	};
}

function syncQuestToTodo(quest: Quest, cwd: string): void {
	try {
		const path = todoPath(cwd);
		const existing = readJSON<SyncedTodoList>(path, { cwd, items: [], version: 1 });
		const existingItems = Array.isArray(existing.items) ? existing.items : [];
		const previousQuestItems = new Map<number, SyncedTodoItem>();
		for (const item of existingItems) {
			if (item?.source === "quest" && typeof item.sourceIndex === "number") {
				previousQuestItems.set(item.sourceIndex, item);
			}
		}
		const nonQuestItems = existingItems.filter(item => item?.source !== "quest" && !item?.content?.startsWith("[Quest]"));
		const questItems = quest.tasks.map((task, index) => questTaskToTodo(quest, task, index, previousQuestItems.get(index)));
		const next: SyncedTodoList = {
			cwd: existing.cwd ?? cwd,
			title: existing.title ?? `Quest: ${quest.name}`,
			items: [...nonQuestItems, ...questItems],
			version: 1,
		};
		writeJSON(path, next);
	} catch { /* optional — pi-todo may not be installed */ }
}

function compactAwarenessBlock(cwd: string): string {
	try {
		const memory = loadProjectMemory(cwd);
		const todo = readJSON<SyncedTodoList | null>(todoPath(cwd), null);
		const meta = readJSON<any>(SESSION_META_PATH, { extensions: {} });
		const memoryMeta = meta.extensions?.memory ?? {};
		const todoMeta = meta.extensions?.todo ?? {};
		const lines: string[] = [];

		const now = new Date();
		lines.push(`Date: ${now.toLocaleString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" })}`);

		const language = memory?.language ?? memoryMeta.language;
		const framework = memory?.framework ?? memoryMeta.framework;
		const packageManager = memory?.packageManager ?? memoryMeta.packageManager;
		const conventions = Array.isArray(memory?.conventions) ? memory.conventions.slice(0, 5) : [];
		const tech = [language, framework, packageManager].filter(Boolean).join(" • ");
		if (memory || tech || conventions.length) {
			lines.push(`Memory: ${memory?.name ?? memoryMeta.name ?? basename(cwd)}${tech ? ` (${tech})` : ""}`);
			if (conventions.length) lines.push(`Conventions: ${conventions.join("; ")}${memory?.conventions?.length > conventions.length ? "…" : ""}`);
		}

		// Research findings from project memory
		const research = memory?.research as Record<string, { value: string; category?: string; timestamp: number }> | undefined;
		if (research) {
			const entries = Object.entries(research)
				.sort(([, a], [, b]) => b.timestamp - a.timestamp)
				.slice(0, 5);
			if (entries.length) {
				const lines2 = entries.map(([k, v]) => {
					const cat = v.category ? `[${v.category}] ` : "";
					const val = v.value.length > 80 ? v.value.slice(0, 77) + "…" : v.value;
					return `- ${k}: ${cat}${val}`;
				});
				lines.push(`Research:\n${lines2.join("\n")}`);
			}
		}

		const items = Array.isArray(todo?.items) ? todo.items : [];
		const total = typeof todoMeta.total === "number" ? todoMeta.total : items.length;
		if (total > 0) {
			const completed = typeof todoMeta.completed === "number" ? todoMeta.completed : items.filter(i => i.status === "completed").length;
			const inProgress = typeof todoMeta.inProgress === "number" ? todoMeta.inProgress : items.filter(i => i.status === "in_progress").length;
			const delegated = typeof todoMeta.delegated === "number" ? todoMeta.delegated : items.filter(i => i.status === "delegated").length;
			lines.push(`Todo: ${completed}/${total} done${inProgress ? ` · ${inProgress} active` : ""}${delegated ? ` · ${delegated} delegated` : ""}`);
		}

		const block = lines.length ? `\n\n## Project Awareness\n${lines.join("\n")}` : "";
		return block.length > 1200 ? `${block.slice(0, 1197)}...` : block;
	} catch { return ""; }
}

// ── Status badge ─────────────────────────────────────────────────────────────

function writeQuestSessionMeta(cwd: string, quest: Quest | null): void {
	if (!quest || quest.status === "idle" || quest.status === "done") {
		writeSessionMeta("quest", cwd, { status: "idle", done: 0, total: 0 });
		return;
	}
	writeSessionMeta("quest", cwd, {
		name: quest.name,
		status: quest.status,
		done: quest.tasks.filter(t => t.status === "done").length,
		total: quest.tasks.length,
	});
}

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

function buildSteeringMessage(quest: Quest, task: QuestTask, index: number, cwd: string): string {
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
		compactAwarenessBlock(cwd),
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
			writeQuestSessionMeta(ctx.cwd, quest);
			syncQuestToTodo(quest, ctx.cwd);

			const modeNote = params.planningMode === "approve"
				? `\n⚠ **Approval mode** — after the plan is created, it must be approved with **quest_approve** before execution begins.`
				: "";
			const awareness = compactAwarenessBlock(ctx.cwd);
			return {
				content: [{
					type: "text",
					text: [
						`Quest created: **${params.name}**`,
						``,
						`Next: Plan the quest. Use subagent(agent="scout") to explore the codebase,`,
						`then subagent(agent="planner") to create a task breakdown. Save the plan`,
						`with **quest_plan** — pass the tasks array and set autoStart: true.`,
						``,
						`Research: Note the current date. Use web_search to find the latest relevant information about this goal (best practices, APIs, security considerations, etc.). Save key findings with quest_memory_save.`,
						awareness,
						modeNote,
					].filter(Boolean).join("\n"),
				}],
				details: { quest },
			};
		},
	});

	pi.registerTool({
		name: "quest_decide",
		label: "Quest Decide",
		description: [
			"Ask the user a question during quest planning or execution.",
			"Call this whenever the quest plan has a branch, ambiguity, or decision point",
			"that needs human judgment — e.g. picking between approaches, confirming tradeoffs,",
			"or resolving unknowns the agent can't determine alone.",
			"Presents the options to the user via an interactive select dialog and returns their choice.",
		].join(" "),
		parameters: Type.Object({
			question: Type.String({ description: "The decision to present to the user. Be clear about the tradeoffs." }),
			options: Type.Array(Type.String(), { description: "List of options the user can choose from (max 10)." }),
			context: Type.Optional(Type.String({ description: "Background context to help the user make an informed decision." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: `Decision needed: "${params.question}" — options: ${params.options.join(", ")}. Running headlessly — defaulting to first option: "${params.options[0]}".` }],
					details: { choice: params.options[0], index: 0, headless: true },
				};
			}

			if (params.options.length === 0) {
				return { content: [{ type: "text", text: "No options provided." }], details: {} };
			}

			if (params.options.length > 10) {
				return { content: [{ type: "text", text: "Too many options (max 10). Narrow them down." }], details: {} };
			}

			const title = `Quest Decide: ${params.question.slice(0, 60)}${params.question.length > 60 ? "…" : ""}`;
			const message = [
				params.context ? `${params.context}\n` : "",
				`**Question:** ${params.question}`,
				``,
				`Pick an option:`,
			].filter(Boolean).join("\n");

			const choice = await ctx.ui.select(message, params.options);
			const idx = params.options.indexOf(choice);

			return {
				content: [{
					type: "text",
					text: [
						`**User decided:** ${choice}`,
						``,
						`Question: ${params.question}`,
						`Chosen: **${choice}** (option ${idx + 1}/${params.options.length})`,
					].join("\n"),
				}],
				details: { question: params.question, choice, index: idx, options: params.options },
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
			"When planningMode='approve' and running interactively, shows the plan to the user for approval.",
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

			// ── Interactive plan review (when UI is available) ──────────────────
			// Format plan summary once for both confirm + fallback
			const tasksPreview = quest.tasks.slice(0, 6).map((t, i) =>
				`${i + 1}. **${t.content}** [${t.agent}]${t.dependencies.length ? ` ← #${t.dependencies.map(d => d + 1).join(", #")}` : ""}\n   ${t.context}`
			).join("\n\n");

			const fullPlan = quest.tasks.map((t, i) => {
				const deps = t.dependencies.length ? ` (requires: ${t.dependencies.map(d => quest.tasks[d].content).join(", ")})` : "";
				return `${i + 1}. **${t.content}** [${t.agent}]${deps}\n   ${t.context}`;
			}).join("\n\n");

			if (needsApproval && ctx.hasUI) {
				// Show plan and ask user to approve
				const confirmMsg = [
					`**Quest:** ${quest.name}`,
					`**Goal:** ${quest.goal}`,
					``,
					`**${quest.tasks.length} tasks planned:**`,
					``,
					fullPlan,
					``,
					`---`,
					`Approve this plan to start executing tasks automatically?`,
				].join("\n");

				const approved = await ctx.ui.confirm("Review Quest Plan", confirmMsg);

				if (approved) {
					// User approved — start immediately
					quest.planApproved = true;
					quest.status = "active";
					quest.tasksSincePause = 0;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					quest.pauseReason = null;

					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

					ctx.ui.notify(`✅ Plan approved. Quest "${quest.name}" is now ACTIVE — ${quest.tasks.length} tasks.`, "info");

					const next = nextPendingTask(quest);
					return {
						content: [{
							type: "text",
							text: [
								`✅ Plan approved by user: **${quest.name}**`,
								``,
								`${quest.tasks.length} tasks queued. Quest is now **ACTIVE**.`,
								next ? `First task: ${next.task.content} [${next.task.agent}]` : "All tasks ready.",
								``,
								"Auto-pilot will fire the first task on the next turn.",
							].join("\n"),
						}],
						details: { approved: true, tasks: quest.tasks.length, nextTask: next?.task.content ?? null },
					};
				}

				// User declined — ask what to do
				const action = await ctx.ui.select(
					"Plan not approved. What would you like to do?",
					["Edit tasks before approving", "Re-plan from scratch", "Cancel (keep plan for later)"],
				);

				if (action === "Edit tasks before approving") {
					quest.status = "planning";
					quest.pauseReason = "Plan review: user wants edits. Use quest_approve(edits=[...]) to modify tasks and approve.";
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

					return {
						content: [{
							type: "text",
							text: [
								`📝 Plan saved but needs edits before approval.`,
								``,
								`Use **quest_approve(edits=[...])** to modify specific tasks, then approve.`,
								`Or re-plan with quest_plan(tasks=[...]).`,
								``,
								`Tasks that can be edited:`,
								quest.tasks.map((t, i) => `  #${i + 1}: ${t.content}`).join("\n"),
							].join("\n"),
						}],
						details: { status: "planning", userAction: "edit", tasks: quest.tasks.length },
					};
				}

				if (action === "Re-plan from scratch") {
					quest.tasks = [];
					quest.status = "planning";
					quest.pauseReason = "User requested re-plan.";
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

					return {
						content: [{
							type: "text",
							text: [
								`🔄 Plan cleared. Call **quest_plan** with a new task breakdown.`,
								``,
								`Original goal: ${quest.goal}`,
							].join("\n"),
						}],
						details: { status: "planning", userAction: "replan" },
					};
				}

				// Cancel — keep plan for later
				quest.status = "planning";
				quest.pauseReason = "Plan saved, awaiting user approval. Use /quest approve or quest_approve to start.";
				saveQuest(quest);
				questCache = quest;
				renderStatus(ctx, quest);
				writeQuestSessionMeta(ctx.cwd, quest);
				syncQuestToTodo(quest, ctx.cwd);

				return {
					content: [{
						type: "text",
						text: [
							`💾 Plan saved (${quest.tasks.length} tasks) — kept for later.`,
							``,
							`Approve when ready: **quest_approve()** or **/quest approve**`,
						].join("\n"),
					}],
					details: { status: "planning", userAction: "defer" },
				};
			}

			// ── No UI or auto-start: existing logic ────────────────────────────
			if (params.autoStart !== false) {
				if (needsApproval) {
					// Stay in planning if headless (already handled interactive)
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
			writeQuestSessionMeta(ctx.cwd, quest);
			syncQuestToTodo(quest, ctx.cwd);

			const approvalMsg = needsApproval
				? [
					``,
					`---`,
					``,
					`## Plan Review`,
					``,
					fullPlan,
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
						`  ${quest.tasks.slice(0, 5).map((t, i) => `${i + 1}. ${t.content} [${t.agent}]${t.dependencies.length ? ` ← #${t.dependencies.map(d => d + 1).join(", #")}` : ""}`).join("\n  ")}`,
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
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

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
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

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
				writeQuestSessionMeta(ctx.cwd, quest);
				syncQuestToTodo(quest, ctx.cwd);

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
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

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
			writeQuestSessionMeta(ctx.cwd, quest);
			syncQuestToTodo(quest, ctx.cwd);

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
			"When running interactively, shows a confirmation dialog with the full plan before approving.",
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
			let editsApplied = 0;
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
					editsApplied++;
				}
			}

			// Interactive confirmation (when UI available)
			if (ctx.hasUI) {
				const planSummary = quest.tasks.map((t, i) => {
					const deps = t.dependencies.length ? ` (requires: ${t.dependencies.map(d => quest.tasks[d].content).join(", ")})` : "";
					return `${i + 1}. **${t.content}** [${t.agent}]${deps}`;
				}).join("\n");

				const confirmMsg = [
					`**Quest:** ${quest.name}`,
					`**Goal:** ${quest.goal}`,
					``,
					`**${quest.tasks.length} tasks:**`,
					planSummary,
					``,
					`---`,
					editsApplied > 0 ? `${editsApplied} task(s) edited. ` : "",
					`Start executing tasks now?`,
				].join("\n");

				const approved = await ctx.ui.confirm("Approve Quest Plan", confirmMsg);
				if (!approved) {
					// Save edits but stay in planning
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

					return {
						content: [{
							type: "text",
							text: [
								editsApplied > 0 ? `📝 ${editsApplied} task edit(s) saved. Plan not approved — kept in planning.` : `Plan not approved. Kept in planning.`,
								``,
								`Approve when ready with **quest_approve()** or **/quest approve**.`,
							].join("\n"),
						}],
						details: { approved: false, editsApplied },
					};
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
			writeQuestSessionMeta(ctx.cwd, quest);
			syncQuestToTodo(quest, ctx.cwd);

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
			writeQuestSessionMeta(ctx.cwd, quest);
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
			writeQuestSessionMeta(ctx.cwd, quest);
			syncQuestToTodo(quest, ctx.cwd);

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

	pi.registerTool({
		name: "quest_memory_save",
		label: "Quest Memory Save",
		description: [
			"Save a research finding to the current quest. If a finding with the same key exists, it is updated.",
			"Findings are also synced to project memory (best-effort) for cross-quest awareness.",
		].join(" "),
		parameters: Type.Object({
			key: Type.String({ description: "Unique key for this finding (e.g. \"api-auth\", \"best-practice-deployment\")" }),
			value: Type.String({ description: "The research finding content" }),
			category: Type.Optional(Type.String({ description: "Optional category for grouping (e.g. \"security\", \"performance\", \"api\")" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const quest = getQuest();
			if (!quest) {
				return { content: [{ type: "text", text: "No active quest. Use quest_create first." }], details: {} };
			}

			// Initialize researchFindings if needed
			if (!quest.researchFindings) quest.researchFindings = [];

			// Upsert by key
			const existing = quest.researchFindings.find(f => f.key === params.key);
			const timestamp = Date.now();
			if (existing) {
				existing.value = params.value;
				if (params.category !== undefined) existing.category = params.category;
				existing.timestamp = timestamp;
			} else {
				quest.researchFindings.push({
					key: params.key,
					value: params.value,
					category: params.category,
					timestamp,
				});
			}

			saveQuest(quest);
			questCache = quest;
			renderStatus(ctx, quest);
			writeQuestSessionMeta(ctx.cwd, quest);

			// Best-effort sync to project memory
			try {
				const memoryPath = projectMemoryPath(ctx.cwd);
				const memory = readJSON<Record<string, any>>(memoryPath, {});
				if (!memory.research) memory.research = {};
				memory.research[params.key] = {
					value: params.value,
					category: params.category ?? null,
					timestamp,
				};
				writeJSON(memoryPath, memory);
			} catch { /* best-effort */ }

			const action = existing ? "Updated" : "Saved";
			return {
				content: [{
					type: "text",
					text: [
						`${action} research finding **${params.key}**`,
						params.category ? `  Category: ${params.category}` : "",
						``,
						`Total findings: ${quest.researchFindings.length}`,
					].filter(Boolean).join("\n"),
				}],
				details: { key: params.key, totalFindings: quest.researchFindings.length },
			};
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
					const vfyList = verifyingTasks.map(t => {
						const idx = quest.tasks.indexOf(t);
						return `- #${idx + 1} **${t.content}**`;
					}).join("\n");

					if (ctx.hasUI) {
						const action = await ctx.ui.select(
							`${verifyingTasks.length} task(s) need verification. What now?`,
							["Verify them now (agent will handle it)", "Skip verification for all", "Pause quest"],
						);

						if (action === "Verify them now (agent will handle it)") {
							// Send steering message so agent runs verification
							autoPilotLocked = true;
							pi.sendUserMessage(
								[
									`## Verification Pending ⏳`,
									``,
									`${verifyingTasks.length} task(s) awaiting verification:`,
									verifyingTasks.map(t => {
										const idx = quest.tasks.indexOf(t);
										return `- #${idx + 1} **${t.content}** — Use subagent(agent="verifier") then call quest_update(index=${idx}, verifyOutcome="PASS"|"FAIL", verifyEvidence=...)`;
									}).join("\n"),
									``,
									`After resolving verification, /quest resume.`,
								].join("\n"),
								{ deliverAs: "steer", triggerTurn: true },
							);
							autoPilotLocked = false;
							return;
						}

						if (action === "Skip verification for all") {
							for (const t of verifyingTasks) {
								t.status = "done";
								t.verified = true;
								t.verifyResult = "[SKIP] Verification skipped by user.";
								t.completedAt = Date.now();
							}
							saveQuest(quest);
							questCache = quest;
							renderStatus(ctx, quest);
							writeQuestSessionMeta(ctx.cwd, quest);
							syncQuestToTodo(quest, ctx.cwd);
							ctx.ui.notify(`${verifyingTasks.length} task(s) verified (skipped). Continuing...`, "info");
							// agent_end will fire again and auto-complete
							return;
						}

						// Pause — fall through
					}

					quest.status = "paused";
					quest.pauseReason = `Waiting for verification on ${verifyingTasks.length} task(s): ${verifyingTasks.map(t => t.content).join(", ")}. Resolve with quest_update(verifyOutcome=...).`;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

					if (ctx.hasUI) {
						ctx.ui.notify(`Quest paused: ${verifyingTasks.length} task(s) need verification.\n${vfyList}`, "warning");
					} else {
						autoPilotLocked = true;
						pi.sendUserMessage(
							[
								`## Verification Pending ⏳`,
								``,
								`${verifyingTasks.length} task(s) awaiting verification:`,
								verifyingTasks.map(t => {
									const idx = quest.tasks.indexOf(t);
									return `- #${idx + 1} **${t.content}** — call quest_update(index=${idx}, verifyOutcome="PASS"|"FAIL", verifyEvidence=...)`;
								}).join("\n"),
								``,
								`/quest resume after resolving verification.`,
							].join("\n"),
							{ deliverAs: "steer", triggerTurn: true },
						);
						autoPilotLocked = false;
					}
					return;
				}
			}

			// All tasks done or blocked
			const allDone = quest.tasks.every(t => t.status === "done" || t.status === "skipped");
			const anyFailed = quest.tasks.some(t => t.status === "failed");

			if (allDone && !anyFailed) {
				quest.status = "done";
				quest.completedAt = Date.now();
				syncConventionsToMemory(quest, ctx.cwd);
				archiveQuest(quest);
				saveQuest(quest);
				questCache = quest;
				renderStatus(ctx, quest);
				writeQuestSessionMeta(ctx.cwd, quest);
				syncQuestToTodo(quest, ctx.cwd);

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
						quest.conventions.length ? `Saved ${quest.conventions.length} convention(s) to project memory.` : `No quest conventions to save to project memory.`,
						``,
						`Start a new quest with /quest create, or review with quest_history.`,
					].filter(Boolean).join("\n"),
					{ deliverAs: "steer", triggerTurn: true },
				);
				autoPilotLocked = false;
			} else if (anyFailed) {
				const failedTasks = quest.tasks.filter(t => t.status === "failed");
				const failedList = failedTasks.map(t => {
					const i = quest.tasks.indexOf(t);
					return `  #${i + 1}: ${t.content} — ${t.result || "no details"}`;
				}).join("\n");

				if (ctx.hasUI) {
					const action = await ctx.ui.select(
						`${failedTasks.length} task(s) failed. What would you like to do?`,
						["Retry failed tasks", "Skip all failed", "Pause and review"],
					);

					if (action === "Retry failed tasks") {
						for (const t of failedTasks) {
							t.status = "pending";
							t.attempts = 0;
							t.startedAt = null;
							t.completedAt = null;
							t.result = null;
						}
						quest.status = "active";
						quest.tasksSincePause = 0;
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						quest.pauseReason = null;
						saveQuest(quest);
						questCache = quest;
						renderStatus(ctx, quest);
						writeQuestSessionMeta(ctx.cwd, quest);
						syncQuestToTodo(quest, ctx.cwd);
						ctx.ui.notify(`${failedTasks.length} task(s) reset for retry. Auto-pilot resuming.`, "info");
						return;
					}

					if (action === "Skip all failed") {
						for (const t of failedTasks) {
							t.status = "skipped";
							t.result = `Skipped by user.`;
							t.completedAt = Date.now();
						}
						quest.status = "active";
						quest.tasksSincePause = 0;
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						quest.pauseReason = null;
						saveQuest(quest);
						questCache = quest;
						renderStatus(ctx, quest);
						writeQuestSessionMeta(ctx.cwd, quest);
						syncQuestToTodo(quest, ctx.cwd);
						ctx.ui.notify(`${failedTasks.length} task(s) skipped. Auto-pilot resuming.`, "info");
						return;
					}

					// Pause and review — fall through
				}

				quest.status = "paused";
				quest.pauseReason = "Some tasks failed. Review and decide: retry, skip, or redefine.";
				quest.lastFiredTaskIndex = -1;
				quest.sameTaskCount = 0;
				saveQuest(quest);
				questCache = quest;
				renderStatus(ctx, quest);
				writeQuestSessionMeta(ctx.cwd, quest);
				syncQuestToTodo(quest, ctx.cwd);

				if (ctx.hasUI) {
					ctx.ui.notify(`Quest paused: ${failedTasks.length} task(s) failed.\nFailed:\n${failedList}`, "warning");
				} else {
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
				}
			} else {
				// All pending tasks are blocked by dependencies
				quest.status = "paused";
				quest.pauseReason = "All remaining tasks are blocked by unfinished dependencies.";
				saveQuest(quest);
				questCache = quest;
				renderStatus(ctx, quest);
				writeQuestSessionMeta(ctx.cwd, quest);
				syncQuestToTodo(quest, ctx.cwd);
			}
			return;
		}

		// Stall detection: same task fired again without progress
		if (next.index === quest.lastFiredTaskIndex) {
			quest.sameTaskCount++;
			if (quest.sameTaskCount > 2) {
				if (ctx.hasUI) {
					const action = await ctx.ui.select(
						`Task "${next.task.content}" stalled after ${quest.sameTaskCount} attempts. What now?`,
						["Skip this task", "Mark as failed", "Pause quest"],
					);

					if (action === "Skip this task") {
						next.task.status = "skipped";
						next.task.result = `Skipped by user after stalling (${quest.sameTaskCount} attempts).`;
						next.task.completedAt = Date.now();
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						saveQuest(quest);
						questCache = quest;
						renderStatus(ctx, quest);
						writeQuestSessionMeta(ctx.cwd, quest);
						syncQuestToTodo(quest, ctx.cwd);
						ctx.ui.notify(`Task #${next.index + 1} skipped.`, "info");
						return;
					}

					if (action === "Mark as failed") {
						next.task.status = "failed";
						next.task.result = `Failed by user after stalling (${quest.sameTaskCount} attempts).`;
						next.task.completedAt = Date.now();
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						saveQuest(quest);
						questCache = quest;
						renderStatus(ctx, quest);
						writeQuestSessionMeta(ctx.cwd, quest);
						syncQuestToTodo(quest, ctx.cwd);
						ctx.ui.notify(`Task #${next.index + 1} marked failed.`, "warning");
						return;
					}

					// Pause — fall through
				}

				quest.status = "paused";
				quest.pauseReason = `Task #${next.index + 1} stalled (${quest.sameTaskCount} attempts without progress).`;
				quest.lastFiredTaskIndex = -1;
				quest.sameTaskCount = 0;
				saveQuest(quest);
				questCache = quest;
				renderStatus(ctx, quest);
				writeQuestSessionMeta(ctx.cwd, quest);
				syncQuestToTodo(quest, ctx.cwd);

				if (ctx.hasUI) {
					ctx.ui.notify(`Quest paused: stalled task. /quest resume to continue.`, "warning");
				} else {
					autoPilotLocked = true;
					pi.sendUserMessage(
						`## Quest Paused: Stalled ⚠\n\nTask #${next.index + 1} "${next.task.content}" has been attempted ${quest.sameTaskCount} times without completion.\nUse quest_update to mark it failed or skipped, then /quest resume.`,
						{ deliverAs: "steer", triggerTurn: true },
					);
					autoPilotLocked = false;
				}
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
			writeQuestSessionMeta(ctx.cwd, quest);
			syncQuestToTodo(quest, ctx.cwd);
			// Don't return — retry with the next pending task
			// This will trigger agent_end again, which will find the next task
			return;
		}

		// Burst limit: ask user before continuing
		if (quest.tasksSincePause >= MAX_BURST) {
			const done = quest.tasks.filter(t => t.status === "done").length;
			const total = quest.tasks.length;

			if (ctx.hasUI) {
				const cont = await ctx.ui.confirm(
					"Quest Checkpoint",
					[`**${quest.tasksSincePause} tasks** completed in this burst.`,
					 ``,
					 `Progress: **${done}/${total}** done`,
					 `Next: **${next.task.content}** [${next.task.agent}]`,
					 ``,
					 `Continue to next task?`,
					].join("\n"),
				);

				if (cont) {
					// Reset burst counter and continue
					quest.tasksSincePause = 0;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);
					// Fall through to fire the next task
				} else {
					quest.status = "paused";
					quest.pauseReason = `User paused at checkpoint after ${quest.tasksSincePause} tasks. /quest resume to continue.`;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					saveQuest(quest);
					questCache = quest;
					renderStatus(ctx, quest);
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);
					ctx.ui.notify(`Quest paused. /quest resume to continue.`, "info");
					return;
				}
			} else {
				// Headless: auto-pause
				quest.status = "paused";
				quest.pauseReason = `Auto-paused after ${MAX_BURST} tasks. /quest resume to continue.`;
				quest.lastFiredTaskIndex = -1;
				quest.sameTaskCount = 0;
				saveQuest(quest);
				questCache = quest;
				renderStatus(ctx, quest);
				writeQuestSessionMeta(ctx.cwd, quest);
				syncQuestToTodo(quest, ctx.cwd);

				autoPilotLocked = true;
				pi.sendUserMessage(
					`## Quest Paused: Checkpoint ⏸\n\n${quest.tasksSincePause}/${MAX_BURST} tasks completed. Progress:\n${formatQuestStatus(quest)}\n\n/quest resume to continue.`,
					{ deliverAs: "steer", triggerTurn: true },
				);
				autoPilotLocked = false;
				return;
			}
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
		writeQuestSessionMeta(ctx.cwd, quest);
		syncQuestToTodo(quest, ctx.cwd);

		autoPilotLocked = true;
		pi.sendUserMessage(
			buildSteeringMessage(quest, next.task, next.index, ctx.cwd),
			{ deliverAs: "steer", triggerTurn: true },
		);
		autoPilotLocked = false;
	});

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		questCache = loadQuest();
		renderStatus(ctx, questCache);
		writeQuestSessionMeta(ctx.cwd, questCache);
		if (questCache?.status === "active") syncQuestToTodo(questCache, ctx.cwd);

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
		writeQuestSessionMeta(ctx.cwd, questCache);
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
					if (ctx.hasUI) {
						await ctx.ui.custom((tui, theme, _kb, done) => {
							const kanban = new QuestKanban(quest, theme);
							kanban.onClose = () => done(undefined);
							return {
								render: (w: number) => kanban.render(w),
								invalidate: () => kanban.invalidate(),
								handleInput: (data: string) => { kanban.handleInput(data); tui.requestRender(); },
							};
						}, { overlay: true });
					} else {
						ctx.ui.notify(formatQuestStatus(quest), "info");
					}
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
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

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
							compactAwarenessBlock(ctx.cwd),
							``,
							`Plan this quest. Use subagent(agent="scout") to explore the codebase,`,
							`then subagent(agent="planner") to create a task breakdown.`,
							`Save the plan with **quest_plan(tasks=[...], autoStart=true)**.`,
						``,
						`Research: Note the current date. Use web_search to find the latest relevant information about this goal (best practices, APIs, security considerations, etc.). Save key findings with quest_memory_save.`,
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
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

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
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);
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
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

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
					writeQuestSessionMeta(ctx.cwd, quest);
					syncQuestToTodo(quest, ctx.cwd);

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
				if (ctx.hasUI) {
					await ctx.ui.custom((tui, theme, _kb, done) => {
						const kanban = new QuestKanban(quest, theme);
						kanban.onClose = () => done(undefined);
						return {
							render: (w: number) => kanban.render(w),
							invalidate: () => kanban.invalidate(),
							handleInput: (data: string) => { kanban.handleInput(data); tui.requestRender(); },
						};
					}, { overlay: true });
				} else {
					ctx.ui.notify(formatQuestStatus(quest), "info");
				}
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
