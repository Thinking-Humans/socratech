/**
 * Brain store (docs/brain-store.md): Obsidian parsing, incremental
 * re-index, hybrid search + link hop, `.brain.jsonl` round trip, mem0 /
 * supermemory import, consolidation ops — and the service end to end with
 * a stub embedder (no model download, no network).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-brain-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const core = await import("../src/core/index.ts");
const server = await import("../src/server/index.ts");
const { parseNote, noteRecords, planReindex, buildBm25, hybridSearch, encodeBundle, decodeBundle, importForeignMemories, parseFacts, parseMemoryOps, applyMemoryOps, memoryUpdateInput, newMemory, brainHash, vectorToB64, b64ToVector } = core;

/** Bag-of-words hashed into 64 dims: similar words → similar vectors. */
const stub = {
	model: "stub-bow",
	dims: 64,
	calls: 0,
	async embed(texts: readonly string[]) {
		this.calls += texts.length;
		return texts.map((t) => {
			const v = new Float32Array(64);
			for (const w of core.tokenize(t)) v[parseInt(brainHash(w).slice(0, 4), 16) % 64]! += 1;
			return v;
		});
	},
};

const NOTE = `---
tags: [calculus, "math/analysis"]
aliases:
  - CR
---
# Chain rule
Intro line with #derivatives and a link to [[Functions#Composition|composition]].

<!-- journey:teach:abc -->
## Statement
(f∘g)' = f'(g)·g'. See [[Leibniz notation]].

\`\`\`python
# not a heading
print(1)
\`\`\`

## Empty

## Examples
d/dx sin(x²) = 2x cos(x²)
`;

describe("parseNote", () => {
	it("splits by heading, reads frontmatter, links and tags, ignores fenced #", () => {
		const n = parseNote("math/Chain rule.md", NOTE);
		assert.equal(n.title, "Chain rule");
		assert.deepEqual(n.aliases, ["CR"]);
		assert.ok(n.tags.includes("calculus") && n.tags.includes("math/analysis") && n.tags.includes("derivatives"));
		assert.deepEqual(n.links.sort(), ["functions", "leibniz notation"]);
		assert.deepEqual(
			n.chunks.map((c) => c.heading),
			["Chain rule", "Chain rule > Statement", "Chain rule > Examples"],
		);
		assert.match(n.chunks[1]!.text, /# not a heading/);
		assert.ok(!n.chunks.some((c) => c.text.includes("journey:")));
	});

	it("splits long sections under the cap", () => {
		const long = `## Big\n${Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"word ".repeat(30)}`).join("\n\n")}`;
		const chunks = parseNote("Big.md", long).chunks;
		assert.ok(chunks.length > 1);
		assert.ok(chunks.every((c) => c.text.length <= core.CHUNK_MAX_CHARS + 20));
	});
});

describe("planReindex", () => {
	it("keeps unchanged chunks, adds changed, drops vanished", () => {
		const now = "2026-11-15T00:00:00Z";
		const v1 = new Map([["a.md", noteRecords("a.md", "# A\none\n## B\ntwo", now)], ["gone.md", noteRecords("gone.md", "# G\nx", now)]]);
		const existing = [...v1.values()].flat();
		const v2 = new Map([["a.md", noteRecords("a.md", "# A\none\n## B\ntwo changed", now)]]);
		const plan = planReindex(existing, v2);
		assert.equal(plan.keep.size, 1);
		assert.equal(plan.add.length, 1);
		assert.equal(plan.drop.size, 2);
	});
});

describe("hybrid search", () => {
	it("fuses BM25 + vectors and hops one wikilink", async () => {
		const now = "t";
		const records = [
			...noteRecords("Chain rule.md", "# Chain rule\nDerivative of a composition: see [[Functions]].", now),
			...noteRecords("Functions.md", "# Functions\nA mapping from a domain to a codomain.", now),
			...noteRecords("Cooking.md", "# Cooking\nPasta needs salted water.", now),
		];
		const vecs = (await stub.embed(records.map((r) => r.text))).map(core.normalizeVector);
		const vectors = new Float32Array(records.length * 64);
		vecs.forEach((v, i) => vectors.set(v, i * 64));
		const snap = { embedding: { model: "stub", dims: 64 }, records, vectors, watermarks: {}, vaults: {} };
		const q = core.normalizeVector((await stub.embed(["derivative composition"]))[0]!);
		const hits = hybridSearch(snap, buildBm25(records.map((r) => r.text)), "derivative composition", q, { k: 1 });
		assert.equal(hits[0]!.record.source.ref, "Chain rule.md");
		const linked = hits.find((h) => h.via === "link");
		assert.equal(linked?.record.source.ref, "Functions.md");
		assert.ok(!hits.some((h) => h.record.source.ref === "Cooking.md"));
	});
});

describe(".brain.jsonl bundle", () => {
	it("round-trips records and vectors", () => {
		const r = newMemory("The learner confuses dy/dx with Δy/Δx.", { kind: "session", ref: "c1" }, "t");
		const v = core.normalizeVector(new Float32Array([1, 2, 3, 4]));
		const text = encodeBundle({ embedding: { model: "m", dims: 4 }, records: [r], vectors: v, watermarks: {}, vaults: { notes: "/secret/path" } });
		assert.ok(!text.includes("/secret/path"), "vault dirs never exported");
		const back = decodeBundle(text);
		assert.equal(back.manifest.format, "brain/1");
		assert.deepEqual(back.records[0], r);
		assert.deepEqual([...back.vectors[0]!], [...v]);
		assert.deepEqual([...b64ToVector(vectorToB64(new Float32Array([0.5, -1, 3.25])))], [0.5, -1, 3.25]);
		assert.throws(() => decodeBundle('{"format":"other"}'));
	});

	it("exports memories only when chunks are excluded", () => {
		const recs = [...noteRecords("a.md", "# A\nx", "t"), newMemory("m", { kind: "import", ref: "f" }, "t")];
		const text = encodeBundle({ embedding: null, records: recs, vectors: new Float32Array(0), watermarks: {}, vaults: {} }, { chunks: false });
		assert.equal(decodeBundle(text).records.length, 1);
	});
});

describe("foreign memory import", () => {
	it("maps mem0, supermemory and JSONL shapes, dedupes", () => {
		const mem0 = JSON.stringify({ results: [{ id: "1", memory: "Likes visual proofs", categories: ["preferences"], created_at: "2026-01-01" }, { id: "2", memory: "Likes visual proofs" }] });
		const a = importForeignMemories(mem0, "mem0.json", "now");
		assert.equal(a.length, 1);
		assert.deepEqual(a[0]!.tags, ["preferences"]);
		assert.equal(a[0]!.created, "2026-01-01");
		const sm = importForeignMemories(JSON.stringify([{ content: "Studies Bayesian stats", metadata: { tags: ["stats"] } }]), "sm.json", "now");
		assert.equal(sm[0]!.text, "Studies Bayesian stats");
		assert.equal(importForeignMemories('{"text":"a"}\n{"text":"b"}', "x.jsonl", "now").length, 2);
	});
});

describe("consolidation ops", () => {
	it("parses facts and ops tolerant of prose, maps positional ids", () => {
		assert.deepEqual(parseFacts('Sure!\n```json\n{"facts": ["A", " ", "B"]}\n```'), ["A", "B"]);
		const old = [newMemory("x", { kind: "session", ref: "c" }, "t"), newMemory("y", { kind: "session", ref: "c" }, "t")];
		const { ids, prompt } = memoryUpdateInput(old, ["z"]);
		assert.match(prompt, /"id": "1"/);
		const ops = parseMemoryOps('{"memory":[{"op":"ADD","text":"z"},{"op":"UPDATE","id":"0","text":"x2"},{"op":"DELETE","id":"1"},{"op":"DELETE","id":"9"},{"event":"NONE"}]}', ids);
		assert.deepEqual(
			ops.map((o) => o.op),
			["ADD", "UPDATE", "DELETE", "NONE"],
		);
		const applied = applyMemoryOps(ops, new Map(old.map((r) => [r.id, r])), { kind: "session", ref: "c2" }, "t2");
		assert.equal(applied.upserts.length, 2);
		assert.equal(applied.upserts[1]!.id, old[0]!.id);
		assert.equal(applied.upserts[1]!.text, "x2");
		assert.ok(applied.deletes.has(old[1]!.id));
	});
});

describe("brain service (stub embedder)", () => {
	server.setBrainEmbedder(stub);
	const vault = path.join(TMP, "MyVault");
	fs.mkdirSync(path.join(vault, "sub"), { recursive: true });
	fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
	fs.writeFileSync(path.join(vault, "Chain rule.md"), NOTE);
	fs.writeFileSync(path.join(vault, "sub", "Functions.md"), "# Functions\nA mapping. Used by [[Chain rule]].");
	fs.writeFileSync(path.join(vault, ".obsidian", "ignored.md"), "# hidden\nnope");

	it("indexes a vault, re-indexes incrementally, searches", async () => {
		const first = await server.indexVault(vault);
		assert.equal(first.vault, "MyVault");
		assert.equal(first.added, 4);
		const calls = stub.calls;
		const again = await server.indexVault(vault);
		assert.equal(again.added, 0);
		assert.equal(stub.calls, calls, "unchanged notes never re-embed");
		fs.appendFileSync(path.join(vault, "sub", "Functions.md"), "\nInjective means one-to-one.");
		const third = await server.indexVault(vault);
		assert.equal(third.added, 1);
		assert.equal(third.dropped, 1);
		const st = server.brainStatus();
		assert.equal(st.chunks, 4);
		assert.equal(st.notes, 2);
		assert.deepEqual(st.vaults.map((v) => v.name), ["MyVault"]);
		const hits = await server.searchBrain("injective one-to-one");
		assert.equal(hits[0]!.record.source.ref, "sub/Functions.md");
		await assert.rejects(server.indexVault(path.join(TMP, "nope")), /Not a folder/);
	});

	it("persists across a reload of the store", () => {
		const snap = server.stores.brainStore.load();
		assert.equal(snap.records.length, 4);
		assert.equal(snap.vectors.length, 4 * 64);
	});

	it("imports mem0 JSON and brain bundles, skips duplicates, exports", async () => {
		const r1 = await server.importBrain(JSON.stringify([{ memory: "The learner prefers worked examples" }]), "mem0.json");
		assert.deepEqual(r1, { added: 1, skipped: 0, format: "foreign" });
		const bundle = server.exportBrain();
		const r2 = await server.importBrain(bundle, "self.brain.jsonl");
		assert.equal(r2.added, 0);
		assert.equal(r2.format, "brain/1");
		assert.equal(server.listMemories().length, 1);
		await assert.rejects(server.importBrain("[]", "empty.json"), /Nothing importable/);
		const mem = server.listMemories()[0]!;
		await server.deleteMemory(mem.id);
		assert.equal(server.listMemories().length, 0);
	});

	it("removes a vault's chunks but keeps memories", async () => {
		await server.importBrain(JSON.stringify([{ memory: "Keeps me" }]), "m.json");
		await server.removeVault("MyVault");
		const st = server.brainStatus();
		assert.equal(st.chunks, 0);
		assert.equal(st.memories, 1);
	});

	it("brain routes: status, search, bad index folder", async () => {
		const status = await import("../app/api/brain/route.ts");
		const res = await status.GET();
		assert.equal(res.status, 200);
		const bad = await status.POST(new Request("http://x/api/brain", { method: "POST", body: JSON.stringify({ action: "index", dir: path.join(TMP, "missing") }) }));
		assert.equal(bad.status, 400);
		const search = await import("../app/api/brain/search/route.ts");
		const s = await search.GET(new Request("http://x/api/brain/search?q=keeps"));
		assert.equal(((await s.json()) as { hits: unknown[] }).hits.length, 1);
	});
});
