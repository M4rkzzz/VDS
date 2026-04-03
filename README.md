# VDS

VDS is an Electron desktop client plus a Node.js signaling server for cascade screen sharing.

Current media path:

- host capture: native `Windows Graphics Capture`
- transport: native `libdatachannel`
- video: `H.264`
- audio: `Opus 48k stereo`
- relay: native encoded fanout (`host -> v1 -> v2`), not browser re-encode
- rendering: native preview / native viewer surface

## Repository Layout

- `desktop/`: Electron main process, preload bridge, updater, native agent bridge
- `server/public/`: canonical frontend assets
- `server/index.js`: shared local/deploy server entry
- `server/server-core.js`: signaling and relay-chain room logic
- `media-agent/`: native capture / encode / decode / relay implementation
- `scripts/`: local test, release, and native build scripts
- `docs/`: manual documents
- `MEDIA_REFACTOR_PLAN.md`: current media architecture and refactor truth source

## Core Commands

```bash
npm install
npm run dev
npm run server
npm run dev:dual:native
npm run dev:triple:native
npm run build:media-agent
npm run build:release
```

## Native Test Flows

- `npm run dev:dual:native`
  - local server + 1 host + 1 viewer
- `npm run dev:triple:native`
  - local server + 1 host + 2 viewers
  - suggested relay order: host creates room -> viewer 1 joins -> viewer 2 joins

## Quality Settings

Current desktop UI supports:

- codec: `H.264`
- `H.265`: disabled in UI as `work in progress`
- resolution: `360p / 480p / 720p / 1080p / 2k / 4k`
- frame rate: `5 / 30 / 60 / 90`
- bitrate: step `1000 kbps`
- hardware acceleration toggle
- encoder preset: `quality / balanced / speed`
- tune: `fastdecode / zerolatency`

## Release and Deployment

- `npm run build:release`
  - builds Electron installer
  - refreshes `server/updates/`
  - prepares `server/` for Docker upload
- `server/` is the deployable server directory
- desktop auto-update feed is served from `server/updates/`

## Source Control Rules

- build outputs are not committed
- `runtime/` binaries are not committed
- `server/public/` is the canonical frontend source directory
- update artifacts in `server/updates/` are deployment outputs, not source
