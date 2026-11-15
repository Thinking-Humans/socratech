/**
 * Inline `/ask` (docs/notes-first.md N3): one streamed model call on the
 * STRONG slot (the teacher role's resolution), context = the ask's `## `
 * section. Returns a ReadableStream of raw answer text deltas; the editor
 * renders them into the callout.
 */

import { normalizeContext } from "@earendil-works/pi-ai";
import { piEngineForSpec } from "../agent/models.ts";
import { ASK_SYSTEM_PROMPT, askPrompt, type AskContext } from "../core/notes.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { NoteError } from "./notes.ts";
import { stores } from "./stores.ts";

export function askStream(ctx: AskContext, signal?: AbortSignal): ReadableStream<Uint8Array> {
	const spec = resolveRoleSpec("teacher", stores.settingsStore.readSettings());
	if (!spec) throw new NoteError("No strong model set — pick one in Settings → Models.", "invalid");
	const engine = piEngineForSpec(spec, false);
	const enc = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				const stream = engine.streamFn(
					engine.model,
					normalizeContext({ systemPrompt: ASK_SYSTEM_PROMPT, messages: [{ role: "user", content: askPrompt(ctx), timestamp: Date.now() }], tools: [] }),
					{ sessionId: `note-ask-${Date.now()}`, reasoning: engine.level && engine.level !== "off" ? engine.level : undefined, signal } as never,
				);
				for await (const event of stream) {
					if (event.type === "text_delta") controller.enqueue(enc.encode(event.delta));
					else if (event.type === "error") {
						if (event.reason !== "aborted") controller.enqueue(enc.encode(`\n\n*(failed: ${event.error.errorMessage ?? "model error"})*`));
						break;
					} else if (event.type === "done") break;
				}
			} catch (err) {
				controller.enqueue(enc.encode(`\n\n*(failed: ${err instanceof Error ? err.message : String(err)})*`));
			} finally {
				controller.close();
			}
		},
	});
}
