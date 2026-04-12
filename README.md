# GodsBooklet — Backend (Node.js + Express + MongoDB)

## Overview
- Endpoints: `/rooms`, `/rooms/:id`, `/rooms/:id/players`, `/rooms/:id/assign`, `/rooms/:id/step`, `/rooms/:id/undo`
- Models: Room, Player, Rules, Event
- Matches MVP & Sprint backlog

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
CORS_ORIGIN=http://localhost:5173
MONGO_URI=mongodb://127.0.0.1:27017/godsbooklet
```

## CORS
Use `CORS_ORIGIN` as a comma-separated whitelist of allowed frontend origins.

Examples:
```env
# Local only
CORS_ORIGIN=http://localhost:5173

# Local + Cloudflare preview + production
CORS_ORIGIN=http://localhost:5173,https://gb-frontend.pages.dev,https://*.gb-frontend.pages.dev,https://godsbooklet.example.com
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

Run the backend first, then run the flow test in a second terminal.

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
