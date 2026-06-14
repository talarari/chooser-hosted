// Wire protocol between the browser clients and the room's Durable Object.
// Every message is JSON with a `t` discriminator. The server is authoritative:
// clients report their own fingers / name / settings, the server runs the
// hold-and-pick state machine and broadcasts phase changes and pick results.

export type Mode = 'winners' | 'groups'
export type Phase = 'idle' | 'armed' | 'picked'

// A client's fingers: fingerId -> [x, y], normalized 0..1.
export type Fingers = Record<string, [number, number]>

export interface ModeSettings {
  mode: Mode
  winnerCount: number
  groupCount: number
}

export interface PeerSnapshot {
  id: string
  name: string | null
  fingers: Fingers
}

// ---- client -> server ----

export type ClientMessage =
  | { t: 'fingers'; fingers: Fingers }
  | { t: 'name'; name: string | null }
  | { t: 'mode'; mode: Mode; winnerCount: number; groupCount: number }

// ---- server -> client ----

// Reveal payloads reuse the deterministic {seed, keys, count} shape so each
// client resolves the same winners/groups locally via the shared chooser logic.
export interface PickPayload {
  seed: number
  keys: string[]
  count: number
}

export type ServerMessage =
  | ({
      t: 'welcome'
      selfId: string
      phase: Phase
      stableSince: number
      serverNow: number
      peers: PeerSnapshot[]
    } & ModeSettings)
  | { t: 'peerJoin'; id: string; name: string | null }
  | { t: 'peerLeave'; id: string }
  | { t: 'fingers'; id: string; fingers: Fingers }
  | { t: 'name'; id: string; name: string | null }
  | ({ t: 'mode' } & ModeSettings)
  | { t: 'phase'; phase: Phase; stableSince: number; serverNow: number }
  | ({ t: 'pick' } & PickPayload)
  | ({ t: 'group' } & PickPayload)
