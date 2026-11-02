// Phase 4 moved some toolbar buttons into dropdowns. This finds a control by its old button name,
// opening its menu first when needed, so the older suites keep reading naturally.
const MENUS = {
  Strikethrough: 'More text formatting',
  'Inline code': 'More text formatting',
  'Align left': 'Alignment',
  'Align center': 'Alignment',
  'Align right': 'Alignment',
  Justify: 'Alignment',
  'Bulleted list': 'Lists',
  'Numbered list': 'Lists',
  Checklist: 'Lists',
  Quote: 'Insert',
  'Code block': 'Insert',
  'Horizontal line': 'Insert',
  'Collapsible section': 'Insert',
  'Remove collapsible section': 'Insert',
  'Insert table': 'Insert',
  'Insert image': 'Insert',
}
const ITEM_LABEL = { 'Insert table': 'Table', 'Insert image': 'Image…', 'Remove collapsible section': 'Collapsible section' }

export function toolFor(page) {
  return label => {
    const menu = MENUS[label]
    if (!menu) return page.locator('.toolbar').getByRole('button', { name: label, exact: true })
    const text = ITEM_LABEL[label] ?? label
    const item = () =>
      page.locator('.popover .menu-item').filter({ has: page.locator('.menu-item-label', { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
    const open = async () => {
      if (!(await item().count())) await page.getByRole('button', { name: menu, exact: true }).click()
      await item().first().waitFor()
    }
    return {
      async click() {
        await open()
        await item().first().click()
      },
      async getAttribute(name) {
        await open()
        const value = await item().first().getAttribute(name === 'aria-pressed' ? 'aria-checked' : name)
        await page.keyboard.press('Escape')
        return value
      },
      async isDisabled() {
        // A disabled dropdown means every item in it is unavailable.
        if (await page.getByRole('button', { name: menu, exact: true }).isDisabled()) return true
        await open()
        const disabled = await item().first().isDisabled()
        await page.keyboard.press('Escape')
        return disabled
      },
    }
  }
}
