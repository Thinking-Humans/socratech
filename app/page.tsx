import { NotesPage } from "@/components/notes/notes-page";
import { ensureDailyNote } from "@/src/server";

// Notes first (docs/notes-first.md N4): home is today's daily note. The
// graph home lives at /graph.
export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ journey?: string }> }) {
	const { journey } = await searchParams;
	const note = ensureDailyNote();
	return <NotesPage key={note.path} note={note} journeyId={journey} />;
}
