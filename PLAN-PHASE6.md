# Phase 6: Ink & Ochre

The user's request: "i don't like the colors, way too soft, something more modern and sleek". After 10 mockups (proposed by the beta team plus alpha), they picked **#9 Ink & Ochre** (gpt-6.1-terra): "a warm editorial desk with ink-black type and a restrained ochre accent, inspired by Bear and Craft."

Decisions:
- **Sidebar notes:** a small muted dot per note, in earthy tones. Rows are otherwise neutral, and the selected note gets the ochre tint.
- **Page font:** the default font for text on the page becomes **IBM Plex Sans**, replacing Arial. Fonts the user picked are never changed.
- **The page stays light in both themes**, as today and as in the mockup. That way text colors and highlights look the same in both themes.
- Light and dark keep following the system, with the existing switch.

## 1. Tokens (`web/src/styles/app.css`, `:root` and `[data-theme='dark']`)

Every existing token keeps its name, so the 2,300 lines of rules don't need rewriting. The changes:

| token | light | dark |
|---|---|---|
| `--bg` | `#f2f0eb` | `#171714` |
| `--sidebar` (new) | `#f7f5f0` | `#1d1c18` |
| `--surface` (was translucent) | `#fffcf7` | `#292720` |
| `--surface-solid` | `#fffcf7` | `#292720` |
| `--surface-sunk` | `#eae6dd` | `#343128` |
| `--canvas` (new) | `#e9e5dc` | `#171714` |
| `--border` | `#ddd7cb` | `#3f3b31` |
| `--border-strong` | `#d3cdc1` | `#504b3e` |
| `--text` | `#25231f` | `#f6f2e8` |
| `--muted` | `#605b52` | `#c4baaa` |
| `--faint` | `#6f695e` | `#a89f90` |
| `--accent` | `#815000` | `#e8bc6a` |
| `--accent-soft` | `#eee4cf` | `#514022` |
| `--accent-ink` (new) | `#684000` | `#ffebc3` |
| `--hover` | `rgb(37 35 31 / 6%)` | `rgb(246 242 232 / 7%)` |
| `--focus` | `#815000` | `#e8bc6a` |
| `--primary` (new; replaces `--primary-from`/`--primary-to`) | `#704600` | `#e8bc6a` |
| `--primary-hover` (new) | `#5c3a00` | `#f0c97f` |
| `--primary-ink` | `#ffffff` | `#241a0a` |
| `--tool-ink` | `#3d3a33` | `#e6e0d3` |
| `--tool-active-bg` | `#eee4cf` | `#514022` |
| `--tool-active-ink` | `#684000` | `#ffebc3` |
| `--tool-disabled` | `#b3ac9f` | `#6b6455` |
| `--danger` / `--danger-soft` | `#a3271b` / `#f6e1dc` | `#ff9b8a` / `rgb(255 155 138 / 15%)` |

Other token changes:
- **Removed:** `--blob-1…4`, `--primary-from` and `--primary-to`.
- **Shadows:** neutral and subtle, with no purple glow.
  - `--shadow-soft`: light `0 1px 2px rgb(37 35 31 / 6%), 0 2px 8px rgb(37 35 31 / 5%)`; dark `0 1px 2px rgb(0 0 0 / 40%)`.
  - `--shadow-pop`: light `0 12px 32px rgb(37 35 31 / 14%), 0 2px 6px rgb(37 35 31 / 8%)`; dark `0 16px 40px rgb(0 0 0 / 50%), 0 0 0 1px rgb(246 242 232 / 6%)`.
  - `--page-shadow`: `0 1px 2px rgb(37 35 31 / 8%)`; dark `0 1px 3px rgb(0 0 0 / 50%)`.
- **Radii:** `--radius-sm 4px`, `--radius 6px`, `--radius-lg 10px`, down from 10/14/22.
- **Font:** `--font-ui: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`.

Every text/background pair is checked for WCAG AA (≥ 4.5:1) by a unit test that parses `app.css`. It covers text, muted and faint on bg, sidebar, surface and sunk; primary-ink on primary and primary-hover; accent-ink and tool-active-ink on their soft backgrounds; accent on surface and sidebar; danger on surface and danger-soft; and the dot inks on their fills.

## 2. The frame

- **Body:** a solid `var(--bg)`. The four radial-gradient blobs and the fixed attachment are gone.
- **Sidebar:** `var(--sidebar)` with a 1px `var(--border)` right edge, and no translucency or blur. The rail matches.
- **Canvas** (around the page): `var(--canvas)`.
- **Buttons:**
  - `.button` uses `border-radius: var(--radius)` instead of a pill, weight 600, a 1px border, and no lift on hover.
  - `.button.primary` uses `background: var(--primary)` (hover `--primary-hover`), with no gradient and no colored shadow.
  - The New note button (lines ~540) gets the same treatment.
- **Toolbar, menus, popovers and dialogs:**
  - Solid `--surface` with `--border` and `--shadow-pop` for floating ones.
  - Radius `--radius-lg` for menus and dialogs, `--radius-sm` for tool buttons.
  - Active tools use `--tool-active-bg` and `--tool-active-ink`.
- **Pills:** only genuinely round things stay pills: avatars, the theme switch track and toggle chips. Search fields, inputs and selects use `--radius`.
- **Weights:** 700 weights in the chrome drop to 600, which suits Plex better, except for headings and the brand.
- **Hard-coded purple** found by grep is replaced with tokens or neutral values: `rgb(185 130 230 …)`, `rgb(109 79 214 …)`, the `rgb(27 21 48 …)` scrims, the `#2d2640` badge, `#4a4166` and `#e8a400`, the favorite star, which becomes `--accent`.
- **Login screen and splash:** the same tokens; the login card is a solid surface.

## 3. Notes in the sidebar: earthy dots

- `web/src/candy.ts` is renamed in spirit: `CANDY = ['ochre', 'clay', 'sage', 'slate', 'plum', 'ink']`, using the same hash, so every note keeps a stable color. The file name and `candyFor` stay, to keep the diff small. A comment explains the change.
- **Tokens per tone:** `--<tone>` (the dot), `--<tone>-fill` (the rail tile and avatar background) and `--<tone>-ink` (text on the fill).
  - Light dots: ochre `#a8761c`, clay `#a9573a`, sage `#5f7d4f`, slate `#4f6578`, plum `#7d4f72`, ink `#3d3a33`.
  - Fills are tints and inks are dark shades; dark mode uses lighter dots, 16% fills and pale inks.
  - All are contrast-checked.
- **`.note-item`:**
  - The row is neutral; hover is `var(--hover)`.
  - When active: `background: var(--accent-soft)`, the title colored `var(--accent-ink)`, no border, no shadow and no candy bar (`::before` removed).
  - `.note-dot` is a 7px dot with no halo ring.
- **`.rail-note`:** the tile uses `--candy-fill` and `--candy-ink`, the earthy fill. When active, it gets a 2px `var(--accent)` ring.
- **`.avatar`:** the earthy fill and ink, without the inset candy ring.
- **Empty-state illustration:** recolored to the tones, with ochre as the main one, and a neutral shadow.

## 4. The page

- `editor.css .page`:
  - `background: #fffefa` (warm white, as in the mockup).
  - `border: 1px solid #e6e0d4`, instead of the lilac `#ece6fa`.
  - `border-radius: var(--radius-sm)`.
  - `--page-accent: #815000` and `--page-accent-soft: rgb(129 80 0 / 14%)`, for selection and handles.
  - Table selected-cell tints `#f3eeff` and `#e0d5ff` become warm ochre tints.
  - Content colors (Google-Docs greys for quotes and code, the link blue, highlight colors) are **unchanged**, because they belong to the content.
- **Default page font:**
  - `.document` gets `font-family: 'IBM Plex Sans', Arial, Helvetica, sans-serif`.
  - `shared/fonts.ts`: `DEFAULT_FONT = 'IBM Plex Sans'`, so the picker shows "IBM Plex Sans (default)".
  - Text with an explicit font keeps it. Saved styles store only explicit fonts (`captureProps`), so nothing stored changes.
- **Font files, bundled offline** because the app is on the LAN: add `@fontsource/ibm-plex-sans` (latin and latin-ext, weights 400/500/600/700 plus 400 italic and 700 italic) and remove `@fontsource-variable/nunito`. They are imported in `main.tsx`.
- **Picking "IBM Plex Sans" from the Google catalog** still works: the same family name loads through the proxy, and fontsource's faces are already present, so it renders the same.

## 5. Small things

- `index.html` theme-color, plus `web/public/theme.js` light/dark values: `#f2f0eb` and `#171714`.
- `favicon.svg`: an ink tile with a warm-white page, an ochre margin line and ochre lines; no gradient. It's used for the brand, the rail logo and the splash too.
- Header comment of `app.css` and the README ("Candy-pastel look…" → "Ink & Ochre look…").

## 6. Tests and checks

- A new unit test, `web/src/theme.test.ts`, parses both token blocks of `app.css` and checks the contrast pairs listed in §1 and §3. A future edit can't silently break AA.
- `grep` must find none of `primary-from`, `blob-`, `lilac`, `mint`, `peach`, `butter`, `Nunito`, `rgb(109 79 214`, `rgb(185 130 230` or `#6d4fd6` in `web/`.
- Existing unit and e2e suites must still pass; none of them assert colors.
- **Visual check:** screenshots of light and dark on a throwaway server (`DATA_DIR=/tmp/m6`) covering:
  - the notes list, with the active note, dots and the rail
  - the editor with the toolbar and a menu open
  - the styles menu, the font picker and a dialog
  - the login screen
  - a phone-width view

## 7. Rollout

The same steps as before:
1. Tag `margin:latest` → `margin:phase5b`.
2. Stop the container, back up the volume and verify the backup.
3. Fingerprint the notes via the API, then `docker compose up -d --build`.
4. Verify the notes are unchanged, the session is kept and the smoke test passes.
5. Never sign the user out.

## 7. Plan review: what changed (this section wins over §1–§6)

Sonnet, gpt-6.1-sol, gpt-6.1-terra, muse and grok reviewed the plan.

### Fonts
- **Imports:** import the range-aware fontsource files (`@fontsource/ibm-plex-sans/{400,500,600,700}.css` and `{400,500,600,700}-italic.css`), not the per-subset files. Per-subset files have no `unicode-range`, so latin-ext would shadow latin and plain text would fall back to Arial (Sonnet). Browsers download only the subsets a page actually uses.
- **Loading:** `ensureFont` and the preview loader skip the bundled family (`BUNDLED_FONT = 'IBM Plex Sans'` in `shared/fonts.ts`), so the proxy never injects a second set of faces with the same name (sol, muse, terra). Picking the catalog's "IBM Plex Sans" still stores an explicit mark; it simply renders with the bundled faces.
- **Weights:** every `font-weight: 800` in the chrome becomes 700, since Plex stops at 700 (muse).
- **Reflow, accepted:** text without an explicit font changes from Arial to Plex, so lines rewrap and tables grow a little. Runs with an explicit Arial mark stay Arial. Stored data doesn't change. The visual check includes a long table and a long-titled note.
- **Comment:** fix the stale "11pt / Arial" comment in `styleCommands.ts`.

### Contrast (every pair below is enforced by `web/src/theme.test.ts`)
- **Faint text:** `--faint` is darkened in light and lightened in dark until it reaches ≥ 4.5 on bg, sidebar, surface, sunk, canvas and accent-soft (sol, muse, Sonnet).
- **The active note row:**
  - The title, snippet and time use `--accent-ink`, with the snippet at reduced emphasis through color, not opacity.
  - `:hover` is not applied to the active row.
- **`--control-border` (new):** ≥ 3:1 against surface and sunk in both themes. It's used for the edges of inputs, search, the font search, chips, the table-size grid and `.color-clear` (terra, sol, Sonnet, muse). `--border` stays decorative, for separators.
- **Focus:** fields that hide the outline and use a soft focus shadow (`.note-title`, `.search`, `.field input`) also get `border-color: var(--focus)` or an outline. `--focus` must be ≥ 3:1 against bg, sidebar and surface.
- **Page:** the page stays **pure white**, not `#fffefa`, so the content link blue `#1a73e8` keeps 4.5:1 (sol).
  - The page edge is `1px solid #d6cfc1` plus a shadow, so it shows against `--canvas`.
  - Editor-owned greys move to ≥ 4.5:1 on white: the placeholder (`#9aa0a6`) and the completed-task text (`#80868b`). Saved content colors are untouched.
- **Dots, fills and inks:** the full table lives in `app.css`, and the test checks each one:
  - the dot ≥ 3:1 on the sidebar and on accent-soft
  - the ink ≥ 4.5:1 on its fill, using an opaque fill so nothing depends on compositing
- **The test:** it parses both token blocks and checks text pairs at 4.5 and UI boundary pairs at 3.

### Every old pastel consumer gets mapped (sol, muse, Sonnet)
- **`.save-status`:**
  - saved → sage
  - busy → ochre
  - warning → clay
  - paused → slate
  - error → `--danger`/`--danger-soft`
- **`.banner`:** info → slate; error → danger.
- **Accent-soft and accent-ink:** `.chip.is-active` and `.table-grid-cell.is-lit`.
- **`.notice::before`:** ochre. **`.setup-hint`:** ochre.
- **Empty illustration:** recolored to the tones (ochre, clay, sage, slate), with a neutral shadow and an ink tip.
- **Grep gate:** the §6 ban list adds `sky`, `pink`, `candy-lilac`, `1b1530`, `fbf7ff`, `backdrop-filter`, `blob`, `drift`, `bob` and `--spring`.

### Frame cleanup the plan missed
- **Theme color:** `web/src/theme.ts` also writes it; all three places use one pair of values (sol, muse, Sonnet).
- **Login blobs:** remove the markup in `LoginScreen.tsx`, the `.blobs`/`.blob-*` CSS, the `drift` keyframes and the phone blob rules.
- **Blur:** delete every `backdrop-filter` (sidebar, toolbar, login card, session overlay) and the `@supports not (backdrop-filter…)` fallbacks.
- **Sidebar:** becomes a flush panel: `margin: 0`, no radius, no shadow, `border-right: 1px solid var(--border)`, background `--sidebar`. The phone sidebar uses `--sidebar` and only a right-edge border. `.rail-note.is-active` uses a gap ring of `--sidebar`.
- **Canvas:** `.canvas` gets `background: var(--canvas)`.
- **Hard-coded radii:**
  - `.login-card` (28px) and `.session-dialog` (26px) → `--radius-lg`.
  - Phone `.page` 14px → `--radius-sm`.
  - `.font-size-input` 8px → `--radius-sm`.
  - The `.search`, `.user-chip`, `.save-status` and `.font-search` pills → `--radius`.
  - Pills stay only for avatars, the theme switch track and filter chips.
- **Scrims:** the session overlay and the phone scrim become `rgb(23 23 20 / 45%)` with no blur.
- **Other hard-coded colors:**
  - The theme-option shadow becomes neutral.
  - The favorite star becomes `--accent`.
  - `.setup-hint code` uses tokens.
  - `.style-preview` deliberately stays white/`#202124`, because it previews page content.
- **Selection and hover on the page:** `::selection` → `#eadcc0`, an ochre tint (≥ 4.5 with page text); the details-button hover → `#f4efe5`.
- **Toolbar edge:** the toolbar and floating popovers use `--border-strong`, so the edge stays visible in dark (Sonnet).
- **Scrollbars:** `scrollbar-color: var(--border-strong) transparent` on scroll areas.

### Motion: calmer
- `--spring` is removed. Popovers, toasts and swatches use `--ease`, around 160ms.
- The `bob` splash animation is deleted, and so is `.button:active` scale.
- `wobble` stays, but only for a failed login.

### Not doing
- A print stylesheet: Margin has no print feature today.

### grok's additions (these win where they differ from the lines above)
- **Selected states keep the soft fill and add a 2px `--accent` mark:**
  - `.note-item.is-active` gets a left bar.
  - `.tool.is-active` and `.chip.is-active` get an inset 1.5px ring.
  - `.table-grid-cell.is-lit` gets an accent border.
  - The fill alone was only 1.2–1.5:1.
- **`.document ::selection`** also sets `color: #202124`, so selected links stay readable.
- **The picker row for the bundled font:** it skips `ensurePreview` and uses `"IBM Plex Sans", sans-serif` directly.
- **Page edge:** border `#9a9385`, and `--page-shadow` light becomes `0 1px 2px rgb(37 35 31 / 10%), 0 12px 32px rgb(37 35 31 / 16%)`.
- **Values:**
  - `--faint`: `#6b655a` light, `#b8afa0` dark.
  - `--control-border`: `#888276` light, `#807b6e` dark. It's also used for `scrollbar-color`.
  - Placeholder and completed-task text: `#5f6368`, asserted by the test from `editor.css`.
- **The contrast test** composites any alpha color over its real background, as with dark `--danger-soft`.
- **Grep gate:** ban `blob-` and `.blobs`, not the substring `blob`, which is also a real `Blob` in `NoteView.tsx`.
- **Motion:**
  - `pop-in` uses `--ease`.
  - Remove the `:active` scales on `.tool` and `.icon-button`, and the `.swatch:hover` scale.
- **Dots:** the dark dot, fill and ink values are opaque. §3's "16% fills" is dropped.
- **`--tool-disabled`:** raised to about 3:1, not 4.5, so disabled controls still look disabled.

## 8. Implementation notes

- **Tokens and the contrast test:**
  - Tokens are in `app.css`.
  - The contrast test is `scripts/theme.test.ts`. It sits in `scripts/` because it reads the stylesheets with `node:fs`, which only the Node tsconfig allows; Vitest's `?raw` returns CSS as empty. Vitest's `include` adds `scripts/**`.
  - The test runs 113 checks: text ≥ 4.5 and UI ≥ 3 in both themes; dark `--danger-soft` composited over its background; `--tool-disabled` between 2.8 and 4.5; and, on the page, the edge, the placeholders, completed tasks and `::selection` read from `editor.css`.
- **Tones:** `candy.ts` tones are ochre, clay, sage, slate, plum and ink, with the same hash. Every dot, fill and ink is opaque and listed in `app.css`.
- **Fonts:**
  - `@fontsource/ibm-plex-sans` is a devDependency (it's only needed to build). `@fontsource-variable/nunito` is removed.
  - `main.tsx` imports the range-aware 400/500/600/700 files, upright and italic.
  - `shared/fonts.ts`: `DEFAULT_FONT = 'IBM Plex Sans'` and `BUNDLED_FONTS`. `ensureFont` and `ensurePreview` skip bundled families, and the picker draws them with the real face.
- **Login screen:** blobs removed from `LoginScreen.tsx`. The e2e `phase3.mjs` "no drifting blobs" check became "no entrance animation with reduced motion".
- **Favicon:** an ink tile with a warm edge, so it shows on the dark sidebar, a warm-white page, ochre lines and a gold margin rule.
- **Visual check:** `/tmp/margin-e2e/phase6-shots.mjs` saves screenshots to `/tmp/margin-demo/p6/`: light, dark, the font menu, the styles menu, the rail, login light and dark, phone light, and the phone dark drawer.
- **Tests:** 524 unit tests. The e2e suites pass: phase5 19, phase4 47, e2e 61, phase2 59, phase3 40.

## 9. Code review: what changed

- **The page edge, found by terra, sol and Sonnet:** the test compared the edge with white instead of the canvas. The test now checks the canvas in both themes plus white, and the edge is darkened to `#857f71`.
- **sol:** enabled favorite stars use `--muted`; only `:disabled` stars use `--tool-disabled`.
- **Sonnet:**
  - Keyboard focus on the always-white page uses `--page-accent`, because dark `--focus` was 1.8:1 on white. The test covers it.
  - The selected font row gets a 3px accent bar.
  - The keyboard row in the font and style lists gets a sunk fill and a 1px `--control-border` ring.
  - The theme switch's active segment gets a ring.
  - Hover no longer hides an active tool or a checked menu item.
  - Popovers, the user menu and notices use `--border-strong`.
  - The 500/600 italic imports are dropped.
  - The test now fails on any undefined `var(--x)`.
  - The empty illustration's comment is reworded.
  - Declined: preloading font files, because the build gives them hashed asset names, and the swap flash is brief on a LAN.
- **muse:**
  - `.tool-select` and `.icon-button` get `:disabled` styles; this covers the paragraph-type select and the font trigger. The danger and star hovers skip disabled buttons.
  - The test covers `surface-solid` and `danger-soft` over bg, surface and sidebar.
  - Test parsing is sturdier: brace-matched blocks, 3/4/6/8-digit hex, comma or space `rgb()`, and full-selector matching.
  - The upload placeholder's dashed edge is `#80868b`, and the test checks it.
  - Chips and lit table cells get an accent ring.
  - Dark `--border-strong` is `#5c5647`, for clearer floating edges.
  - **Declined:**
    - A 3:1 minimum for container edges (the toolbar and popovers): they aren't controls, shadows mark them, and forcing 3:1 would make every separator heavy.
    - The theme track stays at a 6px radius, as built. It reads sleeker than a pill.
    - The rail tooltip's positioning and silent preview failures offline: both behaved this way before this phase.
- **Totals:**
  - 541 unit tests, including 130 contrast checks.
  - e2e: phase3 40, phase5 19, phase4 47, e2e 61, phase2 59. One phase2 run stopped early on a Google Fonts network hiccup and passed on the rerun.
- **grok:**
  - The collapsed-rail tooltip now sits right of the rail (`left: calc(var(--sidebar-width) + 8px)`) instead of covering the tile.
  - The placeholders in the font and styles search, the link input and the style-name input use `--faint`, because the browser's default grey was 3.5:1.
  - Declined: a pill theme track (see muse above).
