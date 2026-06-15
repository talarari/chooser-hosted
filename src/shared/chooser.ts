// Pure game logic shared by the server (the authority that decides a pick) and
// every client (which renders the result). The pick/group functions are
// deterministic so that, given the same {seed, keys, count} the server
// broadcasts, every client derives an identical outcome — colors and group
// numbers line up across devices without any extra coordination.

export const MIN_FINGERS = 2
export const HOLD_MS = 3000 // fingers must stay stable this long before a pick
export const REVEAL_MIN_MS = 2500 // winner stays on screen at least this long
// Groups linger longer: everyone lifts at once to study the split, so the
// reveal needs to stay put well past the moment all fingers leave the screen.
export const GROUPS_REVEAL_MIN_MS = 5000
export const REVEAL_MAX_MS = 8000 // ...and resets after this long no matter what

export const PALETTE = [
  '#ff3b6b', '#ffb820', '#27e0a6', '#2fb5ff', '#a06bff', '#ff7a45',
  '#3ddc97', '#ff5fa2', '#55e6f2', '#cdf252', '#ff8fd8', '#7da2ff',
]

const ADJECTIVES = [
  'Brave', 'Calm', 'Daring', 'Eager', 'Fuzzy', 'Gentle', 'Happy', 'Jolly',
  'Keen', 'Lucky', 'Mighty', 'Nimble', 'Proud', 'Quick', 'Sunny', 'Witty',
]

const ANIMALS = [
  'Otter', 'Panda', 'Tiger', 'Koala', 'Llama', 'Gecko', 'Raven', 'Shark',
  'Moose', 'Bison', 'Dingo', 'Heron', 'Lemur', 'Mole', 'Newt', 'Wolf',
]

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function fingerKey(peerId: string, fingerId: string | number): string {
  return `${peerId}/${fingerId}`
}

// FNV-1a, used to derive stable colors/names from ids.
export function hashStr(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function colorFor(key: string): string {
  return PALETTE[hashStr(key) % PALETTE.length]
}

export function peerName(peerId: string): string {
  const h = hashStr(peerId)
  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[(h >>> 8) % ANIMALS.length]}`
}

export function sanitizeName(raw: string | null | undefined): string | null {
  const name = (raw || '').trim().replace(/\s+/g, ' ').slice(0, 20)
  return name.length ? name : null
}

// Deterministic PRNG so every peer derives the same winner from the seed.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- winners mode ----

export const MIN_WINNERS = 1
export const MAX_WINNERS = 8

// keys: finger keys present at pick time (any order). Returns `count` DISTINCT
// winning keys. Like assignGroups, every peer runs this on the same
// {keys, seed, count} and derives an identical result with no coordination —
// sort first so the shuffle is order-independent, then a seeded Fisher–Yates
// and take the first `count`. Count is clamped to [1, keys.length].
export function pickWinners(keys: string[], seed: number, count: number): string[] {
  const shuffled = [...keys].sort()
  if (shuffled.length === 0) return []
  const n = Math.min(shuffled.length, Math.max(1, Math.floor(count)))
  const rand = mulberry32(seed)
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, n)
}

// Thin wrapper for the single-winner case so existing callers/tests keep working.
export function pickWinner(keys: string[], seed: number): string | null {
  return pickWinners(keys, seed, 1)[0] ?? null
}

// ---- group division mode ----

export const MIN_GROUPS = 2
export const MAX_GROUPS = 8

// Ring color shown in groups mode before the division is revealed — no finger
// is "colored" until the groups are assigned, so they start out neutral.
export const NEUTRAL_COLOR = '#6b7390'

// Deterministically split the finger keys into `count` balanced groups. Like
// pickWinner, every peer runs this on the same {seed, keys, count} and derives
// an identical assignment with no coordination — so all devices agree on who
// landed in which group. Returns a Map of key -> 0-based group index; group
// sizes differ by at most one.
export function assignGroups(keys: string[], seed: number, count: number): Map<string, number> {
  const groups = Math.max(1, Math.floor(count))
  // Sort first so the shuffle is order-independent, then Fisher–Yates with the
  // seeded PRNG so membership is random but agreed across peers.
  const shuffled = [...keys].sort()
  const rand = mulberry32(seed)
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  // Round-robin the shuffled keys into groups → sizes differ by at most one.
  const out = new Map<string, number>()
  shuffled.forEach((key, i) => out.set(key, i % groups))
  return out
}

// Stable, distinct color per group index, drawn from the shared palette.
export function groupColor(index: number): string {
  return PALETTE[index % PALETTE.length]
}

export function randomCode(len = 4): string {
  let code = ''
  for (let i = 0; i < len; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

export function normalizeCode(raw: string | null | undefined): string | null {
  const code = (raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return code.length >= 3 && code.length <= 8 ? code : null
}
