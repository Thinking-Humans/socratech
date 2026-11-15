# Web clip — BUILT 2026-11-15 (owner-approved plan)

Clip the web page you are reading into the vault as a new interactive
notebook, from a Chrome extension or from any MCP-speaking agent.

## Decisions (owner, 2026-11-15)

- D1 **App does the LLM work.** The extension only captures the page and
  hands it over; the app converts with the provider chosen in Settings
  (API key, ChatGPT/other subscription, Claude Code CLI). No keys in the
  extension.
- D2 **Agents use an MCP tool** on the existing `/api/mcp` server (same
  bearer token): `import_page_as_notebook`.
- D3 **Source + learning cells.** Page sections become private cells with
  the source link; code blocks become runnable code cells; generated
  exercise cells follow each section.
- D4 **One new notebook per clip**, titled from the page.

## Design

### One door: `/api/mcp`
The proxy already admits exactly `/api/mcp` on the bearer token, from any
origin, loopback hosts only. The extension speaks MCP's JSON-RPC
`tools/call` over one POST (stateless server, JSON response), so there is
no new route, no new token, no CORS grant, no change to `proxy.ts`.

### Tool `import_page_as_notebook`
Input: `{ url, title?, html?, markdown? }` (≤ 2 MB).
- `html` → Readability + Turndown on the server (reuse `htmlToMarkdown`
  from `src/agent/tools/web.ts`, exported).
- `markdown` → used as is.
- neither → server fetches `url` through the existing `web_fetch` path
  (safeFetch; Jina fallback for JS pages, as today).

Steps:
1. `pageToCells(markdown, {url, title, clippedAt})` — pure, in
   `src/core/web-clip.ts`, unit-tested:
   - first cell: `aside` — `> Source: [title](url) · clipped <date>`
   - split at `#`/`##` headings → one `aside` cell per section (private by
     default: clipped text never publishes unless you flip it)
   - fenced code → `code` cell with `lang` (python/cpp run; others still
     display as code)
   - images stay as remote links (not downloaded)
2. `createJournal` + `addJournalCell` per cell → returns
   `{ id, title, url: "/notebook/<id>", cells }` **immediately**.
3. In the background: one strong-slot call (`strong()` / `readAll`, as
   `gradeCheck` does) returns JSON `[{ section, exercise }]`; each becomes
   an `exercise` cell inserted after its section. No strong model set →
   skipped, and the tool result says so.

### Chrome extension — `extensions/chrome/` (MV3, plain JS)
- `manifest.json`: `activeTab`, `scripting`, `storage`;
  `host_permissions`: `http://localhost/*`, `http://127.0.0.1/*`. No
  access to pages until you click.
- Popup: page title, **Add to Socratech**, status, **Open notebook** link.
- Click → `chrome.scripting.executeScript` injects `vendor/Readability.js`
  + `capture.js` into the tab: clones the live DOM (so logged-in and
  JS-rendered pages work), runs Readability, returns `{url, title, html}`.
- Service worker POSTs the `tools/call` to `<server>/api/mcp` with the
  token, opens the notebook tab on success.
- Options page: server URL (default `http://localhost:3000`) + token
  (copied from Settings → Claude).
- `scripts/build-extension.mjs` copies Readability from `node_modules`
  into `extensions/chrome/vendor/`; load unpacked from
  `extensions/chrome/`.

### Settings → Claude
Add a line: "Chrome extension: paste this endpoint's origin and token
into the extension's options."

## Agents (honest scope)
- Claude Code, Claude Desktop, Cursor, any local MCP client: call
  `import_page_as_notebook` directly (they reach localhost).
- Claude in Chrome / claude.ai connectors and hosted operators (GPT
  agent) run off your machine and **cannot reach localhost**; they use
  the extension button, or need a tunnel (out of scope).

## Phases (each ends green on typecheck + lint + test)
1. `core/web-clip.ts` `pageToCells` + tests.
2. MCP tool + background exercise generation + tests (fake model).
3. Extension + build script + Settings hint.
4. docs/README update.

## Resolved
- Q1 (owner): the desktop server now prefers port **47823** (any free
  port if taken). The extension tries its saved server, then
  `http://localhost:3000`, then `http://127.0.0.1:47823`.

## Use
1. `npm run extension:build` (copies Readability into `extensions/chrome/vendor/`).
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** →
   `extensions/chrome`.
3. Socratech → Settings → Claude → **Copy extension setup** → paste into the
   extension's options → Save.
4. On any page: toolbar button or **Alt+Shift+S** → **Add as notebook**.
