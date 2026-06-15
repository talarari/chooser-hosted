import { connect } from './net.ts'
import type { Net, ConnStatus } from './net.ts'
import { draw } from './render.ts'
import type { RenderFinger } from './render.ts'
import { playCountdownTick, playWinnerReveal, playGroupReveal } from './audio.ts'
import {
  MIN_FINGERS, HOLD_MS, REVEAL_MIN_MS, GROUPS_REVEAL_MIN_MS, REVEAL_MAX_MS,
  MIN_GROUPS, MAX_GROUPS, MIN_WINNERS, MAX_WINNERS, NEUTRAL_COLOR,
  fingerKey, colorFor, peerName, sanitizeName, pickWinners, assignGroups, groupColor,
  randomCode, normalizeCode,
} from '../src/shared/chooser.ts'
import type { Mode, Phase, Fingers, ServerMessage } from '../src/shared/protocol.ts'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T
const REVEAL_AFTER_LIFT_LINGER_MS = 2500

const landing = $('#landing')
const app = $('#app')
const canvas = $<HTMLCanvasElement>('#stage')
const ctx = canvas.getContext('2d')!
const roomCodeEl = $('#room-code')
const nameEls = [$('#name-pill'), $('#name-landing')]
const copyStateEl = $('#copy-state')
const peerCountEl = $('#peer-count')
const peerListEl = $('#peer-list')
const bannerEl = $('#banner')
const tipEl = $('#tip')
const errEl = $('#err')
const modeToggleEl = $('#mode-toggle')
const countStepperEl = $('#count-stepper')
const countLabelEl = $('#count-label')

// surface runtime failures on screen — phones have no devtools handy
const errorLog: { at: string; message: string }[] = []

function showError(msg: string): void {
  errorLog.push({ at: new Date().toISOString(), message: msg })
  if (errorLog.length > 20) errorLog.shift()
  errEl.textContent = `⚠ ${msg}`
  errEl.hidden = false
}

window.addEventListener('error', (e) => showError(e.message))
window.addEventListener('unhandledrejection', (e) => showError((e.reason as Error)?.message ?? String(e.reason)))

// ---- state ----

interface Peer {
  fingers: Fingers
  ts: number
  name?: string | null
}

let net: Net | null = null
let roomCode: string | null = null

const localFingers = new Map<number, { x: number; y: number }>() // pointerId -> normalized 0..1
const peers = new Map<string, Peer>() // peerId -> fingers + name
const bornAt = new Map<string, number>() // fingerKey -> first-seen timestamp, for pop-in
const lastFingerFrame = new Map<string, RenderFinger>() // last known position for reveal snapshots

let state: Phase = 'idle' // idle | armed | picked
let progress = 0
let tickStep = 0 // countdown milestone: 0=none, 1=start, 2=33%, 3=66%
let winners: RenderFinger[] = [] // set in 'winners' mode
let groupAssignment: Map<string, number> | null = null // set in 'groups' mode
let groupFingers: RenderFinger[] = [] // picked-time snapshot for lingering groups reveal
let revealEmptySince: number | null = null
let pickedAt = 0

// Server-driven countdown. The room is the authority on when a pick fires; it
// tells us when the hold started (in server time) and we render the arc against
// our own clock corrected by the offset captured from each server message.
let armedStableSince = 0
let clockOffset = 0 // serverNow - Date.now()
let connStatus: ConnStatus = 'connecting'
let peerListOpen = false // connected-devices popover visibility

// Selection mode, shared across the room. Mirrors the original: 'winners' picks
// `winnerCount` fingers, 'groups' divides everyone into `groupCount` colored
// groups on the same hold. The server owns these too and echoes changes.
let mode: Mode = 'winners'
let winnerCount = 1
let groupCount = 2

// Tolerate jittery mobile links: the heartbeat refreshes held fingers every 1s,
// so a peer's fingers only expire after several missed beats, not one hiccup.
const PEER_STALE_MS = 6000

function serverNow(): number {
  return Date.now() + clockOffset
}

// ---- player name ----

// `myName` is only ever a name the user explicitly chose; the default is derived
// from a stable per-device id (below), not the server-assigned socket id — that
// id isn't known until `welcome` arrives, and using a placeholder made every
// device compute the same default name.
let myName: string | null = null
try { myName = sanitizeName(localStorage.getItem('chooser:name')) } catch {}

function randomId(): string {
  try { return crypto.randomUUID() } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36) }
}

// A stable id for this device/browser, used only to derive a distinct default
// display name that's known immediately (no wait for the server) and unique.
let clientId: string
try {
  clientId = localStorage.getItem('chooser:cid') ?? ''
  if (!clientId) { clientId = randomId(); localStorage.setItem('chooser:cid', clientId) }
} catch { clientId = randomId() }

// A per-page-session id the server uses to recognize a *reconnect* from this
// same page (after a silent socket death — common on mobile) and evict the dead
// socket immediately, instead of letting it linger ~20s as a ghost that inflates
// the device count. Deliberately in-memory and NOT the persisted clientId: two
// tabs of one browser share localStorage, so a shared id would make them fight
// over it (each reconnect evicting the other). Per page, they stay distinct.
const sessionId = randomId()

function selfId(): string {
  return net?.selfId ?? 'me'
}

function displayName(): string {
  return myName ?? peerName(clientId)
}

function renderName(): void {
  for (const el of nameEls) el.textContent = displayName()
  renderPeerList()
}
renderName()

function nameOf(peerId: string): string {
  return peers.get(peerId)?.name ?? peerName(peerId)
}

function applyName(next: string | null): void {
  if (!next || next === myName) return
  myName = next
  try { localStorage.setItem('chooser:name', myName) } catch {}
  renderName()
  net?.sendName(displayName())
}

// Landing page: in-place editing inside the name field
{
  const landingEl = $('#name-landing')
  const wrap = landingEl.closest('.name-edit-wrap') as HTMLElement
  const input = wrap.querySelector('.name-input') as HTMLInputElement
  let canceling = false

  const commit = (): void => { wrap.classList.remove('editing'); applyName(sanitizeName(input.value)) }

  landingEl.addEventListener('click', () => {
    canceling = false
    input.value = displayName()
    wrap.classList.add('editing')
    input.select()
    input.focus()
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); canceling = true; wrap.classList.remove('editing') }
  })

  // blur fires after display:none — guard against Escape re-committing
  input.addEventListener('blur', () => {
    if (canceling) { canceling = false; return }
    commit()
  })
}

// HUD pill: custom bottom-sheet dialog
const nameDialogEl = $('#name-dialog')
const nameDialogInput = $<HTMLInputElement>('#name-dialog-input')

// The on-screen keyboard overlays the bottom of the layout viewport, so a
// bottom-anchored sheet gets hidden behind it. Pin the dialog to the *visual*
// viewport instead (the area above the keyboard) and follow it as it resizes.
function syncDialogViewport(): void {
  if (nameDialogEl.hidden) return
  const vv = window.visualViewport
  if (!vv) return
  nameDialogEl.style.height = `${vv.height}px`
  nameDialogEl.style.top = `${vv.offsetTop}px`
}
window.visualViewport?.addEventListener('resize', syncDialogViewport)
window.visualViewport?.addEventListener('scroll', syncDialogViewport)

function openNameDialog(): void {
  nameDialogInput.value = displayName()
  nameDialogEl.hidden = false
  syncDialogViewport()
  nameDialogInput.select()
  nameDialogInput.focus()
}

function closeNameDialog(save: boolean): void {
  nameDialogEl.hidden = true
  if (save) applyName(sanitizeName(nameDialogInput.value))
}

$('#name-pill').addEventListener('click', openNameDialog)
$('#name-dialog-backdrop').addEventListener('click', () => closeNameDialog(false))
$('#name-dialog-cancel').addEventListener('click', () => closeNameDialog(false))
$('#name-dialog-save').addEventListener('click', () => closeNameDialog(true))
nameDialogInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); closeNameDialog(true) }
  else if (e.key === 'Escape') { e.preventDefault(); closeNameDialog(false) }
})

function ensurePeer(peerId: string): Peer {
  let peer = peers.get(peerId)
  if (!peer) {
    peer = { fingers: {}, ts: performance.now() }
    peers.set(peerId, peer)
  }
  return peer
}

// ---- connected-devices popover ----

// Tapping the device count opens a small list of everyone in the room (this
// device first, then each peer). Built fresh on open and kept in sync while
// open as peers join, leave or rename. (State declared up with the rest.)

function deviceRow(id: string, label: string, isSelf: boolean): HTMLElement {
  const row = document.createElement('div')
  row.className = 'peer-list-item'
  row.setAttribute('role', 'menuitem')

  const dot = document.createElement('span')
  dot.className = 'peer-dot'
  dot.style.background = colorFor(id)

  const text = document.createElement('span')
  text.className = 'peer-name'
  text.textContent = label

  row.append(dot, text)
  if (isSelf) {
    const you = document.createElement('span')
    you.className = 'peer-you'
    you.textContent = 'you'
    row.append(you)
  }
  return row
}

function renderPeerList(): void {
  if (!peerListOpen) return
  peerListEl.replaceChildren(deviceRow(selfId(), displayName(), true))
  for (const peerId of peers.keys()) {
    peerListEl.append(deviceRow(peerId, nameOf(peerId), false))
  }
}

function setPeerList(open: boolean): void {
  peerListOpen = open
  peerListEl.hidden = !open
  peerCountEl.setAttribute('aria-expanded', String(open))
  if (open) renderPeerList()
}

peerCountEl.addEventListener('click', (e) => {
  e.stopPropagation()
  setPeerList(!peerListOpen)
})

// Dismiss on any tap outside the popover (and on its own toggle, handled above).
document.addEventListener('click', (e) => {
  if (peerListOpen && !peerListEl.contains(e.target as Node)) setPeerList(false)
})

// ---- selection mode ----

function renderMode(): void {
  modeToggleEl.textContent = mode === 'groups' ? 'Groups' : 'Winners'
  countStepperEl.hidden = false
  if (mode === 'groups') {
    countLabelEl.textContent = `${groupCount} groups`
    tipEl.textContent = `Everyone holds a finger — they'll be split into ${groupCount} groups`
  } else {
    countLabelEl.textContent = `${winnerCount} winner${winnerCount === 1 ? '' : 's'}`
    tipEl.textContent = winnerCount === 1
      ? 'Touch and hold with at least two fingers — across any devices in the room'
      : `Touch and hold — ${winnerCount} winners get picked across any devices in the room`
  }
}

// Apply a settings update that arrived from the server (no rebroadcast).
function applyMode(data: { mode: Mode; winnerCount: number; groupCount: number }): void {
  if (data.mode === 'winners' || data.mode === 'groups') mode = data.mode
  if (Number.isFinite(data.winnerCount)) {
    winnerCount = Math.min(MAX_WINNERS, Math.max(MIN_WINNERS, Math.floor(data.winnerCount)))
  }
  if (Number.isFinite(data.groupCount)) {
    groupCount = Math.min(MAX_GROUPS, Math.max(MIN_GROUPS, Math.floor(data.groupCount)))
  }
  renderMode()
}

// Apply a local change and tell the server — it's a shared room setting.
function broadcastMode(): void {
  renderMode()
  net?.sendMode({ mode, winnerCount, groupCount })
}

modeToggleEl.addEventListener('click', () => {
  mode = mode === 'groups' ? 'winners' : 'groups'
  reset() // clear any in-progress reveal when switching modes
  broadcastMode()
})

$('#count-dec').addEventListener('click', () => {
  if (mode === 'groups') groupCount = Math.max(MIN_GROUPS, groupCount - 1)
  else winnerCount = Math.max(MIN_WINNERS, winnerCount - 1)
  broadcastMode()
})

$('#count-inc').addEventListener('click', () => {
  if (mode === 'groups') groupCount = Math.min(MAX_GROUPS, groupCount + 1)
  else winnerCount = Math.min(MAX_WINNERS, winnerCount + 1)
  broadcastMode()
})

renderMode()

// ---- landing / room entry ----

$('#new-room').addEventListener('click', () => enterRoom(randomCode()))

$('#home-btn').addEventListener('click', () => leaveRoom())

$<HTMLFormElement>('#join-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const code = normalizeCode($<HTMLInputElement>('#join-code').value)
  if (code) enterRoom(code)
})

let loopStarted = false

function enterRoom(code: string): void {
  if (net) {
    try { net.leave() } catch {}
    peers.clear()
    localFingers.clear()
    reset()
  }
  roomCode = code
  location.hash = code
  roomCodeEl.textContent = code
  landing.hidden = true
  app.hidden = false

  void requestWakeLock()
  resize()
  if (!loopStarted) {
    loopStarted = true
    requestAnimationFrame(tick)
  }

  net = connect(code, () => displayName(), sessionId, {
    onStatus: (status) => { connStatus = status },
    onMessage: handleServerMessage,
  })
  // Test seam: lets the e2e drive a reconnect (it can't kill the socket directly).
  ;(window as unknown as { __net?: Net }).__net = net
}

// Leave the current room and return to the landing screen so a new room can be
// started or another joined. Mirrors enterRoom's teardown but drops the socket.
function leaveRoom(): void {
  if (net) {
    try { net.leave() } catch {}
    net = null
  }
  peers.clear()
  localFingers.clear()
  reset()
  setPeerList(false)
  roomCode = null
  location.hash = ''
  app.hidden = true
  landing.hidden = false
}

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case 'welcome':
      clockOffset = msg.serverNow - Date.now()
      peers.clear()
      for (const p of msg.peers) peers.set(p.id, { fingers: p.fingers, ts: performance.now(), name: p.name })
      applyMode(msg)
      applyPhase(msg.phase, msg.stableSince)
      renderName()
      // bring the server (and through it, peers) up to date with our state
      net?.sendName(displayName())
      net?.sendFingers(packFingers())
      break
    case 'peerJoin':
      ensurePeer(msg.id).name = msg.name ?? undefined
      break
    case 'peerLeave':
      peers.delete(msg.id)
      break
    case 'fingers': {
      const peer = ensurePeer(msg.id)
      peer.fingers = msg.fingers
      peer.ts = performance.now()
      break
    }
    case 'name':
      ensurePeer(msg.id).name = msg.name ?? undefined
      break
    case 'mode':
      applyMode(msg)
      break
    case 'phase':
      clockOffset = msg.serverNow - Date.now()
      applyPhase(msg.phase, msg.stableSince)
      break
    case 'pick':
      applyPick(msg)
      break
    case 'group':
      applyGroup(msg)
      break
  }
  // Membership/name changes are reflected live if the device list is open.
  if (peerListOpen && (msg.t === 'welcome' || msg.t === 'peerJoin' || msg.t === 'peerLeave' || msg.t === 'name')) {
    renderPeerList()
  }
}

// The server's idle/armed transitions drive our countdown; we keep ownership of
// the 'picked' reveal locally so it lingers exactly as before (REVEAL_MIN/MAX).
function applyPhase(phase: Phase, stableSince: number): void {
  if (phase === 'armed') {
    const minReveal = groupFingers.length ? GROUPS_REVEAL_MIN_MS : REVEAL_MIN_MS
    if (state === 'picked') {
      if (performance.now() - pickedAt < minReveal) return
      reset()
    }
    if (state !== 'armed' || stableSince !== armedStableSince) {
      armedStableSince = stableSince
      tickStep = 0
    }
    state = 'armed'
  } else if (phase === 'idle') {
    if (state === 'picked') return // let the local reveal finish
    state = 'idle'
    progress = 0
    tickStep = 0
  }
  // phase === 'picked' is handled by the pick/group message reveal
}

// Drive room entry/exit from the URL hash so the browser back/forward buttons
// work: enterRoom/leaveRoom write the hash (creating history entries), and this
// reconciles the UI when the user navigates that history. Setting the hash to a
// value it already holds is a no-op, so the calls below don't re-fire this.
function syncToHash(): void {
  const code = normalizeCode(location.hash.slice(1))
  if (code) {
    if (code !== roomCode) enterRoom(code)
  } else if (roomCode) {
    leaveRoom()
  }
}

window.addEventListener('hashchange', syncToHash)
syncToHash()

$('#room-pill').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#${roomCode}`
  try {
    if (navigator.share) await navigator.share({ title: 'Join my Chooser room', url })
    else await navigator.clipboard.writeText(url)
    copyStateEl.textContent = '✓'
    setTimeout(() => (copyStateEl.textContent = '⧉'), 1500)
  } catch {}
})

// Mobile browsers freeze a backgrounded tab and the socket often dies silently
// (no close event). After any non-trivial hidden spell, force a fresh
// connection on return so we don't sit on a dead socket showing stale peers.
const REJOIN_AFTER_HIDDEN_MS = 8000
let hiddenAt: number | null = null

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now()
  } else if (net && hiddenAt && Date.now() - hiddenAt > REJOIN_AFTER_HIDDEN_MS) {
    peers.clear()
    localFingers.clear()
    reset()
    net.reconnect()
  }
})

// ---- input ----

function pointerPos(e: PointerEvent): { x: number; y: number } {
  return { x: e.clientX / canvas.clientWidth, y: e.clientY / canvas.clientHeight }
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  localFingers.set(e.pointerId, pointerPos(e))
  broadcastFingers()
})

window.addEventListener('pointermove', (e) => {
  if (!localFingers.has(e.pointerId)) return
  localFingers.set(e.pointerId, pointerPos(e))
  scheduleBroadcast()
})

for (const evt of ['pointerup', 'pointercancel'] as const) {
  window.addEventListener(evt, (e) => {
    if (!localFingers.has(e.pointerId)) return
    localFingers.delete(e.pointerId)
    broadcastFingers()
  })
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault())

// ---- networking helpers ----

function packFingers(): Fingers {
  const out: Fingers = {}
  for (const [id, f] of localFingers) {
    out[id] = [Math.round(f.x * 1e4) / 1e4, Math.round(f.y * 1e4) / 1e4]
  }
  return out
}

let broadcastQueued = false

function broadcastFingers(): void {
  broadcastQueued = false
  net?.sendFingers(packFingers())
}

function scheduleBroadcast(): void {
  if (broadcastQueued) return
  broadcastQueued = true
  requestAnimationFrame(broadcastFingers)
}

// Heartbeat: lets the server/peers keep our fingers fresh if a move is missed.
setInterval(() => {
  if (net && localFingers.size > 0) broadcastFingers()
}, 1000)

// ---- selection rendering ----

function collectFingers(now: number): RenderFinger[] {
  const out: RenderFinger[] = []
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  const me = selfId()
  for (const [id, f] of localFingers) {
    out.push({ key: fingerKey(me, id), px: f.x * w, py: f.y * h, color: '', local: true, bornAt: 0 })
  }
  for (const [peerId, peer] of peers) {
    if (now - peer.ts > PEER_STALE_MS && Object.keys(peer.fingers).length > 0) peer.fingers = {}
    for (const [id, [x, y]] of Object.entries(peer.fingers)) {
      out.push({ key: fingerKey(peerId, id), px: x * w, py: y * h, color: '', local: false, bornAt: 0 })
    }
  }
  for (const f of out) {
    if (!bornAt.has(f.key)) bornAt.set(f.key, now)
    f.bornAt = bornAt.get(f.key)!
    if (groupAssignment) {
      const g = groupAssignment.get(f.key)
      f.group = g ?? null
      f.color = g == null ? NEUTRAL_COLOR : groupColor(g)
    } else if (mode === 'groups') {
      f.group = null
      f.color = NEUTRAL_COLOR
    } else {
      f.color = colorFor(f.key)
    }
    lastFingerFrame.set(f.key, { ...f })
  }
  const live = new Set(out.map((f) => f.key))
  for (const key of bornAt.keys()) if (!live.has(key)) bornAt.delete(key)
  return out
}

function applyGroup({ seed, keys, count }: { seed: number; keys: string[]; count: number }): void {
  if (state === 'picked') return
  const now = performance.now()
  const present = collectFingers(now)
  groupAssignment = assignGroups(keys, seed, count)
  revealEmptySince = null
  groupFingers = keys.map((key) => {
    const f = present.find((x) => x.key === key) ?? lastFingerFrame.get(key)
    const peerId = key.split('/')[0]
    const g = groupAssignment!.get(key)
    return {
      key,
      local: peerId === selfId(),
      bornAt: f?.bornAt ?? now,
      group: g ?? null,
      color: g == null ? NEUTRAL_COLOR : groupColor(g),
      px: f ? f.px : canvas.clientWidth / 2,
      py: f ? f.py : canvas.clientHeight / 2,
    }
  })
  winners = []
  state = 'picked'
  pickedAt = now
  navigator.vibrate?.(40)
  playGroupReveal()
  bannerEl.hidden = false
  bannerEl.style.color = '' // group reveal has no single color; use the default
  bannerEl.textContent = `Split into ${count} group${count === 1 ? '' : 's'}`
}

function applyPick({ seed, keys, count }: { seed: number; keys: string[]; count?: number }): void {
  if (state === 'picked') return
  const won = pickWinners(keys, seed, count ?? 1)
  if (won.length === 0) return
  const now = performance.now()
  const present = collectFingers(now)
  revealEmptySince = null
  winners = won.map((key) => {
    const f = present.find((x) => x.key === key) ?? lastFingerFrame.get(key)
    const peerId = key.split('/')[0]
    return {
      key,
      local: peerId === selfId(),
      color: colorFor(key),
      bornAt: f?.bornAt ?? now,
      px: f ? f.px : canvas.clientWidth / 2,
      py: f ? f.py : canvas.clientHeight / 2,
    }
  })
  state = 'picked'
  pickedAt = now
  const localWon = winners.some((wf) => wf.local)
  navigator.vibrate?.(localWon ? [80, 60, 160] : 30)
  playWinnerReveal(localWon)
  bannerEl.hidden = false
  if (winners.length === 1) {
    // Single-winner wording is load-bearing (e2e asserts on it) — keep it exact.
    const wf = winners[0]
    const peerId = wf.key.split('/')[0]
    bannerEl.style.color = wf.color
    bannerEl.textContent = wf.local ? '🎉 You were chosen!' : `${nameOf(peerId)} was chosen`
  } else {
    bannerEl.style.color = '' // multiple winners have no single color; use default
    bannerEl.textContent = localWon ? "🎉 You're a winner!" : `${winners.length} winners`
  }
}

function reset(): void {
  state = 'idle'
  winners = []
  groupAssignment = null
  groupFingers = []
  revealEmptySince = null
  lastFingerFrame.clear()
  progress = 0
  tickStep = 0
  bannerEl.hidden = true
}

// ---- main loop ----

function tick(): void {
  const now = performance.now()
  const fingers = collectFingers(now)

  if (state === 'picked') {
    const elapsed = now - pickedAt
    if (fingers.length === 0) revealEmptySince ??= now
    else revealEmptySince = null
    const revealDone = (revealEmptySince != null && now - revealEmptySince > REVEAL_AFTER_LIFT_LINGER_MS)
      || elapsed > REVEAL_MAX_MS
    if (revealDone) {
      reset()
    } else if (winners.length) {
      for (const wf of winners) {
        const f = fingers.find((x) => x.key === wf.key)
        if (f) { wf.px = f.px; wf.py = f.py }
      }
    } else if (groupFingers.length) {
      for (const gf of groupFingers) {
        const f = fingers.find((x) => x.key === gf.key)
        if (f) { gf.px = f.px; gf.py = f.py }
      }
    }
  } else if (state === 'armed' && fingers.length >= MIN_FINGERS) {
    progress = Math.min(1, Math.max(0, (serverNow() - armedStableSince) / HOLD_MS))
    if (tickStep < 1) { tickStep = 1; playCountdownTick(0); navigator.vibrate?.(10) }
    else if (progress >= 0.66 && tickStep < 3) { tickStep = 3; playCountdownTick(2); navigator.vibrate?.(25) }
    else if (progress >= 0.33 && tickStep < 2) { tickStep = 2; playCountdownTick(1); navigator.vibrate?.(15) }
  } else {
    progress = 0
    tickStep = 0
  }

  const renderFingers = state === 'picked' && groupFingers.length ? groupFingers : fingers
  draw(ctx, { w: canvas.clientWidth, h: canvas.clientHeight, now, fingers: renderFingers, state, progress, winners, pickedAt })

  const n = 1 + peers.size
  // The colored status dot (CSS, keyed off data-status) now carries the
  // connection state, so the label can stay as a clean device count.
  peerCountEl.dataset.status = connStatus
  peerCountEl.textContent = `${n} device${n === 1 ? '' : 's'}`

  tipEl.style.opacity = state === 'idle' && fingers.length === 0 ? '1' : '0'

  requestAnimationFrame(tick)
}

// ---- chrome ----

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = canvas.clientWidth * dpr
  canvas.height = canvas.clientHeight * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

window.addEventListener('resize', resize)

// ---- PWA install ----

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}

const installBarEl = $('#install-bar')
const installBtnEl = $('#install-btn')
let installPrompt: (Event & { prompt: () => void; userChoice: Promise<{ outcome: string }> }) | null = null

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  installPrompt = e as typeof installPrompt
  installBarEl.hidden = false
})

installBtnEl.addEventListener('click', async () => {
  if (!installPrompt) return
  installPrompt.prompt()
  const { outcome } = await installPrompt.userChoice
  if (outcome === 'accepted') installBarEl.hidden = true
  installPrompt = null
})

window.addEventListener('appinstalled', () => {
  installBarEl.hidden = true
  installPrompt = null
})

async function requestWakeLock(): Promise<void> {
  try {
    const lock = await navigator.wakeLock?.request('screen')
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void requestWakeLock()
    }, { once: true })
    void lock
  } catch {}
}
