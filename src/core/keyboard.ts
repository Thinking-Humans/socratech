/**
 * Keyboard shortcuts (shortcut wave, 2026-09-17) — the single source of truth
 * for every app action that has a binding. This module is PURE (no React, no
 * window access at module scope beyond the guarded helpers) so it can render
 * a cheat sheet, match events, and — at the settings milestone — drive a
 * user-editable key map without touching any component.
 *
 * Design (owner-approved plan):
 * - Tab is DEAD: browser tab-focus navigation is abandoned entirely. Tab
 *   does nothing; Shift+Tab alone cycles the thinking level.
 * - Esc is a layered dismiss: topmost popover (each popover stopPropagation's
 *   its own Esc) → dictation stop → abort in-flight turn.
 * - The key map persists overrides in localStorage (`lh:keymap`, overrides
 *   only) merged over DEFAULT_BINDINGS — the settings wave adds the editor.
 *
 * Binding strings are normalized, cross-platform:
 *   "mod+d"    — mod = ⌘ on macOS, Ctrl elsewhere (both are accepted live)
 *   "shift+tab", "alt+arrowdown", "mod+shift+f", "?", "f2", "escape"
 * Order is fixed: mod, alt, shift, then the key.
 */

export type KeyAction =
	| "toggle-dictation"
	| "open-model-picker"
	| "cycle-thinking"
	| "toggle-sidebar"
	| "sessions-search"
	| "jump-graph"
	| "new-session"
	| "rename-session"
	| "cheat-sheet"
	| "find"
	| "question-focus"
	| "question-next-row"
	| "question-prev-row"
	| "question-pick-row"
	| "question-submit"
	| "open-settings"
	| "toggle-user-thinking"
	| "toggle-question-thread"
	| "search-everything"
	| "journal-new-code"
	| "journal-new-markdown"
	| "journal-new-agent"
	| "journal-run-cell"
	| "journal-run-next"
	| "journal-exit-cell"
	| "journal-focus-top"
	| "journal-edit-cell"
	| "journal-next-cell"
	| "journal-prev-cell"
	| "journal-inline"
	| "journal-inline-insert"
	| "journal-inline-explain"
	| "journal-rate-own"
	| "journal-rate-helped"
	| "journal-rate-stuck"
	| "journal-extract-cell";

/** Where the cheat sheet groups an action (display only — dispatch is
 *  global; a seam that isn't mounted simply no-ops). */
export type KeyScope = "global" | "chat" | "graph" | "journal";

export interface KeyActionDef {
	id: KeyAction;
	/** Cheat-sheet label. */
	label: string;
	scope: KeyScope;
	binding: string;
	/** Display-only (cheat sheet) — contextual keys a SURFACE owns (the
	 *  question dock's row machine); never dispatched from the registry,
	 *  so they can't leak to pages where the surface isn't mounted. */
	displayOnly?: boolean;
	/** Rebindable, but a mounted SURFACE matches it itself (the journal's
	 *  notebook keys) — never in the global dispatch map, so it can share a
	 *  chord with a global action and win only where its surface lives. */
	surfaceOwned?: boolean;
}

export const KEYBOARD_ACTIONS: readonly KeyActionDef[] = [
	{ id: "toggle-dictation", label: "Toggle dictation", scope: "global", binding: "mod+d" },
	{ id: "open-settings", label: "Open settings", scope: "global", binding: "mod+," },
	// Journal-only app (owner, 2026-11-15): Mod+K is search-everything, so the
	// model selector moved to Mod+Shift+K.
	{ id: "open-model-picker", label: "Model selector", scope: "global", binding: "mod+shift+k" },
	{ id: "search-everything", label: "Search everything", scope: "global", binding: "mod+k" },
	{ id: "cycle-thinking", label: "Cycle thinking level", scope: "global", binding: "shift+tab" },
	// Mod+B belongs to the journal (new code cell, owner 2026-11-15).
	{ id: "toggle-sidebar", label: "Toggle sidebar", scope: "global", binding: "mod+\\" },
	{ id: "sessions-search", label: "Search sessions", scope: "global", binding: "mod+shift+f" },
	// (The Alt+↑/↓/↵ session cycle was RETIRED, owner 2026-10-10: barely
	// used, felt laggy. Session navigation lives IN the search now — ↑/↓
	// walk the filtered list, Enter opens (first match when nothing
	// walked) — see sidebar.tsx's search input.)
	{ id: "jump-graph", label: "Graph view", scope: "global", binding: "mod+g" },
	{ id: "new-session", label: "New session", scope: "global", binding: "mod+n" },
	{ id: "rename-session", label: "Rename session", scope: "chat", binding: "f2" },
	{ id: "toggle-user-thinking", label: "Toggle all your thinking", scope: "chat", binding: "mod+t" },
	{ id: "toggle-question-thread", label: "Question · ask for a nudge (side thread)", scope: "chat", binding: "mod+j" },
	// Mod+F is surface-scoped: graph node search and session text Find share
	// one action/binding. Only the currently mounted surface listens.
	{ id: "find", label: "Find", scope: "global", binding: "mod+f" },
	{ id: "cheat-sheet", label: "Shortcut cheat sheet", scope: "global", binding: "?" },
	// The question dock's row machine (wave B) — displayOnly: the dock owns
	// the keys while a question is expanded; the registry never dispatches
	// them, so bare arrows stay free everywhere else.
	{ id: "question-focus", label: "Question · focus thinking ↔ rows", scope: "chat", binding: "tab", displayOnly: true },
	// (The model-menu entries — "walk results" ↑/↓, "pick result" ↵ — were
	// REMOVED, owner 2026-10-10: obvious in-field menu navigation, never
	// dispatched, never rebindable — not settings material. The menu's own
	// arrow machine (menu-shell.tsx) is unchanged.)
	{ id: "question-next-row", label: "Question · next row", scope: "chat", binding: "arrowdown", displayOnly: true },
	{ id: "question-prev-row", label: "Question · previous row", scope: "chat", binding: "arrowup", displayOnly: true },
	{ id: "question-pick-row", label: "Question · pick row", scope: "chat", binding: "space", displayOnly: true },
	{ id: "question-submit", label: "Question · submit", scope: "chat", binding: "enter", displayOnly: true },
	// The journal's notebook keys (owner, 2026-11-15) — Jupyter-style command
	// / edit modes, matched by the journal view itself (surfaceOwned).
	{ id: "journal-new-code", label: "New code cell below", scope: "journal", binding: "mod+b", surfaceOwned: true },
	{ id: "journal-new-markdown", label: "New markdown cell below", scope: "journal", binding: "mod+m", surfaceOwned: true },
	{ id: "journal-new-agent", label: "New agent cell below (command mode)", scope: "journal", binding: "mod+l", surfaceOwned: true },
	{ id: "journal-run-cell", label: "Run cell (edit mode)", scope: "journal", binding: "mod+enter", surfaceOwned: true },
	{ id: "journal-run-next", label: "Run cell + new cell below (edit mode)", scope: "journal", binding: "shift+enter", surfaceOwned: true },
	{ id: "journal-exit-cell", label: "Leave cell (once: stop editing · twice: scroll the notebook)", scope: "journal", binding: "escape", surfaceOwned: true },
	{ id: "journal-focus-top", label: "Focus the top cell", scope: "journal", binding: "tab", surfaceOwned: true },
	{ id: "journal-edit-cell", label: "Edit the focused cell", scope: "journal", binding: "enter", surfaceOwned: true },
	{ id: "journal-next-cell", label: "Next cell", scope: "journal", binding: "arrowdown", surfaceOwned: true },
	{ id: "journal-prev-cell", label: "Previous cell", scope: "journal", binding: "arrowup", surfaceOwned: true },
	// Inline ask while editing (owner, 2026-11-15): Mod+L starts the chord,
	// then I inserts an answer / E explains the highlighted text in a small
	// box (the second key works with or without Mod). Any other key opens the
	// box for a free question. In command mode Mod+L still adds an agent cell.
	{ id: "journal-inline", label: "Inline ask about the highlighted text (edit mode) — then I / E", scope: "journal", binding: "mod+l", surfaceOwned: true },
	{ id: "journal-inline-insert", label: "… then: insert the answer into the cell", scope: "journal", binding: "i", surfaceOwned: true },
	{ id: "journal-inline-explain", label: "… then: explain it in the box", scope: "journal", binding: "e", surfaceOwned: true },
	// Rating + graph on the focused cell (command mode).
	{ id: "journal-rate-own", label: "Rate the focused cell: did it on my own", scope: "journal", binding: "1", surfaceOwned: true },
	{ id: "journal-rate-helped", label: "Rate: did it with help", scope: "journal", binding: "2", surfaceOwned: true },
	{ id: "journal-rate-stuck", label: "Rate: couldn't understand, even with help (explains prerequisites)", scope: "journal", binding: "3", surfaceOwned: true },
	{ id: "journal-extract-cell", label: "Read the notebook into the graph", scope: "journal", binding: "g", surfaceOwned: true },
];

export type KeymapAction = KeyAction | `plugin:${string}:${string}`;
export type KeymapOverrides = Partial<Record<KeymapAction, string>>;
export const KEYMAP_CHANGED_EVENT = "lh:keymap-changed";
const STORAGE_KEY = "lh:keymap";

/** localStorage overrides ({actionId: binding}) — read once per module
 *  instance; the settings editor will write this key. Guarded: SSR and a
 *  corrupt/absent store both fall back to defaults. */
export function loadOverrides(): KeymapOverrides {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as KeymapOverrides;
		if (parsed && typeof parsed === "object") return parsed;
	} catch {
		/* corrupt store = defaults */
	}
	return {};
}

/** Write the full overrides map ({actionId: binding}) — the settings
 *  editor's rebind/reset persistence. Guarded: SSR no-ops. An empty
 *  map clears the store entirely (all-defaults). */
export function saveOverrides(overrides: KeymapOverrides): void {
	if (typeof window === "undefined") return;
	try {
		if (Object.keys(overrides).length) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
		else window.localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* storage unavailable = overrides don't persist, defaults keep working */
	}
	window.dispatchEvent?.(new window.Event(KEYMAP_CHANGED_EVENT));
}

/** The live key map: defaults with user overrides applied. */
export function effectiveKeymap(): Map<string, KeyAction> {
	const overrides = loadOverrides();
	const map = new Map<string, KeyAction>();
	for (const def of KEYBOARD_ACTIONS) {
		if (def.displayOnly || def.surfaceOwned) continue; // a surface matches these itself
		const binding = overrides[def.id] ?? def.binding;
		if (typeof binding === "string" && binding) map.set(binding, def.id);
	}
	return map;
}

/** Which action a normalized binding fires, if any (override-aware). */
export function actionForBinding(binding: string): KeyAction | undefined {
	return effectiveKeymap().get(binding);
}

/** The effective (override-aware) binding for one action — display use. */
export function bindingForAction(id: KeyAction): string {
	const overrides = loadOverrides();
	const def = KEYBOARD_ACTIONS.find((a) => a.id === id);
	if (!def) return "";
	return overrides[id] ?? def.binding;
}

/**
 * Normalize a KeyboardEvent to a canonical binding string. Rules:
 * - mod matches BOTH meta (⌘) and ctrl — Ctrl+K works on a Mac keyboard too.
 * - a printable key ("?") bakes its shift in: "shift+/?" collapses to "?".
 * - with mod or alt held, a single non-ASCII character falls back to its
 *   physical A–Z/comma position (Russian Ctrl+"л" → mod+k). ASCII characters
 *   keep following `key`, including AZERTY/Dvorak mappings.
 */
export function eventBinding(e: KeyboardEvent): string {
	const mod = e.metaKey || e.ctrlKey;
	// A bare printable key bakes its shift into the character ("?" not
	// "shift+/"), so it returns alone. With a real modifier riding along,
	// shift is explicit (⌘⇧F = "mod+shift+f"); non-printable keys (Tab,
	// arrows) always keep their shift (Shift+Tab = "shift+tab").
	if (e.key.length === 1 && !mod && !e.altKey) return e.key.toLowerCase();
	const mods: string[] = [];
	if (mod) mods.push("mod");
	if (e.altKey) mods.push("alt");
	if (e.shiftKey) mods.push("shift");
	return [...mods, modifiedKey(e)].join("+");
}

/** The key part of a modified binding. A non-ASCII `key` (the layout's own
 *  letter) falls back to `code` — KeyK → "k", Comma → "," — the only keys the
 *  registry binds by character. */
function modifiedKey(e: KeyboardEvent): string {
	const key = e.key.toLowerCase();
	// Inspect the reported character: lowercasing can expand it (İ → i̇).
	if (e.key.length !== 1 || e.key <= "\x7f" || !(e.metaKey || e.ctrlKey || e.altKey)) return key;
	if (e.code === "Comma") return ",";
	const letter = /^Key([A-Z])$/.exec(e.code);
	return letter?.[1] ? letter[1].toLowerCase() : key;
}

/** The window event name a registry action dispatches/answers on —
 *  the ONE spelling shared by the dispatcher (keyboard-shortcuts) and
 *  every surface listener. Born from the ⌘B bug (owner interlude
 *  2026-09-25): the sidebar listened on the pre-convention name
 *  "lh:toggle-sidebar" while the dispatcher sent "lh:kbd-toggle-sidebar",
 *  so ⌘B silently did nothing. With both sides composing through this
 *  helper the mismatch is structurally impossible.
 */
export function kbdEventForAction(action: KeyAction): string {
	return `lh:kbd-${action}`;
}

/** True when the event lands in a typing surface (input, textarea, or a
 *  contentEditable). In one, only mod/alt combos (and Tab, which types
 *  nothing) may fire — bare keys belong to the field (typing, caret). */
export function isTypingSurface(e: KeyboardEvent): boolean {
	const target = e.target as HTMLElement | null;
	if (!target) return false;
	const tag = target.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	return target.isContentEditable;
}

/** macOS styling for binding display ("⌘D", "⇧⇥", "⌥↑"). */
export const IS_MAC =
	typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

const MOD_GLYPH = IS_MAC ? "⌘" : "Ctrl+";
const ALT_GLYPH = IS_MAC ? "⌥" : "Alt+";
const SHIFT_GLYPH = IS_MAC ? "⇧" : "Shift+";

const KEY_GLYPH: Record<string, string> = {
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→",
	enter: "↵",
	tab: "⇥",
	escape: "Esc",
	space: "Space",
	" ": "Space",
};

/** Format a binding for display: "mod+shift+f" → "⌘⇧F". */
export function formatBinding(binding: string): string {
	const parts = binding.split("+");
	const key = parts.pop()!; // last part is always the key
	const glyphs: string[] = [];
	for (const part of parts) {
		if (part === "mod") glyphs.push(MOD_GLYPH);
		else if (part === "alt") glyphs.push(ALT_GLYPH);
		else if (part === "shift") glyphs.push(SHIFT_GLYPH);
	}
	const keyGlyph = KEY_GLYPH[key] ?? key.toUpperCase();
	return glyphs.join("") + keyGlyph;
}

/** Does this event fire `id` (override-aware)? For surfaceOwned actions,
 *  which their surface matches itself. */
export function eventMatchesAction(e: KeyboardEvent, id: KeyAction): boolean {
	const binding = bindingForAction(id);
	return binding !== "" && eventBinding(e) === binding;
}
