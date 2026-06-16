import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { MEMORY_PROJECTS_DIR, SESSION_META_PATH, ERROR_LOG_PATH } from "./constants";

export function cwdHash(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function readJSON<T>(path: string, fallback: T): T {
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
	} catch (e) { console.error("[pi-quest] readJSON:", e); /* corrupt → fallback */ }
	return fallback;
}

export function writeJSON(path: string, data: unknown): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	} catch (e) { console.error("[pi-quest] writeJSON:", e); /* best-effort */ }
}

export function projectMemoryPath(cwd: string): string {
	return join(MEMORY_PROJECTS_DIR, `${cwdHash(cwd)}.json`);  // join imported below
}

export function loadProjectMemory(cwd: string): Record<string, any> | null {
	return readJSON<Record<string, any> | null>(projectMemoryPath(cwd), null);
}

export function writeSessionMeta(key: "memory" | "todo" | "quest", cwd: string, data: Record<string, unknown>): void {
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
	} catch (e) { console.error("[pi-quest] writeSessionMeta:", e); /* best-effort cross-extension metadata */ }
}

// ── Telemetry ────────────────────────────────────────────────────────────────

export function logError(context: string, error: unknown): void {
	try {
		const line = `[${new Date().toISOString()}] ${context}: ${(error as Error)?.message || String(error)}\n`;
		appendFileSync(ERROR_LOG_PATH, line, "utf8");
	} catch { /* best-effort telemetry */ }
}

// ── Quest paths (per-project scoping) ────────────────────────────────────────

export function questActivePath(cwd: string): string {
	return join(homedir(), ".pi", "agent", "quests", cwdHash(cwd), "active.json");
}

export function questArchiveDir(cwd: string): string {
	return join(homedir(), ".pi", "agent", "quests", cwdHash(cwd), "archive");
}

export function questArchiveIndexPath(cwd: string): string {
	return join(questArchiveDir(cwd), "archive-index.json");
}
