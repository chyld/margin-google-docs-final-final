// Read-only check of the real instance (after a deploy): signs in, opens every note, never types in a
// document, then signs this session out. Usage: MARGIN_REAL_USER=<name> PW=<password> node e2e/smoke-real.mjs
import { tmpdir } from 'node:os'
import { chromium } from 'playwright-core'
import { signIn } from './login.mjs'
const BASE = process.env.MARGIN_REAL_URL ?? 'http://localhost:5555'
const SHOTS = process.env.MARGIN_SHOTS ?? `${tmpdir()}/margin-shots`
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } })
if (!process.env.MARGIN_REAL_USER || !process.env.PW) {
  console.error('Set MARGIN_REAL_USER and PW to an account on the real instance.')
  process.exit(2)
}
await signIn(BASE, context, process.env.MARGIN_REAL_USER, process.env.PW)
const page = await context.newPage()
await page.setViewportSize({ width: 1400, height: 950 })
const errors = []
let writes = 0
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => message.type() === 'error' && errors.push(message.text()))
page.on('request', request => {
  if (request.method() !== 'GET') writes += 1
})
await page.goto(BASE)
await page.locator('.note-item').first().waitFor()
const count = await page.locator('.note-item').count()
for (let i = 0; i < count; i += 1) {
  await page.locator('.note-item').nth(i).click()
  await page.locator('.document').waitFor()
  await page.waitForTimeout(700)
  const title = await page.locator('.note-title').inputValue()
  const images = await page.locator('.document img').evaluateAll(list => list.map(img => img.naturalWidth > 0))
  console.log(`${title}: editable=${await page.locator('.document').getAttribute('contenteditable')} images=${images.filter(Boolean).length}/${images.length}`)
}
await page.locator('.note-item').first().click()
await page.waitForTimeout(1500)
await page.screenshot({ path: `${SHOTS}/real-light.png` })
await page.emulateMedia({ colorScheme: 'dark' })
await page.waitForTimeout(300)
await page.screenshot({ path: `${SHOTS}/real-dark.png` })
console.log('non-GET requests:', writes, 'errors:', errors)
// Sign out just this test session (never `margin-user logout`, which would sign the owner out too).
await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
await browser.close()
