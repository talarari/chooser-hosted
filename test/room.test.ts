// Drives the authoritative room state machine (src/shared/room.ts) with a fake
// clock, timer and transport — the server-side counterpart of the old client
// smoke test. Covers a full round (hold -> pick -> reveal -> reset), groups
// mode, winner counts, settings sync and connection lifecycle.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RoomState } from '../src/shared/room.ts'
import type { RoomEnv } from '../src/shared/room.ts'
import type { ServerMessage } from '../src/shared/protocol.ts'
import { HOLD_MS, REVEAL_MAX_MS } from '../src/shared/chooser.ts'

function makeRoom(seed = 12345) {
  let now = 0
  let timer: { at: number } | null = null
  const sent: { to: string; msg: ServerMessage }[] = []
  const broadcasts: { msg: ServerMessage; except?: string }[] = []

  const env: RoomEnv = {
    now: () => now,
    setTimer: (ms) => { timer = { at: now + Math.max(0, ms) } },
    clearTimer: () => { timer = null },
    send: (to, msg) => sent.push({ to, msg }),
    broadcast: (msg, except) => broadcasts.push({ msg, except }),
    randomSeed: () => seed,
  }
  const room = new RoomState(env)

  return {
    room,
    sent,
    broadcasts,
    get now() { return now },
    // Advance the clock, firing any timers that come due (in order).
    advance(ms: number) {
      const target = now + ms
      while (timer && timer.at <= target) {
        now = timer.at
        timer = null
        room.onTimer()
      }
      now = target
    },
    hasTimer() { return timer !== null },
    bcasts<T extends ServerMessage['t']>(t: T) {
      return broadcasts.filter((b) => b.msg.t === t).map((b) => b.msg) as Extract<ServerMessage, { t: T }>[]
    },
    lastBcast<T extends ServerMessage['t']>(t: T) {
      const all = this.bcasts(t)
      return all.length ? all[all.length - 1] : undefined
    },
  }
}

test('join welcomes the newcomer with a snapshot and announces them', () => {
  const h = makeRoom()
  h.room.join('aaa', 'Alice')

  const welcome = h.sent.find((s) => s.to === 'aaa' && s.msg.t === 'welcome')
  assert.ok(welcome, 'newcomer gets a welcome')
  assert.equal((welcome!.msg as Extract<ServerMessage, { t: 'welcome' }>).selfId, 'aaa')
  assert.deepEqual((welcome!.msg as Extract<ServerMessage, { t: 'welcome' }>).peers, [])

  h.room.join('bbb', 'Bob')
  const welcomeB = h.sent.find((s) => s.to === 'bbb' && s.msg.t === 'welcome')!.msg as Extract<ServerMessage, { t: 'welcome' }>
  assert.equal(welcomeB.peers.length, 1, 'second joiner sees the first as a peer')
  assert.equal(welcomeB.peers[0].id, 'aaa')

  const joins = h.bcasts('peerJoin')
  assert.ok(joins.some((m) => m.id === 'bbb'), 'others are told a peer joined')
})

test('a full round: two fingers held -> pick -> reveal -> reset', () => {
  const h = makeRoom()
  h.room.join('aaa', 'Alice')
  h.room.join('bbb', 'Bob')

  // one finger each: two fingers across devices arms the countdown
  h.room.onMessage('aaa', { t: 'fingers', fingers: { '1': [0.3, 0.3] } })
  h.room.onMessage('bbb', { t: 'fingers', fingers: { '1': [0.7, 0.7] } })

  const armed = h.lastBcast('phase')
  assert.equal(armed?.phase, 'armed', 'two fingers arm the room')
  assert.ok(h.hasTimer(), 'a pick timer is pending')

  // hold past HOLD_MS -> the room fires the pick
  h.advance(HOLD_MS)
  const pick = h.lastBcast('pick')
  assert.ok(pick, 'the room broadcasts a pick after the hold')
  assert.equal(pick!.keys.length, 2, 'pick covers both fingers')
  assert.deepEqual([...pick!.keys].sort(), ['aaa/1', 'bbb/1'])
  assert.equal(pick!.count, 1)
  assert.equal(h.lastBcast('phase')?.phase, 'picked')

  // everyone lifts; the finger set changes -> room returns to idle
  h.room.onMessage('aaa', { t: 'fingers', fingers: {} })
  h.room.onMessage('bbb', { t: 'fingers', fingers: {} })
  assert.equal(h.lastBcast('phase')?.phase, 'idle', 'round resets when fingers lift')
})

test('a single finger never arms or picks', () => {
  const h = makeRoom()
  h.room.join('aaa', null)
  h.room.onMessage('aaa', { t: 'fingers', fingers: { '1': [0.5, 0.5] } })
  assert.equal(h.lastBcast('phase')?.phase ?? 'idle', 'idle')
  h.advance(HOLD_MS * 2)
  assert.equal(h.bcasts('pick').length, 0, 'no pick with one finger')
})

test('groups mode divides instead of picking a winner', () => {
  const h = makeRoom()
  h.room.join('aaa', null)
  h.room.join('bbb', null)
  h.room.onMessage('aaa', { t: 'mode', mode: 'groups', winnerCount: 1, groupCount: 3 })

  const modeMsg = h.lastBcast('mode')
  assert.equal(modeMsg?.mode, 'groups')
  assert.equal(modeMsg?.groupCount, 3)

  h.room.onMessage('aaa', { t: 'fingers', fingers: { '1': [0.3, 0.3], '2': [0.4, 0.4] } })
  h.room.onMessage('bbb', { t: 'fingers', fingers: { '1': [0.7, 0.7] } })
  h.advance(HOLD_MS)

  const group = h.lastBcast('group')
  assert.ok(group, 'groups mode broadcasts a group division')
  assert.equal(group!.count, 3)
  assert.equal(group!.keys.length, 3)
  assert.equal(h.bcasts('pick').length, 0, 'no winner is picked in groups mode')
})

test('winner count is clamped and echoed to the room', () => {
  const h = makeRoom()
  h.room.join('aaa', null)
  h.room.onMessage('aaa', { t: 'mode', mode: 'winners', winnerCount: 99, groupCount: 2 })
  assert.equal(h.lastBcast('mode')?.winnerCount, 8, 'winner count clamps to MAX_WINNERS')

  h.room.join('bbb', null)
  h.room.onMessage('aaa', { t: 'fingers', fingers: { '1': [0.3, 0.3], '2': [0.5, 0.5] } })
  h.room.onMessage('bbb', { t: 'fingers', fingers: { '1': [0.7, 0.7] } })
  h.advance(HOLD_MS)
  assert.equal(h.lastBcast('pick')?.count, 8, 'the pick carries the clamped winner count')
})

test('changing the finger set restarts the hold', () => {
  const h = makeRoom()
  h.room.join('aaa', null)
  h.room.onMessage('aaa', { t: 'fingers', fingers: { '1': [0.3, 0.3], '2': [0.4, 0.4] } })
  h.advance(HOLD_MS / 2)
  // a third finger lands: the stability window resets
  h.room.onMessage('aaa', { t: 'fingers', fingers: { '1': [0.3, 0.3], '2': [0.4, 0.4], '3': [0.5, 0.5] } })
  h.advance(HOLD_MS / 2)
  assert.equal(h.bcasts('pick').length, 0, 'pick should not fire until a fresh full hold')
  h.advance(HOLD_MS / 2)
  assert.equal(h.bcasts('pick').length, 1, 'pick fires once the new hold completes')
})

test('holding continuously through the reveal re-arms for another round', () => {
  const h = makeRoom()
  h.room.join('aaa', null)
  h.room.join('bbb', null)
  h.room.onMessage('aaa', { t: 'fingers', fingers: { '1': [0.3, 0.3] } })
  h.room.onMessage('bbb', { t: 'fingers', fingers: { '1': [0.7, 0.7] } })
  h.advance(HOLD_MS)
  assert.equal(h.bcasts('pick').length, 1)

  // keep holding the exact same fingers; after REVEAL_MAX the reveal clears and
  // the still-held fingers arm a fresh countdown that picks again.
  h.advance(REVEAL_MAX_MS)
  assert.equal(h.lastBcast('phase')?.phase, 'armed', 're-arms while still held')
  h.advance(HOLD_MS)
  assert.equal(h.bcasts('pick').length, 2, 'a second pick fires on the continued hold')
})

test('name changes are sanitized and broadcast', () => {
  const h = makeRoom()
  h.room.join('aaa', null)
  h.room.onMessage('aaa', { t: 'name', name: '  Cool   Cucumber  ' })
  const name = h.lastBcast('name')
  assert.equal(name?.id, 'aaa')
  assert.equal(name?.name, 'Cool Cucumber')
})

test('leaving announces a departure and recomputes', () => {
  const h = makeRoom()
  h.room.join('aaa', null)
  h.room.join('bbb', null)
  h.room.onMessage('aaa', { t: 'fingers', fingers: { '1': [0.3, 0.3] } })
  h.room.onMessage('bbb', { t: 'fingers', fingers: { '1': [0.7, 0.7] } })
  assert.equal(h.lastBcast('phase')?.phase, 'armed')

  h.room.leave('bbb')
  assert.ok(h.bcasts('peerLeave').some((m) => m.id === 'bbb'), 'departure is announced')
  assert.equal(h.lastBcast('phase')?.phase, 'idle', 'one finger left -> idle')
  assert.equal(h.room.clients.size, 1)
})
