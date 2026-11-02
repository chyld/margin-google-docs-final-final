import type { RefObject } from 'react'
import { FilePlus2, Menu } from 'lucide-react'
import type { TagCount } from '../../../shared/types.ts'
import type { ListState } from '../notes/noteList.ts'
import { EmptyIllustration } from './EmptyIllustration.tsx'
import { TagList } from './Sidebar.tsx'

type HomeProps = {
  listState: ListState
  hasNotes: boolean
  searching: boolean
  creating: boolean
  mobile: boolean
  tags: TagCount[]
  activeTags: string[]
  /** Focused when the logo brings you home. */
  headingRef: RefObject<HTMLHeadingElement | null>
  onCreate: () => void
  onRetry: () => void
  onShowNotes: () => void
  onToggleTag: (tag: string) => void
}

/** "/" with no note open: a first-note invitation, a load error, or the home page. */
export function Home({ listState, hasNotes, searching, creating, mobile, tags, activeTags, headingRef, onCreate, onRetry, onShowNotes, onToggleTag }: HomeProps) {
  return (
    <main className="empty-main">
      {listState === 'ready' && !hasNotes && !searching && (
        <div className="empty-state">
          <EmptyIllustration />
          <h1 ref={headingRef} tabIndex={-1}>
            Your first page is waiting
          </h1>
          <p>Notes you write here are yours alone. Start with a blank page.</p>
          <button type="button" className="button primary" onClick={onCreate} disabled={creating}>
            <FilePlus2 size={18} aria-hidden="true" />
            Create your first note
          </button>
        </div>
      )}
      {listState === 'error' && (
        <div className="empty-state">
          <h1 ref={headingRef} tabIndex={-1}>Couldn't load your notes</h1>
          <button type="button" className="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {listState === 'ready' && (hasNotes || searching) && (
        <div className="empty-state home">
          <EmptyIllustration />
          <h1 ref={headingRef} tabIndex={-1}>
            Pick a note, or start a new one
          </h1>
          <p>{mobile ? 'Open the menu to see your notes.' : 'Your notes are in the list on the left.'}</p>
          <div className="home-actions">
            <button type="button" className="button primary" onClick={onCreate} disabled={creating}>
              <FilePlus2 size={18} aria-hidden="true" />
              New note
            </button>
            {mobile && (
              <button type="button" className="button" onClick={onShowNotes}>
                <Menu size={18} aria-hidden="true" />
                Show my notes
              </button>
            )}
          </div>
          {tags.length > 0 && (
            <section className="home-tags" aria-labelledby="home-tags-title">
              <h2 id="home-tags-title">Tags</h2>
              <TagList tags={tags} activeTags={activeTags} onToggle={onToggleTag} />
            </section>
          )}
        </div>
      )}
    </main>
  )
}
