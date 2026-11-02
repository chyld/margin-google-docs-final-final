const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const dateOnly = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const dateWithYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5 minutes ago", "yesterday", "Mar 4". */
export function formatEdited(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return relative.format(-Math.floor(elapsed / MINUTE), 'minute')
  if (elapsed < DAY) return relative.format(-Math.floor(elapsed / HOUR), 'hour')
  if (elapsed < 7 * DAY) return relative.format(-Math.floor(elapsed / DAY), 'day')

  const sameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear()
  return (sameYear ? dateOnly : dateWithYear).format(timestamp)
}

export function displayTitle(title: string): string {
  return title.trim() || 'Untitled document'
}

/** The first character as people see it (emoji included), uppercased. */
export function firstGrapheme(text: string): string {
  const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  const first = segmenter ? segmenter.segment(text)[Symbol.iterator]().next().value?.segment : [...text][0]
  return (first ?? '').toLocaleUpperCase()
}
