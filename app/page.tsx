import { redirect } from "next/navigation";
import { JournalHome } from "@/components/journal/journal-home";
import { stores } from "@/src/server";

// Home opens the most recently touched notebook (notes removed, owner
// 2026-11-21 — notebooks replace them). The graph home lives at /graph.
export const dynamic = "force-dynamic";

export default async function HomePage() {
	const newest = stores.journalStore.listJournals()[0];
	if (newest) redirect(`/notebook/${newest.id}`);
	return <JournalHome />;
}
