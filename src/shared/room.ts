// The authoritative game room — pure logic, no I/O. The Durable Object
// (src/server.ts) wires real WebSockets, timers and a clock into a RoomEnv and
// hands every client message here; the unit tests wire fakes into the same
// interface. This is the moved-to-the-server version of the state machine that
// used to run on every peer (the old client's "host" picked; now the room does).

import {
  MIN_FINGERS, HOLD_MS, REVEAL_MAX_MS,
  MIN_WINNERS, MAX_WINNERS, MIN_GROUPS, MAX_GROUPS,
  fingerKey, sanitizeName,
} from './chooser.ts'
import type {
  ClientMessage, ServerMessage, Mode, Phase, Fingers, PeerSnapshot,
} from './protocol.ts'

export interface RoomEnv {
  now(): number
  // Schedule onTimer() to fire once after `delayMs`. A later setTimer (or
  // clearTimer) replaces any pending one — the room only ever wants one timer.
  setTimer(delayMs: number): void
  clearTimer(): void
  send(clientId: string, msg: ServerMessage): void
  broadcast(msg: ServerMessage, exceptId?: string): void
  // A fresh uint32 seed for a pick/group reveal.
  randomSeed(): number
}

interface Client {
  id: string
  name: string | null
  fingers: Fingers
}

type TimerKind = 'pick' | 'reset'

export class RoomState {
  readonly clients = new Map<string, Client>()
  phase: Phase = 'idle'
  stableSince = 0
  mode: Mode = 'winners'
  winnerCount = 1
  groupCount = 2

  private lastSig = ''
  private timerKind: TimerKind | null = null
  private readonly env: RoomEnv

  constructor(env: RoomEnv) {
    this.env = env
  }

  // ---- connection lifecycle ----

  join(id: string, name: string | null): void {
    const client: Client = { id, name: sanitizeName(name), fingers: {} }
    this.clients.set(id, client)

    const peers: PeerSnapshot[] = []
    for (const c of this.clients.values()) {
      if (c.id !== id) peers.push({ id: c.id, name: c.name, fingers: c.fingers })
    }
    this.env.send(id, {
      t: 'welcome',
      selfId: id,
      phase: this.phase,
      stableSince: this.stableSince,
      serverNow: this.env.now(),
      mode: this.mode,
      winnerCount: this.winnerCount,
      groupCount: this.groupCount,
      peers,
    })
    this.env.broadcast({ t: 'peerJoin', id, name: client.name }, id)
  }

  leave(id: string): void {
    if (!this.clients.delete(id)) return
    this.env.broadcast({ t: 'peerLeave', id })
    this.fingersChanged()
  }

  // ---- client messages ----

  onMessage(id: string, msg: ClientMessage): void {
    const client = this.clients.get(id)
    if (!client) return
    switch (msg.t) {
      case 'fingers':
        client.fingers = sanitizeFingers(msg.fingers)
        this.env.broadcast({ t: 'fingers', id, fingers: client.fingers }, id)
        this.fingersChanged()
        break
      case 'name':
        client.name = sanitizeName(msg.name)
        this.env.broadcast({ t: 'name', id, name: client.name }, id)
        break
      case 'mode':
        this.applyMode(id, msg)
        break
    }
  }

  // Timer dispatch — the DO calls this when the scheduled timer fires.
  onTimer(): void {
    const kind = this.timerKind
    this.timerKind = null
    if (kind === 'pick') this.firePick()
    else if (kind === 'reset') this.armOrIdle() // re-evaluate; re-arms if still held
  }

  // ---- internals ----

  private applyMode(senderId: string, m: { mode: Mode; winnerCount: number; groupCount: number }): void {
    if (m.mode === 'winners' || m.mode === 'groups') this.mode = m.mode
    if (Number.isFinite(m.winnerCount)) {
      this.winnerCount = clamp(Math.floor(m.winnerCount), MIN_WINNERS, MAX_WINNERS)
    }
    if (Number.isFinite(m.groupCount)) {
      this.groupCount = clamp(Math.floor(m.groupCount), MIN_GROUPS, MAX_GROUPS)
    }
    this.env.broadcast({
      t: 'mode',
      mode: this.mode,
      winnerCount: this.winnerCount,
      groupCount: this.groupCount,
    }, senderId)
    // Switching mode mid-reveal clears it, mirroring the original client.
    if (this.phase === 'picked') this.armOrIdle()
  }

  private allKeys(): string[] {
    const keys: string[] = []
    for (const c of this.clients.values()) {
      for (const fingerId of Object.keys(c.fingers)) keys.push(fingerKey(c.id, fingerId))
    }
    return keys
  }

  private sig(keys: string[]): string {
    return [...keys].sort().join('|')
  }

  // Called whenever the set of fingers might have changed.
  private fingersChanged(): void {
    const sig = this.sig(this.allKeys())
    // While a reveal is showing, hold it until the finger SET changes (the
    // client lingers the reveal visually for a moment after fingers lift).
    if (this.phase === 'picked') {
      if (sig === this.lastSig) return
    } else if (sig === this.lastSig) {
      return // same fingers, just moved — nothing structural changed
    }
    this.armOrIdle()
  }

  // Re-evaluate from the current fingers with a fresh stability window: arm a
  // countdown if at least MIN_FINGERS are down, otherwise go idle.
  private armOrIdle(): void {
    const keys = this.allKeys()
    this.lastSig = this.sig(keys)
    this.stableSince = this.env.now()
    this.env.clearTimer()
    if (keys.length >= MIN_FINGERS) {
      this.phase = 'armed'
      this.timerKind = 'pick'
      this.env.setTimer(HOLD_MS)
    } else {
      this.phase = 'idle'
      this.timerKind = null
    }
    this.broadcastPhase()
  }

  private firePick(): void {
    const keys = this.allKeys()
    if (keys.length < MIN_FINGERS) {
      this.armOrIdle()
      return
    }
    const seed = this.env.randomSeed()
    if (this.mode === 'groups') {
      this.env.broadcast({ t: 'group', seed, keys, count: this.groupCount })
    } else {
      this.env.broadcast({ t: 'pick', seed, keys, count: this.winnerCount })
    }
    this.phase = 'picked'
    this.lastSig = this.sig(keys) // lock the current set; reveal ends when it changes
    this.timerKind = 'reset'
    this.env.setTimer(REVEAL_MAX_MS)
    this.broadcastPhase()
  }

  private broadcastPhase(): void {
    this.env.broadcast({
      t: 'phase',
      phase: this.phase,
      stableSince: this.stableSince,
      serverNow: this.env.now(),
    })
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

// Keep only well-formed [x, y] pairs with finite, 0..1-ish coordinates so a
// misbehaving client can't poison the shared finger set.
function sanitizeFingers(raw: unknown): Fingers {
  const out: Fingers = {}
  if (!raw || typeof raw !== 'object') return out
  let count = 0
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 64) break // cap fingers per device
    if (!Array.isArray(val) || val.length !== 2) continue
    const [x, y] = val
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue
    out[String(id).slice(0, 16)] = [clamp(x, 0, 1), clamp(y, 0, 1)]
    count++
  }
  return out
}
