// Earthy tones for per-note dots and per-user avatars (Ink & Ochre): a fixed set, so every color is
// contrast-checked (scripts/theme.test.ts). The same hash as before, so each note keeps its slot.
export const CANDY = ['ochre', 'clay', 'sage', 'slate', 'plum', 'ink'] as const
export type Candy = (typeof CANDY)[number]

/** A stable tone for any string (a note id, a username). */
export function candyFor(value: string): Candy {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return CANDY[(hash >>> 0) % CANDY.length] as Candy
}
