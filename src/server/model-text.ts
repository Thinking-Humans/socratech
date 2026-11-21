/**
 * One-shot streamed model answers for notebook features (cell /ask, agent
 * cells, inline ask, flashcard drafts, prerequisites, web clips): the strong
 * slot, or the cheap slot at low thinking for latency-first calls. Returns a
 * ReadableStream of raw answer text deltas.
 */

import { normalizeContext } from "@earendil-works/pi-ai";
import { piEngineForSpec, type ResolvedModelSpec } from "../agent/models.ts";
import { resolveRoleSpec, resolveSlot } from "../core/settings-resolution.ts";
import { stores } from "./stores.ts";

/** No usable model configured (routes answer 400). */
export class ModelTextError extends Error {
	constructor(
		message: string,
		readonly code: "invalid" = "invalid",
	) {
		super(message);
		this.name = "ModelTextError";
	}
}

/**
 * One streamed strong-slot answer (journal cell `/ask` and the rest).
 * `onEnd` gets the full text once the stream ends — unless the
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
	if (!spec) throw new ModelTextError("No strong model set — pick one in Settings → Models.", "invalid");
	return specTextStream(spec, systemPrompt, prompt, sessionPrefix, signal, onEnd);
}

/**
 * Latency-sensitive answers (notebook inline ask): CHEAP slot at low
 * thinking. Falls back to the strong slot when no cheap model is set.
 */
export function quickTextStream(
	systemPrompt: string,
	prompt: string,
	sessionPrefix: string,
	signal?: AbortSignal,
): ReadableStream<Uint8Array> {
	const settings = stores.settingsStore.readSettings();
	const spec = resolveSlot(settings?.models?.cheap) ?? resolveRoleSpec("teacher", settings);
	if (!spec) throw new ModelTextError("No model set — pick one in Settings → Models.", "invalid");
	return specTextStream({ provider: spec.provider, id: spec.id, thinkingLevel: "low" }, systemPrompt, prompt, sessionPrefix, signal);
}

function specTextStream(
	spec: ResolvedModelSpec,
	systemPrompt: string,
	prompt: string,
	sessionPrefix: string,
	signal?: AbortSignal,
	onEnd?: (text: string) => void,
): ReadableStream<Uint8Array> {
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
