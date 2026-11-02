# Margin, Phase 2: tables, images, collapsible sections, fonts, headings 1–6, 12 highlights

Status: **v2**, revised after the beta plan review (see "Beta review: what changed from v1" at the end). It builds on the shipped MVP described in `PLAN.md`.

## User decisions (fixed)

| Topic | Decision |
|---|---|
| Features | Tables; images via paste, resizable; collapsible sections; font family and size from Google Fonts with favorites; headings 1–6; 12 highlight colors matching the 12 text colors |
| Font delivery | **Margin caches them.** The server downloads from Google on first use and stores the files in the data volume. The browser never contacts Google. |
| Font list | **Full catalog, searchable** (~1,960 families): category filter, favorites pinned at the top, previews that load as you scroll |
| Image storage | **Files on the server.** Notes store only a link. Unused images are cleaned up. |
| Image extras | Paste (required), **drag-and-drop**, **upload button**, **alignment**. No alt-text editor. |

Verified facts:
- **Packages:** `@tiptap/extension-image`, `-details` and `-table` are at 3.32.2 and installed. `FontFamily` and `FontSize` ship in `@tiptap/extension-text-style`.
- **Schema in Node:** `getSchema()` builds with every new extension, and `.check()` passes on a doc using all of them.
- **Catalog:** the metadata at `https://fonts.google.com/metadata/fonts` is plain JSON (`familyMetadataList`).
  - 1,959 families, 5 categories.
  - Every name matches `[A-Za-z0-9 ]+`, and slugs are unique.
  - Weights are the keys of each family's `fonts` object (`"400"`, `"400i"`, …).
  - `popularity` sorts ascending (Roboto, Open Sans, …).
  - Only four families lack `400`: Buda (300), Molle (400i only), Sunflower (300/500/700) and UnifrakturCook (700).
- **css2 behavior** (verified live by reviewers):
  - It returns **HTTP 400 with an HTML body** when *none* of the requested weight tuples exist.
  - A missing italic is silently dropped.
  - `text=` previews return a `fonts.gstatic.com/l/font?kit=…` URL with a narrow `unicode-range`.

---

## 1. Shared editor schema: `shared/extensions.ts`

The single extension list stays the source of truth for the editor and the server schema check.

```ts
StarterKit.configure({ heading: { levels: [1,2,3,4,5,6] }, link: {...unchanged} })
TextStyle, Color, FontFamily, FontSize
Highlight.configure({ multicolor: true })
TextAlign.configure({ types: ['heading', 'paragraph'], alignments })
TaskList, TaskItem.configure({ nested: true })
TableKit.configure({ table: { resizable: true, cellMinWidth: 48 } })
MarginImage.configure({ inline: false, allowBase64: false,
  resize: { enabled: true, directions: ['top-left','top-right','bottom-left','bottom-right'],
            minWidth: 48, minHeight: 48, alwaysPreserveAspectRatio: true } })
Details.configure({ persist: true, HTMLAttributes: { class: 'details' } }), DetailsSummary, DetailsContent
Placeholder.configure({ includeChildren: true, showOnlyCurrent: false,
  placeholder: ({ node }) => node.type.name === 'detailsSummary' ? 'Section title' : 'Start writing…' })
```

`MarginImage = Image.extend(...)` changes:
- **`align`**: `left | center | right | null`, rendered as and parsed from `data-align`.
- **`width` and `height`**: `parseHTML` reads the attribute or the inline `style` width/height (the resizable node view writes styles, not attributes) and coerces it to a number. This keeps size through copy and paste between notes.
- **`parseHTML`**: `img[src]` with `getAttrs` that **returns `false` unless the src is a Margin image**. A same-origin absolute URL is normalized to `/api/images/<id>.<ext>`.
- **`addInputRules()` returns `[]`.** The inherited Markdown rule `![x](url)` would create images with arbitrary URLs.
- **`addNodeView`** wraps the parent's resizable node view with two local fixes, verified in 3.32.2 source:
  1. **Listener leak:** the constructor registers `handleEditorUpdate.bind(this)` and `destroy()` removes a *different* bound function. The wrapper captures the exact handler (temporarily intercepting `editor.on('update')` during construction) and removes it on destroy.
  2. **Stale size after undo:** `update()` never re-applies width and height. The wrapper's `update` sets `img.style.width/height` from `node.attrs` after the original update returns true.

Other changes:
- `HEADING_LEVELS = [1,2,3,4,5,6]`. The validator derives from it; its "must be 1, 2 or 3" message is updated.
- **No `FileHandler`.** Its `allowedMimeTypes` filtering hides rejected files from callbacks, and `consumePasteEvent` would turn spreadsheet pastes (HTML table plus PNG snapshot) into images. A small client-only `ImageInput` extension (§3.3) replaces it, and the package is uninstalled. Client-only extensions add no schema, so the server schema is unaffected.
- **Stable extension array:** the client list `[...extensions, ImageInput]` is a **module-level constant**, so `useEditor` doesn't call `setOptions` every render.

## 2. Server validation: `shared/doc.ts`

The principle is unchanged: reject unknown structure; normalize harmless variations; clean unsafe *formatting* values to null. New rule: **never silently drop content.** Anything that would lose content is rejected with a clear 400. The save queue treats that as a permanent error, **keeps the local draft** and shows "Couldn't save".

- `NODE_TYPES` += `table, tableRow, tableHeader, tableCell, image, details, detailsSummary, detailsContent`.
- `BLOCK_TYPES` (text extraction) += the table and details nodes, so search and snippets include cell and section text.

| Node / mark | Attribute | Rule |
|---|---|---|
| image | `src` | Must match `^/api/images/[0-9a-f]{64}\.(png|jpg|gif|webp)$`. Otherwise **reject (400 "Image source not allowed")**. The client never creates other srcs: there are no input rules, and paste is filtered. |
| image | `width`, `height` | Number or numeric string, coerced to a number, finite, 1–10000. Otherwise `null`. |
| image | `alt`, `title` | String or number (stringified), ≤ 1000 chars. Otherwise `null`. |
| image | `align` | `left`/`center`/`right`, else `null` |
| tableCell/Header | `colspan`, `rowspan` | Integer (numeric strings coerced) 1–100, else reject. A wrong span corrupts layout, so this is not silently fixed. |
| tableCell/Header | `colwidth` | `null`, or an array of length `colspan` of finite numbers 0–10000. `0` and `null` entries mean "unset", and `null` normalizes to `0`. Fractional values are allowed, because prosemirror-tables writes `0` for spanned or new columns and fractional widths while dragging. Otherwise `null`. |
| tableCell/Header | `align` | `left`/`center`/`right`, else `null` (no `justify`; verified in `parseAlign.ts`) |
| details | `open` | Boolean, else `false` |
| textStyle | `fontFamily` | **Structured** check: a comma-separated list (≤ 10 items, ≤ 300 chars) where each item is a balanced `"…"` or `'…'` string without `\ ; : ( ) { } < >`, or bare words `[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*`. Otherwise `null`. Every catalog name passes (test). |
| textStyle | `fontSize` | `^\d{1,3}(\.\d{1,3})?(pt|px|em|rem|%)$` with value in (0, 400], or a CSS size keyword. Otherwise `null`. |

- **Round-trip property test:**
  - Build docs in Node with the real schema and real commands: prosemirror-tables `addColumnBefore`, `mergeCells`, `splitCell`, column widths; `setDetails`; images with sizes; fonts.
  - Assert `inspectDoc(doc).doc` deep-equals `doc`.
  - Assert `checkSchema` passes.
  - Any value the editor emits must survive the cleaner unchanged.

## 3. Images

### 3.1 Upload: `POST /api/images`

- Raw body. `Content-Type` is exactly `image/png | image/jpeg | image/gif | image/webp` (no SVG).
- **Guard:** the content-type exception is keyed on **method and path** (`POST` + `/api/images`). Every other body route still requires JSON. Neither JSON nor these image types is CORS-safelisted, and forms can't send them. Host, `Sec-Fetch-Site` and Origin checks still apply.
- **Body limits are scoped.** The existing global `bodyLimit(5 MiB)` skips `POST /api/images`, which gets its own 10 MiB limit, so exactly one limit applies to each route. Tests: a 6 MiB upload succeeds; a chunked upload without `Content-Length` over 10 MiB gets 413.
- **Magic bytes must match the declared type**, else 415:
  - PNG `89 50 4E 47 0D 0A 1A 0A`
  - JPEG `FF D8 FF`
  - GIF `GIF87a`/`GIF89a`
  - WebP `RIFF????WEBP`
- **Commit is fully synchronous** once the body has been read. Nothing awaits, so it cannot interleave with the sweep (§3.4) in Node's single thread.
  1. `id = sha256`.
  2. Write `images/.tmp-<rand>` and `renameSync` to `images/<id>.<ext>`. If a trashed copy exists, remove it.
  3. Upsert the row with `unreferenced_since = NULL, trashed_at = NULL`.
- Response `201 { src }`.

### 3.2 Serving: `GET /api/images/:name`

- `:name` is validated with `^[0-9a-f]{64}\.(png|jpg|gif|webp)$` **before** any filesystem access.
- Looks in `images/` and then `images/.trash/`. A trashed hit is **restored**: synchronous rename back, and the row is cleared.
- Headers:
  - `Content-Type` from the extension
  - `Cache-Control: public, max-age=31536000, immutable`
  - `nosniff` and `CORP: same-origin` (from `secureHeaders`)

### 3.3 Client: paste, drop, button (`web/src/imageInput.ts`)

**Paste handling** (own ProseMirror plugin, client-only extension `ImageInput`):
- `handlePaste`: collect `clipboardData.files`.
- If there are none, or if the HTML contains a `<table>` or any text beyond a lone `<img>`, return `false` so ProseMirror pastes the HTML. This handles Excel and Sheets, which also put a PNG snapshot on the clipboard.
- Otherwise handle the image files and return `true`.

**Drop handling**:
- `handleDrop`: if the dataTransfer contains the internal ProseMirror slice, or no files, return `false`.
- Position comes from `posAtCoords`, falling back to the current selection (never position 0).

**Upload button**: a toolbar button opens a hidden `<input type=file multiple accept=…>`.

**Every path** validates each file's type and size (≤ 10 MB) and shows a notice listing what was skipped, e.g. "Skipped drawing.svg: images must be PNG, JPEG, GIF or WebP, up to 10 MB."

**Remote images in pasted HTML**:
- `transformPastedHTML` counts `<img>` elements whose src isn't a Margin image.
- If any, it shows "N images from the web weren't pasted. Save them and drop them in instead."
- `parseHTML` drops them.

**Upload lifecycle** (`createImageUploads`, one per editor):
- Each file gets an id and a **widget decoration placeholder** (spinner box sized to the image's aspect ratio), added via plugin meta and mapped through transactions.
  - Multiple files get placeholders at the same position in order. Each later placeholder uses `side: 1` after the previous one, so they keep their order regardless of completion order.
- **The doc is not touched during upload.** Nothing temporary is ever autosaved; no `blob:` URLs exist.
- **On success**:
  1. Return if `editor.isDestroyed`, or the upload was aborted, or the placeholder no longer exists (its range was deleted). The last case is the user's own action, so there's no notice.
  2. Otherwise, at the placeholder's mapped position: `insertContentAt(pos, {type:'image', attrs:{src, width, height}})`.
  3. Remove the placeholder.
- **On failure**: remove the placeholder and show a notice with the reason.
- **Unsaved-work integration**:
  - Pending uploads count as unsaved work. The save indicator shows "Uploading image…", and `beforeunload` prompts while any are pending.
  - **Switching notes, or the note becoming read-only, aborts pending uploads** (`AbortController`) and shows "Image upload cancelled". The cancel is visible, not silent. Uploads over localhost take well under a second, so this is rare.
- **Initial size**: `createImageBitmap(file)` gives the natural size; `width = min(natural, 624)` (the page's content width), with height by ratio.
- **Notices**: a small dismissible message bar under the toolbar in `NoteView`, shared with font errors.

### 3.4 Cleanup (reworked)

Note content is the **single source of truth**. There's no reference table to drift. Deletion is **two-stage and self-healing**. Every step is synchronous, so the sweep cannot interleave with an upload or save.

```sql
images(id TEXT PRIMARY KEY, ext TEXT NOT NULL, bytes INTEGER NOT NULL,
       created_at INTEGER NOT NULL, unreferenced_since INTEGER, trashed_at INTEGER)
```

**Sweep**: at startup and every 6 h (`setInterval(...).unref()`); injectable clock.
1. **Scan** `SELECT content FROM notes` and collect every `/api/images/<64hex>.` id (a regex over stored JSON).
2. **Referenced** images: set `unreferenced_since = NULL`. If trashed, restore the file and set `trashed_at = NULL`.
3. **Unreferenced, live** images: set `unreferenced_since = now` if it's null. If it's older than **30 days**, move the file to `images/.trash/` and set `trashed_at = now`.
4. **Trashed** images with `trashed_at` older than **30 days**: delete the trash file, then the row.
5. **Heal**:
   - A file in `images/` with no row gets a row (`created_at = mtime`), so a crash between rename and insert is harmless.
   - A row whose file is missing in both places is deleted.
   - `.tmp-*` files older than 1 day are deleted.

**Drafts and undo**:
- Local drafts are invisible to the server. On app load, the client collects image ids from all `margin:draft:*` entries and calls `POST /api/images/touch {ids}` (JSON, ≤ 500 ids). That clears `unreferenced_since` and restores trashed files.
- Any request for a trashed image restores it.
- Any save that references a trashed image restores it at the next sweep.
- So **an image is permanently deleted only after 60 days in which no note referenced it, no draft in an opened browser referenced it, and nothing requested it.**

This replaces v1's `note_images` table and 7-day grace. Reviewers showed that design could delete images still needed by drafts, undo, a stale second tab or a racing save.

### 3.5 Resizing and alignment

- `ResizableNodeView` (with the two fixes in §1): corner handles, ratio locked, min 48 px. Committing a resize writes `width`/`height` in one transaction, which autosaves.
- **Handle CSS** (none ships with Tiptap; handles are 0×0 otherwise):

  ```css
  [data-resize-handle] { width: 10px; height: 10px; background: #fff; border: 1.5px solid #1a73e8;
                         border-radius: 50%; z-index: 2 }
  ```

  Plus per-corner cursors. Handles are visible only while the image is hovered or selected.
- **Fit inside page and cells**:

  ```css
  .document [data-resize-container], .document [data-resize-wrapper] { max-width: 100%; min-width: 0 }
  .document img { max-width: 100% }
  .document [data-resize-container]:not([data-resize-state="true"]) img { height: auto !important }
  ```

  The last rule doesn't apply while dragging, so drag feedback is exact.
- **Read-only**:

  ```css
  .ProseMirror[contenteditable="false"] [data-resize-handle] { display: none }
  ```

  The node view only re-checks editability on `update` events, and Margin toggles editability without one.
- **Alignment**: with an image selected (`NodeSelection`), the align left/center/right buttons set `align` and show its state; justify is disabled. Each alignment maps to `justify-content` on the container:

  ```css
  [data-resize-container][data-node="image"]:has(img[data-align="center"]) { justify-content: center }
  ```

  (and likewise for `right`). Selected image gets an outline.
- **E2E**: assert the **clamped** committed width (e.g. a drag beyond the page width commits ≤ 624).

## 4. Fonts

### 4.1 Catalog: `shared/font-catalog.json` (committed)

- `scripts/update-font-catalog.ts` (`npm run fonts:catalog`) is developer-run only. The app never calls the undocumented metadata endpoint at runtime.
- It reads `familyMetadataList` and **sorts by `popularity` ascending**. No entries are skipped: all 1,959 are open source, and Google serves the brand-flagged ones (Noto, Google Sans) normally (verified).
- Each entry is `{ f: family, k: category, w: [normal weights], i: [italic weights] }`, built from the keys of the `fonts` object.
- Estimated ~100 KB raw, ~25 KB gzipped.
- **Server** reads it with `readFileSync(new URL('../shared/font-catalog.json', import.meta.url))` into `Map<family, entry>` and `Map<slug, family>`. A slug collision gets a numeric suffix (none exist today; there's a test).
- **Client** imports it lazily: `import('../../shared/font-catalog.json')`, a separate chunk. `resolveJsonModule: true` is added to both tsconfigs.

### 4.2 Proxy and cache: `server/fonts.ts`

**Axis tuples** are built from catalog data and used for **both** full and preview CSS:
- Normal: `400` if present, else the closest normal weight, plus `700` if present.
- Italic: `400i` and `700i` if present.
- A family with no normal weights (Molle) gets italic tuples only.
- Tuples are sorted per the css2 spec (ital, then weight, numerically) and URL-encoded.
- Regression fixtures: Buda, Molle, Sunflower, UnifrakturCook, plus a regular-only and an italic-capable family.

**Two independent stylesheet kinds per family**, each with its own manifest, so nothing is ever read-modify-written:
- `fonts/<slug>/full.css` + `full.json`, from `css2?family=…:ital,wght@…&display=swap`.
- `fonts/<slug>/preview.css` + `preview.json`, from the same tuples plus `&text=<family name>`.
  - In `preview.css`, the `font-family` is renamed to `"<Family> Preview"`, so a preview face never competes with the document face.

**Fetching a stylesheet** (cache miss):
1. `fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })`, with a modern desktop Chrome `User-Agent`.
2. **Require** status 200, `content-type` starting with `text/css`, and a streamed body ≤ 512 KB.
3. **Parse `@font-face` blocks.** Each `src: url(...)` must parse as a URL with `protocol === 'https:'`, `hostname === 'fonts.gstatic.com'` and no credentials or port. **A block with any other URL is dropped.**
4. Zero valid blocks → 503, and nothing is cached.
5. Rewrite each URL to `/api/fonts/file/<slug>/<sha1(fullUrl)[0:16]>.<ext>`, where `ext` comes from the block's `format()` hint (`woff2` expected).
6. Write the manifest, then the CSS, each tmp + `renameSync`. **A CSS file counts as a cache hit only if its manifest exists.**
7. **Eager Latin**: after a full stylesheet is cached, download in the background the files for the blocks Google labels `/* latin */` and `/* latin-ext */` (all styles). The common case then works offline right after first use; other scripts stay lazy.

**Fetching a font file**:
- `:slug` must match `^[a-z0-9-]+$` and exist in the catalog; `:file` must match `^[0-9a-f]{16}\.(woff2|woff|ttf)$`. Both are checked **before** any path join, and the resolved path must stay inside `fonts/`.
- **Cache hit**: serve from disk.
- **Otherwise**: the file must be in the full or preview manifest (unknown → 404). Fetch with `redirect: 'error'`, a streamed cap of 5 MB and a **magic-byte check** matching the extension (`wOF2`, `wOFF`, `00 01 00 00`/`true`). Store it (tmp + rename), then serve it.

**Responses**:
- CSS: `Content-Type: text/css; charset=utf-8`, `Cache-Control: no-cache`. The CSS isn't content-addressed; revalidation is cheap.
- Files: `font/woff2` (etc.), `Cache-Control: public, max-age=31536000, immutable`.

**Robustness**:
- Dedupe in-flight requests per key.
- A **global outbound concurrency cap of 4**.
- Failures → 503, never cached.
- `FONT_DOWNLOADS=off` disables outbound requests.
- `createApp({ dataDir, fetchImpl, now })` makes all of this testable without the network.

**Favorites**:
- `GET /api/fonts/favorites` returns `{families}`.
- `PUT /api/fonts/favorites` takes `{families}` (zod strict, ≤ 200, each in the catalog, deduped, order kept) and stores it in `settings` under `fontFavorites`.

### 4.3 Client fonts: `web/src/fonts.ts`

**Family names** are parsed by splitting on commas, trimming, and stripping quotes. Each `textStyle.fontFamily` contributes its **first** family; every distinct one that is in the catalog gets loaded.

**`ensureFont(family)`**:
- Injects `<link rel=stylesheet href="/api/fonts/css?family=…">`, then confirms with `document.fonts.load('1em "<Family>"')`.
- State per family: `loading | ready | failed`. On failure, the link is removed, a notice is shown once, and a later pick may **retry**.

**`ensurePreview(family)`**: the same with the preview CSS. Preview and full state are **separate**.

**When fonts load**: on note open, and after editor updates (debounced 500 ms), the doc JSON is scanned for fonts to load.

**Stored value**: `fontFamily = "<Family>", <generic>`. The generic comes from the category: serif, sans-serif, monospace, cursive (Handwriting); Display uses sans-serif.

### 4.4 Font picker: `web/src/components/FontPicker.tsx`

**Trigger**: a ~140 px toolbar button showing the current first family, or "Arial" (the page default).

**Popover**:
- search box
- category chips (All, Sans Serif, Serif, Display, Handwriting, Monospace)
- **Default (Arial)** row → `unsetFontFamily`
- **Favorites** (★)
- **All fonts** by popularity

**Virtualized list**: 32 px rows, visible window plus overscan, no library. Previews are requested **only after scrolling has been idle for 150 ms**, for visible rows; the server's cap of 4 outbound requests bounds Google traffic.

**Star toggle**: optimistic, serialized `PUT`s, reverts with a notice on failure.

**Keyboard**: ↑/↓, Enter, Esc returns focus to the editor.

**Applying**: `ensureFont`, then `setFontFamily(value)`. With an empty selection this sets the stored mark.

### 4.5 Font size: `web/src/components/FontSize.tsx`

- `[−] [ 11 ] [+]` in pt.
- The input accepts 1–400, applied on Enter or blur; preset dropdown 8 9 10 11 12 14 18 24 30 36 48 60 72 96.
- −/+ step by 1; Ctrl+Shift+. and Ctrl+Shift+, do the same.
- Stored as `"<n>pt"`.
- **Display value**:
  - From the mark: pt as is, px × 0.75 rounded to 0.5.
  - Otherwise the block default: paragraph 11, H1 20, H2 16, H3 14, H4 12, H5 11, H6 11.
  - Blank for `em`, `%` and keywords.
- **Base sizes move to pt**:
  - Paragraph 11pt (was 15 px; visually the same).
  - H1 20, H2 16, H3 14, H4 12 bold, H5 11 bold gray, H6 11 italic gray.

## 5. Tables

- **Insert**: a grid picker popover (10 × 8) runs `insertTable({rows, cols, withHeaderRow: false})`.
- **Table menu** (enabled in a table; items gated by `editor.can()`):
  - insert row above / below
  - insert column left / right
  - delete row, delete column
  - merge cells, split cell
  - toggle header row, toggle header column
  - delete table
- **Column resizing** (`resizable: true`). Verified: the plugin is installed only if the editor is editable at creation, and its mouse handlers check `view.editable` at run time. Margin creates the editor read-only only for unparseable notes, which never become editable, so this is fine; it's documented in code.
- **CSS**: `.tableWrapper` (horizontal scroll), `.column-resize-handle`, `.selectedCell`, borders, padding, `table-layout: fixed`.
- Tab and Shift+Tab move between cells; Tab in the last cell adds a row.
- Pasting tables from web pages and spreadsheets produces table nodes, never images (§3.3).

## 6. Collapsible sections

- **Toolbar button**: `setDetails()` wraps the selected blocks as the content and leaves an empty summary showing the "Section title" placeholder. Focus moves to the summary. Inside a section the button runs `unsetDetails()`, and it is active there.
- `persist: true`: open or closed is stored and autosaves. Read-only toggles aren't persisted (the extension checks `isEditable`).
- **Real DOM** (verified): `div[data-type=details] > button + div > summary + div[data-type=detailsContent][hidden]`.
- **Styles**:
  - The toggle `<button>` is styled as a disclosure triangle that rotates when open.
  - Summary is bold.
  - **`display` is never set on `detailsContent`**, because collapsing uses the `hidden` attribute.
  - Placeholder: `.document summary.is-empty::before { content: attr(data-placeholder) }`. With `showOnlyCurrent: false`, every empty summary shows it. The doc placeholder CSS stays limited to `.is-editor-empty` on the first paragraph, so other empty nodes stay quiet.

## 7. Headings 1–6 and highlights

- **Style select**: Normal text, Heading 1–6. Markdown `#`…`######` and Ctrl+Alt+1…6 are built in.
- **Highlights**: 12 swatches, one light tint per text color in the same order:

| Text | Highlight |
|---|---|
| Black `#202124` | `#d3d4d6` |
| Dark gray `#5f6368` | `#e3e4e6` |
| Gray `#9aa0a6` | `#f1f3f4` |
| Red `#d93025` | `#f6c6c3` |
| Orange `#e8710a` | `#fbd5a5` |
| Yellow `#c69200` | `#fff475` |
| Green `#188038` | `#ccf0d2` |
| Teal `#007b83` | `#c6eef0` |
| Blue `#1a73e8` | `#cbe4fd` |
| Purple `#9334e6` | `#e9d2fd` |
| Pink `#d01884` | `#fdcfe8` |
| Brown `#795548` | `#e6d5cc` |

## 8. Toolbar layout

New order:

1. Undo / Redo
2. Style
3. **Font**
4. **Size**
5. B I U S code
6. Colors
7. Link
8. **Image**
9. **Table**, **Table menu**
10. Alignment
11. Lists
12. Quote, code block, **Collapsible**, HR
13. Clear formatting

`flex-wrap: wrap` with unbreakable groups. Popovers reuse `useDismiss`.

## 9. Database migration 2

```sql
CREATE TABLE images (id TEXT PRIMARY KEY, ext TEXT NOT NULL, bytes INTEGER NOT NULL,
                     created_at INTEGER NOT NULL, unreferenced_since INTEGER, trashed_at INTEGER);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

- Runs in the existing transactional `user_version` migrator.
- Test: a populated v1 database upgrades with notes unchanged; a failing migration rolls back.
- `prepareDataDir` creates and checks `images/`, `images/.trash/` and `fonts/`.
- **Rollback note**: the old image refuses `user_version` 2, so the pre-deploy backup is the rollback path.

## 10. Security summary

- **Guard**:
  - The `Sec-Fetch-Site` check (`same-origin`/`none` only; absent is allowed for curl and the healthcheck) now applies to **all `/api` requests, including GETs**. A page on another site, including another localhost port (same-site), can't trigger font downloads or probe the API.
  - The content-type exception covers exactly `POST /api/images` with four image types.
- **Outbound**: only `fonts.googleapis.com` (URLs built from catalog data) and `fonts.gstatic.com` (exact parsed host, https, `redirect: 'error'`), with timeouts, streamed size caps, magic-byte checks, a concurrency cap and `FONT_DOWNLOADS=off`.
- **Filesystem**: every path param is regex-validated before use; names are content hashes or server-generated.
- **Doc validation**:
  - image `src` locked to Margin's own path (rejected otherwise)
  - font family structurally validated, so it can't break the `style` attribute or its sibling declarations
  - size, alignment and table attributes typed
- **CSP**: `font-src 'self'` explicit; everything else unchanged.

## 11. Testing

**Unit (shared)**:
- cleaner rules in §2, including coercions, `colwidth` zeros and fractions, and rejected image src
- `isSafeFontFamily` (catalog names pass; unbalanced quotes fail) and `isSafeFontSize`
- text extraction from tables and details
- the **round-trip property test** built with real prosemirror-tables commands

**Unit (web)**:
- `imageInput` paste decision: Excel-style HTML table + PNG → not handled; a lone image → handled; SVG → notice
- upload lifecycle with a fake uploader: out-of-order completion keeps order; deleted placeholder → no insert; destroyed editor → no throw
- font-family parsing

**Server**:
- **Upload**:
  - the four types
  - mismatch → 415
  - JSON → 415
  - 6 MiB → 201
  - over 10 MiB, including chunked → 413
  - cross-site → 403
  - dedupe
  - commit restores a trashed copy
- **GET image**: headers; bad name → 404; a trashed file is restored.
- **Sweep**, with a fake clock:
  - referenced images kept
  - unreferenced → trash after 30 days → purged after 60
  - a re-referenced trashed image is restored
  - touch restores
  - heal (row-less file, missing file, tmp)
- **Fonts**, with a mocked fetch:
  - unknown family → 404
  - tuple building (four fixtures)
  - 400/HTML from Google → 503, not cached
  - a non-gstatic block is dropped
  - lookalike host is dropped
  - a redirect fails
  - full and preview manifests are independent in both orders
  - a CSS hit requires a manifest
  - the file magic check
  - traversal attempts (`%2F`, `..`) → 404
  - concurrency cap and dedupe
  - `FONT_DOWNLOADS=off`
  - `text/css` content type
- **Favorites**: validation.
- **Migration**: v1 → v2.
- **Guard**: a cross-site GET → 403.

**E2E** (throwaway instance on port 5557 with a temp `DATA_DIR`; **never the user's container**):
- tables: grid insert, Tab, menu actions, merge and split, column resize, reload
- images:
  - real `ClipboardEvent('paste', {clipboardData})` with a PNG
  - Excel-style paste → table
  - `DragEvent('drop')` at real coordinates
  - upload button
  - SVG notice
  - resize → clamped width saved; undo restores the displayed size
  - align
  - copy and paste between notes keeps size
  - switching notes mid-upload (delayed route) → "cancelled" notice
- collapsible: wrap, placeholder visible, toggle, reload keeps state
- headings H1–H6; 12 highlights
- font size stepper and presets
- the existing 61 checks
- **Fonts against the real network** (Lora, Molle; favorites; cache hit on second load) run once and are **not** part of the repeatable regression gate. The mocked server tests cover the pipeline.

## 12. Rollout

1. `npm test`, `npm run typecheck`, `npm run build`, then e2e on the throwaway instance.
2. **Back up the whole volume** first: `VACUUM INTO` a database copy, then tar the volume into `~/margin-backups/margin-data-<timestamp>.tar.gz` on the host.
3. `docker compose up -d --build`. Migration 2 runs and the healthcheck must turn healthy.
4. Read-only smoke test of the real instance: demo notes open; nothing written.
5. README:
   - back up the whole volume (images and fonts live there)
   - font download behavior, `FONT_DOWNLOADS=off`
   - image retention (30 days unreferenced → trash → purged after 30 more)
   - new shortcuts
6. **Ask the user** before adding a "What's new" demo note to their data.

## Out of scope (later)

- alt text, captions, text wrap, cropping
- importing remote images from pasted HTML (needs SSRF design)
- cell colors, borders, sorting
- recent fonts, weights beyond 400/700, variable axes
- pagination

---

## Beta review: what changed from v1

Reviewers: Claude Sonnet 5.5, GPT-6.1 Sol, GPT-6.1 Terra, Grok 4.7, Muse Wonder 1.0, DeepSeek V4.1 Flash, MiniMax M3.1 Flash, GLM 5.3 Flash, Kimi K3.1 Pro.

Verdicts:
- **needs rework**: Terra, Sol, Kimi
- **approve with changes**: Muse, Sonnet, DeepSeek, GLM, MiniMax, and Grok. Grok's review arrived after implementation had started; all eight of its items were already covered by v2.

**Images**
- **Cleanup redesigned** (§3.4, raised by nearly all): `note_images` and the 7-day grace are gone.
  - Note content is the source of truth; v1's grace didn't cover drafts, undo, stale tabs or races.
  - Deletion is 30 days unreferenced → trash → 30 days → purge.
  - Restore happens on request, reference or draft touch.
  - The sweep and the upload commit are synchronous, so there's no race.
- **Invalid image src is rejected, not replaced** with a paragraph (silent loss, and it could even produce invalid docs). The Markdown image input rule is disabled.
- **Upload limit** (all): the global 5 MiB limit shadowed the image route; limits are now scoped.
- **FileHandler dropped** (Terra, Sol, DeepSeek, MiniMax, Sonnet): it hid rejected files, and `consumePasteEvent` turned spreadsheet pastes into pictures. Replaced by our own paste and drop plugin.
- **Upload lifecycle** (Terra, Sol, Kimi, Muse):
  - `isDestroyed` guards
  - per-upload ids and ordering
  - pending uploads count as unsaved work
  - visible cancel on note switch
- **Resizable image fixes**:
  - handle CSS (DeepSeek: handles were 0×0)
  - container `max-width` (DeepSeek)
  - local fixes for the listener leak (all) and the undo size bug (Sol)
  - width/height parsed from style for copy and paste (MiniMax, Muse)

**Validator**
- **Cleaner mismatches with real editor output** (Sonnet, MiniMax, Muse):
  - `colwidth` zeros and fractions
  - numeric-string coercion
  - cell align without `justify`
  - a round-trip property test added

**Fonts**
- **Font proxy hardening** (all):
  - separate preview and full manifests; preview family renamed
  - status, content-type and `@font-face` validation, so Google's 400 HTML is never cached (Muse, MiniMax)
  - exact host parsing (DeepSeek: `startsWith` accepted lookalikes)
  - `redirect: 'error'`
  - path params validated before use
  - magic bytes
  - `text/css`
  - concurrency cap
  - eager Latin download for offline use
- **Catalog facts corrected** (MiniMax): weights come from `fonts` keys, popularity sorts ascending, tuples come from real weights, the four families without 400 are fixtures, and previews use the same tuples (Sol, Kimi).
- **Client font loading** (Muse, DeepSeek, Sol): quotes stripped, every family in a doc loaded, separate preview and full state, retry after failure.

**Smaller fixes**
- **Details placeholder selector** (all): `<summary>` has no `data-type`; uses `summary.is-empty` with `showOnlyCurrent: false`.
- **Guard** (Kimi): the `Sec-Fetch-Site` check now covers GETs too.
- **Plumbing** (Muse, DeepSeek): `resolveJsonModule`, and `createApp({dataDir, fetchImpl, now})`.
- **Rollout** (Sonnet, Terra): whole-volume backup; the demo note becomes opt-in.

**Not changed**
- **Durable client leases for drafts** (Terra, Kimi): replaced by the touch-on-load call plus a trash that restores itself. A draft only loses an image if that browser isn't opened for 60 days while holding it.
- **Keep uploads alive across note switches** (Kimi): uploads over localhost take well under a second. A visible cancel and the unload prompt are proportionate.

---

## Implementation notes: where the code differs from v2

Found while building and testing; each is covered by a test.

**Images**
- **Inserting doesn't move the cursor.** Tiptap's `insertContentAt` selects a newly inserted image, so the next keystroke or paste replaced it (found by the e2e test). Images now insert with `updateSelection: false`.
- **Empty lines.** On an empty line the image goes *above* the line instead of replacing it, so the cursor ends up below the image. Replacing the line also deleted the placeholders of the other files in a batch.
- **Order.** Files in one paste, drop or upload upload in parallel but are inserted strictly in file order. Inserting as each upload finished reversed them (found by the e2e test).
- **Page content width** is 622 px (816 − 2 × 96 − 2 × 1 px border), not 624.

**Sections**
- **New sections start open.** Tiptap's `setDetails` creates a closed section, which hid the text just wrapped. The toolbar sets `open: true` in the same transaction.

**Smaller differences**
- **Notices** are an app-wide toast area, not a bar under the toolbar. The note view is rebuilt on every note switch, so a bar would lose "Image upload cancelled" at exactly the moment it matters.
- **Font size box** applies on Enter or a preset click. Clicking away discards the typed value instead of applying it on blur.
- **The e2e scripts** (`/tmp/margin-e2e`) refuse to run against port 5555. The broken-note step writes to the throwaway instance's database file (`MARGIN_DB`) instead of running a command in the user's container.

**Verification**
- 238 unit and server tests; `npm run typecheck`.
- 61/61 original e2e checks and 55/55 Phase 2 e2e checks on a throwaway instance (port 5557, temp data). That includes real Google downloads of Lora (regular/italic/bold) and Molle (italic only) through the cache.

---

## Beta code review: what changed after implementation

Verdicts:
- **ship after fixes**: all nine (Terra, Sol, Sonnet, Muse, DeepSeek, MiniMax, GLM, Kimi, Grok)

**Fixed**

*Fonts*
- **Previews of one-word family names never showed** (Sol, Sonnet, MiniMax; verified in Chromium). `document.fonts.load()` tests a space by default, and a `text=` preview subset only contains the letters of the name. 0 faces was treated as failure, and the stylesheet was removed. That hit about 700 families. Now:
  - Previews are tested with the family name.
  - Only a rejected load counts as a failure.
  - Previews retry after 5 s instead of 60 s.
  - New e2e check.
- **Picked fonts waited behind preview downloads** (Muse; verified with a probe). The Google download limiter now has two priorities: document fonts first, previews last. Queued previews are capped at 24 and time out after 15 s. Test added.
- **Favorites could be wiped or lose toggles** (Terra, Sol, Sonnet, Muse, DeepSeek, Kimi, Grok):
  - Toggles wait for the saved list to load, and each one is applied exactly once.
  - Writes send the whole current list, one at a time.
  - Responses only apply if no newer toggle happened (revision counter).
  - Successful PUTs reconcile.
  - The picker refreshes favorites when opened.
- **Font picker focus** (Sol, Sonnet, DeepSeek, Muse): Escape from anywhere in the picker returns to the document, and the category chips keep focus in the search box. e2e check added.
- **Robustness and cleanup** (DeepSeek, Muse, GLM, MiniMax, Kimi):
  - A damaged font manifest reads as "not cached" instead of a 500.
  - A font file Google retired (404/410) drops the cached stylesheet so it's fetched fresh.
  - Stale `.tmp-*` files in `fonts/` are removed at startup.
  - Catalog names are re-validated by the server.
  - A failed catalog chunk load can be retried.

*Images*
- **An image pasted into a section title split the section in two** (Kimi, DeepSeek; verified live). It now goes after the section. If an insertion fails anyway, there's a notice. e2e check added.
- **Image lifecycle details**:
  - In an empty list or task item, the image goes below the item's first line (Sonnet).
  - Internal drags are left to ProseMirror via the `moved` flag (DeepSeek).
  - Dropping onto a read-only note says so (GLM).
  - A file dropped outside the page no longer navigates the tab away (Sonnet).
  - The "web images weren't pasted" notice is decided in `handlePaste`, so Firefox's "Copy image" (file + `<img>`) no longer shows it falsely (GLM).
- **Several images into an empty bullet, checklist item or section title came out reversed** (Grok; reproduced with the real schema). The image goes outside the line holding the placeholder, so every file resolved to the same spot. Each insertion now skips images already sitting there. e2e check added.
- **Touch resizing never committed** (Kimi; verified in source: no `touchend` handler). A touch that started on a handle now finishes like a mouse release.
- **Image cleanup**:
  - Drafts with more than 500 images are touched in batches (Terra, DeepSeek).
  - A request for a live image also resets its unused clock, and a read racing the sweep retries once (Muse).
  - The sweep only loads notes that contain an image link (MiniMax).

*Validator*
- **Pasted tables with odd `colspan`/`rowspan` made a note unsaveable** (Sonnet; verified live). Spans are layout, so they're now clamped to 1–100 instead of rejected.
- **Unknown attributes were stored verbatim** (Muse). The validator now keeps only the attributes the editor's schema defines for each node and mark. Test added.
- **Pasted font values nulled after reload** (Sonnet): sizes with many decimals (e.g. `14.666666666666666px`) and font lists of up to 20 names are accepted.

*Smaller*
- **Size box** (Kimi, MiniMax): −/+ and ↑/↓ step from the number typed in the box.
- **Dead code and duplication removed**: `slugOf`, the duplicate generic-family map, duplicate heading levels, and the always-true `canInsertImage` check.
- **Favorites limit**: the request check and the service agree on 200.

**Not changed**
- **Let non-image file drops fall through** (Muse): inside the page, the browser would open the file and leave Margin. A "skipped" notice is better.
- **Typing over a selected image replaces it** (GLM): standard behavior for a selected object (Word and Google Docs do the same), and undo restores it.
- **Unit tests for the upload lifecycle** (GLM): they need a DOM editor, which the unit tests don't have. The e2e covers order, cancelling on note switch, typing after an insert, and section titles.
- **Stream image responses** (MiniMax): images are capped at 10 MB, and this is a single-user app.
- **"Redundant" `uploaded.catch`** (MiniMax): it isn't redundant. An upload can fail before its turn in the ordered chain, and without it the browser reports an unhandled rejection.
- **Refresh favorites on first open** (MiniMax): the first open already loads them fresh.

**Verification after fixes**
- 242 unit and server tests; `npm run typecheck`.
- e2e on a fresh throwaway instance (port 5558): 61/61 original checks, and 59/59 Phase 2 checks including real Google font downloads.
