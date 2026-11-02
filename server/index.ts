import type { Server } from 'node:http'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createSessionStore } from './auth.ts'
import { dataPaths, openDatabase, prepareDataDir } from './db.ts'
import { createFontService, loadFontCatalog } from './fonts.ts'
import { createImageStore } from './images.ts'
import { createUserStore } from './users.ts'

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 5555)
// The port the browser sees. In dev, Vite serves 5555 and proxies /api to this server.
const publicPort = process.env.PUBLIC_PORT ?? '5555'
const dataDir = resolve(process.env.DATA_DIR ?? './data')
const staticDir = resolve(process.env.STATIC_DIR ?? 'dist/web')
// FONT_DOWNLOADS=off: never contact Google; fonts already cached keep working.
const fontDownloads = (process.env.FONT_DOWNLOADS ?? 'on').toLowerCase() !== 'off'
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

// Extra host names (e.g. mybox.local) on top of localhost and IP addresses, which always work.
const extraHosts = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
const secureCookies = (process.env.COOKIE_SECURE ?? 'off').toLowerCase() === 'on'

const db = openDatabase(prepareDataDir(dataDir))
const paths = dataPaths(dataDir)
const images = createImageStore({ db, dir: paths.images, trashDir: paths.imageTrash })
const fonts = createFontService({ db, dir: paths.fonts, catalog: loadFontCatalog(), downloads: fontDownloads })
const app = createApp({
  db,
  hosts: { ports: [publicPort, String(port)], extraHosts },
  images,
  fonts,
  staticDir,
  cookieName: `margin_session_${publicPort}`,
  secureCookies,
})
const sessions = createSessionStore(db)
const users = createUserStore(db)

function maintenance(): void {
  try {
    const result = images.sweep()
    if (result.trashed || result.purged || result.restored || result.healed) {
      console.log(`Image cleanup: ${JSON.stringify(result)}`)
    }
  } catch (error) {
    console.error('Image cleanup failed', error)
  }
  try {
    sessions.removeExpired()
  } catch (error) {
    console.error('Session cleanup failed', error)
  }
  const legacy = users.legacyCounts()
  if (legacy.notes || legacy.images) {
    console.log(
      `${legacy.notes} note(s) and ${legacy.images} image(s) from before accounts are waiting to be claimed: ` +
        'run "margin-user add <name>" (first account) or "margin-user claim <name>"',
    )
  } else if (users.count() === 0) {
    console.log('No accounts yet: create one with "margin-user add <name>"')
  }
}
maintenance()
const sweepTimer = setInterval(maintenance, SWEEP_INTERVAL_MS)
sweepTimer.unref()

const server = serve({ fetch: app.fetch, hostname: host, port }, info => {
  console.log(`Margin listening on http://${info.address}:${info.port} (data: ${dataDir})`)
}) as Server

let shuttingDown = false

function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received, shutting down`)

  clearInterval(sweepTimer)
  server.close(() => {
    db.close()
    process.exit(0)
  })
  // Keep-alive sockets would otherwise hold close() open until they time out.
  server.closeIdleConnections()
  setTimeout(() => server.closeAllConnections(), 3000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
