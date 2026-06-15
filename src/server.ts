// Cloudflare Worker entrypoint + the per-room Durable Object.
//
// The Worker serves the static client (Workers Static Assets) for every normal
// request and upgrades `/ws?room=CODE` to a WebSocket handled by the room's
// Durable Object. `idFromName(roomCode)` maps a room code to exactly one DO
// instance, anywhere in the world — so every player in a room lands on the same
// instance, which holds the authoritative game state and all their sockets.

import { RoomState } from './shared/room.ts'
import type { RoomEnv } from './shared/room.ts'
import { normalizeCode } from './shared/chooser.ts'
import type { ClientMessage } from './shared/protocol.ts'

export interface Env {
  ROOM: DurableObjectNamespace
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') {
      const room = normalizeCode(url.searchParams.get('room'))
      if (!room) return new Response('missing or invalid room code', { status: 400 })
      const stub = env.ROOM.get(env.ROOM.idFromName(room))
      return stub.fetch(request)
    }
    // Everything else (index.html, app.js, styles.css, …) is a static asset.
    return env.ASSETS.fetch(request)
  },
}

// Reap a socket after this long with no message (incl. the client's keepalive
// ping every 5s). Mobile sockets often die without a close event; this is how a
// ghost client (and its stale fingers / inflated device count) gets cleaned up.
const IDLE_TIMEOUT_MS = 20000
const REAP_INTERVAL_MS = 5000

export class Room implements DurableObject {
  private room: RoomState
  private sockets = new Map<string, WebSocket>()
  private lastSeen = new Map<string, number>()
  private reaper: ReturnType<typeof setInterval> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(_state: DurableObjectState, _env: Env) {
    const env: RoomEnv = {
      now: () => Date.now(),
      setTimer: (delayMs) => {
        this.clearTimer()
        this.timer = setTimeout(() => {
          this.timer = null
          this.room.onTimer()
        }, Math.max(0, delayMs))
      },
      clearTimer: () => this.clearTimer(),
      send: (clientId, msg) => {
        const ws = this.sockets.get(clientId)
        if (ws) trySend(ws, JSON.stringify(msg))
      },
      broadcast: (msg, exceptId) => {
        const data = JSON.stringify(msg)
        for (const [id, ws] of this.sockets) {
          if (id !== exceptId) trySend(ws, data)
        }
      },
      randomSeed: () => (Math.random() * 2 ** 32) >>> 0,
    }
    this.room = new RoomState(env)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const id = crypto.randomUUID().slice(0, 8)
    const name = new URL(request.url).searchParams.get('name')

    server.accept()
    this.sockets.set(id, server)
    this.lastSeen.set(id, Date.now())
    this.room.join(id, name)
    this.startReaper()

    server.addEventListener('message', (event) => {
      this.lastSeen.set(id, Date.now())
      let msg: ClientMessage
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '') as ClientMessage
      } catch {
        return
      }
      if (msg.t === 'ping') return // keepalive only — already refreshed lastSeen
      this.room.onMessage(id, msg)
    })

    server.addEventListener('close', () => this.drop(id))
    server.addEventListener('error', () => this.drop(id))

    return new Response(null, { status: 101, webSocket: client })
  }

  private drop(id: string): void {
    this.lastSeen.delete(id)
    if (this.sockets.delete(id)) this.room.leave(id)
    if (this.sockets.size === 0) this.stopReaper()
  }

  // Periodically close sockets that have gone quiet — the only way to detect a
  // client that vanished without a clean close. Runs only while clients exist.
  private startReaper(): void {
    if (this.reaper !== null) return
    this.reaper = setInterval(() => {
      const now = Date.now()
      for (const [id, ts] of this.lastSeen) {
        if (now - ts > IDLE_TIMEOUT_MS) {
          try { this.sockets.get(id)?.close(1001, 'idle') } catch {}
          this.drop(id)
        }
      }
    }, REAP_INTERVAL_MS)
  }

  private stopReaper(): void {
    if (this.reaper !== null) {
      clearInterval(this.reaper)
      this.reaper = null
    }
  }
}

function trySend(ws: WebSocket, data: string): void {
  try {
    ws.send(data)
  } catch {
    // socket already closing/closed — the close handler will clean it up.
  }
}
