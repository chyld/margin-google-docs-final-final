// Margin's image node: Tiptap's resizable image, locked to images stored by this server.
import { Image } from '@tiptap/extension-image'
import type { Node as PMNode } from '@tiptap/pm/model'
import { IMAGE_SRC } from './imageRules.ts'

export const IMAGE_ALIGNMENTS = ['left', 'center', 'right'] as const
export type ImageAlign = (typeof IMAGE_ALIGNMENTS)[number]

/** The default width for new images (the old 8.5-inch page's text column). The page is full width
 *  now; images are still capped at the page width by CSS. */
export const PAGE_CONTENT_WIDTH = 622

/**
 * Returns the canonical relative src for a Margin image, or null for anything else. Same-origin
 * absolute URLs (as browsers write them into copied HTML) are normalized to the relative path.
 */
export function normalizeImageSrc(src: string | null | undefined, origin?: string): string | null {
  if (!src) return null
  if (IMAGE_SRC.test(src)) return src
  const base = origin ?? (globalThis as { location?: { origin: string } }).location?.origin
  if (!base) return null
  try {
    const url = new URL(src, base)
    if (url.origin !== base || url.search || url.hash) return null
    return IMAGE_SRC.test(url.pathname) ? url.pathname : null
  } catch {
    return null
  }
}

// Structural DOM types, so this file also type-checks in the server's DOM-less config. Node views
// only ever run in the browser.
type ElementLike = { getAttribute(name: string): string | null; style?: { width?: string; height?: string } }
type StyledElement = { style: { width: string; height: string } }
type EventTargetLike = {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  dispatchEvent(event: unknown): boolean
}
const browserDocument = () => (globalThis as unknown as { document: EventTargetLike }).document
const browserMouseEvent = () => (globalThis as unknown as { MouseEvent: new (type: string) => unknown }).MouseEvent

// Reads a pixel size from the element's style (what the resizable view writes) or its attribute.
function readDimension(element: ElementLike, name: 'width' | 'height'): number | null {
  for (const raw of [element.style?.[name], element.getAttribute(name)]) {
    if (!raw) continue
    const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/.exec(raw)
    if (!match) continue
    const value = Math.round(Number(match[1]))
    if (value > 0 && value <= 10_000) return value
  }
  return null
}

function applySize(img: StyledElement, node: PMNode) {
  const { width, height } = node.attrs as { width: number | null; height: number | null }
  img.style.width = width ? `${width}px` : ''
  img.style.height = height ? `${height}px` : ''
}

export const MarginImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: element => normalizeImageSrc(element.getAttribute('src')),
      },
      width: { default: null, parseHTML: element => readDimension(element, 'width') },
      height: { default: null, parseHTML: element => readDimension(element, 'height') },
      align: {
        default: null,
        parseHTML: element => {
          const value = element.getAttribute('data-align')
          return (IMAGE_ALIGNMENTS as readonly string[]).includes(value ?? '') ? value : null
        },
        renderHTML: attributes => (attributes.align ? { 'data-align': attributes.align } : {}),
      },
    }
  },

  // Pasted HTML keeps only images stored by Margin. Remote images would be blocked by the CSP and
  // inline data: images would bloat notes; the editor reports how many were skipped.
  parseHTML() {
    return [{ tag: 'img[src]', getAttrs: element => (normalizeImageSrc(element.getAttribute('src')) ? null : false) }]
  },

  // The inherited ![alt](url) rule would accept any URL.
  addInputRules() {
    return []
  },

  addNodeView() {
    const createView = this.parent?.()
    if (!createView) return null

    return props => {
      const { editor } = props
      // Tiptap 3.32's ResizableNodeView subscribes with `fn.bind(this)` and unsubscribes with a
      // second, different bound function, so the listener outlives the view. Capture the real one.
      let updateListener: ((...args: never[]) => void) | undefined
      const hadOwnOn = Object.prototype.hasOwnProperty.call(editor, 'on')
      const originalOn = editor.on
      editor.on = function (this: typeof editor, event: string, listener: (...args: never[]) => void) {
        if (event === 'update' && !updateListener) updateListener = listener
        return originalOn.call(this, event as never, listener as never)
      } as typeof editor.on
      let view: ReturnType<typeof createView>
      try {
        view = createView(props)
      } finally {
        if (hadOwnOn) editor.on = originalOn
        else delete (editor as { on?: unknown }).on
      }

      const nodeView = view as {
        dom: {
          querySelector(selector: string): StyledElement | null
          addEventListener(type: string, listener: (event: Event) => void, options?: { passive: boolean }): void
          removeEventListener(type: string, listener: (event: Event) => void): void
        }
        update?: (node: PMNode, ...rest: never[]) => boolean
        destroy?: () => void
      }
      const img = nodeView.dom.querySelector('img')

      // Undo/redo of a resize changes the node's width/height, but the base view only applies them
      // on creation. Re-apply after every accepted update.
      const baseUpdate = nodeView.update?.bind(nodeView)
      nodeView.update = (node, ...rest) => {
        const accepted = baseUpdate ? baseUpdate(node, ...rest) : false
        if (accepted && img) applySize(img, node)
        return accepted
      }

      // Its touch support never commits: there's a touchmove handler but no touchend. When a touch
      // that started on a handle ends, finish the resize the way a mouse release would.
      const page = browserDocument()
      const finishTouch = () => {
        stopWatchingTouch()
        page.dispatchEvent(new (browserMouseEvent())('mouseup'))
      }
      const stopWatchingTouch = () => {
        page.removeEventListener('touchend', finishTouch)
        page.removeEventListener('touchcancel', finishTouch)
      }
      const onTouchStart = (event: Event) => {
        if (!(event.target as { closest?: (selector: string) => unknown } | null)?.closest?.('[data-resize-handle]')) return
        page.addEventListener('touchend', finishTouch)
        page.addEventListener('touchcancel', finishTouch)
      }
      nodeView.dom.addEventListener('touchstart', onTouchStart, { passive: true })

      const baseDestroy = nodeView.destroy?.bind(nodeView)
      nodeView.destroy = () => {
        baseDestroy?.()
        nodeView.dom.removeEventListener('touchstart', onTouchStart)
        stopWatchingTouch()
        if (updateListener) editor.off('update', updateListener as never)
      }

      return view
    }
  },
})
