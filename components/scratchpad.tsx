"use client";

/**
 * THE SCRATCHPAD (Mod+P, owner 2026-11-17): one small plain-text buffer that
 * floats over whatever is open — for asides. No agent, no tabs, no markdown.
 * Drag it by its bar, resize it from the corner; Mod+P or Esc hides it and
 * hands focus back. It stays mounted while hidden, so toggling is instant
 * and the caret, scroll and undo history survive.
 *
 * The text lives in the data directory (/api/scratchpad). A copy in
 * localStorage paints it at once and holds an unsent edit across a reload;
 * the frame (position + size) is per device, in localStorage only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";
import { bindingForAction, formatBinding } from "@/src/core";

const TEXT_KEY = "lh:scratchpad";
const FRAME_KEY = "lh:scratchpad-frame";
const SAVE_DELAY_MS = 400;
const EDGE = 8;
const MIN_W = 200;
const MIN_H = 120;

interface Frame {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Keep the frame inside the window (and at least its minimum size). */
export function fitScratchpadFrame(f: Frame, viewport: { width: number; height: number }): Frame {
	const w = Math.max(MIN_W, Math.min(f.w, viewport.width - 2 * EDGE));
	const h = Math.max(MIN_H, Math.min(f.h, viewport.height - 2 * EDGE));
	const x = Math.max(EDGE, Math.min(f.x, viewport.width - w - EDGE));
	const y = Math.max(EDGE, Math.min(f.y, viewport.height - h - EDGE));
	return { x, y, w, h };
}

// (A window that reports no size — a headless page — still gets a sane frame.)
const viewport = () => ({ width: window.innerWidth || 1024, height: window.innerHeight || 768 });

function loadFrame(): Frame {
	const v = viewport();
	const fallback = { w: 380, h: 260, x: v.width - 380 - 24, y: v.height - 260 - 24 };
	try {
		const raw = JSON.parse(window.localStorage.getItem(FRAME_KEY) ?? "null") as Partial<Frame> | null;
		if (raw && [raw.x, raw.y, raw.w, raw.h].every((n) => typeof n === "number" && Number.isFinite(n))) return fitScratchpadFrame(raw as Frame, v);
	} catch {
		/* corrupt = default */
	}
	return fitScratchpadFrame(fallback, v);
}

function loadCached(): { text: string; dirty: boolean } | null {
	try {
		const raw = JSON.parse(window.localStorage.getItem(TEXT_KEY) ?? "null") as { text?: unknown; dirty?: unknown } | null;
		if (raw && typeof raw.text === "string") return { text: raw.text, dirty: raw.dirty === true };
	} catch {
		/* corrupt = nothing cached */
	}
	return null;
}

function cache(text: string, dirty: boolean): void {
	try {
		window.localStorage.setItem(TEXT_KEY, JSON.stringify({ text, dirty }));
	} catch {
		/* storage unavailable: the server copy still saves */
	}
}

export function Scratchpad({ open, onClose }: { open: boolean; onClose: () => void }) {
	const [mounted, setMounted] = useState(false);
	const [text, setText] = useState("");
	const [frame, setFrame] = useState<Frame | null>(null);
	const [saveError, setSaveError] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const areaRef = useRef<HTMLTextAreaElement>(null);
	const textRef = useRef("");
	const dirtyRef = useRef(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const openerRef = useRef<HTMLElement | null>(null);

	const save = useCallback((keepalive = false) => {
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = null;
		if (!dirtyRef.current) return;
		const sent = textRef.current;
		fetch("/api/scratchpad", {
			method: "PUT",
			cache: "no-store",
			keepalive,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: sent }),
		})
			.then((res) => {
				if (!res.ok) throw new Error(String(res.status));
				setSaveError(false);
				// Typed on while it was in flight: the next save carries that.
				if (textRef.current !== sent) return;
				dirtyRef.current = false;
				cache(sent, false);
			})
			.catch(() => setSaveError(true));
	}, []);

	// App start: paint the cached copy, then take the server's — unless an
	// edit from last time never reached it (then ours goes up instead).
	useEffect(() => {
		setMounted(true);
		setFrame(loadFrame());
		const cached = loadCached();
		if (cached) {
			textRef.current = cached.text;
			dirtyRef.current = cached.dirty;
			setText(cached.text);
		}
		if (cached?.dirty) {
			save();
			return;
		}
		let cancelled = false;
		fetch("/api/scratchpad", { cache: "no-store" })
			.then((res) => (res.ok ? (res.json() as Promise<{ text?: string }>) : null))
			.then((data) => {
				if (cancelled || !data || typeof data.text !== "string" || dirtyRef.current) return;
				textRef.current = data.text;
				setText(data.text);
				cache(data.text, false);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [save]);

	// Leaving the page: send what is still waiting on the debounce.
	useEffect(() => {
		const flush = () => save(true);
		window.addEventListener("pagehide", flush);
		return () => window.removeEventListener("pagehide", flush);
	}, [save]);

	// A smaller window never strands the pad off-screen.
	useEffect(() => {
		const refit = () => setFrame((f) => (f ? fitScratchpadFrame(f, viewport()) : f));
		window.addEventListener("resize", refit);
		return () => window.removeEventListener("resize", refit);
	}, []);

	// Open: remember who had focus, take it. Hide: save, hand focus back.
	const wasOpenRef = useRef(false);
	useEffect(() => {
		if (!mounted || open === wasOpenRef.current) return;
		wasOpenRef.current = open;
		if (open) {
			const active = document.activeElement as HTMLElement | null;
			openerRef.current = active && active !== document.body && !panelRef.current?.contains(active) ? active : null;
			setFrame((f) => (f ? fitScratchpadFrame(f, viewport()) : f));
			areaRef.current?.focus({ preventScroll: true });
			return;
		}
		save();
		const opener = openerRef.current;
		openerRef.current = null;
		if (panelRef.current?.contains(document.activeElement) && opener?.isConnected) opener.focus({ preventScroll: true });
	}, [open, mounted, save]);

	const onChange = (value: string) => {
		textRef.current = value;
		dirtyRef.current = true;
		setText(value);
		cache(value, true);
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => save(), SAVE_DELAY_MS);
	};

	/** Drag (move) or corner-drag (resize): the panel follows the pointer
	 *  directly; React state catches up once on release. */
	const startGesture = (e: React.PointerEvent, kind: "move" | "resize") => {
		const panel = panelRef.current;
		if (!panel || !frame || e.button !== 0) return;
		e.preventDefault();
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		const from = { px: e.clientX, py: e.clientY, ...frame };
		let latest = frame;
		const onMove = (ev: PointerEvent) => {
			const dx = ev.clientX - from.px;
			const dy = ev.clientY - from.py;
			latest = fitScratchpadFrame(kind === "move" ? { ...from, x: from.x + dx, y: from.y + dy } : { ...from, w: from.w + dx, h: from.h + dy }, viewport());
			Object.assign(panel.style, { left: `${latest.x}px`, top: `${latest.y}px`, width: `${latest.w}px`, height: `${latest.h}px` });
		};
		const onUp = () => {
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
			handle.removeEventListener("pointercancel", onUp);
			setFrame(latest);
			try {
				window.localStorage.setItem(FRAME_KEY, JSON.stringify(latest));
			} catch {
				/* the frame just won't persist */
			}
			if (kind === "move") areaRef.current?.focus({ preventScroll: true });
		};
		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
		handle.addEventListener("pointercancel", onUp);
	};

	if (!mounted || !frame) return null;
	const toggleKeys = formatBinding(bindingForAction("toggle-scratchpad"));

	return createPortal(
		<div
			ref={panelRef}
			role="complementary"
			aria-label="Scratchpad"
			aria-hidden={!open}
			data-scratchpad
			data-testid="scratchpad"
			className="fixed z-[90] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
			style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h, display: open ? "flex" : "none" }}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !e.nativeEvent.isComposing) {
					e.preventDefault();
					e.stopPropagation();
					onClose();
				}
			}}
		>
			<div
				data-testid="scratchpad-bar"
				onPointerDown={(e) => startGesture(e, "move")}
				className="flex cursor-move touch-none select-none items-center gap-2 border-b border-border/60 px-2.5 py-1 text-[11px] uppercase tracking-wider text-muted-foreground"
			>
				<span>Scratchpad</span>
				<span className="flex-1" />
				{saveError && <span className="normal-case tracking-normal text-destructive">not saved</span>}
				<span className="normal-case tracking-normal text-muted-foreground/60">{toggleKeys}</span>
				<button
					type="button"
					aria-label="Hide scratchpad"
					title={`Hide (${toggleKeys} or Esc)`}
					onPointerDown={(e) => e.stopPropagation()}
					onClick={onClose}
					className="rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-3" />
				</button>
			</div>
			<textarea
				ref={areaRef}
				aria-label="Scratchpad text"
				data-testid="scratchpad-text"
				value={text}
				spellCheck={false}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					// Tab types a tab here instead of cycling the page's fields.
					if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
					e.preventDefault();
					e.stopPropagation();
					const el = e.currentTarget;
					if (!document.execCommand("insertText", false, "\t")) el.setRangeText("\t", el.selectionStart, el.selectionEnd, "end");
					onChange(el.value);
				}}
				className="min-h-0 w-full flex-1 resize-none bg-transparent px-2.5 py-2 font-mono text-[13px] leading-relaxed text-foreground outline-none"
			/>
			<div
				aria-hidden="true"
				data-testid="scratchpad-resize"
				onPointerDown={(e) => startGesture(e, "resize")}
				className="absolute bottom-0 right-0 size-4 cursor-nwse-resize touch-none"
				style={{ background: "linear-gradient(135deg, transparent 50%, var(--border) 50%, var(--border) 60%, transparent 60%, transparent 72%, var(--border) 72%, var(--border) 82%, transparent 82%)" }}
			/>
		</div>,
		document.body,
	);
}
