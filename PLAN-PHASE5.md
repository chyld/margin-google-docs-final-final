# Margin, Phase 5: styles that keep going, and a full-width editor

Status: **v2**, revised after the plan review by Sonnet, GPT-6.1 sol and terra, and Muse. **§7 wins over §1–§6.** This phase builds on Phase 4: see `PLAN-PHASE4.md`, especially §8 (style mechanics) and §10.

## The user's reports (verbatim)

1. "i saved a style, then i selected the style, the style was working on my new line, but if i press enter then the style goes away, i want to keep the style until i change something on the formatting bar."
2. "also make the edit full width"
3. "also sometimes i select a style and it doesn't work, like it is inconsistent"

## Decisions (user's answers)

| Question | Answer |
|---|---|
| Enter at the end of a heading-type styled line | **Same style, same heading level.** Choosing "Normal text" or another style leaves it. |
| What ends the style for the text typed next | **Any formatting-bar change** (bold, color, font, size, alignment, paragraph type, clear formatting…). The style ends from that point on, and **text keeps its current look**. |
| Enter on an empty styled line | **The style is kept.** Clicking back into a styled empty line also types in that style. |
| Full width | **Fill the space** beside the sidebar, with small margins. Phones stay as they are. |

## Root causes (investigated by Sonnet, GPT-6.1 sol and terra, Muse and me; reproduced headless and in the browser)

**R1. Enter at the end of a heading (verified).**
- Tiptap's `splitBlock` makes the new block a paragraph. `detachOnTypeChange` then clears its `styleId`, which was by design (PLAN-PHASE4 §10).
- That appended transaction also contains a step, so ProseMirror drops the stored marks that `splitBlock` had just carried over (`namedStyle`).
- The new line is therefore completely plain.

**R2. The style on an empty line lives only in stored marks (verified).** Stored marks are cleared by any selection change or step before typing:
- a click, the arrow keys, or blur and refocus
- the DOM redraw when `applyStyle` turns an empty paragraph into a heading: the browser repro shows the heading look but no color or bold on the typed text

The block link (`styleId`) survives and the Styles button still shows the style, but the typed text is untagged, so the style's text parts never show. **This is the main "inconsistent" case.**

**R3. A partial selection with a style that has paragraph parts (verified).**
- A paragraph-only style does nothing and shows a notice.
- A style with both text and paragraph parts silently applies only the text parts.

**R4. Smaller causes (code reading and tests):**
- **Code.** Inline code and code blocks can't take the tag, and the notice is misleading.
- **Toolbar states** show only direct formatting. A style's bold leaves the Bold button off, and a style's bold can't be switched off at all (the known limit).
- **Shortcut before load.** The favorite shortcut does nothing on its first press while styles are still loading.

## 1. Styles keep going: the "typing style"

**1.1 Enter continues the style.** A new `StyleContinuation` extension (in `shared/namedStyle.ts`, so the schema stays shared) handles **Enter** before StarterKit's keymap does, when all of these hold:
- the cursor is in a `paragraph` or `heading` with a `styleId`
- that block is **not** inside a list item, task item, code block, table header or details summary; lists keep their own Enter, and `keepOnSplit` already carries `styleId` there
- the selection is a text selection

It splits with `tr.split(pos, 1, [{ type: node.type, attrs: { ...node.attrs, textAlign: node.attrs.textAlign } }])`, so the new line is the **same type (and heading level)** and keeps the same `styleId`. It then sets stored marks to the marks at the cursor, keeping the `namedStyle` tag; on an empty line, a tag is built from the block's `styleId`. The transaction carries `APPLY_STYLE_META`, so the detach plugin leaves it alone.

The result:
- Enter at the end of "Heading 2 + purple" gives another Heading 2 + purple line.
- Enter on an empty styled line gives another styled line.
- Enter in the middle of a line keeps both halves styled.

**1.2 Empty styled lines keep their style (fixes R2).** An `appendTransaction` in the same extension watches typed text. When text is inserted into a `paragraph`/`heading` with a `styleId` that had **no text before the transaction**, and the inserted text has no `namedStyle` mark, it adds `namedStyle{id: styleId}` to the inserted range.
- **Covered:** clicking back into a styled empty line, deleting a line's text and retyping, and the redraw-after-heading case.
- **Deliberately narrow:** text typed next to untagged words in a linked paragraph (for example after "Remove style" on some words) is *not* re-tagged.

**1.3 The detach plugin stays,** for manual type changes that don't go through the toolbar: the "## " input rules, and pasted blocks. Toolbar and shortcut type changes now end the style first (§2), so the plugin just tidies up.

## 2. Any formatting-bar change ends the style, keeping the look

**`endStyle(tr)`** in `web/src/styleCommands.ts` turns style-provided formatting into **direct formatting** and drops the link. This is "materialize, then untag". Let S be each style found in the scope.

**Collapsed cursor:**
- Stored marks become the marks at the cursor, minus the `namedStyle` tag, plus S's text parts as direct marks:
  - textStyle `fontFamily`, `fontSize` and `color`, merged into any existing textStyle (existing direct values win)
  - highlight
  - bold, italic, underline, strike
- The next typed text therefore looks the same but is no longer the style.
- If the cursor's block has a `styleId`, S's alignment becomes the block's `textAlign` (unless it already has one), and `styleId` is cleared. The node type is already real. The heading *look* given by CSS where the node couldn't become a heading (a list item's first line) is lost; that is accepted and noted.
- Text earlier in the paragraph keeps its tags and still follows edits to the style.

**Non-empty selection:**
- Every tagged text node in the selection gets S's text parts as direct marks (direct values already there win), and its tag is removed.
- Blocks covered completely get their alignment materialized and are unlinked. Partly covered blocks stay linked.

**Which actions end the style.** `endStyle` runs first, as its own transaction marked `endStyle`, then the action runs:
- toolbar: Bold, Italic, Underline, ⋯ Strikethrough and Inline code, Text color, Highlight color, Font, Font size (−, +, box and presets), Alignment, Paragraph type, Clear formatting
- the same actions' **keyboard shortcuts**:
  - Ctrl/⌘+B, I, U and E, and Ctrl/⌘+Shift+S
  - Ctrl/⌘+Shift+L/E/R/J
  - Ctrl/⌘+Alt+0–6
  - Ctrl/⌘+Shift+. and ,
  - Ctrl/⌘+\\

  These are intercepted in `Editor.tsx`'s `handleKeyDown` (endStyle is dispatched, then the default handler runs).

**Not counted:** undo/redo, Link, Lists, Insert, table options, and the Styles menu itself (choosing another style replaces it, and "Remove style" works as before).

**Side benefit:** after materializing, Bold *can* switch off a style's bold. The known limit from Phase 4 disappears for anyone who presses the button.

**Toolbar states show the effective look:** Bold, Italic, Underline, Strike, the color bars, the font name and the size box fall back to the style's values at the cursor, through `currentStyle` and `styleById`. What you see on the buttons is what the text has.

## 3. Applying a style: no more silent no-ops (fixes R3 and R4)

- **Partial selection with paragraph parts:** the paragraph parts apply to **every touched paragraph or heading**, and the text parts to the selected text. There is no notice and no silent skip.
- **Code:**
  - inline code is still skipped, but the notice now reads "Code can't take a style"
  - in a code block, the notice reads "Styles don't apply inside code blocks"
  - a deleted style gets "That style was deleted"
- **Favorite shortcut before the styles load:** it loads them, then applies favorite N.
- **Applying at a collapsed cursor in an empty paragraph** also sets the block link, so §1.2 covers it even if the stored marks are lost. This is already true; a test will pin it.

## 4. Full-width editing

- **`.page`:**
  - Width 100% with no maximum. Padding 40px 56px on desktop and 32px 40px at 900px and below; phones keep theirs.
  - `min-height`: fills the visible canvas (`calc(100% - …)`) instead of a fixed 1056px.
  - Border, radius and shadow stay, so it's a full-width white sheet on the pastel canvas.
- **`.canvas`:** horizontal padding goes from 20–24px to 16px.
- **Images and tables:** new images keep their default width (622px); existing ones keep their saved widths and are capped at 100%. Tables already use the full width of the page.
- **Nothing persists:** this is CSS only, with no setting. Phones are unchanged.

## 5. Tests

**Unit tests, with the real schema plus the `StyleContinuation` and detach plugins.** The real Enter chain is driven through Tiptap's `Editor` in Node. Earlier tests used `tr.split` and missed R1.
- Enter at the end, middle and start of a styled paragraph and heading: same type and level, `styleId` kept, typed text tagged.
- Enter on an empty styled line, twice: still styled.
- Inside a list item: the list behavior is unchanged and the style is kept.
- Typing into an empty linked block after a selection change: tagged. Typing next to untagged words in a linked block: not tagged.
- `endStyle` with a collapsed cursor:
  - the stored marks equal the materialized look and have no tag; the block is unlinked and its alignment materialized
  - text before the cursor keeps its tag
- `endStyle` with a selection: tags are replaced by direct marks and existing direct values win; only fully covered blocks are unlinked.
- Bold on styled-bold text switches bold off (materialize, then toggle).
- A partial selection with a paragraph-only style applies the paragraph parts to the touched blocks.

**E2E (`phase5.mjs`):**
- the user's exact flow: save a style, choose it on a new line, type, Enter, type, so both lines are styled
- the heading-style flow, with the color present on every line
- click away and back into an empty styled line, then type: styled
- toolbar Bold or a color change at the end of a styled line, then Enter and type: the new text is not the style, and the earlier text keeps its look
- full width: `.page` fills the main area at 1400px and 1000px; phones are unchanged

**Regression:** the phase 1–4 suites (61, 59, 40 and 47 checks), with the toolbar helper and the width assertions updated where full width changes layout.

## 6. Rollout

The usual sequence:
1. Back up the data volume with Margin stopped, and tag `margin:phase4b`.
2. Rebuild.
3. Check read-only: every note unchanged, and the user's session kept.

No migration is needed.


---

## 7. Plan review: what changed (this section wins)

**R2's main trigger, found by Sonnet:**
- Styling the **last** line as a heading makes TrailingNode append an empty paragraph. That appended step wipes the stored marks.
- Any appended transaction can do the same: TrailingNode, Details, Table, autolink.
- So the block link is the source of truth for typing (§1.2), and stored marks are only a bonus.

**Enter (`StyleContinuation`, priority 1000, a shared extension):**
- **The new line is the same type, keeps `styleId` and has filtered stored marks.** Enter runs `deleteSelection`, then splits at the mapped cursor (checked with `canSplit`) with `[{type: node.type, attrs: node.attrs}]`, all in one chained transaction carrying `APPLY_STYLE_META`. Stored marks are the marks at the cursor that are allowed across a split: no `link`, no `code`. When the line is empty and the block is linked, a tag is added from `styleId`.
- **Containers keep their own Enter.** On an **empty** linked line inside anything other than the document or a table cell (a quote or a details section), it returns false, so `liftEmptyBlock` and the details exit run; the lifted paragraph keeps `styleId`.
- **List and task items:** the **first** child returns false, so `splitListItem` runs and `keepOnSplit` carries the link. A styled heading *later* in an item is handled by this split.
- **Edges:**
  - Enter at the start of a styled line keeps both halves styled.
  - Shift+Enter, the hard break, is untouched.
  - **Accepted consequence of the user's choice:** repeated Enter on an empty styled heading at the top level makes more styled headings; picking "Normal text" leaves the style.

**Empty-line typing (§1.2 rule):**
- **What counts as new text.** For each transaction in the batch, mapped through the whole batch, every changed range is examined. A `paragraph` or `heading` with `styleId` qualifies when the block it came from had **no text nodes** (an image or a hard break alone counts as no text) and now has text nodes without a `namedStyle` tag. Those nodes are tagged where `allowsMarkType` allows it and they aren't code.
- **When it applies.** This covers typing, paste, drop and autocomplete into an empty styled line. It skips undo and redo (`history$` meta), IME composition (`composition` meta), and its own appended transaction. That transaction has `addToHistory: false`, so undo of typing undoes both together.
- **Known limit:** text entered through IME composition on an empty styled line isn't tagged; typing next to it afterwards still isn't re-tagged.

**Ending a style (`endStyle`):**
- **One transaction.** `runWithEndStyle(editor, action)` builds `chain().focus().command(endStyle).<action>().command(restoreTypingMarks).run()`. That is one history event, one save and one toolbar update. If the action added steps that cleared the materialized stored marks (alignment, paragraph type), the last command restores them unless the action changed the stored marks itself (bold toggles).
- **Which style S:**
  - Collapsed cursor: the tag at the cursor (from stored marks, else `$from.marks()`), else the block's style **only if the block is empty**.
  - Selection: each tagged text node uses its own tag's style. Mixed styles are fine.
- **When nothing happens:**
  - **Unresolved styles:** if `styleById` doesn't know a style (not loaded yet, or unknown), `endStyle` changes nothing for it. A look it can't reproduce is never dropped.
  - **Clear formatting** skips materializing; it just clears and unlinks.
  - **The image-alignment branch** doesn't end a style.
- **Materializing:**
  - Merge into one textStyle per node; direct values win per attribute, and a direct size in `px` is kept.
  - Add `highlight{color}`, and bold, italic, underline and strike unless already present.
  - Build stored marks with `addToSet`, and respect `allowsMarkType`.
- **Unlinking a block.** This applies to fully covered blocks, or the cursor's block when it is collapsed and S is a block style. If the node's type and level differ from `style.block` (the style was edited later, or a list item's first line), the node is first converted to that type where the parent allows it. Where it doesn't (a list item's first line with a heading style), the block **stays linked** so its look is kept, and only the text tags end. `textAlign` gets the style's alignment unless it already has one. Empty linked blocks are always unlinked.
- **Shortcuts.** A client-only `EndStyleShortcuts` extension (priority 1000) re-binds Tiptap's exact key strings, so layout handling stays Tiptap's. Each runs `runWithEndStyle` with the original command and returns true:
  - Mod-b, Mod-B, Mod-i, Mod-I, Mod-u, Mod-U
  - Mod-Shift-s, Mod-e, Mod-Shift-h
  - Mod-Shift-l/e/r/j
  - Mod-Alt-0…6

  Ctrl+Shift+. and , and Ctrl+\ in `Editor.tsx` are routed through the same helper.
- **The toolbar paths**, all through `runWithEndStyle`:
  - Bold, Italic, Underline, Strikethrough and Inline code
  - color set and clear, highlight set and clear
  - Font: `setFontFamily`, and `unsetFontFamily` for the default
  - size: `setFontSize`, which also covers −, + and the presets
  - alignment, except with an image selected
  - paragraph type: `setBlock`, folded into one chain
  - Clear formatting, without materializing
- **Toolbar states.** They use the style's text parts only where the text really carries the tag: at the cursor, or on every text node of a range, matching `isActive` semantics. A paragraph link alone counts only on an empty line. The font-size box and `stepFontSize` use the same effective size.
- **Known limit:** after ending a style on an empty line, the materialized look lives in the stored marks. Clicking away and back before typing loses it, as before Phase 5.

**Applying a style:**
- **Paragraph parts on a partial selection** apply to every block the selection really touches. A block the selection merely ends at the start of doesn't count, and only `paragraph` and `heading` blocks qualify.
  - A style **with text parts** tags only the selected text.
  - A style **without text parts** is applied like a whole-paragraph apply to those blocks (their text gets tagged), so text parts added later reach them.
- **Notices.** `applyStyle` now returns `{tr} | {reason}`, with the reason 'deleted', 'code' or 'nothing'. The Styles menu and the favorite shortcut share the messages.
- **The favorite shortcut before load** keeps the editor, loads once (repeated presses are coalesced), then checks the editor isn't destroyed and is still editable, and applies to the *current* selection. A failed load shows a notice.

**Full width (exact CSS):**
- **Page:**
  - `.page { width: 100%; max-width: none; min-height: 100%; padding: 40px 56px }`. The padding is 32px 40px at 900px and below, and the existing 760px phone rules stay last.
  - `min-height: 100%` resolves against `.canvas`'s content box (a definite-height flex item), so there is no extra scrollbar.
- **Document and canvas:** `.document { min-height: 200px }`; `.canvas` gets symmetric 16px horizontal padding.
- **Tables:** resized tables keep their pixel widths (accepted); tables without set widths stretch.
- **Code:** the `PAGE_CONTENT_WIDTH` comment is updated: it is now only the default width for new images.

**Tests:**
- **Unit tests** use **happy-dom** for a mounted Tiptap `Editor` in the test files that need key handling (`// @vitest-environment happy-dom`). They press real Enter through `editor.commands.keyboardShortcut('Enter')` and run the real plugin order. Cases:
  - Enter with a range selection
  - an empty line in a quote and in a table cell
  - Enter in the middle of a link
  - the trailing paragraph
  - a heading later in a list item
  - Shift+Enter
  - undo that doesn't re-tag
  - `endStyle` with an empty store
  - one undo for an action that ended a style
  - partial-selection paragraph parts
  - the result notices
- **The e2e suite** stays in `/tmp/margin-e2e` (`phase5.mjs`) like the earlier ones, and covers the user's flows plus the full-width layout at 1400px, 1000px, 900px and 390px.

## 8. Implementation notes

- **`shared/namedStyle.ts`:** `StyleContinuation` (priority 1000) holds `continueStyleOnEnter`, a pure state-to-transaction command, and the `tagTextOnEmptyStyledLines` plugin.
- **`web/src/styleCommands.ts`:**
  - `applyStyle` returns an `ApplyResult`.
  - Paragraph parts apply on partial selections, and selections that merely end at a paragraph's start don't count.
  - `endStyle` and `materializedMarks` live here, and `effectiveTextProps` feeds the toolbar states and the font size.
  - In `endStyle`, the paragraph unlink runs *before* the typing marks are set, because a step clears stored marks.
- **`web/src/endStyle.ts`:** `runWithEndStyle` makes one chained transaction, with typing marks restored after steps such as alignment, and `EndStyleShortcuts` holds the shortcuts.
- **Toolbar wiring:** every toolbar path and the `fontSize.ts` and `FontPicker` paths go through `runWithEndStyle`; Clear formatting passes `materialize: false`.
- **Update to match selection** re-applies the updated style to the selection it came from, like Word. Otherwise the tweaks made there (now style-ending) would leave that text unlinked.
- **Tests:**
  - happy-dom unit tests in `web/src/styleContinuation.test.ts` press a real Enter through the keymap: 19 cases.
  - `/tmp/margin-e2e/phase5.mjs` has 19 checks.
  - The regression suites pass: 61, 59, 40 and 47.
  - The e2e `login.mjs` now signs in with an unpatched fetch, so a second context's sign-in no longer replaces the first one's session.

## 9. Code review: what changed

Sonnet, gpt-6.1-sol, gpt-6.1-terra, muse and grok reviewed the code (grok's review arrived after the first deploy; see the end). OpenCode models were excluded at the user's request.

- **terra:**
  - Fully covered blocks are unlinked one at a time with mapped positions.
  - "Reset formatting" skips code text.
  - A collapsed cursor on untagged text no longer unlinks its paragraph.
- **sol:**
  - TrailingNode's appended paragraph cleared the typing marks; the `keepTypingMarks` plugin re-applies them through appended transactions.
  - Clear formatting types plain text (`intended = []`).
  - Favorite shortcuts remember their slot while the styles load.
  - Bold, italic and the other states aggregate per text node across mixed styles.
- **Sonnet:**
  - Clear formatting with no style types plain text.
  - Paragraph-type changes keep alignment (`changeParagraphType` remembers and restores it, since multi-block `setNode` drops `textAlign`).
  - The shortcuts always return true, so the browser default never fires.
  - Declined: "re-apply on Update only if already styled", because re-applying matches Word.
- **muse:**
  - `runWithEndStyle` dry-runs the action with `can()` first, so a failing action doesn't end the style.
  - The alignment button falls back to the linked style's alignment.
  - Real keydown tests for Ctrl+Shift+S, Ctrl+Shift+R and Ctrl+Alt+2.
- **Totals:** 402 unit tests pass, both tsc configs are clean, and the e2e suites pass (phase5 19, e2e 61, phase2 59, phase3 40, phase4 47).
- **Deploy:**
  - Backup: `~/margin-backups/margin-data-20261031-174634-pre-phase5.tar.gz`
  - Rollback image: `margin:phase4b`
  - All 7 notes were verified unchanged and the user's session was kept.

### grok (fixed and redeployed as a follow-up)

- **High:** Enter on an empty styled last line of a collapsible section split inside the section forever. The section's own Enter only exits from a *plain* empty paragraph, and `styleId` is `keepOnSplit`.
  - Fix: `exitSection` moves the line, with its attributes, to just after the section and keeps the style for typing.
  - An only line leaves a plain empty paragraph behind, because a section needs one.
- **Medium:** paragraph-type changes on a styled list item's first line did nothing.
  - Cause: `setNode` can't apply there, so the `can()` gate bailed. The same happened for "Normal text" on an already-paragraph styled line.
  - Fix: `setTypeWhereAllowed` changes each line only where its container allows it, never lifting it out of a list. It reports "applicable" when a line changes *or* is linked to a style, so the change always ends the style.
  - Heading shortcuts still toggle. `runWithEndStyle` returns true once the dry run passes, because ending the style first can make the real run's command report false after it already unlinked.
- **Low:** Create and Update in the styles form now show the same notice as applying from the list when the style can't apply.
- **Totals:** 411 unit tests; e2e phase5 19, phase4 47, e2e 61, phase2 59, phase3 40.
- **Redeploy:**
  - Backup: `~/margin-backups/margin-data-20261031-181947-pre-phase5b.tar.gz`
  - Rollback image: `margin:phase5a`
  - Notes and styles fingerprints identical before and after; the user's session kept.
