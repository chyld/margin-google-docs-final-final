// Phase 4: collapsible sidebar, compact toolbar, saved styles, favorites.
// Throwaway instance only: MARGIN_URL=http://localhost:5557 node phase4.mjs
import { chromium } from 'playwright-core'
import { signIn } from './login.mjs'
import { BASE, SHOTS } from './env.mjs'

const results = []
const errors = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true })
const settle = page => page.waitForTimeout(60)

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, init)
  return response.status === 204 ? null : response.json()
}

async function newNote(page, title) {
  const before = page.url()
  await page.getByRole('button', { name: 'New note' }).first().click()
  await page.waitForURL(url => /\/notes\/[0-9a-f-]{36}$/.test(String(url)) && String(url) !== before)
  await page.locator('.document').waitFor()
  await page.locator('.note-title').fill(title)
  await page.locator('.document').click()
}

async function selectWordBack(page, length) {
  for (let i = 0; i < length; i += 1) await page.keyboard.press('Shift+ArrowLeft')
  await settle(page)
}

async function waitSaved(page) {
  await page.locator('.save-status').filter({ hasText: 'All changes saved' }).waitFor({ timeout: 10_000 })
}

const computed = (page, selector, prop) =>
  page.locator(selector).first().evaluate((el, p) => getComputedStyle(el)[p], prop)

try {
  // Start clean (this instance's notes and styles).
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await signIn(BASE, context)
  for (const note of await api('/api/notes')) await api(`/api/notes/${note.id}`, { method: 'DELETE' })
  for (const style of (await api('/api/styles')).styles.filter(s => !s.deleted)) await api(`/api/styles/${style.id}`, { method: 'DELETE' })

  const page = await context.newPage()
  page.on('pageerror', error => errors.push(String(error)))
  // The duplicate-name test expects one 409.
  page.on('console', message => message.type() === 'error' && !/409/.test(message.text()) && errors.push(message.text()))
  page.on('dialog', dialog => dialog.accept())
  await page.goto(BASE)
  await page.locator('.sidebar').waitFor()

  // ---- toolbar: one row, menus ----
  await newNote(page, 'Style lab')
  const rowHeight = async () => (await page.locator('.toolbar').boundingBox()).height
  check('toolbar is one row at 1400px (sidebar open)', (await rowHeight()) < 50, `height=${await rowHeight()}`)
  await page.setViewportSize({ width: 1280, height: 900 })
  await settle(page)
  check('toolbar is one row at 1280px (sidebar open)', (await rowHeight()) < 50, `height=${await rowHeight()}`)

  await page.keyboard.type('menu test')
  await selectWordBack(page, 4)
  // From the keyboard, a menu takes focus (with the mouse, focus stays in the document).
  await page.getByRole('button', { name: 'More text formatting' }).focus()
  await page.keyboard.press('Enter')
  check('opening a menu from the keyboard focuses its first item', await page.evaluate(() => document.activeElement?.textContent?.includes('Strikethrough')))
  await page.keyboard.press('ArrowDown')
  check('arrow keys move through items', await page.evaluate(() => document.activeElement?.textContent?.includes('Inline code')))
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  check('Enter applies the item and keeps the selection', (await page.locator('.document s').textContent()) === 'test')
  check('focus is back in the document', await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')))
  await page.getByRole('button', { name: 'Alignment' }).click()
  await page.keyboard.press('Escape')
  check('Escape closes a menu and returns to the document', !(await page.locator('.popover').count()) && (await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror'))))

  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await page.locator('.menu-item', { hasText: 'Table' }).click()
  await page.locator('.table-grid-cell[aria-label="1 by 1 table"]').waitFor()
  check('Insert → Table opens the size grid with a cell focused', await page.evaluate(() => document.activeElement?.classList.contains('table-grid-cell')))
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.locator('.document table').waitFor()
  check('arrow keys pick the size; Enter inserts a 2×2 table', (await page.locator('.document table td').count()) === 4)
  check('table options appear only inside a table', (await page.getByRole('button', { name: 'Table options' }).count()) === 1)
  await page.locator('.document > p').last().click()
  await settle(page)
  check('…and hide outside it', (await page.getByRole('button', { name: 'Table options' }).count()) === 0)
  await page.setViewportSize({ width: 1400, height: 900 })

  // ---- saving a style ----
  await page.locator('.document > p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.type('Callout text')
  await selectWordBack(page, 12)
  await page.getByRole('button', { name: 'Text color' }).click()
  await page.getByRole('menuitemradio', { name: 'Purple' }).click()
  await page.getByRole('button', { name: 'Bold' }).click()
  await page.locator('.styles-trigger').click()
  await page.locator('.styles-save').click()
  await page.locator('.style-form-name').fill('Callout')
  const parts = await page.locator('.style-part').allTextContents()
  check('the save form offers the captured parts', parts.some(p => p.includes('Text color')) && parts.some(p => p.includes('Bold')), parts.join(' | '))
  const checkedParts = await page.locator('.style-part input:checked').count()
  check('only parts that are set start checked (not size/font/paragraph)', checkedParts === 2, `checked=${checkedParts}`)
  await page.getByRole('button', { name: 'Save style' }).click()
  await page.locator('.styles-popover').waitFor({ state: 'detached' })
  await waitSaved(page)
  const styles = (await api('/api/styles')).styles
  const callout = styles.find(s => s.name === 'Callout' && !s.deleted)
  check('the style is saved', callout?.props.color === '#9334e6' && callout?.props.bold === true, JSON.stringify(callout?.props))
  check('the source text is linked to it', (await page.locator(`.document span[data-style="${callout?.id}"]`).count()) === 1)
  check('the trigger shows the style name', (await page.getByRole('button', { name: 'Style: Callout' }).count()) === 1)

  // ---- applying it elsewhere ----
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Plain line to style')
  await page.locator('.styles-trigger').click()
  await page.locator('.style-row', { hasText: 'Callout' }).click()
  await waitSaved(page)
  const linked = page.locator(`.document span[data-style="${callout.id}"]`, { hasText: 'Plain line to style' })
  check('applying with a cursor styles the whole line', (await linked.count()) === 1)
  check('the look comes from the style (purple, bold)', (await computed(page, `.document span[data-style="${callout.id}"] >> nth=1`, 'color')) === 'rgb(147, 52, 230)')

  // A manual tweak inside styled text.
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('Control+ArrowLeft')
  await selectWordBack(page, 0)
  // Select the word "Plain" and make it green by hand.
  await page.keyboard.press('Home')
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+ArrowRight')
  await settle(page)
  await page.getByRole('button', { name: 'Text color' }).click()
  await page.getByRole('menuitemradio', { name: 'Green' }).click()
  await waitSaved(page)

  // A second note uses it too.
  await newNote(page, 'Second note')
  await page.keyboard.type('Elsewhere')
  await page.locator('.styles-trigger').click()
  await page.locator('.style-row', { hasText: 'Callout' }).click()
  await waitSaved(page)
  const secondUrl = page.url()

  // ---- editing the style updates every use, at once ----
  // Restyle this text by hand (blue, italic), then "Update to match selection".
  await page.locator('.document').click()
  await page.keyboard.press('Control+a')
  await page.getByRole('button', { name: 'Text color' }).click()
  await page.getByRole('menuitemradio', { name: 'Blue' }).click()
  await page.getByRole('button', { name: 'Italic' }).click()
  await page.locator('.styles-trigger').click()
  await page.locator('.style-row', { hasText: 'Callout' }).hover()
  await page.getByRole('button', { name: 'More actions for Callout' }).click()
  await page.locator('.style-actions .menu-item', { hasText: 'Update to match selection' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.locator('.styles-popover').waitFor({ state: 'detached' })
  const afterUpdate = (await api('/api/styles')).styles.find(s => s.id === callout.id)
  check(
    'Update to match selection saves the full look (style + tweaks)',
    afterUpdate.props.color === '#1a73e8' && afterUpdate.props.bold === true && afterUpdate.props.italic === true,
    JSON.stringify(afterUpdate.props),
  )

  // Back to the first note: no reload needed, and nothing was rewritten.
  const allNotes = await api('/api/notes')
  const firstNoteBefore = await api(`/api/notes/${allNotes.find(n => n.title === 'Style lab').id}`)
  await page.locator('.note-item', { hasText: 'Style lab' }).click()
  await page.locator(`.document span[data-style="${callout.id}"]`).first().waitFor()
  check('other notes show the new look (blue, italic)', (await computed(page, `.document span[data-style="${callout.id}"] >> nth=1`, 'fontStyle')) === 'italic')
  const tweaked = page.locator('.document span[style*="color"]', { hasText: 'Plain' })
  check('a manual tweak inside styled text still wins', (await tweaked.count()) === 1 && (await tweaked.evaluate(el => getComputedStyle(el).color)) === 'rgb(24, 128, 56)')
  await page.waitForTimeout(1200)
  const firstNoteAfter = await api(`/api/notes/${firstNoteBefore.id}`)
  check('opening the note did not rewrite it', firstNoteAfter.updatedAt === firstNoteBefore.updatedAt)

  // ---- favorites and the shortcut ----
  await page.locator('.document > p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Shortcut line')
  await page.locator('.styles-trigger').click()
  await page.locator('.style-row', { hasText: 'Callout' }).hover()
  await page.getByRole('button', { name: 'Add Callout to favorites' }).click()
  await page.locator('.styles-heading', { hasText: 'Favorites' }).waitFor()
  check('a starred style is listed under Favorites with its shortcut', (await page.locator('.style-row', { hasText: 'Callout' }).textContent()).includes('1'))
  await page.keyboard.press('Escape')
  await page.locator('.document').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Control+Alt+Shift+Digit1')
  await waitSaved(page)
  check('Ctrl+Alt+Shift+1 applies favorite 1', (await page.locator(`.document span[data-style="${callout.id}"]`, { hasText: 'Shortcut line' }).count()) === 1)

  // ---- a second tab sees edits after focus ----
  const tab2 = await context.newPage()
  await tab2.goto(secondUrl)
  await tab2.locator(`.document span[data-style="${callout.id}"]`).waitFor()
  await page.bringToFront()
  await page.evaluate(async id => {
    await fetch(`/api/styles/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ props: { color: '#188038', bold: true } }),
    })
  }, callout.id)
  await tab2.bringToFront()
  await tab2.evaluate(() => window.dispatchEvent(new Event('focus')))
  await tab2.waitForFunction(id => getComputedStyle(document.querySelector(`.document span[data-style="${id}"]`)).color === 'rgb(24, 128, 56)', callout.id, { timeout: 5000 }).then(
    () => check('another tab picks up a style edit when it gets focus', true),
    () => check('another tab picks up a style edit when it gets focus', false),
  )
  await tab2.close()

  // ---- deleting keeps the look ----
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(400)
  await page.locator('.styles-trigger').click()
  await page.locator('.style-row', { hasText: 'Callout' }).hover()
  await page.getByRole('button', { name: 'More actions for Callout' }).click()
  await page.locator('.style-actions .menu-item', { hasText: 'Delete' }).click()
  await page.waitForFunction(() => !document.querySelector('.style-row'))
  check('a deleted style leaves the menu', (await page.locator('.style-row', { hasText: 'Callout' }).count()) === 0)
  await page.keyboard.press('Escape')
  check('text that used it keeps its look', (await computed(page, `.document span[data-style="${callout.id}"]`, 'color')) === 'rgb(24, 128, 56)')
  await page.screenshot({ path: `${SHOTS}/p4-styles.png` })

  // ---- copying styled text carries its look for other apps ----
  await page.locator('.document span[data-style]').first().dblclick()
  await settle(page)
  const copied = await page.evaluate(() => {
    let html = ''
    const grab = event => (html = event.clipboardData.getData('text/html'))
    window.addEventListener('copy', grab)
    document.execCommand('copy')
    window.removeEventListener('copy', grab)
    return html
  })
  check('copied HTML keeps the style tag and inlines its look', /data-style="[0-9a-f-]{36}"[^>]*style="[^"]*color: #188038/.test(copied) || /style="[^"]*color: #188038[^"]*"[^>]*data-style=/.test(copied), copied.slice(0, 200))

  // ---- a manual heading change unlinks a paragraph style ----
  await page.locator('.document > p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Heading style line')
  const headingStyleId = await page.evaluate(async () => {
    const id = crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')
    const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`
    await fetch('/api/styles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: uuid, name: 'Big heading', props: { block: 'h1', color: '#9334e6' } }) })
    return uuid
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(400)
  await page.locator('.styles-trigger').click()
  await page.locator('.style-row', { hasText: 'Big heading' }).click()
  await page.locator(`.document h1[data-style-id="${headingStyleId}"]`).waitFor()
  await page.keyboard.press('Control+Alt+3')
  await settle(page)
  check('Ctrl+Alt+3 on a styled heading unlinks it (the manual level shows)', (await page.locator('.document h3', { hasText: 'Heading style line' }).getAttribute('data-style-id')) === null)

  // ---- table options and colors are keyboard menus too ----
  await page.getByRole('button', { name: 'Text color' }).focus()
  await page.keyboard.press('Enter')
  check('the color menu (from the keyboard) focuses its first item', await page.evaluate(() => document.activeElement?.classList.contains('color-clear')))
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Text color' }).click()
  check('opened with the mouse, focus stays in the document', await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')))
  await page.keyboard.press('Escape')

  // ---- name clash is a form error, not a session problem ----
  await page.locator('.styles-trigger').click()
  await page.locator('.styles-save').click()
  await page.locator('.style-form-name').fill('Taken')
  await page.locator('.style-part input').first().check()
  await page.getByRole('button', { name: 'Save style' }).click()
  await page.locator('.styles-popover').waitFor({ state: 'detached' })
  await page.locator('.styles-trigger').click()
  await page.locator('.styles-save').click()
  await page.locator('.style-form-name').fill('TAKEN')
  await page.locator('.style-part input').first().check()
  await page.getByRole('button', { name: 'Save style' }).click()
  await page.locator('.style-form .popover-error', { hasText: 'already have a style' }).waitFor()
  check('a duplicate name shows an inline error and no sign-in box', (await page.locator('.session-dialog').count()) === 0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  // ---- font menu star ----
  await page.locator('.document').click()
  await page.getByRole('button', { name: 'Font', exact: true }).click()
  await page.getByLabel('Search fonts').fill('Lora')
  await page.locator('.font-row', { hasText: /^Lora/ }).first().waitFor()
  await page.keyboard.press('Enter')
  await page.locator('.font-popover').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Font', exact: true }).click()
  const headStar = page.locator('.font-head .font-star')
  const headLabel = await headStar.getAttribute('aria-label')
  check('the font menu header shows the current font', (await page.locator('.font-head .styles-current').textContent()) === 'Lora', headLabel ?? '')
  await headStar.click()
  const flipped = await headStar.getAttribute('aria-label')
  check('the header star toggles the favorite', headLabel !== flipped && /Lora/.test(flipped ?? ''), `${headLabel} → ${flipped}`)
  if (flipped?.startsWith('Remove')) await headStar.click()
  await page.keyboard.press('Escape')

  // ---- sidebar rail ----
  await page.getByLabel('Search notes').fill('Second')
  await page.waitForTimeout(400)
  const toggle = page.locator('.sidebar-toggle')
  await toggle.click()
  check('the sidebar collapses to a rail', (await page.locator('.sidebar.is-collapsed').count()) === 1 && (await page.locator('.sidebar').boundingBox()).width < 80)
  check('focus stays on the toggle', await page.evaluate(() => document.activeElement?.classList.contains('sidebar-toggle')))
  check('the rail lists recent notes even while searching', (await page.locator('.rail-note').count()) === 2)
  check('the toolbar is one row with the rail at 1000px', await (async () => {
    await page.setViewportSize({ width: 1000, height: 800 })
    await settle(page)
    return (await rowHeight()) < 50
  })())
  await page.screenshot({ path: `${SHOTS}/p4-rail.png` })
  await page.reload()
  await page.locator('.sidebar').waitFor()
  check('collapsed state survives a reload', (await page.locator('.sidebar.is-collapsed').count()) === 1)
  await page.locator('.rail-note').nth(1).click()
  await page.waitForURL(/\/notes\//)
  check('rail notes open notes', (await page.locator('.note-title').inputValue()).length > 0)
  await page.locator('.document').click()
  await page.keyboard.press('Control+Shift+Backslash')
  await settle(page)
  check('Ctrl+Shift+\\ expands it again', (await page.locator('.sidebar.is-collapsed').count()) === 0)
  await page.keyboard.press('Control+Shift+Backslash')
  await page.locator('.rail-button[aria-label="Search notes"]').click()
  check('the rail search expands and focuses the search box', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Search notes'))
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.locator('.sidebar-toggle').click()
  await page.locator('.rail .user-chip').click()
  const popover = await page.locator('.user-popover').boundingBox()
  check('the rail account menu opens to the right, on screen', popover !== null && popover.x > 60 && popover.x + popover.width < 1000, JSON.stringify(popover))
  await page.keyboard.press('Escape')
  await page.locator('.sidebar-toggle').click()

  // ---- tablet width: collapsing works there too ----
  await page.setViewportSize({ width: 900, height: 800 })
  await page.locator('.sidebar-toggle').click()
  check('collapsing works at tablet width', (await page.locator('.sidebar').boundingBox()).width < 80)
  await page.locator('.sidebar-toggle').click()

  // ---- phone: menus are bottom sheets, no rail ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await signIn(BASE, phone)
  const phonePage = await phone.newPage()
  await phonePage.addInitScript(() => localStorage.setItem('margin:sidebar', 'collapsed'))
  await phonePage.goto(BASE)
  await phonePage.getByRole('button', { name: 'Open notes menu' }).click()
  await phonePage.locator('.note-item').first().click()
  await phonePage.locator('.document').click()
  check('phones ignore the collapsed setting (no rail)', (await phonePage.locator('.sidebar.is-collapsed').count()) === 0)
  await phonePage.locator('.styles-trigger').click()
  const sheet = await phonePage.locator('.styles-popover').boundingBox()
  check('the Styles menu is a bottom sheet on phones', sheet !== null && sheet.x >= 0 && sheet.x + sheet.width <= 390 && sheet.y + sheet.height <= 844, JSON.stringify(sheet))
  await phonePage.screenshot({ path: `${SHOTS}/p4-phone-styles.png` })
  await phone.close()

  check('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '))
} catch (error) {
  for (const ctx of browser.contexts()) for (const pg of ctx.pages()) await pg.screenshot({ path: `${SHOTS}/p4-fail-${ctx.pages().indexOf(pg)}.png` }).catch(() => {})
  check('script ran to completion', false, String(error).split('\n').slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
