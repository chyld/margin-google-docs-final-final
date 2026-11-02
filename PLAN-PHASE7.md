# Phase 7: the logo goes home, and notes get tags

The user's request: "the logo should take you to home page (no note shown)" and "add tags to notes (all lowercase, a-z and 0-9, no spaces)". The beta team (Sonnet, gpt-6.1-sol, gpt-6.1-terra, grok and muse) gave design advice first. The user then chose:

- **Home:** a quiet home: the welcome illustration, a New note button, and the user's tags with counts. There's no recent-notes list, since the sidebar already shows one.
- **Tag edits count as edits:** a real change to a note's tags bumps `updatedAt`, so the note moves to the top.
- **Finding:** clicking a tag filters the list. `#work meeting` in search means tag *work* AND the text "meeting". Several tags are ANDed.
- **The tag list with counts** appears in the sidebar, under the search box (hidden when the user has no tags), and on home.

## 1. Home and the logo

- **Remove the auto-open effect** (App.tsx: "Open the newest note when no note is selected"). `/` now always means "no note open": on first load, on refresh and with Back. All five reviewers agreed; a logo-only exception can't survive a refresh.
- **Deleting a note** still opens its neighbour, and goes to `/` only when nothing is left (unchanged).
- **The logo becomes a link in all three places,** as a real `<a href="/">`. A plain click calls `navigate('/')`, the same way note links do, so modified clicks still open a tab:
  - **Expanded sidebar `.brand`:** the icon and the word "Margin" form one link. The phone drawer's close button stays a separate button, outside the link.
  - **Collapsed rail `.rail-logo`:** a link with `aria-label="Margin home"`.
  - **Phone `.app-bar-brand`:** a link.
  - The link gets `aria-current="page"` when on `/`.
  - Following it clears the search box (and with it any tag filter) and closes the phone drawer. When the click came from the drawer, focus moves to the home heading.
- **Home view** (`.empty-main`, when the user has notes and none is open):
  - the illustration, then the heading "Pick a note, or start a new one" and a New note button
  - the tag list with counts, as links that apply the filter (see §4)
  - The first-note state for a user with no notes is unchanged.
- `NoteView` already flushes pending saves on unmount, so leaving a note for `/` loses nothing. A test checks this.

## 2. Data

- **Migration 5** (append only): `note_tags (note_id TEXT NOT NULL, user_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (note_id, tag))` with `CREATE INDEX note_tags_user_tag ON note_tags (user_id, tag, note_id)`. Existing notes simply have no tags.
- **`user_id`** is stored on the row, as with `image_owners`. It is always the session's user, never from the client. Every read and write is scoped by user.
- **Cleanup without foreign keys** (the schema declares none):
  - `notes.delete` deletes the note's tag rows in the same transaction.
  - `users.ts` `--purge` deletes `note_tags` by `user_id`.
  - `--transfer-to` and `reassign` move `note_tags.user_id` in the same transaction as `moveNotes`.
  - `claimNotes` is irrelevant: pre-account notes had no tags.
- **Rules,** in `shared/tags.ts`, used by both client and server:
  - `normalizeTag(raw)` trims, strips one leading `#` and lowercases.
  - A tag is valid when it matches `^[a-z0-9]{1,32}$`.
  - Anything else is **rejected**, not stripped, because `to-do` must not silently become `todo`.
  - `MAX_TAGS = 20` per note.
  - `normalizeTags(list)` normalizes, drops duplicates and sorts A–Z, or reports the first invalid tag.
- **Types:**
  - `Note` and `NoteSummary` gain `tags: string[]`, sorted.
  - Summaries load tags with a second query over the returned ids, so a join can't multiply or cap rows.
- **API:**
  - `PATCH /api/notes/:id` accepts an optional `tags: string[]`, which replaces the note's tags. If it's omitted, the tags are unchanged; `[]` clears them. It may be sent alone or with title and content, applied atomically in one transaction.
  - A real change to the tag set bumps `updated_at`; an identical set doesn't.
  - Invalid tags, or more than 20, return 400 with a clear message.
  - `GET /api/tags` returns `{ tags: [{ tag, count }] }` across **all** the user's notes, not the capped list, sorted by count descending, then by name.
  - `GET /api/notes?q=…` parses `#tag` tokens out of `q`: tokens matching `^#[a-z0-9]{1,32}$` after lowercasing. Each becomes an `EXISTS` condition, ANDed. The remaining words go through the existing LIKE search; an empty remainder means no text filter. A token that isn't a valid tag, such as `#to-do` or a lone `#`, stays in the text search.

## 3. Saving: through the existing queue

Four of the five reviewers recommended this, because it keeps offline drafts, sign-out pause, retries and 404 handling.

- `SavePatch` gains `tags?: string[]`.
- **Merging:** the queue already merges patches by key (last write wins per key), so a tag edit never drops a pending content edit, or the other way round.
- `hasKeys`, `decideDraft` (a tag comparison) and draft persistence and restore all include tags. An older draft without `tags` means "unchanged".
- **No tags on content saves:** content saves don't send tags, so a stale tab can't overwrite tags it never touched.
- `App.onSaved` updates the sidebar row from the returned summary, including tags. When a save changed tags, the tag counts reload (`GET /api/tags`), debounced.

## 4. Tag UI

- **Chip row under the title** in `NoteView`, a group named "Tags":
  - Each chip is the tag text, which applies the filter, plus a remove button (`aria-label="Remove tag work"`).
  - Then an input, `aria-label="Add a tag"`, with the placeholder "Add tag…".
- **Input behavior:**
  - **Committing:** Enter, comma, space and blur commit the typed tag. Uppercase is lowercased as you type.
  - **Invalid characters:** if the text has any, it stays in the field with the inline message "Tags use only a–z and 0–9" (also announced through `aria-live`).
  - **Pasting:** text like "a b, c" splits on whitespace and commas. The valid pieces are added, and the first invalid piece stays in the field with the message.
  - **Backspace** in an empty field focuses the last chip's remove button; a second Backspace removes that chip.
  - **The limit:** at 20 tags the field is hidden, with "20 tags max".
  - **Suggestions:** the user's existing tags, minus ones already on the note, through a native `<datalist>`. It works on phones and needs no custom combobox semantics.
  - **Announcements:** "Tag added: work" and "Tag removed: work".
  - **Read-only notes:** no input and no remove buttons.
- **Sidebar Tags section,** under the search box (expanded sidebar only; the rail is too narrow):
  - a wrapping row of `#tag count` chips, each a button that toggles that tag in the search box
  - An active tag is highlighted with the selected treatment (accent-soft plus an accent ring) and `aria-pressed`.
  - It shows the top 12 tags, with "Show all (N)" to expand, and it's hidden when the user has no tags.
- **Filtering is done in the search box:** clicking a tag, in the sidebar, on home or on a note's chip, adds `#tag` to the search box, or removes it if it's already there. The list then updates through the normal search.
  - This makes the syntax visible and keeps one filter mechanism. Clearing search clears it, and so does the logo.
  - Clicking a note's chip doesn't close the open note.
  - The filter isn't kept in the URL, like search today; the user didn't ask for shareable filters.
- **Note rows in the sidebar** show up to 3 tags as small plain chips (`#work`) under the snippet, plus "+N". They're not interactive, because the row is a link, and that keeps the HTML valid.
- **Styling:** chips are small with `--radius-sm` corners, the `--surface-sunk` fill and `--muted` text. Hover uses `--hover`, and active uses `--accent-soft`/`--accent-ink` plus a ring. The contrast test (`scripts/theme.test.ts`) covers any new color pairs.

## 5. Not now

- Renaming, merging or deleting a tag across notes. The table makes it one statement later.
- Tags in the URL, OR filters, and tag colors.

## 6. Tests

- **Server** (`app.test.ts` plus a new `server/tags.test.ts`):
  - validation (400s), normalization, the limit
  - PATCH tags alone and with content (atomic), `updated_at` bumped only on a real change
  - list and get include tags
  - `#tag` search with AND and text, invalid `#` tokens staying as text
  - `/api/tags` counts beyond `LIST_LIMIT`, and a cross-user 404 and isolation
  - deleting a note removes its tags
  - CLI purge, transfer and reassign move or delete tags
  - the migration from version 4
  - Existing exact-shape assertions gain `tags: []`.
- **Save queue** (`saveQueue.test.ts`): tag and content merging, draft round-trip with tags, an old draft without tags, and `decideDraft` comparing tags.
- **Shared:** a `shared/tags.test.ts` for `normalizeTag` and `normalizeTags`.
- **UI** (happy-dom, where practical): the chip input commits, pastes, handles Backspace and rejects invalid text; the logo navigates to `/`.
- **E2E** (`/tmp/margin-e2e/phase7.mjs`):
  - landing on home
  - the logo from a note goes home in all three places
  - adding tags, and their persistence after reload
  - the sidebar tag filter and `#tag` search
  - tag counts
  - removing a tag
  - phones
  - The existing suites stay green; any that relied on auto-open get updated.

## 7. Rollout

The same as always:
1. Fingerprint the notes.
2. Tag `margin:latest` → `margin:phase6`.
3. Stop the container, back up the volume and verify the backup.
4. Run `docker compose up -d --build`. Migration 5 runs on start.
5. Verify the notes are unchanged (the fingerprint now ignores the new `tags` field, which is `[]` for every existing note), the session is kept and the smoke test passes.
6. Never sign the user out.

## 8. Plan review: what changed (this section wins over §1–§7)

From gpt-6.1-terra, gpt-6.1-sol and Sonnet:

- **Ownership before tag rows** (sol, Sonnet): `update()` runs in one `BEGIN IMMEDIATE` transaction. It checks the note belongs to the session user before touching `note_tags`, so a foreign or missing id never gets rows. A test checks this.
- **Tags-only saves** (Sonnet): the PATCH schema accepts a body with only `tags`. `update()` gains a tags-only branch: `touch` bumps `updated_at` only on a real change, otherwise the summary is read back unchanged.
- **Tags flow everywhere** (terra, sol, Sonnet):
  - `Prepared` carries tags through the server copy, the local-changes overlay and draft restore.
  - `App.onSaved` keeps unsaved tags, as it keeps unsaved titles, and invalidates list requests sent before the save.
  - The optimistic new-note row gets `tags: []`.
  - `decideDraft` compares tags.
  - `readDraft` drops invalid tags from a stored draft, so one bad draft can't block content saves.
- **Tag counts** (terra, sol): `GET /api/tags` loads on start, after deletes, after re-sign-in, and after any save that changed a note's tags (debounced 400ms). Only the newest response is applied.
- **The search length cap** (terra, sol, Sonnet): the client takes `#tag` words out of the search itself (`parseTagQuery`) and sends `?q=<text>&tag=a&tag=b`. The 200-character cap then applies only to the text and can't cut a tag. `#to-do` and a lone `#` stay as text.
- **Search races** (terra): changing the query invalidates the in-flight list request immediately, not after the 250ms debounce.
- **Logo, drawer and focus** (terra, sol, Sonnet): `goHome()` clears search, closes the drawer and navigates, even when already on `/`. Two animation frames later it focuses the `tabIndex={-1}` home heading. The drawer's close button stays outside the brand link. Home also has an error state.
- **Tag clicks show the list** (sol, Sonnet): on a phone, toggling a tag opens the drawer; with the sidebar collapsed, it expands it.
- **The tag field** (terra, sol, Sonnet):
  - **Composition:** nothing commits while an input method is composing (`isComposing`, keyCode 229), and text is normalized only on commit, not lowercased as you type.
  - **Phone keyboards:** typed spaces and commas commit through the input event, and so does picking a datalist suggestion (`insertReplacementText`).
  - **Paste:** it respects the selection and keeps every rejected or over-limit piece in the field.
  - **At 20 tags:** the field stays, read-only with the placeholder "20 tags max", so focus isn't lost.
  - **Focus after removing:** it goes to the next chip's remove button, else the field.
  - **When locked:** the field and remove buttons hide whenever the note is locked (signing out) or opened read-only.
- **Rollback note** (Sonnet): the old image refuses a database at schema version 5, so rolling back this phase means restoring the volume backup, not only switching images.
- **Accepted, not changed:** replacing the whole tag set means two tabs editing tags at once keep the last write, the same as titles today.

From grok and muse:

- Most points match the above and were already built: tags on `Prepared` and on restore; a missing key means unchanged; counts after deletes and while a filter is active; tags parsed in the client; the drawer and focus; the tags-only PATCH; one transaction; the transfer and purge ordering (tags move only inside transfer and reassign, and are deleted only by purge, before `deleteNotes`); a Backspace handler on the remove button; shared `parseTagQuery`/`toggleTagInQuery`; the phone "Show my notes" button kept on home; home tags as buttons; and the new-row `tags`.
- **Added after these reviews:**
  - Typed but uncommitted valid tags are saved when the note view closes, as with Back or opening another note, even without a blur (muse).
  - Blur doesn't commit when focus moves within the tag group, so typing and then clicking a chip's × removes the intended chip (grok, muse).
  - Re-adding an existing tag is a quiet no-op ("Tag already added"), with no PATCH (muse).
  - `onSaved` moves a row to the top only when `updatedAt` is newer; an unchanged save updates it in place (grok).
- **Clarified:** after `#tags` are removed, the remaining words are matched as one phrase, as in today's search (`hello #work world` → the text "hello world") (muse).
- **Kept:** `note_tags.user_id`, as with `image_owners`, so every statement can be scoped by user without a join. A test covers reassign, transfer and purge (muse suggested dropping it).

## 9. Code review: what changed

- **grok (High):** a valid tag still in the field never made the sign-out save. The lock now applies synchronously (`flushSync(() => setLocked(true))`) before `queue.drain()`, and `TagEditor` commits on lock in a `useLayoutEffect`. An e2e check covers it.
- **terra:**
  - Typed tags are committed on `pagehide` and on hidden `visibilitychange` (in the capture phase, before the app persists drafts), and when editing locks.
  - More than 20 `#tags` in a search match nothing instead of being silently truncated.
- **sol:**
  - An input method's unfinished text is never committed by any path: blur, hidden page, lock or unmount.
  - List responses overlay unsaved titles and tags.
- **Sonnet:**
  - A save landing while a list request is in flight reloads the list instead of discarding that answer, as when clearing the search right after a tag edit.
  - Held Backspace (`event.repeat`) never removes chips.
  - `TagEditor` calls `onLeave` (`queue.flush`) after committing typed tags on close.
  - The queue ignores edits to notes it cancelled, meaning deleted notes.
  - `savedTags` refreshes from every list response.
  - The tag field has a dashed border at rest.
  - The sidebar tag list leaves room for focus rings.
  - Contrast pairs added: `accent-ink` on `surface-solid`, `danger` on `bg` and `canvas`, `focus` on `surface-solid`.
  - Tests added for `%`/`_` with a tag filter and for migration 5's table.
- **muse:**
  - Pills clicked in the sidebar stay visible past the top 12, so focus isn't lost when turning one off.
  - Removing the last chip focuses the field.
  - Declined: surfacing invalid typed text dropped when the view closes; text that can't be a tag is fine to drop.
- **grok (Low/Medium):**
  - Counts reload when a list response shows a known note's tags changed.
  - Repeated identical announcements are spoken again, via an alternating trailing no-break space.
- **Totals:** 589 unit tests. e2e: phase7 27, phase3 40, phase5 19, phase4 47, e2e 61, phase2 59. The phase3 and phase2 suites were updated: phase3 because `/` no longer auto-opens a note, and phase2's drop check now waits for layout to settle.
