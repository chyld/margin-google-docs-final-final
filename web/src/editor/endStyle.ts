// Formatting-bar actions end the active style first: one transaction, one undo step.
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { ChainedCommands, Editor } from '@tiptap/core'
import type { Mark } from '@tiptap/pm/model'
import { styleById } from '../state/namedStyles.ts'
import { detachBlockStyles, endStyle, rememberAlignments, restoreAlignments, setTypeWhereAllowed } from './styleCommands.ts'
import type { BlockTarget } from './styleCommands.ts'

const styleOf = (id: string) => styleById(id)?.props

/**
 * Runs a formatting action after ending the style at the selection, in one transaction. If the
 * action's own steps clear the formatting held for the next keystroke (alignment, paragraph type),
 * it's put back, unless the action set it itself (toggling bold at the cursor).
 */
export function runWithEndStyle(
  editor: Editor,
  action: (chain: ChainedCommands) => ChainedCommands,
  { materialize = true, focus = true, lookup = styleOf }: { materialize?: boolean; focus?: boolean; lookup?: (id: string) => import('../../../shared/styleProps.ts').StyleProps | undefined } = {},
): boolean {
  // An action that can't apply here (alignment in a section title, say) changes nothing, so it must
  // not end the style either: try it first without dispatching.
  if (!action(editor.can().chain()).run()) return false
  let typing: readonly Mark[] | null = null
  let start = editor.chain()
  if (focus) start = start.focus()
  const chain = start.command(({ tr }) => {
    typing = endStyle(tr, lookup, { materialize })
    return true
  })
  // The dry run said the action applies. Ending the style first can make it report false here (a
  // paragraph-type change that only unlinked finds the line already unlinked), but Tiptap
  // dispatches the chain anyway, so the change happened.
  action(chain)
    .command(({ tr }) => {
      // Clear formatting means plain typing; other actions keep the style's look for the next text.
      const intended = materialize ? typing : []
      if (intended && tr.selection.empty && tr.storedMarks === null && tr.docChanged) tr.setStoredMarks(intended)
      if (tr.selection.empty && tr.storedMarks) tr.setMeta(TYPING_META, tr.storedMarks)
      return true
    })
    .run()
  return true
}

const TYPING_META = 'endStyleTyping'
const typingKey = new PluginKey<readonly Mark[] | null>('endStyleTyping')

/**
 * Keeps the marks an ended style left for typing even when another plugin's change right after (the
 * empty line added after a final heading) clears them; otherwise the next character would pick the
 * style back up from the text before it.
 */
function keepTypingMarks(): Plugin {
  return new Plugin<readonly Mark[] | null>({
    key: typingKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const marks = tr.getMeta(TYPING_META) as readonly Mark[] | undefined
        if (marks) return marks
        // Changes appended by plugins keep the pending marks; anything the user does drops them.
        return tr.getMeta('appendedTransaction') ? value : null
      },
    },
    appendTransaction(_transactions, _oldState, newState) {
      const marks = typingKey.getState(newState)
      if (!marks || newState.storedMarks || !newState.selection.empty) return null
      return newState.tr.setStoredMarks(marks)
    },
  })
}

type Action = (chain: ChainedCommands) => ChainedCommands

/**
 * A paragraph-type change: ends the style, changes the type, unlinks the paragraphs, and keeps each
 * paragraph's alignment (its own or its style's), which Tiptap would drop across several paragraphs.
 */
export function changeParagraphType(chain: ChainedCommands, change: Action, lookup = styleOf): ChainedCommands {
  let saved: ReturnType<typeof rememberAlignments> = []
  let since = 0
  return change(
    chain.command(({ tr }) => {
      saved = rememberAlignments(tr, lookup)
      since = tr.mapping.maps.length
      return true
    }),
  ).command(({ tr }) => {
    restoreAlignments(tr, saved, since)
    detachBlockStyles(tr, lookup)
    return true
  })
}

/** The paragraph-type menu and its shortcuts: see `setTypeWhereAllowed`. */
export function setParagraphType(chain: ChainedCommands, target: BlockTarget, { toggle = false, lookup = styleOf } = {}): ChainedCommands {
  return changeParagraphType(chain, c => c.command(({ tr }) => setTypeWhereAllowed(tr, target, { toggle })), lookup)
}

/**
 * The formatting shortcuts end the style too, exactly like their toolbar buttons. Same key strings as
 * Tiptap's own (so keyboard layouts behave the same), run first by priority.
 */
export const EndStyleShortcuts = Extension.create({
  name: 'endStyleShortcuts',
  priority: 1000,

  addProseMirrorPlugins() {
    return [keepTypingMarks()]
  },

  addKeyboardShortcuts() {
    // Always "handled": the key was intercepted, so Tiptap's own binding mustn't run it again.
    const run = (action: Action) => () => {
      runWithEndStyle(this.editor, action, { focus: false })
      return true
    }
    const heading = (level: number) => run(chain => setParagraphType(chain, { type: 'heading', level }, { toggle: true }))
    return {
      'Mod-b': run(chain => chain.toggleBold()),
      'Mod-B': run(chain => chain.toggleBold()),
      'Mod-i': run(chain => chain.toggleItalic()),
      'Mod-I': run(chain => chain.toggleItalic()),
      'Mod-u': run(chain => chain.toggleUnderline()),
      'Mod-U': run(chain => chain.toggleUnderline()),
      'Mod-Shift-s': run(chain => chain.toggleStrike()),
      'Mod-e': run(chain => chain.toggleCode()),
      'Mod-Shift-h': run(chain => chain.toggleHighlight()),
      'Mod-Shift-l': run(chain => chain.setTextAlign('left')),
      'Mod-Shift-e': run(chain => chain.setTextAlign('center')),
      'Mod-Shift-r': run(chain => chain.setTextAlign('right')),
      'Mod-Shift-j': run(chain => chain.setTextAlign('justify')),
      'Mod-Alt-0': run(chain => setParagraphType(chain, { type: 'paragraph' })),
      'Mod-Alt-1': heading(1),
      'Mod-Alt-2': heading(2),
      'Mod-Alt-3': heading(3),
      'Mod-Alt-4': heading(4),
      'Mod-Alt-5': heading(5),
      'Mod-Alt-6': heading(6),
    }
  },
})
