import { matchesKey, Key } from "@earendil-works/pi-tui";
import type { Quest, QuestTask } from "./types";
import { ICON } from "./constants";

export class QuestKanban {
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

		const statusTag = this.quest.status.toUpperCase();
		const title = `Quest: ${this.quest.name} [${statusTag}] — ${totalTasks} tasks`;
		lines.push(theme.fg("accent", theme.bold(title)));
		lines.push("");

		if (totalTasks === 0) {
			lines.push(theme.fg("muted", "  No tasks yet. Create a plan with quest_plan."));
			lines.push("");
			lines.push(theme.fg("dim", "esc close"));
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		const headerLine = cols.map((c, ci) => {
			const hdr = ` ${c.title} (${c.tasks.length}) `;
			const padded = hdr.padEnd(colWidth).slice(0, colWidth);
			const colored = theme.fg(c.color, padded);
			return ci === this.selectedCol
				? theme.bg("selectedBg", colored)
				: colored;
		}).join(" ".repeat(gap));
		lines.push(headerLine);

		const sep = cols.map(() => "─".repeat(colWidth)).join(" ".repeat(gap));
		lines.push(theme.fg("dim", sep));

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
