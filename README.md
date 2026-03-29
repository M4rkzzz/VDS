# VDS

VDS is an Electron desktop client plus a Node.js signaling server for screen sharing.

## Layout

- `desktop/`: Electron main process, preload script, and desktop assets
- `server/public/`: shared renderer assets used by both desktop and server
- `server/index.js`: shared server entry for local development and deployment
- `server/server-core.js`: shared signaling server implementation
- `server/package.json`: minimal dependency manifest for the server image
- `server/docker-compose.yml` and `server/Dockerfile`: self-contained container deployment entrypoints
- `server/updates/`: desktop auto-update artifacts served by the signaling container

## Commands

```bash
npm install
npm run dev
npm run server
npm run build:release
cd server
docker compose up --build
```

## Rules

- Build outputs live in `build/` and `dist/` and are not committed
- `server/` is prepared as a deployable directory after `npm run build:release`
- `server/public/` is the canonical frontend asset directory
