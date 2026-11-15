/**
 * BrainStore — fs adapter for the second-brain index (docs/brain-store.md).
 * data/brain/records.json names its vectors file (`vectors.<gen>.f32`,
 * row i ↔ records[i]); a save writes the new vectors file first, then
 * swaps records.json by rename, then drops the old vectors file — a torn
 * save leaves the previous generation intact.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { BrainStore } from "../core/ports.ts";
import type { BrainEmbeddingInfo, BrainRecord, BrainSnapshot } from "../core/contracts/brain.ts";

interface RecordsFile {
	version: 1;
	embedding: BrainEmbeddingInfo | null;
	vectorsFile: string | null;
	records: BrainRecord[];
	watermarks: Record<string, string | number>;
	vaults?: Record<string, string>;
}

const RECORDS = () => path.join(PATHS.brain, "records.json");

function empty(): BrainSnapshot {
	return { embedding: null, records: [], vectors: new Float32Array(0), watermarks: {}, vaults: {} };
}

export const brainStore: BrainStore = {
	load() {
		try {
			const file = JSON.parse(fs.readFileSync(RECORDS(), "utf-8")) as RecordsFile;
			let vectors = new Float32Array(0);
			if (file.vectorsFile && file.embedding) {
				const buf = fs.readFileSync(path.join(PATHS.brain, path.basename(file.vectorsFile)));
				vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
				if (vectors.length !== file.records.length * file.embedding.dims) throw new Error("brain vectors/records mismatch");
			}
			return { embedding: file.embedding, records: file.records, vectors, watermarks: file.watermarks ?? {}, vaults: file.vaults ?? {} };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[brain] load failed, starting empty:", err);
			return empty();
		}
	},
	save(snap) {
		fs.mkdirSync(PATHS.brain, { recursive: true });
		let previous: string | null = null;
		try {
			previous = (JSON.parse(fs.readFileSync(RECORDS(), "utf-8")) as RecordsFile).vectorsFile;
		} catch {
			// first save
		}
		const vectorsFile = snap.embedding && snap.vectors.length ? `vectors.${Date.now().toString(36)}.${process.pid}.f32` : null;
		if (vectorsFile) fs.writeFileSync(path.join(PATHS.brain, vectorsFile), Buffer.from(snap.vectors.buffer, snap.vectors.byteOffset, snap.vectors.byteLength));
		const file: RecordsFile = { version: 1, embedding: snap.embedding, vectorsFile, records: snap.records, watermarks: snap.watermarks, vaults: snap.vaults };
		const tmp = `${RECORDS()}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(file), "utf-8");
		fs.renameSync(tmp, RECORDS());
		if (previous && previous !== vectorsFile) fs.rmSync(path.join(PATHS.brain, path.basename(previous)), { force: true });
	},
};
