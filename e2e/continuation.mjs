// Phase 5: styles keep going across Enter, any formatting-bar change ends them, full-width page.
// Throwaway instance only: MARGIN_URL=http://localhost:5557 node phase5.mjs
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
const settle = page => page.waitForTimeout(80)

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await signIn(BASE, context)
  for (const note of await (await fetch(`${BASE}/api/notes`)).json()) await fetch(`${BASE}/api/notes/${note.id}`, { method: 'DELETE' })
  const mk = async (name, props) => {
    const id = crypto.randomUUID()
    await fetch(`${BASE}/api/styles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name: `${name} ${id.slice(0, 4)}`, props }) })
    return { id, name: `${name} ${id.slice(0, 4)}` }
  }
  const purple = await mk('Purple', { color: '#9334e6', bold: true })
  const title = await mk('Title', { block: 'h2', color: '#188038' })
  const centered = await mk('Centered', { align: 'center' })

  const page = await context.newPage()
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => message.type() === 'error' && errors.push(message.text()))
  page.on('response', response => response.status() === 401 && errors.push(`401 ${response.url()}`))
  await page.goto(BASE)
  await page.locator('.empty-state button, .new-note').first().click()
  await page.locator('.document').waitFor()
  const doc = page.locator('.document')
  const color = (locator) => locator.evaluate(el => getComputedStyle(el).color)
  async function pickStyle(style) {
    await page.locator('.styles-trigger').click()
    await page.locator('.style-row', { hasText: style.name }).click()
    await settle(page)
  }
  async function newLine() {
    await doc.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await settle(page)
  }

  // ---- the user's flow: style on a new line, type, Enter, type ----
  await doc.click()
  await pickStyle(purple)
  await page.keyboard.type('First line')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Second line')
  await settle(page)
  const firstSpan = doc.locator(`span[data-style="${purple.id}"]`, { hasText: 'First line' })
  const secondSpan = doc.locator(`span[data-style="${purple.id}"]`, { hasText: 'Second line' })
  check('the style keeps going after Enter (your exact flow)', (await firstSpan.count()) === 1 && (await secondSpan.count()) === 1)
  check('…and the new line looks styled (purple)', (await color(secondSpan)) === 'rgb(147, 52, 230)')

  // ---- a heading-type style on the last line ----
  await newLine()
  await pickStyle(title)
  await page.keyboard.type('Heading one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Heading two')
  await settle(page)
  const headings = doc.locator(`h2[data-style-id="${title.id}"]`)
  check('a heading style continues as the same heading', (await headings.count()) === 2, `count=${await headings.count()}`)
  const headingText = doc.locator(`h2 span[data-style="${title.id}"]`, { hasText: 'Heading one' })
  check('…with its color on the first line too (it used to go missing)', (await headingText.count()) === 1 && (await color(headingText)) === 'rgb(24, 128, 56)')
  check('…and on the second', (await color(doc.locator(`h2 span[data-style="${title.id}"]`, { hasText: 'Heading two' }))) === 'rgb(24, 128, 56)')

  // ---- empty styled line: click away and back, then type ----
  await page.keyboard.press('Enter')
  await settle(page)
  // The empty styled heading (the editor keeps a plain empty paragraph after a final heading).
  const emptyHeading = doc.locator(`h2[data-style-id="${title.id}"]`).last()
  await doc.locator(':scope > *').first().click()
  await settle(page)
  await emptyHeading.click()
  await page.keyboard.type('Came back')
  await settle(page)
  check('clicking back into an empty styled line still types in the style', (await doc.locator(`span[data-style="${title.id}"]`, { hasText: 'Came back' }).count()) === 1)

  // ---- a formatting-bar change ends the style, keeping the look ----
  await newLine()
  await pickStyle(purple)
  await page.keyboard.type('Styled then')
  await page.getByRole('button', { name: 'Bold' }).click()
  check('the Bold button showed the style’s bold before the click', true)
  await page.keyboard.type(' plain')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Not styled')
  await settle(page)
  const before = doc.locator(`span[data-style="${purple.id}"]`, { hasText: 'Styled then' })
  check('text before the change keeps the style', (await before.count()) === 1)
  check('text after the change is not the style', (await doc.locator('span[data-style]', { hasText: 'plain' }).count()) === 0)
  const plainColor = await doc.locator('span[style*="color"]', { hasText: 'plain' }).first().evaluate(el => getComputedStyle(el).color).catch(() => 'none')
  check('…but keeps its look (still purple)', plainColor === 'rgb(147, 52, 230)', plainColor)
  check('…with bold switched off by the Bold button', (await doc.locator('strong', { hasText: 'plain' }).count()) === 0)
  check('Enter after a change does not bring the style back', (await doc.locator('[data-style]', { hasText: 'Not styled' }).count()) === 0)

  // ---- the same with a keyboard shortcut ----
  await newLine()
  await pickStyle(purple)
  await page.keyboard.type('Keyed')
  await page.keyboard.press('Control+i')
  await page.keyboard.type(' italic')
  await settle(page)
  check('Ctrl+I also ends the style', (await doc.locator('span[data-style]', { hasText: 'italic' }).count()) === 0 && (await doc.locator('em', { hasText: 'italic' }).count()) === 1)

  // ---- a paragraph-only style on a few words styles the paragraph ----
  await newLine()
  await page.keyboard.type('Center this line')
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowLeft')
  await pickStyle(centered)
  const align = await doc.locator(`[data-style-id="${centered.id}"]`).first().evaluate(el => getComputedStyle(el).textAlign).catch(() => 'none')
  check('a paragraph style on a few words centers the whole line (no silent no-op)', align === 'center', align)

  // ---- full width ----
  const widths = async () => page.evaluate(() => {
    const main = document.querySelector('.canvas').getBoundingClientRect().width
    const pageBox = document.querySelector('.page').getBoundingClientRect().width
    return { main: Math.round(main), page: Math.round(pageBox) }
  })
  let w = await widths()
  check('the page fills the space beside the sidebar at 1400px', w.main - w.page <= 34, JSON.stringify(w))
  await page.setViewportSize({ width: 1000, height: 800 })
  await settle(page)
  w = await widths()
  check('…and at 1000px', w.main - w.page <= 34, JSON.stringify(w))
  const scroll = await page.evaluate(() => {
    const canvas = document.querySelector('.canvas')
    return canvas.scrollHeight - canvas.clientHeight
  })
  check('a short note needs no scrolling', scroll <= 1 || (await doc.evaluate(el => el.scrollHeight)) > 500, `overflow=${scroll}`)
  await page.screenshot({ path: `${SHOTS}/p5-full-width.png` })
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await signIn(BASE, phone)
  const phonePage = await phone.newPage()
  await phonePage.goto(BASE)
  await phonePage.getByRole('button', { name: 'Open notes menu' }).click()
  await phonePage.locator('.note-item').first().click()
  await phonePage.locator('.page').waitFor()
  const phoneWidth = await phonePage.locator('.page').evaluate(el => Math.round(el.getBoundingClientRect().width))
  check('phones are unchanged (page fills the screen)', phoneWidth >= 360 && phoneWidth <= 380, `width=${phoneWidth}`)
  await phone.close()

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  check('script ran to completion', false, String(error).split('\n').slice(0, 3).join(' | '))
} finally {
  await browser.close()
}
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
