# Margin, Phase 3: accounts, a command-line user tool, and a candy-pastel redesign

Status: **v2**, revised after the beta plan review by nine models. **Section 10 overrides earlier sections wherever they disagree.** This phase builds on Phase 2, which is shipped and running. See `PLAN.md` and `PLAN-PHASE2.md` for the current design.

## User decisions (fixed)

| Topic | Decision |
|---|---|
| Login | Username and password. Accounts are created only from the command line; there is no sign-up page. |
| Notes | **Private per user.** Each user sees only their own notes, images and font favorites. The existing notes, images and favorites go to the first account created. |
| Network | **Open to the local network.** Phones and laptops on the Wi-Fi can use Margin. The user accepted that this is plain HTTP, with no TLS. |
| Style | **Candy pastel:** soft mint, peach, lilac, sky, butter and pink. Friendly, light and playful, but still modern and sleek. |
| Dark mode | **Light and dark, following the system**, with a manual override. The document page itself stays white in both themes, so the 12 text colors and 12 highlights look the same. |

Current state, for reviewers:
- **Stack:** Node 24 runs `.ts` directly, with `node:sqlite`, Hono 4.13, React 19, Tiptap 3.32.2 and Vite 8, in Docker Compose.
- **Data:** 6 real notes and 4 images live in the `margin-data` volume.
- **Request guard (`server/guard.ts`):**
  - Rejects any Host not on an allowlist; the default list is `localhost`, `127.0.0.1` and `[::1]` on the port.
  - Requires `Sec-Fetch-Site` to be same-origin or none on every `/api` request.
  - Requires the Origin to match on writes.
  - Requires JSON content types, except for image upload.
- **Save queue (`web/src/saveQueue.ts`):**
  - Retries network errors, 5xx, 408 and 429.
  - Treats 404 as final ("This note was deleted"), which discards the draft. Every other 4xx is a permanent error.
  - Drafts live in localStorage under `margin:draft:<noteId>`.
- **Server state:** settings (font favorites) are one global row in `settings`. The image store and sweep are global; images are content-addressed (SHA-256) and served with `Cache-Control: public, immutable`.

---

## 1. Data model: migration 3

```sql
CREATE TABLE users (
  id                   TEXT PRIMARY KEY,               -- randomUUID()
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,                  -- "scrypt$N$r$p$saltB64$hashB64"
  created_at           INTEGER NOT NULL,
  password_changed_at  INTEGER NOT NULL
);
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,                      -- SHA-256 hex of the cookie token, never the token
  user_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  user_agent    TEXT NOT NULL DEFAULT ''               -- first 200 chars, for `margin-user sessions`
);
CREATE INDEX sessions_user ON sessions (user_id);
ALTER TABLE notes ADD COLUMN user_id TEXT;             -- NULL = not yet claimed (pre-Phase-3 notes)
CREATE INDEX notes_user_updated ON notes (user_id, updated_at DESC, id DESC);
CREATE TABLE image_owners (
  image_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (image_id, user_id)
);
CREATE TABLE user_settings (
  user_id  TEXT NOT NULL,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
```

- **No `FOREIGN KEY` enforcement.** The connection never turns on `PRAGMA foreign_keys`, and `ALTER TABLE` can't add a constraint to existing rows anyway. Deleting a user removes all their rows in one explicit transaction (§4).
- **Claiming legacy data.** When the **first** user is created, one `BEGIN IMMEDIATE` transaction does all of this:
  - `UPDATE notes SET user_id = ? WHERE user_id IS NULL`
  - inserts an `image_owners` row for every image
  - moves `settings.fontFavorites` into `user_settings` and deletes the old row

  The CLI prints what it claimed ("Claimed 6 existing notes and 4 images"). Notes with `user_id IS NULL` are invisible to everyone until claimed, so the window between the upgrade and the first `add` is safe. A `claim <username>` command exists for the case where the first account was deleted before claiming (rare; it claims any remaining `NULL` notes).
- The global `settings` table stays for future app-wide settings and is otherwise unused.

## 2. Passwords and sessions (`server/auth.ts`)

**Hashing:**
- `crypto.scrypt` (async, so it doesn't block the event loop) with N=2^15, r=8, p=1, a 16-byte random salt, a 64-byte key and `maxmem` = 64 MiB.
- The parameters are stored in the hash string, so they can be raised later. A successful login with outdated parameters re-hashes the password.
- Verification uses `timingSafeEqual`.
- A login for an unknown username still runs scrypt against a fixed dummy hash, so its timing matches a wrong password.
- Passwords are 8 to 1024 characters. NFC normalization is applied before hashing.

**Usernames:** `^[a-z0-9][a-z0-9._-]{1,31}$`, stored lowercase, unique without regard to case.

**Session token:**
- 32 bytes from `randomBytes`, base64url-encoded. Only its SHA-256 is stored.
- The cookie is `margin_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`.
- `Secure` is added only when `COOKIE_SECURE=on`, for anyone who later puts Margin behind HTTPS. It can't be on by default: the cookie would never be sent over plain HTTP.

**Lifetime:**
- 30 days of inactivity (sliding window), with an absolute cap of 180 days from creation.
- `last_seen_at` and `expires_at` are written at most once an hour per session, and the cookie is re-sent then, so a page load doesn't mean a database write.
- Expired sessions are deleted at startup and on the existing 6-hour timer.

**Session cache:** none. Each authenticated request does one indexed `SELECT` joining sessions and users. As a result, deleting a user or revoking sessions from the CLI takes effect on the very next request.

**Login rate limit** (in memory, reset on restart):
- Keyed by client IP **and** by username:
  - at most 10 failures per (IP, username) in 15 minutes
  - at most 30 failures per IP in 15 minutes
  - at most 50 failures per username in 15 minutes, across all IPs
- Past a limit, the server returns `429` with `Retry-After`.
- A success clears the counters for that (IP, username).
- **Why there is no hard lockout:** a hostile device on the Wi-Fi must not be able to lock the owner out forever. The per-username cap slows a distributed guesser and recovers after 15 minutes.
- **Client IP:** taken from the socket (`c.env.incoming.socket.remoteAddress`). `X-Forwarded-For` is ignored unless `TRUST_PROXY=on`.
- **Concurrent hashing:** at most 4 scrypt hashes run at once. Extra login requests wait in a queue of up to 20; beyond that they get `503`. This keeps a flood of logins from pinning the CPU.

## 3. Server routes and the guard

**New routes (JSON, all through the existing guard):**

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/auth/login` `{username, password}` | none | 200 `{user:{id,username}}` and the cookie. 401 `{error:"Wrong username or password"}` (one message for both cases). 429 or 503 as in §2. Logging in while already signed in replaces the old session. |
| `POST /api/auth/logout` | optional | Deletes the session row if there is one, clears the cookie, returns 204. Always succeeds. |
| `GET /api/auth/me` | optional | 200 `{user}`, or 401 `{error, setupNeeded}`. `setupNeeded` is true when no users exist, so the login screen can show the `margin-user add` command. |
| `GET /api/health` | none | Unchanged (the Docker health check uses it). |

**Every other `/api` route requires a session.** Without one it returns `401 {error:"Sign in required"}`. An `auth` middleware sets `c.var.user`.

**Per-user scoping:**
- **Notes:** every query in `server/notes.ts` gains `AND user_id = :userId`, and inserts set it. Another user's note id gives 404, exactly like a missing note. This covers search too.
- **Images:**
  - Upload saves the file once, as now (content-addressed), and adds an `image_owners` row for the uploader. Re-uploading identical bytes as another user just adds that user's row.
  - `GET /api/images/:name` requires an owner row for the current user; otherwise it returns 404. Responses change to `Cache-Control: private, max-age=31536000, immutable`.
  - `POST /api/images/touch` only acts on ids the user owns.
  - The sweep stays global: references are counted across all notes. When an image is purged, its `image_owners` rows are deleted.
  - Saving a note does **not** grant ownership of an image it references; knowing a hash is not enough to read another user's image.
- **Fonts:**
  - CSS and font files require a session, so unauthenticated devices can't use Margin as a download proxy.
  - The cache stays shared, since these are public Google fonts.
  - Favorites move to `user_settings (user_id, 'fontFavorites')`. `FontService.getFavorites(userId)` and `setFavorites(userId, families)` take the user.

**Guard changes for LAN access:**
- **Host allowlist.** A Host is allowed when its port equals `PUBLIC_PORT` or `PORT`, and its name is one of:
  - `localhost`
  - **any IPv4 or bracketed IPv6 literal**
  - a name listed in `ALLOWED_HOSTS` (e.g. `mybox.local`)

  Allowing IP literals is safe against DNS rebinding: in a rebinding attack the Host header is always the attacker's domain name, never an IP literal. It also means the DHCP address of the laptop can change without editing any config.
- **Origin check.** On writes, Origin must equal `http://<Host>`, or `https://<Host>` when `COOKIE_SECURE=on`. That is a true same-origin check, instead of a fixed list.
- **Unchanged:** the `Sec-Fetch-Site` and JSON content-type rules. They already make login CSRF and cross-site API calls impossible.

**Docker Compose:**
- `ports: "5555:5555"` (all interfaces).
- The README notes:
  - Docker publishes the port around host firewalls such as ufw.
  - On an untrusted network, use `127.0.0.1:5555:5555`.
  - Phones open `http://<laptop-ip>:5555`.
- `index.ts` logs the LAN addresses it can see. Inside Docker it sees only the container's address, so the README explains `ip -4 addr` instead.

## 4. Command-line user tool (`server/cli.ts`, run as `margin-user`)

The Dockerfile adds a script, `/usr/local/bin/margin-user` → `exec node /app/server/cli.ts "$@"`. Usage from the host:

```
docker compose exec margin margin-user add alice            # prompts for the password twice (hidden)
docker compose exec margin margin-user add alice --generate # prints a random 20-char password once
docker compose exec -T margin margin-user add alice --password-stdin < pw.txt
docker compose exec margin margin-user list                 # username, created, notes, active sessions, last seen
docker compose exec margin margin-user passwd alice         # new password; signs out all of alice's sessions
docker compose exec margin margin-user rename alice alicia
docker compose exec margin margin-user logout alice         # revoke all sessions
docker compose exec margin margin-user sessions alice       # created / last seen / user agent
docker compose exec margin margin-user delete alice         # asks "type alice to confirm"; --yes skips. Deletes notes, sessions, settings, image ownership
docker compose exec margin margin-user claim alice          # gives alice any unowned notes and images
```

Locally, without Docker: `npm run user -- add alice`.

- **Database access.** The tool uses the same `DATA_DIR`, `openDatabase()` (so migrations run) and WAL with `busy_timeout`. It is safe while the server runs, because the server keeps no auth cache.
- **Ownership.** The image ships with `USER node`, so files the CLI creates stay owned by node. `docker compose exec` runs as that user.
- **Hidden input.** Password prompts use raw-mode TTY reading with echo off. With no TTY, the tool requires `--password-stdin` or `--generate` and exits with an error otherwise.
- **Output.** Exit codes are 0 for success, 1 for a usage error, and 2 for a not-found or conflict. Messages are friendly, and `--help` lists every command.

## 5. Client: authentication flow

- **`api.ts`:** a 401 from any route except `auth/login` and `auth/me` calls the registered `onUnauthorized` handler, then throws `ApiError(401)` as before.
- **`Root.tsx`** (new top component in `main.tsx`):
  - `checking`: a pastel splash with a spinner; it calls `/api/auth/me`.
  - `signedOut`: shows `<LoginScreen>`, including the `margin-user add` hint when `setupNeeded`.
  - `signedIn(user)`: shows `<App user={user} key={user.id}>`.
- **Session expired mid-use (401 while signed in):**
  - `App` stays mounted, so the editor keeps its content and the save queue keeps its pending edits.
  - The login card shows as a **modal overlay**, with the username prefilled and the message "Your session ended. Sign in again to keep saving."
  - Signing in again as the **same** user closes the overlay, calls `queue.retryAll()` and reloads the note list. A note that failed to load with 401 retries on its own, because `App` bumps a `sessionEpoch` that NoteView watches.
  - Signing in as a **different** user (the "Not you?" link) runs `queue.persistDrafts()`, signs in, then does a full page reload. Module state, such as font favorites and caches, can't leak between users.
- **Save queue:**
  - 401 joins the retryable statuses, with the message "Signed out. Sign in to keep saving", so edits are never discarded.
  - New `retryAll()` retries every waiting entry immediately.
  - `beforeunload` already warns when anything is unsaved.
- **Drafts are namespaced per user:** `margin:draft:<userId>:<noteId>`.
  - `createSaveQueue` takes the prefix, and `touchDraftImages` scans only that prefix.
  - Legacy `margin:draft:<noteId>` keys are re-keyed to the first user who signs in on that browser (one-time, flagged in localStorage). In practice there are none today; all notes are saved.
- **Sign out (user menu):** shows "Saving…", runs `queue.flushAll()` and waits for in-flight saves (up to 5 s). Then:
  - If anything is still unsaved, it asks "Sign out anyway? Unsaved edits stay on this device and save the next time you sign in", and keeps those drafts.
  - Otherwise, or once confirmed, it calls `POST /api/auth/logout` and does a full reload to `/`.
- **Login screen:**
  - Username and password fields, a show/hide password toggle, and "Sign in" with a loading state. The username field gets focus first.
  - Errors appear inline with a short wobble. A 429 shows "Too many attempts. Try again in N minutes."
  - The fields use `autocomplete="username"` and `autocomplete="current-password"`, so password managers work.
  - It is a real `<form>` (Enter submits), but submission happens through `fetch`.

## 6. Redesign: "Candy pastel", light and dark

**Principles:**
- Playful color in the app's frame; calm, white paper for the document.
- Rounded shapes, generous spacing, soft shadows and small, springy motion.
- Readable contrast in both themes (WCAG AA for text). All motion is turned off under `prefers-reduced-motion`.

**Theme plumbing:**
- `web/public/theme.js` is a tiny external script loaded in `<head>` before CSS paints; inline scripts are blocked by the CSP.
  - It reads `localStorage['margin:theme']` (`system` | `light` | `dark`) and sets `<html data-theme="light|dark">`.
  - It follows `matchMedia('(prefers-color-scheme: dark)')` changes while set to system.
- The setting is per device: the login screen needs it before anyone is signed in.
- **UI font:** Nunito, bundled through `@fontsource-variable/nunito` and served from `/assets`, so the CSP font-src `'self'` still holds. Document text keeps its Arial default, so existing notes look identical.

**Design tokens** (CSS custom properties in `app.css`; values are starting points to tune):

| Token | Light | Dark |
|---|---|---|
| `--bg` (app canvas) | `#fbf7ff` with soft radial blobs of lilac, mint and peach | `#1b1530` with dim plum and teal blobs |
| `--surface` (sidebar, toolbar, menus) | `rgb(255 255 255 / 72%)` with backdrop blur | `rgb(40 32 66 / 78%)` with backdrop blur |
| `--text` / `--muted` | `#2d2640` / `#6f6787` | `#f3eeff` / `#b3a9cf` |
| `--accent` (primary) | lilac `#8b6cf0` → pink `#f07ab4` gradient for primary buttons | same hues, lighter: `#a891ff` → `#ff9cc8` |
| Candy set | mint `#7fdcc0`, peach `#ffb59a`, lilac `#b9a2ff`, sky `#8fcbff`, butter `#ffe08a`, pink `#ff9cc8` | same hues at lower lightness for fills, full for accents |
| `--radius` | 14px for cards and menus, 999px for pills | same |
| Shadows | soft colored (`0 8px 24px rgb(139 108 240 / 14%)`) | deeper, with a faint glow |

**Components:**
- **Login screen:**
  - A full-screen pastel canvas with floating blurred blobs that drift slowly.
  - A frosted white card holding the logo, "Welcome back" and the form.
  - A gradient "Sign in" pill. The card pops in when it appears.
- **Sidebar:**
  - Frosted panel; the brand at the top with the new candy logo.
  - A gradient "New note" pill and a rounded search field.
  - Note list items are rounded cards. Each note gets a candy color derived from a hash of its id, shown as a dot and a tinted hover. The active card has a tinted background and a colored left bar.
  - Relative times are kept.
- **User chip** (bottom of the sidebar):
  - An avatar circle with the user's initial on a candy color derived from the username, plus the username.
  - Its menu has Theme (System / Light / Dark, as a segmented control) and Sign out.
- **Note header and toolbar:**
  - The title input sits on the canvas.
  - The toolbar becomes a floating rounded frosted bar that stays pinned while the page scrolls. Groups are separated by soft dividers, and buttons are round-cornered chips with candy hover tints. The active state is a lilac fill.
  - Dropdowns (headings, font picker, sizes, colors, highlights, table menu, link popover) restyle onto the same surface, radius and shadow tokens.
  - The 12 color and highlight swatches keep their exact values.
- **The page:** stays white with a soft shadow on the pastel canvas, like paper on a desk, in both themes.
  - Inside the document, only UI accents change: selection color, placeholder color, the selected-cell tint and resize handle in tables, the image resize handles and focus ring, and the section triangle.
  - Content colors are untouched.
- **Notices and banners:** pastel toasts that slide up from the bottom, color-coded (mint for info, peach for warnings, pink-red for errors).
- **Empty state and crash screen:** a cheerful inline-SVG illustration of a stack of pastel paper and a pencil, with friendly copy.
- **Save status:** a small pill: mint "Saved", butter "Saving…", peach "Retrying", pink "Not saved".
- **Favicon:** a new candy-colored mark.

**Responsive layout** (new: LAN access means phones):
- **Up to 760px:**
  - The sidebar becomes a slide-over drawer, opened by a menu button in the note header. A scrim closes it, Escape closes it, and opening a note closes it.
  - The toolbar scrolls horizontally in one row.
  - The page goes edge-to-edge with smaller padding.
- **Tablet widths** keep the sidebar at a narrower width.
- **Touch targets** are at least 40px. The existing touch-resize support for images keeps working.

**Motion** (all under `@media (prefers-reduced-motion: no-preference)`):
- 120–180 ms ease-out for hovers.
- Primary buttons get a slight press "squish" (scale .97).
- Menus fade and scale in from 0.98.
- Toasts slide in.
- The login card pops in, and errors wobble.
- Nothing animates layout or blocks typing.

## 7. Testing

**Server unit tests (Vitest):**
- hash round-trip, re-hashing of outdated parameters, timing with the dummy hash path
- session create, lookup, slide, absolute cap, expiry and cleanup
- the rate limiter: each key, Retry-After, and reset on success
- the scrypt concurrency queue

**Server API tests:**
- 401 on every protected route; login, logout and me; the cookie flags
- `COOKIE_SECURE`
- **isolation:** user B can't list, get, patch or delete A's notes, can't get A's image, can't touch it, and can't see A's favorites
- an image uploaded by both users is readable by both
- purge removes the owner rows
- guard: IP literal hosts are allowed, foreign names are rejected, the Origin must match the Host, and the port must match

**Migration test:** a version-2 database with notes, images and favorites, migrated, then the first `add` claims everything, and a second `add` claims nothing.

**CLI tests:** spawn `node server/cli.ts` against a temp `DATA_DIR`:
- add (stdin and generate), list, passwd (revokes sessions), rename, logout, delete (removes rows; `--yes`), claim
- exit codes and the non-TTY error

**Client unit tests:**
- the save queue treats 401 as retryable and `retryAll` works
- draft prefixes are per user
- legacy drafts are re-keyed

**End to end** (Playwright against throwaway instances only; never port 5555):
- `e2e.mjs` and `phase2.mjs` sign in first; the user is created with the CLI against the temp data dir.
- New `phase3.mjs`:
  - login errors and 429
  - session expiry mid-edit: revoke with the CLI, type, sign in again, and the edit saves
  - sign out with a pending edit
  - two users isolated in two browser contexts
  - the theme toggle persists and follows the system
  - mobile viewport (390×844): the drawer opens and closes, the toolbar scrolls
  - reduced motion
- Screenshots in light, dark and mobile for visual review.

## 8. Rollout on the real instance

1. Back up the `margin-data` volume to `~/margin-backups/` before anything else.
2. Rebuild and restart with the new compose port. Migration 3 runs; the notes are hidden until claimed.
3. Run `margin-user add chyld --generate`. It claims the 6 notes, 4 images and the favorites, and prints the password once; I pass it to the user, who can change it with `passwd`.
4. Verify read-only:
   - sign in; all 6 notes appear unchanged; images load; favorites are kept
   - signed-out requests return 401
   - the instance is reachable at the laptop's LAN IP
5. Update the README: accounts, the CLI, LAN access and its plain-HTTP caveat, `COOKIE_SECURE`, `ALLOWED_HOSTS`, `TRUST_PROXY`.

## 9. Out of scope (possible later)

- HTTPS (Caddy or Tailscale in front, with `COOKIE_SECURE=on`)
- password change or self-service in the UI
- sharing notes between users
- admin web UI
- 2FA
- per-user storage quotas

---

## 10. Beta review: what changed from v1 (this section wins over §1–§9)

Nine reviewers read v1 against the code (Sonnet 5.5, GPT-6.1 sol and terra, Grok 4.7, Muse, DeepSeek, MiniMax, GLM, Kimi).

### Data and claiming
- **Legacy claim state:**
  - Migration 3 writes `settings('legacyClaim')` = `{"state":"pending","migratedAt":<ms>}` when there is any legacy data (notes, images or favorites). Otherwise it writes `{"state":"none"}`.
  - `claim` and the first-account claim only work while the state is `pending`. Afterwards it becomes `{"state":"done","userId","at"}`.
  - Deleting every user never reopens claiming.
  - Eligible data:
    - notes with `user_id IS NULL`
    - images with `created_at <= migratedAt` and **zero** owner rows
    - the legacy favorites row, which is **copied**, not deleted
- **The first `add` asks before claiming.** While the claim is pending, `add` asks "6 notes and 4 images from before accounts exist. Give them to chyld? [Y/n]".
  - Without a TTY it needs `--claim` or `--no-claim`.
  - The user insert, the users-count check and the claim run in **one** `BEGIN IMMEDIATE` transaction.
  - Hashing happens before that transaction opens.
- **`reassign <from> <to>`** moves notes, image ownership and favorites, which repairs a typo in the first account's name.
- **Visibility of unclaimed data.**
  - The server logs "N notes and M images from before accounts are waiting: run margin-user claim <name>" at startup and on each sweep.
  - `/api/auth/me` returns `legacyPending: true` so the app can show that hint as a banner.
- **`delete <user>` never silently destroys notes.** It refuses when the user owns anything, unless one of these is given:
  - `--transfer-to <other>`
  - `--purge`, which prints the note and image counts and requires typing the username, even with `--yes`
- **Migrations are race-safe.** `migrate()` takes `BEGIN IMMEDIATE` *before* reading `user_version` and re-reads it inside the transaction, so a server and the CLI starting together can't both apply version 3.
- **Upload is one step.** It writes the file, then inserts the `images` row and the `image_owners` row in a single transaction.
- **Rows created by `heal()` stay unowned**, so they are swept as usual. The only way to get one is a crash before the upload response, so no note references it. Purge deletes the owner rows in the same transaction.
- **The sweep keeps counting references across all users** on purpose, so restore semantics stay simple. A note that references another user's hash keeps that file alive but can't read it.
- **Note store is bound to a user.** `notes.forUser(userId)` returns statements that all include `user_id`.
  - Search becomes `WHERE user_id = :u AND (title LIKE … OR text LIKE …)`.
  - Create is `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM users WHERE id = :u)`, so a request racing a CLI delete can't create an orphan note.

### Auth server
- **Sign-in required by default.** One `api.use('*')` auth middleware with an explicit public list: `GET /health`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`. A test walks every registered route and expects 401 without a session.
- **Every `/api` JSON response is `Cache-Control: no-store`.**
- **Images:**
  - Responses are `Cache-Control: private, no-cache` with `ETag: "<hash>"`, so each view revalidates (a cheap 304) and the ownership check runs every time.
  - The ownership check runs **before** `resolve()` and `touch()` side effects; a non-owner's request never restores a trashed file.
  - Images already cached as `public, immutable` stay cached in the owner's own browser. Accepted and documented.
  - Logout also sends `Clear-Site-Data: "cache"` as a best effort: browsers honor it on localhost but not on a plain-HTTP LAN address.
- **Cookie:** named `margin_session_<PUBLIC_PORT>`, because cookies ignore ports.
  - `Max-Age` is the minimum of the idle limit (30 days) and the time left before the absolute cap (180 days).
  - It is re-sent on the hourly refresh. If the refresh write fails, the server logs it and serves the request anyway; it never returns a 500 for this.
  - Login replaces only **the session in that request's cookie**, never the user's other devices.
- **Sessions created before `users.password_changed_at` are rejected** in the lookup join. `passwd` sets that time and deletes the sessions.
- **Login race with the CLI.** After scrypt succeeds, login re-reads the user row and issues a session only if the `password_hash` is unchanged. Re-hashing old parameters uses `UPDATE … WHERE password_hash = :old`.
- **Login hardening:**
  - The body limit is 4 KB, and fields are validated before any hashing. The username is trimmed, then lowercased, then checked against the regex.
  - At most **2** scrypt hashes run at once, which leaves libuv threadpool room for file I/O. The queue holds 20, with a 10 s wait deadline; beyond either it returns `503` with `Retry-After`.
  - Each attempt is **reserved before** hashing, so in-flight attempts count. Limits are checked before queueing, and again when a hash starts.
  - Hard limits apply per (IP, username) (10 per 15 minutes) and per IP (30 per 15 minutes).
  - **The per-username limit across all IPs is a delay, not a block.** It adds up to 2 s once failures pass 20 in 15 minutes, so a hostile device can never keep the owner out. A correct password always succeeds after any delay.
  - Limiter maps are capped at 10,000 keys and pruned every minute.
  - IPs are normalized (the `::ffff:` prefix is removed).
  - The rollout checks which address the container sees for LAN and localhost clients.
  - `TRUST_PROXY` is **dropped** from this phase.
- **Host rule:**
  - `ALLOWED_HOSTS` **adds** to the defaults. Entries can be `name` or `name:port`.
  - The Host must carry the port (`PUBLIC_PORT` or `PORT`).
  - IPv4 must be four decimal octets; `127.1`, hex forms and trailing dots are rejected. IPv6 must be bracketed and pass `net.isIPv6`, with no zone. Names are matched lowercased.
  - Origin, when present on a write, must be `http://<Host>` or `https://<Host>`. A missing Origin is still allowed, as today (non-browser clients). The `Sec-Fetch-Site` and JSON rules stay, and the plan no longer claims CSRF is "impossible": it is blocked by those layers.
- **Same-account guard.** Every authenticated client request sends `X-Margin-User: <id>`. If the session belongs to someone else, the server answers `409 {code:"user_mismatch"}` **before** any processing. A tab still open for alice can therefore never write into bob's account, and a cross-user 404 can no longer discard a draft.

### Client
- **`Root` states:** `checking`, `unreachable` (a retry button and automatic retry, for network failures), `signedOut`, and `signedIn`.
- **Save queue lifecycle:**
  - 401 and 409 put the queue into **`paused`**: timers stop, entries and drafts are kept, and the status reads "Signed out. Sign in to keep saving". There are no background retries while paused.
  - `resume()` clears the backoff and sends immediately.
  - `suspend()` stops all sending for good, including flushes on unmount and on page hide; it is used before a user switch or sign-out.
  - `drain(timeoutMs): Promise<boolean>` waits for in-flight saves and their follow-ups.
  - `persistDrafts()` returns whether every draft was written.
- **Auth events are idempotent.** The first 401 or 409 opens the overlay once, and later ones are ignored while it is open. A `BroadcastChannel('margin-auth')` tells other tabs about sign-in and sign-out, and tabs re-check `/api/auth/me` when they become visible.
- **Same-user re-auth:**
  - the queue resumes, and the list reloads
  - a NoteView that **failed** reloads; a ready editor is left alone
  - `fonts.ts` forgets failed loads
  - broken `<img>` elements in the document get their `src` re-assigned
  - image uploads that hit 401 wait for re-auth and retry once
- **A different user, or a 409:**
  - `suspend()`, then `persistDrafts()`, then sign in, then a full reload
  - uploads are cancelled with a notice
  - the `beforeunload` warning is suppressed for that reload
- **Sign out:**
  - The editor becomes read-only.
  - Margin waits for image uploads and `drain(5000)`, then calls `persistDrafts()`.
  - If anything is still unsaved, or storage failed, it confirms with accurate wording: "…stay in this browser and come back when you open that note after signing in", or "couldn't be kept in this browser" when storage failed.
  - Then it runs `suspend()` and the logout, broadcasts the change, and calls `location.replace('/')` with the unload warning suppressed.
- **Legacy drafts** are re-keyed only when `/api/auth/me` says this user claimed the legacy data (`legacyOwner: true`). Each old key is removed only after its new key is written. For anyone else they are left untouched.
- **`ApiError`** carries `retryAfter` and the parsed body, so the login screen can use `setupNeeded` and show the 429 wait time.

### CLI
- **Shared startup with the server:** the same `DATA_DIR` resolution, `prepareDataDir()` and `openDatabase()`.
- **Busy database:** `SQLITE_BUSY` after the timeout gives the message "Margin is busy, try again" and exit code 3.
- **Password input:**
  - Hidden prompts use readline with muted output, read from `/dev/tty` when stdin isn't a TTY, and restore the terminal on exit, SIGINT and errors.
  - `--password-stdin` strips exactly one trailing `\n` or `\r\n` and nothing else.
- **Setup:**
  - `npm run user -- …` is added.
  - The Dockerfile creates `/usr/local/bin/margin-user` (`chmod +x`) before `USER node`.
  - The CLI imports only Node built-ins and the server modules, which are prod-safe.
  - The README documents `docker compose run --rm margin margin-user …`, which works while the container is stopped, and warns never to `exec` as root.
- **`sessions` output:** user agents are stripped of control characters and truncated when printed, and "last seen" is labeled approximate.

### Redesign
- **Contrast:**
  - Primary pills use a **light candy gradient with dark ink**: lilac `#cbb8ff` → pink `#ffb3d6`, text `#2d1f4f`, roughly 9:1 or better. Status pills and toasts use dark ink on pastel fills.
  - Note colors are **hashed into a fixed set of 6 checked colors**.
  - Focus rings get their own token.
  - Muted text gets a contrast check over the strongest blob, and surfaces have an opaque fallback (`@supports not (backdrop-filter…)`).
- **Theme:**
  - `color-scheme` is set per theme; the page is pinned to `color-scheme: light` with its own ink colors, so dark tokens never reach note content. `<meta name="theme-color">` updates with the theme.
  - `theme.js` wraps storage in try/catch and only bootstraps and follows the system. React writes the setting and `data-theme` itself.
  - A theme control also sits **on the login screen**.
- **Mobile (≤ 760px):**
  - An **app bar exists in every state**, with the menu button, brand and a compact save-status icon (labeled), instead of hiding it.
  - The drawer is a `role="dialog"` with `aria-modal`: focus is trapped, the main area is `inert`, focus returns to the trigger, scrolling is locked, and Escape or the scrim closes it.
  - The toolbar scrolls sideways with **no backdrop-filter** (a filter would break fixed positioning). Every popover becomes a **fixed bottom sheet**, so nothing is clipped. The table-size grid fits at 30px cells in the sheet.
  - Image resize handles get larger invisible hit areas.
  - `100dvh`, `viewport-fit=cover` with safe-area insets, and `interactive-widget=resizes-content` are used.
  - Blobs are static and there is no blur on phones.
- **Session-expired overlay:**
  - It is a `role="dialog"`, cannot be dismissed with Escape or the scrim, and makes the app behind it `inert`.
  - Focus goes to the **password** field, because the username is prefilled.
  - Errors are announced through `aria-live`.
- **Motion:** the blobs drift only on the login screen, nothing animates under reduced motion (including the splash spinner), and drifting pauses while the tab is hidden.

### Rollout
- Tag the running image `margin:phase2` for rollback.
- Stop the container, then `tar` the whole volume; with nothing running, the WAL is consistent. Verify the archive by opening its `margin.db` copy and counting 6 notes.
- Rollback means restoring the archive into the volume and running `margin:phase2`.

### Declined, with reasons
- **Committing the Playwright e2e scripts.** They stay in `/tmp/margin-e2e` as in Phases 1 and 2. They are throwaway harnesses tied to this machine's Chromium.
- **A 14-day sliding session.** The user chose convenience on a home network. The cookie is per port, and Margin can revoke sessions instantly from the CLI.
- **Ownership by "my note references this hash".** That would let anyone who learns a hash gain access by saving a note.
- **`userland-proxy: false` in compose.** It is a Docker daemon setting, not a compose setting. The rollout checks the observed client IPs instead.

---

## 11. Implementation notes

- **Migration 3** runs every pending migration in one `BEGIN IMMEDIATE` and re-reads `user_version` inside the lock.
  - Switching an older database to WAL needs exclusive access and ignores the busy timeout, so `enableWal()` retries for up to 5 s.
  - Without this, a test that opened the database from three processes at once hit "database is locked".
- **A sign-in compares `password_changed_at`, not the hash, to detect a password change.**
  - The background re-hash of old parameters changes the hash without changing the password.
  - Comparing hashes made a second, parallel sign-in fail. The test that catches this is `does not fail a second login while the first one upgrades the hash`.
- **`margin-user` is plain Node.** It shares `prepareDataDir()` and `openDatabase()` with the server. The hidden prompt uses readline with muted output, falling back to `/dev/tty`.
- **Theme:** `public/theme.js` bootstraps the theme before the first paint. `web/src/theme.ts` owns the choice afterwards, and both follow `prefers-color-scheme` while the choice is "system".
- **Phone popovers are CSS-only bottom sheets** (`position: fixed`). The toolbar on phones has no `backdrop-filter`, because that would make fixed descendants position relative to the toolbar.
- **Test suites.** Playwright suites live in `/tmp/margin-e2e` and run against throwaway instances only:
  - `e2e.mjs`: 61 checks
  - `phase2.mjs`: 59
  - `phase3.mjs`: 40 (accounts, the session-ended flow, two users, two tabs, sign-out, themes, phones, reduced motion)
  - `login.mjs` signs the older suites in.

## 12. Code review: fixes and declines

Reviewers: Sonnet 5.5, GPT-6.1 sol and terra, Muse, DeepSeek, GLM, Kimi and Grok. MiniMax stopped without findings.

**Fixed:**
- **Password change between the final check and session creation.** Reproduced by sol. The session `INSERT … SELECT` now requires the `password_changed_at` that was checked, so the check and the insert are one atomic statement.
- **A busy-server 503 wiped the whole (IP, username) failure counter.** It now calls `limiter.release()`, which gives back exactly one attempt.
- **The per-username slowdown didn't reduce throughput** when many attempts ran in parallel. `slowDown()` now chains the waits per username.
- **Limiter maps** are pruned every minute on an unref'd timer, so they never evict live counters early.
- **IPv6 clients** are keyed by their /64.
- **A too-long password** gets the same 401 as a wrong one.
- **Logout from a stale tab could revoke another account's session.** Logout now honors `X-Margin-User` and answers 409.
- **Favorites were lost on claim, reassign and delete with transfer** when the target already had some. They are now merged and de-duplicated.
- **Deleting a user who has only favorites** now needs `--transfer-to` or `--purge`, like notes and images do.
- **Image ownership and favorites for a user deleted mid-request:** nothing is written.
- **`legacyPending` stayed true when nothing was left to claim.** It now comes from the actual counts, and dismissing the banner is remembered per user.
- **Origin** accepts `https://<Host>` only with `COOKIE_SECURE=on`.
- **Compose** now passes `PUBLIC_PORT` (via `MARGIN_PUBLIC_PORT`), `FONT_DOWNLOADS` and `COOKIE_SECURE`.
- **CLI:**
  - Argument counts are exact.
  - `--flag=value` is rejected on yes/no flags.
  - Losing the race for legacy data still creates the account, without the data.
  - Error hints are specific to each command.
- **A failed sign-out reloaded the page still signed in.**
  - The queue is now paused, not suspended, until logout succeeds. On failure, editing comes back and a notice explains.
  - A 401 or 409 counts as already signed out.
- **The sign-out lock cancelled uploads before the user confirmed.** The editor gets a separate `paused` prop that doesn't cancel uploads.
- **Unsaved-work warnings:**
  - The sign-out confirmation lists every problem: uploads, and edits that couldn't be stored.
  - Switching accounts, or "Switch to the other account", asks first if drafts couldn't be stored.
- **A stale `/auth/me` answering after a re-sign-in reopened the dialog.** Account checks now carry a generation counter.
- **Session dialog:**
  - Tab is trapped inside it, and focus returns to where it was afterwards.
  - Notices render above it.
- **Phone drawer:**
  - Escape works wherever focus is.
  - Opening a note moves focus to its title.
- **Theme switch:** one Tab stop, with arrow, Home and End keys (the radio-group pattern). The account menu focuses it when it opens.
- **A favorite toggled while signed out** is kept and sent after the same user signs in again.
- **The cookie Max-Age test was flaky**, off by one millisecond. It now allows that.
- **From Kimi:**
  - `reassign` and `delete --transfer-to` now pass the legacy-owner role, which adopts pre-account drafts, to the new owner.
  - The session overlay scrolls when it doesn't fit (a phone in landscape, or with the keyboard open).
  - The setup-hint command has fixed dark ink, because it was unreadable in dark mode.
  - The table-size grid shrinks to fit 320px screens.

- **From Grok (after the rollout, redeployed):**
  - A request still in flight with the old cookie when the user signed in again came back 401 and reopened the dialog. Requests now carry a sign-in epoch; a stale 401 or 409 becomes a retryable `StaleSessionError` (the save queue retries it, uploads and note loads retry at once).
  - The 5 MB JSON body limit buffered streamed bodies before the session check. It now runs after the session check and skips sign-in, which reads at most 4 KB.

**Declined:**
- **Docker hiding client addresses (GLM).** With Docker's default iptables port publishing, connections from other devices keep their real address; only connections from the host itself go through the gateway. The rollout checks what the server actually sees: a connection through the LAN address arrived as 192.168.1.197, and only localhost connections show the Docker gateway. Hard limits per (IP, username) still cap guessing either way.
