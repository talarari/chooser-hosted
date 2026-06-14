// Boots the real app for the e2e: builds the client into public/ then runs the
// Worker (with its Durable Object) under `wrangler dev` in local mode. The
// browser pages talk to it exactly as in production — static assets over HTTP,
// game traffic over a WebSocket to the room's Durable Object.
import { spawn, execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function waitForReady(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`server at ${url} did not become ready in ${timeoutMs}ms`)
}

export async function startServer(port = 8788) {
  // Build the static client the Worker will serve.
  execSync('node build.mjs', { cwd: repo, stdio: 'inherit' })

  const proc = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--log-level', 'warn'],
    { cwd: repo, stdio: 'inherit', detached: true },
  )

  const url = `http://127.0.0.1:${port}`
  try {
    await waitForReady(url)
  } catch (err) {
    try { process.kill(-proc.pid) } catch {}
    throw err
  }

  return {
    url,
    close: () => new Promise((resolve) => {
      proc.on('exit', () => resolve())
      try { process.kill(-proc.pid) } catch { resolve() }
    }),
  }
}
