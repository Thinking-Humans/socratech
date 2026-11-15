# Learn in Public — plan (APPROVED 2026-11-15)

Started 2026-11-15. One loop: point at a topic → teach/exercise → write what was
learned → publish → what was written feeds the graph → next exercises draw on it.
Every session leaves a publishable artifact.

## Decisions (owner, 2026-11-15)

| # | Decision |
|---|---|
| D1 | Sessions are driven from **both** the app UI (deep teaching) and Claude Code over MCP (exercises + writing). One journal, one tag schema, one exporter. |
| D2 | Socratech itself ships the learn-in-public machinery, for any user. rhizoMorphic is one target, not a special case. |
| D3 | Default visibility: **exercise statements + reflections publish**; attempts, verdicts, confidence, thinking stay private unless a cell is toggled to publish. |
| D4 | **Asides** private by default; aside + publish renders as a styled margin note (`<aside class="note">`). |
| D5 | Output is a neutral bundle. `markdown`: `YYYY-MM-DD-slug/index.md` (front matter + cells). `notebook` (rhizoMorphic convention): `index.md` front matter only + `notebook.ipynb` as the post, cells tagged by role. |
| D6 | Writing surface: a cell-based **journal pane** per session inside Socratech; Claude Code reaches it through new MCP tools. |
| D7 | Journal feeds the graph **on publish**, through the existing notes-import extraction; post URL is the provenance. Ideas land provisional → gym. |
| D8 | ~~Code cells are static in v1.~~ **Reversed 2026-11-15:** code cells run — see *Runnable cells* below. |
| D9 | Starter site: minimal **Hugo + GitHub Actions → Pages**, KaTeX + highlighting at build time. |
| D10 | Publish = write bundle into a **local clone** of the site repo, show diff, commit + push with the user's own git credentials **after confirm**. Scaffold uses `gh` when present. |

## Phases

Each phase ends green on `npm run typecheck && npm run lint && npm test`.

### 1. Journal domain (core + store) — BUILT 2026-11-15
- `src/core/contracts/journal.ts`
  - `Journal { id, chatId?, title, slug, createdAt, updatedAt, cells, published? }`
  - `JournalCell { id, role, source, lang?, output?, publish, origin? }`
  - `role`: `exercise | attempt | verdict | reflection | aside | code`
  - `publish` defaults by role (D3/D4): exercise ✓, reflection ✓, code ✓ (Q2), attempt ✗, verdict ✗, aside ✗
  - `origin`: `{ chatId, toolCallId, ideaIds }` for auto-filled cells
  - `published`: `{ at, siteRepo, path, url, commit }[]`
- `JournalStore` port in `src/core/ports.ts`; fs adapter `src/store/notebooks.ts` → `data/notebooks/<id>.py` + `<id>.socratech.json` (see *Marimo storage*; originally `data/journals/<id>.json`); wired in `src/server/stores.ts`.
- `src/core/journal-export.ts` (pure): `Journal → { "index.md": string, "notebook.ipynb"?: string }`. Drops unpublished cells. Front matter: title, date, tags (from target idea names), `socratech: { journal, ideas }`.

### 2. Auto-fill from sessions — BUILT 2026-11-15
- Practice and improvise `problem` → `exercise` cell; learner submission → `attempt`; `conclude`/`rejudge` → `verdict`.
- Reuses the practice join in `src/core/session-markdown.ts` (`MarkdownContext`) so one formatting engine stays true.
- Hook at turn end in `src/server/turn-service.ts`; idempotent by `toolCallId`.

### 3. Journal pane (UI) — BUILT 2026-11-15
- `components/journal/` beside the chat; cells render with the existing streamdown + KaTeX stack.
- Per cell: role chip, publish toggle (eye), edit, delete, reorder; add reflection / aside / code.
- Header: title, slug, **Preview** (exact exported markdown), **Publish**.
- Standalone journals (no chat) allowed: write-only sessions.

### 4. Publish — BUILT 2026-11-15
- Settings → **Publishing**: site repo path, content dir (default `content/posts`), formats (md / md + ipynb), branch, base URL.
- `POST /api/journals/[id]/publish?dry=1` → bundle + `git diff --stat`; confirm → write, `git add <bundle dir>` only, commit, push.
- Never stages outside the bundle dir. Refuses on dirty bundle dir it did not write.
- After push: record `published`, run notes import on published reflection cells with source = post URL (D7).

### 5. Starter site scaffold
- `templates/site-hugo/`: `hugo.toml` (passthrough math), `layouts/` (baseof, list, single, `_markup/render-passthrough.html` KaTeX, aside + code styles), `static/css/katex/`, `.github/workflows/deploy.yml`.
- Settings → **Set up learn-in-public site**: choose folder → copy template → `git init` → optional `gh repo create --public --source --push` → `gh api` enable Pages (Actions). Each external step confirmed.

### 6. MCP (Claude Code driver)
- New tools on `src/server/mcp.ts`: `journal_list`, `journal_get`, `journal_create`, `journal_append_cell`, `journal_update_cell`, `journal_preview`.
- **No publish over MCP** — publish stays a human click (public push).
- Claude Code loop: `add_idea` (seed topic) → pose via `improvise` prompt → `record_improvisation` → `journal_append_cell` exercise/attempt/verdict → user writes reflection in app or tells Claude.

### 7. rhizoMorphic as a target
- Point Publishing at `~/Desktop/Projects/blog`, formats md + ipynb.
- Blog side: `layouts/_partials/nb/parse.html` + CSS learn `aside` tag → margin-note cell. Exported ipynb carries roles as cell tags.

## Implementation rulings (2026-11-15, owner-confirmed)
- **R1 Lost-update law.** Store is replace-whole; three writers (pane, turn-end fill, MCP). No caller sends a whole journal: every route/tool is ONE op on a fresh read (`src/server/journals.ts`). Cell patches take `ifUpdatedAt` → 409 when stale.
- **R2 Attempt cell** = learner's LAST thinking submission on the problem (earlier ones read as drafts).
- **R3 Auto-create.** Practice/improvise sessions get a journal on their first exercise, titled from the chat title at that moment. Teaching/standalone journals are created explicitly.
- **R4 Survives chat deletion.** Deleting a session keeps its journal (the learner's writing); `chatId` dangles.
- **R5 Pinned bundle dir.** Slug is locked after first publish; republish reuses `publications[0].path` and the original date (adds `lastmod`).
- **R7 Deleted stays deleted.** Deleting a session's journal tombstones the session (`data/journals/_opted-out.json`); auto-fill skips it; "Start journal" by hand lifts it.
- **R6 Fill skipped under NODE_ENV=test** at turn end (like extraction); the seam is tested directly.

## Phase 3–4 as built (owner choices 2026-11-15)
- Session view: top-bar tab swap **Chat | Journal** (`?view=journal` deep link); the journal is an absolute overlay so the chat keeps running.
- Sidebar **Journals** section (+ new standalone journal → `/journal/[id]`).
- Cells Jupyter-style: click/Enter edit, Esc or click-away commits, Shift+Enter adds a cell below.
- **Preview** and **Publish** both show the server dry run (`GET /api/journals/[id]/publish`): target dir, per-file status, commit, push target, URL, blockers, exact `index.md`.
- Publish (`POST {confirmDir}`) commits ONLY the bundle dir (`git commit -- <dir>`), pushes `HEAD:<branch>` to the branch's remote, skips unchanged files (no lastmod-only commits), refuses a dirty bundle dir or a moved target.
- Settings → **Publishing**: site repo, content folder, site URL, format, push.
- Graph feed (D7) reports its real outcome: started / models-missing / graph-off / unchanged.

## API (phase 3 transport, built)
- `GET /api/journals` · `GET /api/journals?chatId=` · `POST /api/journals {title, chatId?, slug?, tags?}`
- `GET|PATCH {title?,slug?,tags?}|DELETE /api/journals/[id]`
- `POST /api/journals/[id]/cells {role, source?, lang?, output?, publish?, afterId?}`
- `PATCH {…fields, ifUpdatedAt?} | PATCH {toIndex} | DELETE /api/journals/[id]/cells/[cellId]`
- Event: `journals-changed {journalId, chatId?}` on every write.

## Resolved (owner, 2026-11-15)
- **Q1** Repo lives at `~/EF/thinkinghumans/socratech` (origin Thinking-Humans/socratech); nested copy in `blog/` removed.
- **Q2** Code cells publish by default — code + the last run's output (notebook: real `execution_count` + stdout outputs).
- **Q3** UI name: **Journal**.
- **Q4** Build order: phases 1→4 (usable loop on rhizoMorphic), then 5–6, then 7.

## Runnable cells + cell `/ask` — BUILT 2026-11-15 (owner; reverses D8)

Jupyter-style working loop inside the Journal pane; the published notebook is the post.

- **Languages:** `python` (aliases `py`, `python3`) and `cpp` (`c++`, `cxx`, `cc`). Other languages keep the pasted-output field.
- **Python:** one persistent `python3` per journal (`src/server/code-runner.ts`) — cells share variables, the last expression echoes like Jupyter, tracebacks point at `<cell n>`. 60 s limit → KeyboardInterrupt (state kept), then kill (state reset). `MPLBACKEND=Agg`; no rich/image outputs yet.
- **C++:** each cell compiles alone (`g++ -std=c++20 -O1`; `LH_CXX` overrides) and runs once, 10 s limit. No shared state between C++ cells. Compile errors / exit codes become the output.
- Code runs with cwd `data/journal-work/<journalId>/`. Runs are serialized per journal; the run counter is per journal (restart resets it). `LH_PYTHON` overrides the interpreter.
- **Keys:** Ctrl/⌘+Enter save + run · Shift+Enter save + run + new cell · Esc save. Header: **Run all**, **Restart** (Python).
- **`/ask`** on its own line in any cell (`# /ask …` / `// /ask …` in code) is lifted out on save and asked on the strong slot with the whole cell (source, language, last output) as focus and the surrounding cells as context. The answer streams under the cell and is saved as a **private aside** (`**/ask** …`) below it — even if the tab closes.
- **Export:** notebook code cells carry `execution_count`, stdout `outputs`, and `metadata.vscode.languageId` (the blog's `nb/parse.html` reads it for per-cell highlighting).
- **API:** `POST /api/journals/[id]/cells/[cellId]/run` → `{journal, run}` · `POST …/cells/[cellId]/ask {question}` → text stream · `DELETE /api/journals/[id]/kernel`.
- **Safety:** runs arbitrary local code — reachable only through the API gate (`proxy.ts`: Host check vs DNS rebinding, cross-site writes refused).

## Notebook keys, agent cells, search, media embeds — BUILT 2026-11-15 (owner)

- **Journal-only app:** `components/journal/journal-only.ts` (`JOURNAL_ONLY`) hides notes, session doors, the session list and background agents; home opens the newest journal.
- **Keys:** see `docs/keyboard.md` → Journal. All in the registry (`src/core/keyboard.ts`, scope `journal`, `surfaceOwned`), rebindable in Settings → Keyboard.
- **Agent cells** (`role: "agent"`, Mod+L): the source is a request; running streams the strong model's answer (whole journal as context, `journalAgentPrompt`) into `output`. Private by default; published as **Asked** + answer. `POST /api/journals/[id]/cells/[cellId]/agent`.
- **Search everything** (Mod+K): `GET /api/journals/search?q=` over titles, tags, cell text, code and outputs (`src/core/journal-search.ts`); Enter jumps to the cell.
- **Media embeds** in markdown cells: paste, drop, or the paperclip → `POST /api/journals/[id]/media` (raw stream, 500 MB cap; exempt from proxy.ts's truncating body clone, same API gate in-handler) → stored in `data/journal-media/<id>/`, embedded as `![alt](media/<name>)` on its own line. The cell draws whole-line embeds itself (image / video player from `GET …/media/[name]`, Range-aware); markdown rendering keeps blocking images (model output never loads one). Publish copies referenced files into `<bundle>/media/` and turns video embeds into `<video>` tags (the blog renders raw HTML).

## Journals removed; notebooks only (owner, 2026-11-15)

- UI says **Notebook** everywhere; `/notebook/[id]` (old `/journal/[id]` links redirect). Internals keep the `journal` names (`/api/journals`, `src/core/journal*.ts`).
- A new notebook is ONE empty markdown cell, opened for editing — a plain text note is just a one-cell notebook.
- The daily-journal / notes form factor is gone from the product; the cell-type picker offers Markdown, Code, Agent, Aside (exercise / attempt / verdict only show on cells that already have them).
- **Inline ask** while editing (Mod+L, then I / E / type): `POST /api/journals/[id]/cells/[cellId]/inline` streams an ephemeral answer about the highlighted text, with the live draft + notebook as context (`inlineAskPrompt`). See docs/keyboard.md.

## Notebooks as the unit of learning — ratings, check, per-cell graph (owner, 2026-11-15)

- **Rating** (markdown + code cells): *did it on my own* / *did it with help* / *couldn't understand, even with help* — buttons under the cell or 1/2/3 on a focused cell. Stored as `cell.understanding {level, hash, at, check?}`; `hash` = the text rated, so an edit marks it stale.
- **Couldn't, even with help** → an agent cell **above** the cell (`**Prerequisites** for cell N …`) explains the ideas it depends on, simplest first; it runs at once; re-rating reuses it.
- **Check me** (agent cross-check): one question about the cell (strong slot) → the learner answers → `VERDICT: holds|shaky|fails` + rationale, kept on the rating; a disagreement with the rating is flagged.
- **Graph extraction only when asked (Add to graph / G) or on publish.** Each cell is its own notes source, `notebook://<journalId>/<cellId>`. Re-extracting an edited cell withdraws that cell's earlier contribution first (`deleteSourcesTraces`, delete-nodes: ideas only it supported die; shared ideas keep their other provenance) and reads the new text; a cell emptied of text is withdrawn; unchanged text is a no-op (`cell.graph.hash`). Only the learner's own writing is read (markdown + aside cells; never agent output, code, or media lines). Publish extracts every published cell that is new or changed, one at a time. Deleting an extracted cell or notebook withdraws its traces.
- Ratings stay in the notebook, never in the graph (the graph holds no learner assessments); per-idea views can join ratings through cell provenance at read time.
- Code: `src/core/notebook-learning.ts`, `src/server/notebook-learning.ts`; routes `…/cells/[cellId]/rate|check|extract`.

## Marimo storage (owner, 2026-11-15)

A notebook is stored as a **marimo `.py`** (git-friendly, opens in marimo) plus a **sidecar** for what marimo has no slot for. Pure translation: `src/core/marimo-format.ts` (`journalToMarimo`, `marimoToJournal`); adapter: `src/store/notebooks.ts`.

- **Files** (`data/notebooks/`, named by journal id so a title or slug change never renames anything): `<id>.py`, `<id>.socratech.json`, `_opted-out.json` (deleted-session tombstones). Each file is written atomically, the `.py` first.
- **The .py holds all readable text.** Markdown roles (reflection, aside, exercise, attempt, verdict) → `mo.md(r"""…""")` (marimo's markdown cells). Python code → a real cell with marimo-style refs/defs (best effort; marimo rewrites signatures when it opens the file). C++ and other languages → `mo.md` with a fenced block (rendered, never run by marimo). Agent cells → `_prompt` / `_answer` strings plus a callout display line. A setup cell `import marimo as mo` comes first.
- **Cell ids are the cell function names** (`def cell_3f2a…(…)`); ids that are not safe Python names are escaped as `c_…`. That match survives reordering and edits in marimo.
- **The sidecar** holds every Journal field except the cells (id, title, slug, chatId, tags, publications, timestamps, journal-level `graph`, and any future field), and per cell everything but its text: role, lang, publish, executionCount, code output, origin, understanding, graph, timestamps, plus `sourceHash` to notice hand edits. Agent answers live only in the .py.
- **Hand edits in marimo** load: reordered cells keep their metadata; edited text wins (that cell's `updatedAt` moves); a cell added in marimo gets an id and default metadata (role from its shape); a cell deleted there leaves the sidecar. Cells marimo strips names from (unparsable code, saved as `app._unparsable_cell(…, name="_")`) re-attach by text hash. The store writes back only what it must: the .py when ids changed, the sidecar when metadata did; marimo's own formatting writes nothing. A corrupt sidecar is read around, never overwritten. Deleting a cell in marimo does not withdraw its graph traces (delete in the app for that).
- **Migration:** the first store call moves `data/journals/<id>.json` into this format and the JSON into `data/journals/.migrated/` (never deleted; idempotent; unreadable files stay put). Tombstones merge into the new `_opted-out.json`.
- **marimo-clean check:** Socratech keeps its own runner (Python kernel, g++), where a second cell may redefine a global; marimo refuses that. python3's `ast` (`src/server/marimo-check.ts`) reports globals two Python cells define (and a cell defining `mo`) plus unparsable cells. It rides on Python run results (`marimo`) and `GET /api/journals/[id]/marimo`; Python cells show a warning note (`components/journal/marimo-warning.tsx`). Advisory only.
- **Publishing:** the `notebook` bundle format ships `notebook.py` (published cells only, no sidecar) beside `notebook.ipynb` (still the post the blog parses) and `index.md`.
- Known marimo quirks: markdown containing `"""` is written as `r'''…'''` (valid; `marimo check --strict` flags it as a style warning, and `--fix` re-escapes it, adding a backslash to the text). Python code whose lines all end in CRLF reads back as LF.
