# Chooser (hosted)

A multiplayer finger chooser that works **across devices** — everyone in the room
holds a finger on their own phone, and one finger (on one device) gets picked.

This is the **server-authoritative** version of [Chooser](../chooser). The
original is 100% peer-to-peer over WebRTC (signaling via Nostr relays + a TURN
worker); this rewrite drops all of that for a single source of truth:

- **One Cloudflare Worker** serves the static client and upgrades `/ws` to a
  WebSocket.
- **One Durable Object per room.** `idFromName(roomCode)` maps a room code to
  exactly one Durable Object instance worldwide, so every player in a room lands
  on the same instance. That instance holds the authoritative game state and all
  the players' sockets, and runs the hold-countdown-pick state machine.
- **Clients just report and render.** They send their own fingers / name /
  settings and draw whatever the server broadcasts. No WebRTC, no signaling, no
  TURN, no "host" election — networking is a single WebSocket.

It runs entirely on the **Cloudflare free tier**: the Durable Object is
SQLite-backed (`new_sqlite_classes`), which is the free-tier-eligible flavour.

Live: **https://chooser.talarari.workers.dev**

## How to play

1. Open the app, tap **Start a room** — you get a 4-letter room code.
2. Friends join by entering the code (or opening the shared link — tap the room
   pill to copy/share it).
3. Everyone touches and holds the screen. Multiple fingers per device work too.
4. Once at least **2 fingers** (across all devices) hold steady for **3
   seconds**, the server picks one finger and lights up the winning device.
5. Lift all fingers to play again.

**Winners vs. Groups** — the mode toggle switches what the hold produces and the
stepper sets the count: pick 1–8 **winners**, or divide everyone into 2–8 evenly
sized **groups**. Mode and count are a shared room setting synced to everyone.

## Project layout

```
src/server.ts          Worker entrypoint + the per-room Durable Object (Room)
src/shared/chooser.ts  Pure game logic (deterministic pick/group, names, colors)
src/shared/protocol.ts WebSocket message types (client <-> server)
src/shared/room.ts     Authoritative room state machine (pure, I/O-free)
client/                Browser client (TypeScript) — main, net, render, audio + HTML/CSS
build.mjs              Bundles client/ into public/ (served by the Worker)
test/                  Unit tests (chooser, room) + e2e (two real browsers)
```

The deterministic pick logic in `src/shared/chooser.ts` is imported by **both**
the server and the client, so the server's seed resolves to the same winners,
colors and group numbers on every device.

## Develop

```sh
npm install
npm run dev        # builds the client, then `wrangler dev` (local Worker + DO)
```

Open the printed `http://127.0.0.1:8787`. Open it in two windows (same `#ROOM`
hash) to play against yourself.

## Test

```sh
npm test           # unit tests: pure game logic + room state machine
npm run typecheck  # tsc for client and worker
npm run e2e        # two Chromium pages over a local `wrangler dev` (needs: npm run e2e:install)
```

The e2e can also run against the live deployment:

```sh
E2E_BASE_URL=https://chooser.talarari.workers.dev npm run e2e
```

## Deploy

```sh
npm run deploy     # builds client into public/, then `wrangler deploy`
```

Needs Cloudflare credentials (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
in the environment, or `wrangler login`). CI (`.github/workflows/deploy.yml`)
runs the unit tests and the local e2e on every push/PR, deploys on pushes to
`main`, and then smokes the live deployment with the same e2e suite. Add
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets for the
deploy job.
