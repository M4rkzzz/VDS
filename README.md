# VDS

VDS is an Electron desktop client plus a Node.js signaling server for cascade screen sharing.

## 1.7.0 Overview

Version `1.7.0` focuses on renderer/native-authority modularization, media-agent session ownership, native/OBS lifecycle reliability, and Web/native relay topology robustness.

Highlights:

- split renderer responsibilities into dedicated app state, room client, UI, native session, peer, surface, diagnostics, and P2P state-machine modules
- tightened media-agent ownership around Host, Peer, Surface, Relay, Audio, and OBS ingest session controllers
- fixed native/OBS share start, stop-share, repeated share, room creation, room-code display, public-room discovery, and stale-manifest cleanup
- fixed OBS ingest audio and AAC manifest behavior for downstream playback and relay
- improved source thumbnail and WGC preview timing with async thumbnail loading and diagnostic WGC preview failures
- strengthened chain-first Web/native relay routing with server-side upstream reselection and per-upstream downstream limits
- added renderer/native bridge, room-client, media-agent boundary, logging, server, VDS_web, and media-agent release gates
- improved the 3010 signal admin dashboard with live topology, node/edge state, capacity, and manifest visualization

## Current Media Path

- host backend: native capture or local OBS ingest
- native host capture: Windows Graphics Capture
- OBS ingest: local-only MPEG-TS over SRT on `127.0.0.1`
- transport: native `libdatachannel`
- video: `H.264 / H.265`
- audio: native host uses `Opus 48k stereo`, OBS ingest uses `AAC 48k`
- relay: encoded fanout, not browser re-encode
- rendering: native preview / native viewer surface; web viewer uses WebCodecs

## Repository Layout

- `desktop/`: Electron main process, preload bridge, updater, native agent bridge
- `server/`: deployable Node signaling server, Docker context, admin dashboard, update feed output
- `server/public/`: Electron renderer assets served by the local/deployed server
- `vds_web/`: Chrome/Edge web viewer source; build output is copied to `server/public/vds_web/`
- `media-agent/`: native capture, encode, decode, relay, preview, and viewer surface implementation
- `runtime/`: generated native runtime copied into Electron packages; not committed
- `scripts/`: local test, release, server, and native build scripts
- `tools/`: helper tools such as the VDS test launcher
- `docs/`: audit notes, logging policy, media-agent notes, and project structure docs
- `MEDIA_REFACTOR_PLAN.md`: current media architecture and unreleased-change truth source

More detail: [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md).

## Core Commands

```bash
npm install
npm run dev
npm run server
npm run dev:single:native
npm run dev:dual:native
npm run dev:dual:web
npm run dev:triple:native
npm run triple:nwn
npm run check:vds-web
npm run test:vds-web
npm run test:server
npm run build:vds-web
npm run build:media-agent
npm run build:release
```

## Native Test Flows

- `npm run dev:single:native`
  - local server + 1 native client
- `npm run dev:dual:native`
  - local server + 1 host + 1 native viewer
- `npm run dev:dual:web`
  - local server + native host + web viewer flow
- `npm run dev:triple:native`
  - local server + 1 host + 2 native viewers
- `npm run triple:nwn`
  - native host + web relay/viewer + native viewer scenario

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
- keyframe interval controls

OBS mode currently behaves like this:

- VDS prepares a local SRT address and waits for OBS to push a valid program stream
- default port is `61080`
- the user can optionally save a custom local port for OBS
- VDS does not control OBS and does not use `obs-websocket`
- OBS mode is local-only and not a generic remote SRT gateway

Viewer join mode currently behaves like this:

- default tab is `Lobby`
- the lobby polls `/api/public-rooms` while the join panel is open
- hosts choose whether a room is public before starting share
- manual room code entry remains available in the `Direct` tab

## Release and Deployment

- `npm run build:release`
  - runs prebuild checks, including VDS_web build and media-agent verification
  - builds Electron installer
  - refreshes `server/updates/`
  - validates packaged media-agent runtime against `runtime/media-agent`
  - validates `dist/` and `server/updates/` update manifests
  - publishes the GitHub Release through `gh`
- `npm run release:github`
  - requires GitHub CLI `gh` and an authenticated session
  - creates tag `v<version>` if needed, pushes it, and uploads installer, blockmap, and `latest.yml`
  - refuses dirty worktrees unless `ALLOW_DIRTY_GITHUB_RELEASE=1` is set
- `server/` is the deployable server directory
- desktop auto-update feed is served from `server/updates/`
- release notes for recent versions are tracked in [CHANGELOG.md](CHANGELOG.md)

## Source Control Rules

- build outputs are not committed
- `runtime/` binaries are not committed
- `server/public/vds_web/` is generated by `npm run build:vds-web` and is not committed
- update artifacts in `server/updates/` are deployment outputs, not source
- `docs/CODE_AUDIT_FINDINGS.md` records discovered issues and handling results for audit continuity
