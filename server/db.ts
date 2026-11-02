import { accessSync, constants, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Each entry upgrades the schema by one version. Never edit a shipped migration; append a new one.
const MIGRATIONS = [
  `
  CREATE TABLE notes (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL,
    text        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX notes_updated_at ON notes (updated_at DESC, id DESC);
  `,
  // Migration 2: uploaded images (files live in DATA_DIR/images) and app settings such as font favorites.
  `
  CREATE TABLE images (
    id                  TEXT PRIMARY KEY,
    ext                 TEXT NOT NULL,
    bytes               INTEGER NOT NULL,
    created_at          INTEGER NOT NULL,
    unreferenced_since  INTEGER,
    trashed_at          INTEGER
  );
  CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  `,
  // Migration 3: accounts. Notes from before accounts keep user_id NULL (hidden); they were given to
  // an account with `margin-user claim` (removed after Phase 8). The legacyClaim setting is unread now.
  `
  CREATE TABLE users (
    id                   TEXT PRIMARY KEY,
    username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash        TEXT NOT NULL,
    created_at           INTEGER NOT NULL,
    password_changed_at  INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    user_agent    TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions (user_id);
  ALTER TABLE notes ADD COLUMN user_id TEXT;
  CREATE INDEX notes_user_updated ON notes (user_id, updated_at DESC, id DESC);
  CREATE TABLE image_owners (
    image_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (image_id, user_id)
  );
  CREATE INDEX image_owners_user ON image_owners (user_id);
  CREATE TABLE user_settings (
    user_id  TEXT NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  INSERT INTO settings (key, value)
  SELECT 'legacyClaim',
    CASE
      WHEN EXISTS (SELECT 1 FROM notes) OR EXISTS (SELECT 1 FROM images)
        OR EXISTS (SELECT 1 FROM settings WHERE key = 'fontFavorites')
      THEN json_object('state', 'pending', 'migratedAt', CAST(unixepoch('subsec') * 1000 AS INTEGER))
      ELSE json_object('state', 'none')
    END;
  `,
  // Migration 4: saved styles. Deleted styles stay (deleted_at) so text that uses them keeps its look.
  `
  CREATE TABLE styles (
    id             TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    name           TEXT NOT NULL,
    name_key       TEXT NOT NULL,
    props          TEXT NOT NULL,
    favorite_slot  INTEGER,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    deleted_at     INTEGER,
    PRIMARY KEY (user_id, id)
  );
  CREATE UNIQUE INDEX styles_live_name ON styles (user_id, name_key) WHERE deleted_at IS NULL;
  `,
  // Migration 5: note tags (shared/tags.ts rules). user_id is always the note owner's, kept in step by
  // notes.ts and users.ts (the schema declares no foreign keys).
  `
  CREATE TABLE note_tags (
    note_id  TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    tag      TEXT NOT NULL,
    PRIMARY KEY (note_id, tag)
  );
  CREATE INDEX note_tags_user_tag ON note_tags (user_id, tag, note_id);
  `,
]

export const SCHEMA_VERSION = MIGRATIONS.length

/** Folders inside the data directory. */
export function dataPaths(dataDir: string) {
  return {
    database: join(dataDir, 'margin.db'),
    images: join(dataDir, 'images'),
    imageTrash: join(dataDir, 'images', '.trash'),
    fonts: join(dataDir, 'fonts'),
  }
}

/** Creates the data directory and its folders if needed, and returns the database file path. */
export function prepareDataDir(dataDir: string): string {
  const paths = dataPaths(dataDir)
  try {
    for (const dir of [dataDir, paths.images, paths.imageTrash, paths.fonts]) {
      mkdirSync(dir, { recursive: true })
      accessSync(dir, constants.W_OK)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Data directory "${dataDir}" is not writable (${reason}). ` +
        'If it is a Docker volume created by root, fix its ownership (chown 1000:1000) or recreate the volume.',
    )
  }
  return paths.database
}

// Switching to WAL needs a moment of exclusive access and doesn't wait for the busy timeout, so a
// second process (the server and margin-user starting together) retries briefly. WAL is persistent:
// once a database is in WAL mode, this is a no-op.
function enableWal(db: DatabaseSync): void {
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL')
      return
    } catch (error) {
      if (!(error instanceof Error && /locked|busy/i.test(error.message)) || Date.now() > deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

/** Opens the database (a file path or ":memory:") and brings its schema up to date. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 5000 })
  enableWal(db)
  migrate(db)
  return db
}

function readVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function checkVersion(version: number): void {
  if (version > MIGRATIONS.length) {
    throw new Error(
      `Database schema version ${version} is newer than this version of Margin supports (${MIGRATIONS.length}).`,
    )
  }
}

/** Runs `work` inside BEGIN IMMEDIATE, so checks and writes can't interleave with another process. */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// The server and the margin-user command can start at the same moment, so the version is read again
// after taking the write lock: whoever comes second sees the other's work and skips it.
function migrate(db: DatabaseSync): void {
  checkVersion(readVersion(db))
  if (readVersion(db) === MIGRATIONS.length) return
  transaction(db, () => {
    const current = readVersion(db)
    checkVersion(current)
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      db.exec(MIGRATIONS[version] as string)
      db.exec(`PRAGMA user_version = ${version + 1}`)
    }
  })
}
