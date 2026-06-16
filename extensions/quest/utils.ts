import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MEMORY_PROJECTS_DIR, SESSION_META_PATH } from "./constants";

export function cwdHash(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function readJSON<T>(path: string, fallback: T): T {
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
	} catch { /* corrupt → fallback */ }
	return fallback;
}

export function writeJSON(path: string, data: unknown): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	} catch { /* best-effort */ }
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
	} catch { /* best-effort cross-extension metadata */ }
}

// join is needed for projectMemoryPath but imported from "node:path" already above via dirname
// Actually we need to import join
