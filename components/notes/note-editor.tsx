"use client";

/**
 * The note editor (docs/notes-first.md N2/N3): CodeMirror 6 over one vault
 * file. Autosaves (debounced, mtime-guarded — a file changed on disk by
 * Obsidian/Emacs is never clobbered). `/ask …` lines run with ⌘/Ctrl+Enter
 * or their button: the line becomes a `> [!claude] question` callout and
 * the answer streams into it. `## Topic` lines offer "start journey".
 */

import { useEffect, useRef, useState } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { ASK_LINE_RE, askContext, calloutBody, calloutHead, journeyMarker, journeySection, type JourneyKind } from "@/src/core";
import { CALLOUT_HEAD_RE, livePreview } from "./live-preview";

export interface NoteFileView {
	path: string;
	content: string;
	mtime: number;
}

export interface JourneySeed {
	kind: JourneyKind;
	topic: string;
	section: string;
}

type SaveState = "saved" | "saving" | "dirty" | "conflict" | "error";

export function NoteEditor({
	note,
	onJourney,
	onResume,
	onSaved,
	className,
}: {
	note: NoteFileView;
	/** Starts a journey; resolves to the new session id (its marker goes under the heading). */
	onJourney?: (seed: JourneySeed) => Promise<string | undefined>;
	onResume?: (chatId: string) => void;
	onSaved?: (note: NoteFileView) => void;
	className?: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const mtime = useRef(note.mtime);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const asking = useRef(0);
	const [saveState, setSaveState] = useState<SaveState>("saved");
	const [notice, setNotice] = useState<string | null>(null);
	const journeyRef = useRef(onJourney);
	journeyRef.current = onJourney;
	const resumeRef = useRef(onResume);
	resumeRef.current = onResume;
	const savedRef = useRef(onSaved);
	savedRef.current = onSaved;

	useEffect(() => {
		if (!host.current) return;
		mtime.current = note.mtime;

		/** Position mappers for answers streaming in (their callout moves as the learner types). */
		const mapListeners = new Set<(u: ViewUpdate) => void>();

		const save = async () => {
			const view = viewRef.current;
			if (!view) return;
			// An answer still streaming: save once it lands (the stream end re-schedules).
			if (asking.current > 0) return;
			setSaveState("saving");
			try {
				const res = await fetch("/api/notes", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: note.path, content: view.state.doc.toString(), ifMtime: mtime.current }),
				});
				if (res.status === 409) {
					setSaveState("conflict");
					return;
				}
				if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
				const { note: saved } = (await res.json()) as { note: NoteFileView };
				mtime.current = saved.mtime;
				setSaveState((s) => (s === "saving" ? "saved" : s));
				savedRef.current?.(saved);
			} catch (err) {
				setSaveState("error");
				setNotice(err instanceof Error ? err.message : String(err));
			}
		};
		const scheduleSave = () => {
			setSaveState("dirty");
			if (saveTimer.current) clearTimeout(saveTimer.current);
			saveTimer.current = setTimeout(() => void save(), 600);
		};

		const ask = async (view: EditorView, lineNumber: number) => {
			const doc = view.state.doc;
			if (lineNumber < 1 || lineNumber > doc.lines) return false;
			const line = doc.line(lineNumber);
			if (!ASK_LINE_RE.test(line.text)) return false;
			const ctx = askContext(doc.toString(), lineNumber);
			if (!ctx) return false;
			const content = doc.toString();
			// The /ask line becomes the callout head; the body grows under it.
			view.dispatch({ changes: { from: line.from, to: line.to, insert: `${calloutHead(ctx.question)}\n> …` } });
			let headPos = line.from;
			asking.current++;
			const writeBody = (answer: string) => {
				const v = viewRef.current;
				if (!v) return;
				const d = v.state.doc;
				const head = d.lineAt(Math.min(headPos, d.length));
				if (!CALLOUT_HEAD_RE.test(head.text)) return; // the learner removed it
				let end = head.to;
				for (let n = head.number + 1; n <= d.lines && d.line(n).text.startsWith(">"); n++) end = d.line(n).to;
				v.dispatch({ changes: { from: head.to, to: end, insert: `\n${calloutBody(answer || "…")}` } });
			};
			// Keep headPos mapped through every edit while streaming.
			const mapper = (u: ViewUpdate) => {
				headPos = u.changes.mapPos(headPos);
			};
			mapListeners.add(mapper);
			let answer = "";
			try {
				const res = await fetch("/api/notes/ask", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ content, line: lineNumber }),
				});
				if (!res.ok || !res.body) {
					const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
					answer = `*(couldn't ask: ${msg})*`;
					writeBody(answer);
				} else {
					const reader = res.body.getReader();
					const dec = new TextDecoder();
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						answer += dec.decode(value, { stream: true });
						writeBody(answer);
					}
				}
			} catch (err) {
				writeBody(`${answer}\n\n*(failed: ${err instanceof Error ? err.message : String(err)})*`);
			} finally {
				mapListeners.delete(mapper);
				asking.current--;
				scheduleSave();
			}
			return true;
		};


		const view = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: note.content,
				extensions: [
					history(),
					keymap.of([
						{
							key: "Mod-Enter",
							run: (v) => {
								const n = v.state.doc.lineAt(v.state.selection.main.head).number;
								if (!ASK_LINE_RE.test(v.state.doc.line(n).text)) return false;
								void ask(v, n);
								return true;
							},
						},
						indentWithTab,
						...defaultKeymap,
						...historyKeymap,
					]),
					markdown({ base: markdownLanguage }),
					EditorView.lineWrapping,
					livePreview({
						onAsk: (n) => void ask(view, n),
						onJourney: (n, kind) => {
							const s = journeySection(view.state.doc.toString(), n);
							if (!s) return;
							const heading = view.state.doc.line(n).text;
							let headPos = view.state.doc.line(n).from;
							const mapper = (u: ViewUpdate) => {
								headPos = u.changes.mapPos(headPos);
							};
							mapListeners.add(mapper);
							void journeyRef.current?.({ kind, topic: s.topic, section: s.section }).then((id) => {
								mapListeners.delete(mapper);
								const v = viewRef.current;
								if (!id || !v) return;
								const line = v.state.doc.lineAt(Math.min(headPos, v.state.doc.length));
								if (line.text !== heading) return; // heading edited/removed meanwhile
								v.dispatch({ changes: { from: line.to, insert: `\n${journeyMarker(kind, id)}` } });
							});
						},
						onResume: (id) => resumeRef.current?.(id),
						isBusy: () => false,
					}),
					EditorView.updateListener.of((u) => {
						if (!u.docChanged) return;
						for (const f of mapListeners) f(u);
						if (asking.current === 0) scheduleSave();
					}),
				],
			}),
		});
		viewRef.current = view;
		view.focus();
		// Cursor to the end of the first empty "## " line, or the doc end.
		const doc = view.state.doc;
		let pos = doc.length;
		for (let n = 1; n <= doc.lines; n++) {
			if (/^##\s*$/.test(doc.line(n).text)) {
				pos = doc.line(n).to;
				break;
			}
		}
		view.dispatch({ selection: { anchor: pos } });

		const flush = () => {
			if (saveTimer.current) {
				clearTimeout(saveTimer.current);
				saveTimer.current = null;
				void save();
			}
		};
		window.addEventListener("beforeunload", flush);
		return () => {
			window.removeEventListener("beforeunload", flush);
			flush();
			view.destroy();
			viewRef.current = null;
		};
		// One editor per file: a new path remounts (the parent keys it).
	}, [note.path]);

	return (
		<div className={`relative flex min-h-0 flex-col ${className ?? ""}`}>
			<div className="pointer-events-none absolute right-4 top-3 z-10 text-xs text-muted-foreground" data-testid="note-save-state">
				{saveState === "saving" || saveState === "dirty" ? "saving…" : saveState === "saved" ? "saved" : null}
			</div>
			{saveState === "conflict" && (
				<div className="mx-auto mt-3 flex max-w-2xl items-center gap-3 rounded-md border border-border bg-muted px-3 py-2 text-sm">
					<span className="flex-1">This note changed on disk (another editor?). Your edits are not saved.</span>
					<button type="button" className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent" onClick={() => location.reload()}>
						Reload
					</button>
				</div>
			)}
			{saveState === "error" && notice && (
				<div className="mx-auto mt-3 max-w-2xl rounded-md border border-border bg-muted px-3 py-2 text-sm text-destructive">Save failed: {notice}</div>
			)}
			<div ref={host} className="min-h-0 flex-1" data-testid="note-editor" />
		</div>
	);
}
