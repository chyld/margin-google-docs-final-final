import { useRef, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import type { ChainedCommands } from '@tiptap/core'
import { runWithEndStyle, setParagraphType } from '../editor/endStyle.ts'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ChevronLeft,
  Code,
  Ellipsis,
  Highlighter,
  ImagePlus,
  Italic,
  Link,
  List,
  ListCollapse,
  ListOrdered,
  ListTodo,
  Minus,
  Plus,
  Quote,
  Redo2,
  RemoveFormatting,
  SquareCode,
  Strikethrough,
  Table,
  Underline,
  Undo2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { HEADING_LEVELS } from '../../../shared/extensions.ts'
import { firstFontFamily } from '../../../shared/fonts.ts'
import type { ImageAlign } from '../../../shared/image.ts'
import type { StyleAlign } from '../../../shared/styleProps.ts'
import { currentFontSize } from '../editor/fontSize.ts'
import { IMAGE_ACCEPT, uploadImages } from '../editor/imageInput.ts'
import { BLOCK_OPTIONS } from '../editor/labels.ts'
import { FontPicker } from './FontPicker.tsx'
import { FontSize } from './FontSize.tsx'
import { LinkPopover } from './LinkPopover.tsx'
import { clearInlineFormatting, currentStyle, effectiveTextProps } from '../editor/styleCommands.ts'
import type { CurrentStyle } from '../editor/styleCommands.ts'
import { styleById } from '../state/namedStyles.ts'
import { StylesMenu } from './StylesMenu.tsx'
import { TableGrid, TableOptions } from './TableMenu.tsx'
import { Group, MenuItem, MOD, Separator, ToolButton, ToolMenuButton, useDismiss } from './ToolbarParts.tsx'
import { useFormatPanel } from '../state/formatPanel.ts'

type Swatch = { name: string; value: string }

// Hex only, matching the server's color check.
const TEXT_COLORS: Swatch[] = [
  { name: 'Black', value: '#202124' },
  { name: 'Dark gray', value: '#5f6368' },
  { name: 'Gray', value: '#9aa0a6' },
  { name: 'Red', value: '#d93025' },
  { name: 'Orange', value: '#e8710a' },
  { name: 'Yellow', value: '#c69200' },
  { name: 'Green', value: '#188038' },
  { name: 'Teal', value: '#007b83' },
  { name: 'Blue', value: '#1a73e8' },
  { name: 'Purple', value: '#9334e6' },
  { name: 'Pink', value: '#d01884' },
  { name: 'Brown', value: '#795548' },
]

// One light tint per text color, in the same order, so the two palettes line up.
const HIGHLIGHT_COLORS: Swatch[] = [
  { name: 'Black', value: '#d3d4d6' },
  { name: 'Dark gray', value: '#e3e4e6' },
  { name: 'Gray', value: '#f1f3f4' },
  { name: 'Red', value: '#f6c6c3' },
  { name: 'Orange', value: '#fbd5a5' },
  { name: 'Yellow', value: '#fff475' },
  { name: 'Green', value: '#ccf0d2' },
  { name: 'Teal', value: '#c6eef0' },
  { name: 'Blue', value: '#cbe4fd' },
  { name: 'Purple', value: '#e9d2fd' },
  { name: 'Pink', value: '#fdcfe8' },
  { name: 'Brown', value: '#e6d5cc' },
]

type Block = 'paragraph' | `h${(typeof HEADING_LEVELS)[number]}` | 'other'
type Align = StyleAlign

type ToolbarState = {
  editable: boolean
  canUndo: boolean
  canRedo: boolean
  block: Block
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  code: boolean
  canCode: boolean
  color: string | null
  highlight: string | null
  link: boolean
  align: Align
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
  blockquote: boolean
  codeBlock: boolean
  canMarks: boolean
  canBulletList: boolean
  canOrderedList: boolean
  canTaskList: boolean
  canBlockquote: boolean
  canCodeBlock: boolean
  canHorizontalRule: boolean
  canAlign: boolean
  fontFamily: string | null
  fontSize: number | null
  imageSelected: boolean
  imageAlign: ImageAlign
  inTable: boolean
  canInsertTable: boolean
  details: boolean
  canDetails: boolean
  style: CurrentStyle
}

/** A linked paragraph shows the type its style gives it (it may differ from the node, e.g. in lists). */
function linkedBlock(editor: Editor): Block | null {
  const id = editor.state.selection.$from.parent.attrs.styleId as string | null | undefined
  const block = id ? styleById(id)?.props.block : undefined
  return block ? (block as Block) : null
}

function currentBlock(editor: Editor): Block {
  for (const level of HEADING_LEVELS) {
    if (editor.isActive('heading', { level })) return `h${level}`
  }
  return editor.isActive('paragraph') ? 'paragraph' : 'other'
}

// Runs after every transaction; editor.can() must be called here so disabled states stay current.
export function selectState({ editor }: { editor: Editor | null }): ToolbarState | null {
  if (!editor) return null
  const can = editor.can()
  const highlight = editor.isActive('highlight') ? (editor.getAttributes('highlight').color as string | undefined) : undefined
  const imageSelected = editor.isActive('image')
  const details = editor.isActive('details')
  const styleText = effectiveTextProps(editor.state, id => styleById(id)?.props)
  return {
    editable: editor.isEditable,
    canUndo: can.undo(),
    canRedo: can.redo(),
    block: linkedBlock(editor) ?? currentBlock(editor),
    // What the text really has: direct formatting, or the parts its style gives it.
    bold: editor.isActive('bold') || Boolean(styleText?.bold),
    italic: editor.isActive('italic') || Boolean(styleText?.italic),
    underline: editor.isActive('underline') || Boolean(styleText?.underline),
    strike: editor.isActive('strike') || Boolean(styleText?.strike),
    code: editor.isActive('code'),
    canCode: can.toggleCode(),
    color: (editor.getAttributes('textStyle').color as string | undefined) ?? styleText?.color ?? null,
    highlight: highlight ?? styleText?.highlight ?? null,
    link: editor.isActive('link'),
    // The paragraph's own alignment, else the one its style gives it.
    align:
      (['center', 'right', 'justify'] as const).find(align => editor.isActive({ textAlign: align })) ??
      ((editor.state.selection.$from.parent.attrs.textAlign as Align | null) ? 'left' : null) ??
      (styleById(editor.state.selection.$from.parent.attrs.styleId as string | undefined)?.props.align as Align | undefined) ??
      'left',
    bulletList: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    taskList: editor.isActive('taskList'),
    blockquote: editor.isActive('blockquote'),
    codeBlock: editor.isActive('codeBlock'),
    canMarks: can.toggleBold(),
    canBulletList: can.toggleBulletList(),
    canOrderedList: can.toggleOrderedList(),
    canTaskList: can.toggleTaskList(),
    canBlockquote: can.toggleBlockquote(),
    canCodeBlock: can.toggleCodeBlock(),
    canHorizontalRule: can.setHorizontalRule(),
    canAlign: can.setTextAlign('left'),
    // Direct formatting first, then the font the text's style supplies.
    fontFamily: firstFontFamily(editor.getAttributes('textStyle').fontFamily) ?? firstFontFamily(styleText?.fontFamily),
    fontSize: currentFontSize(editor),
    imageSelected,
    imageAlign: imageSelected ? ((editor.getAttributes('image').align as ImageAlign | null) ?? 'left') : 'left',
    inTable: editor.isActive('table'),
    canInsertTable: can.insertTable({ rows: 1, cols: 1 }),
    details,
    canDetails: details ? can.unsetDetails() : can.setDetails(),
    style: currentStyle(editor.state),
  }
}

type ColorMenuProps = {
  label: string
  icon: LucideIcon
  swatches: Swatch[]
  current: string | null
  clearLabel: string
  barFallback: string
  disabled: boolean
  onPick: (color: string) => void
  onClear: () => void
  onRestoreFocus: () => void
}

function ColorMenu(props: ColorMenuProps) {
  const { label, icon: Icon, swatches, current, clearLabel, barFallback, disabled, onPick, onClear, onRestoreFocus } = props
  return (
    <ToolMenuButton
      label={label}
      className="tool-color"
      popoverClassName="color-popover"
      disabled={disabled}
      onRestoreFocus={onRestoreFocus}
      trigger={
        <>
          <Icon size={18} aria-hidden="true" />
          <span className="color-bar" style={{ background: current ?? barFallback }} />
        </>
      }
    >
      {close => (
        <>
          <button
            type="button"
            className="color-clear"
            role="menuitem"
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              onClear()
              close()
            }}
          >
            {clearLabel}
          </button>
          <div className="swatches" role="none">
            {swatches.map(swatch => (
              <button
                key={swatch.value}
                type="button"
                role="menuitemradio"
                aria-checked={current?.toLowerCase() === swatch.value}
                aria-label={swatch.name}
                title={swatch.name}
                className="swatch"
                style={{ background: swatch.value }}
                onMouseDown={event => event.preventDefault()}
                onClick={() => {
                  onPick(swatch.value)
                  close()
                }}
              />
            ))}
          </div>
        </>
      )}
    </ToolMenuButton>
  )
}

type ToolbarProps = {
  editor: Editor | null
  /** The note can't be edited (e.g. its stored content failed to load). */
  readOnly: boolean
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
}

export function Toolbar({ editor, readOnly, linkOpen, onLinkOpenChange }: ToolbarProps) {
  const state = useEditorState({ editor, selector: selectState })
  const linkRef = useDismiss(linkOpen, () => onLinkOpenChange(false))
  const { stylesRequest } = useFormatPanel()

  if (!editor || !state) return <div className="toolbar" role="toolbar" aria-label="Formatting" />

  // setEditable(false, false) emits no transaction, so state.editable alone can be stale.
  const off = readOnly || !state.editable
  const chain = () => editor.chain().focus()
  // Formatting-bar changes end the active style first (keeping its look), in the same undo step.
  const styled = (action: (c: ChainedCommands) => ChainedCommands) => runWithEndStyle(editor, action)

  // A manual paragraph-type change wins over a paragraph style: it ends the style (keeping its look),
  // changes the type where the container allows it, and unlinks the lines, even where the type itself
  // can't change (a list item's first line must stay a paragraph). One undo step.
  function setBlock(block: string) {
    const level = Number(/^h([1-6])$/.exec(block)?.[1])
    styled(c => setParagraphType(c, level ? { type: 'heading', level } : { type: 'paragraph' }))
  }

  // With an image selected, the alignment menu places the image instead of aligning text.
  function align(value: Align) {
    if (state?.imageSelected) {
      if (value !== 'justify') chain().updateAttributes('image', { align: value === 'left' ? null : value }).run()
    } else {
      styled(c => c.setTextAlign(value))
    }
  }
  const alignState: Align = state.imageSelected ? state.imageAlign : state.align
  const alignDisabled = off || (state.imageSelected ? false : !state.canAlign)
  // Synchronous: the next keystroke must land in the document, not on a closing menu.
  const focusEditor = () => editor.view.focus()
  const AlignIcon = ALIGN_ICONS[alignState]
  const ListIcon = state.orderedList ? ListOrdered : state.taskList ? ListTodo : List

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <Group label="History">
        <ToolButton label="Undo" shortcut={`${MOD}+Z`} icon={Undo2} disabled={off || !state.canUndo} onClick={() => chain().undo().run()} />
        <ToolButton label="Redo" shortcut={`${MOD}+Shift+Z`} icon={Redo2} disabled={off || !state.canRedo} onClick={() => chain().redo().run()} />
      </Group>
      <Separator />

      <StylesMenu editor={editor} current={state.style} disabled={off} openRequest={stylesRequest} />
      <Separator />

      <select
        className="tool-select block-select"
        aria-label="Paragraph type"
        title="Paragraph type"
        value={state.block}
        disabled={off}
        onChange={event => setBlock(event.target.value)}
      >
        {BLOCK_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {state.block === 'other' && (
          <option value="other" disabled>
            —
          </option>
        )}
      </select>
      <Separator />

      <Group label="Font">
        <FontPicker editor={editor} current={state.fontFamily} disabled={off || !state.canMarks} />
        <FontSize editor={editor} value={state.fontSize} disabled={off || !state.canMarks} />
      </Group>
      <Separator />

      <Group label="Text formatting">
        <ToolButton label="Bold" shortcut={`${MOD}+B`} icon={Bold} active={state.bold} disabled={off || !state.canMarks} onClick={() => styled(c => c.toggleBold())} />
        <ToolButton label="Italic" shortcut={`${MOD}+I`} icon={Italic} active={state.italic} disabled={off || !state.canMarks} onClick={() => styled(c => c.toggleItalic())} />
        <ToolButton label="Underline" shortcut={`${MOD}+U`} icon={Underline} active={state.underline} disabled={off || !state.canMarks} onClick={() => styled(c => c.toggleUnderline())} />
        <ToolMenuButton
          label="More text formatting"
          icon={Ellipsis}
          active={state.strike || state.code}
          disabled={off}
          onRestoreFocus={focusEditor}
        >
          {close => (
            <>
              <MenuItem label="Strikethrough" icon={Strikethrough} shortcut={`${MOD}+Shift+S`} checked={state.strike} disabled={!state.canMarks} onSelect={() => { styled(c => c.toggleStrike()); close() }} />
              <MenuItem label="Inline code" icon={Code} shortcut={`${MOD}+E`} checked={state.code} disabled={!state.canCode} onSelect={() => { styled(c => c.toggleCode()); close() }} />
            </>
          )}
        </ToolMenuButton>
      </Group>
      <Separator />

      <Group label="Colors and link">
        <ColorMenu
          label="Text color"
          icon={Baseline}
          swatches={TEXT_COLORS}
          current={state.color}
          clearLabel="Default color"
          barFallback="#202124"
          disabled={off || !state.canMarks}
          onPick={color => styled(c => c.setColor(color))}
          onClear={() => styled(c => c.unsetColor())}
          onRestoreFocus={focusEditor}
        />
        <ColorMenu
          label="Highlight color"
          icon={Highlighter}
          swatches={HIGHLIGHT_COLORS}
          current={state.highlight}
          clearLabel="None"
          barFallback="transparent"
          disabled={off || !state.canMarks}
          onPick={color => styled(c => c.setHighlight({ color }))}
          onClear={() => styled(c => c.unsetHighlight())}
          onRestoreFocus={focusEditor}
        />
        <div className="tool-menu" ref={linkRef}>
          <ToolButton
            label="Link"
            shortcut={`${MOD}+K`}
            icon={Link}
            active={state.link || linkOpen}
            disabled={off}
            onClick={() => onLinkOpenChange(!linkOpen)}
          />
          {linkOpen && !off && <LinkPopover editor={editor} onClose={() => onLinkOpenChange(false)} />}
        </div>
      </Group>
      <Separator />

      <Group label="Paragraph">
        <ToolMenuButton label="Alignment" icon={AlignIcon} disabled={alignDisabled} onRestoreFocus={focusEditor}>
          {close => (
            <>
              {(['left', 'center', 'right', 'justify'] as const).map(value => (
                <MenuItem
                  key={value}
                  label={ALIGN_LABELS[value]}
                  icon={ALIGN_ICONS[value]}
                  shortcut={`${MOD}+Shift+${ALIGN_KEYS[value]}`}
                  checked={alignState === value}
                  radio
                  disabled={value === 'justify' && state.imageSelected}
                  onSelect={() => {
                    align(value)
                    close()
                  }}
                />
              ))}
            </>
          )}
        </ToolMenuButton>
        <ToolMenuButton
          label="Lists"
          icon={ListIcon}
          active={state.bulletList || state.orderedList || state.taskList}
          disabled={off}
          onRestoreFocus={focusEditor}
        >
          {close => (
            <>
              <MenuItem label="Bulleted list" icon={List} shortcut={`${MOD}+Shift+8`} checked={state.bulletList} disabled={!state.canBulletList} onSelect={() => { chain().toggleBulletList().run(); close() }} />
              <MenuItem label="Numbered list" icon={ListOrdered} shortcut={`${MOD}+Shift+7`} checked={state.orderedList} disabled={!state.canOrderedList} onSelect={() => { chain().toggleOrderedList().run(); close() }} />
              <MenuItem label="Checklist" icon={ListTodo} shortcut={`${MOD}+Shift+9`} checked={state.taskList} disabled={!state.canTaskList} onSelect={() => { chain().toggleTaskList().run(); close() }} />
            </>
          )}
        </ToolMenuButton>
      </Group>
      <Separator />

      <InsertMenu editor={editor} state={state} disabled={off} />
      {state.inTable && <TableOptions editor={editor} disabled={off} />}
      <Separator />

      <ToolButton label="Clear formatting" shortcut={`${MOD}+\\`} icon={RemoveFormatting} disabled={off} onClick={() => clearFormatting(editor)} />
    </div>
  )
}

const ALIGN_ICONS = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignJustify } as const
const ALIGN_LABELS = { left: 'Align left', center: 'Align center', right: 'Align right', justify: 'Justify' } as const
const ALIGN_KEYS = { left: 'L', center: 'E', right: 'R', justify: 'J' } as const

/** Clears marks, style links and block types (Ctrl/⌘+\\ too). Works with a collapsed cursor. */
export function clearFormatting(editor: Editor, { focus = true } = {}): void {
  // Ends the style too (nothing to keep: everything is being cleared).
  runWithEndStyle(
    editor,
    c =>
      c
        .command(({ tr }) => {
          clearInlineFormatting(tr)
          return true
        })
        .clearNodes(),
    { materialize: false, focus },
  )
}

function InsertMenu({ editor, state, disabled }: { editor: Editor; state: ToolbarState; disabled: boolean }) {
  const [panel, setPanel] = useState<'menu' | 'table'>('menu')
  // Kept mounted outside the menu: the menu closes before the file picker reports the files.
  const input = useRef<HTMLInputElement>(null)
  const chain = () => editor.chain().focus()
  return (
    <>
      <ToolMenuButton
        label="Insert"
        icon={Plus}
        disabled={disabled}
        kind={panel === 'menu' ? 'menu' : 'dialog'}
        onRestoreFocus={() => editor.view.focus()}
        // However the menu closes, it opens on the Insert list next time.
        onOpenChange={open => !open && setPanel('menu')}
      >
        {close =>
          panel === 'table' ? (
            <div
              className="insert-table-panel"
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  // One layer at a time: back to the Insert menu.
                  event.stopPropagation()
                  event.nativeEvent.stopImmediatePropagation()
                  setPanel('menu')
                }
              }}
            >
              <button type="button" className="menu-item with-icon insert-back" onClick={() => setPanel('menu')}>
                <span className="menu-item-icon" aria-hidden="true">
                  <ChevronLeft size={16} />
                </span>
                <span className="menu-item-label">Table size</span>
              </button>
              <TableGrid
                autoFocus
                onPick={(rows, cols) => {
                  editor.chain().focus().insertTable({ rows, cols, withHeaderRow: false }).run()
                  setPanel('menu')
                  close()
                }}
              />
            </div>
          ) : (
            <>
              <MenuItem label="Image…" icon={ImagePlus} onSelect={() => { close(); input.current?.click() }} />
              <MenuItem label="Table" icon={Table} submenu disabled={!state.canInsertTable} onSelect={() => setPanel('table')} />
              <div className="menu-separator" role="separator" />
              <MenuItem
                label="Collapsible section"
                icon={ListCollapse}
                checked={state.details}
                disabled={!state.canDetails}
                onSelect={() => {
                  // Tiptap creates sections collapsed, which would hide the text just wrapped; start open.
                  if (state.details) chain().unsetDetails().run()
                  else chain().setDetails().updateAttributes('details', { open: true }).run()
                  close()
                }}
              />
              <MenuItem label="Quote" icon={Quote} shortcut={`${MOD}+Shift+B`} checked={state.blockquote} disabled={!state.canBlockquote} onSelect={() => { chain().toggleBlockquote().run(); close() }} />
              <MenuItem label="Code block" icon={SquareCode} shortcut={`${MOD}+Alt+C`} checked={state.codeBlock} disabled={!state.canCodeBlock} onSelect={() => { chain().toggleCodeBlock().run(); close() }} />
              <MenuItem label="Horizontal line" icon={Minus} disabled={!state.canHorizontalRule} onSelect={() => { chain().setHorizontalRule().run(); close() }} />
            </>
          )
        }
      </ToolMenuButton>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={event => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length > 0) uploadImages(editor, files)
        }}
      />
    </>
  )
}
