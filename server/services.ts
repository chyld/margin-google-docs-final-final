// The server's data stores, built once from the database: the app's routes and the maintenance
// loop in index.ts share the same instances. (images and fonts also need folders and options, so
// they stay separate; margin-user builds just the store it needs.)
import type { DatabaseSync } from 'node:sqlite'
import { createSessionStore } from './auth.ts'
import { createNoteStore } from './notes.ts'
import { createStyleStore } from './styles.ts'
import { createUserStore } from './users.ts'

export function createServices(db: DatabaseSync) {
  return {
    notes: createNoteStore(db),
    sessions: createSessionStore(db),
    users: createUserStore(db),
    styles: createStyleStore(db),
  }
}

export type Services = ReturnType<typeof createServices>
