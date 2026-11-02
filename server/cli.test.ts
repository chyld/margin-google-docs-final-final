import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyPassword } from './auth.ts'
import { openDatabase, prepareDataDir } from './db.ts'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'margin-cli-'))
})

afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

type Result = { code: number; stdout: string; stderr: string }

/** Runs margin-user without a terminal (detached, so /dev/tty isn't available either). */
function cli(args: string[], stdin = ''): Promise<Result> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(process.cwd(), 'server/cli.ts'), ...args], {
      env: { ...process.env, DATA_DIR: dataDir },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('exit', code => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

function database(): DatabaseSync {
  return openDatabase(prepareDataDir(dataDir))
}

describe('margin-user', () => {
  it('prints help', async () => {
    const result = await cli(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('add <name>')
  })

  it('adds a user from stdin, stripping exactly one trailing newline', async () => {
    const result = await cli(['add', 'Alice', '--password-stdin'], ' spaced password \n')
    expect(result).toMatchObject({ code: 0 })
    expect(result.stdout).toContain('Created alice.')
    const db = database()
    const row = db.prepare("SELECT password_hash FROM users WHERE username = 'alice'").get() as { password_hash: string }
    db.close()
    expect((await verifyPassword(' spaced password ', row.password_hash)).ok).toBe(true)
    expect((await verifyPassword(' spaced password', row.password_hash)).ok).toBe(false)
  })

  it('generates a password and shows it once', async () => {
    const result = await cli(['add', 'bob', '--generate'])
    expect(result.code).toBe(0)
    const password = /Password \(shown only once\): (\S+)/.exec(result.stdout)?.[1] as string
    expect(password).toHaveLength(20)
    const db = database()
    const row = db.prepare("SELECT password_hash FROM users WHERE username = 'bob'").get() as { password_hash: string }
    db.close()
    expect((await verifyPassword(password, row.password_hash)).ok).toBe(true)
  })

  it('explains what to do without a terminal', async () => {
    const result = await cli(['add', 'carol'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/--password-stdin or --generate/)
  })

  it('rejects bad names, short passwords, duplicates and unknown options', async () => {
    expect((await cli(['add', 'bad name', '--generate'])).code).toBe(1)
    expect((await cli(['add', 'dave', '--password-stdin'], 'short')).code).toBe(1)
    expect((await cli(['add', 'dave', '--generate'])).code).toBe(0)
    const duplicate = await cli(['add', 'DAVE', '--generate'])
    expect(duplicate.code).toBe(2)
    expect(duplicate.stderr).toContain('already exists')
    expect((await cli(['add', 'erin', '--generat'])).code).toBe(1)
    // Extra names and values on yes/no flags are mistakes, not ignored.
    expect((await cli(['add', 'erin', 'frank', '--generate'])).stderr).toContain('Usage: margin-user add')
    expect((await cli(['delete', 'dave', 'erin', '--yes'])).code).toBe(1)
    expect((await cli(['delete', 'dave', '--purge=false'])).stderr).toContain("doesn't take a value")
    expect((await cli(['frobnicate'])).code).toBe(1)
    expect((await cli(['passwd', 'nobody', '--generate'])).code).toBe(2)
  })

  it('asks before claiming legacy notes, or takes --claim / --no-claim', async () => {
    const legacy = new DatabaseSync(join(dataDir, 'margin.db'))
    legacy.exec(`
      CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX notes_updated_at ON notes (updated_at DESC, id DESC);
      CREATE TABLE images (id TEXT PRIMARY KEY, ext TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL,
        unreferenced_since INTEGER, trashed_at INTEGER);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO notes VALUES ('n1', 'Old', '{}', '', 1, 1);
      PRAGMA user_version = 2;
    `)
    legacy.close()

    // No terminal to ask on, and no answer given.
    const unanswered = await cli(['add', 'chyld', '--generate'])
    expect(unanswered.code).toBe(1)
    expect(unanswered.stderr).toContain('--claim')
    const declined = await cli(['add', 'helper', '--generate', '--no-claim'])
    expect(declined.code).toBe(0)
    const list = await cli(['list'])
    expect(list.stdout).toContain('1 note(s), 0 image(s) from before accounts are unclaimed')

    const added = await cli(['add', 'chyld', '--generate', '--claim'])
    expect(added.stdout).toContain('chyld now owns 1 note(s), 0 image(s)')
    expect((await cli(['claim', 'chyld'])).code).toBe(2)
    expect((await cli(['list'])).stdout).toMatch(/chyld\s+.*\s1\s+0\s+0/)
  })

  it('changes passwords, renames, signs out, reassigns and deletes', async () => {
    await cli(['add', 'alice', '--generate'])
    await cli(['add', 'bob', '--generate'])
    const db = database()
    const alice = (db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: string }).id
    db.prepare("INSERT INTO notes (id, title, content, text, created_at, updated_at, user_id) VALUES ('n', '', '{}', '', 0, 0, ?)").run(alice)
    db.prepare("INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES ('s', ?, ?, ?, ?, ?)").run(
      alice,
      Date.now(),
      Date.now(),
      Date.now() + 86_400_000,
      'Evil\u001b[2J agent',
    )
    db.close()

    const sessions = await cli(['sessions', 'alice'])
    expect(sessions.stdout).toContain('Evil[2J agent')
    expect(sessions.stdout).not.toContain('\u001b')

    expect((await cli(['logout', 'alice'])).stdout).toContain('1 session(s)')
    expect((await cli(['passwd', 'alice', '--password-stdin'], 'a brand new password')).code).toBe(0)
    expect((await cli(['rename', 'alice', 'bob'])).code).toBe(2)
    expect((await cli(['rename', 'alice', 'alicia'])).code).toBe(0)

    // Refuses without a decision about the notes; --yes alone isn't enough.
    const refused = await cli(['delete', 'alicia', '--yes'])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('--transfer-to')
    // --purge needs the name typed, which can't happen without a terminal.
    expect((await cli(['delete', 'alicia', '--purge', '--yes'])).code).toBe(1)

    expect((await cli(['reassign', 'alicia', 'bob'])).stdout).toContain('Moved 1 note(s)')
    expect((await cli(['delete', 'alicia', '--yes'])).code).toBe(0)
    const remaining = await cli(['list'])
    expect(remaining.stdout).not.toContain('alicia')
    expect(remaining.stdout).toMatch(/bob\s+.*\s1\s+0\s+0/)
  })
})
