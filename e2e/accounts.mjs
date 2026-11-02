// Phase 3: accounts, the session-ended flow, two users, themes, phones.
// Runs against a throwaway instance only:
//   e2e/run.sh accounts   (a fresh throwaway server on 5557; MARGIN_DATA is its data directory)
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { BASE, DATA, REPO, SHOTS } from './env.mjs'

if (!DATA) {
  console.error('Set MARGIN_DATA to the throwaway instance data directory.')
  process.exit(2)
}
const results = []
const errors = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function cli(args, input) {
  try {
    return execFileSync('node', [`${REPO}/server/cli.ts`, ...args], {
      env: { ...process.env, DATA_DIR: DATA },
      input: input ?? '',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
}

const stamp = Date.now().toString(36)
const ALICE = `alice${stamp}`
const BOB = `bob${stamp}`
const LOCKY = `locky${stamp}`
const PASS_A = 'alice-password-1'
const PASS_B = 'bob-password-22'
cli(['add', ALICE, '--password-stdin'], PASS_A)
cli(['add', BOB, '--password-stdin'], PASS_B)
cli(['add', LOCKY, '--password-stdin'], 'locky-password-3')

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true })

function watch(page, label) {
  page.on('pageerror', error => errors.push(`${label}: ${error}`))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const text = message.text()
    // Expected: 401s while signed out, 409 for the other account, the 429 test.
    if (/401|409|429|Unauthorized|Conflict|Too Many|ERR_INTERNET_DISCONNECTED/i.test(text)) return
    if (label === 'bob' && /404/.test(text)) return
    errors.push(`${label}: ${text}`)
  })
}

async function signInUi(page, username, password) {
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

const doc = page => page.locator('.document')

try {
  // ---- sign-in screen ----
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const page = await context.newPage()
  watch(page, 'alice')
  page.on('dialog', dialog => dialog.accept())
  await page.goto(BASE)
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
  check('signed-out visitors see the sign-in screen', true)
  check('the username field has focus', await page.evaluate(() => document.activeElement?.getAttribute('name') === 'username'))
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOTS}/p3-login-light.png` })

  await signInUi(page, ALICE, 'wrong password!')
  await page.locator('.login-error').filter({ hasText: 'Wrong username or password' }).waitFor()
  check('a wrong password shows an inline error', true)

  await signInUi(page, ALICE.toUpperCase(), PASS_A)
  await page.locator('.sidebar').waitFor()
  check('signs in (username is case-insensitive)', true)
  await page.getByRole('button', { name: 'Create your first note' }).click()
  await doc(page).waitFor()
  await page.locator('.note-title').fill('Alice secret plans')
  await doc(page).click()
  await page.keyboard.type('zebra crossing at noon')
  await page.locator('.save-status').filter({ hasText: 'All changes saved' }).waitFor({ timeout: 10_000 })
  check('alice can create and save a note', true)
  await page.screenshot({ path: `${SHOTS}/p3-app-light.png` })

  // ---- rate limit (its own user, so the others aren't affected) ----
  const limitPage = await browser.newPage()
  await limitPage.goto(BASE)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await signInUi(limitPage, LOCKY, `wrong-${attempt}-password`)
    await limitPage.locator('.login-error').filter({ hasText: 'Wrong' }).waitFor()
  }
  await signInUi(limitPage, LOCKY, 'locky-password-3')
  await limitPage.locator('.login-error').filter({ hasText: 'Too many attempts' }).waitFor()
  check('too many failures shows the wait time', true, await limitPage.locator('.login-error').textContent())
  await limitPage.close()

  // ---- session ends mid-edit: revoked from the CLI ----
  cli(['logout', ALICE])
  await doc(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' and more after logout')
  await page.locator('.session-dialog').waitFor({ timeout: 15_000 })
  check('the session-ended dialog appears when saving fails with 401', true)
  check('the app behind the dialog is inert', await page.evaluate(() => document.querySelector('.app')?.inert === true))
  check('the save status says it is waiting', (await page.locator('.save-status').textContent())?.includes('Signed out') ?? false)
  check('focus is on the password field', await page.evaluate(() => document.activeElement?.getAttribute('name') === 'password'))
  await page.keyboard.press('Escape')
  check('Escape does not dismiss the dialog', await page.locator('.session-dialog').isVisible())
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOTS}/p3-session-ended.png` })
  await page.getByLabel('Password', { exact: true }).fill(PASS_A)
  await page.getByRole('button', { name: 'Sign in again' }).click()
  await page.locator('.session-dialog').waitFor({ state: 'detached' })
  await page.locator('.save-status').filter({ hasText: 'All changes saved' }).waitFor({ timeout: 10_000 })
  const notesAfter = await page.evaluate(async () => (await fetch('/api/notes').then(r => r.json())).map(n => n.snippet))
  check('the edit made while signed out is saved after signing in again', notesAfter.some(s => s.includes('and more after logout')), JSON.stringify(notesAfter))

  // ---- two users, separate browsers ----
  const bobContext = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const bobPage = await bobContext.newPage()
  watch(bobPage, 'bob')
  await bobPage.goto(BASE)
  await signInUi(bobPage, BOB, PASS_B)
  await bobPage.locator('.sidebar').waitFor()
  await bobPage.waitForTimeout(500)
  const bobList = await bobPage.locator('.note-item').count()
  check("bob does not see alice's notes", bobList === 0, `items=${bobList}`)
  await bobPage.getByLabel('Search notes').fill('zebra')
  await bobPage.waitForTimeout(600)
  check("bob's search does not find alice's text", (await bobPage.locator('.note-item').count()) === 0)
  const aliceNoteId = page.url().split('/').pop()
  await bobPage.goto(`${BASE}/notes/${aliceNoteId}`)
  await bobPage.getByText('Note not found').waitFor()
  check("opening alice's note URL as bob says not found", true)

  // ---- two tabs, one browser: another account signs in ----
  const aliceId = await page.evaluate(async () => (await fetch('/api/auth/me').then(r => r.json())).user.id)
  const tab2 = await context.newPage()
  watch(tab2, 'tab2')
  await tab2.goto(BASE)
  await tab2.locator('.sidebar').waitFor()
  await tab2.evaluate(async ([username, password]) => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
    new BroadcastChannel('margin-auth').postMessage({ type: 'signed-in', userId: 'someone-else' })
  }, [BOB, PASS_B])
  await page.locator('.session-dialog').filter({ hasText: 'Another account signed in' }).waitFor({ timeout: 10_000 })
  check('the first tab learns another account signed in', true)
  const before = await page.evaluate(async id => (await fetch('/api/notes', { headers: { 'X-Margin-User': id } }).then(r => r.status)), aliceId)
  check('requests from the first tab are refused (409), not applied to bob', before === 409, `status=${before}`)
  await page.getByLabel('Password', { exact: true }).fill(PASS_A)
  await page.getByRole('button', { name: 'Sign in again' }).click()
  await page.locator('.session-dialog').waitFor({ state: 'detached' })
  check('signing in again as alice continues in place', (await page.locator('.note-title').inputValue()) === 'Alice secret plans')
  await tab2.close()

  // ---- sign out that fails (server unreachable): stays signed in and says so ----
  await page.route('**/api/auth/logout', route => route.abort('internetdisconnected'))
  await page.locator('.user-chip').click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.locator('.notice').filter({ hasText: "Couldn't sign out" }).waitFor({ timeout: 10_000 })
  check('a failed sign-out keeps the app and says so', await page.locator('.sidebar').isVisible())
  check('…and editing works again', (await page.locator('.document').getAttribute('contenteditable')) === 'true')
  await page.unroute('**/api/auth/logout')

  // ---- sign out with an unsaved edit ----
  await page.route('**/api/notes/*', route => (route.request().method() === 'PATCH' ? route.abort('internetdisconnected') : route.continue()))
  await doc(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' unsent words')
  await page.waitForTimeout(300)
  const confirmMessages = []
  page.removeAllListeners('dialog')
  page.on('dialog', dialog => {
    confirmMessages.push(dialog.message())
    void dialog.accept()
  })
  await page.locator('.user-chip').click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor({ timeout: 20_000 })
  check('sign out with unsaved changes asks first', confirmMessages.some(m => m.includes('stay in this browser')), confirmMessages.join(' | '))
  const keptDraft = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('margin:draft:')))
  check('the unsaved edit is kept as this user’s draft', keptDraft.length === 1 && !keptDraft[0].endsWith(':') && keptDraft[0].split(':').length === 4, keptDraft.join(','))
  await page.unroute('**/api/notes/*')
  check('signed out for real (API refuses)', (await page.evaluate(async () => (await fetch('/api/notes')).status)) === 401)

  // ---- theme ----
  await page.getByRole('radio', { name: 'Dark theme' }).click()
  check('dark theme applies on the sign-in screen', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOTS}/p3-login-dark.png` })
  await page.reload()
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
  check('the theme choice survives a reload', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
  await signInUi(page, ALICE, PASS_A)
  await page.locator('.sidebar').waitFor()
  // Phase 7: "/" is home (no note opens by itself), so open the newest note.
  await page.locator('.note-item').first().click()
  await doc(page).waitFor()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/p3-app-dark.png` })
  const pageColors = await page.evaluate(() => {
    const pageEl = document.querySelector('.page')
    const docEl = document.querySelector('.document')
    return { page: getComputedStyle(pageEl).backgroundColor, text: getComputedStyle(docEl).color }
  })
  check('in dark mode the page stays white with dark ink', pageColors.page === 'rgb(255, 255, 255)' && pageColors.text === 'rgb(32, 33, 36)', JSON.stringify(pageColors))
  await page.locator('.user-chip').click()
  await page.getByRole('radio', { name: 'System' }).click()
  await page.keyboard.press('Escape')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(150)
  check('System follows the OS (dark)', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForTimeout(150)
  check('System follows the OS (light)', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light')

  // ---- phone ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const phonePage = await phone.newPage()
  watch(phonePage, 'phone')
  await phonePage.goto(BASE)
  await phonePage.waitForTimeout(600)
  await phonePage.screenshot({ path: `${SHOTS}/p3-phone-login.png` })
  await signInUi(phonePage, ALICE, PASS_A)
  await phonePage.locator('.app-bar').waitFor()
  check('phones get an app bar', await phonePage.locator('.app-bar').isVisible())
  check('the drawer starts closed', !(await phonePage.locator('.sidebar').isVisible()))
  await phonePage.screenshot({ path: `${SHOTS}/p3-phone-empty.png` })
  await phonePage.getByRole('button', { name: 'Open notes menu' }).click()
  await phonePage.locator('.sidebar.is-open').waitFor()
  await phonePage.waitForTimeout(350)
  check('the drawer opens as a modal dialog', (await phonePage.locator('.sidebar').getAttribute('aria-modal')) === 'true')
  check('focus moves into the drawer', await phonePage.evaluate(() => document.activeElement?.classList.contains('drawer-close')))
  await phonePage.screenshot({ path: `${SHOTS}/p3-phone-drawer.png` })
  await phonePage.keyboard.press('Escape')
  await phonePage.waitForTimeout(350)
  check('Escape closes the drawer and focus returns to the menu button', !(await phonePage.locator('.sidebar').isVisible()) && (await phonePage.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Open notes menu')))
  await phonePage.getByRole('button', { name: 'Open notes menu' }).click()
  await phonePage.locator('.note-item').first().click()
  await phonePage.locator('.document').waitFor()
  await phonePage.waitForTimeout(350)
  check('opening a note closes the drawer', !(await phonePage.locator('.sidebar').isVisible()))
  check('focus moves to the note title', await phonePage.evaluate(() => document.activeElement?.classList.contains('note-title')))
  check('the save status is visible on phones', await phonePage.locator('.save-status').isVisible())
  const toolbarScrolls = await phonePage.evaluate(() => {
    const bar = document.querySelector('.toolbar')
    return bar.scrollWidth > bar.clientWidth && getComputedStyle(bar).flexWrap === 'nowrap'
  })
  check('the toolbar is one scrollable row', toolbarScrolls)
  await phonePage.locator('.document').click()
  await phonePage.getByRole('button', { name: 'Text color' }).click()
  const sheet = await phonePage.locator('.color-popover').boundingBox()
  check('menus open as bottom sheets inside the screen', sheet !== null && sheet.x >= 0 && sheet.x + sheet.width <= 390 && sheet.y + sheet.height <= 844 && sheet.y > 300, JSON.stringify(sheet))
  await phonePage.screenshot({ path: `${SHOTS}/p3-phone-sheet.png` })
  await phonePage.keyboard.press('Escape')
  await phonePage.emulateMedia({ colorScheme: 'dark' })
  await phonePage.waitForTimeout(200)
  await phonePage.screenshot({ path: `${SHOTS}/p3-phone-dark.png` })

  // ---- reduced motion ----
  const calm = await browser.newContext({ viewport: { width: 1000, height: 700 }, reducedMotion: 'reduce' })
  const calmPage = await calm.newPage()
  await calmPage.goto(BASE)
  await calmPage.locator('.login-card').waitFor()
  // Phase 6: the login card's entrance animation is skipped (0.01ms) when motion is reduced.
  const duration = await calmPage.evaluate(() => getComputedStyle(document.querySelector('.login-card')).animationDuration)
  check('no entrance animation with reduced motion', parseFloat(duration) < 0.001, duration)

  check('no unexpected console errors', errors.length === 0, errors.slice(0, 5).join(' | '))
} catch (error) {
  check('script ran to completion', false, String(error).split('\n').slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
