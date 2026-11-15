# Notes first — plan (owner, 2026-11-15)

The chatbot is no longer the front door. The learner writes markdown notes;
Claude answers inline; a written section can start a **journey** (a
teach/practice session) in a side pane. Builds on docs/learn-in-public.md.

## Decisions (owner, 2026-11-15)

| # | Decision |
|---|---|
| N1 | Notes are **plain `.md` files in a vault folder** (Settings → Notes → vault path). Obsidian / Emacs / git can open them. Daily note = `daily/YYYY-MM-DD.md`. |
| N2 | Editor = **CodeMirror 6 live preview**: raw markdown, headings / callouts styled inline. |
| N3 | `/ask <question>` on its own line → Claude's answer streams in below as an Obsidian callout `> [!claude]`. Model = **strong slot**; context = the current `## ` section (+ graph context). |
| N4 | Home (`/`) opens today's daily note. Graph + sessions stay reachable from the sidebar. |
| N5 | **Start journey** on a `## Topic` section → creates a session (teach default; practice/improvise selectable) seeded with the section text; the session opens in a **right side pane** beside the note. The full chat page stays for deep links. |
| N6 | Daily `## Topic` sections route into a **per-topic journal** (private by default) on "File to journals". |
| N6b | Notebook cells survive: the journal pane keeps reflection/aside/code cells + ipynb export. In notes, fenced ```` ```lang ```` blocks are highlighted and file into the topic journal as **code cells** (static, D8; execution = separate phase if wanted). |
| N7 | Lines starting `want:` → **provisional graph ideas** (same merge as MCP `add_idea`; no model needed). |

## Phases (each ends green on typecheck + lint + test)

1. **Vault + editor + daily home** — BUILT 2026-11-15 (no Settings UI for the vault yet: `PUT /api/settings/notes {vaultDir}`) — notes settings section; `src/server/notes.ts` (safe path resolve inside vault, list/read/write); `GET/PUT /api/notes?path=`; `components/notes/` CodeMirror editor with autosave; `/` → today's daily note; sidebar Notes list.
2. **Inline `/ask`** — BUILT 2026-11-15 (`/ask` line becomes `> [!claude] question`; graph context not yet passed) — `POST /api/notes/ask {path, line}` streams text; editor inserts/updates the callout under the `/ask` line; abortable.
3. **Journey pane** — BUILT 2026-11-15 (teach / practice / improvise buttons on each `## Topic`; `Chat embedded` in the right pane, `?journey=<chatId>`; a started journey writes `<!-- journey:<kind>:<chatId> -->` under the heading — invisible in Obsidian reading view — and the heading then offers "resume <kind> →") — section gutter action → `POST /api/chats` + opening prompt; `Chat` made embeddable (no `h-dvh`, scoped listeners); note page splits note | session.
4. **Topic routing + want → graph** — "File to journals" parses the daily note: `## Topic` → topic journal cells (`learned`, `want` roles, private); `want:` lines → provisional ideas; idempotent by (date, topic, line hash).
