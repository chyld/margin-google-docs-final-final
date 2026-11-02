// Phase 8: the Format sidebar (docked, overlay, phone sheet), its contents, actions and shortcut.
import { chromium } from 'playwright-core'
import { signIn } from './login.mjs'
import { BASE, SHOTS } from './env.mjs'
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true })
let passed = 0, total = 0
const check = (name, ok, detail = '') => { total += 1; if (ok) passed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }
const errors = []
const watch = page => {
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => m.type() === 'error' && !/401/.test(m.text()) && errors.push(m.text()))
}
try {
  await signIn(BASE)
  for (const note of await (await fetch(`${BASE}/api/notes`)).json()) await fetch(`${BASE}/api/notes/${note.id}`, { method: 'DELETE' })
  const STYLE = '44444444-4444-4444-8444-444444444444'
  await fetch(`${BASE}/api/styles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: STYLE, name: 'Phase8 Callout', props: { color: '#9334e6', bold: true } }) })
  const note = await (await fetch(`${BASE}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Format sidebar' }) })).json()
  const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) })
  await fetch(`${BASE}/api/notes/${note.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: { type: 'doc', content: [
    { type: 'paragraph', content: [t('Plain '), t('styled words', [{ type: 'namedStyle', attrs: { id: STYLE } }]), t(' gap '), t('direct red', [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#d93025', fontFamily: null, fontSize: null } }])] },
  ] } }) })
  const row = (page, label) => page.locator('.format-row', { has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd')

  // ---- wide window: docked ----
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 } })
  await signIn(BASE, context)
  const page = await context.newPage()
  watch(page)
  await page.goto(BASE)
  await page.locator('.note-item').first().waitFor()
  check('home has no Format sidebar', (await page.locator('.format-panel').count()) === 0 && (await page.locator('.format-toggle').count()) === 0)
  await page.locator('.note-item').first().click()
  await page.locator('.format-panel.is-docked').waitFor()
  check('a wide window shows it docked on first use', true)
  await page.locator('.document').getByText('styled words').click()
  await page.waitForTimeout(300)
  check('the text style is named', (await row(page, 'Text style').textContent()).includes('Phase8 Callout'))
  check('color comes from the style', (await row(page, 'Color').textContent()).includes('#9334e6') && (await row(page, 'Color').locator('.format-source').textContent()) === 'Phase8 Callout')
  await page.locator('.document').getByText('direct red').click()
  await page.waitForTimeout(300)
  check('direct formatting says Direct', (await row(page, 'Color').textContent()).includes('#d93025') && (await row(page, 'Color').locator('.format-source').textContent()) === 'Direct')
  check('the paragraph has no style', (await row(page, 'Paragraph style').textContent()).includes('No style'))

  // style name opens the Styles menu
  await page.locator('.document').getByText('styled words').click()
  await page.locator('.format-style-name.is-button').click()
  await page.locator('.styles-popover').waitFor({ timeout: 3000 })
  check('the style name opens the Styles menu', true)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // Clear formatting on the direct text
  await page.locator('.document').getByText('direct red').dblclick()
  await page.locator('.format-foot button').click()
  await page.waitForTimeout(400)
  check('Clear formatting removes direct formatting', (await row(page, 'Bold').textContent()).startsWith('Off'))

  // collapse, remember, shortcut
  await page.locator('.format-toggle').click()
  await page.waitForTimeout(200)
  check('the toggle hides it', (await page.locator('.format-panel').count()) === 0 && (await page.locator('.format-toggle').getAttribute('aria-expanded')) === 'false')
  await page.reload()
  await page.locator('.document').waitFor()
  await page.waitForTimeout(300)
  check('the choice survives a reload', (await page.locator('.format-panel').count()) === 0)
  await page.locator('.document').click()
  await page.keyboard.press('Control+Alt+Shift+Backslash')
  await page.waitForTimeout(200)
  check('Ctrl+Alt+Shift+\\ shows it again', (await page.locator('.format-panel').count()) === 1)
  check('…and the editor keeps focus', await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')))
  await page.screenshot({ path: `${SHOTS}/p8-e2e-docked.png` })
  await context.close()

  // ---- medium window: overlay ----
  const mid = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  await signIn(BASE, mid)
  const mp = await mid.newPage()
  watch(mp)
  await mp.goto(`${BASE}/notes/${note.id}`)
  await mp.locator('.document').waitFor()
  await mp.waitForTimeout(300)
  check('a medium window starts closed (even though open is remembered)', (await mp.locator('.format-panel').count()) === 0)
  await mp.locator('.format-toggle').click()
  await mp.locator('.format-panel.is-overlay').waitFor()
  check('it opens as an overlay', true)
  await mp.locator('.format-close').focus()
  await mp.keyboard.press('Escape')
  await mp.waitForTimeout(300)
  check('Escape closes the overlay and focus returns to the toggle', (await mp.locator('.format-panel').count()) === 0 && (await mp.evaluate(() => document.activeElement?.classList.contains('format-toggle'))))
  await mid.close()

  // ---- phone: bottom sheet ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true })
  await signIn(BASE, phone)
  const pp = await phone.newPage()
  watch(pp)
  await pp.goto(`${BASE}/notes/${note.id}`)
  await pp.locator('.document').waitFor()
  await pp.locator('.format-toggle').click()
  await pp.locator('.format-panel.is-sheet').waitFor()
  await pp.waitForTimeout(300)
  check('phone: a bottom sheet (a modal dialog)', (await pp.locator('.format-panel').getAttribute('role')) === 'dialog' && (await pp.locator('.app').getAttribute('inert')) !== null)
  check('phone: focus moves into the sheet', await pp.evaluate(() => document.activeElement?.classList.contains('format-close')))
  await pp.screenshot({ path: `${SHOTS}/p8-phone-sheet.png` })
  await pp.keyboard.press('Escape')
  await pp.waitForTimeout(400)
  check('phone: Escape closes it, the app is live again, focus on the toggle', (await pp.locator('.format-panel').count()) === 0 && (await pp.locator('.app').getAttribute('inert')) === null && (await pp.evaluate(() => document.activeElement?.classList.contains('format-toggle'))))
  await pp.locator('.document').click()
  await pp.keyboard.press('Control+Alt+Shift+Backslash')
  await pp.waitForTimeout(300)
  check('phone: the shortcut opens the sheet (the closed notes drawer does not block it)', (await pp.locator('.format-panel.is-sheet').count()) === 1)
  await phone.close()

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  check('script ran to completion', false, String(error).split('\n').slice(0, 3).join(' | '))
}
console.log(`${passed}/${total} checks passed`)
await browser.close()
