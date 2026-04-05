# VDS

VDS is an Electron desktop client plus a Node.js signaling server for cascade screen sharing.

## 1.6.1 Overview

Version `1.6.1` keeps the native media path as the only mainline and adds OBS local ingest as a formal host mode instead of a side experiment.

Highlights:

- added OBS local `SRT` ingest as a host backend with room creation delayed until valid OBS program media arrives
- promoted `AAC` into the transport, relay, and native viewer playback path instead of forcing ingest-side `Opus` conversion
- updated the OBS host UI to use a fixed default local port (`61080`), a one-click `Copy and Start` flow, and optional saved custom port overrides
- kept native `H.264 / H.265` + encoded relay fanout as the core production path
- preserved the recent WGC fixes for resize recovery, minimized-window startup recovery, and high-FPS capture behavior on Win11 24H2

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

OBS mode currently behaves like this:

- VDS prepares a local SRT address and waits for OBS to push a valid program stream
- default port is `61080`
- the user can optionally save a custom local port for OBS
- VDS does not control OBS and does not use `obs-websocket`
- OBS mode is local-only and not a generic remote SRT gateway

## Current Highlights

- H.265 is now part of the native mainline for host, viewer, and relay fanout
- AAC is now part of the formal native transport / relay / viewer playback path
- OBS local ingest is now a formal host backend, not a sidecar experiment
- hardware encoder detection uses native self-test instead of raw FFmpeg enumeration
- host and viewer UI expose native FPS diagnostics
- Win11 24H2 WGC high-FPS capture requires `GraphicsCaptureSession.MinUpdateInterval(1ms)`
- WGC session now explicitly sets cursor capture and border behavior when the platform exposes those properties

## Release and Deployment

- `npm run build:release`
  - builds Electron installer
  - refreshes `server/updates/`
  - prepares `server/` for Docker upload
- `server/` is the deployable server directory
- desktop auto-update feed is served from `server/updates/`
- `1.6.1` release assets are the installer, blockmap, and `latest.yml`
- release notes for recent versions are tracked in [CHANGELOG.md](/d:/project/videosharing/CHANGELOG.md)

## Source Control Rules

- build outputs are not committed
- `runtime/` binaries are not committed
- `server/public/` is the canonical frontend source directory
- update artifacts in `server/updates/` are deployment outputs, not source
