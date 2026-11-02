// End-to-end checks for Phase 2 (tables, images, sections, fonts, sizes, headings, highlights).
// Runs against a throwaway instance only: MARGIN_URL=http://localhost:5557
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { signIn } from './login.mjs'
import { toolFor } from './toolbar.mjs'
import { BASE, SHOTS } from './env.mjs'

const NETWORK_FONTS = process.env.MARGIN_NETWORK_FONTS === '1'

const results = []
const consoleErrors = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, init)
  return response.status === 204 ? null : response.json()
}
function find(node, predicate, out = []) {
  if (predicate(node)) out.push(node)
  for (const child of node.content ?? []) find(child, predicate, out)
  return out
}
const marksOf = node => find(node, n => n.type === 'text').flatMap(n => n.marks ?? [])

const PNG_A = readFileSync(new URL('./fixtures/welcome.png', import.meta.url)).toString('base64')
const PNG_B = readFileSync(new URL('./fixtures/showcase.png', import.meta.url)).toString('base64')

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } })
await signIn(BASE, context)
const page = await context.newPage()
page.on('console', message => message.type() === 'error' && consoleErrors.push(message.text()))
page.on('pageerror', error => consoleErrors.push(String(error)))
page.on('dialog', dialog => dialog.accept())

const settle = () => page.waitForTimeout(60)
// ProseMirror reads native selection moves from the async selectionchange event; pause after them.
const press = async key => {
  await page.keyboard.press(key)
  await settle()
}
const editor = page.locator('.document')
const status = page.locator('.save-status')
const waitSaved = () => status.filter({ hasText: 'All changes saved' }).waitFor({ timeout: 10_000 })
const tool = toolFor(page)
const notice = text => page.locator('.notice', { hasText: text })
const noteId = () => page.url().split('/').pop()
const saved = async () => (await api(`/api/notes/${noteId()}`)).content

async function newNote(title) {
  await page.getByRole('button', { name: /New note/ }).click()
  await page.waitForURL(/\/notes\/[0-9a-f-]{36}$/)
  await page.locator('.note-title:focus').waitFor()
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  await settle()
}

// Puts the cursor in the trailing empty paragraph (Ctrl+End can stay inside a table cell).
async function goToEnd() {
  const last = editor.locator(':scope > p').last()
  await last.scrollIntoViewIfNeeded()
  await last.click()
  await page.keyboard.press('End')
  await settle()
}

async function selectAllInEditor() {
  await editor.click()
  await page.keyboard.press('Control+a')
  await settle()
}

async function dispatchFiles(kind, files, { html = '', x = 0, y = 0 } = {}) {
  await page.evaluate(
    ({ kind, files, html, x, y }) => {
      const transfer = new DataTransfer()
      for (const file of files) {
        const bytes = Uint8Array.from(atob(file.b64), c => c.charCodeAt(0))
        transfer.items.add(new File([bytes], file.name, { type: file.type }))
      }
      if (html) transfer.setData('text/html', html)
      const target = kind === 'paste' ? document.querySelector('.ProseMirror') : document.elementFromPoint(x, y)
      const init = { bubbles: true, cancelable: true }
      const event =
        kind === 'paste'
          ? new ClipboardEvent('paste', { ...init, clipboardData: transfer })
          : new DragEvent('drop', { ...init, dataTransfer: transfer, clientX: x, clientY: y })
      target.dispatchEvent(event)
    },
    { kind, files, html, x, y },
  )
}

try {
  for (const note of await api('/api/notes')) await api(`/api/notes/${note.id}`, { method: 'DELETE' })
  await api('/api/fonts/favorites', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"families":[]}' })
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Create your first note' }).click()
  await page.waitForURL(/\/notes\/[0-9a-f-]{36}$/)
  await page.locator('.note-title:focus').waitFor()
  await page.keyboard.type('Phase 2 test')
  await page.keyboard.press('Enter')
  await settle()

  // ---- headings 1–6 ----
  await page.keyboard.type('#### Markdown four')
  await page.keyboard.press('Enter')
  check('Markdown #### makes a heading 4', (await editor.locator('h4', { hasText: 'Markdown four' }).count()) === 1)
  for (const level of [5, 6]) {
    await page.keyboard.type(`Level ${level}`)
    await page.getByRole('combobox', { name: 'Paragraph type' }).selectOption(`h${level}`)
    await editor.locator(`h${level}`, { hasText: `Level ${level}` }).waitFor({ timeout: 2000 })
    await press('End')
    await press('Enter')
    await settle()
  }
  check('style menu offers headings 4–6', (await editor.locator('h5').count()) === 1 && (await editor.locator('h6').count()) === 1)
  const options = await page.getByRole('combobox', { name: 'Paragraph type' }).locator('option').allTextContents()
  check('style menu lists Heading 1 to Heading 6', ['1', '2', '3', '4', '5', '6'].every(n => options.includes(`Heading ${n}`)))

  // ---- highlights ----
  await page.getByRole('combobox', { name: 'Paragraph type' }).selectOption('paragraph')
  await page.keyboard.type('Highlight me')
  await page.keyboard.down('Shift')
  for (let i = 0; i < 'Highlight me'.length; i += 1) await page.keyboard.press('ArrowLeft')
  await page.keyboard.up('Shift')
  await settle()
  await tool('Highlight color').click()
  const highlightSwatches = await page.locator('.color-popover .swatch').count()
  check('highlight menu has 12 swatches', highlightSwatches === 12, `count=${highlightSwatches}`)
  await page.locator('.color-popover .swatch[aria-label="Brown"]').click()
  await tool('Text color').click()
  check('text color menu still has 12 swatches', (await page.locator('.color-popover .swatch').count()) === 12)
  await press('Escape')
  await waitSaved()
  check('brown highlight saved', marksOf(await saved()).some(m => m.type === 'highlight' && m.attrs.color === '#e6d5cc'))

  // ---- font size ----
  await press('End')
  await press('Enter')
  await page.keyboard.type('Sized text')
  await page.keyboard.down('Shift')
  for (let i = 0; i < 'Sized text'.length; i += 1) await page.keyboard.press('ArrowLeft')
  await page.keyboard.up('Shift')
  await settle()
  const sizeBox = page.getByRole('textbox', { name: 'Font size' })
  check('size box shows the paragraph default 11', (await sizeBox.inputValue()) === '11')
  await tool('Increase font size').click()
  await waitSaved()
  check('+ sets 12pt', marksOf(await saved()).some(m => m.type === 'textStyle' && m.attrs.fontSize === '12pt'))
  check('size box follows the mark', (await sizeBox.inputValue()) === '12')
  await sizeBox.click()
  await page.locator('.size-option', { hasText: /^24$/ }).click()
  await waitSaved()
  check('preset 24 sets 24pt', marksOf(await saved()).some(m => m.type === 'textStyle' && m.attrs.fontSize === '24pt'))
  await page.keyboard.press('Control+Shift+Comma')
  await waitSaved()
  check('Ctrl+Shift+, steps down to 23pt', marksOf(await saved()).some(m => m.type === 'textStyle' && m.attrs.fontSize === '23pt'))

  // ---- tables ----
  await press('End')
  await press('Enter')
  await tool('Insert table').click()
  await page.locator('.table-grid-cell[aria-label="3 by 3 table"]').hover()
  check('grid shows the size', (await page.locator('.table-grid-label').textContent())?.trim() === '3 × 3')
  await page.locator('.table-grid-cell[aria-label="3 by 3 table"]').click()
  await editor.locator('table').waitFor()
  check('insert a 3×3 table', (await editor.locator('table tr').count()) === 3 && (await editor.locator('table td').count()) === 9)
  await page.keyboard.type('A1')
  await page.keyboard.press('Tab')
  await page.keyboard.type('B1')
  for (let i = 0; i < 7; i += 1) await page.keyboard.press('Tab')
  await page.keyboard.press('Tab') // last cell: adds a row
  await settle()
  check('Tab in the last cell adds a row', (await editor.locator('table tr').count()) === 4)

  await editor.locator('td', { hasText: 'A1' }).click()
  await tool('Table options').click()
  await page.getByRole('menuitem', { name: 'Insert column right' }).click()
  check('insert column', (await editor.locator('table tr').first().locator('td').count()) === 4)
  await tool('Table options').click()
  await page.getByRole('menuitem', { name: 'Header row' }).click()
  check('toggle header row', (await editor.locator('table th').count()) === 4)

  // Merge A1 and the next cell by dragging across them, then split again.
  const firstRow = editor.locator('table tr').first()
  const c1 = await firstRow.locator('th').nth(0).boundingBox()
  const c2 = await firstRow.locator('th').nth(1).boundingBox()
  await page.mouse.move(c1.x + 10, c1.y + c1.height / 2)
  await page.mouse.down()
  await page.mouse.move(c2.x + c2.width / 2, c2.y + c2.height / 2, { steps: 5 })
  await page.mouse.up()
  await tool('Table options').click()
  await page.getByRole('menuitem', { name: 'Merge cells' }).click()
  await settle()
  check('merge cells', (await firstRow.locator('th[colspan="2"]').count()) === 1)
  await tool('Table options').click()
  await page.getByRole('menuitem', { name: 'Split cell' }).click()
  check('split cell', (await firstRow.locator('th').count()) === 4)

  // Resize the first column by dragging its right border.
  const border = await firstRow.locator('th').nth(0).boundingBox()
  await page.mouse.move(border.x + border.width - 2, border.y + border.height / 2)
  await settle()
  await page.mouse.down()
  await page.mouse.move(border.x + border.width + 80, border.y + border.height / 2, { steps: 6 })
  await page.mouse.up()
  await waitSaved()
  const cells = find(await saved(), n => n.type === 'tableHeader')
  check('column resize is saved', Array.isArray(cells[0]?.attrs?.colwidth) && cells[0].attrs.colwidth[0] > border.width, JSON.stringify(cells[0]?.attrs))

  // Spreadsheet paste: HTML table + PNG snapshot becomes a table, not a picture.
  await editor.locator('td').last().click()
  await page.keyboard.press('Control+End')
  await settle()
  const tablesBefore = await editor.locator('table').count()
  const imagesBefore = await editor.locator('img').count()
  await dispatchFiles('paste', [{ name: 'image.png', type: 'image/png', b64: PNG_B }], {
    html: '<table><tr><td>Fruit</td><td>Price</td></tr><tr><td>Apple</td><td>1</td></tr></table>',
  })
  await page.waitForTimeout(400)
  check(
    'spreadsheet paste makes a table, not an image',
    (await editor.locator('table').count()) === tablesBefore + 1 && (await editor.locator('img').count()) === imagesBefore,
  )

  // ---- images ----
  await goToEnd()
  await dispatchFiles('paste', [{ name: 'welcome.png', type: 'image/png', b64: PNG_A }])
  await editor.locator('img[src^="/api/images/"]').first().waitFor({ timeout: 5000 })
  await waitSaved()
  let images = find(await saved(), n => n.type === 'image')
  check('pasted image is uploaded and saved by link', images.length === 1 && /^\/api\/images\/[0-9a-f]{64}\.png$/.test(images[0].attrs.src))
  check('new image starts at page width', images[0]?.attrs.width === 622, `width=${images[0]?.attrs.width}`)
  await page.keyboard.type('Caption after image')
  await waitSaved()
  const afterPaste = (await saved()).content
  const imageIndex = afterPaste.findIndex(n => n.type === 'image')
  check(
    'typing after a pasted image goes below it instead of replacing it',
    imageIndex >= 0 && afterPaste[imageIndex + 1]?.content?.[0]?.text === 'Caption after image',
  )

  // Resize with the bottom-right handle (centered in the viewport so the handle is reachable).
  const img = editor.locator('img').first()
  await img.evaluate(el => el.scrollIntoView({ block: 'center' }))
  await img.hover()
  const handle = page.locator('[data-resize-handle="bottom-right"]').first()
  const handleBox = await handle.boundingBox()
  check('resize handles are visible on hover', handleBox && handleBox.width >= 10 && (await handle.evaluate(el => getComputedStyle(el).opacity)) === '1')
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox.x - 250, handleBox.y - 100, { steps: 8 })
  await page.mouse.up()
  await waitSaved()
  images = find(await saved(), n => n.type === 'image')
  const resizedWidth = images[0].attrs.width
  check('resizing saves a smaller width', resizedWidth < 622 && resizedWidth > 300, `width=${resizedWidth}`)
  const displayed = await img.evaluate(el => Math.round(el.getBoundingClientRect().width))
  check('displayed width matches the saved width', Math.abs(displayed - resizedWidth) <= 2, `displayed=${displayed}`)

  await page.keyboard.press('Control+z')
  await page.waitForTimeout(200)
  const afterUndo = await img.evaluate(el => Math.round(el.getBoundingClientRect().width))
  check('undo restores the displayed size', Math.abs(afterUndo - 622) <= 2, `displayed=${afterUndo}`)
  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(200)

  // Align the selected image.
  await img.click()
  await settle()
  await tool('Align center').click()
  await waitSaved()
  images = find(await saved(), n => n.type === 'image')
  const container = await page.locator('[data-resize-container][data-node="image"]').first().evaluate(el => getComputedStyle(el).justifyContent)
  check('align center applies to the selected image', images[0].attrs.align === 'center' && container === 'center', `${images[0].attrs.align} ${container}`)
  check('justify is disabled for images', await tool('Justify').isDisabled())

  // Upload button and drop.
  await goToEnd()
  await page.locator('input[type=file]').setInputFiles([
    { name: 'showcase.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B, 'base64') },
  ])
  await page.waitForFunction(() => document.querySelectorAll('.document img').length === 2, null, { timeout: 5000 })
  check('upload button inserts an image', true)
  await page.waitForFunction(() => [...document.querySelectorAll('.document img')].every(img => img.complete))
  const dropTarget = editor.locator(':scope > p').last()
  // Images finishing layout can still move the page: scroll until the target sits still in view.
  let box = null
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await dropTarget.evaluate(el => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(200)
    const next = await dropTarget.boundingBox()
    const centre = next.y + next.height / 2
    const stable = box && Math.abs(box.y - next.y) < 1
    box = next
    if (stable && centre > 0 && centre < page.viewportSize().height) break
  }
  await dispatchFiles('drop', [{ name: 'dropped.png', type: 'image/png', b64: PNG_A }], { x: box.x + 5, y: box.y + box.height / 2 })
  await page.waitForFunction(() => document.querySelectorAll('.document img').length === 3, null, { timeout: 5000 })
  check('dropped image is inserted', true)

  // Several files at once keep their order.
  await goToEnd()
  await dispatchFiles('paste', [
    { name: 'one.png', type: 'image/png', b64: PNG_A },
    { name: 'two.png', type: 'image/png', b64: PNG_B },
  ])
  await page.waitForFunction(() => document.querySelectorAll('.document img').length === 5, null, { timeout: 5000 }).then(
    () => check('pasting two files inserts both', true),
    async () => check('pasting two files inserts both', false, `count=${await editor.locator('img').count()}`),
  )
  const srcs = await editor.locator('img').evaluateAll(list => list.slice(-2).map(el => el.getAttribute('src')))
  const firstSrc = await editor.locator('img').nth(0).getAttribute('src')
  check('multi-file paste keeps file order', srcs[0] === firstSrc && srcs[1] !== firstSrc, JSON.stringify(srcs))
  await waitSaved()

  // Several files into an empty bullet keep their order too.
  await goToEnd()
  await page.keyboard.type('- ')
  await settle()
  const before = await editor.locator('img').count()
  await dispatchFiles('paste', [
    { name: 'one.png', type: 'image/png', b64: PNG_A },
    { name: 'two.png', type: 'image/png', b64: PNG_B },
  ])
  await page.waitForFunction(n => document.querySelectorAll('.document img').length === n + 2, before, { timeout: 5000 })
  const inList = await editor.locator('ul:not([data-type]) li img').evaluateAll(list => list.map(el => el.getAttribute('src')))
  const firstImageSrc = await editor.locator('img').nth(0).getAttribute('src')
  check('two images in an empty bullet keep file order', inList.length === 2 && inList[0] === firstImageSrc && inList[1] !== firstImageSrc, JSON.stringify(inList))
  await waitSaved()

  // Rejected files and web images get a notice.
  await dispatchFiles('paste', [{ name: 'drawing.svg', type: 'image/svg+xml', b64: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') }])
  await notice('Skipped drawing.svg').waitFor({ timeout: 3000 })
  check('SVG paste shows a notice', true)
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/html', '<p>From the web</p><img src="https://example.com/cat.png">')
    transfer.setData('text/plain', 'From the web')
    document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
  })
  await notice("An image from the web wasn't pasted").waitFor({ timeout: 3000 })
  check('web images in pasted HTML are left out with a notice', (await editor.locator('img[src^="https://"]').count()) === 0)

  // ---- collapsible sections ----
  await goToEnd()
  await page.keyboard.type('Hidden body text')
  await tool('Collapsible section').click()
  await editor.locator('.details').waitFor()
  check('collapsible section wraps the paragraph', (await editor.locator('[data-type="detailsContent"]', { hasText: 'Hidden body text' }).count()) === 1)
  await page.waitForTimeout(100)
  check('a new section starts open', (await editor.locator('.details.is-open').count()) === 1 && !(await editor.locator('[data-type="detailsContent"]').evaluate(el => el.hidden)))
  const placeholder = await editor.locator('.details summary').evaluate(el => getComputedStyle(el, '::before').content)
  check('empty section title shows a placeholder', placeholder.includes('Section title'), placeholder)
  await editor.locator('.details summary').click()
  await page.keyboard.type('Section heading')
  await editor.locator('.details > button').click()
  await settle()
  const hiddenNow = await editor.locator('[data-type="detailsContent"]').evaluate(el => el.hidden)
  check('toggle collapses the section', hiddenNow)
  await waitSaved()
  const details = find(await saved(), n => n.type === 'details')[0]
  check('section state is saved', details && details.attrs.open === false)
  await editor.locator('.details > button').click()
  await waitSaved()
  check('opening is saved too', find(await saved(), n => n.type === 'details')[0]?.attrs.open === true)

  // An image pasted into a section title goes after the section instead of splitting it.
  await editor.locator('.details summary').click()
  await press('End')
  await dispatchFiles('paste', [{ name: 'title.png', type: 'image/png', b64: PNG_B }])
  await page.waitForFunction(() => document.querySelectorAll('.document img').length === 8, null, { timeout: 5000 })
  await waitSaved()
  const top = (await saved()).content.map(n => n.type)
  const detailsAt = top.indexOf('details')
  check(
    'image pasted in a section title lands after the section',
    top.filter(type => type === 'details').length === 1 && top[detailsAt + 1] === 'image',
    top.join(','),
  )

  // ---- reload keeps everything ----
  const outline = doc => (doc.content ?? []).map(n => n.type + (n.type === 'paragraph' || n.type.startsWith('heading') ? `(${find(n, x => x.type === 'text').map(t => t.text).join('')})` : '')).join(' | ')
  console.log('before reload (dom)', JSON.stringify(await editor.evaluate(el => [...el.children].map(c => c.tagName + ':' + (c.textContent ?? '').slice(0, 20)))))
  console.log('before reload (saved)', outline(await saved()))
  await page.reload()
  await editor.locator('table').first().waitFor()
  await page.waitForTimeout(300)
  const counts = { tables: await editor.locator('table').count(), images: await editor.locator('img').count(), open: await editor.locator('.details.is-open').count(), h6: await editor.locator('h6').count(), highlight: await editor.locator('p', { hasText: 'Highlight me' }).count() }
  console.log('after reload', JSON.stringify(counts))
  console.log('after reload (saved)', outline(await saved()))
  await page.screenshot({ path: `${SHOTS}/phase2-reload.png` })
  check(
    'reload keeps tables, images, sections and headings',
    (await editor.locator('table').count()) === 2 &&
      (await editor.locator('img').count()) === 8 &&
      (await editor.locator('.details.is-open').count()) === 1 &&
      (await editor.locator('h6').count()) === 1,
  )

  // ---- fonts ----
  await editor.locator('p', { hasText: 'Highlight me' }).click()
  await page.keyboard.press('Home')
  await page.keyboard.down('Shift')
  await page.keyboard.press('End')
  await page.keyboard.up('Shift')
  await settle()
  await tool('Font').click()
  await page.locator('.font-popover').waitFor()
  await page.locator('.font-row').first().waitFor({ timeout: 5000 })
  check('font picker lists the catalog', (await page.locator('.font-heading', { hasText: 'All fonts' }).count()) === 1)
  await page.getByRole('combobox', { name: 'Search fonts' }).fill('Lora')
  await page.locator('.font-row', { hasText: /^Lora$/ }).first().waitFor()
  check('search narrows the list', (await page.locator('.font-heading', { hasText: 'Matching fonts' }).count()) === 1)
  await page.getByRole('button', { name: 'Serif', exact: true }).click()
  check('category filter keeps Lora', (await page.locator('.font-row', { hasText: /^Lora$/ }).count()) >= 1)
  await page.locator('.font-row', { hasText: /^Lora$/ }).first().click()
  await waitSaved()
  check('picking Lora saves the font family', marksOf(await saved()).some(m => m.type === 'textStyle' && m.attrs.fontFamily === '"Lora", serif'))
  check('font button shows the current font', (await tool('Font').textContent())?.includes('Lora'))

  // Favorites follow you after a reload.
  await tool('Font').click()
  await page.getByRole('combobox', { name: 'Search fonts' }).fill('Lora')
  await page.locator('.font-row', { hasText: /^Lora$/ }).first().hover()
  await page.getByRole('button', { name: 'Add Lora to favorites' }).first().click()
  await page.waitForTimeout(300)
  check('star saves a favorite', (await api('/api/fonts/favorites')).families.includes('Lora'))
  await page.keyboard.press('Escape')
  await page.reload()
  await editor.waitFor()
  await editor.locator('p').first().click()
  await tool('Font').click()
  await page.locator('.font-heading', { hasText: 'Favorites' }).waitFor({ timeout: 5000 })
  check('favorites appear at the top after reload', (await page.locator('.font-row').nth(1).textContent())?.includes('Lora'))
  await page.keyboard.press('Escape')

  if (NETWORK_FONTS) {
    // Previews of one-word families (no space in the preview subset) load and stay loaded.
    await tool('Font').click()
    await page.locator('.font-row', { hasText: /^Inter$/ }).first().waitFor()
    const previewLoaded = await page
      .waitForFunction(() => document.fonts.check('15px "Inter Preview"', 'Inter'), null, { timeout: 10_000 })
      .then(() => true, () => false)
    check('font previews load for one-word family names', previewLoaded)
    await page.keyboard.press('Escape')
    const refocused = await page
      .waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'), null, { timeout: 2000 })
      .then(() => true, () => false)
    check('Escape returns focus to the document', refocused)

    // Real Google download through the server cache.
    const loaded = await page.waitForFunction(() => document.fonts.check('16px "Lora"'), null, { timeout: 15_000 }).then(() => true, () => false)
    check('Lora loads through the server cache', loaded)
    const css = await fetch(`${BASE}/api/fonts/css?family=Lora`)
    check('font CSS is served as text/css from Margin', css.headers.get('content-type')?.startsWith('text/css') && !(await css.text()).includes('gstatic'))
    await fetch(`${BASE}/api/fonts/css?family=Molle`).then(r => check('Molle (italic only) loads', r.status === 200, `status=${r.status}`))
  }

  // ---- upload cancelled by leaving the note ----
  await newNote('Second note')
  await page.route('**/api/images', async route => {
    await new Promise(resolve => setTimeout(resolve, 2500))
    await route.continue().catch(() => undefined)
  })
  await dispatchFiles('paste', [{ name: 'slow.png', type: 'image/png', b64: PNG_B }])
  await page.locator('.save-status', { hasText: 'Uploading image' }).waitFor({ timeout: 2000 })
  check('pending upload shows in the save indicator', true)
  await page.locator('.note-item', { hasText: 'Phase 2 test' }).click()
  await notice('Image upload cancelled').waitFor({ timeout: 3000 })
  check('leaving the note cancels its upload with a notice', true)
  await page.unroute('**/api/images')

  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300))
} catch (error) {
  check('script completed', false, String(error).slice(0, 400))
  await page.screenshot({ path: `${SHOTS}/phase2-failure.png` })
} finally {
  await page.screenshot({ path: `${SHOTS}/phase2-final.png` })
  await browser.close()
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
