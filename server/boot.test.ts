// Starts the real server with plain `node`, catching type-stripping and ESM errors that tsc can't see.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

let child: ChildProcess | undefined
let dataDir: string | undefined

afterEach(() => {
  child?.kill('SIGTERM')
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

it('boots with plain node and answers the health check', async () => {
  const port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'margin-boot-'))
  child = spawn(process.execPath, ['server/index.ts'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, STATIC_DIR: join(dataDir, 'none') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout?.on('data', chunk => (output += chunk))
  child.stderr?.on('data', chunk => (output += chunk))

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      expect(await response.json()).toEqual({ ok: true })
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(`server did not answer in time:\n${output}`)
}, 15_000)
