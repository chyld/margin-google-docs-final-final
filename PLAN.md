# Margin: MVP plan (v2, after beta review)

Margin is a personal, single-user "Google Docs": a list of notes and a rich text editor built on Tiptap. It runs with Docker Compose on port 5555.

## Decisions (from the user)

| Topic | Decision |
|---|---|
| Stack | React + Vite + TypeScript frontend, Hono API on Node 24, SQLite |
| Access | No login. Port 5555 bound to `127.0.0.1` only |
| Layout | Left sidebar with the notes list. Editor shows a white "paper" page on a gray canvas, toolbar pinned on top |
| Run | `docker compose up -d --build`, then open http://localhost:5555 |

## MVP scope

In:

- Notes list in the sidebar: newest edited first, title, short snippet, relative "edited" time.
- Create a note ("+ New"), open it, rename it (title field above the page), delete it (with a confirm prompt).
- Search box that filters notes by title and body text.
- Tiptap editor with a standard formatting toolbar (below).
- Autosave with a visible status. Unsaved edits are kept in `localStorage` until the server confirms them.
- Deep links: `/notes/:id` opens that note, and reload keeps you on it.
- Data survives page reloads, container restarts and rebuilds (Docker volume).

Out (see the roadmap at the end): auth, images, tables, export, version history, folders/tags, trash, real-time collaboration, comments, dark mode, mobile layout, conflict detection between tabs.

## Architecture

One container, one Node process:

```
browser ──► :5555 (127.0.0.1 only)
             └─ Hono (Node 24)
                 ├─ guard        Host allowlist, Origin / Sec-Fetch-Site check, JSON-only writes
                 ├─ /api/*       JSON API (unknown /api paths → JSON 404)
                 ├─ /assets/*    hashed Vite output (missing → 404, never HTML)
                 └─ GET /, /notes/:id → index.html (SPA fallback, no-cache)
                     └─ SQLite file at /data/margin.db (Docker named volume)
```

Key choices:

- **No native modules.** The server uses Node 24's built-in `node:sqlite` (`DatabaseSync`).
- **No server build step.** Node 24 runs `.ts` directly (type stripping). This needs:
  - `"type": "module"` in `package.json`.
  - Erasable syntax only.
  - Explicit `.ts` import extensions.
  - `import type` for every type-only import. Node keeps a plain `import { Note }` and crashes at runtime, even though `tsc` passes.
  - The compiler settings `erasableSyntaxOnly`, `verbatimModuleSyntax` and `allowImportingTsExtensions` enforce these. A boot smoke test catches anything `tsc` misses.
- **One `package.json`** at the repo root, no workspaces and no project references. Two plain tsconfigs.
- **Store Tiptap JSON, not HTML.**
  - The database column is a string. The API and the editor always see a parsed object. Stringify and parse only at the SQLite boundary. Tiptap reads a *string* as HTML, which would corrupt notes.
  - Safety comes from rendering through the editor schema, plus server-side validation of node types, mark types and dangerous attributes. It does not come from "ProseMirror drops unknown nodes". With invalid JSON, Tiptap silently falls back to an empty doc, which is a data-loss trap. See "Editor".

## Security (localhost app, no login)

Binding to `127.0.0.1` stops other machines, but not hostile web pages in the user's own browser (cross-site requests, DNS rebinding). A small `guard` middleware runs on every request:

1. **Host allowlist.** `Host` must be one of `ALLOWED_HOSTS` (default `localhost:5555,127.0.0.1:5555,[::1]:5555`). Anything else gets a `403`. This blocks DNS rebinding.
2. **Writes** (POST, PATCH, DELETE):
   - Reject if `Sec-Fetch-Site` is `cross-site`, or if `Origin` is present and isn't `http://<allowed host>`.
   - POST and PATCH need `Content-Type: application/json`, otherwise `415`. This makes cross-origin writes non-simple requests that need a preflight. Hono's `c.req.json()` doesn't check the content type itself.
3. **No CORS headers**, ever. Add `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.

Dev mode binds the API to `127.0.0.1`. Only Docker sets `HOST=0.0.0.0`, inside the container.

## Repository layout

```
.
├── docker-compose.yml
├── Dockerfile
├── .dockerignore            # node_modules, dist, data, .git, **/*.test.ts
├── .gitignore               # node_modules, dist, data
├── package.json             # "type": "module"
├── tsconfig.node.json       # server/, shared/, vite.config.ts (module nodenext)
├── tsconfig.web.json        # web/src/, shared/ (moduleResolution bundler, DOM, react-jsx)
├── vite.config.ts           # root: 'web', outDir: '../dist/web', proxy, and the Vitest `test` block
├── README.md
├── shared/
│   ├── types.ts             # Note, NoteSummary, request/response shapes
│   ├── doc.ts               # inspectDoc(): validate a Tiptap doc + extract plain text
│   └── doc.test.ts
├── server/
│   ├── index.ts             # read env, open db, serve(), graceful shutdown
│   ├── app.ts               # createApp({ db, staticDir, allowedHosts }), used by tests
│   ├── guard.ts             # Host / Origin / content-type middleware
│   ├── db.ts                # open database, pragmas, transactional migrations
│   ├── notes.ts             # note queries
│   ├── app.test.ts          # API + guard + static/fallback tests (temp db + temp static dir)
│   └── boot.test.ts         # spawns `node server/index.ts`, hits /api/health
└── web/
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx              # layout, routing, list state, wiring the save queue
        ├── api.ts               # typed fetch wrapper, ApiError with status
        ├── router.ts            # tiny pushState router for /notes/:id
        ├── saveQueue.ts         # framework-free autosave engine (timers, retries, drafts)
        ├── saveQueue.test.ts
        ├── components/
        │   ├── Sidebar.tsx
        │   ├── NoteView.tsx      # title, status, delete, toolbar, page, load-error banner
        │   ├── Editor.tsx        # Tiptap setup
        │   ├── Toolbar.tsx       # all buttons, style <select>, color popovers
        │   └── LinkPopover.tsx
        └── styles/
            ├── app.css
            └── editor.css
```

## Data model

`new DatabaseSync(path, { timeout: 5000 })` (a busy timeout), then `journal_mode=WAL`. `DATA_DIR` is created if missing. If the directory isn't writable, startup fails with a clear message about volume ownership.

Migrations are tracked with `PRAGMA user_version`. Each one runs in `BEGIN IMMEDIATE … PRAGMA user_version = N; COMMIT`, with rollback on error. A database with a newer version than the code knows refuses to start.

```sql
CREATE TABLE notes (
  id          TEXT PRIMARY KEY,           -- crypto.randomUUID()
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,              -- JSON.stringify(Tiptap doc)
  text        TEXT NOT NULL DEFAULT '',   -- plain text derived on the server, for search + snippet
  created_at  INTEGER NOT NULL,           -- epoch ms
  updated_at  INTEGER NOT NULL            -- epoch ms
);
CREATE INDEX notes_updated_at ON notes (updated_at DESC, id DESC);
```

New notes start with `{"type":"doc","content":[{"type":"paragraph"}]}`.

### `inspectDoc(value)` (shared/doc.ts)

One recursive walk that validates and extracts text. It returns `{ ok: true, text }` or `{ ok: false, error }`.

- The root is an object with `type: "doc"`. Every node is a plain object with a known `type`.
- Node types:
  - `doc`, `paragraph`, `text`, `heading`, `blockquote`
  - `bulletList`, `orderedList`, `listItem`, `taskList`, `taskItem`
  - `codeBlock`, `horizontalRule`, `hardBreak`
- Mark types: `bold`, `italic`, `underline`, `strike`, `code`, `link`, `textStyle`, `highlight`.
- `content` must be an array and `marks` must be an array of `{ type, attrs? }`. Text nodes need a string `text`.
- Dangerous attributes:
  - `textStyle.color` and `highlight.color` must be absent, null or a hex color (`#rgb` / `#rrggbb`). Color and Highlight put the raw value straight into `style`.
  - `link.href` must be a string, and its scheme must not be `javascript:`, `data:` or `vbscript:`.
- Limits: depth ≤ 100, nodes ≤ 200,000.
- Text: concatenate the text nodes, with a newline between blocks. The snippet is the whitespace-collapsed first 140 characters.

These allowlists match the editor's extensions. Adding an extension means updating `shared/doc.ts` in the same change.

## API

All JSON. IDs must be UUIDs. Errors return `{ error }`: `400` for bad input, `403` from the guard, `404` for a missing note or unknown `/api` path, `413` for too large, `415` for a non-JSON write.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | none | `{ ok: true }` |
| GET | `/api/notes?q=` | none | `NoteSummary[]` (`{ id, title, snippet, updatedAt }`) |
| POST | `/api/notes` | `{ title? }` | `201` + `Note` |
| GET | `/api/notes/:id` | none | `Note` (`{ id, title, content, createdAt, updatedAt }`), where `content` is an object |
| PATCH | `/api/notes/:id` | `{ title?, content? }`, at least one | `NoteSummary` (lets the sidebar update without a refetch) |
| DELETE | `/api/notes/:id` | none | `204` |

The notes list:

- Ordered by `updated_at DESC, id DESC`, limited to 200 rows.
- `q` is trimmed and limited to 200 characters.
- Search uses `title LIKE ? ESCAPE '\' OR text LIKE ? ESCAPE '\'`. The query escapes `\` first, then `%` and `_`. Case-insensitivity is ASCII-only in SQLite (documented MVP limitation).

Validation and limits:

- Request bodies go through a strict zod (v4) envelope that rejects unknown keys. `title` is a string of at most 500 characters. `content` is `z.unknown()`, so zod never strips it, and is then checked by `inspectDoc`.
- The server derives `text` from `content`. The client never sends it.
- Body limit: `bodyLimit({ maxSize: 5 MiB })` on `/api/*`, returning `413 { error }`. Hono's default limit would be much smaller.
- Malformed JSON returns `400`. `app.onError` turns anything else into a `500` JSON response.

Concurrency: last write wins between tabs. This is documented, and conflict detection is on the roadmap. Within one tab, saves are strictly serialized (see "Autosave").

## Frontend

### Layout

```
┌──────────────┬──────────────────────────────────────────────┐
│ Margin       │ [Untitled document.............]  Saved ✓  🗑 │
│ [+ New]      │ ↶ ↷ │Normal▾│ B I U S <> │ A▾ 🖍▾ │ 🔗 │ ≡ ≡ ≡ ≡ │ • 1. ☑ │ ❝ {} ― │ ⌫ │
│ 🔍 Search    ├──────────────────────────────────────────────┤
│──────────────│            ┌──────────────────────┐          │
│▸ Groceries   │            │   816px white page,  │          │
│  2 min ago   │            │   96px padding,      │          │
│  Ideas       │            │   drop shadow        │          │
└──────────────┴──────────────────────────────────────────────┘
```

- Sidebar is 280px wide and scrolls on its own. The active note is highlighted. Empty titles show "Untitled document".
- The title bar and toolbar stay sticky. The gray canvas (`#f1f3f4`) scrolls. The page is 816px × min 1056px, with 96px padding and a shadow.
- Empty states: no notes, no search results, "Note not found".
- Plain CSS with custom properties. Icons from `lucide-react`.

### Routing and list state

- A tiny router (`pushState` + `popstate`) with two routes: `/` and `/notes/:id`.
- On load: fetch the list. Open the URL's note, or the newest note, or show the empty state.
- Search is debounced 250ms. Each request gets a sequence number, and stale responses are ignored.
- After a successful save, the PATCH response (`NoteSummary`) updates the list:
  - With no active search, the item is updated and moved to the top.
  - With an active search, the current query is re-fetched, since the note may enter or leave the results.
- `+ New`: POST, add the note to the list, navigate to it, focus the title.
- Delete: `confirm()`, cancel the note's save queue, clear its draft, DELETE, then open the next note.

### Editor (Tiptap v3, `@tiptap/react` 3.32.x)

```ts
StarterKit.configure({
  heading: { levels: [1, 2, 3] },
  link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
}),
TextStyle, Color,
Highlight.configure({ multicolor: true }),
TextAlign.configure({ types: ['heading', 'paragraph'] }),
TaskList, TaskItem.configure({ nested: true }),
Placeholder.configure({ placeholder: 'Start writing…' }),
```

StarterKit already includes link, underline, the lists and list keymap, undo/redo, drop cursor, gap cursor and trailing node. They are not added a second time.

- `NoteView` fetches the note first and then mounts `<Editor key={note.id} content={…}>`. The content goes to `useEditor({ content })`, so no `setContent` call and no spurious update. The per-note remount keeps undo history separate.
- **Load-error safety:**
  - Use `enableContentCheck: true`. `onContentError` puts the note in a read-only "This note contains content Margin can't display. It has not been changed." state.
  - That note's autosave is disabled, so the fallback empty doc can never overwrite the stored one.
- `onUpdate` sends `editor.getJSON()` to the save queue on every change. The snapshot is taken immediately, not later, so it never depends on the editor still being mounted.
- Toolbar state comes from `useEditorState` with a selector that also computes the `editor.can()` checks, so active and disabled states stay current.
- Links: Ctrl/Cmd+click opens the link in a new tab (`noopener`). The popover (also opened with Ctrl/Cmd+K) shows the URL with Apply, Remove and Open buttons. It uses `setLink` / `unsetLink`, which run Tiptap's URL validation.
- Colors come from a fixed hex palette only.
- The placeholder needs a CSS rule: `.tiptap p.is-editor-empty:first-child::before { content: attr(data-placeholder); float: left; height: 0; pointer-events: none; color: …; }`.

### Toolbar (the "standard formatting navbar")

1. Undo, Redo
2. Text style `<select>`: Normal text, Heading 1, Heading 2, Heading 3
3. Bold, Italic, Underline, Strikethrough, Inline code
4. Text color, Highlight color (a palette popover with "Default" / "None")
5. Link (popover, Ctrl/Cmd+K)
6. Align left / center / right / justify
7. Bulleted list, Numbered list, Checklist
8. Blockquote, Code block, Horizontal line
9. Clear formatting (`unsetAllMarks` + `clearNodes`)

Every button has `title` (with its shortcut), `aria-label` and `aria-pressed`, and is disabled when its command can't run. The container has `role="toolbar"`. Buttons call `preventDefault` on `mousedown` so the editor keeps focus.

### Autosave (`saveQueue.ts`, framework-free, created once at app level)

The queue lives above the editor and is keyed by note ID. Remounts, note switches and A→B→A navigation never create a second writer for a note.

Each note's entry holds:

- `pending`: the merged patch (`{ title?, content? }`), or nothing
- `generation`: the edit counter
- `inFlight`: whether a request is running
- the debounce and max-wait timers
- the retry state
- `status`: `idle | saving | saved | retrying | error`

Behaviour:

- `update(id, patch)` merges into `pending`, bumps `generation` and schedules a save: 800ms debounce, at most 5s during continuous typing.
- **Serialized saving.** Only one request per note is in flight. On success, if newer edits arrived meanwhile, one follow-up save goes out with the latest merged patch. Each request carries its own ID and snapshot.
- **Errors:**
  - Network errors and 5xx: retry with backoff (1s, 2s, 4s … max 30s). Status is "Save failed, retrying".
  - 4xx (400/404/413): stop retrying. Status is a persistent error ("Couldn't save: …", or "This note was deleted"). Edits stay in the editor and in the draft.
- `flush(id)` saves immediately and returns a promise. Switching notes doesn't block on it, because the queue keeps working in the background.
- `cancel(id)` is used on delete. It clears timers, drops `pending` and ignores any in-flight result.
- `getPending(id)`: when a note is reopened while it still has unsaved or in-flight edits, the view starts from the pending snapshot, not the stale server copy.
- **Local drafts.** Unsaved patches are written to `localStorage` (`margin:draft:<id>` = `{ title?, content?, editedAt }`) when a save is scheduled, and synchronously on `visibilitychange → hidden` and `pagehide`. The draft is cleared once the server confirms a generation that includes the latest edit.
- **Draft recovery on open.** If a draft exists and `editedAt` > the server's `updatedAt`, the draft is applied and saved, and a "Restored unsaved changes" notice is shown. Older drafts are discarded.
- **Unload.**
  - On `visibilitychange → hidden`: flush with a normal fetch.
  - On `pagehide`: write drafts. Send a `keepalive` PATCH only if the body is under 60 KB and nothing is in flight for that note. Browsers cap keepalive requests at about 64 KiB, and an out-of-order send could overwrite newer data.
  - On `beforeunload`: show the leave prompt while any note is dirty or saving.
- Storage, `fetch` and the clock are injected, so the queue is unit-tested in Node with fake timers. No DOM or React test libraries are needed.

## Docker

```dockerfile
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build                       # vite build → dist/web

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist/web ./dist/web
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5555
CMD ["node", "server/index.ts"]
```

```yaml
services:
  margin:
    build: .
    image: margin:latest
    container_name: margin
    init: true
    ports:
      - "127.0.0.1:5555:5555"
    environment:
      HOST: 0.0.0.0
      PORT: "5555"
      DATA_DIR: /data
    volumes:
      - margin-data:/data
    restart: unless-stopped
    stop_grace_period: 10s
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:5555/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
volumes:
  margin-data:
```

- The server calls `serve({ fetch: app.fetch, hostname: HOST, port: PORT })`, with `HOST` defaulting to `127.0.0.1`.
- On `SIGTERM`/`SIGINT` it calls `server.close()`, then `closeIdleConnections()`, then `db.close()`, then exits.
- `serveStatic` (`@hono/node-server` ≥ 2.1.3) is rooted at `STATIC_DIR`, which defaults to `dist/web` relative to the working directory, `/app` in Docker.
  - Hashed `/assets/*` files get `Cache-Control: public, max-age=31536000, immutable`.
  - The `index.html` fallback, for GET/HEAD requests to extensionless non-`/api` paths only, gets `no-cache`.
- The README covers:
  - Backup: `VACUUM INTO` to a timestamped file in `/data`, then `docker compose cp`.
  - Volume ownership: a pre-existing root-owned volume needs a `chown`, or `docker compose down -v` (which deletes the data).

## Local development

- `npm run dev`: runs the API (`node --watch server/index.ts`, `HOST=127.0.0.1 PORT=5556 DATA_DIR=./data`) and Vite on `127.0.0.1:5555`, with `/api` proxied to 5556. Uses `concurrently`. The proxy keeps the original `Host`, so the guard allows it. Docker and dev both use port 5555, so only one can run at a time.
- `npm run typecheck`: `tsc -p tsconfig.node.json && tsc -p tsconfig.web.json` (both `noEmit`).
- `npm test`: Vitest, Node environment, root at the repo root.
- `npm run build`: `vite build`.

## Dependencies

- Runtime: `hono`, `@hono/node-server` (≥ 2.1.3), `zod` (v4).
- Frontend (dev deps, bundled):
  - `react`, `react-dom`, `lucide-react`
  - `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`
  - `@tiptap/extension-text-style`, `@tiptap/extension-highlight`, `@tiptap/extension-text-align`, `@tiptap/extension-list`, `@tiptap/extensions`
- Tooling: `vite`, `@vitejs/plugin-react`, `typescript`, `@types/node` (^24), `@types/react`, `@types/react-dom`, `vitest`, `concurrently`.
- All `@tiptap/*` packages are pinned to the same exact version. If TypeScript 7 or Vite 8 break anything, that will show in the first scaffold step, and I'll pin TypeScript 5.9 if needed.

## Testing

- **`shared/doc.test.ts`**:
  - valid docs and text extraction
  - unknown node and mark types
  - non-hex colors and `javascript:` hrefs
  - depth and node limits
- **`server/app.test.ts`**:
  - full CRUD, with `content` returned as an object
  - ordering, the 200-row limit, search with `%`, `_` and `\`
  - zod rejecting unknown keys without stripping `content`
  - 400s, 404s, 413s and 415s
  - guard: bad `Host` → 403, cross-site `Origin` or `Sec-Fetch-Site` → 403
  - unknown `/api/x` → JSON 404, missing `/assets/x.js` → 404, `/notes/<id>` → `index.html`
- **`server/boot.test.ts`**: spawns `node server/index.ts` on a random port with a temp `DATA_DIR` and checks `/api/health`. This catches type-stripping and ESM errors that `tsc` can't.
- **`web/src/saveQueue.test.ts`**:
  - debounce and max-wait
  - no overlapping saves, and a follow-up after edits made mid-flight
  - retries for network errors and 5xx, a stop on 4xx, and 404 "deleted"
  - `cancel` on delete, `flush`
  - drafts written and cleared, and recovery decisions
- **Type check** both configs.
- **Manual end to end:**
  - `docker compose up -d --build`, then `docker compose ps` shows `healthy`.
  - curl the API, including a forged `Host` (→ 403).
  - `docker port margin` shows `127.0.0.1`, and curl on the LAN IP fails.
  - Click through the UI: every toolbar control, create, rename, search, delete, reload mid-typing, open `/notes/<id>` directly, then `docker compose down && up -d` and check the data is still there.

## Acceptance criteria

1. `docker compose up -d --build` starts Margin and the container reports `healthy`. Both http://localhost:5555 and a direct `/notes/<id>` URL load the app.
2. Port 5555 is bound to `127.0.0.1` only, and requests with a foreign `Host` or a cross-site `Origin` are rejected.
3. Notes can be created, opened, renamed, edited, searched and deleted. The list stays in sync without a reload.
4. Every toolbar control works and shows its active and disabled state for the current selection.
5. Edits autosave with a visible status. Switching notes quickly (A→B→A) never loses or crosses edits. Reloading mid-edit loses nothing: the draft is restored if the save didn't land.
6. A note whose stored content the editor can't parse opens read-only and is never overwritten.
7. Notes survive `docker compose down && docker compose up -d`.
8. `npm test` and `npm run typecheck` pass.

## Build order

1. Scaffold: `package.json`, tsconfigs, `vite.config.ts` (with `test`), ignore files. Smoke-test that TS 7, Vite 8, Vitest and `node:sqlite` all work together.
2. Shared: `types.ts`, `doc.ts` + tests.
3. Server: `db.ts`, `notes.ts`, `guard.ts`, `app.ts`, `index.ts` + API and boot tests.
4. Save queue + tests.
5. Web shell: layout, sidebar, router, API client, list/search/create/delete.
6. Editor: Tiptap setup, toolbar, link popover, color palettes, load-error state, paper styling.
7. Docker: `Dockerfile`, `docker-compose.yml`, README.
8. Verify against the acceptance criteria.

## Beta review: what changed from v1

All nine reviewers returned "ready with changes". Accepted:

- **Security.** Host allowlist (DNS rebinding), Origin and `Sec-Fetch-Site` checks on writes, JSON-only writes, loopback-only dev binding. (All nine reviewers.)
- **Data loss on bad content.** `enableContentCheck` with a read-only state instead of a silent empty doc, plus server-side `inspectDoc` validation. (Sonnet, Sol, Terra, Muse, DeepSeek, MiniMax.)
- **Zod.** `content` is `z.unknown()`, so it is never stripped. (Grok.) `content` is an object over the API. (Muse, Grok.)
- **Autosave.**
  - The app-level queue is keyed by note ID, with immediate snapshots.
  - 4xx errors stop retrying.
  - Delete cancels the note's queue.
  - Drafts go to `localStorage`, because keepalive is capped at 64 KiB.
  - The engine is framework-free and tested in Node. (Most reviewers. The framework-free engine came from Kimi and MiniMax.)
- **Node type stripping.** `"type": "module"`, `import type`, the compiler settings, two plain tsconfigs instead of `tsc -b --noEmit`, and a boot smoke test. (All.)
- **Build, static files and Docker.**
  - Vite `root: 'web'` and `outDir: '../dist/web'`. (Kimi, Grok.)
  - An explicit static and fallback order, JSON 404s under `/api`, and real 404s for missing assets.
  - `WORKDIR`, `npm ci` as root, then chown `/data` and switch to `USER node`.
  - `init`, explicit `serve()` hostname and port, and `node:sqlite` `timeout`.
  - Transactional migrations.
  - `bodyLimit` `maxSize`, because the default is small. (MiniMax.)
- **Search.** `ESCAPE '\'`, escaping `\` as well, ASCII-only case-folding documented, `LIMIT 200`, a cap on `q` length, ignoring stale responses, and re-fetching the list during an active search.
- **Server-derived `text`.** The client no longer sends it. (DeepSeek, MiniMax.)
- **Colors limited to hex**, in the editor and on the server. (Grok.)
- **Small things.** The placeholder CSS rule, Ctrl/Cmd+click on links, merged small components, `@types/node` ^24, timestamped backups, `id` as an ordering tie-breaker.

Declined:

- **Cutting color, highlight and alignment from the toolbar** (DeepSeek, MiniMax). The user asked for a standard formatting toolbar, and Google Docs has all three.
- **Falling back to an empty doc on load errors** (GLM). That is exactly what causes the overwrite. The note goes read-only instead.
- **`baseUpdatedAt` / 409 conflict detection between tabs** (Sonnet). Deferred to the roadmap. Last write wins is documented.
- **Full ProseMirror schema validation on the server.** The node and mark allowlist plus checks on dangerous attributes is enough for a single-user app.

## Beta code review: what changed after implementation

All nine reviewers returned "ship after fixes". Fixed:

- **Stale reload after a save** (Sol, Muse, Kimi, Sonnet). A reload that read a note before its save landed, but arrived after it, could show old text marked "saved". The next edit would then overwrite the newer version.
  - The queue now remembers the last confirmed version of each note (`getLocalChanges`) and lays it over any older server copy.
  - `open()` never moves the draft base backwards.
  - A browser test reproduces the race with held requests.
- **Delete order** (all nine). Pending edits and the draft are dropped only after the server confirms the delete. A failed delete keeps saving, and a save that lands after a successful delete gets a 404, which is now final.
- **Drafts on every edit** (Terra, Sol, Muse, MiniMax, GLM, Grok). The draft is written 300ms after each edit, including while a save is in flight or waiting to retry.
- **Pasted colors can't block saving** (Sonnet, DeepSeek).
  - The server accepts CSS color functions (`oklch()`, `lab()`, `color()`, `var()`, …).
  - It clears colors it can't vouch for instead of rejecting the document.
  - It removes links outside web, email, phone and same-site links but keeps their text.
  - It clears invalid text alignments and rejects heading levels outside 1–3.
- **Structure checked against the real editor schema** (Muse, DeepSeek, Kimi, GLM). The extension list moved to `shared/extensions.ts`, and the server rejects documents that `schema.nodeFromJSON(doc).check()` refuses. The Tiptap packages are now runtime dependencies. Drafts are checked against the same schema before they're restored.
- **Read-only path**:
  - The content error is reported from an effect, not during render (Sonnet, MiniMax, DeepSeek).
  - The toolbar and Ctrl/Cmd+K are disabled on read-only notes (DeepSeek, GLM).
- **Unload** (Kimi, Terra, Grok). Saves started when the page is hidden or closed use keepalive when they're small, and they stay tracked by the queue. That replaces the untracked keepalive sender.
- **Smaller fixes**:
  - A 404 no longer counts as unsaved, so closing the tab doesn't warn.
  - Create and delete discard any list request still in flight.
  - The "just created" title focus is used once.
  - Malformed `/notes/%…` URLs no longer crash, and a top-level error boundary catches anything else.
  - The sidebar notes when it's showing the latest 200 notes.
  - HSTS is off.
  - An empty `ALLOWED_HOSTS` falls back to the defaults.
  - Update statements are prepared once.
  - Editor options are stable between renders.
  - Link input accepts `host:port`.
  - The "Download raw content" file is released after a delay.
  - The Docker image prunes dev dependencies instead of installing twice.
  - The README restore steps remove SQLite's `-wal` and `-shm` files.

Not changed:

- Retry backoff ignoring `Retry-After` (GLM). A local server never returns 429.
- Paging past 200 notes (Sonnet). The sidebar says so, and search reaches older notes.
- Making the editor read-only while a delete is in flight (Sol, DeepSeek). Edits made during it are saved if the delete fails, and dropped if it succeeds.

## Roadmap after the MVP

- **Phase 2, writing comfort:** tables, images (upload to `/data/uploads`), word count, find and replace, keyboard shortcut help, dark mode.
- **Phase 3, organization:** folders or tags, pinning, trash with restore, full-text search with SQLite FTS5 (Unicode-aware).
- **Phase 4, safety:** conflict detection between tabs (`baseUpdatedAt` → 409), version history, export to Markdown/HTML/PDF/DOCX, import Markdown, automatic backups.
- **Phase 5, reach:** password login, real-time multi-device sync (Yjs + Hocuspocus), comments, sharing.
