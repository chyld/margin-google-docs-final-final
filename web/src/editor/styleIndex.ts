// Looking saved styles up by id, and whether the list has loaded. A leaf (no app imports), shared by
// the store (state/namedStyles.ts) and the formatting readers (formatInfo.ts, the toolbar).
import type { NamedStyle } from '../../../shared/styleProps.ts'

export type StylesStatus = 'loading' | 'loaded' | 'failed'

/** The status the store's snapshot is in. */
export function stylesStatus(snapshot: { loaded: boolean; failed: boolean }): StylesStatus {
  return snapshot.loaded ? 'loaded' : snapshot.failed ? 'failed' : 'loading'
}

/** Style id → style, built once per styles list (the store replaces the list on every change). */
const indexes = new WeakMap<readonly NamedStyle[], Map<string, NamedStyle>>()
export function styleIndex(list: readonly NamedStyle[]): ReadonlyMap<string, NamedStyle> {
  let index = indexes.get(list)
  if (!index) {
    index = new Map(list.map(style => [style.id, style]))
    indexes.set(list, index)
  }
  return index
}
