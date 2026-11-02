// Where the browser suites run. They delete data, so they only ever talk to a throwaway server
// (e2e/run.sh starts one on 5557), never the real instance on 5555.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repo root (for the CLI and the built app). */
export const REPO = fileURLToPath(new URL('..', import.meta.url))
/** Screenshots taken along the way (for looking at failures). */
export const SHOTS = process.env.MARGIN_SHOTS ?? join(tmpdir(), 'margin-shots')

const base = process.env.MARGIN_URL ?? ''
if (!base || new URL(base).port === '5555') {
  console.error('Set MARGIN_URL to a throwaway Margin (not port 5555). Use e2e/run.sh.')
  process.exit(2)
}
export const BASE = base
/** The throwaway server's data directory and database (some checks edit them directly). */
export const DATA = process.env.MARGIN_DATA ?? ''
export const DB = process.env.MARGIN_DB ?? (DATA ? join(DATA, 'margin.db') : '')
