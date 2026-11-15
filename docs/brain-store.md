# Brain store — plan (owner, 2026-11-15)

A local, queryable second brain: Obsidian vaults (and this app's notes) are
indexed into one store of note **chunks** + mem0-shaped **memories**, each
with an embedding row. Querying needs no agent; an agent only *updates*
memories (consolidation). A portable bundle format lets brains move between
apps.

## Decisions (owner, 2026-11-15)

| # | Decision |
|---|---|
| B1 | **Embeddings are local**: transformers.js + `Xenova/bge-small-en-v1.5` (q8, 384d). Model (~35 MB) downloads once into `data/brain/models/`; offline after. Notes never leave the machine for indexing. |
| B2 | **Store = pure-TS flat index** behind core ports (`BrainStore`, `Embedder`): `data/brain/records.json` + `vectors.<gen>.f32`, swapped atomically. Brute-force cosine + in-memory BM25; fine to ~100k chunks. SQLite/sqlite-vec later = a new adapter only. |
| B3 | v1 scope: **Obsidian vault import + incremental index**, **`.brain.jsonl` export/import**, **agent consolidation**. Retrieval into `/ask` + journeys is deliberately *not* wired yet (search API + settings search box only). |

## Shape

- **Chunks** (`c_<hash>`): one per heading section (long sections split at
  ~1500 chars on paragraph boundaries), prefixed with note title + heading
  path. Frontmatter `tags`/`aliases`, inline `#tags`, `[[wikilinks]]`
  (normalized to lowercase basenames, as Obsidian resolves them) kept.
  HTML comments (journey markers) dropped; `.obsidian/` and dot-dirs skipped.
  Ids are content-addressed per vault → re-index embeds only changed chunks.
- **Memories** (`m_<hash>`): free-standing facts — from imports or
  consolidation. Never touched by vault re-index.
- **Search**: BM25 + cosine fused by reciprocal rank, then one wikilink hop
  (notes the hits link to / are linked from join at half score, `via:"link"`).
- **Vaults**: name → absolute dir, machine-local. The app's notes vault is
  `notes` and re-indexes 15 s after a save once indexed.

## `.brain.jsonl` (format `brain/1`)

Line 1 = manifest `{format:"brain/1", exported, app, embedding:{model,dims}|null, count}`.
Every other line = a record `{id, type:"chunk"|"memory", text, source:{kind, ref, vault?, heading?}, links[], tags[], hash, created, updated}`,
optionally with `v` = base64 little-endian float32. A reader reuses `v` only
when its embedding model equals the manifest's; otherwise it re-embeds.
Absolute paths are never exported.

Import also accepts **mem0** (`memory`, `categories`, `created_at`) and
**supermemory** (`content`, `metadata.tags`) exports — array, `{results}`,
`{memories}`, `{documents}`, or JSONL — mapped to memories, deduped by text.

## Consolidation (mem0 loop)

1. Extract facts from new material (extractor slot) → `{"facts": [...]}`.
2. For each fact, find similar memories (hybrid search, memories only).
3. One reconcile call → `ADD` / `UPDATE id` / `DELETE id` / `NONE`
   (positional ids so the model can't invent record ids).
4. Apply + embed, record a watermark.

Triggers: a session **10 min after its last turn** (messages since the
watermark), a journal **2 min after its last edit** (skipped when its
rendered markdown hash is unchanged). Only runs once the brain has any
records. Manual: `POST /api/brain/consolidate {chatId|journalId}`.
Failures land in `BrainStatus.lastError`, never in a turn.

## API

| Route | |
|---|---|
| `GET /api/brain` | status |
| `POST /api/brain {action:"index", dir?}` | index a vault (202; poll status) |
| `POST /api/brain {action:"remove", vault}` | drop a vault's chunks |
| `GET /api/brain/search?q&k&types` | hybrid search, no model call |
| `GET /api/brain/export?chunks=0&vectors=0` | `.brain.jsonl` download |
| `POST /api/brain/import?name=` | body = bundle or mem0/supermemory JSON |
| `GET/DELETE /api/brain/memories` | list / delete memories |
| `POST /api/brain/consolidate` | run consolidation now |

UI: Settings → Second brain.

## Next

- Wire `searchBrain` into `/ask` context and journey openers (formatBrainContext exists).
- MCP `recall` tool over the same search.
- Desktop packaging check: `onnxruntime-node` native binary in the standalone bundle (mac arm64).
