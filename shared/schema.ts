import { getSchema } from '@tiptap/core'
import { extensions } from './extensions.ts'

export const schema = getSchema(extensions)

/** Checks that the editor can open this document: known types, valid nesting and attributes. */
export function checkSchema(doc: unknown): { ok: true } | { ok: false; error: string } {
  try {
    schema.nodeFromJSON(doc).check()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
