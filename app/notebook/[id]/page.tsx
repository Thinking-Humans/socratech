import { notFound } from "next/navigation";
import { JournalPage } from "@/components/journal/journal-page";
import { stores } from "@/src/server";

export const dynamic = "force-dynamic";

/** A notebook, full page (journals are notebooks, owner 2026-11-15). A session's notebook redirects
 *  nowhere — it is reachable here too, though the sidebar opens it on the
 *  session's Journal tab. */
export default async function JournalRoute({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const journal = stores.journalStore.getJournal(id);
	if (!journal) notFound();
	return <JournalPage journalId={journal.id} />;
}
