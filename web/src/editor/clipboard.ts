// Copying styled text into another app (mail, Google Docs) should keep its look, but the look lives in
// Margin's stylesheet. The clipboard copy therefore gets the style's declarations inline too (the
// data-style tags stay, so pasting back into Margin keeps the link).
import { DOMSerializer } from '@tiptap/pm/model'
import { schema as sharedSchema } from '../../../shared/schema.ts'
import { styleDeclarations } from '../../../shared/styleProps.ts'
import { styleById } from '../state/namedStyles.ts'

function inlineStyleLooks(root: DocumentFragment | HTMLElement): void {
  const apply = (element: Element, id: string | null, kind: 'inline' | 'block') => {
    const declarations = styleDeclarations(styleById(id)?.props)?.[kind]
    if (!declarations?.length || !(element instanceof HTMLElement)) return
    element.setAttribute('style', `${declarations.join('; ')};${element.getAttribute('style') ?? ''}`)
  }
  for (const element of root.querySelectorAll('[data-style]')) apply(element, element.getAttribute('data-style'), 'inline')
  for (const element of root.querySelectorAll('[data-style-id]')) apply(element, element.getAttribute('data-style-id'), 'block')
}

// Built from the shared schema: node and mark types are looked up by name, and the editor's schema
// has exactly the same ones (its client-only extensions add none).
const baseSerializer = DOMSerializer.fromSchema(sharedSchema)

/** The editor's clipboardSerializer. */
export const styledClipboardSerializer = new (class extends DOMSerializer {
  serializeFragment(...args: Parameters<DOMSerializer['serializeFragment']>) {
    const fragment = baseSerializer.serializeFragment(...args)
    inlineStyleLooks(fragment)
    return fragment
  }
})(baseSerializer.nodes, baseSerializer.marks)
