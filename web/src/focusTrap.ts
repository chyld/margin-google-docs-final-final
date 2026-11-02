import type { KeyboardEvent } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keeps Tab inside `container` (modal dialogs, the phone drawer, the Format sheet): Tab on the last
 * visible control goes to the first, Shift+Tab on the first goes to the last. With
 * `recaptureOutside`, Tab also pulls focus back in when it has escaped the container.
 */
export function trapTab(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null, { recaptureOutside = false } = {}): void {
  if (event.key !== 'Tab' || !container) return
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(item => item.offsetParent !== null)
  const first = items[0]
  const last = items[items.length - 1]
  if (!first || !last) return
  const outside = recaptureOutside && !container.contains(document.activeElement)
  if (event.shiftKey && (document.activeElement === first || outside)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || outside)) {
    event.preventDefault()
    first.focus()
  }
}
