/**
 * Obsidian-style live preview for CodeMirror 6 (docs/notes-first.md N2):
 * the text stays raw markdown; decorations style it in place.
 *  - headings sized, emphasis / code / links highlighted
 *  - `> [!claude]` callout blocks shaded as Claude's answer
 *  - `/ask …` lines marked, with a run button (onAsk)
 *  - `## Topic` lines carry journey buttons — teach / practice / improvise
 *    (onJourney), and "resume" for a journey already started (onResume)
 *  - `<!-- journey:kind:id -->` marker lines set small and muted
 *  - fenced code blocks set in mono on a panel
 */

import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { JOURNEY_MARKER_RE, type JourneyKind } from "@/src/core";

/** Dispatch to repaint buttons when busy state changes outside the doc. */
export const refreshPreview = StateEffect.define<null>();

export const ASK_RE = /^\/ask\s+\S/;
export const CALLOUT_HEAD_RE = /^>\s*\[!claude\]/i;
export const TOPIC_RE = /^##\s+(\S.*)$/;

const highlight = HighlightStyle.define([
	{ tag: t.heading1, fontSize: "1.6em", fontWeight: "800" },
	{ tag: t.heading2, fontSize: "1.3em", fontWeight: "700" },
	{ tag: t.heading3, fontSize: "1.12em", fontWeight: "700" },
	{ tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
	{ tag: t.strong, fontWeight: "700", color: "var(--lh-ink-strong)" },
	{ tag: t.emphasis, fontStyle: "italic", color: "var(--lh-ink-italic)" },
	{ tag: t.strikethrough, textDecoration: "line-through" },
	{ tag: t.link, color: "var(--muted-foreground)", textDecoration: "underline" },
	{ tag: t.url, color: "var(--muted-foreground)" },
	{ tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.9em" },
	{ tag: [t.processingInstruction, t.meta], color: "var(--muted-foreground)" },
	{ tag: t.quote, color: "var(--foreground)" },
	{ tag: t.list, color: "var(--muted-foreground)" },
]);

class ButtonWidget extends WidgetType {
	constructor(
		readonly label: string,
		readonly kind: "ask" | "journey" | "resume",
		readonly line: number,
		readonly busy: boolean,
		readonly arg = "",
	) {
		super();
	}
	eq(other: ButtonWidget) {
		return other.label === this.label && other.kind === this.kind && other.line === this.line && other.busy === this.busy && other.arg === this.arg;
	}
	toDOM() {
		const b = document.createElement("button");
		b.type = "button";
		b.className = `cm-lh-btn cm-lh-btn-${this.kind}`;
		b.textContent = this.label;
		b.dataset.lhAction = this.kind;
		b.dataset.line = String(this.line);
		b.dataset.arg = this.arg;
		b.disabled = this.busy;
		return b;
	}
	ignoreEvent() {
		return false;
	}
}

export interface LivePreviewOptions {
	onAsk: (lineNumber: number) => void;
	onJourney: (lineNumber: number, kind: JourneyKind) => void;
	onResume: (chatId: string) => void;
	/** Line numbers with an /ask in flight (button shows busy). */
	isBusy: (lineNumber: number) => boolean;
}

function build(view: EditorView, opts: LivePreviewOptions): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const doc = view.state.doc;
	// Fenced-code line ranges from the parse tree.
	const codeLines = new Set<number>();
	syntaxTree(view.state).iterate({
		enter(node) {
			if (node.name === "FencedCode") {
				const a = doc.lineAt(node.from).number;
				const b = doc.lineAt(node.to).number;
				for (let n = a; n <= b; n++) codeLines.add(n);
				return false;
			}
		},
	});
	let inCallout = false;
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		const text = line.text;
		if (codeLines.has(n)) {
			builder.add(line.from, line.from, Decoration.line({ class: "cm-lh-code" }));
			inCallout = false;
			continue;
		}
		if (CALLOUT_HEAD_RE.test(text)) {
			inCallout = true;
			builder.add(line.from, line.from, Decoration.line({ class: "cm-lh-callout cm-lh-callout-head" }));
			continue;
		}
		if (inCallout && text.startsWith(">")) {
			builder.add(line.from, line.from, Decoration.line({ class: "cm-lh-callout" }));
			continue;
		}
		inCallout = false;
		if (JOURNEY_MARKER_RE.test(text)) {
			builder.add(line.from, line.from, Decoration.line({ class: "cm-lh-marker" }));
			continue;
		}
		if (ASK_RE.test(text)) {
			builder.add(line.from, line.from, Decoration.line({ class: "cm-lh-ask" }));
			const busy = opts.isBusy(n);
			builder.add(line.to, line.to, Decoration.widget({ widget: new ButtonWidget(busy ? "asking…" : "ask ⌘↵", "ask", n, busy), side: 1 }));
			continue;
		}
		if (TOPIC_RE.test(text)) {
			// Latest journey of this section (markers sit right under the heading).
			let latest: RegExpMatchArray | null = null;
			for (let k = n + 1; k <= doc.lines; k++) {
				const t2 = doc.line(k).text;
				if (/^#{1,2}\s/.test(t2)) break;
				latest = t2.match(JOURNEY_MARKER_RE) ?? latest;
			}
			if (latest) builder.add(line.to, line.to, Decoration.widget({ widget: new ButtonWidget(`resume ${latest[1]} →`, "resume", n, false, latest[2]), side: 1 }));
			const kinds: [JourneyKind, string][] = [
				["teach", latest ? "teach" : "teach →"],
				["practice", "practice"],
				["improvise", "improvise"],
			];
			for (const [k, label] of kinds) builder.add(line.to, line.to, Decoration.widget({ widget: new ButtonWidget(label, "journey", n, false, k), side: 1 }));
		}
	}
	return builder.finish();
}

const theme = EditorView.theme({
	"&": { color: "var(--foreground)", backgroundColor: "transparent", fontSize: "var(--lh-prose-size)", height: "100%" },
	".cm-scroller": { fontFamily: "var(--font-prose)", lineHeight: "1.65", overflow: "auto" },
	".cm-content": { maxWidth: "46rem", margin: "0 auto", padding: "2rem 1.5rem 40vh", caretColor: "var(--foreground)" },
	"&.cm-focused": { outline: "none" },
	".cm-cursor": { borderLeftColor: "var(--foreground)" },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent) !important" },
	".cm-activeLine": { backgroundColor: "transparent" },
	".cm-lh-code": { fontFamily: "var(--font-mono)", fontSize: "0.88em", backgroundColor: "var(--muted)", paddingLeft: "0.75rem" },
	".cm-lh-callout": { backgroundColor: "color-mix(in oklab, var(--accent) 70%, transparent)", borderLeft: "3px solid #d97757", paddingLeft: "0.75rem" },
	".cm-lh-callout-head": { color: "#d97757", fontSize: "0.85em", fontWeight: "600" },
	".cm-lh-ask": { color: "#d97757" },
	".cm-lh-btn": {
		marginLeft: "0.75rem",
		padding: "0 0.45rem",
		fontFamily: "var(--font-ui)",
		fontSize: "0.7rem",
		lineHeight: "1.4rem",
		borderRadius: "4px",
		border: "1px solid var(--border)",
		color: "var(--muted-foreground)",
		background: "transparent",
		cursor: "pointer",
		verticalAlign: "middle",
	},
	".cm-lh-btn:hover": { color: "var(--foreground)", backgroundColor: "var(--accent)" },
	".cm-lh-btn:disabled": { cursor: "default", opacity: "0.6" },
	".cm-lh-btn-journey": { opacity: "0", transition: "opacity 120ms", marginLeft: "0.35rem" },
	".cm-lh-btn-journey + .cm-lh-btn-journey": { marginLeft: "0.25rem" },
	".cm-line:hover .cm-lh-btn-journey, .cm-activeLine .cm-lh-btn-journey": { opacity: "1" },
	".cm-lh-btn-resume": { color: "#d97757", borderColor: "#d97757" },
	".cm-lh-marker": { fontFamily: "var(--font-mono)", fontSize: "0.7em", color: "var(--muted-foreground)", opacity: "0.6" },
});

export function livePreview(opts: LivePreviewOptions): Extension {
	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view, opts);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.reconfigured || tr.effects.some((e) => e.is(refreshPreview))) || syntaxTree(u.startState) !== syntaxTree(u.state)) {
					this.decorations = build(u.view, opts);
				}
			}
		},
		{
			decorations: (v) => v.decorations,
			eventHandlers: {
				mousedown(e) {
					const el = (e.target as HTMLElement).closest<HTMLElement>("[data-lh-action]");
					if (!el) return false;
					e.preventDefault();
					const line = Number(el.dataset.line);
					const action = el.dataset.lhAction;
					if (action === "ask") opts.onAsk(line);
					else if (action === "resume") opts.onResume(el.dataset.arg ?? "");
					else opts.onJourney(line, (el.dataset.arg || "teach") as JourneyKind);
					return true;
				},
			},
		},
	);
	return [syntaxHighlighting(highlight), theme, plugin];
}
