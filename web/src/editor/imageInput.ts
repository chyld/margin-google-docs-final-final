// Pasting, dropping and uploading images into the editor.
//
// While a file uploads, a placeholder widget marks where it will go. The document itself is not
// touched until the upload succeeds, so nothing temporary is ever autosaved. The placeholder is a
// decoration, so it moves with edits; if the user deletes the text around it, the image is dropped.
import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { normalizeImageSrc, PAGE_CONTENT_WIDTH } from '../../../shared/image.ts'
import { IMAGE_TYPES, isImageType, MAX_IMAGE_BYTES } from '../../../shared/imageRules.ts'
import { api, ApiError, StaleSessionError } from '../api.ts'
import { showNotice } from '../state/notices.ts'
import { waitForReauth } from '../state/session.ts'

export const IMAGE_ACCEPT = Object.keys(IMAGE_TYPES).join(',')

type PlaceholderMeta = { add?: Array<{ id: string; pos: number; side: number }>; remove?: string[] }
type FileLike = { name: string; type: string; size: number }

const uploadsKey = new PluginKey<DecorationSet>('imageUploads')
const uploadsByEditor = new WeakMap<Editor, Map<string, AbortController>>()
let uploadSequence = 0

// ---- pending uploads count as unsaved work (save indicator, unload prompt) ----

let pendingCount = 0
const pendingListeners = new Set<() => void>()

function changePending(delta: number) {
  pendingCount = Math.max(0, pendingCount + delta)
  for (const listener of pendingListeners) listener()
}

export function pendingImageUploads(): number {
  return pendingCount
}

export function subscribePendingUploads(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

// ---- decisions, kept pure for tests ----

/** Splits files into ones Margin can store and ones it has to skip. */
export function partitionImageFiles<T extends FileLike>(files: T[]): { accepted: T[]; rejected: T[] } {
  const accepted: T[] = []
  const rejected: T[] = []
  for (const file of files) {
    ;(isImageType(file.type) && file.size > 0 && file.size <= MAX_IMAGE_BYTES ? accepted : rejected).push(file)
  }
  return { accepted, rejected }
}

/**
 * Whether a paste carrying files should become image uploads. Spreadsheets and word processors put
 * a picture of the selection on the clipboard next to the real content; that content wins.
 */
export function shouldPasteAsFiles(fileCount: number, html: string): boolean {
  if (fileCount === 0) return false
  if (!html.trim()) return true
  if (/<table[\s>]/i.test(html)) return false
  const text = html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .trim()
  // Only an <img> (e.g. "Copy image" in a browser): upload the file instead.
  return text.length === 0
}

/** How many images in pasted HTML Margin will leave out (anything not stored by Margin). */
export function countForeignImages(html: string, origin: string): number {
  let count = 0
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi)) {
    const src = (match[2] ?? '').replace(/&amp;/g, '&')
    if (!normalizeImageSrc(src, origin)) count += 1
  }
  return count
}

function describeFiles(files: FileLike[]): string {
  const names = files.map(file => file.name || 'an image')
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

// ---- placeholders ----

function placeholderElement(): HTMLElement {
  const element = document.createElement('span')
  element.className = 'image-upload-placeholder'
  element.contentEditable = 'false'
  element.textContent = 'Uploading image…'
  return element
}

function findPlaceholder(state: EditorState, id: string): number | null {
  const found = uploadsKey.getState(state)?.find(undefined, undefined, spec => spec.id === id)
  return found?.[0]?.from ?? null
}

function removePlaceholders(editor: Editor, ids: string[]) {
  if (editor.isDestroyed) return
  const tr = editor.state.tr.setMeta(uploadsKey, { remove: ids } satisfies PlaceholderMeta).setMeta('addToHistory', false)
  editor.view.dispatch(tr)
}

async function displaySize(file: Blob): Promise<{ width: number | null; height: number | null }> {
  try {
    const bitmap = await createImageBitmap(file)
    const { width, height } = bitmap
    bitmap.close()
    const shown = Math.min(width, PAGE_CONTENT_WIDTH)
    return { width: Math.round(shown), height: Math.round((height * shown) / width) }
  } catch {
    return { width: null, height: null }
  }
}

// Moves past images that already sit at `pos`, so a batch inserted at one spot keeps file order.
function skipImages(doc: EditorState['doc'], pos: number): number {
  let at = pos
  for (let node = doc.resolve(at).nodeAfter; node?.type.name === 'image'; node = doc.resolve(at).nodeAfter) {
    at += node.nodeSize
  }
  return at
}

function insertImage(editor: Editor, pos: number, id: string, attrs: Record<string, unknown>) {
  const { doc } = editor.state
  const $pos = doc.resolve(pos)
  let at = pos
  if ($pos.parent.type.name === 'detailsSummary') {
    // A section title can't hold an image, and splitting there would split the section in two.
    at = skipImages(doc, $pos.after($pos.depth - 1))
  } else if ($pos.depth > 0 && $pos.parent.isTextblock && $pos.parent.content.size === 0) {
    // On an empty line the image goes above it, so the line (and a cursor in it) ends up below the
    // image, and other placeholders on that line survive for the next images of the batch. List and
    // task items must start with a paragraph, so there it goes below the item's first line instead.
    const item = $pos.depth > 1 ? $pos.node($pos.depth - 1) : null
    const firstLineOfItem = item && /^(listItem|taskItem)$/.test(item.type.name) && $pos.index($pos.depth - 1) === 0
    at = firstLineOfItem ? skipImages(doc, $pos.after()) : $pos.before()
  }
  const inserted = editor
    .chain()
    .command(({ tr }) => {
      tr.setMeta(uploadsKey, { remove: [id] } satisfies PlaceholderMeta)
      return true
    })
    // Leave the selection where the user has it. Tiptap would otherwise select the new image, and
    // the next keystroke or paste would replace it.
    .insertContentAt(at, { type: 'image', attrs }, { updateSelection: false })
    .run()
  if (!inserted) {
    removePlaceholders(editor, [id])
    showNotice("Couldn't place the image there. Try putting the cursor on an empty line.")
  }
}

/** Uploads a file; if the session ended meanwhile, waits for the user to sign in again and retries once. */
async function uploadKeepingThroughSignIn(file: File, signal: AbortSignal): Promise<{ src: string }> {
  try {
    return await api.uploadImage(file, signal)
  } catch (error) {
    // Sent with the session a sign-in just replaced: send it again right away.
    if (error instanceof StaleSessionError) return api.uploadImage(file, signal)
    if (!(error instanceof ApiError) || !error.isAuthFailure) throw error
    await waitForReauth(signal)
    return api.uploadImage(file, signal)
  }
}

/** Uploads image files and inserts them at `pos` (default: the cursor), in order. */
export function uploadImages(editor: Editor, files: File[], pos?: number): void {
  const { accepted, rejected } = partitionImageFiles(files)
  if (rejected.length > 0) {
    showNotice(`Skipped ${describeFiles(rejected)}: images must be PNG, JPEG, GIF or WebP, up to 10 MB.`)
  }
  if (accepted.length === 0 || editor.isDestroyed) return
  if (!editor.isEditable) {
    showNotice("This note is read-only, so images can't be added.")
    return
  }

  const at = Math.max(0, Math.min(pos ?? editor.state.selection.to, editor.state.doc.content.size))
  const items = accepted.map(file => {
    uploadSequence += 1
    return { id: `upload-${uploadSequence}`, file, side: uploadSequence }
  })
  editor.view.dispatch(
    editor.state.tr
      .setMeta(uploadsKey, { add: items.map(item => ({ id: item.id, pos: at, side: item.side })) } satisfies PlaceholderMeta)
      .setMeta('addToHistory', false),
  )

  let uploads = uploadsByEditor.get(editor)
  if (!uploads) {
    uploads = new Map()
    uploadsByEditor.set(editor, uploads)
  }
  // Uploads run in parallel, but images are inserted strictly in file order.
  let previous: Promise<unknown> = Promise.resolve()
  for (const item of items) {
    const controller = new AbortController()
    uploads.set(item.id, controller)
    changePending(1)
    const size = displaySize(item.file)
    const uploaded = uploadKeepingThroughSignIn(item.file, controller.signal)
    // Handled below once it's this file's turn; this only avoids an "unhandled rejection" warning.
    uploaded.catch(() => undefined)

    previous = previous
      .then(() => uploaded)
      .then(async ({ src }) => {
        const dimensions = await size
        if (controller.signal.aborted || editor.isDestroyed) return
        const position = findPlaceholder(editor.state, item.id)
        // The user deleted the spot the image was going to; respect that.
        if (position === null) return
        insertImage(editor, position, item.id, { src, ...dimensions })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || editor.isDestroyed) return
        removePlaceholders(editor, [item.id])
        const reason = error instanceof Error ? error.message : String(error)
        showNotice(`Couldn't upload ${describeFiles([item.file])}: ${reason}`)
      })
      .finally(() => {
        uploads.delete(item.id)
        changePending(-1)
      })
  }
}

/** Cancels this editor's uploads (e.g. when leaving the note). Returns how many were cancelled. */
export function cancelImageUploads(editor: Editor): number {
  const uploads = uploadsByEditor.get(editor)
  if (!uploads || uploads.size === 0) return 0
  const count = uploads.size
  for (const controller of uploads.values()) controller.abort()
  uploads.clear()
  if (!editor.isDestroyed) removePlaceholders(editor, [...(uploadsKey.getState(editor.state)?.find() ?? [])].map(d => d.spec.id as string))
  return count
}

/** Paste and drop handling for image files. Client-only: it adds nothing to the schema. */
export const ImageInput = Extension.create({
  name: 'imageInput',

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin<DecorationSet>({
        key: uploadsKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            let next = set.map(tr.mapping, tr.doc)
            const meta = tr.getMeta(uploadsKey) as PlaceholderMeta | undefined
            if (meta?.add) {
              next = next.add(
                tr.doc,
                meta.add.map(item => Decoration.widget(item.pos, placeholderElement, { id: item.id, side: item.side })),
              )
            }
            if (meta?.remove) {
              const ids = meta.remove
              next = next.remove(next.find(undefined, undefined, spec => ids.includes(spec.id as string)))
            }
            return next
          },
        },
        props: {
          decorations: state => uploadsKey.getState(state),

          handlePaste(_view, event) {
            const files = Array.from(event.clipboardData?.files ?? [])
            const html = event.clipboardData?.getData('text/html') ?? ''
            if (shouldPasteAsFiles(files.length, html)) {
              event.preventDefault()
              uploadImages(editor, files)
              return true
            }
            // Pasted as HTML: parseHTML leaves out images Margin doesn't store; say so. (Decided
            // here rather than in transformPastedHTML, which also runs for "Copy image" pastes
            // that end up uploading the file.)
            const skipped = countForeignImages(html, window.location.origin)
            if (skipped > 0) {
              showNotice(
                skipped === 1
                  ? "An image from the web wasn't pasted. Save it to your computer and drop it in instead."
                  : `${skipped} images from the web weren't pasted. Save them to your computer and drop them in instead.`,
              )
            }
            return false
          },

          handleDrop(view, event, _slice, moved) {
            // Moving content inside the editor is ProseMirror's job.
            if (moved) return false
            const files = Array.from(event.dataTransfer?.files ?? [])
            if (files.length === 0) return false
            event.preventDefault()
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
            uploadImages(editor, files, pos)
            return true
          },
        },
      }),
    ]
  },
})
