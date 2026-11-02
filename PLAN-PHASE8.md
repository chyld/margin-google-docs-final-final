# Phase 8: a Format sidebar on the right

The user's request: "make a sidebar on the right that is collapsable, the sidebar will show you the current formatting for the text you are on, it will also show you the name of the style, if appropriate."

The beta team (Sonnet, gpt-6.1-sol, gpt-6.1-terra, grok and muse) advised first. The user then chose:
- **What it does:** shows information, plus two buttons: **Clear formatting**, and the style name, which opens the Styles menu. It has no duplicate pickers.
- **Collapsing:** it hides fully. A toggle at the right end of the toolbar, and a shortcut, bring it back.
- **Default:** open on wide screens on first use, closed on smaller ones. Afterwards the choice is remembered per device.
- **Phones:** a **bottom sheet** opened by the same toolbar button.

All five reviewers agreed on these points, so they're decided:
- Show the text style and the paragraph style separately.
- Label where each value comes from.
- Show "Mixed" per property.
- Leave out line spacing; it isn't a stored property.
- Don't show the panel on home.
- Add no live region.
- Use one shared derivation, so the toolbar and the panel can't disagree.

## 1. What the panel shows

A header with "Format" (`h2`), a "Read-only" tag when it applies, and a close button. Then these sections, top to bottom:

- **Styles:**
  - **Rows:** a **Text style** row and a **Paragraph style** row, each showing one of:
    - the style name, a button that opens the Styles menu
    - "No style"
    - "Mixed" (with the names in a tooltip, up to 3)
    - "Name (deleted)"
    - "Unknown style" (the id was not found once styles had loaded)
    - "Loading…" (styles not loaded yet)
  - **"Includes":** under a named style, a muted line listing what the style itself defines, reusing the Styles menu's `caption()`, extended with B/I/U/S and colors.
- **Paragraph:**
  - **Type:** Normal text or Heading 1–6. A linked style's type wins over the node, as in the toolbar.
  - **Alignment.**
  - **Context chips,** only when true: Bulleted list, Numbered list, Checklist, Quote, Code block, Table, Collapsible section.
- **Text:**
  - **Rows:** font, size (pt), bold, italic, underline, strikethrough, code, text color (a swatch plus hex), highlight (a swatch plus hex, or "None"), and link (the truncated href, or "None").
  - **Source chip:** each row shows one of:
    - **Direct**: a mark on the text.
    - **the style's name**: a text style, or a paragraph style on an empty line.
    - **Default**: the page or heading default, such as "11pt", "IBM Plex Sans", Heading 4's bold or Heading 3's grey.
    - **Mixed**: the values differ across the selection. When the values agree but the sources differ, the chip says "Mixed sources".
  - **Defaults are real values,** never blank. Font: IBM Plex Sans. Size: the type's size. Color: the type's color (`#202124`, or `#434343` for h3 and `#666666` for h4–h6). Bold: on for h4 and h5. Italic: on for h6. All come from `BLOCK_TYPOGRAPHY`.
- **Special cases:**
  - **Image selected:** the Text section is replaced by "Image" and its alignment.
  - **Code block:** the Text section shows only "Code block · monospace".
  - **Empty line or plain cursor:** the section caption reads "Typing here", and the values are what the next character gets. That means the stored marks, plus the paragraph style on an empty linked line, using the same rules as `effectiveTextProps`.
- **Actions:**
  - **Clear formatting** (`clearFormatting`, the same as Ctrl/⌘+\) is disabled when the note is read-only or locked.
  - The style names open the Styles menu.

## 2. One derivation: `inspectFormatting`

- A new pure module, `web/src/formatInfo.ts`, provides `inspectFormatting(state, styleOf, { stylesLoaded })`.
- **What it returns:**
  - `styles: { text, paragraph }` (`none | mixed | { id }`)
  - `block: { value, source }`, `align: { value, source }`, `context: string[]`
  - `image: { align } | null`, `codeBlock: boolean`, `typingHere: boolean`
  - `text: { fontFamily, fontSize, bold, italic, underline, strike, code, color, highlight, link }`, each `{ value, source }` with `source: 'direct' | 'style' | 'default' | 'mixed' | 'mixed-sources'` plus `styleId` when the source is a style
- **How it works:**
  - **Text pieces:** it walks only the selection's text nodes (`nodesBetween`), or reads the marks at the cursor (stored marks first).
  - **Per piece:** the value is the direct mark's attribute if there is one; else the text style's prop; else, on an empty linked line, the paragraph style's prop; else the block default.
  - **Aggregation:** per property. Flags are "on" only if every piece is on.
  - **Large selections:** past 5,000 text nodes it stops walking and marks the unresolved properties "mixed". That keeps select-all on huge notes bounded.
- **The toolbar reads the same function.** `selectState` takes bold, italic, underline, strike, color, highlight, font family, font size, alignment and block from `inspectFormatting`, using a uniform value or null/false. `can.*` and other toolbar-only fields stay where they are. This replaces the separate `effectiveTextProps`/`currentFontSize` reads in `selectState`; `currentFontSize` stays for the size stepper and delegates to `inspectFormatting`.
  - **Intentional difference:** the toolbar's B button shows marks and styles only, never Heading 4's default bold, which a mark can't toggle. The panel shows that default with a "Default" chip.
- **Saved styles changing** (an update, or the first load) emit no editor transaction, so the panel also subscribes to `useNamedStyles()` and recomputes when styles change.

## 3. Layout and behavior

- **Where it lives:**
  - In `Editor.tsx`, the canvas and the panel sit side by side in a new `.editor-body` flex row under the toolbar. The editor instance stays where it is, and nothing is lifted into `App`.
  - The panel exists only while a note is open: not on home, not while a note loads, and not on errors.
- **Width:** 280px, a full-height column with its own scroll, `--sidebar` background and a 1px `--border` on its left edge.
- **The toggle:**
  - A `PanelRight` icon button at the right end of the toolbar, labelled "Format sidebar", with `aria-expanded`, `aria-controls` and `aria-pressed` styling.
  - The close button in the panel header does the same thing.
  - **Shortcut:** Ctrl/⌘+Alt+Shift+\, matched by key position (`event.code === 'Backslash'`), with the same guards as the left sidebar's shortcut: not while a dialog is open, and not on phones. Ctrl/⌘+\ (clear formatting) and Ctrl/⌘+Shift+\ (left sidebar) are taken.
- **Remembering it:**
  - **Key:** `margin:format-panel` (`open`/`closed`), with the same try/catch pattern as `margin:sidebar`.
  - **First use** (nothing stored): open when the window is at least 1280px wide.
  - **Implementation:** a tiny store, `web/src/formatPanel.ts`, using `useSyncExternalStore`, so the toolbar button and the panel share it.
- **Window widths:**
  - **≥ 1200px:** docked. It narrows the page column, which stays at least about 560px wide even with the left sidebar open.
  - **761–1199px:** an overlay floating over the right edge of the canvas, with a shadow. Escape or the close button dismisses it.
    - At these widths it starts closed every time, whatever is stored, and opening or closing it here doesn't change the stored choice, so a narrow window never opens with the page covered.
  - **≤ 760px (phones):** a bottom sheet, opened from the toolbar button. It's `role="dialog"` with `aria-modal`, a scrim, a close button and Escape, and focus returns to the toolbar button. It starts closed and isn't remembered.
- **Focus:**
  - Opening with the button keeps focus on the button. Opening with the shortcut keeps focus in the editor.
  - Closing from inside the panel puts focus on the toolbar toggle.
- **Read-only notes** still show the panel, with the "Read-only" tag and Clear formatting disabled.

## 4. Opening the Styles menu from the panel

- `StylesMenu`'s `ToolMenuButton` owns its open state.
- A small event in `web/src/formatPanel.ts`, `requestStylesMenu()`, dispatches `margin:open-styles`. `StylesMenu` listens for it and opens, from the keyboard path, so focus moves into the menu.
- On phones the sheet closes first, then the menu opens as its own bottom sheet.

## 5. Accessibility

- The panel is `<aside id="format-panel" aria-labelledby="format-panel-title">`, a complementary landmark named "Format". The phone sheet is a dialog.
- Rows are a description list (`<dl>`). Every value is text, never color alone; swatches have the hex beside them.
- There's no `aria-live`, because cursor movement would be constant noise.

## 6. Styling

- The panel uses the Ink & Ochre tokens.
- **Source chips:** small `--radius-sm` chips. Direct is `--accent-soft`/`--accent-ink`. A style chip is `--surface-sunk`/`--text`. Default is muted text with no fill. Mixed is italic and muted.
- **Contrast:** any new color pairs go into `scripts/theme.test.ts`.

## 7. Tests

- **`web/src/formatInfo.test.ts`** (pure, on `EditorState`s built from the shared schema) covers:
  - direct versus text-style versus paragraph-style versus default sources
  - an empty linked line ("typing here")
  - untagged words in a linked paragraph (the character rows don't claim the style)
  - a mixed range per property, and mixed sources
  - deleted, unknown and loading styles
  - heading defaults (h4 bold, h3 grey)
  - an image, a code block, a link href, and the walk cap
- **Toolbar agreement:** for a set of fixtures, the toolbar's derived values equal `inspectFormatting`'s uniform values.
- **Panel component tests** (happy-dom): persistence and the first-use default, the shortcut, the close button and focus, Clear formatting, and the style name dispatching the Styles menu event.
- **E2E** (`/tmp/margin-e2e/phase8.mjs`):
  - the panel docked on a wide window, and hidden on home
  - formatting and the style name following the cursor
  - Clear formatting
  - collapse and expand by button and by shortcut, and persistence after reload
  - the overlay at 1000px
  - the phone bottom sheet
  - The existing suites stay green.

## 8. Rollout

The usual:
1. Fingerprint the notes.
2. Tag `margin:latest` → `margin:phase7`.
3. Back up the volume and verify the backup.
4. Run `docker compose up -d --build`.
5. Verify the notes are unchanged, the session is kept and the smoke test passes.

There's no schema change this time, so rolling back is simply switching back to `margin:phase7`.

## 9. Plan review: what changed (this section wins over §1–§8)

From gpt-6.1-terra, gpt-6.1-sol, muse and Sonnet:

- **The toolbar's own logic is not rewired** (muse and Sonnet's "simplest cut"). Its value semantics stay exactly as they are today: first-piece font, color and size; heading default bold never lights B; mixed alignment shows the first block's.
  - The panel reads `formatInfoFor()`, a single cached computation per editor state and styles snapshot (a `WeakMap` keyed by state).
  - Agreement is enforced by a test: for uniform selections, the toolbar's derived values equal the panel's non-default values.
  - Reason: rewiring would change toolbar behaviour in several places, as all four reviewers found. Their own sharpest advice was to share the walk, not rewrite `selectState`.
- **`inspectFormatting`** (`web/src/formatInfo.ts`, a leaf module; `parseFontSize` moved here and `fontSize.ts` re-exports it):
  - **Walking the selection:**
    - It walks each `selection.ranges` entry, so table cell selections are exact.
    - It skips blocks the selection only reaches the start of.
    - Empty selected lines count for the paragraph parts.
    - It folds in one pass and stops early once everything is known to be mixed. There's no cap: a uniform selection of any size stays correct, as the toolbar's own walks already do.
  - **At a cursor:**
    - Stored marks are authoritative, including an explicit `[]` after clear formatting.
    - The text style and the paragraph style are worked out independently. Untagged words in a linked paragraph claim no text style, and only an empty linked line takes the style's text parts.
  - **New sources:**
    - `element` with a label: links are `#1a73e8` and underlined, code is monospace, quotes are `#5f6368`, and table headers and collapsible titles are bold.
    - `unresolved`, for a style that hasn't loaded or doesn't exist. The panel shows "—", never a confident "Default".
  - **Styles:** the style status is three-way (`loading | loaded | failed`). A failed load shows "Couldn't load styles", not "Loading…" forever.
  - **Matching values:** colors are canonicalized before comparison, and px sizes convert to points as in the size box.
  - **Mixed style rows** carry up to three ids and a total, for the tooltip.
  - **Special selections:** `image` only for a `NodeSelection` on an image, and `codeBlock` only when every touched block is a code block.
  - **Lookups:** styles are looked up through a `Map` built once per styles snapshot.
- **The toggle sits in the note header**, beside Delete (Sonnet). On phones the toolbar scrolls sideways, and on desktop it wraps, so a toolbar-end button could be off-screen or orphaned.
  - It's its own button: `aria-expanded`, plus `aria-controls` while the panel exists. It isn't a `ToolButton`.
- **Opening the Styles menu:** there's no global DOM event. `ToolMenuButton` gains an `openRequest` number prop, which opens it from the keyboard path. The number comes from the `formatPanel.ts` store and passes through `Toolbar` → `StylesMenu`.
  - It's ignored when the menu is disabled. On read-only or locked notes, the panel shows style names as plain text, not buttons.
- **The phone sheet** is a real modal:
  - It's portalled next to `.app`, with the sheet at `z-index` 50 and the scrim at 49, below the session overlay (100) and notices (110).
  - `App` makes `.app` inert while it's open, through a store flag, the same way it does for the session dialog.
  - Focus moves to the sheet's close button and Tab stays inside it. Escape and the scrim close it, and focus returns to the toggle after `inert` is lifted.
  - It closes when the session ends, and when the left drawer opens.
  - Opening the Styles menu from it closes the sheet first, without the focus-return.
- **State model** (`web/src/formatPanel.ts`):
  - **Mode:** `docked` (≥ 1200px), `overlay` (761–1199px) or `sheet` (≤ 760px), from `matchMedia`.
  - **Open:** when docked, the stored value (`margin:format-panel`), or on first use `matchMedia('(min-width: 1280px)')`. Otherwise a transient flag, reset whenever the mode changes.
  - **Storage:** it goes through try/catch, and `storage` events keep tabs in step.
- **Layout:**
  - `.editor-body` is `flex: 1; min-height: 0; min-width: 0; position: relative`, and the canvas gets `min-width: 0`.
  - The docked panel is `flex: 0 0 280px` with its own scroll.
  - The overlay is absolutely positioned inside `.editor-body`, below the toolbar's stacking context, so toolbar menus always stay above it.
  - Escape on the overlay is handled on the `aside` and respects `defaultPrevented`.
- **The shortcut** (Ctrl/⌘+Alt+Shift+\) is a window capture listener owned by `Editor`, so it only works with a note open.
  - It ignores `AltGraph`, key repeat and composition, and does nothing while a dialog other than its own sheet is open or the session has ended. It calls `preventDefault` and `stopPropagation`.
  - No conflicts: the left sidebar shortcut requires no Alt, and favorites use digit keys.
  - **Known limit:** on a few AltGr layouts, AltGr+Shift+\ types a character, so the guard skips the shortcut there.
- **Clear formatting from the panel:**
  - It uses the same effective read-only flag as the toolbar (`readOnly || paused || blocked`), computed once in `Editor`.
  - Its `mousedown` calls `preventDefault`, so the editor keeps its selection.
  - A keyboard activation (`event.detail === 0`) runs it with `focus: false`, so the keyboard user stays in the panel.
- **The "Read-only" tag** follows the note being read-only (`readOnly || blocked`), not the sign-out pause.
- **Panel caption:** the panel has its own caption function. The Styles menu's `caption()` is unchanged.
- **Images:** a selected image hides the paragraph rows too.

From grok, after building (most of its points match the above and were already in):

- **Color order** is direct → style → link → checked item → quote → default, because a style's color beats the link blue (`.document span[data-style] a`).
- **Quote grey** applies only to normal text and headings 1–2. Smaller headings keep their own color.
- **Checked checklist lines** read as struck through and grey, with the source "Checked item".
- **Unchanged:** the toolbar still ignores heading defaults and element looks, as before.

## 10. Implementation notes

- **New files:**
  - `web/src/formatInfo.ts`: `inspectFormatting`, `formatInfoFor` (the cache) and `parseFontSize` (moved here).
  - `web/src/formatPanel.ts`: the store.
  - `web/src/components/FormatPanel.tsx`: the panel.
  - Tests: `formatInfo.test.ts` (23), `formatPanel.test.ts` (5), `formatAgreement.test.ts` (7, comparing the toolbar's `selectState` with the panel for uniform selections), and the e2e suite `/tmp/margin-e2e/phase8.mjs` (19).
- **Changed:**
  - `Editor.tsx`: the `.editor-body` row, the portal for the phone sheet, the shortcut, and one `off` flag.
  - `NoteView.tsx`: the header toggle.
  - `App.tsx`: inert while the sheet is open, and the sheet closes when the session ends.
  - `ToolbarParts.tsx`: `openRequest`.
  - `StylesMenu.tsx` and `Toolbar.tsx`: pass `openRequest`; `clearFormatting` takes `{ focus }`; `selectState` is exported for the agreement test.
  - `fontSize.ts`: re-exports `parseFontSize`.
  - `app.css` and `editor.css`: the layout and the panel styles.
- **E2E helpers:** `toolbar.mjs`'s `toolFor` now looks inside `.toolbar`, because the panel has its own Clear formatting button.

## 11. Code review: what changed

- **terra:**
  - When the browser blocks storage, the docked choice is kept in memory, so the toggle always works.
  - Clear formatting on the phone sheet closes the sheet first and focuses the text only after `inert` is lifted.
- **sol:**
  - A choice that failed to write wins over a stale stored one.
  - Table-header and collapsible-title bold apply only to blocks without their own weight, so headings keep theirs.
  - A paragraph style with a type keeps its own color inside a quote.
  - A highlight without a color reads as the page yellow, `#fff475`.
- **Sonnet:**
  - The panel itself is focusable (`tabIndex={-1}`), so clicking static text keeps Escape and the Tab trap working.
  - Unresolved parts from the same missing style agree, showing "—" instead of "Mixed".
  - The shortcut and the session ending return focus properly when they close the sheet.
  - The scrolling body is focusable.
  - "Other" blocks get no "Direct" chip.
  - Component tests were added (`formatPanelView.test.ts`), and the store test restores `matchMedia`.
  - Declined: changing how a selection starting at the very end of a line counts that line. It matches the toolbar's `isActive`.
- **muse:**
  - Empty lines in a range count only for the paragraph parts. They no longer turn uniform text "Mixed".
  - Any checked ancestor marks nested items as checked.
  - An unloaded paragraph style leaves the block's size, color, bold and italic defaults unresolved.
  - A selected horizontal line, or another non-text node, shows "no text formatting".
  - An image hides the Styles rows.
  - Code blocks hide Type and Alignment.
  - The store's test reset removes its listeners.
- **grok:**
  - The shortcut only stops for modal dialogs (`aria-modal="true"`), because the closed phone drawer keeps `role="dialog"`. The phone shortcut works, and an e2e check covers it.
  - Unloaded paragraph styles carry their id, so two different ones are "Mixed".
  - An unloaded paragraph style beats the quote and checked-item greys, showing "—".
  - Keyboard Clear formatting on the sheet keeps the sheet open, with focus in it.
- **Totals:** 641 unit tests. e2e: phase8 20, phase7 27, phase3 40, phase5 19, phase4 47, e2e 61, phase2 59.
