# Phase 9: simpler design, modular code

Status: **v2**, revised after the plan review by Sonnet, Codex Sol, Codex Terra, Grok, Muse, DeepSeek and GLM. Six approved with changes. DeepSeek asked to rework §4.1 and the hand-off contracts, which v2 does. Their findings are summarized in §11.

Baseline: commit `10e17c3` on branch `phase9` is the deployed Phase 8 code (local only, never pushed).

## 1. Goal and rules

The feature set is done. Phase 9 removes duplicated rules, moves logic out of components that don't own it, splits files that do several jobs, and deletes dead code. It comes from the 2026-11-01 architecture review. The owner chose all four steps and asked to delete the pre-accounts migration code.

The behavior stays the same except for the changes listed in §9. The rules:
- Moves are **verbatim**: code is moved, not redesigned, unless a section says otherwise.
- A step ends green before the next starts: `npm run typecheck`, `npm test`, and all browser suites (`npm run e2e`, each suite against its own fresh server on 5557).
- Each step is one local commit on `phase9`, so reviewers diff step by step.
- No pushes. Never `margin-user logout chyld`. Tests run on 5557 only.

## 2. Step 0: the safety net (tests that pass today)

### 0.1 The browser suites go into the repo as `e2e/`
They were rebuilt from the session transcript on 2026-11-01 and pass at these counts on the baseline. They are currently in `~/margin-e2e-recovery/e2e`.

| From | To | Checks on 2026-11-01 |
|---|---|---|
| `e2e.mjs` | `e2e/core.mjs` | 61 |
| `phase2.mjs` | `e2e/content.mjs` | 59 |
| `phase3.mjs` | `e2e/accounts.mjs` | 40 |
| `phase4.mjs` | `e2e/styles.mjs` | 47 |
| `phase5.mjs` | `e2e/continuation.mjs` | 19 |
| `phase7.mjs` | `e2e/tags.mjs` | 27 |
| `phase8.mjs` | `e2e/format-panel.mjs` | 20 |

Also moved:
- `smoke-real3.mjs` → `e2e/smoke-real.mjs` (read-only, for the real instance at deploy)
- `login.mjs`, `toolbar.mjs`, `make-fixtures.mjs` and `fixtures/` (the two PNGs)

Changes while moving:
- **Every destructive suite refuses port 5555 itself.** `core.mjs` loses its `MARGIN_E2E_ALLOW_WIPE` override.
- **No hardcoded paths.** The repo path in `accounts.mjs` becomes repo-relative.
- **Packaging.** `e2e/package.json` and `e2e/node_modules` are deleted. `playwright-core@1.64.1` becomes a root devDependency. `e2e/` is added to `.dockerignore`.
- **`e2e/run.sh <suite|all>` is rewritten.** It is repo-relative, builds once, and gives each suite a fresh `/tmp/m-e2e-5557` server. It refuses 5555 and stops its server afterwards. `npm run e2e` calls it.

The counts are re-measured after the move, and every later step must keep them (or raise them).

### 0.2 Characterization tests, written against today's code
These are added now, so they pass on the baseline before anything changes.

**Toolbar.** `formatAgreement.test.ts` is replaced by `toolbarState.test.ts`. It records today's `selectState` output as literal expected values, not as "equals formatInfo".

| Case | Today's value |
|---|---|
| Uniform direct marks | |
| Two different bold styles | Bold on |
| Direct bold plus style bold | Bold on |
| Direct bold plus table-header bold | Bold off |
| Stored marks at a collapsed cursor, including `[]` after clear formatting | |
| Link | Underline and color off |
| Styled link whose style underlines | Underline on |
| Inline code | |
| Quote, checked item, table header | Defaults off |
| Linked heading style | Block from the style, size 20/16/14…, bold off for the heading default |
| Unresolved or loading style | Block from the node, align `left`, size from the node |
| Highlight mark without a color | Highlight null |
| Pasted `color: red` and `rgb(…)` | Raw value shown |
| Mixed color, size or family | First piece's value |
| Mixed align | First paragraph's value |
| Image selected | Image align |

When Step 2 lands, every assertion that changes is listed in §9, or the code is fixed.

**Account transfer.** New `server/transfer.test.ts`. It builds a fixture database, runs today's `reassign` and today's `delete --transfer-to` on copies, and snapshots every row of `notes`, `note_tags`, `image_owners`, `styles`, `user_settings`, `users` and `sessions`, plus the returned counts. The fixture covers:
- a shared image
- a style id already on the target
- a tombstoned style
- a case-insensitive name clash
- favorite slots on both users
- favorites on both users, including an unknown family and duplicates
- a non-favorite setting on both users
- a note with tags

A second test forces a failure after the first transfer write and asserts that nothing changed. Step 3 must reproduce the snapshots exactly.

**Migration.** The `auth.test.ts` "migration 3 and claiming" group is trimmed, not deleted. Kept:
- the two-process migration test
- the v2 → current upgrade test
- a new test: a pre-accounts database still opens, and its notes stay hidden (`user_id IS NULL`)

**Image references.** A test runs `server/images.ts`'s current `REFERENCE` regex over real note JSON fixtures. In Step 1, `imageIdsIn` must return the same ids, because the image sweep depends on it.

### 0.3 Unit tests named by phase are renamed by module
- `web/src/phase2.test.ts` → `imageInput.test.ts`.
- `shared/phase2.test.ts` is split: its doc parts merge into the existing `shared/doc.test.ts`, and the rest goes to new `shared/fonts.test.ts` and `shared/image.test.ts`.
- The 15 "Phase N" comments in code become plain explanations.

## 3. Step 0.5: folder moves (mechanical, nothing else)

Done first, so new files from later steps land in their final place and later diffs show content changes, not renames. Imports are updated; nothing else changes.

```
web/src/
  main.tsx  App.tsx  api.ts  router.ts  format.ts  useMediaQuery.ts
  editor/      styleCommands  endStyle  formatInfo  fontSize  imageInput  links
  notes/       saveQueue
  state/       namedStyles  formatPanel  notices  theme  session  fonts  candy
  components/  (UI only, unchanged)
  styles/      app.css  editor.css
```

Tests move with their modules. `shared/` and `server/` don't move. The README "How it's put together" section is updated.

## 4. Step 1: cleanup (small, low risk)

Order inside the step: **1b first** (it deletes code the rest would otherwise touch), then 1a, then the rest.

### 1b. Delete the pre-accounts migration code
The live database has `legacyClaim = done`.

**Server: `users.ts`**
- Deleted: `legacyClaim`, `legacyCounts`, `claimInto`, `moveLegacyOwner` and its calls in `reassign` and `delete`, `claim()`, the `LegacyClaim` and `ClaimCounts` types.
- Deleted SQL: `getSetting`, `putSetting`, `legacyNotes`, `legacyImages`, `claimNotes`, `claimImages`, `legacyFavorites`, and the unused `countSettings`.
- `create(username, hash)` returns the `UserRow`. Callers that read `.user` are updated.

**Server: `cli.ts`**
- Deleted: the `claim` command, `--claim` / `--no-claim`, the `add` prompt and its race-retry `catch`, `describeClaim`, the `list` footer about unclaimed data, and the help and header text for these.

**Server: `index.ts`**
- The maintenance notice keeps the `users.count() === 0` "No accounts yet" hint.
- The claim branch becomes one warning, from one `SELECT COUNT(*) FROM notes WHERE user_id IS NULL`, if any exist: "N notes from before accounts can't be opened by this version. Open the data once with the `margin:phase8` image and run `margin-user claim <name>`." It's tiny, and it means an old database never loses notes silently.

**Server: `app.ts`**
- `/auth/me` returns `{ user }` when signed in. The 401 body `{ error, setupNeeded }` is unchanged, because `Root.tsx` uses it for first-run.

**Web**
- `api.ts`: `Me = { user }`.
- `App.tsx`: deleted `LEGACY_DRAFT`, `adoptLegacyDrafts`, the legacy banner and its dismissed key. The startup `touchDraftImages` call stays.
- `saveQueue.ts`: the un-namespaced `DRAFT_PREFIX` default goes. `draftPrefix` becomes required, since it always comes from `draftPrefixFor`.

**Tests**
- Claim tests in `auth.test.ts` and `cli.test.ts` are deleted. The kept migration tests are in §2.
- `reassign`'s "merges favorites" test stays; its legacy-owner test goes.
- `e2e/smoke-real.mjs` loses its banner check.

**Kept**
- Migration 3's SQL. Shipped migrations are never edited.
- The `settings` table and its rows, now unread.

**Docs:** README says a pre-accounts database must be claimed first, using the `margin:phase8` image and `margin-user claim`.

**Accepted loss.** `margin:draft:<noteId>` keys from before accounts, in a browser that hasn't opened Margin since the claim, are no longer adopted. The owner accepted this.

### 1a. `transaction()` moves to `server/db.ts`
- `notes.ts`, `styles.ts` and `users.ts` import it from there.
- `images.ts` `removeRow` and `save` use it instead of hand-written `BEGIN IMMEDIATE/COMMIT/ROLLBACK`.
- `migrate()` uses it, keeping its re-read of `user_version` inside the lock.
- This lands before Step 3.

### 1c. One copy of each shared rule

**Sign-in failure check**
- Today: `ApiError.isAuthFailure`, `isAuthFailure()` in `api.ts`, `isAuthError` in `saveQueue.ts`.
- After: one `isAuthFailure(error: unknown)` in a new leaf, `web/src/notes/authFailure.ts`, so `saveQueue` stays free of I/O.
- The unused `onAuthError` option and `isPaused()` go, with their tests.

**Image limits and ids**
- Today:
  - `MAX_IMAGE_BYTES` is defined twice (server and web)
  - three MIME lists
  - four id regexes: `images.ts` `REFERENCE` and `IMAGE_NAME`, `App.tsx` `IMAGE_ID`, and the touch schema in `app.ts`
- After: a new dependency-free leaf, `shared/imageRules.ts` (no Tiptap). It holds:
  - `MAX_IMAGE_BYTES`
  - `IMAGE_TYPES` (MIME → extension)
  - the id pattern
  - `imageIdsIn(text)`, a global, unanchored scan
- `shared/image.ts` imports it for `IMAGE_SRC`.
- `guard.ts` keeps a header regex that allows parameters (`image/png; charset=…`), built from the `IMAGE_TYPES` keys.
- `sniffImageType` stays server-only.
- The sweep stays safe because saved documents are validated against `IMAGE_SRC`, and the §2 fixture test pins the ids.

**Font-family grammar**
- Today: copied byte-for-byte in `doc.ts:85` and `styleProps.ts:48`.
- After: a new dependency-free leaf, `shared/safe.ts`. It holds the family pattern and its cap, `isSafeLink`, and the loose document color check `isSafeColor`.
- `canonicalColor`, the strict style rule, stays in `styleProps.ts`.
- `links.ts` then stops importing Tiptap.

**Mark and alignment lists**
- Today: `FLAG_MARKS` in `formatInfo.ts` and `styleCommands.ts`; `Align` in `formatInfo.ts` and `Toolbar.tsx`; `STYLE_ALIGNMENTS` and `TEXT_ALIGNMENTS`.
- After: one each, in `shared/styleProps.ts`. Its `BLOCK_TYPES` is renamed `STYLE_BLOCKS`, because `doc.ts` has a different one.

**UI labels**
- Today: `BLOCK_LABELS` in `StylesMenu.tsx`; `BLOCK_NAMES` and `ALIGN_NAMES` in `FormatPanel.tsx`.
- After: one `web/src/editor/labels.ts`, in `web/`, not `shared/`. "Justify" vs "Justified" stays as each screen shows it today. A test pins both.

**Tab focus trap**
- Today: `LoginScreen` `trapTab`, plus copies in `Sidebar` and `FormatPanel`.
- After: `web/src/focusTrap.ts`: `trapTab(event, container, { visibleOnly, recaptureOutside })`. Each caller keeps today's behavior:
  - Login and Sidebar: visible only, recapture when focus escapes
  - FormatPanel: its current selector, no visibility filter

**Tag messages**
- Today: `TagEditor` builds its "at most…" messages itself.
- After: `shared/tags.ts` exports message builders, and the strings stay byte-identical. `TagEditor.commit` keeps its keep-invalid-pieces logic and does not use `normalizeTags`.

### 1d. Node and mark allowlists: kept, with a drift test
Reviewers pointed out that the hand-written `NODE_TYPES` / `MARK_TYPES` list in `doc.ts` is a deny-by-default gate: a new extension's attributes aren't saved until someone reviews them. So the list stays, and a new test asserts it equals `Object.keys(schema.nodes)` / `schema.marks`. Drift in either direction fails, which replaces the "remember to update" comment.

### 1e. Small fixes
- **`namedStyle.ts`:** `detachOnTypeChange` calls the file's own `changedRanges()` and `blockBefore()` (verified equivalent).
- **Unused imports:** `DRAFT_PREFIX` in `App.tsx`, `detachBlockStyles` in `Toolbar.tsx`.
- **Stale comments:** "Moved to formatInfo.ts" in `fontSize.ts`, "Splash, unreachable" in `app.css`.
- **Types:** `TagCount` is defined only in `shared/types.ts`. `CreateNoteBody` / `UpdateNoteBody` stay hand-written: the web uses them, and it can't import server schemas.
- **Style lookup:** `styleIndex` (the cached `Map` per styles snapshot) moves out of `formatInfo.ts` into a leaf, `web/src/editor/styleIndex.ts`, with a new `stylesStatus(snapshot)` helper. `namedStyles.styleById` uses the index. That keeps `formatInfo` a leaf.
- **No work at import time:** `namedStyles.ts` installs its window `focus` and reauth listeners through an idempotent `ensureListeners()` called by `loadStyles`.

### 1f. The server's data stores are built once
- New `server/services.ts`: `createServices(db)` returns `{ notes, sessions, users, styles }`.
- `createApp(options)` uses `options.services ?? createServices(db)`.
- `index.ts` builds the services once and hands them to both `createApp` and the maintenance loop.
- `images`, `fonts`, `limiter` and `hashQueue` stay injected options, because tests inject fakes.
- `cli.ts` and `server/testing.ts` keep building only the store they need.

## 5. Step 2: one formatting source

### 2.1 The toolbar reads `formatInfoFor`, through a small adapter
- **Where:** new `web/src/editor/toolbarState.ts` holds `selectState`.
- **Re-rendering:** the Toolbar does what `FormatPanel` does. `useEditorState` selects `editor.state` with identity equality; render reads `useNamedStyles()` and calls `formatInfoFor(state, styles, stylesStatus(...))`. Style edits then refresh the toolbar.
- **Still read from the editor:** the `editor.can()` flags, editable, undo/redo, lists, quote, code block, table, image, details, link, inline code and `style: currentStyle(state)`.

**One addition to `formatInfo`.** Each field's fold also records `explicit`: true when every piece's value came from direct formatting or a style. That separates the two cases today's toolbar treats differently:
- direct bold plus style bold: `mixed-sources`, explicit, so Bold shows on
- direct bold plus a bold table header: `mixed-sources`, not explicit, so Bold shows off

**The toolbar rules:**

| Field | Shown when | Otherwise |
|---|---|---|
| bold, italic, underline, strike | `value === true` and `explicit` | off |
| color, highlight, fontFamily | the value is uniform and `explicit` | none |
| fontSize | the value from any source | if `unresolved`, the node's default from `BLOCK_TYPOGRAPHY` (as today); if mixed, blank |
| align | the value | if `unresolved`, `left` (as today); if mixed, blank: a left icon with no item checked, so it never crashes |
| block | the value | if `unresolved`, the node's type (as today); if mixed, `'other'`, the existing "—" |
| image align | unchanged override when an image is selected | |

**Also in this step:**
- `formatInfo` keeps a pasted direct color that `canonicalColor` can't normalize (`red`, `rgb(…)`, `oklch(…)`) as its raw value, instead of dropping it. The toolbar and the Format panel both show it, like today's toolbar.
- `stepFontSize` steps from 11 when the size is blank, as today.
- Deleted: `effectiveTextProps`, `linkedBlock`, `currentBlock`, `HEADING_SIZES`, `PARAGRAPH_SIZE`, and the style branches of `currentFontSize`.
- `styleContinuation.test.ts`'s one use of `effectiveTextProps` switches to `formatInfoFor`.
- The §2 characterization tests decide: every assertion that changes is in §9.

### 2.2 Editor logic moves out of components
- New `web/src/editor/commands.ts`: `clearFormatting` (from `Toolbar.tsx`), `applyFavorite` / `runFavorite`, and the shortcut logic from `Editor.tsx`'s `handleKeyDown`.
- New `web/src/editor/clipboard.ts`: the clipboard serializer.
- **The shortcuts' dispatcher stays where it is,** in `editorProps.handleKeyDown`, which runs first today. It keeps `event.code` matching, the `editable` guards, its order relative to `EndStyleShortcuts`, and calling `setLinkOpen`. Only the logic it calls moves.
- No component imports logic from another component any more.

### 2.3 "Open the Styles menu" stops travelling through the panel store
`Editor.tsx` renders both `Toolbar` and `FormatPanel`. It keeps a `stylesMenuRequest` counter in local state, passes `onOpenStyles` to the panel and `openRequest` to the toolbar. `stylesRequest` leaves `formatPanel.ts`. The `formatPanel.test.ts` and `formatPanelView.test.ts` assertions on the counter are replaced by a check that the panel's style name opens the Styles menu and focuses it, and stays inert when read-only.

### 2.4 Page typography in one table, tested against the CSS
- `shared/styleProps.ts` gains `ELEMENT_COLORS` (link `#1a73e8`, quote and checked `#5f6368`, default highlight `#fff475`) next to `BLOCK_TYPOGRAPHY`. `formatInfo.ts` and `fontSize.ts` read them instead of their own copies.
- The panel's code font *label* "Monospace" stays a label.
- New `web/src/styles/typography.test.ts` parses `editor.css` and compares it to the table. It:
  - resolves paragraph values from `.document`
  - treats `h1`/`h2` color as inherited
  - normalizes `#666` to `#666666`
  - checks only that the code stack contains `monospace`
  - covers size, weight, style, color and the element colors
- **Not doing:** `previewStyle` and the two style captions stay as they are. They differ on purpose, and merging them saves little.

## 6. Step 3: boundaries

### 3.1 Drafts (`web/src/notes/drafts.ts`)
**What moves there:**
- from `saveQueue.ts`: the draft key format (`draftPrefixFor`), read, write and clear, and `decideDraft`. Storage stays injected.
- from `App.tsx`: `browserStorage` and `touchDraftImages` (using `imageIdsIn`)
- from `NoteView.prepareNote`: the whole restore policy, as `restoreForOpen(queue, note, { confirm, now })`, in today's order:
  1. `getLocalChanges` and `queue.open`. Edits in memory and confirmed saves newer than the GET win over a disk draft.
  2. `decideDraft`
  3. A matching or older draft is discarded, after asking when it's older.
  4. `checkSchema`. An invalid draft returns the saved note without asking or discarding.
  5. `confirm`
  6. `queue.update`

**Tests:**
- in-memory edits beat the draft and nothing is asked
- a newer draft restores
- an older one asks, then restores or discards
- an invalid draft is kept, not asked about
- a draft with tags only
- the call order

### 3.2 The note list (`web/src/notes/noteList.ts`): a framework-free store, one per App mount

**API**
- `createNoteList({ api, queue })`: no side effects.
- `start()` (idempotent) and `dispose()`, which clears both timers and ignores responses after it. Both are called from an effect, so StrictMode's setup, cleanup and setup works.
- `subscribe` / `getSnapshot`: a cached object, replaced only on change.
- Operations: `setQuery`, `refresh`, `noteSaved`, `noteCreated`, `noteDeleted(id, listAtStart)`, `localTitle`, `localTags`.

**Wiring.** The queue's `onSaved` calls `listRef.current?.noteSaved(summary)`, late-bound like today's `onSavedRef`. The store gets the queue to read `getUnsaved`.

**Rules it preserves**, from App.tsx:156-213 and 432-609:
1. `setQuery`:
   - skips an unchanged query
   - sets the query and bumps the request id **synchronously**
   - clears the previous timer
   - loads after 250ms (0 when blank)
2. A list response:
   - only the newest request may apply
   - diff the server tags against `savedTags` first, and refresh the counts if they changed
   - overlay unsaved title and tags from the queue **at response time**
   - `listLoading` is cleared only by its own request
3. `noteSaved`:
   - if the tags differ from `savedTags`, record them and refresh counts after 400ms
   - then, if the query isn't blank or a list request is in flight, refetch without patching
   - otherwise bump the request id, overlay unsaved edits, and patch: replace in place unless `updatedAt` is strictly newer, which moves the note to the top
4. `savedTags` is filled only for missing ids, after any notes change. `localTitle` and `localTags` never touch it.
5. `recent`:
   - recomputed only when the list is ready and the query is blank
   - `noteDeleted` removes the note from it regardless
6. `noteDeleted` (App calls it only after the delete succeeds or returns 404, then `queue.cancel`):
   - bumps the request id
   - removes the note from `notes`, `recent` and `savedTags`
   - loads tag counts **immediately**
   - returns the next note from `listAtStart`, the list App captured before the request, as today
7. `noteCreated`: bump the request id, then clear the query, then prepend `{ tags: [] }`.
8. Only the newest tag-count response applies.

**Tests (fake timers, fake api)** cover each rule above, plus:
- a query change during the debounce window
- a stale tag-count response
- dispose, then start again

After writing them, I run a mutation check: remove each guard once and confirm a test fails.

**Two new browser checks in `core.mjs`, using `page.route()` delays:**
- a slow, stale list answer never replaces a newer one
- a save landing mid-request isn't lost

### 3.3 The session (`web/src/notes/useSession.ts`)
- **What moves, verbatim:** `endSession`, `resumeSession`, `recheck`, `leaveTo`, `signInAgain`, `signOut`, the broadcast and visibility listeners, and the pagehide / beforeunload / visibilitychange draft protection. Those listeners stay bubble-phase, so `TagEditor`'s capture listeners still run first.
- **Inside the hook:** `leaving`, `authGeneration`, `focusBeforeDialog` (including its `#format-panel` → `.format-toggle` rule), `sessionEndedRef`, and the `forgetFailedFonts()` + `notifyReauthenticated()` calls in resume.
- **Signature:** `useSession({ queue, user, onResumed })`. `onResumed` is held in a ref, so listeners don't re-subscribe.
- **What it returns:**
  - `sessionEnded`
  - `isSessionEnded()`, which the sidebar shortcut reads
  - `reauthEpoch`, which `NoteView` uses to retry a failed load
  - `locked`, `signingOut`, `signInAgain`, `signOut` and `leaveTo`
- **What stays in App:** the "session ended closes the Format sheet" effect.
- **Unchanged behavior:** when the confirm is declined, `signInAgain` returns with the queue still paused, as today.
- **Coverage:** the accounts suite (40 checks) and the core suite. This code is DOM-heavy, so it gets no new unit tests.

### 3.4 `App.tsx` keeps layout only
- Sidebar collapse, the drawer and its shortcut stay.
- The home heading, tag list and three empty states become a `Home` component. `homeHeadingRef` is passed in for `goHome`.
- Target: about 300 lines, down from 780.

### 3.5 Each server store moves and deletes its own rows
**The rules for the new functions:**
- They are plain SQL on the same `db`. They **never** call `transaction()` and never call store methods that do, such as `notes.delete`, `styles.create` or `images.removeRow`.
- Each store gets only the functions that have a caller.

**What each store gets**
- **`notes.ts`:** `transferOwned(from, to)` moves notes and `note_tags`, returning the note `changes`. `deleteOwned(id)` and `countOwned(id)`.
- **`images.ts`:** `transferOwned(from, to)` copies owners with `INSERT OR IGNORE` (keeping `created_at`) and then deletes the source's owners. It returns the inserted `changes`, so a shared image counts 0. `deleteOwned(id)` deletes owner rows only: the `images` row and file stay for the sweep. `countOwned(id)`.
- **`styles.ts`:** `transferOwned(from, to)` is today's `moveStyles`, verbatim. It moves tombstones, drops the source copy of an id already on the target, renames only live name clashes, and appends favorite slots after the target's highest. It returns the live styles moved. `deleteOwned(id)`, and `countOwned(id)` (live only).
- **New `server/settings.ts`** owns `user_settings`:
  - `favoritesOf(id)`: the raw list, any strings
  - `mergeFavorites(to, list)`: target first, deduplicated, no catalog filter, no cap, never throws (today's rule)
  - `transferOwned(from, to)`: merges favorites, then copies other keys where the target has none (target wins), then deletes the source's rows
  - `deleteOwned(id)`
  - for the API: `readFavorites(id, isKnown)` filters on read, and `writeFavorites(id, list, isKnown)` keeps `MAX_FAVORITES`, its exact error messages and statuses, and the `WHERE EXISTS (SELECT 1 FROM users…)` guard
  - The font service loses its favorites SQL, and the favorites routes call `settings`.

**`users.ts` uses them**
- It builds these from `db` itself, so `createUserStore(db)` keeps its signature.
- `reassign`: `transferOwnedData(from, to)` only. The source user and their sessions stay.
- `delete --transfer-to`: `transferOwnedData`, then `deleteOwnedData(source)`, then the user's sessions and row.
- `owned()` and the delete refusal keep today's counts: notes, image owners, live styles, and the length of the raw favorites list.
- `list()` keeps its single SQL query, which only reads.

**Done when** the §2 transfer snapshots and the rollback test pass unchanged, along with the existing transfer, purge and name-clash tests.

### 3.6 Browser font favorites get their own module
The favorites half of `state/fonts.ts` (load, refresh, toggle, the write queue, waiting for sign-in) moves to `state/fontFavorites.ts`.

## 7. Step 4: structure

### 4.1 Server routes
- **The split:** `server/routes/{auth,notes,images,fonts,styles}.ts`. Each exports a **registration function**, `registerNoteRoutes(api, deps)`, on the shared `api` router. They are not nested apps, so error flow is unchanged. Each file keeps its zod schemas beside its handlers.
- **What stays in `app.ts`, in order:** guard, CSP, session middleware, body limits, `PUBLIC_ROUTES` (fail-closed), static serving and `onError`.
- **Errors:**
  - New `HttpError(status, message, code?)` is the base of `FontError` and `StyleError` only. `UserError` stays a CLI error.
  - `onError` maps `HttpError` to today's bodies: fonts give `{ error }`, styles give `{ error, code }`. `FontError.upstreamStatus` behavior is kept. Expected errors aren't logged.
  - That deletes the six route-level font and style try/catch blocks and `fontErrorResponse`.
  - The login `try` stays: it turns `BusyError` into 503 with `Retry-After: 5` and releases the limiter slot.
- **Tests:**
  - The 401 test iterates `app.routes` and expects 401 on every non-public route, instead of a hand-written list.
  - New response-shape tests: font 404 and 503 without `code`, style 409 with `code`, login 503 with `Retry-After`, `/api/does-not-exist` returning a JSON 404, and the `no-store` header.

### 4.2 The font CSS sanitizer gets its own file
`rewriteFontCss`, `isGstaticUrl` and `hasFontSignature` move to `server/fontCss.ts`.

## 8. Not doing

| Idea | Why not |
|---|---|
| A shared store helper | It repeats a pattern, but there's no shared logic to extract. |
| Splitting `app.css` | It's sectioned already, and splitting risks the cascade order. |
| Generating `editor.css` | The 2.4 test protects the same thing. |
| Splitting `styleCommands.ts` or `auth.ts` | Each is one cohesive area. |
| Merging `previewStyle` and the two style captions | They differ on purpose. |
| Deriving the node and mark allowlist from the schema | It weakens the gate; 1d adds a drift test instead. |
| `UserError` as an HTTP error | It's a CLI error. |
| `createServices` for the CLI and test helpers | They need one store each. |
| Moving the shortcuts into a Tiptap extension | It would break `event.code` matching and handler order. |
| A catalog filter on account transfer | It would destroy stored data. |

## 9. Visible changes

**From deleting the migration code (§4 1b):**
1. The pre-accounts banner and `margin-user claim` are gone.
2. Old pre-accounts drafts in a browser that hasn't opened Margin since the claim are no longer adopted. The owner accepted this.

**The toolbar now agrees with the Format panel (§5 2.1)** in these edge cases:
3. **Mixed selections:** when alignment, font, size or color differ across the selection, the toolbar shows blank instead of the first piece's value, and paragraphs of different types show "—". The panel says "Mixed". Stepping the size (Ctrl+Shift+. or the +/− buttons) still starts from the first size in the selection.
4. **Highlight without a color:** it shows the yellow it's painted with, instead of nothing.
5. **Right after "Clear formatting" at the cursor:** the font, size and color boxes show what you'll type next, instead of the old text's values. Today they're stale, while Bold and Italic are already right.
6. **A styled link whose style underlines, or a checked item whose style strikes through:** Underline (or Strikethrough) shows off, because the link (or the checked item) draws it. **Inline code inside a style that sets a font:** the font box is blank, because code uses the page's monospace font.
7. **Rare ranges:** a selection crossing a code block, or covering only empty styled lines, follows the panel's reading.
8. **Colors written as `rgb(…)`** show as their hex value (`#188038`). Named and other colors (`red`, `oklch(…)`) show as written, for text and highlight alike, in the toolbar and now also in the Format sidebar (which used to show the default color for them).
9. **Draft images:** the once-per-page "keep these images" ping for local drafts counts only references with a stored image's extension (`.png`, `.jpg`, `.gif`, `.webp`), the same rule the server's cleanup uses. Image nodes can't hold anything else, so this only drops references typed as plain text.

Everything else must be identical. The browser suites, the characterization tests and the unit tests are the proof.

## 10. Order, review and deploy

1. Step 0 → 0.5 → 1 → 2. Then **beta code review** of commits Step 0 through Step 2.
2. Step 3 → 4. Then **beta code review** of the Step 3–4 commits.
3. **Deploy once**, using the usual routine:
   - fingerprint the notes
   - `docker tag margin:latest margin:phase8`
   - stop the container
   - back up the volume to `~/margin-backups`
   - integrity check
   - `up -d --build`
   - compare fingerprints, run `e2e/smoke-real.mjs`, check `margin-user list`

   Rollback is `margin:phase8`. There are no new migrations.

## 11. What the plan review changed (v1 → v2)

**Toolbar**
- It wasn't an exact match. v2 adds the `explicit` flag, keeps today's fallbacks for unresolved styles, keeps raw pasted colors, and handles blank alignment.
- §9 now lists the remaining differences honestly (all seven reviewers).
- Characterization tests pin today's toolbar before the change (Sol, Sonnet, Terra, Muse, DeepSeek, GLM).
- The Toolbar computes in render with identity selection (Sonnet, DeepSeek).

**Account transfer**
- No catalog filter on favorites (all seven). The exact contracts are spelled out. Snapshot and rollback tests come first (Sol, Terra, Grok, Muse, DeepSeek).

**Missing contracts**
- `reauthEpoch` (all seven).
- The note list's lifecycle, wiring and ordering rules (all seven).
- `restoreForOpen` call order (Sol, Sonnet, Grok, DeepSeek).

**Errors**
- The login 503 stays (GLM, Grok). Response bodies are kept, there are six try/catch blocks rather than eight, and `UserError` stays a CLI error (Sonnet, Muse, Grok, DeepSeek).

**Shortcuts**
- The dispatcher stays. `event.code` and handler order are preserved (Sol, Sonnet, Muse, Grok, DeepSeek, GLM).

**Legacy removal**
- The full list of what depends on it.
- The migration tests are kept.
- The 401 body and the "No accounts yet" hint are kept.
- A warning for hidden pre-accounts notes (Sonnet, Muse, Grok, DeepSeek, Sol, Terra).

**Placement**
- `imageRules.ts` and `authFailure.ts` are dependency-free leaves.
- `styleIndex` stays a leaf.
- Labels go in `web/`.
- `createServices` is narrower (Sonnet, Muse, DeepSeek).

**Cut**
- Deriving the allowlist (it's now a drift test).
- The `previewStyle` and caption merges.
- `z.infer` request types.
- `createServices` in the CLI and `testing.ts`.

**Order**
- A git baseline first.
- Folder moves first, mechanically (Sonnet).
- 1b first, and 1a before Step 3 (Sonnet, Grok).
- Step 0 holds only tests that pass today (Muse).

**Files**
- `smoke-real3.mjs`, `make-fixtures.mjs`, the `run.sh` rewrite, removing `e2e/node_modules`, and merging into the existing `shared/doc.test.ts` (Muse, DeepSeek, GLM).

## 12. Implementation notes (where the code differs from v2)

- **`shared/phase2.test.ts`** became `shared/docRoundTrip.test.ts`, `shared/fonts.test.ts` and `shared/image.test.ts`. The document parts weren't merged into `doc.test.ts` because the two files' helpers clash (`paragraph()` has different signatures). `web/src/phase2.test.ts` became `editor/imageInput.test.ts`, `editor/fontSize.test.ts` and `state/fonts.test.ts`.
- **The typography test** is `scripts/typography.test.ts`, next to the theme test, because it reads `editor.css` with Node's `fs`, which the web TypeScript config doesn't include. A one-value mutation of `editor.css` makes it fail.
- **The focus trap** has one option, `recaptureOutside` (the sign-in dialog). The Format sheet now uses the standard selector and visibility filter. It has no inputs or links, and the sheet is always visible, so nothing changes.
- **`toolbarState.test.ts`**: eight cases changed when the toolbar moved onto `formatInfo`. Each is marked "Changed" in the test, and each is one of §9 items 3–8.
- **Element colors** are `ELEMENT_COLORS` in `shared/styleProps.ts`.

**After the step 0–2 code review** (Sonnet, Codex Sol, Codex Terra, Grok, Muse, DeepSeek, GLM):
- **Fixed:**
  - A highlight color the hex rule can't rewrite (`yellow`, `oklch(…)`) showed as the default yellow. It now shows as written, like text colors.
  - A paragraph with its own alignment whose style hadn't loaded showed `left`. Its own alignment now shows.
  - The size box went blank with an image or line selected. It shows 11 again (`FormatInfo.hasText`).
  - Stepping the size of a mixed selection started from 11, collapsing 18pt + 24pt to 12pt. It steps from the first size again (`stepBaseSize`).
- **Tests:**
  - The transfer snapshots now cover every column, with distinct values. They were re-recorded against the step 0 code and match the current code exactly.
  - New tests: the labels, and the toolbar cases above.
  - The dead fallback import in `styleContinuation.test.ts` is gone.
- **`e2e/run.sh`:**
  - It refuses to run when port 5557 is already in use, so the suites can't wipe a server they didn't start.
  - It checks that its server started.
  - It requires a zero exit status as well as a passing summary.
- **Listed in §9 instead of changed back:** a checked item's style strikethrough, inline code's font, mixed paragraph types, the sidebar showing pasted colors, and draft image references.
- **Cleanups:** "Phase N" in test names, `CONTENT_TYPES` derived from `IMAGE_TYPES`, double blank lines.
