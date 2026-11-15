import { redirect } from "next/navigation";
import { JournalHome } from "@/components/journal/journal-home";
import { JOURNAL_ONLY } from "@/components/journal/journal-only";
import { NotesPage } from "@/components/notes/notes-page";
import { ensureDailyNote, stores } from "@/src/server";

// Journal-only (2026-11-15, components/journal/journal-only.ts): home opens
// the most recently touched journal. Otherwise notes first (docs/notes-first.md
// N4): home is today's daily note. The graph home lives at /graph.
export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ journey?: string }> }) {
	if (JOURNAL_ONLY) {
		const newest = stores.journalStore.listJournals()[0];
		if (newest) redirect(`/notebook/${newest.id}`);
		return <JournalHome />;
	}
	const { journey } = await searchParams;
	const note = ensureDailyNote();
	return <NotesPage key={note.path} note={note} journeyId={journey} />;
}
