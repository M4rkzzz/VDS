# VDS

VDS is an Electron desktop client plus a Node.js signaling server for cascade screen sharing.

## 1.6.7 Overview

Version `1.6.7` focuses on native P2P connection robustness, media surface stability, server topology visibility, and release validation for mixed native/web relay flows.

Highlights:

- improved native offer/answer attempt isolation and reconnect behavior for host/viewer/relay edges
- added server-side upstream reselection with per-upstream downstream capacity limits
- fixed host stop-share/re-share room lifecycle by fully unbinding destroyed room sockets
- improved native viewer surface movement handling to avoid updateSurface storms during window dragging
- restored WGC live preview as the default host preview path while hardening WGC source creation errors
- added a 3010 signal admin dashboard with graphical topology, node state, edge state, and live manifests
- improved diagnostic density by moving high-frequency surface/getStats logs behind the debug high-frequency channel
- kept native `H.264 / H.265` + encoded relay fanout and Web viewer relay as the production path

Current media path:

- host backend: native capture or local OBS ingest
- native host capture: `Windows Graphics Capture`
- OBS ingest: local-only `MPEG-TS over SRT` on `127.0.0.1`
- transport: native `libdatachannel`
- video: `H.264 / H.265`
- audio: native host uses `Opus 48k stereo`, OBS ingest uses `AAC 48k`
- relay: native encoded fanout (`host -> v1 -> v2`), not browser re-encode
- rendering: native preview / native viewer surface

## Repository Layout

- `desktop/`: Electron main process, preload bridge, updater, native agent bridge
- `server/public/`: canonical frontend assets
- `server/index.js`: shared local/deploy server entry
- `server/server-core.js`: signaling and relay-chain room logic
- `vds_web/`: Chrome/Edge web viewer and encoded relay feasibility harness
- `media-agent/`: native capture / encode / decode / relay implementation
- `scripts/`: local test, release, and native build scripts
- `docs/`: manual documents
- `MEDIA_REFACTOR_PLAN.md`: current media architecture and refactor truth source

## Core Commands

```bash
npm install
npm run dev
npm run server
npm run dual:web
npm run dev:dual:native
npm run dev:triple:native
npm run check:vds-web
npm run build:vds-web
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

- host backend tabs: `Native Push / OBS Push`
- codec: `H.264 / H.265`
- resolution: `360p / 480p / 720p / 1080p / 2k / 4k`
- frame rate: `5 / 30 / 60 / 90`
- bitrate: step `1000 kbps`
- hardware acceleration toggle
- local preview toggle
- hardware encoder selection: auto or manually select validated hardware encoders
- encoder preset: `quality / balanced / speed`
- tune: `fastdecode / zerolatency`
- keyframe interval: `1s / 0.5s / all-intra`

OBS mode currently behaves like this:

- VDS prepares a local SRT address and waits for OBS to push a valid program stream
- default port is `61080`
- the user can optionally save a custom local port for OBS
- VDS does not control OBS and does not use `obs-websocket`
- OBS mode is local-only and not a generic remote SRT gateway

Viewer join mode currently behaves like this:

- default tab is `Lobby`
- the lobby polls `/api/public-rooms` every `500ms` while the join panel is open
- hosts choose whether a room is public before starting share
- manual room code entry remains available in the `Direct` tab

## Current Highlights

- H.265 is now part of the native mainline for host, viewer, and relay fanout
- VDS_web now exists as a browser feasibility harness for Chrome/Edge watching and zero-reencode encoded relay validation
- AAC is now part of the formal native transport / relay / viewer playback path
- OBS local ingest is now a formal host backend, not a sidecar experiment
- public room listing is now part of the default product flow instead of requiring room-code-only join every time
- hardware encoder detection uses native self-test instead of raw FFmpeg enumeration
- host and viewer UI expose native FPS diagnostics
- Win11 24H2 WGC high-FPS capture requires `GraphicsCaptureSession.MinUpdateInterval(1ms)`
- WGC session now explicitly sets cursor capture and border behavior when the platform exposes those properties

## Release and Deployment

- `npm run build:release`
  - builds Electron installer
  - refreshes `server/updates/`
  - prepares `server/` for Docker upload
  - publishes the GitHub Release through `gh`
- `npm run release:github`
  - requires GitHub CLI `gh` and an authenticated session
  - creates tag `v<version>` if needed, pushes it, and uploads installer, blockmap, and `latest.yml`
  - refuses dirty worktrees unless `ALLOW_DIRTY_GITHUB_RELEASE=1` is set
- `server/` is the deployable server directory
- desktop auto-update feed is served from `server/updates/`
- `1.6.7` release assets are the installer, blockmap, and `latest.yml`
- release notes for recent versions are tracked in [CHANGELOG.md](CHANGELOG.md)

## Source Control Rules

- build outputs are not committed
- `runtime/` binaries are not committed
- `server/public/` is the canonical frontend source directory
- update artifacts in `server/updates/` are deployment outputs, not source
