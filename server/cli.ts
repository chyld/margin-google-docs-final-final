// margin-user: manage Margin accounts from the command line.
//
//   docker compose exec margin margin-user add alice
//   npm run user -- add alice          (without Docker)
//
// Safe to run while the server is up: both use the same SQLite database (WAL), and the server keeps
// no account cache, so changes apply on the next request.
import { openSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { randomInt } from 'node:crypto'
import tty from 'node:tty'
import { cleanUserAgent, hashPassword, normalizeUsername, passwordProblem } from './auth.ts'
import { openDatabase, prepareDataDir } from './db.ts'
import { createUserStore, UserError } from './users.ts'
import type { ClaimCounts } from './users.ts'

const EXIT = { ok: 0, usage: 1, problem: 2, busy: 3 } as const

const HELP = `margin-user: manage Margin accounts

Usage: margin-user <command> [arguments]

  add <name> [--generate | --password-stdin] [--claim | --no-claim]
                          Create an account. Asks for the password twice (hidden).
                          --generate prints a random password once instead.
                          The first account can take the notes from before accounts
                          (it asks; --claim / --no-claim answers without asking).
  list                    Show every account with its notes, images and sessions.
  passwd <name> [--generate | --password-stdin]
                          Set a new password. Signs the user out everywhere.
  rename <name> <new-name>
  logout <name>           Sign the user out on every device.
  sessions <name>         Show where the user is signed in.
  delete <name> (--transfer-to <other> | --purge) [--yes]
                          Delete an account. Its notes either move to another user or,
                          with --purge, are deleted for good (asks you to type the name).
  claim <name>            Give the notes and images from before accounts to <name>.
  reassign <from> <to>    Move every note, image and favorite from one user to another.

Names: 1-32 characters, lowercase letters, digits, dot, dash or underscore.
Passwords: at least 8 characters.

Docker: docker compose exec margin margin-user <command>
        docker compose run --rm margin margin-user <command>   (when Margin is stopped)
Never run it as root inside the container: the database files must stay owned by "node".`

class CliError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

type Parsed = { positional: string[]; flags: Map<string, string | true> }

const VALUE_FLAGS = new Set(['--transfer-to'])

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (arg.startsWith('--')) {
      const [name, inline] = arg.split('=', 2) as [string, string | undefined]
      if (VALUE_FLAGS.has(name)) {
        const value = inline ?? argv[++index]
        if (value === undefined) throw new CliError(EXIT.usage, `${name} needs a value`)
        flags.set(name, value)
      } else if (inline !== undefined) {
        // e.g. --purge=false must not quietly mean "purge".
        throw new CliError(EXIT.usage, `${name} doesn't take a value`)
      } else flags.set(name, true)
    } else if (arg === '-h') flags.set('--help', true)
    else if (arg === '-y') flags.set('--yes', true)
    else positional.push(arg)
  }
  return { positional, flags }
}

function allowFlags(parsed: Parsed, allowed: string[]): void {
  for (const flag of parsed.flags.keys()) {
    if (flag !== '--help' && !allowed.includes(flag)) throw new CliError(EXIT.usage, `Unknown option ${flag}`)
  }
}

/** Exactly `count` names after the command; anything extra is a mistake worth stopping for. */
function arity(args: string[], count: number, usage: string): void {
  if (args.length !== count) throw new CliError(EXIT.usage, `Usage: margin-user ${usage}`)
}

function needName(value: string | undefined, label = 'a username'): string {
  if (value === undefined) throw new CliError(EXIT.usage, `Give ${label}. See margin-user --help`)
  const name = normalizeUsername(value)
  if (!name) {
    throw new CliError(EXIT.usage, `"${value}" isn't a valid name: use 1-32 lowercase letters, digits, ".", "-" or "_"`)
  }
  return name
}

// ---- terminal input ----

type Terminal = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; close: () => void }

/** The interactive terminal: stdin when it is one, otherwise /dev/tty (e.g. when input is piped). */
function openTerminal(): Terminal | null {
  if (process.stdin.isTTY) return { input: process.stdin, output: process.stdout, close: () => {} }
  try {
    const fd = openSync('/dev/tty', 'r+')
    const input = new tty.ReadStream(fd)
    const output = new tty.WriteStream(fd)
    return {
      input,
      output,
      close: () => {
        input.destroy()
        output.destroy()
      },
    }
  } catch {
    return null
  }
}

/** Asks a question on the terminal. Hidden input never echoes; the terminal is always restored. */
function ask(question: string, { hidden = false } = {}): Promise<string> {
  const terminal = openTerminal()
  if (!terminal) throw new CliError(EXIT.usage, noTerminalHint)
  let muted = false
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) terminal.output.write(chunk, encoding)
      callback()
    },
  })
  const rl = createInterface({ input: terminal.input, output, terminal: true })
  return new Promise<string>((resolvePromise, reject) => {
    let answered = false
    const finish = () => {
      rl.close()
      terminal.close()
    }
    rl.on('SIGINT', () => {
      finish()
      terminal.output.write('\n')
      reject(new CliError(130, 'Cancelled'))
    })
    rl.on('close', () => {
      if (!answered) reject(new CliError(EXIT.usage, 'Cancelled'))
    })
    rl.question(question, answer => {
      answered = true
      if (hidden) terminal.output.write('\n')
      finish()
      resolvePromise(answer)
    })
    muted = hidden
  })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  // Exactly one trailing newline is removed (what `echo` or a text editor adds), nothing else.
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

// What to pass instead of answering a question, set per command before it asks anything.
let noTerminalHint = 'No terminal to ask on.'

const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generatePassword(length = 20): string {
  let password = ''
  for (let index = 0; index < length; index += 1) password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]
  return password
}

/** Gets a new password from the flags or the terminal. Returns it and whether it was generated. */
async function newPassword(parsed: Parsed): Promise<{ password: string; generated: boolean }> {
  if (parsed.flags.has('--generate') && parsed.flags.has('--password-stdin')) {
    throw new CliError(EXIT.usage, 'Use either --generate or --password-stdin')
  }
  if (parsed.flags.has('--generate')) return { password: generatePassword(), generated: true }
  let password: string
  if (parsed.flags.has('--password-stdin')) {
    password = await readStdin()
  } else {
    password = await ask('Password: ', { hidden: true })
    const again = await ask('Repeat password: ', { hidden: true })
    if (password !== again) throw new CliError(EXIT.usage, "The passwords don't match")
  }
  const problem = passwordProblem(password)
  if (problem) throw new CliError(EXIT.usage, problem)
  return { password, generated: false }
}

function describeClaim(counts: ClaimCounts): string {
  const parts = [`${counts.notes} note(s)`, `${counts.images} image(s)`]
  if (counts.favorites) parts.push('the font favorites')
  return parts.join(', ')
}

function when(time: number | null): string {
  if (time === null) return 'never'
  return new Date(time).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map(row => (row[column] ?? '').length))) ?? []
  return rows.map(row => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()).join('\n')
}

// ---- commands ----

async function run(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  const [command, ...args] = parsed.positional
  if (!command || command === 'help' || parsed.flags.has('--help')) {
    console.log(HELP)
    return
  }

  const dataDir = resolve(process.env.DATA_DIR ?? './data')
  const db = openDatabase(prepareDataDir(dataDir))
  const users = createUserStore(db)
  try {
    switch (command) {
      case 'add': {
        allowFlags(parsed, ['--generate', '--password-stdin', '--claim', '--no-claim'])
        arity(args, 1, 'add <name> [--generate | --password-stdin] [--claim | --no-claim]')
        const name = needName(args[0])
        if (users.find(name)) throw new CliError(EXIT.problem, `A user named "${name}" already exists`)
        let claim = false
        const legacy = users.legacyCounts()
        if (parsed.flags.has('--claim') && parsed.flags.has('--no-claim')) {
          throw new CliError(EXIT.usage, 'Use either --claim or --no-claim')
        }
        if (legacy.notes || legacy.images || legacy.favorites) {
          if (parsed.flags.has('--claim')) claim = true
          else if (!parsed.flags.has('--no-claim')) {
            noTerminalHint = `Margin has notes from before accounts. Without a terminal, add --claim (give them to ${name}) or --no-claim.`
            const answer = await ask(
              `Margin has ${describeClaim(legacy)} from before accounts. Give them to ${name}? [Y/n] `,
            )
            claim = !/^n/i.test(answer.trim())
          }
        } else if (parsed.flags.has('--claim') && users.legacyClaim().state !== 'pending') {
          console.log('(There is nothing from before accounts to claim.)')
        }
        noTerminalHint = 'No terminal to ask for the password on. Use --password-stdin or --generate.'
        const { password, generated } = await newPassword(parsed)
        // Hash before opening the transaction: scrypt takes a moment and must not hold the lock.
        const hash = await hashPassword(password)
        let claimed: ClaimCounts | null = null
        try {
          claimed = users.create(name, hash, { claim }).claimed
        } catch (error) {
          // Another `add` claimed the old notes first: still create this account, without them.
          if (!(claim && error instanceof UserError && /nothing from before accounts/.test(error.message))) throw error
          users.create(name, hash, { claim: false })
          console.log('(Another account claimed the notes from before accounts just now.)')
        }
        console.log(`Created ${name}.`)
        if (claimed) console.log(`${name} now owns ${describeClaim(claimed)} from before accounts.`)
        if (generated) console.log(`Password (shown only once): ${password}`)
        if (users.count() === 1) console.log('Sign in at http://<this computer>:5555')
        break
      }
      case 'list': {
        allowFlags(parsed, [])
        arity(args, 0, 'list')
        const list = users.list()
        if (list.length === 0) {
          console.log('No accounts yet. Create one with: margin-user add <name>')
        } else {
          const rows = [['USER', 'CREATED', 'NOTES', 'IMAGES', 'STYLES', 'SESSIONS', 'LAST SEEN (approx.)']]
          for (const user of list) {
            rows.push([
              user.username,
              when(user.createdAt),
              String(user.notes),
              String(user.images),
              String(user.styles),
              String(user.sessions),
              when(user.lastSeen),
            ])
          }
          console.log(table(rows))
        }
        const legacy = users.legacyCounts()
        if (legacy.notes || legacy.images) {
          console.log(`\n${describeClaim(legacy)} from before accounts are unclaimed: margin-user claim <name>`)
        }
        break
      }
      case 'passwd': {
        allowFlags(parsed, ['--generate', '--password-stdin'])
        arity(args, 1, 'passwd <name> [--generate | --password-stdin]')
        noTerminalHint = 'No terminal to ask for the password on. Use --password-stdin or --generate.'
        const name = needName(args[0])
        users.require(name)
        const { password, generated } = await newPassword(parsed)
        users.setPassword(name, await hashPassword(password))
        console.log(`Changed the password for ${name} and signed them out everywhere.`)
        if (generated) console.log(`Password (shown only once): ${password}`)
        break
      }
      case 'rename': {
        allowFlags(parsed, [])
        arity(args, 2, 'rename <name> <new-name>')
        const from = needName(args[0])
        const to = needName(args[1], 'the new name')
        users.rename(from, to)
        console.log(`Renamed ${from} to ${to}.`)
        break
      }
      case 'logout': {
        allowFlags(parsed, [])
        arity(args, 1, 'logout <name>')
        const name = needName(args[0])
        const count = users.logout(name)
        console.log(`Signed ${name} out of ${count} session(s).`)
        break
      }
      case 'sessions': {
        allowFlags(parsed, [])
        arity(args, 1, 'sessions <name>')
        const name = needName(args[0])
        const list = users.sessions(name)
        if (list.length === 0) console.log(`${name} isn't signed in anywhere.`)
        else {
          const rows = [['SIGNED IN', 'LAST SEEN (approx.)', 'EXPIRES', 'BROWSER']]
          for (const session of list) {
            rows.push([when(session.createdAt), when(session.lastSeen), when(session.expiresAt), cleanUserAgent(session.userAgent).slice(0, 80)])
          }
          console.log(table(rows))
        }
        break
      }
      case 'delete': {
        allowFlags(parsed, ['--transfer-to', '--purge', '--yes'])
        arity(args, 1, 'delete <name> (--transfer-to <other> | --purge) [--yes]')
        noTerminalHint = 'No terminal to confirm on. Add --yes (a --purge that deletes notes always needs a terminal).'
        const name = needName(args[0])
        const transfer = parsed.flags.get('--transfer-to')
        const purge = parsed.flags.has('--purge')
        if (transfer !== undefined && purge) throw new CliError(EXIT.usage, 'Use either --transfer-to or --purge')
        const transferTo = typeof transfer === 'string' ? needName(transfer, 'a user to transfer to') : undefined
        const owned = users.owned(name)
        const ownsAnything = owned.notes + owned.images + owned.favorites + owned.styles > 0
        const inventory =
          `${owned.notes} note(s), ${owned.images} image(s), ${owned.styles} style(s) and ${owned.favorites} favorite font(s)`
        if (!purge && transferTo === undefined && ownsAnything) {
          throw new CliError(EXIT.problem, `${name} owns ${inventory}. Use --transfer-to <user> to keep them, or --purge to delete them.`)
        }
        if (purge && ownsAnything) {
          // Typing the name is required even with --yes: this can't be undone.
          console.log(`This permanently deletes ${name} and their ${inventory}.`)
          const answer = await ask(`Type ${name} to confirm: `)
          if (answer.trim().toLowerCase() !== name) throw new CliError(EXIT.problem, 'Not confirmed; nothing was deleted')
        } else if (!parsed.flags.has('--yes')) {
          const what = transferTo ? `Delete ${name} and give their notes to ${transferTo}?` : `Delete ${name}?`
          const answer = await ask(`${what} [y/N] `)
          if (!/^y/i.test(answer.trim())) throw new CliError(EXIT.problem, 'Not confirmed; nothing was deleted')
        }
        const result = users.delete(name, { transferTo, purge })
        if (transferTo) {
          console.log(`Deleted ${name}; ${transferTo} now has their ${result.notes} note(s), ${result.images} image(s) and ${result.styles} style(s).`)
        }
        else console.log(`Deleted ${name}${result.notes + result.images ? ` and ${result.notes} note(s)` : ''}.`)
        break
      }
      case 'claim': {
        allowFlags(parsed, [])
        arity(args, 1, 'claim <name>')
        const name = needName(args[0])
        const counts = users.claim(name)
        console.log(`${name} now owns ${describeClaim(counts)} from before accounts.`)
        break
      }
      case 'reassign': {
        allowFlags(parsed, [])
        arity(args, 2, 'reassign <from> <to>')
        const from = needName(args[0])
        const to = needName(args[1], 'the user to move them to')
        const result = users.reassign(from, to)
        console.log(`Moved ${result.notes} note(s), ${result.images} image(s) and ${result.styles} style(s) from ${from} to ${to}.`)
        break
      }
      default:
        throw new CliError(EXIT.usage, `Unknown command "${command}". See margin-user --help`)
    }
  } finally {
    db.close()
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)
}

run(process.argv.slice(2)).then(
  () => process.exit(EXIT.ok),
  (error: unknown) => {
    if (error instanceof CliError) {
      if (error.message) console.error(error.message)
      process.exit(error.code)
    }
    if (error instanceof UserError) {
      console.error(error.message)
      process.exit(error.kind === 'usage' ? EXIT.usage : EXIT.problem)
    }
    if (isBusy(error)) {
      console.error('Margin is busy right now. Try again in a moment.')
      process.exit(EXIT.busy)
    }
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(EXIT.problem)
  },
)
