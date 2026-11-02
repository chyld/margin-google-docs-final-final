# Margin, Phase 4: collapsible sidebar, compact toolbar, saved styles, favorites

Status: **v2**, revised after the beta plan review. **§8 replaces the style mechanics of §4.2–§4.4 and wins over §1–§7 wherever they disagree.**

This phase builds on Phase 3, which is shipped and running: accounts, private notes, LAN access and the candy-pastel redesign. See `PLAN-PHASE3.md` (especially §10–§12) and the earlier plans.

## User decisions (fixed)

| Topic | Decision |
|---|---|
| Sidebar | **Collapses to a slim icon rail** with the logo, New note, Search, colored dots for recent notes (tooltip shows the title) and the account avatar. Toggled by a button and Ctrl/⌘+\\. Remembered per device. |
| Toolbar | **One compact row.** Tighter spacing. Alignment becomes one dropdown and lists another. Quote, code block, collapsible section, horizontal line, image and table move into one **Insert** menu. Less-used text toggles go into a "⋯" menu. |
| Styles | **Save formatted text as a named style; reuse it anywhere; unlimited styles.** |
| Style edits | **Update everywhere** (like Word): text remembers its style, so editing a style restyles every place it's used in every note. Deleting a style keeps the text's current look. |
| Style contents | **All three groups:** font, size and colors; bold, italic, underline and strike; paragraph type (normal or H1–H6) and alignment. |
| Scope | Styles belong to **the user's account** and work in all of their notes, like font favorites. |
| Favorites | **Fonts and styles are pinned at the top of their menus.** A ★ in each menu's header favorites the current font or style. Favorite styles get keyboard shortcuts for the first nine (see §4.6). |

Current state, for reviewers:
- **Font favorites already exist** (a ☆ on each row of the font menu, plus a pinned "Favorites" section), stored per user in `user_settings`. This phase adds only the header ★ and keeps the rest.
- **Toolbar today:** `web/src/components/Toolbar.tsx` with `ToolbarParts.tsx`, `FontPicker.tsx`, `FontSize.tsx`, `TableMenu.tsx` and `LinkPopover.tsx`. It wraps onto two rows at 1400px with the sidebar open.
- **Editor shortcuts already taken:**
  - Ctrl/⌘+Alt+1–6: headings, from StarterKit and the same in Google Docs
  - Ctrl/⌘+Shift+7/8/9: lists
  - Ctrl/⌘+Shift+L/E/R/J: alignment
  - Ctrl/⌘+Shift+B: quote
  - Ctrl/⌘+Alt+C: code block

---

## 1. Collapsible sidebar (desktop and tablet; phones keep the drawer)

**Toggling:**
- A collapse button (`PanelLeftClose` icon) sits in the sidebar header next to the brand.
- In the rail, an expand button (`PanelLeftOpen`) is the first item.
- Ctrl/⌘+\\ toggles from anywhere, including while typing in the editor. It is handled on `window` in the capture phase; ProseMirror doesn't use Mod-\\.

**The rail** (`.sidebar.is-collapsed`, width 68px), top to bottom:
- **Expand button.**
- **Logo.**
- **New note:** a round gradient button.
- **Search:** expands the sidebar and focuses the search field.
- **Recent notes:** up to 12 of the newest, as 34px candy circles showing the title's first letter.
  - Each is a link to the note. The tooltip and `aria-label` show the full title.
  - The active note gets a ring.
  - The column scrolls if the window is short.
- **Account avatar**, which opens the same account menu. The popover anchors to the right of the rail.

**Behavior:**
- **Remembered per device** in `localStorage['margin:sidebar'] = 'collapsed' | 'expanded'`, wrapped in try/catch.
- **Transition:** the grid column width animates (`grid-template-columns`, 200ms). Under reduced motion it is instant.
- **Phones (≤ 760px):** the collapse controls are hidden and the drawer works as now. The saved state is ignored there.
- **Accessibility:**
  - The toggle has `aria-expanded` and `aria-controls="notes-drawer"`, labeled "Collapse sidebar" or "Expand sidebar".
  - The rail is a `nav` landmark labeled "Notes".
  - Focus stays on the toggle after toggling, because the button is swapped in place.

## 2. Compact toolbar (one row)

The new order. Separators are 1px and buttons are 30px with 1px gaps:

```
↶ ↷ | Styles▾ | Normal text▾ | Font▾ −11+ | B I U ⋯ | A▾ 🖍▾ 🔗 | ≡▾ ☰▾ | ＋Insert▾ | [table▾ when in a table] | Tx
```

- **Styles▾**, new (§4): shows the current style's name at the cursor, or "Styles". Max width 120px with an ellipsis.
- **Normal text▾:** the existing paragraph-type select, restyled and narrower (112px).
- **Font▾ and size:** unchanged behavior, slimmer. The font trigger is 112px wide.
- **B I U, then "⋯"** (`More text formatting`): a small menu with Strikethrough and Inline code, each showing its shortcut and active state. The ⋯ button lights up when either is active.
- **A▾ and 🖍▾:** the existing color and highlight menus. **🔗:** the existing link popover.
- **≡▾ Alignment:** one button whose icon shows the current alignment. The menu offers Left, Center, Right and Justify with shortcuts. With an image selected it aligns the image, as today, and Justify is disabled.
- **☰▾ Lists:** the icon shows the active list type, or a bullet list when none. The menu offers bulleted, numbered and checklist, with active states.
- **＋ Insert▾:**
  - Image (opens the file picker) and Table (opens the existing size grid as a submenu panel)
  - a separator
  - Collapsible section, Quote and Code block. Section and Quote are toggles, shown with a checkmark when active.
  - Horizontal line
- **Table options▾** (the existing `TableOptions`): **shown only while the cursor is in a table**, so it doesn't take space otherwise.
- **Tx (clear formatting):** also clears style tags (§4.4).

**Menu mechanics:**
- A new shared `ToolMenuButton` provides the trigger, the popover and `useDismiss`.
- The menu is `role="menu"`, each item `role="menuitem"` or `menuitemcheckbox`. Arrow Up and Down move between items, Home and End jump, Enter or Space activates, and Escape closes and returns focus to the trigger.
- `onMouseDown` calls `preventDefault` on items, so the editor keeps its selection.
- On phones, menus open as bottom sheets, reusing the Phase 3 CSS.

**Target width:** about 900px, so one row fits at 1200px or wider with the sidebar expanded, and at about 960px with it collapsed. Narrower windows still wrap; phones scroll sideways as now.

## 3. Font favorites (small additions)

The font menu header gets a ★ toggle for **the font at the cursor**, labeled "Add Lora to favorites" or "Remove Lora from favorites". It uses the existing `toggleFavorite()`. When the selection has no single font (mixed, or the default Arial), the ★ is disabled.

Nothing else changes: the existing ☆ on rows, the pinned section, and per-user storage.

## 4. Saved styles

### 4.1 Style definition (shared: `shared/styles.ts`)

```ts
type StyleProps = {
  // inline ("character") parts
  fontFamily?: string      // isSafeFontFamily
  fontSize?: string        // isSafeFontSize
  color?: string           // isSafeColor, hex only from the UI
  highlight?: string       // isSafeColor
  bold?: true; italic?: true; underline?: true; strike?: true
  // paragraph parts
  block?: 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  align?: 'left' | 'center' | 'right' | 'justify'
}
type NamedStyle = { id: string /* uuid */; name: string; props: StyleProps; favorite: boolean; createdAt: number; updatedAt: number }
```

- **One validator for both sides:** `cleanStyleProps(value): StyleProps | null` and `canonicalProps(props): string`, which is JSON with sorted keys. It rejects unknown keys, unsafe values and empty props.
- **Names:** 1–60 characters, trimmed, with control characters removed. They are unique per user, ignoring case.
- **A style sets only the parts it has.** A part it doesn't have is left alone. For example, a style with only `color` recolors text but doesn't touch bold.

### 4.2 How text remembers its style ("update everywhere" while keeping manual tweaks)

A new **inline mark, `namedStyle`**, has the attributes `{ id: uuid, applied: string }`:
- `applied` is the canonical JSON of the **inline parts that were stamped** when the style was applied or last refreshed.
- It renders as `<span data-style="<id>" data-style-applied="…">`. `parseHTML` reads them back, so copy and paste inside Margin keeps the link.
- It is `inclusive: true`, so typing at the end of styled text continues the style. It `excludes` itself, so a span has only one style.

**Paragraph styles** add two global attributes on `paragraph` and `heading`: `styleId` (uuid or null) and `styleApplied` (canonical JSON of the stamped `block` and `align`, or null).
- They are rendered as `data-style-id` and `data-style-applied` and parsed back.
- `heading` and `paragraph` both carry them, so changing the block type keeps the link.

**The real formatting is always stamped into the document:** textStyle attributes, highlight, the bold and other marks, the node type and textAlign. Every note is therefore self-contained:
- the server's text extraction and the existing renderers need nothing new
- a deleted style naturally "keeps the current look"

**Refreshing a style's text ("restamp", client-side, `web/src/namedStyles.ts`).**

For every inline range tagged `namedStyle{id, applied}`:
- **If `id` isn't one of the user's styles** (deleted, or pasted from another account), remove only the `namedStyle` mark. The formatting stays.
- **Otherwise,** with `old = parse(applied)` and `cur = style.props` limited to the inline parts:
  - For every key where `old[k] !== cur[k]`: if the text's *current* value equals `old[k]` (nobody overrode it), set it to `cur[k]`, or remove it when `cur[k]` is undefined. If it differs, it's a manual tweak and stays.
  - Then set `applied = canonical(cur)`.

Blocks with `styleId` work the same way for `block` and `align`. A change of block type is skipped where the schema doesn't allow it, for example the first child of a list item must stay a paragraph.

**When restamping runs:**
1. **When a note opens:** once both the note and the user's styles are loaded, and only if the note is editable.
2. **When the user's styles change in this tab:** create, update, delete.
3. **When styles are re-fetched on window focus,** because another tab may have edited them, if anything changed.

**Restamp transactions:**
- They set `addToHistory: false` and a meta flag `namedStyleRestamp`. They are dispatched only when something actually changes.
- The resulting update autosaves normally.
- Notes that are never opened keep their old look until opened. That is acceptable, because nothing else renders them.

### 4.3 Applying a style (`applyNamedStyle(editor, style)`)

**Range:**
- With a non-empty selection: the selection's text, and for paragraph parts every textblock it touches.
- With an empty selection: the whole current textblock, which is how Word paragraph styles behave.

**Inline parts:** for each text range,
- Set every key the style has, even if the text overrode it, because applying is explicit.
- For keys only in the *previous* style's `applied` (switching from style A to style B), remove the value if it still equals A's applied value.
- Set `namedStyle{ id, applied: canonical(inlineParts) }`.

**Paragraph parts:** for each touched `paragraph` or `heading`, set the block type and alignment if the style has them, and set `styleId` and `styleApplied`.

Applying is one undoable step, and the editor keeps focus.

**"Remove style"** (in the Styles menu) un-applies the style for the range: values that still equal `applied` are removed, then the tags are removed.

### 4.4 Clear formatting

The existing `unsetAllMarks().clearNodes()` already drops `namedStyle`, because it is a mark. It is extended to reset `styleId` and `styleApplied` on the affected blocks.

### 4.5 Styles menu (toolbar)

**Trigger:** "Styles▾", or the current style's name in its own font when the cursor is in styled text.

**Popover** (about 300px; a bottom sheet on phones):
- **Header:** the current style's name and a **★** that favorites it. With no style at the cursor: "No style" and the ★ disabled.
- **"＋ Save selection as a style…"** opens the inline **save form**:
  - a name field
  - a **parts checklist** filled from the formatting at the selection's start
    - Font: Lora
    - Size: 14
    - Text color: ■ Red
    - Highlight: ■ Yellow
    - Bold, Italic, Underline, Strikethrough
    - Paragraph: Heading 2
    - Alignment: Center
  - Parts that are set are pre-checked. Normal paragraph and left alignment start unchecked but can be checked.
  - Save is disabled until there is a name and at least one part.
  - Saving creates the style **and applies it** to the selection, so the source text is linked too.
- **Search** (shown once there are more than 8 styles), then **Favorites** and **All styles** (alphabetical).
  - Each row previews the name in the style's font, size (clamped to 11–20pt for the menu), colors and emphasis. Previews load the font through `ensureFont`.
  - Rows also show the paragraph type and alignment as a small caption, a ★ toggle, and a "⋯" for the row actions.
  - Clicking a row applies the style.
- **Row actions:**
  - **Update to match selection:** opens the save form prefilled from the selection, with the style's current parts checked.
  - **Rename.**
  - **Delete:** asks "Delete 'Callout'? Text that uses it keeps its look."
- **Footer:** "Remove style" when the cursor is in styled text.

**Keyboard:** arrow keys move between rows, Enter applies, and ★ and ⋯ are reachable with Tab.

### 4.6 Favorite-style shortcuts

The user asked for Ctrl+Alt+1…9, but **Ctrl/⌘+Alt+1–6 are already the heading shortcuts** (StarterKit; the same in Google Docs).

**Plan: Alt+Shift+1…9** (Option+Shift on Mac), matched by `event.code` (`Digit1`…`Digit9`) so keyboard layouts don't matter.
- They apply favorites 1–9 in menu order (alphabetical within Favorites).
- The menu shows each favorite's shortcut.
- The final report will explain this deviation to the user.

### 4.7 Server

**Migration 4:**
```sql
CREATE TABLE styles (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  props       TEXT NOT NULL,          -- canonical JSON (shared/styles.ts)
  favorite    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX styles_user_name ON styles (user_id, name COLLATE NOCASE);
```

**Routes** (session required, JSON, the existing guard and 409 user binding):

| Route | Behavior |
|---|---|
| `GET /api/styles` | `{ styles: NamedStyle[] }`, ordered by name |
| `POST /api/styles` `{name, props, favorite?}` | 201 with the style. 400 for invalid props or name; 409 `{code:'name_taken'}`; 400 past **500 styles** per user. The insert only happens if the user still exists. |
| `PATCH /api/styles/:id` `{name?, props?, favorite?}` | 200 with the style; 404 if it's not this user's. Changing `props` or `name` bumps `updated_at`. |
| `DELETE /api/styles/:id` | 204; 404 if it's not this user's |

**Document validator (`shared/doc.ts`):**
- `namedStyle` is added to the mark allowlist. `id` must be a uuid; `applied` must parse through `cleanStyleProps` and contain inline parts only (the empty `{}` is allowed). Otherwise the mark is dropped and the text kept.
- `styleId` and `styleApplied` on paragraph and heading are cleaned the same way; an invalid value is set to null.
- The server never checks that a style id exists. Unknown ids are cleaned up lazily by the client (§4.2).

**Accounts (`server/users.ts`):**
- `delete --purge` removes the user's styles.
- `--transfer-to` and `reassign` move styles to the target. A name clash gets " (2)", " (3)" and so on, and the style ids stay the same, so tagged text keeps working.
- `margin-user list` gains a STYLES column.

### 4.8 Client store (`web/src/namedStyles.ts`)

- **Module state,** like font favorites: `loadStyles()`, `subscribeStyles()`, and `createStyle`, `updateStyle`, `deleteStyle` and `setStyleFavorite`, each optimistic with a revision guard.
- **401 or 409:** the change waits for re-auth, as favorites do.
- **Re-fetching:** on window focus, and on `onReauthenticated`.
- **Change events:** a `stylesChanged` event triggers the restamp in the open editor.
- **Capture:** `captureProps(editor): StyleProps` reads the formatting at the selection's start, including `currentFontSize()` and `firstFontFamily`.

## 5. Testing

**Unit tests:**
- `cleanStyleProps` and `canonicalProps`
- the validator for `namedStyle` and the style block attributes, including round trips through `schema.nodeFromJSON`
- the restamp algorithm on ProseMirror docs:
  - an unchanged value is updated
  - a manually overridden value is kept
  - a removed part is unset
  - a deleted style is untagged with the look kept
  - a block type change is skipped inside a list item
- apply and remove; switching from style A to style B
- capture from mixed formatting

**Server:**
- styles CRUD and isolation: user B can't see, patch or delete A's styles
- the 500 cap, name uniqueness, invalid props
- migration 4
- users: delete, transfer and reassign with name-clash renaming

**End-to-end** (`phase4.mjs`, throwaway instance):
- **Sidebar:** collapse and expand by button and Ctrl+\\; the setting persists across a reload; rail links open notes; the rail search expands the sidebar and focuses search.
- **Toolbar:**
  - it is a single row at 1400px, both with the sidebar expanded and collapsed
  - every menu opens, works from the keyboard, and keeps the editor selection
  - the Insert table submenu works
- **Styles:**
  - save from formatted text, then apply elsewhere in the same note and in another note
  - edit the style, and both places update after reopening, with a manual tweak preserved
  - favorite it; Alt+Shift+1 applies it
  - delete it; the text keeps its look and loses the tag
- **Font menu:** the header ★ works.
- **Phones:** the toolbar menus become bottom sheets.
- **Regression:** the Phase 1–3 suites (61, 59 and 40 checks) still pass.

## 6. Rollout

1. Back up the volume with Margin stopped, and tag `margin:phase3`.
2. Rebuild. Migration 4 runs.
3. Check read-only: all notes unchanged, styles empty, sign-in works.
4. Update the README: the sidebar, the toolbar, styles and shortcuts.

## 7. Out of scope

- Sharing styles between users, or importing and exporting them
- Style inheritance ("based on")
- Rewriting notes that are never opened on the server
- Restyling the built-in heading levels themselves

---

## 8. Beta review: what changed from v1 (this section wins)

Reviewers: Sonnet 5.5, GPT-6.1 sol and terra, Muse, DeepSeek and GLM, with Grok, MiniMax and Kimi pending.

They found that the v1 approach could not be made reliable. v1 copied a style's formatting into the text, then kept a snapshot and "restamped" lazily on the client. Problems they demonstrated:
- **Undo broke** after a restamp (Sonnet reproduced it).
- **Formatting got wiped.** `addMark(textStyle)` replaces the whole mark, so restamping the color erased the font and size (DeepSeek and sol verified this).
- **Overrides were misread.** A hand-tweak that happens to equal the old value is indistinguishable from no tweak. Adding a new part to a style never reached existing text.
- **Links got stripped** whenever the styles list was empty, failed to load or was stale.
- **Notes reordered.** Opening a note after a style edit rewrote it, bumped `updated_at`, and moved it to the top of the list.
- **Stale tabs overwrote notes.** A stale tab could restamp an old copy and overwrite newer edits.
- **Values came in many forms:** heading-default sizes, font stacks versus first families, `rgb()` versus hex.

### 8.1 New style mechanics: tags in the document, look from generated CSS

**The document stores only which style text uses:**
- An inline mark `namedStyle { id }` renders as `<span data-style="<uuid>">`.
- A block attribute `styleId` on `paragraph` and `heading` renders as `data-style-id="<uuid>"`.
- Both are defined in `shared/extensions.ts` (a `NamedStyle` Mark and a `NamedStyleBlock` extension using `addGlobalAttributes`), so the server's schema check knows them.
- `keepOnSplit: true`: Enter continues the paragraph style, like Word.

**Generated CSS supplies the look.** `web/src/namedStyles.ts` keeps one `<style id="margin-named-styles">` element. CSP `style-src` already allows inline styles. It contains, for each of the user's styles:
```css
.document span[data-style="ID"] { font-family:…; font-size:…; color:…; background-color:…; font-weight:700; font-style:italic; text-decoration-line: underline line-through; }
.document [data-style-id="ID"] { /* paragraph parts */ text-align:…; font-size/weight/line-height/margins of the chosen heading level }
```

**Editing a style changes every use at once,** in every note and every open tab (they re-fetch styles on focus). Notes are never rewritten: no restamp, no autosave, no `updated_at` bump, no undo problems, no multi-tab overwrites.

**Manual tweaks win automatically.** The existing marks render inside the style span: textStyle as `<span style="color:…">`, highlight as `<mark style>`, and `<strong>`/`<em>`/`<u>`/`<s>`. CSS inheritance means the innermost declaration wins. For alignment, manual `textAlign` is an inline style on the block, which beats the generated rule.
- **Known limit:** a tweak can't *remove* bold, italic, underline or strike that the style adds. CSS has no "not bold" mark. This is written up as a limitation.

**Deleting a style keeps the look** through a tombstone:
- `DELETE` sets `deleted_at`. The style disappears from menus, but its definition and CSS stay, so the text looks exactly as before.
- A deleted style can't be applied, edited or favorited. "Remove style" still works on its text.
- A tombstone uses one row. Notes are never rewritten.

**Unknown ids** (pasted from another account) simply have no CSS. The text shows its own marks only, and nothing is ever stripped, so a failed or stale styles fetch can't harm documents.

**Paragraph type, two layers:**
1. When the style is applied, the block's node type is set if the parent allows it. This uses a `contentMatch` check through `parent.canReplaceWith`; the first child of a list item or task item stays a paragraph, and `detailsSummary` and `codeBlock` are skipped. That keeps structure and semantics right.
2. The *look* comes from the CSS. The generated block rule copies the chosen heading level's typography from `editor.css`, through a shared TS map, so a later change of the style's paragraph type re-renders every use even where the node type couldn't change.

A manual "Normal text / Heading N" change in the toolbar **detaches** the block (clears `styleId`), so the manual choice visibly wins.

**Fonts:** `fontsInDoc()` also loads the font of every style used in the document, through tags and block ids, plus the fonts of favorite styles when the menu opens.

### 8.2 Applying, removing, clearing

**Apply (one undoable transaction, through custom transform code, not toolbar commands):**
- **Non-empty selection inside one block:** inline parts only. For each text node, remove the *direct* formatting for the parts the style defines (Word's "applying a style resets direct formatting"): rebuild the merged textStyle attributes per node and drop the mark when all are null, then remove the typed marks. Then add `namedStyle{id}`, which replaces any other `namedStyle` because the mark excludes itself.
- **Collapsed selection, or a selection covering whole blocks:** the paragraph parts apply to every touched `paragraph`/`heading` (sets `styleId`, clears manual `textAlign` if the style defines alignment, sets the node type where allowed). The inline parts apply to all the text in those blocks.
- **Empty paragraph:** sets the block attribute, and adds stored marks so typing continues the style.
- **Inline code** (which excludes all other marks) and **code blocks** are skipped. A style is never "recorded" where it couldn't apply. Toggling inline code on styled text removes the tag; that is documented.

**Remove style:** removes the `namedStyle` marks in the range and clears `styleId` on the touched blocks. The look reverts to the remaining direct formatting.

**Clear formatting (Tx):**
- Also clears `styleId` on the affected blocks.
- With a collapsed cursor, acts on the current block and the stored marks. Today `unsetAllMarks` silently does nothing with a collapsed cursor; that is fixed.
- **Ctrl/⌘+\\ becomes Clear formatting**, the Google Docs shortcut.

**Current style shown in the menu:** the inline tag at the cursor or selection start comes first, then the block's `styleId`. Mixed selections show "Mixed". The trigger shows the name; the header ★ favorites that style.

### 8.3 Style definitions, capture, validation

**Props:**
- `{ fontFamily?, fontSize?, color?, highlight?, bold?, italic?, underline?, strike?, block?: 'paragraph'|'h1'…'h6', align? }`
- Validated by a dependency-free `shared/styleProps.ts`, so there's no import cycle with `doc.ts`.
- Canonical forms:
  - fontFamily: the full family value as the font picker writes it
  - fontSize: `"<n>pt"`, 1–400
  - colors: lowercase `#rrggbb`. Capture converts `rgb()` and short hex. Other color forms are dropped from the capture checklist.
- Empty props are rejected. The props JSON is at most 2 KB.

**Capture** ("Save selection as a style…" and "Update to match selection"):
- Reads **explicit** values at the selection start: the textStyle attributes, highlight color and typed marks of the text node at `from` (not `getAttributes`), plus that block's type and *explicit* `textAlign`. If the text is already styled, the style's props are merged underneath.
- Implicit defaults (11pt, Arial, heading sizes, left) are not set.
- The checklist pre-checks only the parts that are actually set. Paragraph type is pre-checked only for a heading.

**Names:** trimmed, NFC, with control and bidi-format characters stripped, 1–60 characters. A `name_key` column (`name.normalize('NFC').toLocaleLowerCase('und')`) gives Unicode-aware uniqueness: `UNIQUE (user_id, name_key)` among non-deleted styles, using a partial index.

**Ids are generated by the client** and sent in `POST`. The server validates the uuid and makes the insert idempotent per (user, id). The style can therefore be applied right after the request succeeds. The save form keeps a mapped selection bookmark from when it opened, and applies there after the POST resolves; if the editor is gone, nothing is applied.

**No optimistic document changes.** Creating, updating and deleting styles only touch documents after the server confirms. CSS updates on confirm. A failure shows a notice; `name_taken` appears inline in the form.

**No count cap** (the user asked for unlimited). Each definition is bounded (2 KB), and the menu is search-first and virtualized.

**Document validator (`shared/doc.ts`):** the `namedStyle` mark needs `id` to be a uuid, otherwise the mark is dropped; `styleId` must be a uuid or null. Nothing else is stored, so document size barely grows.

### 8.4 Server

**Migration 4:**
```sql
CREATE TABLE styles (
  id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
  props TEXT NOT NULL, favorite_slot INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX styles_live_name ON styles (user_id, name_key) WHERE deleted_at IS NULL;
```

**`favorite_slot` (1, 2, 3, …)** gives stable shortcut numbers.
- Starring takes the lowest free slot; unstarring frees it. Shortcuts therefore never renumber when another style is starred.
- Favorites are listed by slot. The menu shows slots 1–9 with their shortcut.

**Routes:**

| Route | Behavior |
|---|---|
| `GET /api/styles` | Live and deleted styles. Deleted ones are needed for CSS, and flagged. |
| `POST /api/styles` | Body `{id, name, props}` |
| `PATCH /api/styles/:id` | Body `{name?, props?, favorite?}`. A name clash is 409 `{code:'name_taken'}` on both POST and PATCH (the constraint error is caught). Deleted styles answer 404. |
| `DELETE /api/styles/:id` | Sets the tombstone, which frees the slot and the name. |

All of these insert only for existing users.

**Client 409 handling:** `api.ts` now ends the session **only for `code: 'user_mismatch'`**. Today any 409, including `name_taken`, would open the session dialog.

**Accounts:**
- `owned()`, the delete refusal, the CLI messages and `list` include style counts (live ones).
- `--purge` deletes the styles.
- `--transfer-to` and `reassign` move them in the same transaction:
  - Ids are kept, so text stays linked.
  - Name clashes become " (2)", " (3)" and so on, looping until free with the base truncated to fit 60 characters.
  - Favorite slots are renumbered after the target's own.

### 8.5 Toolbar (revised)

**Width:** the real budget at 1200px with the sidebar open is about 840px (sol, Sonnet, GLM and DeepSeek all measured).
- Revised target: **one row at ≥1280px expanded and ≥1000px collapsed.** The e2e test measures 1280 expanded, 1000 collapsed and 1100 tablet.
- Trims to get there:
  - Styles trigger: 104px
  - Normal-text select: 96px
  - Font: 100px
  - Buttons: 30px
  - Separators: 1px with 4px margins
  - Clear formatting stays as one button
- Below those widths the toolbar wraps, as today. Phones scroll sideways.

**Menus (`ToolMenuButton`):**
- Opening **focuses the first enabled item**. Arrows, Home and End move; Enter and Space activate.
- **Escape closes only the innermost layer** (a `useDismiss` stack) and returns focus to the **editor**, matching the existing popovers. Activating an item also refocuses the editor. The ProseMirror selection lives in editor state, so it survives the focus move.
- Plain menus (More, Alignment, Lists, Insert) use `menu`/`menuitem`/`menuitemcheckbox`.
- **The Styles popover is a dialog:** a search box plus a listbox with `aria-activedescendant`, like FontPicker. Rows are options; the ★ and ⋯ are separate buttons reachable by Tab.
- **Insert → Table** opens the existing size grid as a second panel (a dialog). ArrowRight or Enter opens it; Escape returns to the Insert menu.
- **The hidden image file input stays mounted in the toolbar.** The menu item calls `.click()` on it, so the menu closing doesn't lose the picked file.
- **Edge collision:** menus that would overflow the right edge align to the trigger's right. All menus have `max-height` with scrolling.
- **Table options▾** appears only in a table. The extra 34px may wrap the row at the minimum widths, which is accepted.

### 8.6 Sidebar rail (revised)

- **One persistent toggle button** (it only changes its icon and label) is placed at the top of the sidebar in both states, so focus is never lost.
- If collapsing hides the focused element, focus moves to the toggle.
- **Shortcut: Ctrl/⌘+Shift+\\**, matched by `event.code === 'Backslash'` (works on AZERTY and others). Ctrl/⌘+\\ is now Clear formatting (§8.2). It is ignored while the session dialog or another dialog is open.
- **Width:** `.app.is-collapsed { --sidebar-width: 68px }` comes after the tablet media rule and is more specific (the tablet rule moves to `.app:not(.is-collapsed)`).
- **Rail notes:** the **unfiltered** newest 12, kept separately from search results.
  - The letter is the first grapheme of `displayTitle` (`Intl.Segmenter`), so emoji work; the same fix applies to the avatar.
  - Targets are 40px, with a visible tooltip on hover and focus, and `aria-current`.
- **Landmark:** the rail's label is "Recent notes", which avoids a duplicate "Notes" landmark.
- **Account popover** in the rail opens to the right (a `placement` prop), 240px wide.
- **No column animation.** Reflowing large notes every frame is costly; the change is instant.

### 8.7 Shortcuts (revised)

- **Favorite styles: Ctrl+Alt+Shift+1…9** (⌘+Option+Shift on Mac).
  - Alt+Shift switches the keyboard layout on Windows (GLM, DeepSeek), and Ctrl+Alt+1–6 are headings. Ctrl+Alt+Shift+digit is free in Tiptap and the browsers.
  - Matched by `event.code` in the editor's own `handleKeyDown`, so it only works while typing in an editable document, never in inputs. It calls `preventDefault`.
  - The user will be told about the deviation.
- **Sidebar:** Ctrl/⌘+Shift+\\. **Clear formatting:** Ctrl/⌘+\\.

### 8.8 Tests (revised)

**Unit tests:**
- `styleProps` validation and canonical forms (colors, sizes, names, Unicode keys)
- the document validator with the mark and attribute (malformed ids dropped)
- an HTML round trip: render, then `parseHTML` for the mark and the block attribute
- CSS generation, including escaping, and ignoring an unsafe value even if stored
- apply and remove in many cases:
  - a mixed selection
  - direct formatting reset per text node (font kept when only the color is reset)
  - an empty paragraph with stored marks
  - collapsed versus whole-block selection
  - list item and task item first child, details summary, code and code block skipped
  - one undo step
- clear formatting with a collapsed cursor
- capture: only explicit values, `rgb()` to hex, merging with an existing style

**Server:**
- CRUD and isolation
- idempotent POST with a client id
- PATCH and POST name clash returning 409 `name_taken`
- tombstones (hidden from apply, kept in GET)
- favorite-slot allocation
- migration 4
- accounts: delete refused for a styles-only user; purge; transfer with clash renaming and kept ids

**Client:** the api 409 handling, so `name_taken` doesn't end the session.

**End-to-end:**
- **Rewrite the e2e suites** for the new toolbar (DeepSeek): open ⋯, Alignment, Lists and Insert before acting. Check counts will change.
- **New `phase4.mjs`:**
  - the rail: toggle and shortcut, persistence, focus, tablet width, recents ignoring an active search
  - toolbar row widths at the stated sizes, keyboard use of every menu, Insert → Image and Table
  - styles: save, apply in two notes, edit (both update without reopening; a manual tweak survives), favorite plus Ctrl+Alt+Shift+1, delete (the look stays and the style is gone from the menu), two tabs (an edit in tab A shows in tab B after focus)
  - the font menu header ★
  - phone bottom sheets

### 8.9 Declined

- **Note revision checks / If-Match for all note saves** (terra, sol). No longer needed for styles, since notes aren't rewritten automatically. Two-tab editing of the same note stays last-write-wins, as documented since Phase 1.
- **Split buttons for lists and alignment** (Sonnet). The user chose dropdowns. The trigger icon shows the current state.

## 9. Implementation notes

- **Shared code:**
  - `shared/styleProps.ts` is the dependency-free module for validation, canonical forms, names and the stylesheet generator.
  - `shared/namedStyle.ts` holds the `NamedStyle` mark (priority 1001, so it renders outermost) and the `NamedStyleBlock` global attribute. Both are registered in `shared/extensions.ts`.
- **Server:**
  - `server/styles.ts` is the store. POST is idempotent per client id; PATCH and POST return `name_taken`; deletion leaves a tombstone; favorite slots are stable.
  - Accounts: `server/users.ts` moves styles on transfer and reassign, keeping ids and resolving clashes with " (n)" truncated to 60 characters; purge deletes them.
- **Client:**
  - `web/src/namedStyles.ts` holds the store and the `<style id="margin-named-styles">` element. It changes only after the server confirms, and re-fetches on window focus and after re-auth.
  - Ids come from `crypto.getRandomValues`, because `randomUUID` needs a secure context and a LAN address isn't one.
  - `web/src/styleCommands.ts` implements apply, remove, clear, capture and current style as raw transforms. textStyle attributes are merged per text node; inline code and code blocks are skipped; block types are guarded by `canReplaceWith`; an empty paragraph gets stored marks.
- **Toolbar:**
  - `ToolMenuButton` and `MenuItem` live in `ToolbarParts.tsx`.
  - Focus goes back to the editor *synchronously* (`view.focus()`): with the frame-delayed `commands.focus()`, the first keystroke after a menu action could be lost.
  - **Measured content width:** 812px, so one row at ≥1280 expanded and ≥1000 with the rail.
- **Tests:**
  - Unit: `server/styles.test.ts` (14), `web/src/styleCommands.test.ts` (14), `web/src/api.test.ts` (409 handling).
  - E2E: `/tmp/margin-e2e/phase4.mjs` (43 checks). The older suites use `toolbar.mjs` to reach controls that moved into menus: e2e 61/61, phase2 59/59, phase3 40/40.

## 10. Code review: fixes

Reviewers: Sonnet 5.5, GPT-6.1 sol and terra, and Muse. DeepSeek, MiniMax, GLM and Kimi could not run: the OpenCode Go weekly usage limit was reached. Grok reported after the first deploy; its fixes were redeployed (below).

**Fixed:**
- **Inline code at the cursor (sol, Sonnet; high).** Applying a style with a collapsed cursor inside inline code stored `code` together with `namedStyle`, which made an invalid mark set the next time the user typed. Stored marks are now built with `Mark.addToSet`. There is a regression test.
- **The style list.**
  - **Stale refresh (terra, Muse).** A list fetched before a confirmed change could revert it. A mutation counter now drops stale lists and refetches.
  - **Out-of-order responses (sol).** Responses for the same style can no longer arrive out of order and resurrect a deleted style: mutations run one at a time per style.
  - **Failed load (Muse).** It is no longer shown as "Loading…" forever: there is a failed state, with a retry on menu open and on window focus.
- **Style links.**
  - **Typing at the cursor (terra).** Applying at a collapsed cursor now clears the direct `textStyle` parts the style defines from the stored marks, so the next typed text shows the style.
  - **Parts added later (sol).** Whole paragraphs are linked (`styleId`) even for styles without paragraph parts. The paragraph rule carries the text parts too, so parts added to a style later reach those paragraphs.
  - **Highlight and lines (Sonnet).** These stay on text spans, so a highlight style doesn't paint the whole paragraph box.
- **Saving a new style.**
  - **The source selection (sol, Sonnet).** The bookmark is mapped through every transaction while the form is open or saving.
  - **One id per form (Muse).** The id is fixed when the form opens, so a retry after a lost response is idempotent.
  - **Server checks (Sonnet).** POST with an existing id is accepted only for the identical live style; otherwise it answers 409 `id_in_use`.
- **Update to match selection.**
  - **It ignored the linked definition (sol, Sonnet).** It now keeps the linked definition's block type, and starts from the union of the style's parts and the captured look.
- **Manual heading changes (Sonnet).** Ctrl+Alt+1–6, "## " and the toolbar now unlink the paragraph style, as does Enter after a styled heading. This is done by an `appendTransaction` plugin (`detachOnTypeChange`) that compares the old and new node type and level; style applies are exempt through a meta flag.
- **Remove style** on part of a paragraph removes only those words' tags; the paragraph keeps its link (Sonnet).
- **Clear formatting with a collapsed cursor** no longer wipes the whole paragraph. Only the next typed text is plain, as in Google Docs.
- **Font names (Sonnet).** Control characters are rejected in font names in styles and documents, because a newline would end a CSS string early.
- **Copying into other apps (Sonnet).** Styled text copied to mail or Google Docs keeps its look: a clipboard serializer inlines the style's declarations and keeps the `data-style` tags for pasting back into Margin.
- **Menus.**
  - **Focus (found while testing the fixes).** Opening with the mouse leaves focus in the document, as in Google Docs; only keyboard opening moves focus into the menu. Moving focus back and forth made ProseMirror ignore a keystroke that came straight after a menu action.
  - **Insert menu (Muse, Sonnet).** It always reopens on its list (`onOpenChange`).
  - **Table options and the color menus (Muse, Sonnet)** now use the shared keyboard menus.
  - **Alignment items** are `menuitemradio` (Sonnet).
  - **Labels (Sonnet).** The paragraph select is labelled "Paragraph type".
- **Styles menu.**
  - **Accessibility (Sonnet).** Rows no longer nest buttons inside options, and `aria-controls` is never dangling.
  - **Keyboard (sol).** Enter on a row's ★ or ⋯ no longer applies the style.
  - **Focus (Muse).** The panel takes focus when there's no list or search yet, so typing never lands in the note.
- **Feedback.**
  - **Paragraph styles on a partial selection (Muse)** show a notice explaining that they need a cursor or whole paragraphs.
  - **The favorite shortcut (Sonnet)** only reports "no favorite" once the styles have loaded, and does nothing in read-only notes.
- **Display and spacing.**
  - **Font menu (Muse).** It shows a font that comes from a style.
  - **Heading margins (Muse).** Generated paragraph rules copy the heading's margins.
  - **Collapsed sidebar (Muse).** It drops a deleted note even while a search is active.

**From Grok (after the first deploy, redeployed):**
- **Enter in a styled paragraph unlinked the new half (high).** The unlink-on-type-change plugin mapped the split-off block back to a text position and read that as a type change. It now compares against the enclosing textblock: a same-type split keeps the link, and Enter after a styled heading still starts an unlinked paragraph.
- **Remove style on a few words left them looking styled (high).** The paragraph rule carried the text parts (color, weight). The fix: every whole-paragraph apply now **tags the text** too, even for styles without text parts yet. Paragraph rules carry only the heading look and alignment, so removing a style from some words really removes its look, and parts added to a style later still reach every use.
- **Spacing:**
  - A Normal-text paragraph style no longer emits `margin: 0`, which flattened paragraph spacing.
  - Heading spacing applies only to top-level paragraphs, so list lines keep their own.
- **Links inside styled text** take the style's color.
- **The paragraph-type select** unlinks a paragraph even where its node type can't change (a list item's first line), and it shows the linked style's type.
- **Focus:** the font picker, size box and link popover return focus synchronously, like the menus.
- **The sidebar shortcut** is ignored while a dialog is open.
- **Insert → Table** opens with ArrowRight.
- **The CLI** prints the moved style count for `delete --transfer-to`.

**Declined:**
- **Virtualizing the styles list** (Grok). Fonts already load only for visible rows, and a personal style list stays small. This can be revisited if anyone's list grows into the hundreds.
