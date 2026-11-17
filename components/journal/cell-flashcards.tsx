"use client";

/**
 * CELL FLASHCARDS (F on a cell, owner 2026-11-17): the agent drafts recall
 * cards from one cell; the learner edits, removes or adds cards, picks the
 * deck they go into (or names a new one) and saves. The cards are stored by
 * the Flashcards core plugin through its own operations — scheduling, review
 * and the library all stay there. Nothing is written until Save.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LayersIcon, LoaderCircleIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import type { FlashcardDraft } from "@/src/core";
import { HostDialog } from "@/components/host-dialog";
import { journalApi } from "@/components/journal/journal-api";

const PLUGIN_ID = "flashcards";
const LAST_DECK_KEY = "lh:flashcards-last-deck";
const NEW_DECK = "__new__";

interface Deck {
	id: string;
	name: string;
}

/** A card being edited; `requestId` makes a retried save create it once. */
interface Card extends FlashcardDraft {
	requestId: string;
	saved?: boolean;
}

const newCard = (draft: FlashcardDraft = { name: "", question: "", answer: "" }): Card => ({ ...draft, requestId: crypto.randomUUID() });

/** One operation of the Flashcards plugin's backend. */
async function flashcards<T>(operation: string, input: unknown = {}): Promise<T> {
	const res = await fetch(`/api/plugins/${PLUGIN_ID}/call`, {
		method: "POST",
		cache: "no-store",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operation, input }),
	});
	const data = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
	if (!res.ok) throw new Error(data.error ?? `Flashcards request failed (${res.status})`);
	return data.result as T;
}

async function pluginEnabled(): Promise<boolean> {
	const res = await fetch("/api/plugins", { cache: "no-store" });
	const data = (await res.json().catch(() => ({}))) as { plugins?: Array<{ id: string; enabled?: boolean }> };
	return data.plugins?.some((p) => p.id === PLUGIN_ID && p.enabled === true) ?? false;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function CellFlashcards({
	journalId,
	cellId,
	onClose,
	onSaved,
}: {
	journalId: string;
	/** The cell to draft from; null = closed. */
	cellId: string | null;
	onClose: () => void;
	onSaved: (message: string) => void;
}) {
	const headingId = useId();
	const headingRef = useRef<HTMLSpanElement>(null);
	/** null = still checking; false = the plugin is turned off. */
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [decks, setDecks] = useState<Deck[]>([]);
	const [deckId, setDeckId] = useState(NEW_DECK);
	const [deckName, setDeckName] = useState("");
	const [cards, setCards] = useState<Card[]>([]);
	const [drafting, setDrafting] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** Bumps per open / redraft so a late reply never lands in a newer dialog. */
	const runRef = useRef(0);

	const draft = useCallback(async () => {
		if (!cellId) return;
		const run = ++runRef.current;
		setDrafting(true);
		setError(null);
		try {
			const drafts = await journalApi.draftFlashcards(journalId, cellId);
			if (run === runRef.current) setCards(drafts.map((d) => newCard(d)));
		} catch (err) {
			if (run === runRef.current) setError(errorText(err));
		} finally {
			if (run === runRef.current) setDrafting(false);
		}
	}, [journalId, cellId]);

	// Each open: is the plugin on, which decks exist, and a fresh draft.
	useEffect(() => {
		if (!cellId) return;
		setEnabled(null);
		setCards([]);
		setError(null);
		setSaving(false);
		setDeckName("");
		let cancelled = false;
		void (async () => {
			try {
				const on = await pluginEnabled();
				if (cancelled) return;
				setEnabled(on);
				if (!on) return;
				const state = await flashcards<{ decks: Deck[] }>("get-state");
				if (cancelled) return;
				setDecks(state.decks);
				let last: string | null = null;
				try {
					last = window.localStorage.getItem(LAST_DECK_KEY);
				} catch {
					/* no remembered deck */
				}
				setDeckId(state.decks.some((d) => d.id === last) ? last! : (state.decks[0]?.id ?? NEW_DECK));
				void draft();
			} catch (err) {
				if (!cancelled) setError(errorText(err));
			}
		})();
		return () => {
			cancelled = true;
			runRef.current++;
		};
	}, [cellId, draft]);

	const patch = (i: number, fields: Partial<FlashcardDraft>) => setCards((list) => list.map((c, at) => (at === i ? { ...c, ...fields } : c)));

	const complete = cards.filter((c) => c.name.trim() && c.question.trim() && c.answer.trim());
	const canSave = !saving && !drafting && cards.length > 0 && complete.length === cards.length && (deckId !== NEW_DECK || deckName.trim() !== "");

	const save = async () => {
		if (!canSave) return;
		setSaving(true);
		setError(null);
		try {
			let target = decks.find((d) => d.id === deckId);
			if (!target) {
				const known = new Set(decks.map((d) => d.id));
				const state = await flashcards<{ decks: Deck[] }>("create-deck", { name: deckName.trim() });
				target = state.decks.find((d) => !known.has(d.id));
				if (!target) throw new Error("The new deck was not created.");
				// A retry after a failed card must reuse this deck, not make another.
				setDecks(state.decks);
				setDeckId(target.id);
			}
			for (const card of cards) {
				if (card.saved) continue;
				await flashcards("create-card", { deckId: target.id, name: card.name.trim(), question: card.question.trim(), answer: card.answer.trim(), requestId: card.requestId });
				setCards((list) => list.map((c) => (c.requestId === card.requestId ? { ...c, saved: true } : c)));
			}
			try {
				window.localStorage.setItem(LAST_DECK_KEY, target.id);
			} catch {
				/* the choice just isn't remembered */
			}
			onSaved(`${cards.length} flashcard${cards.length === 1 ? "" : "s"} saved to “${target.name}”.`);
			onClose();
		} catch (err) {
			setError(errorText(err));
		} finally {
			setSaving(false);
		}
	};

	const field = "lh-input w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none";

	return (
		<HostDialog
			open={cellId !== null}
			onClose={() => {
				onClose();
				return "closed";
			}}
			aria-labelledby={headingId}
			headingRef={headingRef}
			backdropProps={{ "data-testid": "cell-flashcards", className: "fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[8vh]" }}
			frame={<div className="flex max-h-[84vh] w-full max-w-[40rem] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()} />}
		>
			<div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
				<LayersIcon className="size-4 text-primary" />
				<span id={headingId} ref={headingRef} role="heading" aria-level={2} className="flex-1 text-sm font-medium text-card-foreground outline-none">
					Flashcards from this cell
				</span>
				<span className="text-[11px] text-muted-foreground/70">Esc</span>
			</div>

			{enabled === false ? (
				<p className="px-4 py-6 text-sm text-muted-foreground" data-testid="cell-flashcards-disabled">
					The Flashcards plugin is turned off. Turn it on in <strong>Settings → Core plugins</strong>, then press F on the cell again.
				</p>
			) : (
				<>
					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
						{(enabled === null || drafting) && (
							<p className="flex items-center gap-2 text-xs text-muted-foreground">
								<LoaderCircleIcon className="size-3.5 animate-spin" />
								{enabled === null ? "Opening Flashcards…" : "The agent is drafting cards from the cell…"}
							</p>
						)}
						{cards.map((card, i) => (
							<div key={card.requestId} className="flex flex-col gap-1.5 rounded-lg border border-border/70 p-2.5" data-testid="cell-flashcard">
								<div className="flex items-center gap-2">
									<input
										aria-label={`Card ${i + 1} name`}
										value={card.name}
										disabled={card.saved}
										onChange={(e) => patch(i, { name: e.target.value })}
										placeholder="Name of the fact"
										className={`${field} flex-1 font-medium`}
									/>
									{card.saved ? (
										<span className="text-[11px] uppercase tracking-wider text-success">saved</span>
									) : (
										<button
											type="button"
											aria-label={`Remove card ${i + 1}`}
											title="Remove card"
											onClick={() => setCards((list) => list.filter((_, at) => at !== i))}
											className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
										>
											<Trash2Icon className="size-3.5" />
										</button>
									)}
								</div>
								<textarea
									aria-label={`Card ${i + 1} question`}
									value={card.question}
									disabled={card.saved}
									onChange={(e) => patch(i, { question: e.target.value })}
									placeholder="Question (Markdown)"
									className={`${field} field-sizing-content min-h-9 resize-none`}
								/>
								<textarea
									aria-label={`Card ${i + 1} answer`}
									value={card.answer}
									disabled={card.saved}
									onChange={(e) => patch(i, { answer: e.target.value })}
									placeholder="Answer (Markdown)"
									className={`${field} field-sizing-content min-h-9 resize-none`}
								/>
							</div>
						))}
						{enabled && !drafting && (
							<div className="flex gap-1.5">
								<button
									type="button"
									data-testid="cell-flashcards-add"
									onClick={() => setCards((list) => [...list, newCard()])}
									className="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								>
									<PlusIcon className="size-3" />
									Add card
								</button>
								<button
									type="button"
									data-testid="cell-flashcards-redraft"
									disabled={saving || cards.some((c) => c.saved)}
									onClick={() => void draft()}
									title="Ask the agent again (replaces these cards)"
									className="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
								>
									<RotateCcwIcon className="size-3" />
									Redraft
								</button>
							</div>
						)}
						{error && (
							<p className="text-xs text-destructive" role="alert">
								{error}
							</p>
						)}
					</div>
					<div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
						<label htmlFor={`${headingId}-deck`}>Deck</label>
						<select
							id={`${headingId}-deck`}
							data-testid="cell-flashcards-deck"
							value={deckId}
							disabled={saving || cards.some((c) => c.saved)}
							onChange={(e) => setDeckId(e.target.value)}
							className="max-w-48 rounded-md border border-border bg-background px-1.5 py-1 text-sm text-foreground"
						>
							{decks.map((d) => (
								<option key={d.id} value={d.id}>
									{d.name}
								</option>
							))}
							<option value={NEW_DECK}>New deck…</option>
						</select>
						{deckId === NEW_DECK && (
							<input
								aria-label="New deck name"
								data-testid="cell-flashcards-deck-name"
								value={deckName}
								onChange={(e) => setDeckName(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && void save()}
								placeholder="Deck name"
								className={`${field} w-44`}
							/>
						)}
						<span className="flex-1" />
						<button
							type="button"
							data-testid="cell-flashcards-save"
							disabled={!canSave}
							onClick={() => void save()}
							className="flex items-center gap-1.5 rounded-md border border-primary/60 px-3 py-1 text-xs uppercase tracking-wider text-primary transition-colors hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-40"
						>
							{saving && <LoaderCircleIcon className="size-3 animate-spin" />}
							Save {cards.length || ""} card{cards.length === 1 ? "" : "s"}
						</button>
					</div>
				</>
			)}
		</HostDialog>
	);
}
