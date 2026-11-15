import { notFound } from "next/navigation";
import { NotesPage } from "@/components/notes/notes-page";
import { NoteError, dailyNotePath, ensureDailyNote, readNote } from "@/src/server";

export const dynamic = "force-dynamic";

/** /notes/<vault-relative path> — any note; a missing daily note is created. */
export default async function NotePage({
	params,
	searchParams,
}: {
	params: Promise<{ path: string[] }>;
	searchParams: Promise<{ journey?: string }>;
}) {
	const [{ path }, { journey }] = await Promise.all([params, searchParams]);
	const rel = path.map(decodeURIComponent).join("/");
	let note;
	try {
		const daily = rel.match(/^daily\/(\d{4}-\d{2}-\d{2})\.md$/);
		note = daily && rel === dailyNotePath(daily[1]) ? ensureDailyNote(daily[1]) : readNote(rel);
	} catch (err) {
		if (err instanceof NoteError) notFound();
		throw err;
	}
	if (!note) notFound();
	return <NotesPage key={note.path} note={note} journeyId={journey} />;
}
