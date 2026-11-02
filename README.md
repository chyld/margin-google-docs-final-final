# Margin

A personal "Google Docs" for you and the people you share a computer or home network with: a list of notes and a rich text editor built on [Tiptap](https://tiptap.dev). Everyone signs in and sees only their own notes. Notes, images and fonts are stored on your machine, in one Docker volume.

- [Quick start](#quick-start)
- [Using Margin](#using-margin)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Accounts](#accounts)
- [Backups](#backups)
- [Updating](#updating)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Quick start

You need [Docker](https://docs.docker.com/get-docker/) with Docker Compose (Docker Desktop includes it).

1. **Get the code and start Margin:**

   ```bash
   git clone https://github.com/chyld/margin-google-docs-final-final.git margin
   cd margin
   docker compose up -d --build
   ```

   The first build takes a minute or two. `docker compose ps` shows `healthy` once it's up.

2. **Create your account.** There is no sign-up page; accounts are made from the command line:

   ```bash
   docker compose exec margin margin-user add yourname
   ```

   It asks for a password twice (at least 8 characters; nothing shows while you type). Add `--generate` instead to get a random password printed once.

3. **Open http://localhost:5555 and sign in.**

4. **Optional: use it from your phone or another computer.** On the same network, open `http://<this computer's IP>:5555`. Find the IP with `ip -4 addr` (Linux), `ipconfig getifaddr en0` (macOS), `ipconfig` (Windows), or your network settings.

> **Plain HTTP on your network.** Passwords and notes travel unencrypted between devices and this computer. That's fine on a home network you trust; don't use it on public Wi-Fi. To keep Margin to this computer only, start it with `MARGIN_BIND=127.0.0.1 docker compose up -d`. Docker publishes the port around host firewalls such as ufw.

Everyday commands:

```bash
docker compose ps             # is it running? ("healthy")
docker compose logs -f        # follow the logs
docker compose stop           # stop (your notes stay in the margin-data volume)
docker compose start          # start again
docker compose down           # stop and remove the container (the volume, and your notes, stay)
```

Margin restarts by itself after a reboot (`restart: unless-stopped`).

## Using Margin

### Notes

- **New note:** the **New note** button in the sidebar (or the **+** on a phone). The title field is focused; type a title, then press Enter to start writing.
- **Everything saves as you type.** The status at the top of the note says *Saving…*, *All changes saved*, or what went wrong. Ctrl/⌘+S saves right away. If the connection drops, Margin keeps retrying, and keeps your edits in the browser in case the tab closes. They come back the next time you open the note.
- **Open a note** by clicking it in the sidebar. The newest edits are at the top.
- **Delete a note** with the trash button at the top right of the note. It asks first, and it can't be undone.
- **Home:** the Margin logo (in the sidebar, the collapsed rail, or the phone's top bar) goes home: no note open, with a **New note** button and your tags.
- **Search:** type in the sidebar's search box. It matches titles and text.

### Tags

- Add tags in the field under a note's title. Tags are lowercase letters a–z and digits 0–9, with no spaces. Press Enter, comma or space to add one, or paste `work ideas 2026` to add several. A note can have up to 20.
- Remove a tag with its **×**. Or press Backspace in the empty field to jump to the last tag, then Backspace again to remove it.
- **Click a tag** (on a note, in the sidebar or on the home page) to filter the list by it: Margin puts `#tag` in the search box. Click it again to clear it.
- **Search with tags:** `#work meeting` finds notes tagged *work* that mention "meeting". Several `#tags` must all match.

### Formatting

The toolbar above the page, from left to right:

| Control | What it does |
|---|---|
| Undo, redo | Also Ctrl/⌘+Z and Ctrl/⌘+Shift+Z |
| **Styles▾** | Your saved styles (see below) |
| Paragraph type | Normal text, Heading 1–6 |
| **Font** | The whole Google Fonts catalog, searchable. Click ★ next to a font to pin it to the top of the list; the ★ at the top of the menu favorites the font at the cursor |
| **Size** | In points: −/+, or type a size, or pick a preset |
| **B** *I* <u>U</u> | Bold, italic, underline. **⋯** holds strikethrough and inline code |
| Text color, highlight | 12 colors each |
| Link | Select text, then Ctrl/⌘+K. Ctrl/⌘+click a link to open it (a plain click puts the cursor in it, so links are easy to edit) |
| **Alignment▾**, **Lists▾** | Left, center, right, justify; bulleted, numbered, checklist |
| **＋ Insert▾** | Image, table, collapsible section, quote, code block, horizontal line |
| Table options▾ | Shows while the cursor is in a table: add or delete rows and columns, merge and split cells, header row and column |
| Clear formatting | Back to plain text (Ctrl/⌘+\\) |

Markdown-style typing works too: `# ` for a heading, `- ` or `* ` for a bulleted list, `1. ` for a numbered list, `[ ] ` for a checklist, `> ` for a quote, and three backticks for a code block.

### Images and tables

- **Images:** paste one, drag one in from your computer, or use **＋ Insert▾ → Image**. PNG, JPEG, GIF and WebP are accepted, up to 10 MB each. Drag a corner to resize one. Click an image, then use the alignment menu to place it left, center or right. Images copied from a web page aren't hotlinked; save them to your computer and drop them in.
- **Tables:** **＋ Insert▾ → Table**, then pick a size. Tab moves to the next cell, and Tab in the last cell adds a row. Drag a column edge to resize it.
- **Collapsible sections** have a title line; click the arrow to open or close them. Press Enter on an empty last line to leave the section.

### Saved styles

A style is a named set of formatting you can reuse in every note, like the paragraph styles in a word processor.

- **Make one:** format some text the way you like, then **Styles▾ → Save selection as a style…**. Name it and choose what it includes: font, size, colors, bold, italic, underline, strikethrough, paragraph type and alignment.
- **Use one:** select text (or put the cursor on an empty line) and click the style in **Styles▾**.
- **It keeps going as you type:** Enter starts the next line in the same style, headings included.
- **Change it everywhere:** edit text that uses the style, then choose **Update to match selection** from the **⋯** next to the style. Every place that uses it changes at once.
- **Step out of a style:** any toolbar change (or its shortcut) ends the style from that point. The text keeps its look but is no longer linked, so later edits to the style won't touch it. Clear formatting goes back to plain text.
- **Favorites:** star a style to pin it at the top of the menu. Favorites 1–9 apply with **Ctrl+Alt+Shift+1…9** (⌘⌥⇧ on a Mac).
- **Deleting a style** keeps the look of the text that used it.

### Format sidebar

The panel button at the top right of a note (or Ctrl/⌘+Alt+Shift+\\) shows the formatting at the cursor or selection:
- **What it shows:** paragraph type, alignment, font, size, bold, italic, underline, strikethrough, colors and link.
- **Where each value comes from:** *Direct*, the style's name, *Default*, or how the page draws links, code, quotes and table headers. A selection mixing several values says *Mixed*.
- **Styles:** the text and paragraph style names. Click a name to open the Styles menu.
- **Clear formatting** is at the bottom.

It's docked on wide windows (and each device remembers whether you left it open), floats over the page on medium windows, and slides up from the bottom on phones.

### The sidebar, themes and phones

- **Collapse the sidebar** with the button at its top (or Ctrl/⌘+Shift+\\). The collapsed rail keeps New note, Search and your recent notes, and each device remembers the choice.
- **Light or dark:** Margin follows your system by default. Change it from the menu under your name in the sidebar. The page itself stays white in both themes.
- **Phones:** the notes list is a slide-out menu (☰ at the top left), the toolbar is one row you swipe sideways, and its menus open from the bottom of the screen.

### Your account

- **Sign out** from the menu under your name. Margin waits for the last saves first; if something hasn't saved yet, it asks before signing you out.
- **Sessions last 30 days** after your last visit, and at most 180 days. If your session ends while you're typing, a sign-in box appears over the page and nothing you typed is lost.
- **Forgot your password?** Someone with access to the computer running Margin sets a new one: `docker compose exec margin margin-user passwd yourname`.

## Keyboard shortcuts

Ctrl on Windows and Linux, ⌘ on a Mac (and ⌥ for Alt). Shortcuts that use Shift with a number, `.`, `,` or `\` match the key's position, so they work on any keyboard layout.

| Action | Shortcut |
|---|---|
| Save now | Ctrl+S |
| Undo, redo | Ctrl+Z, Ctrl+Shift+Z (or Ctrl+Y) |
| Bold, italic, underline | Ctrl+B, Ctrl+I, Ctrl+U |
| Strikethrough, inline code | Ctrl+Shift+S, Ctrl+E |
| Highlight | Ctrl+Shift+H |
| Link | Ctrl+K |
| Clear formatting | Ctrl+\\ |
| Font size bigger, smaller | Ctrl+Shift+. , Ctrl+Shift+, |
| Normal text, Heading 1–6 | Ctrl+Alt+0, Ctrl+Alt+1…6 |
| Align left, center, right, justify | Ctrl+Shift+L, E, R, J |
| Numbered, bulleted, checklist | Ctrl+Shift+7, 8, 9 |
| Quote, code block | Ctrl+Shift+B, Ctrl+Alt+C |
| Apply favorite style 1–9 | Ctrl+Alt+Shift+1…9 |
| Show or hide the sidebar | Ctrl+Shift+\\ |
| Show or hide the Format sidebar | Ctrl+Alt+Shift+\\ |

## Accounts

Each account has its own private notes, images, styles and font favorites. Manage accounts with `margin-user`:

```bash
docker compose exec margin margin-user add alice              # asks for the password twice (hidden)
docker compose exec margin margin-user add alice --generate   # prints a random password once
docker compose exec margin margin-user list                   # notes, images, styles and sessions per user
docker compose exec margin margin-user passwd alice           # new password; signs alice out everywhere
docker compose exec margin margin-user rename alice alicia
docker compose exec margin margin-user logout alice           # sign out on every device
docker compose exec margin margin-user sessions alice         # where alice is signed in
docker compose exec margin margin-user delete alice --transfer-to bob   # or --purge to delete her notes
docker compose exec margin margin-user reassign alice bob     # move everything from alice to bob
docker compose exec margin margin-user --help
```

- Names are 1–32 characters: lowercase letters, digits, dot, dash or underscore. Passwords are at least 8 characters.
- When Margin is stopped, use `docker compose run --rm margin margin-user …` instead of `exec`.
- Never run it as root (`docker exec -u root`): the database files must stay owned by the `node` user.
- Without Docker: `npm run user -- add alice` (uses `DATA_DIR`, default `./data`).
- Too many wrong passwords from one device bring a 15-minute pause. Failures for one name from many devices only slow sign-in down, so nobody can lock you out.
- **Data from very old versions** (from before Margin had accounts) must be claimed with an older version first: check out commit `10e17c3`, run `margin-user claim <name>` with it, then come back to the current version. This version opens such a database but can't reach those notes, and says so in the server log.

## Backups

Everything lives in the `margin-data` Docker volume:

| Path | What |
|---|---|
| `/data/margin.db` | Notes, accounts, styles and settings (SQLite) |
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

## Updating

```bash
cd margin
git pull
docker compose up -d --build
```

Your notes stay in the volume. Database changes, if a new version has any, are applied automatically when Margin starts. Taking a [backup](#backups) first is a good habit. To go back, check out the previous version and rebuild. A newer database may be refused by an older version, so restore the backup you took before updating.

## Configuration

Environment variables. With Docker Compose, set them in your shell or in a `.env` file next to `docker-compose.yml` (for example `FONT_DOWNLOADS=off`); compose passes them through:

| Variable | Default | Meaning |
|---|---|---|
| `MARGIN_PUBLIC_PORT` | `5555` | (compose) The port in the browser's address bar, and the port Docker publishes |
| `MARGIN_BIND` | `0.0.0.0` | (compose) Host interface Docker publishes on; `127.0.0.1` keeps Margin to this computer |
| `MARGIN_HOSTS` | (none) | (compose) Extra host names for the address bar, e.g. `mybox.local`. `localhost` and IP addresses always work |
| `FONT_DOWNLOADS` | `on` | `off` stops Margin from ever contacting Google; fonts already cached keep working |
| `COOKIE_SECURE` | `off` | `on` marks the session cookie Secure; only for setups that put HTTPS in front of Margin |

Without Docker, the server reads `PORT` (default `5555`), `PUBLIC_PORT` (`5555`), `HOST` (`127.0.0.1`), `DATA_DIR` (`./data`), `STATIC_DIR` (`dist/web`), `ALLOWED_HOSTS`, `FONT_DOWNLOADS` and `COOKIE_SECURE`.

### Security notes

- Every API route except sign-in and health needs a session. Passwords are hashed with scrypt; the session cookie is `HttpOnly`, `SameSite=Lax`, and only a hash of it is stored. `margin-user` changes (new password, logout, delete) apply on the very next request.
- Notes, images and favorites are private per account: someone else's note or image looks exactly like a missing one. Images are revalidated on each view, so the ownership check always runs.
- A tab still open for one account can never write into another: every request names its account, and a mismatch is refused.
- The `Host` header must be `localhost`, an IP address, or a name from `ALLOWED_HOSTS`, on Margin's port. That blocks DNS-rebinding attacks from web pages (they always use their own domain name).
- API requests from other sites (including other ports on localhost) are rejected, and every write must be JSON, except image uploads, which must be PNG, JPEG, GIF or WebP.
- **The one outbound connection:** the first time a font is used, the server downloads it from `fonts.googleapis.com` / `fonts.gstatic.com` and caches it in the volume. The browser never contacts Google. Only families in the bundled catalog can be requested, redirects are refused, and responses are size-checked and verified before caching. Set `FONT_DOWNLOADS=off` to disable it.
- Uploaded images are checked by their file signature, not just their declared type, and served from Margin's own origin only.
- The server checks note content against the editor's schema before storing it, and strips colors or links it can't vouch for (for example `javascript:` links).
- Two tabs editing the same note at once: the last save wins.

## Troubleshooting

| Problem | What to do |
|---|---|
| The page doesn't load at all | `docker compose ps` should say `healthy`. If not, `docker compose logs` says why. |
| Port 5555 is already used by something else | Start Margin on another port: `MARGIN_PUBLIC_PORT=8080 docker compose up -d`, then open http://localhost:8080. |
| It works on this computer but not from my phone | Use this computer's IP address, not `localhost`, and make sure both are on the same network. Check that you didn't start it with `MARGIN_BIND=127.0.0.1`. |
| "Forbidden host" when using a name like `mybox.local` | Add the name: `MARGIN_HOSTS=mybox.local docker compose up -d`. IP addresses always work. |
| Forgot a password | `docker compose exec margin margin-user passwd yourname` |
| "Too many attempts" | Wait 15 minutes, or sign in from another device. |
| "Signed out. Sign in to keep saving" | Your session ended (expired, or someone signed in as a different user in this browser). Sign in again in the box; nothing you typed is lost. |
| Fonts don't change, or show a fallback | The first use of a font needs internet access (Margin caches it after that). Check that `FONT_DOWNLOADS` isn't `off`. |
| The log says the data directory "is not writable" | See [volume permissions](#volume-permissions). |

### Volume permissions

The container runs as the `node` user (uid 1000). A fresh `margin-data` volume gets the right ownership automatically. If the server says the data directory isn't writable, fix the volume's ownership, or recreate it with `docker compose down -v`. That deletes your notes, so back them up first.

## Development

Requires Node 24 or newer.

```bash
npm install
npm run dev         # Vite on http://localhost:5555, API on 5556 (data in ./data)
npm test            # unit tests (Vitest)
npm run typecheck   # server + web
npm run build       # production frontend into dist/web
npm run e2e         # browser checks (needs Chromium; see below)
```

The dev server and Docker both use port 5555, so stop one before starting the other.

- **Browser checks:** `npm run e2e` builds once, then runs each suite in `e2e/` against its own throwaway server on port 5557, with a fresh database. `e2e/run.sh core styles` runs just those suites. The suites delete data: they refuse port 5555 and refuse to start if something is already listening on 5557. They drive Chromium at `/usr/bin/chromium` (set `CHROMIUM` for another path). Screenshots go to `$MARGIN_SHOTS` (default: a `margin-shots` folder in your temp directory).
- **After deploying**, `MARGIN_REAL_USER=yourname PW=yourpassword node e2e/smoke-real.mjs` opens every note on the real instance without typing anything, checks that images load, then signs that session out.

### How it's put together

- `server/` is a Hono app on Node 24, run directly as TypeScript (Node strips the types; there's no build step). It uses the built-in `node:sqlite`.
  - Type-only imports must use `import type`, and local imports need `.ts` extensions.
  - `app.ts` holds the middleware (host and origin guard, security headers, sessions, body limits, in that order) and turns errors into JSON; `routes/` has the API, one file per area.
  - Each store owns its tables (`notes.ts`, `images.ts`, `styles.ts`, `settings.ts`, `auth.ts` for sessions, `users.ts` for accounts) and is built once in `services.ts`. Moving or deleting an account (`users.ts`) asks each store to move or delete its own rows, in one transaction.
  - `cli.ts` is `margin-user`.
- `shared/` holds what both sides check the same way: the types, the document validator (`doc.ts`), saved-style rules (`styleProps.ts`), image rules (`imageRules.ts`), safe CSS and link values (`safe.ts`) and tag rules (`tags.ts`).
  - `extensions.ts` is the single Tiptap extension list: the editor uses it, and the server checks documents against the schema it produces. When you add an extension, review its attributes in `doc.ts` and add its node and mark names to the lists there; a test fails until they match the schema.
  - `font-catalog.json` is a snapshot of the Google Fonts catalog. Refresh it with `npm run fonts:catalog`.
- `server/images.ts` stores and cleans up images; `server/fonts.ts` is the Google Fonts proxy and cache, and `server/fontCss.ts` checks what Google sends.
- `web/src/` is a React + Vite app.
  - `components/` is UI only. `components/Editor.tsx` sets up Tiptap.
  - `editor/` is editor logic with no React: style commands, what formatting the selection has (`formatInfo.ts`, which both the toolbar and the Format sidebar read), shared commands and shortcuts (`commands.ts`), font sizes, links, and pasting, dropping and uploading images (`imageInput.ts`).
  - `notes/` keeps notes safe: `saveQueue.ts` is the autosave engine (debounced, one request per note at a time, retries), `drafts.ts` and `openNote.ts` handle local drafts, `noteList.ts` keeps the notes list in step with saves, and `useSession.ts` handles the session ending, signing in again and signing out.
  - `state/` holds the small app-wide stores: saved styles, fonts, the Format sidebar, notices, theme, session.
- `e2e/` holds the browser checks.

The `PLAN*.md` files record how Margin was designed and built, phase by phase, including each phase's reviews.

## License

[MIT](LICENSE)
