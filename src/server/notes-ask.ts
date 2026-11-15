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
	return strongTextStream(ASK_SYSTEM_PROMPT, askPrompt(ctx), "note-ask", signal);
}

/**
 * One streamed strong-slot answer (shared by note `/ask` and journal cell
 * `/ask`). `onEnd` gets the full text once the stream ends — unless the
 * caller aborted or the model failed.
 */
export function strongTextStream(
	systemPrompt: string,
	prompt: string,
	sessionPrefix: string,
	signal?: AbortSignal,
	onEnd?: (text: string) => void,
): ReadableStream<Uint8Array> {
	const spec = resolveRoleSpec("teacher", stores.settingsStore.readSettings());
	if (!spec) throw new NoteError("No strong model set — pick one in Settings → Models.", "invalid");
	const engine = piEngineForSpec(spec, false);
	const enc = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			let text = "";
			let failed = false;
			// A reader that went away (tab closed) must not lose the answer:
			// keep reading the model, just stop pushing.
			let open = true;
			const push = (chunk: string) => {
				if (!open) return;
				try {
					controller.enqueue(enc.encode(chunk));
				} catch {
					open = false;
				}
			};
			try {
				const stream = engine.streamFn(
					engine.model,
					normalizeContext({ systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }], tools: [] }),
					{ sessionId: `${sessionPrefix}-${Date.now()}`, reasoning: engine.level && engine.level !== "off" ? engine.level : undefined, signal } as never,
				);
				for await (const event of stream) {
					if (event.type === "text_delta") {
						text += event.delta;
						push(event.delta);
					} else if (event.type === "error") {
						failed = true;
						if (event.reason !== "aborted") push(`\n\n*(failed: ${event.error.errorMessage ?? "model error"})*`);
						break;
					} else if (event.type === "done") break;
				}
			} catch (err) {
				failed = true;
				push(`\n\n*(failed: ${err instanceof Error ? err.message : String(err)})*`);
			} finally {
				if (!failed && !signal?.aborted && text.trim()) {
					try {
						onEnd?.(text);
					} catch (err) {
						console.error("[ask] onEnd failed:", err);
					}
				}
				if (open) {
					try {
						controller.close();
					} catch {
						// already cancelled by the reader
					}
				}
			}
		},
		cancel() {
			// Reader gone; the model loop keeps going so onEnd still lands.
		},
	});
}
