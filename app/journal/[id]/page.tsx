import { redirect } from "next/navigation";

/** Journals are notebooks now (owner, 2026-11-15): old links keep working. */
export default async function JournalRedirect({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	redirect(`/notebook/${id}`);
}
