/**
 * Notebook video jobs (owner, 2026-11-21): a headless Claude Code run in a
 * per-notebook HyperFrames project builds one voiced video of the whole
 * notebook. 10–30 minutes, so it is a server job, not a request:
 *
 *   data/journal-video/<id>/state.json   what the panel polls
 *   data/journal-video/<id>/project/     the agent's project (kept for updates)
 *
 * The finished MP4 is copied into the notebook's media store. The agent runs
 * with project-only settings (the HyperFrames skills + the learner's taste
 * skill copied in), no MCP, a Bash allowlist and a zero credit limit.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { getClaudeBinary } from "../agent/claude-code/binary.ts";
import {
	IDLE_VIDEO_STATE,
	NOTEBOOK_VIDEO_HEADLESS_RULES,
	notebookVideoHash,
	notebookVideoMedia,
	notebookVideoPrompt,
	notebookVideoSource,
	videoProgressLine,
	type NotebookVideoState,
} from "../core/notebook-video.ts";
import { JournalError } from "../core/journal.ts";
import { mediaFileName } from "../core/journal-media.ts";
import { claudeCodeAvailable } from "./claude-code-config.ts";
import { journalMediaDir, journalMediaFile } from "./journal-media.ts";
import { requireJournal } from "./journals.ts";
import { stores } from "./stores.ts";
import { uploadToYouTube, type YouTubePrivacy } from "./youtube.ts";

/** Skills the agent gets, copied from the user's Claude skills folder. */
const HYPERFRAMES_SKILLS = [
	"hyperframes",
	"hyperframes-animation",
	"hyperframes-audio",
	"hyperframes-cli",
	"hyperframes-core",
	"hyperframes-creative",
	"hyperframes-keyframes",
	"hyperframes-registry",
	"media-use",
];
const ALLOWED_BASH = ["npx --yes hyperframes", "npx hyperframes", "ffprobe", "ffmpeg", "ls", "mkdir"];
const KOKORO_VENV = path.join(/* turbopackIgnore: true */ os.homedir(), ".hyperframes", "kokoro-venv");
const LOG_LINES = 60;

// ─── the taste skill (Settings → Notebook video) ─────────────────────────────

export function readVideoTaste(): { text: string; custom: boolean; defaultText: string } {
	const defaultText = fs.readFileSync(PATHS.notebookVideoSkill, "utf8");
	try {
		return { text: fs.readFileSync(PATHS.notebookVideoTaste, "utf8"), custom: true, defaultText };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		return { text: defaultText, custom: false, defaultText };
	}
}

/** Save the learner's taste (null = back to the shipped default). */
export function writeVideoTaste(text: string | null): void {
	if (text === null) return fs.rmSync(PATHS.notebookVideoTaste, { force: true });
	if (!text.trim()) throw new JournalError("The taste skill is empty.", "invalid");
	fs.mkdirSync(path.dirname(PATHS.notebookVideoTaste), { recursive: true });
	fs.writeFileSync(PATHS.notebookVideoTaste, text);
}

// ─── setup (Settings → Notebook video) ──────────────────────────────────────

export interface VideoSetup {
	claude: boolean;
	skills: boolean;
	kokoro: boolean;
	ffmpeg: boolean;
}

const userSkillsDir = () => path.join(/* turbopackIgnore: true */ os.homedir(), ".claude", "skills");
const onPath = (bin: string) => (process.env.PATH ?? "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(/* turbopackIgnore: true */ d, bin)));

export function videoSetup(): VideoSetup {
	return {
		claude: claudeCodeAvailable(),
		skills: HYPERFRAMES_SKILLS.every((s) => fs.existsSync(path.join(/* turbopackIgnore: true */ userSkillsDir(), s, "SKILL.md"))),
		kokoro: fs.existsSync(path.join(/* turbopackIgnore: true */ KOKORO_VENV, "bin", "python")),
		ffmpeg: onPath("ffmpeg") && onPath("ffprobe"),
	};
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		p.on("error", reject);
		p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${out.slice(-400)}`))));
	});
}

/** One-time install: HyperFrames skills, the render browser, local Kokoro voice. */
export async function installVideoTools(onLine: (line: string) => void = () => {}): Promise<VideoSetup> {
	const setup = videoSetup();
	if (!setup.skills) {
		onLine("installing HyperFrames skills");
		await run("npx", ["--yes", "hyperframes", "skills", "update", ...HYPERFRAMES_SKILLS]);
	}
	onLine("checking the render browser");
	await run("npx", ["--yes", "hyperframes", "browser", "ensure"]);
	if (!setup.kokoro) {
		onLine("installing local Kokoro voice");
		await run("python3", ["-m", "venv", KOKORO_VENV]);
		await run(path.join(KOKORO_VENV, "bin", "pip"), ["install", "-q", "kokoro-onnx", "soundfile"]);
	}
	return videoSetup();
}

// ─── state ───────────────────────────────────────────────────────────────────

const videoDir = (id: string) => path.join(/* turbopackIgnore: true */ PATHS.journalVideo, id.replace(/[^\w-]/g, "_"));
const stateFile = (id: string) => path.join(videoDir(id), "state.json");
const projectDir = (id: string) => path.join(videoDir(id), "project");

type Job = { proc: ChildProcess; state: NotebookVideoState; cancelled: boolean };
type VideoGlobal = { __lhNotebookVideoJobs?: Map<string, Job> };
/** Process-global: route modules and HMR reloads share the running jobs. */
function jobs(): Map<string, Job> {
	const g = globalThis as typeof globalThis & VideoGlobal;
	return (g.__lhNotebookVideoJobs ??= new Map());
}

function readState(id: string): NotebookVideoState {
	try {
		return { ...IDLE_VIDEO_STATE, ...(JSON.parse(fs.readFileSync(stateFile(id), "utf8")) as NotebookVideoState) };
	} catch {
		return { ...IDLE_VIDEO_STATE };
	}
}

function writeState(id: string, state: NotebookVideoState): void {
	fs.mkdirSync(videoDir(id), { recursive: true });
	const tmp = `${stateFile(id)}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, "\t"));
	fs.renameSync(tmp, stateFile(id));
}

/** Kill a process group if it is still a claude run (pid reuse guard). */
function killGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
	try {
		if (!fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("claude")) return;
	} catch {
		if (process.platform === "linux") return; // gone
	}
	try {
		process.kill(-pid, signal);
	} catch {
		// already gone
	}
}

/** HyperFrames keeps a warm Chrome daemon in its own session (it idles out
 *  after 5 min), out of the job's process group. When a job ends, stop
 *  anything still running inside its project folder. Linux /proc only. */
function killProjectStragglers(dir: string): void {
	let pids: string[];
	try {
		pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
	} catch {
		return;
	}
	for (const pid of pids) {
		try {
			const cwd = fs.readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
			if (cwd === dir || cwd.startsWith(`${dir}${path.sep}`)) process.kill(Number(pid), "SIGTERM");
		} catch {
			// not ours / gone
		}
	}
}

/** The panel's view. A "running" state with no live job was cut off (server restart). */
export function notebookVideoState(id: string): NotebookVideoState & { stale: boolean; setup: VideoSetup } {
	requireJournal(id);
	const job = jobs().get(id);
	let state = job?.state ?? readState(id);
	if (!job && state.status === "running") {
		if (state.pid) killGroup(state.pid);
		state = { ...state, status: "interrupted", pid: undefined, finishedAt: new Date().toISOString() };
		writeState(id, state);
	}
	const stale = Boolean(state.video && state.sourceHash && state.sourceHash !== notebookVideoHash(requireJournal(id)));
	return { ...state, stale, setup: videoSetup() };
}

// ─── the run ─────────────────────────────────────────────────────────────────

/** Fresh or updated project: notebook, media, skills (+ taste), zero credit limit. */
function prepareProject(id: string, kind: "generate" | "update", request?: string): string {
	const journal = requireJournal(id);
	const dir = projectDir(id);
	killProjectStragglers(dir);
	if (kind === "generate") fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, "media"), { recursive: true });
	fs.writeFileSync(path.join(dir, "notebook.md"), notebookVideoSource(journal));
	for (const name of notebookVideoMedia(journal)) {
		const file = journalMediaFile(id, name);
		if (file) fs.copyFileSync(file, path.join(dir, "media", name));
	}
	const skills = path.join(dir, ".claude", "skills");
	fs.rmSync(skills, { recursive: true, force: true });
	for (const s of HYPERFRAMES_SKILLS) fs.cpSync(path.join(userSkillsDir(), s), path.join(skills, s), { recursive: true });
	fs.mkdirSync(path.join(skills, "notebook-video"), { recursive: true });
	fs.writeFileSync(path.join(skills, "notebook-video", "SKILL.md"), readVideoTaste().text);
	fs.mkdirSync(path.join(dir, ".hyperframes"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".hyperframes", "credit-limit.json"), '{"credits": 0}\n');
	const requestFile = path.join(dir, "request.md");
	if (request?.trim()) fs.writeFileSync(requestFile, `${request.trim()}\n`);
	else fs.rmSync(requestFile, { force: true });
	fs.rmSync(path.join(dir, "renders", "notebook.mp4"), { force: true });
	return dir;
}

/** The strong slot's model when it is a Claude Code one, else Claude Code's default. */
function agentModel(): string | undefined {
	const strong = stores.settingsStore.readSettings()?.models?.strong?.model;
	return strong?.provider === "claude-code" ? strong.id : undefined;
}

export function startNotebookVideo(id: string, opts: { request?: string } = {}): NotebookVideoState {
	requireJournal(id);
	if (jobs().has(id)) throw new JournalError("A video for this notebook is already being made.", "conflict");
	const setup = videoSetup();
	if (!setup.claude) throw new JournalError("Notebook videos need Claude Code (Settings → Models → Claude Code).", "invalid");
	if (!setup.skills || !setup.kokoro || !setup.ffmpeg) throw new JournalError("Install the video tools first (Settings → Notebook video).", "invalid");
	const binary = getClaudeBinary()!;
	const previous = readState(id);
	const kind = opts.request?.trim() && previous.video && fs.existsSync(path.join(projectDir(id), "script.md")) ? "update" : "generate";
	const dir = prepareProject(id, kind, opts.request);
	const sourceHash = notebookVideoHash(requireJournal(id));
	const model = agentModel();
	const args = [
		"-p",
		notebookVideoPrompt(kind),
		"--output-format",
		"stream-json",
		"--verbose",
		...(model ? ["--model", model] : []),
		"--setting-sources",
		"project",
		"--strict-mcp-config",
		"--mcp-config",
		'{"mcpServers":{}}',
		"--tools",
		"Bash",
		"Read",
		"Write",
		"Edit",
		"Glob",
		"Grep",
		"Skill",
		"--permission-mode",
		"dontAsk",
		"--allowedTools",
		...ALLOWED_BASH.map((c) => `Bash(${c}:*)`),
		"Read",
		"Write",
		"Edit",
		"Glob",
		"Grep",
		"Skill",
		"--append-system-prompt",
		NOTEBOOK_VIDEO_HEADLESS_RULES,
		"--no-session-persistence",
	];
	const proc = spawn(binary, args, {
		cwd: dir,
		// Own process group: cancel kills claude AND its npx / Chrome / ffmpeg children.
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, HYPERFRAMES_PYTHON: path.join(KOKORO_VENV, "bin", "python"), HYPERFRAMES_SKIP_SKILLS: "1" },
	});
	const state: NotebookVideoState = {
		status: "running",
		kind,
		...(opts.request?.trim() ? { request: opts.request.trim() } : {}),
		...(previous.video ? { video: previous.video, sourceHash: previous.sourceHash } : {}),
		startedAt: new Date().toISOString(),
		log: [kind === "update" ? `updating: ${opts.request!.trim()}` : "starting from scratch"],
		pid: proc.pid,
	};
	const job: Job = { proc, state, cancelled: false };
	jobs().set(id, job);
	writeState(id, state);

	let lastWrite = 0;
	const push = (line: string) => {
		state.log = [...state.log, line].slice(-LOG_LINES);
		if (Date.now() - lastWrite > 1000) {
			lastWrite = Date.now();
			writeState(id, state);
		}
	};
	let buf = "";
	let result: { is_error?: boolean; result?: string } | null = null;
	proc.stdout!.on("data", (chunk: Buffer) => {
		buf += chunk.toString("utf8");
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const raw = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (!raw.trim()) continue;
			try {
				const event = JSON.parse(raw) as { type?: string };
				if (event.type === "result") result = event as typeof result;
				const line = videoProgressLine(event);
				if (line) push(line);
			} catch {
				// not JSON — ignore
			}
		}
	});
	let stderr = "";
	proc.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-2000)));
	let finished = false;
	const finish = (code: number | null, err?: Error) => {
		if (finished) return;
		finished = true;
		jobs().delete(id);
		killProjectStragglers(dir);
		try {
			requireJournal(id);
		} catch {
			return; // the notebook was deleted mid-run: leave nothing behind
		}
		const done: NotebookVideoState = { ...state, pid: undefined, finishedAt: new Date().toISOString() };
		const render = path.join(dir, "renders", "notebook.mp4");
		if (job.cancelled) {
			done.status = "cancelled";
		} else if (code === 0 && fs.existsSync(render) && fs.statSync(render).size > 0) {
			const mediaDir = journalMediaDir(id);
			fs.mkdirSync(mediaDir, { recursive: true });
			const name = mediaFileName("notebook-video.mp4", randomUUID().slice(0, 6));
			fs.copyFileSync(render, path.join(mediaDir, name));
			if (previous.video && previous.video !== name) fs.rmSync(path.join(mediaDir, previous.video), { force: true });
			Object.assign(done, { status: "done", video: name, sourceHash, summary: result?.result?.trim(), error: undefined, youtube: undefined });
		} else {
			done.status = "failed";
			done.error = err?.message ?? (result?.result?.trim() || stderr.trim().split("\n").pop() || `the agent exited (${code}) without renders/notebook.mp4`);
		}
		writeState(id, done);
	};
	proc.on("error", (err) => finish(null, err));
	proc.on("exit", (code) => finish(code));
	return state;
}

/** Upload the current video to YouTube (the learner confirmed title / privacy). */
export async function uploadNotebookVideo(id: string, meta: { title: string; description: string; privacy: YouTubePrivacy }): Promise<NotebookVideoState> {
	requireJournal(id);
	if (jobs().has(id)) throw new JournalError("Wait for the running video job to finish.", "conflict");
	const state = readState(id);
	const file = state.video ? journalMediaFile(id, state.video) : null;
	if (!file) throw new JournalError("There is no finished video to upload.", "invalid");
	const { id: videoId, url } = await uploadToYouTube(file, meta);
	const next = { ...state, youtube: { id: videoId, url, privacy: meta.privacy, at: new Date().toISOString() } };
	writeState(id, next);
	return next;
}

export function cancelNotebookVideo(id: string): NotebookVideoState {
	const job = jobs().get(id);
	if (!job) return notebookVideoState(id);
	job.cancelled = true;
	const pid = job.proc.pid;
	if (pid) {
		killGroup(pid, "SIGTERM");
		setTimeout(() => killGroup(pid, "SIGKILL"), 5000).unref();
	}
	return job.state;
}
