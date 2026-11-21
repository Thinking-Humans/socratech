/**
 * Notebook video (owner, 2026-11-21): the "notebook visualizer" — one voiced
 * explainer video of the WHOLE notebook, made by a headless Claude Code run
 * with the HyperFrames skills and the learner's taste skill. Pure parts:
 * the agent's notebook.md, the job state contract, the headless rules.
 */

import type { Journal } from "./contracts/journal.ts";
import { mediaRefs } from "./journal-media.ts";
import { cellConfidence, textHash } from "./notebook-learning.ts";

export type NotebookVideoStatus = "idle" | "running" | "done" | "failed" | "cancelled" | "interrupted";

/** data/journal-video/<id>/state.json — what the panel shows. */
export interface NotebookVideoState {
	status: NotebookVideoStatus;
	/** The current finished video in the notebook's media store (survives a failed re-run). */
	video?: string;
	/** textHash of the notebook.md the current video was made from. */
	sourceHash?: string;
	/** "generate" from scratch, or "update" with the learner's request. */
	kind?: "generate" | "update";
	request?: string;
	startedAt?: string;
	finishedAt?: string;
	/** The agent's closing summary of the video. */
	summary?: string;
	error?: string;
	/** Recent progress lines, oldest first. */
	log: string[];
	/** The running agent's process-group id (cancel / orphan cleanup). */
	pid?: number;
	/** The current video's YouTube upload, if the learner uploaded it. */
	youtube?: { id: string; url: string; privacy: string; at: string };
}

export const IDLE_VIDEO_STATE: NotebookVideoState = { status: "idle", log: [] };

const ROLE_NAME: Record<string, string> = { reflection: "markdown", code: "code", agent: "agent question", aside: "aside" };

/** Every cell, in order — private ones too (marked), since the video is of the whole notebook. */
export function notebookVideoSource(journal: Journal): string {
	const parts = [`# ${journal.title}`];
	journal.cells.forEach((cell, i) => {
		const head = `## Cell ${i + 1} (${cell.role === "code" ? `code, ${cell.lang || "text"}` : (ROLE_NAME[cell.role] ?? cell.role)})${cell.publish ? "" : " <!-- private -->"}`;
		const body = cell.role === "code" ? `\`\`\`${cell.lang || ""}\n${cell.source.trimEnd()}\n\`\`\`` : cell.source.trim();
		const out = cell.output?.trim()
			? cell.role === "agent"
				? `**Agent answer:**\n\n${cell.output.trim()}`
				: `Output:\n\`\`\`\n${cell.output.trimEnd()}\n\`\`\``
			: "";
		const rating = cell.understanding ? `_Learner's confidence: ${cellConfidence(cell.understanding)}%_` : "";
		parts.push([head, body, out, rating].filter(Boolean).join("\n\n"));
	});
	return `${parts.join("\n\n")}\n`;
}

/** Media files the video source refers to (copied into the project's media/). */
export function notebookVideoMedia(journal: Journal): string[] {
	return [...new Set(journal.cells.flatMap((c) => mediaRefs(`${c.source}\n${c.output ?? ""}`)))];
}

export const notebookVideoHash = (journal: Journal) => textHash(notebookVideoSource(journal));

/** Appended to the agent's system prompt: the unattended contract. */
export const NOTEBOOK_VIDEO_HEADLESS_RULES = `# Running unattended (Socratech notebook video)

You run headless inside the Socratech app: nobody is watching and nobody can answer.
- Never run \`preview\`, never give a URL and wait, never ask questions. Decide and continue.
- Always call the CLI as \`npx --yes hyperframes …\`.
- Voice is local Kokoro (\`npx --yes hyperframes tts\`). Never run \`auth login\`, never use HeyGen
  generation, cloud render or anything paid (the credit limit is 0).
- Follow the \`notebook-video\` skill: it is the learner's taste and workflow. On style it wins over other skills.
- The deliverable is \`renders/notebook.mp4\` in this directory. Render with \`--quality delivery\`.
- Work only inside this directory.
- Bash runs ONLY these commands (anything else is refused — that does not mean Bash is unavailable):
  \`npx --yes hyperframes …\`, \`npx hyperframes …\`, \`ffprobe …\`, \`ffmpeg …\`, \`ls …\`, \`mkdir …\`.
  Use the Read/Write/Edit/Glob/Grep tools for files. One command per Bash call, no pipes or \`&&\`.`;

export function notebookVideoPrompt(kind: "generate" | "update"): string {
	return kind === "update"
		? "The video project in this directory already exists (script.md, assets, composition, renders/notebook.mp4). notebook.md is the notebook as it is now. Read request.md: it is what the learner wants changed. Revise the project to do exactly that, keep everything else, and re-render renders/notebook.mp4. Use the notebook-video skill."
		: "Make the notebook video for notebook.md, following the notebook-video skill, and render it to renders/notebook.mp4.";
}

/** One progress line from a Claude Code stream-json event, or null. */
export function videoProgressLine(event: unknown): string | null {
	const e = event as { type?: string; message?: { content?: unknown } };
	if (e.type !== "assistant" || !Array.isArray(e.message?.content)) return null;
	const lines: string[] = [];
	for (const c of e.message.content as { type?: string; name?: string; text?: string; input?: Record<string, unknown> }[]) {
		if (c.type === "tool_use") {
			const input = c.input ?? {};
			const detail =
				c.name === "Bash"
					? String(input.command ?? "").replace(/^npx (--yes )?/, "")
					: c.name === "Skill"
						? String(input.skill ?? "")
						: String(input.file_path ?? input.pattern ?? "").split("/").slice(-2).join("/");
			lines.push(`${c.name}${detail ? `: ${detail}` : ""}`);
		} else if (c.type === "text" && c.text?.trim()) {
			lines.push(c.text.trim().split("\n")[0]!);
		}
	}
	const line = lines.join(" · ").replace(/\s+/g, " ").trim();
	return line ? (line.length > 160 ? `${line.slice(0, 157)}…` : line) : null;
}
