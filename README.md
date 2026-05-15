# GodsBooklet — Backend (Node.js + Express + MongoDB)

## Overview
- Endpoints: `/rooms`, `/rooms/:id`, `/rooms/:id/players`, `/rooms/:id/assign`, `/rooms/:id/step`, `/rooms/:id/undo`
- Models: Room, Player, Rules, Event
- Matches MVP & Sprint backlog

## v0.4 Stabilization

### Fixed
- Added game-over checks after night resolution.
- Enforced the Witch one-potion-per-night rule at the backend source of truth.
- Added multi-death night result support with `meta.lastKilledSeats`, while keeping `meta.lastKilledSeat` for compatibility.
- Prevented unresolved vote phases from being skipped by generic phase advancement.
- Added backend-backed exile vote resolution, including first-round and second-round tie handling.
- Ensured exiled players are marked eliminated in backend room state.
- Added backend-backed sheriff election winner, tie, second-round tie, and no-sheriff persistence.
- Added formal sheriff state in `room.meta.sheriffSeat`, `room.meta.noSheriff`, and `room.meta.sheriffElectionCompleted`.
- Added sheriff badge transfer and tear-badge flow after sheriff death.
- Made `GET /rooms/:id` read-only by returning computed meta without saving the room.
- Fixed CORS env priority for multi-origin deployment.

### Changed
- Added `npm run test:flow:local` to start the backend, wait for readiness, run the API flow test, and clean up the spawned server.
- Extended the API flow test to verify vote resolution instead of skipping vote phase.
- Standardized environment configuration around `MONGO_URI` and multi-origin CORS envs.

### Verification
- Backend syntax checks should pass for `app.js`, `routes/rooms.js`, `scripts/run-flow-with-server.js`, and `scripts/happy-path-flow.js`.
- `npm run test:flow:local` should pass locally when `MONGO_URI` is configured.
- Frontend production build should pass from `gb-frontend` with `npm run build`.

### Known risks
- Full browser click-path verification is still manual.
- Smoke-test rooms may remain in MongoDB after verification runs.
- Some frontend interaction state remains local and can be further backend-backed later.

## Quick Start
1. **Install dependencies**
```bash
npm i
```
2. **Set environment (.env)**
The backend uses one MongoDB environment key in every environment: `MONGO_URI`.
Render should continue to provide it from deployed env vars, and local development should provide it from `gb-backend/.env`.

```
NODE_ENV=development
PORT=3000
CORS_ALLOWED_ORIGINS=http://localhost:5173
# Optional fallback if multi-origin envs are absent:
# CORS_ORIGIN=http://localhost:5173
MONGO_URI=mongodb://127.0.0.1:27017/godsbooklet
```

## CORS
Use `CORS_ALLOWED_ORIGINS` as a comma-separated whitelist of allowed frontend origins. `CORS_ORIGINS` is also supported. `CORS_ORIGIN` remains as a backward-compatible single-origin fallback.

Examples:
```env
# Local only
CORS_ALLOWED_ORIGINS=http://localhost:5173

# Local + Cloudflare preview + production
CORS_ALLOWED_ORIGINS=http://localhost:5173,https://gb-frontend.pages.dev,https://*.gb-frontend.pages.dev,https://godsbooklet.example.com
```
3. **Run in dev (hot reload)**
```bash
npm run dev
```

Local startup:
- create `gb-backend/.env` from `.env.example`
- set `MONGO_URI` to your local or Atlas connection string
- do not use old split Mongo settings such as `MONGO_HOST` or `MONGO_USER`
- run `npm run dev`

4. **Run in prod**
```bash
npm start
```

## Happy-path flow smoke test
This repo includes a lightweight API-driven flow test for the main moderator workflow:
- create room
- add/fill players
- assign roles and enter night
- resolve night
- advance day -> vote -> night
- resolve night again
- verify room state and logs

Preferred local verification command:

```bash
npm run test:flow:local
```

Manual fallback: run the backend first, then run the flow test in a second terminal.

Commands:
```bash
# terminal 1
npm run dev

# terminal 2
npm run test:flow
```

Options:
```bash
# hit a different backend URL
node ./scripts/happy-path-flow.js --base-url=http://localhost:3000

# run more than the default 2 iterations
node ./scripts/happy-path-flow.js --iterations=3
```

Environment overrides:
```bash
BACKEND_BASE_URL=http://localhost:3000
FLOW_ITERATIONS=3
npm run test:flow
```

PowerShell:
```powershell
$env:BACKEND_BASE_URL="http://localhost:3000"
$env:FLOW_ITERATIONS="3"
npm run test:flow
```

## Test with cURL
```bash
# Create 9p classic room
curl -X POST http://localhost:3000/rooms -H "Content-Type: application/json" -d '{
  "name":"Club Night","maxSeats":9,"presetKey":"9p-classic",
  "rules":{"witchSelfSaveFirstNight":false,"guardConsecutiveProtectAllowed":false,"sheriffEnabled":true}
}'

# Add player
curl -X POST http://localhost:3000/rooms/<roomId>/players -H "Content-Type: application/json" -d '{ "seat":1,"nickname":"A" }'

# Assign roles
curl -X POST http://localhost:3000/rooms/<roomId>/assign -H "Content-Type: application/json" -d '{}'

# Step advance
curl -X POST http://localhost:3000/rooms/<roomId>/step -H "Content-Type: application/json" -d '{ "actor":"system","action":"advancePhase" }'
```
