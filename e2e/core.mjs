// Core editor checks: notes, formatting, autosave, drafts, conflicts, broken notes.
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { signIn } from './login.mjs'
import { toolFor } from './toolbar.mjs'
import { BASE, DB, SHOTS } from './env.mjs'

const results = []
const consoleErrors = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, init)
  return response.status === 204 ? null : response.json()
}

function walkMarks(node, out = new Set()) {
  for (const mark of node.marks ?? []) out.add(mark.type)
  for (const child of node.content ?? []) walkMarks(child, out)
  return out
}

function walkTypes(node, out = new Set()) {
  out.add(node.type)
  for (const child of node.content ?? []) walkTypes(child, out)
  return out
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const session = await signIn(BASE, context)
const page = await context.newPage()
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', error => consoleErrors.push(String(error)))
page.on('dialog', dialog => dialog.accept())

const mod = 'Control'
// ProseMirror reads native selection moves (End, Shift+Arrow) from the async selectionchange event.
// Pause briefly after them, as a human would, so the next key sees the updated selection.
const settle = () => page.waitForTimeout(40)
async function press(key) {
  await page.keyboard.press(key)
  if (/End|Home|Arrow|Escape|Enter/.test(key)) await settle()
}
const editor = page.locator('.document')
const status = page.locator('.save-status')
const waitSaved = () => status.filter({ hasText: 'All changes saved' }).waitFor({ timeout: 10_000 })
const tool = toolFor(page)

try {
  // Start from an empty database.
  for (const note of await api('/api/notes')) await api(`/api/notes/${note.id}`, { method: 'DELETE' })

  await page.goto(BASE)
  await page.getByText('No notes yet').first().waitFor()
  check('empty state on a fresh database', true)

  // Create a note.
  await page.getByRole('button', { name: 'Create your first note' }).click()
  await page.waitForURL(/\/notes\/[0-9a-f-]{36}$/)
  const noteA = page.url().split('/').pop()
  const titleFocused = await page
    .waitForFunction(() => document.activeElement?.classList.contains('note-title'), null, { timeout: 3000 })
    .then(() => true, () => false)
  check('new note opens with the title focused', titleFocused)

  await page.keyboard.type('E2E formatting test')
  await press('Enter')
  const editorFocused = await page.evaluate(() => document.activeElement?.classList.contains('document'))
  check('Enter in the title moves to the document', editorFocused)
  check('sidebar title updates while typing', (await page.locator('.note-item.is-active .note-item-title').textContent()) === 'E2E formatting test')

  // Headings via the style select.
  await page.keyboard.type('Big heading')
  await page.getByLabel('Paragraph type').selectOption('h1')
  check('Heading 1 from the style select', (await editor.locator('h1').textContent()) === 'Big heading')
  check('style select reflects the heading', (await page.getByLabel('Paragraph type').inputValue()) === 'h1')
  await press('End')
  await press('Enter')
  check('Enter after a heading returns to normal text', (await page.getByLabel('Paragraph type').inputValue()) === 'paragraph')

  // Marks: type a word, select it, toggle each mark.
  async function typeAndSelect(word) {
    await page.keyboard.type(word)
    for (let index = 0; index < word.length; index += 1) await page.keyboard.press('Shift+ArrowLeft')
    await settle()
  }
  const marks = [
    ['Bold', 'strong'],
    ['Italic', 'em'],
    ['Underline', 'u'],
    ['Strikethrough', 's'],
    ['Inline code', 'code'],
  ]
  for (const [label, tag] of marks) {
    await typeAndSelect(label.toLowerCase().replace(' ', ''))
    await tool(label).click()
    const pressed = await tool(label).getAttribute('aria-pressed')
    const found = await editor.locator(tag).filter({ hasText: label.toLowerCase().replace(' ', '') }).count()
    check(`${label} applies and shows as active`, found === 1 && pressed === 'true', `found=${found} pressed=${pressed}`)
    await press('End')
    await tool(label).click() // turn the mark off for the next word
    await page.keyboard.type(' ')
  }

  // Text color and highlight.
  await typeAndSelect('colored')
  await tool('Text color').click()
  await page.getByRole('menuitemradio', { name: 'Red' }).click()
  const colorStyle = await editor.locator('span[style*="color"]').first().getAttribute('style')
  check('text color applies', /color:\s*(#d93025|rgb\(217, 48, 37\))/i.test(colorStyle ?? ''), colorStyle ?? 'none')
  await tool('Highlight color').click()
  await page.getByRole('menuitemradio', { name: 'Yellow' }).click()
  check('highlight applies', (await editor.locator('mark').count()) === 1)
  await press('End')
  await press('Enter')

  // Link via Ctrl+K.
  await typeAndSelect('tiptap')
  await press(`${mod}+k`)
  await page.getByLabel('Link address').fill('tiptap.dev')
  await page.getByRole('button', { name: 'Apply' }).click()
  await settle()
  const href = await editor.locator('a').first().getAttribute('href')
  check('Ctrl+K link with https:// added', href === 'https://tiptap.dev', String(href))
  await press('End')

  // javascript: links are refused.
  await page.keyboard.type(' ')
  await typeAndSelect('evil')
  await tool('Link').click()
  await page.getByLabel('Link address').fill('javascript:alert(1)')
  await page.getByRole('button', { name: 'Apply' }).click()
  check('javascript: link refused', (await page.locator('.popover-error').count()) === 1 && (await editor.locator('a').count()) === 1)
  await press('Escape')
  await editor.click()
  await press(`${mod}+End`)
  await press('Enter')

  // Alignment.
  await page.keyboard.type('centered line')
  await tool('Align center').click()
  check('align center', (await editor.locator('p[style*="text-align: center"]').count()) === 1 && (await tool('Align center').getAttribute('aria-pressed')) === 'true')
  await tool('Align left').click()
  await press('End')
  await press('Enter')

  // Lists, quote, code block, horizontal rule.
  await tool('Bulleted list').click()
  await page.keyboard.type('bullet one')
  check('bulleted list', (await editor.locator('ul:not([data-type]) li').count()) === 1 && (await tool('Bulleted list').getAttribute('aria-pressed')) === 'true')
  await press('Enter')
  await press('Enter')
  await tool('Numbered list').click()
  await page.keyboard.type('number one')
  check('numbered list', (await editor.locator('ol li').count()) === 1)
  await press('Enter')
  await press('Enter')
  await tool('Checklist').click()
  await page.keyboard.type('task one')
  check('checklist', (await editor.locator('ul[data-type="taskList"] li').count()) === 1)
  await editor.locator('ul[data-type="taskList"] input[type="checkbox"]').check()
  check('checklist item can be checked', (await editor.locator('li[data-checked="true"]').count()) === 1)
  await editor.locator('ul[data-type="taskList"] li div p').click()
  await press('End')
  await press('Enter')
  await press('Enter')
  await tool('Quote').click()
  await page.keyboard.type('a quote')
  check('blockquote', (await editor.locator('blockquote').count()) === 1)
  await press('Enter')
  await press('Enter')
  await tool('Code block').click()
  await page.keyboard.type('const x = 1')
  check('code block', (await editor.locator('pre code').count()) === 1)
  await press('Enter')
  await press('Enter')
  await press('Enter')
  await tool('Horizontal line').click()
  check('horizontal line', (await editor.locator('hr').count()) === 1)

  // Undo / redo on a freshly typed word.
  await press('Enter')
  await page.keyboard.type('undoable')
  await page.waitForTimeout(600) // let undo history close the group
  await press(`${mod}+z`)
  check('undo works', (await editor.getByText('undoable').count()) === 0)
  await tool('Redo').click()
  check('redo works', (await editor.getByText('undoable').count()) === 1)

  // Clear formatting on just one word.
  await press(`${mod}+End`)
  await page.keyboard.type(' plain')
  for (let index = 0; index < 5; index += 1) await page.keyboard.press('Shift+ArrowLeft')
  await settle()
  await tool('Bold').click()
  const boldBefore = await editor.locator('strong').filter({ hasText: 'plain' }).count()
  await tool('Clear formatting').click()
  check('clear formatting removes marks from the selection only', boldBefore === 1 && (await editor.locator('strong').filter({ hasText: 'plain' }).count()) === 0 && (await editor.locator('strong').filter({ hasText: 'bold' }).count()) === 1)
  await press(`${mod}+End`)

  // Autosave.
  await waitSaved()
  check('autosave shows "All changes saved"', true)
  const savedA = await api(`/api/notes/${noteA}`)
  const savedMarks = walkMarks(savedA.content)
  const savedTypes = walkTypes(savedA.content)
  const expectedMarks = ['bold', 'italic', 'underline', 'strike', 'code', 'textStyle', 'highlight', 'link']
  const expectedTypes = ['heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'horizontalRule']
  check('server stored every mark', expectedMarks.every(mark => savedMarks.has(mark)), [...savedMarks].join(','))
  check('server stored every block type', expectedTypes.every(type => savedTypes.has(type)), [...savedTypes].join(','))
  check('server stored the title', savedA.title === 'E2E formatting test')

  // Reload keeps everything.
  const htmlBefore = await editor.innerHTML()
  await page.reload()
  await editor.waitFor()
  check('reload keeps the note open and identical', (await editor.innerHTML()) === htmlBefore && (await page.locator('.note-title').inputValue()) === 'E2E formatting test')

  // Second note, then quick A→B→A switching while typing.
  await page.getByRole('button', { name: 'New note' }).click()
  await page.waitForURL(url => !url.pathname.endsWith(noteA))
  const noteB = page.url().split('/').pop()
  await page.locator('.note-title:focus').waitFor()
  await page.keyboard.type('Second note')
  await editor.click()
  await page.keyboard.type('typed in B')
  await page.locator(`a[href="/notes/${noteA}"]`).click()
  await editor.waitFor()
  await editor.click()
  await press(`${mod}+End`)
  await page.keyboard.type(' plus A')
  await page.locator(`a[href="/notes/${noteB}"]`).click()
  await editor.waitFor()
  check('B shows its own unsaved-or-saved text after switching', (await editor.textContent())?.includes('typed in B') ?? false)
  await page.locator(`a[href="/notes/${noteA}"]`).click()
  await editor.waitFor()
  check('A shows the edit made just before switching', (await editor.textContent())?.includes('plus A') ?? false)
  await waitSaved()
  await page.waitForTimeout(500)
  const [finalA, finalB] = await Promise.all([api(`/api/notes/${noteA}`), api(`/api/notes/${noteB}`)])
  const textA = JSON.stringify(finalA.content)
  const textB = JSON.stringify(finalB.content)
  check('no edits crossed between notes', textA.includes('plus A') && !textA.includes('typed in B') && textB.includes('typed in B') && !textB.includes('plus A'))
  check('second note title saved', finalB.title === 'Second note')

  // Search.
  await page.getByLabel('Search notes').fill('plus A')
  await page.waitForTimeout(600)
  const hits = await page.locator('.note-item').count()
  check('search by body text', hits === 1 && (await page.locator('.note-item-title').first().textContent()) === 'E2E formatting test', `hits=${hits}`)
  await page.getByLabel('Search notes').fill('zzz-no-match')
  await page.getByText('No notes match your search.').waitFor()
  check('search with no results', true)
  await page.getByLabel('Search notes').fill('')
  await page.waitForTimeout(400)

  // Offline save, then draft recovery after reload.
  await page.route('**/api/notes/*', route => (route.request().method() === 'PATCH' ? route.abort('internetdisconnected') : route.continue()))
  await editor.click()
  await press(`${mod}+End`)
  await page.keyboard.type(' offline words')
  await status.filter({ hasText: 'retrying' }).waitFor({ timeout: 10_000 })
  check('failed save shows "retrying"', true)
  // Hide the page so drafts are written synchronously, like closing a tab.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const draftKeys = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('margin:draft:')))
  check('draft kept in localStorage while offline', draftKeys.length === 1, draftKeys.join(','))
  // Closing the tab: the small pending edit goes out as a keepalive request.
  await page.close({ runBeforeUnload: false })
  let keptAlive = false
  for (let attempt = 0; attempt < 20 && !keptAlive; attempt += 1) {
    keptAlive = JSON.stringify((await api(`/api/notes/${noteA}`)).content).includes('offline words')
    if (!keptAlive) await new Promise(resolve => setTimeout(resolve, 100))
  }
  check('small unsaved edit delivered by keepalive when the tab closes', keptAlive)

  // Crash recovery: a tab that died before saving leaves its draft in localStorage.
  const page3 = await context.newPage()
  const dialogs = []
  page3.on('dialog', dialog => {
    dialogs.push(dialog.message())
    void (dialog.type() === 'confirm' && dialog.message().includes('Restore those changes') ? dialog.dismiss() : dialog.accept())
  })
  page3.on('pageerror', error => consoleErrors.push(String(error)))
  await page3.goto(`${BASE}/notes/${noteA}`)
  await page3.locator('.document').waitFor()
  const seedDraft = (id, draft) => page3.evaluate(([key, value]) => localStorage.setItem(key, JSON.stringify(value)), [`margin:draft:${session.user.id}:${id}`, draft])
  const docWith = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

  // Nothing saved since the draft's base: restore automatically, then save.
  const serverB = await api(`/api/notes/${noteB}`)
  await seedDraft(noteB, { content: docWith('recovered after a crash'), editedAt: Date.now(), baseUpdatedAt: serverB.updatedAt })
  await page3.goto(`${BASE}/notes/${noteB}`)
  await page3.locator('.document').waitFor()
  check('draft restored after reopening', (await page3.locator('.document').textContent())?.includes('recovered after a crash') ?? false)
  check('restore notice shown', (await page3.locator('.banner.info').count()) === 1)
  await page3.locator('.save-status').filter({ hasText: 'All changes saved' }).waitFor({ timeout: 10_000 })
  check('restored draft saved to the server', JSON.stringify((await api(`/api/notes/${noteB}`)).content).includes('recovered after a crash'))
  check('draft cleared after saving', (await page3.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('margin:draft:')).length)) === 0)

  // The note was saved again after the draft's base: ask first; declining keeps the server copy.
  const serverA = await api(`/api/notes/${noteA}`)
  await seedDraft(noteA, { content: docWith('stale draft'), editedAt: serverA.updatedAt - 60_000, baseUpdatedAt: serverA.updatedAt - 120_000 })
  await page3.goto(`${BASE}/notes/${noteA}`)
  await page3.locator('.document').waitFor()
  check('older draft asks before restoring', dialogs.some(message => message.includes('Restore those changes')))
  check('declined draft is discarded and the saved note shown', !((await page3.locator('.document').textContent())?.includes('stale draft')) && (await page3.evaluate(id => localStorage.getItem(`margin:draft:${id}`), noteA)) === null)

  // A note whose stored content the editor can't parse opens read-only and is never overwritten.
  const broken = await api('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Broken note' }) })
  const brokenContent = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep me' }] }, { type: 'futureWidget', attrs: { x: 1 } }] })
  // Writes straight into the throwaway instance's database file (never the user's container).
  if (!DB) throw new Error('Set MARGIN_DB (or MARGIN_DATA) to the test instance database')
  execFileSync('node', ['-e',
    `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.prepare('UPDATE notes SET content=? WHERE id=?').run(process.argv[2], process.argv[3])`,
    DB, brokenContent, broken.id])
  const patches = []
  page3.on('request', request => {
    if (request.method() === 'PATCH' && request.url().includes(broken.id)) patches.push(request.url())
  })
  await page3.goto(`${BASE}/notes/${broken.id}`)
  await page3.locator('.banner.error').waitFor()
  const editable = await page3.locator('.document').getAttribute('contenteditable')
  check('unparseable note opens read-only with a warning', editable === 'false', `contenteditable=${editable}`)
  await page3.locator('.document').click()
  await page3.keyboard.type('should not save')
  await page3.waitForTimeout(1500)
  const brokenAfter = await api(`/api/notes/${broken.id}`)
  check('unparseable note is never overwritten', patches.length === 0 && JSON.stringify(brokenAfter.content) === brokenContent, `patches=${patches.length}`)
  const tool3 = toolFor(page3)
  check('toolbar is disabled on a read-only note', await tool3('Bold').isDisabled() && await tool3('Bulleted list').isDisabled())
  await page3.keyboard.press('Control+k')
  await page3.waitForTimeout(200)
  check('Ctrl+K does not open the link popover on a read-only note', (await page3.locator('.link-popover').count()) === 0)

  // Delete (confirm dialog auto-accepted).
  await page3.getByRole('button', { name: 'Delete note' }).click()
  await page3.waitForURL(url => !url.pathname.includes(broken.id))
  check('delete removes the note and opens the next one', (await api(`/api/notes/${broken.id}`)).error === 'Note not found')

  // Unknown note id.
  await page3.goto(`${BASE}/notes/00000000-0000-4000-8000-000000000000`)
  await page3.getByText('Note not found').waitFor()
  check('unknown note shows "Note not found"', true)

  // Malformed escape in the URL: a "not found" page, not a crash.
  await page3.goto(`${BASE}/notes/%E0%A4%A`)
  await page3.getByText('Note not found').waitFor()
  check('malformed note URL shows "Note not found"', (await page3.getByText('Something went wrong').count()) === 0)

  // A→B→A race: the GET for A reads the note before A's save lands, but its response arrives after.
  await page3.goto(`${BASE}/notes/${noteA}`)
  await page3.locator('.document').waitFor()
  let releasePatch
  let releaseGet
  const patchGate = new Promise(resolve => (releasePatch = resolve))
  const getGate = new Promise(resolve => (releaseGet = resolve))
  let armed = true
  await page3.route(`**/api/notes/${noteA}`, async route => {
    const method = route.request().method()
    if (armed && method === 'PATCH') {
      await patchGate
      await route.continue()
    } else if (armed && method === 'GET') {
      const response = await route.fetch() // reads the old content: the PATCH is still held
      releasePatch()
      await getGate
      await route.fulfill({ response })
    } else {
      await route.continue()
    }
  })
  await page3.locator('.document').click()
  await page3.keyboard.press('Control+End')
  await page3.waitForTimeout(40)
  await page3.keyboard.type(' raced')
  const patchResponse = page3.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(noteA))
  await page3.locator(`a[href="/notes/${noteB}"]`).click()
  await page3.locator('.document').waitFor()
  await page3.locator(`a[href="/notes/${noteA}"]`).click()
  await patchResponse
  await page3.waitForTimeout(100)
  releaseGet()
  await page3.locator('.document').waitFor()
  await page3.waitForTimeout(200)
  armed = false
  await page3.unroute(`**/api/notes/${noteA}`)
  check('stale GET after a save still shows the saved edit', (await page3.locator('.document').textContent())?.includes('raced') ?? false)
  await page3.locator('.document').click()
  await page3.keyboard.press('Control+End')
  await page3.waitForTimeout(40)
  await page3.keyboard.type(' after-race')
  await page3.locator('.save-status').filter({ hasText: 'All changes saved' }).waitFor({ timeout: 10_000 })
  const afterRace = JSON.stringify((await api(`/api/notes/${noteA}`)).content)
  check('the next save keeps the raced edit', afterRace.includes('raced') && afterRace.includes('after-race'))

  // Pasting text colored with oklch() (common on modern sites) must not block saving.
  await page3.locator('.document').evaluate(element => {
    const data = new DataTransfer()
    data.setData('text/html', '<p><span style="color: oklch(0.6 0.2 30)">oklch pasted</span></p>')
    data.setData('text/plain', 'oklch pasted')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await page3.locator('.save-status').filter({ hasText: 'All changes saved' }).waitFor({ timeout: 10_000 })
  const pasted = JSON.stringify((await api(`/api/notes/${noteA}`)).content)
  check('pasted oklch() color saves', pasted.includes('oklch pasted') && pasted.includes('oklch(0.6 0.2 30)'))

  // A failed delete keeps the note and its unsaved edits.
  await page3.getByRole('button', { name: 'New note' }).click()
  await page3.locator('.note-title:focus').waitFor()
  const doomedId = page3.url().split('/').pop()
  await page3.route('**/api/notes/*', route => (route.request().method() === 'DELETE' ? route.abort('internetdisconnected') : route.continue()))
  await page3.keyboard.type('Delete fails')
  await page3.getByRole('button', { name: 'Delete note' }).click()
  await page3.waitForTimeout(300)
  await page3.unroute('**/api/notes/*')
  check('failed delete keeps the note open', page3.url().endsWith(doomedId))
  await page3.locator('.save-status').filter({ hasText: 'All changes saved' }).waitFor({ timeout: 10_000 })
  check('failed delete still saves the pending edit', (await api(`/api/notes/${doomedId}`)).title === 'Delete fails')

  // Reopening a newly created note doesn't steal focus into the title.
  await page3.locator(`a[href="/notes/${noteA}"]`).click()
  await page3.locator('.document').waitFor()
  await page3.locator(`a[href="/notes/${doomedId}"]`).click()
  await page3.locator('.document').waitFor()
  await page3.waitForTimeout(200)
  check('revisiting a new note does not refocus its title', !(await page3.evaluate(() => document.activeElement?.classList.contains('note-title'))))

  // Screenshot of the formatted note for the user.
  await page3.goto(`${BASE}/notes/${noteA}`)
  await page3.locator('.document').waitFor()
  await page3.locator('.document h1').click()
  await page3.waitForTimeout(300)
  await page3.screenshot({ path: `${SHOTS}/margin.png` })
} catch (error) {
  check('script ran to completion', false, error instanceof Error ? error.stack?.split('\n').slice(0, 3).join(' | ') : String(error))
} finally {
  const relevantErrors = consoleErrors.filter(text => !text.includes('ERR_INTERNET_DISCONNECTED') && !text.includes('Failed to load resource'))
  check('no unexpected console errors', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '))
  await browser.close()
  const failed = results.filter(result => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}
