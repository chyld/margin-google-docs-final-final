# Margin

A personal "Google Docs" for you and the people you share a computer or home network with: a list of notes and a rich text editor built on [Tiptap](https://tiptap.dev). Everyone signs in and sees only their own notes. Notes, images and fonts are stored on your machine.

## Run it

```bash
docker compose up -d --build
```

Create an account (accounts are made only from the command line; there is no sign-up page):

```bash
docker compose exec margin margin-user add yourname
```

Then open http://localhost:5555 and sign in. Phones and laptops on the same network can use `http://<this computer's IP>:5555` (find the IP with `ip -4 addr` or your network settings).

> **Plain HTTP on your network.** Passwords and notes travel unencrypted between devices and this computer. That's fine on a home network you trust; don't use it on public Wi-Fi. To keep Margin to this computer only, start it with `MARGIN_BIND=127.0.0.1 docker compose up -d`. Docker publishes the port around host firewalls such as ufw.

```bash
docker compose logs -f        # follow the logs
docker compose ps             # shows "healthy" once it's up
docker compose down           # stop (your notes stay in the margin-data volume)
```

## Accounts

Each account has its own private notes, images and font favorites. Manage accounts with `margin-user`:

```bash
docker compose exec margin margin-user add alice              # asks for the password twice (hidden)
docker compose exec margin margin-user add alice --generate   # prints a random password once
docker compose exec margin margin-user list                   # notes, images and sessions per user
docker compose exec margin margin-user passwd alice           # new password; signs alice out everywhere
docker compose exec margin margin-user rename alice alicia
docker compose exec margin margin-user logout alice           # sign out on every device
docker compose exec margin margin-user sessions alice         # where alice is signed in
docker compose exec margin margin-user delete alice --transfer-to bob   # or --purge to delete her notes
docker compose exec margin margin-user reassign alice bob     # move everything from alice to bob
docker compose exec margin margin-user --help
```

- When Margin is stopped, use `docker compose run --rm margin margin-user …` instead of `exec`.
- Never run it as root (`docker exec -u root`): the database files must stay owned by the `node` user.
- Without Docker: `npm run user -- add alice` (uses `DATA_DIR`, default `./data`).
- **Data from before accounts** (Margin before Phase 3) must be claimed with an older version first: run the `margin:phase8` image once and `margin-user claim <name>`. This version opens such a database but can't reach those notes, and says so in the server log.
- Sessions last 30 days after your last visit (at most 180 days). Too many wrong passwords from one device get a 15-minute pause; failures for one name from many devices only slow sign-in down, so nobody can lock you out.

## Features

- Notes list with search across titles and text, newest edits first. The Margin logo (sidebar, collapsed rail, phone bar) goes home: no note open, with New note and your tags.
- **Tags**: add them under a note's title (lowercase a–z and 0–9; Enter, comma or space adds one; paste "a b c" for several; up to 20 per note). The sidebar and home list your tags with counts; clicking one puts `#tag` in the search (click again to clear). Search `#work meeting` for notes tagged *work* that mention "meeting"; several `#tags` must all match.
- A full-width page beside the sidebar with a compact one-row toolbar:
  - undo and redo
  - **Styles▾**: saved styles (see below)
  - paragraph type (normal text, headings 1–6)
  - **fonts**: the whole Google Fonts catalog, searchable, with favorites (★) pinned at the top; the ★ at the top of the menu favorites the font at the cursor
  - **font size** in points: −/+ buttons, a size box with presets, Ctrl/Cmd+Shift+. and Ctrl/Cmd+Shift+,
  - bold, italic, underline; **⋯** holds strikethrough and inline code
  - text color and highlight color (12 each; the highlights are tints of the text colors), and links (Ctrl/Cmd+K; Ctrl/Cmd+click opens one)
  - **alignment▾** and **lists▾** (bulleted, numbered, checklist)
  - **＋ Insert▾**: image (also paste or drag in; PNG, JPEG, GIF, WebP up to 10 MB; drag a corner to resize), table (pick a size; Tab moves between cells), collapsible section, quote, code block, horizontal line
  - **table options▾** (rows, columns, merge/split, header row/column) appear while the cursor is in a table
  - clear formatting (Ctrl/Cmd+\\)
- **Saved styles.** Format some text, then **Styles▾ → Save selection as a style…**, name it and pick what it includes (font, size, colors, bold/italic/underline/strike, paragraph type, alignment). Click a style to apply it anywhere, in any of your notes. Editing a style ("Update to match selection", from the ⋯ next to it) restyles every place it's used at once. A style keeps going as you type: Enter starts the next line in the same style (headings included), and empty styled lines keep it too. Any formatting-bar change (or its shortcut) ends the style from that point: the text keeps its current look but is no longer linked, so later edits to the style won't touch it. Clear formatting goes back to plain text. If a style can't be applied (for example inside a code block), a short notice says why. Deleting a style keeps the look of text that used it. Star styles to pin them at the top; favorites 1–9 apply with **Ctrl+Alt+Shift+1…9** (⌘⌥⇧ on a Mac).
- **Format sidebar** (the panel button at the top right of a note, or Ctrl/⌘+Alt+Shift+\\): shows the formatting at the cursor or selection — paragraph type, alignment, font, size, bold/italic/underline/strike, colors, link — each marked with where it comes from (Direct, the style's name, Default, or how the page draws links, code, quotes and table headers), plus the text and paragraph style names ("Mixed" for mixed selections). The style name opens the Styles menu; Clear formatting is at the bottom. Docked on wide windows (remembered per device), floating on medium ones, a bottom sheet on phones.
- **Collapsible sidebar**: the button at its top (or Ctrl/Cmd+Shift+\\) shrinks it to a slim rail with New note, Search and your recent notes. Each device remembers the choice.
- Autosave while you type, with a status indicator. Ctrl/Cmd+S saves immediately.
- Edits that haven't reached the server are kept in the browser (`localStorage`, per account) and restored if the tab closes or reloads first. If your session ends while you're typing, a sign-in box appears and nothing is lost.
- "Ink & Ochre" look: warm paper neutrals, ink-black type and one ochre accent, in light and dark themes (follows your system unless you pick one). The page itself stays white in both. The UI and the page's default font are IBM Plex Sans, bundled with the app so it works offline. Every color pair is checked for WCAG AA contrast by `scripts/theme.test.ts`.
- Works on phones: the notes list becomes a slide-out menu and toolbar menus open from the bottom.

## Backups

Everything lives in the `margin-data` Docker volume:

| Path | What |
|---|---|
| `/data/margin.db` | Notes and settings (SQLite) |
| `/data/images/` | Uploaded images, named by the SHA-256 of their bytes |
| `/data/fonts/` | Cached Google Fonts (can be re-downloaded, but needed offline) |

Back up the whole volume. The first command takes a consistent copy of the database while Margin runs; the second archives it together with the images and fonts:

```bash
stamp=$(date +%Y%m%d-%H%M%S)
docker compose exec margin node -e "new (require('node:sqlite').DatabaseSync)('/data/margin.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker run --rm -v margin_margin-data:/data -v "$PWD":/backup alpine \
  tar czf "/backup/margin-$stamp.tar.gz" -C /data backup.db images fonts
docker compose exec margin rm /data/backup.db
```

To restore an archive:

```bash
docker compose stop
docker run --rm -v margin_margin-data:/data -v "$PWD":/backup alpine sh -c '
  rm -rf /data/margin.db /data/margin.db-wal /data/margin.db-shm /data/images /data/fonts &&
  tar xzf /backup/margin-YYYYMMDD-HHMMSS.tar.gz -C /data &&
  mv /data/backup.db /data/margin.db && chown -R 1000:1000 /data'
docker compose start
```

Removing the `-wal` and `-shm` files matters: SQLite would otherwise replay them onto the restored copy.

### Image cleanup

An image is a file in the volume; notes only link to it. Every 6 hours Margin checks which images no note uses. One that stays unused for 30 days moves to `/data/images/.trash`, and is deleted for good after 30 more days. Anything that uses a trashed image again (opening a note or a restored draft that shows it, or saving a note that contains it) brings it back.

## Configuration

Environment variables. With Docker Compose, set them in your shell or a `.env` file next to `docker-compose.yml` (for example `FONT_DOWNLOADS=off`); compose passes them through:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5555` | Port the server listens on |
| `PUBLIC_PORT` | `5555` | Port the browser uses (it names the session cookie). With compose, set `MARGIN_PUBLIC_PORT`, which also changes the published port |
| `HOST` | `127.0.0.1` | Interface to bind (`0.0.0.0` inside Docker) |
| `MARGIN_BIND` | `0.0.0.0` | (compose) Host interface Docker publishes on; `127.0.0.1` keeps Margin to this computer |
| `DATA_DIR` | `./data` | Folder for `margin.db`, `images/` and `fonts/` |
| `FONT_DOWNLOADS` | `on` | `off` stops Margin from ever contacting Google; fonts already cached keep working |
| `ALLOWED_HOSTS` | (none) | Extra host names for the address bar, e.g. `mybox.local` (set `MARGIN_HOSTS` for compose). `localhost` and IP addresses on Margin's port always work |
| `COOKIE_SECURE` | `off` | `on` marks the session cookie Secure; only for setups that put HTTPS in front of Margin |

### Security notes

- Every API route except sign-in and health needs a session. Passwords are hashed with scrypt; the session cookie is `HttpOnly`, `SameSite=Lax`, and only a hash of it is stored. `margin-user` changes (new password, logout, delete) apply on the very next request.
- Notes, images and favorites are private per account: someone else's note or image looks exactly like a missing one. Images are revalidated on each view, so the ownership check always runs.
- A tab still open for one account can never write into another: every request names its account, and a mismatch is refused.
- The `Host` header must be `localhost`, an IP address, or a name from `ALLOWED_HOSTS`, on Margin's port. That blocks DNS-rebinding attacks from web pages (they always use their own domain name).
- API requests from other sites (including other ports on localhost) are rejected, and every write must be JSON, except image uploads, which must be PNG, JPEG, GIF or WebP.
- **The one outbound connection**: the first time a font is used, the server downloads it from `fonts.googleapis.com` / `fonts.gstatic.com` and caches it in the volume. The browser never contacts Google. Only families in the bundled catalog can be requested, redirects are refused, and responses are size-checked and verified before caching. Set `FONT_DOWNLOADS=off` to disable it.
- Uploaded images are checked by their file signature, not just their declared type, and served from Margin's own origin only. Images pasted from web pages are not hotlinked.
- The server checks note content against the editor's schema before storing it, and strips colors or links it can't vouch for (for example `javascript:` links).
- Two tabs editing the same note at once: the last save wins.

### Volume permissions

The container runs as the `node` user (uid 1000). A fresh `margin-data` volume gets the right ownership automatically. If the server says the data directory isn't writable, fix the volume's ownership, or recreate it with `docker compose down -v`. That deletes your notes, so back them up first.

## Development

Requires Node 24 or newer.

```bash
npm install
npm run dev         # Vite on http://localhost:5555, API on 5556 (data in ./data)
npm test            # Vitest
npm run typecheck   # server + web
npm run build       # production frontend into dist/web
```

The dev server and Docker both use port 5555, so stop one before starting the other.

### How it's put together

- `server/` is a Hono app on Node 24, run directly as TypeScript (Node strips the types; there's no build step). It uses the built-in `node:sqlite`.
  - Type-only imports must use `import type`, and local imports need `.ts` extensions.
- `shared/` holds the types and the document validator (`doc.ts`), used by both sides.
  - `extensions.ts` is the single Tiptap extension list: the editor uses it, and the server checks documents against the schema it produces. When you add an extension, review its attributes in `doc.ts` and add its node and mark names to the lists there; a test fails until they match the schema.
  - `font-catalog.json` is a snapshot of the Google Fonts catalog. Refresh it with `npm run fonts:catalog`.
- `server/images.ts` stores and cleans up images; `server/fonts.ts` is the Google Fonts proxy and cache.
- `web/src/` is a React + Vite app.
  - `components/` is UI only. `components/Editor.tsx` sets up Tiptap.
  - `editor/` is editor logic with no React: style commands, what formatting the selection has (`formatInfo.ts`), font sizes, links, and pasting, dropping and uploading images (`imageInput.ts`).
  - `notes/` keeps notes safe: `saveQueue.ts` is the autosave engine (debounced, one request per note at a time, retries, local drafts).
  - `state/` holds the small app-wide stores: saved styles, fonts, the Format sidebar, notices, theme, session.
- `e2e/` holds the browser checks: `npm run e2e` (or `e2e/run.sh <suite>`) starts a throwaway server on port 5557 for each suite. Never point them at real data.

See `PLAN.md` for the design and the roadmap, and `PLAN-PHASE2.md` for tables, images, sections and fonts.
