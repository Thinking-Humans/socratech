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
| D8 | Code cells are **static** in v1 (source + optional pasted output). Execution deferred. |
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
- `JournalStore` port in `src/core/ports.ts`; fs adapter `src/store/journals.ts` → `data/journals/<id>.json`; wired in `src/server/stores.ts`.
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
- **Q2** Code cells publish by default — as static code blocks (with recorded output), never executable.
- **Q3** UI name: **Journal**.
- **Q4** Build order: phases 1→4 (usable loop on rhizoMorphic), then 5–6, then 7.
