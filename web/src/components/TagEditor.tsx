import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEvent, FormEvent, KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import {
  isValidTag,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  normalizeTag,
  splitTagInput,
  TAG_RULE_MESSAGE,
  TAG_TOO_LONG_MESSAGE,
  TOO_MANY_TAGS_MESSAGE,
} from '../../../shared/tags.ts'

type TagEditorProps = {
  tags: string[]
  /** The user's other tags, offered as suggestions. */
  suggestions: string[]
  /** No adding or removing (signing out, or a note that opened read-only). */
  disabled: boolean
  onChange: (tags: string[]) => void
  /** Filter the notes list by this tag. */
  onOpenTag: (tag: string) => void
  /** Called as the editor closes, after typed tags were kept (the note saves right away). */
  onLeave?: () => void
}

/** Typing commits on Enter, comma, space or leaving the field; nothing is committed mid-composition. */
const DELIMITER = /[\s,]/

/**
 * A note's tags: chips (the name filters the list, × removes it) and a field to add more. Tags are
 * lowercase a–z and 0–9 (shared/tags.ts); anything else stays in the field with a message.
 */
export function TagEditor({ tags, suggestions, disabled, onChange, onOpenTag, onLeave }: TagEditorProps) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [announcement, setAnnouncementText] = useState('')
  // A live region only speaks when its text changes: alternate a trailing no-break space so the
  // same message (adding a tag again) is announced again.
  const announceCount = useRef(0)
  const setAnnouncement = (text: string) => {
    announceCount.current += 1
    setAnnouncementText(announceCount.current % 2 ? text : `${text}\u00a0`)
  }
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const errorId = useId()
  const full = tags.length >= MAX_TAGS

  // Valid typed tags are kept even without a blur: when the note view closes (Back, another note),
  // when the page is hidden or closed (before the app persists drafts), and when editing locks.
  const latest = useRef({ draft, tags, onChange, onLeave })
  latest.current = { draft, tags, onChange, onLeave }
  // An input method's unfinished text is never saved as a tag.
  const composing = useRef(false)
  const keepTyped = useRef(() => {
    const { draft: pending, tags: current, onChange: save } = latest.current
    if (!pending.trim() || composing.current) return
    const added = splitTagInput(pending).map(normalizeTag).filter(tag => isValidTag(tag) && !current.includes(tag))
    const next = [...new Set([...current, ...added])].slice(0, MAX_TAGS)
    if (next.length > current.length) {
      latest.current = { ...latest.current, draft: '', tags: next }
      save(next.sort())
      setDraft('')
    }
  })
  useEffect(() => {
    const keep = keepTyped.current
    const onHidden = () => {
      if (document.visibilityState === 'hidden') keep()
    }
    // Capture phase: runs before the app's own listeners persist drafts and flush saves.
    window.addEventListener('pagehide', keep, true)
    document.addEventListener('visibilitychange', onHidden, true)
    return () => {
      window.removeEventListener('pagehide', keep, true)
      document.removeEventListener('visibilitychange', onHidden, true)
      keep()
      latest.current.onLeave?.()
    }
  }, [])
  // A layout effect: with the lock applied synchronously (sign-out), the tag is queued before the
  // final saves are sent.
  useLayoutEffect(() => {
    if (disabled) {
      keepTyped.current()
      setDraft('')
      setError(null)
    }
  }, [disabled])

  /** Adds the valid pieces; returns the pieces that stay in the field (invalid or over the limit). */
  function commit(pieces: string[]): string[] {
    const next = [...tags]
    const kept: string[] = []
    let problem: string | null = null
    for (const piece of pieces) {
      const tag = normalizeTag(piece)
      if (!tag) continue
      if (!isValidTag(tag)) {
        kept.push(piece)
        problem ??= tag.length > MAX_TAG_LENGTH ? TAG_TOO_LONG_MESSAGE : TAG_RULE_MESSAGE
        continue
      }
      if (next.includes(tag)) continue
      if (next.length >= MAX_TAGS) {
        kept.push(piece)
        problem ??= TOO_MANY_TAGS_MESSAGE
        continue
      }
      next.push(tag)
    }
    const added = next.filter(tag => !tags.includes(tag))
    if (added.length > 0) {
      onChange([...next].sort())
      setAnnouncement(`Tag${added.length > 1 ? 's' : ''} added: ${added.join(', ')}`)
    } else if (!problem && pieces.some(piece => tags.includes(normalizeTag(piece)))) {
      // Already on the note: nothing to save.
      setAnnouncement('Tag already added')
    }
    setError(problem)
    return kept
  }

  function commitDraft(text = draft): void {
    const kept = commit(splitTagInput(text))
    setDraft(kept.join(' '))
  }

  function remove(tag: string, { focusAfter = true } = {}): void {
    const index = tags.indexOf(tag)
    onChange(tags.filter(item => item !== tag))
    setAnnouncement(`Tag removed: ${tag}`)
    setError(null)
    if (!focusAfter) return
    // Keep focus nearby: the next chip's remove button, else the field.
    requestAnimationFrame(() => {
      const buttons = rowRef.current?.querySelectorAll<HTMLButtonElement>('.tag-chip-remove')
      // The chip that took this one's place, else (it was the last) the field.
      const target = buttons && index < buttons.length ? buttons[index] : null
      ;(target ?? inputRef.current)?.focus()
    })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' || event.key === ',' || event.key === ' ') {
      event.preventDefault()
      commitDraft()
    } else if (event.key === 'Backspace' && draft === '' && tags.length > 0 && !event.repeat) {
      // First Backspace moves to the last chip's remove button; Backspace there removes it.
      event.preventDefault()
      const buttons = rowRef.current?.querySelectorAll<HTMLButtonElement>('.tag-chip-remove')
      buttons?.[buttons.length - 1]?.focus()
    } else if (event.key === 'Escape' && (draft || error)) {
      event.preventDefault()
      setDraft('')
      setError(null)
    }
  }

  // Phone keyboards often skip keydown: a typed delimiter or a picked suggestion commits here.
  function handleInput(event: FormEvent<HTMLInputElement>): void {
    const native = event.nativeEvent as InputEvent
    const value = event.currentTarget.value
    if (native.isComposing) {
      setDraft(value)
      return
    }
    if (native.inputType === 'insertReplacementText' || (native.inputType === undefined && suggestions.includes(value))) {
      commitDraft(value)
      return
    }
    if (DELIMITER.test(value)) {
      const pieces = splitTagInput(value)
      const endsWithDelimiter = DELIMITER.test(value.slice(-1))
      const trailing = endsWithDelimiter ? '' : (pieces.pop() ?? '')
      const kept = commit(pieces)
      setDraft([...kept, trailing].filter(Boolean).join(' '))
      return
    }
    setDraft(value)
    if (error) setError(null)
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    const text = event.clipboardData.getData('text')
    if (!DELIMITER.test(text.trim())) return
    event.preventDefault()
    const input = event.currentTarget
    const start = input.selectionStart ?? draft.length
    const end = input.selectionEnd ?? draft.length
    commitDraft(draft.slice(0, start) + text + draft.slice(end))
  }

  const offered = suggestions.filter(tag => !tags.includes(tag))

  return (
    <div className="tag-editor" role="group" aria-label="Tags" ref={rowRef}>
      {tags.map(tag => (
        <span key={tag} className="tag-chip">
          <button type="button" className="tag-chip-name" title={`Show notes tagged #${tag}`} onClick={() => onOpenTag(tag)}>
            #{tag}
          </button>
          {!disabled && (
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`Remove tag ${tag}`}
              onClick={() => remove(tag)}
              onKeyDown={event => {
                if (event.key === 'Backspace' || event.key === 'Delete') {
                  event.preventDefault()
                  // A held key mustn't eat every tag: removing takes a fresh press.
                  if (!event.repeat) remove(tag)
                }
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          ref={inputRef}
          className="tag-input"
          value={draft}
          placeholder={full ? `${MAX_TAGS} tags max` : tags.length ? 'Add tag…' : 'Add a tag…'}
          aria-label="Add a tag"
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          readOnly={full}
          list={offered.length ? listId : undefined}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          maxLength={200}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onInput={handleInput}
          onChange={() => undefined}
          onPaste={handlePaste}
          onBlur={event => {
            if (composing.current) return
            // Moving within the tags (e.g. to a chip's remove button) isn't leaving: no commit that
            // would shift the chips under the click.
            if (rowRef.current?.contains(event.relatedTarget as Node | null)) return
            if (draft.trim()) commitDraft()
          }}
        />
      )}
      {!disabled && offered.length > 0 && (
        <datalist id={listId}>
          {offered.map(tag => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
      )}
      {error && (
        <span id={errorId} className="tag-error" role="alert">
          {error}
        </span>
      )}
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>
    </div>
  )
}
