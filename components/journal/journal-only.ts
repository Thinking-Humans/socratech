/**
 * JOURNAL-ONLY (owner, 2026-11-15): the journal is the only thing in the
 * app — the sidebar shows just Journals (+ Settings) and home opens the
 * newest journal. Notes, session doors, the session list and background
 * agents are hidden, not deleted; flip this to bring them back.
 */
export const JOURNAL_ONLY = true;

/** The empty graph's hint: in the notebook app, ideas come from notebooks. */
export const GRAPH_EMPTY_HINT = JOURNAL_ONLY
	? "Start a notebook below, or read one in with Add to graph."
	: "Start a session to begin learning.";
