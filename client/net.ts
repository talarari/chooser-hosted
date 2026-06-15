// Networking layer: a single WebSocket to the room's Durable Object. The server
// is authoritative — we report our own fingers / name / settings and apply
// whatever phase changes and pick results the server broadcasts back. No more
// WebRTC, signaling relays or TURN: one socket to one server instance per room.

import type {
  ClientMessage, ServerMessage, Fingers, ModeSettings,
} from '../src/shared/protocol.ts'

export type ConnStatus = 'connecting' | 'connected' | 'closed'

export interface NetHandlers {
  onMessage: (msg: ServerMessage) => void
  onStatus: (status: ConnStatus) => void
}

// A test seam: `?ws=ws://host:port` overrides the WebSocket origin so the e2e
// can point at a local server. Production derives it from the page origin.
function wsBase(): string {
  try {
    const override = new URLSearchParams(location.search).get('ws')
    if (override) return override.replace(/\/$/, '')
  } catch {}
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}`
}

export interface Net {
  selfId: string | null
  sendFingers(fingers: Fingers): void
  sendName(name: string | null): void
  sendMode(settings: ModeSettings): void
  // Drop the current socket and immediately open a fresh one (used on resume
  // from a backgrounded tab, where the old socket may be silently dead).
  reconnect(): void
  leave(): void
}

// App-level keepalive so the server can tell a live client from a silently dead
// socket and reap the latter. Comfortably under typical idle-socket timeouts.
const PING_MS = 5000

export function connect(roomCode: string, getName: () => string | null, handlers: NetHandlers): Net {
  let ws: WebSocket | null = null
  let closed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoff = 500

  const pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ t: 'ping' })) } catch {}
    }
  }, PING_MS)

  const net: Net = {
    selfId: null,
    sendFingers: (fingers) => send({ t: 'fingers', fingers }),
    sendName: (name) => send({ t: 'name', name }),
    sendMode: (settings) => send({ t: 'mode', ...settings }),
    reconnect: () => {
      if (closed) return
      const old = ws
      ws = null // so the old socket's close handler no-ops (sock !== ws)
      try { old?.close() } catch {}
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      backoff = 500
      open()
    },
    leave: () => {
      closed = true
      clearInterval(pingTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { ws?.close() } catch {}
      ws = null
    },
  }

  function send(msg: ClientMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)) } catch {}
    }
  }

  function open(): void {
    if (closed) return
    handlers.onStatus('connecting')
    const name = getName()
    const url = `${wsBase()}/ws?room=${encodeURIComponent(roomCode)}` +
      (name ? `&name=${encodeURIComponent(name)}` : '')
    const sock = new WebSocket(url)
    ws = sock

    sock.addEventListener('open', () => {
      backoff = 500
      handlers.onStatus('connected')
    })
    sock.addEventListener('message', (event) => {
      let msg: ServerMessage
      try { msg = JSON.parse(event.data as string) as ServerMessage } catch { return }
      if (msg.t === 'welcome') net.selfId = msg.selfId
      handlers.onMessage(msg)
    })
    sock.addEventListener('close', () => {
      if (sock !== ws) return
      ws = null
      if (closed) return
      handlers.onStatus('closed')
      reconnectTimer = setTimeout(open, backoff)
      backoff = Math.min(backoff * 2, 5000)
    })
    sock.addEventListener('error', () => { try { sock.close() } catch {} })
  }

  open()
  return net
}
