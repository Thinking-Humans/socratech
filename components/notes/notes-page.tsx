"use client";

/**
 * The notes surface (docs/notes-first.md): the note editor, and — once a
 * `## Topic` section starts a journey — that session in a right pane
 * (N5). The pane's session is in the URL (`?journey=<chatId>`), so a
 * reload or a shared link keeps it.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Chat } from "@/components/chat";
import { TopBar } from "@/components/top-bar";
import { stashOpeningPrompt } from "@/components/opening-prompt";
import { journeyPrompt, slotsConfigured, type LhMessage } from "@/src/core";
import { NoteEditor, type JourneySeed, type NoteFileView } from "./note-editor";

function shiftDay(date: string, by: number): string {
	const d = new Date(`${date}T12:00:00`);
	d.setDate(d.getDate() + by);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function noteHref(path: string): string {
	return `/notes/${path.split("/").map(encodeURIComponent).join("/")}`;
}

interface JourneyChat {
	id: string;
	title: string;
	kind?: "teach" | "practice" | "improvise";
	messages: LhMessage[];
	turnInFlight?: boolean;
	turnError?: string;
	compacting?: boolean;
}

function JourneyPane({ chatId, onClose }: { chatId: string; onClose: () => void }) {
	const [chat, setChat] = useState<JourneyChat | null>(null);
	const [configured, setConfigured] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		setChat(null);
		void Promise.all([
			fetch(`/api/chats/${encodeURIComponent(chatId)}`).then((r) => (r.ok ? (r.json() as Promise<JourneyChat>) : Promise.reject(new Error(`HTTP ${r.status}`)))),
			fetch("/api/settings").then((r) => (r.ok ? r.json() : null)).catch(() => null),
		])
			.then(([c, s]) => {
				if (!live) return;
				setChat(c);
				setConfigured(slotsConfigured((s as { settings?: { models?: never } } | null)?.settings?.models));
			})
			.catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
		return () => {
			live = false;
		};
	}, [chatId]);

	return (
		<div className="relative flex min-h-0 w-[min(48rem,48%)] shrink-0 flex-col border-l border-border" data-testid="journey-pane">
			<button
				type="button"
				aria-label="Close journey"
				title="Close journey"
				onClick={onClose}
				className="absolute right-2 top-3 z-20 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
			>
				<XIcon className="size-4" />
			</button>
			{error ? (
				<div className="p-6 text-sm text-muted-foreground">Couldn&apos;t open this journey ({error}).</div>
			) : chat ? (
				<Chat
					key={chat.id}
					embedded
					chatId={chat.id}
					title={chat.title}
					kind={chat.kind ?? "teach"}
					initialMessages={chat.messages}
					initialError={chat.turnError}
					initialConfigured={configured}
					initiallyInFlight={chat.turnInFlight}
					initiallyCompacting={chat.compacting}
				/>
			) : (
				<div className="p-6 text-sm text-muted-foreground">Opening journey…</div>
			)}
		</div>
	);
}

export function NotesPage({ note, journeyId }: { note: NoteFileView; journeyId?: string }) {
	const router = useRouter();
	const search = useSearchParams();
	const [journey, setJourney] = useState<string | undefined>(journeyId);
	const [starting, setStarting] = useState<string | null>(null);
	const daily = note.path.match(/^daily\/(\d{4}-\d{2}-\d{2})\.md$/)?.[1];

	const setJourneyUrl = useCallback(
		(id: string | undefined) => {
			setJourney(id);
			const params = new URLSearchParams(search.toString());
			if (id) params.set("journey", id);
			else params.delete("journey");
			const qs = params.toString();
			window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
		},
		[search],
	);

	const startJourney = useCallback(
		async (seed: JourneySeed): Promise<string | undefined> => {
			setStarting(`${seed.kind} · ${seed.topic}`);
			try {
				const res = await fetch("/api/chats", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ title: seed.topic, ...(seed.kind === "teach" ? {} : { kind: seed.kind }) }),
				});
				const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
				if (!res.ok || !body.id) throw new Error(body.error ?? `HTTP ${res.status}`);
				stashOpeningPrompt(body.id, journeyPrompt(seed.kind, seed.topic, seed.section));
				setJourneyUrl(body.id);
				return body.id;
			} catch (err) {
				alert(`Couldn't start the journey: ${err instanceof Error ? err.message : String(err)}`);
				return undefined;
			} finally {
				setStarting(null);
			}
		},
		[setJourneyUrl],
	);

	return (
		<div className="flex h-dvh min-w-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col">
				<TopBar>
					{daily ? (
						<div className="flex items-center gap-1">
							<button
								type="button"
								aria-label="Previous day"
								onClick={() => router.push(noteHref(`daily/${shiftDay(daily, -1)}.md`))}
								className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								<ChevronLeftIcon className="size-4" />
							</button>
							<span className="font-title text-xl tracking-tight">{daily}</span>
							<button
								type="button"
								aria-label="Next day"
								onClick={() => router.push(noteHref(`daily/${shiftDay(daily, 1)}.md`))}
								className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								<ChevronRightIcon className="size-4" />
							</button>
						</div>
					) : (
						<span className="font-title truncate text-xl tracking-tight">{note.path.replace(/\.md$/, "")}</span>
					)}
					<div className="min-w-4 flex-1" aria-hidden="true" />
					{starting && <span className="text-xs text-muted-foreground">starting journey: {starting}…</span>}
					<span className="hidden text-xs text-muted-foreground md:inline">/ask … then ⌘↵</span>
				</TopBar>
				<NoteEditor key={note.path} note={note} onJourney={startJourney} onResume={setJourneyUrl} className="min-h-0 flex-1" />
			</div>
			{journey && <JourneyPane chatId={journey} onClose={() => setJourneyUrl(undefined)} />}
		</div>
	);
}
