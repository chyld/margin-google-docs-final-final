import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Editor } from '@tiptap/react'
import { TableProperties } from 'lucide-react'
import { MenuItem, ToolMenuButton } from './ToolbarParts.tsx'

const GRID_COLUMNS = 10
const GRID_ROWS = 8

/**
 * Pick a table size on a grid, like Google Docs. Arrow keys move between cells; Enter inserts.
 */
export function TableGrid({ onPick, autoFocus = false }: { onPick: (rows: number, cols: number) => void; autoFocus?: boolean }) {
  const [size, setSize] = useState({ rows: 1, cols: 1 })
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoFocus) gridRef.current?.querySelector<HTMLElement>('button')?.focus()
  }, [autoFocus])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, [number, number]> = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    const rows = Math.min(GRID_ROWS, Math.max(1, size.rows + move[0]))
    const cols = Math.min(GRID_COLUMNS, Math.max(1, size.cols + move[1]))
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${rows - 1}-${cols - 1}"]`)?.focus()
  }

  return (
    <div className="table-grid-popover">
      <div ref={gridRef} className="table-grid" role="group" aria-label="Table size" onKeyDown={onKeyDown} onMouseLeave={() => setSize({ rows: 1, cols: 1 })}>
        {Array.from({ length: GRID_ROWS }, (_, row) =>
          Array.from({ length: GRID_COLUMNS }, (_, col) => {
            const lit = row < size.rows && col < size.cols
            return (
              <button
                key={`${row}-${col}`}
                type="button"
                data-cell={`${row}-${col}`}
                className={lit ? 'table-grid-cell is-lit' : 'table-grid-cell'}
                aria-label={`${row + 1} by ${col + 1} table`}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setSize({ rows: row + 1, cols: col + 1 })}
                onFocus={() => setSize({ rows: row + 1, cols: col + 1 })}
                onClick={() => onPick(row + 1, col + 1)}
              />
            )
          }),
        )}
      </div>
      <div className="table-grid-label" aria-live="polite">
        {size.cols} × {size.rows}
      </div>
    </div>
  )
}

type TableAction = { label: string; can: () => boolean; run: () => void } | 'separator'

/** Row, column, merge and header commands for the table at the cursor. */
export function TableOptions({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  const action = (label: string, name: string): TableAction => ({
    label,
    can: () => (editor.can() as unknown as Record<string, () => boolean>)[name]?.() ?? false,
    run: () => (editor.chain().focus() as unknown as Record<string, () => { run: () => boolean }>)[name]?.().run(),
  })

  const actions: TableAction[] = [
    action('Insert row above', 'addRowBefore'),
    action('Insert row below', 'addRowAfter'),
    action('Insert column left', 'addColumnBefore'),
    action('Insert column right', 'addColumnAfter'),
    'separator',
    action('Delete row', 'deleteRow'),
    action('Delete column', 'deleteColumn'),
    'separator',
    action('Merge cells', 'mergeCells'),
    action('Split cell', 'splitCell'),
    'separator',
    action('Header row', 'toggleHeaderRow'),
    action('Header column', 'toggleHeaderColumn'),
    'separator',
    action('Delete table', 'deleteTable'),
  ]

  return (
    <ToolMenuButton label="Table options" icon={TableProperties} disabled={disabled} onRestoreFocus={() => editor.view.focus()}>
      {close =>
        actions.map((item, index) =>
          item === 'separator' ? (
            <div key={`separator-${index}`} className="menu-separator" role="separator" />
          ) : (
            <MenuItem
              key={item.label}
              label={item.label}
              danger={item.label === 'Delete table'}
              disabled={!item.can()}
              onSelect={() => {
                item.run()
                close()
              }}
            />
          ),
        )
      }
    </ToolMenuButton>
  )
}
