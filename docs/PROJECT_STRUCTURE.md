# Project Structure

This document is the maintenance map for the VDS repository. It separates source, generated output, release artifacts, and local test helpers.

## Top-Level Source Areas

- `desktop/`
  - Electron main process and preload bridge.
  - Owns native media-agent IPC, update flow, debug categories, window metadata helper startup, and packaged/runtime path resolution.

- `server/`
  - Deployable Node.js signaling server and Docker context.
  - `server/server-core.js` owns room lifecycle, WebSocket signaling, topology assignment, public-room listing, update static serving, and the 3010 admin snapshot API.
  - `server/index.js` is the production/local server entry.
  - `server/public/admin.html` is the standalone admin dashboard.

- `server/public/`
  - Electron renderer UI source served by the local/deployed server.
  - `app.js` owns shared UI, room lifecycle UI, update UI, source/quality modals, and non-native browser fallback glue.
  - `app-native-overrides.js` owns native media-engine behavior, native P2P signaling integration, surface sync, native diagnostics, and native start/stop share paths.
  - `style.css` and `index.html` are the desktop renderer UI shell.

- `vds_web/`
  - TypeScript Chrome/Edge web viewer source.
  - `src/main.ts` coordinates room signaling, upstream/downstream connections, UI, and encoded-frame relay; relay keyframe caching stays here.
  - `src/playback-session.ts` owns frame reassembly, video scheduling, the local audio/video players, and media-session cleanup. Its complete encoded frames can be relayed independently of local decoding.
  - `src/upstream-recovery.ts` handles connection failure timers; `src/webcodecs-*` implement decoding and output. Playback diagnostics are separate from connection/relay state.
  - Builds to `server/public/vds_web/` through `npm run build:vds-web`.
  - The build output is generated deployment content and is ignored by git.

- `media-agent/`
  - Native C++ media runtime.
  - Owns Windows capture, FFmpeg/native encode/decode, native surfaces, WGC preview, peer transport, audio capture/playback, relay dispatch, OBS ingest, and JSON RPC.
  - `src/nat_port_prediction.h` implements bounded port prediction and neighborhood generation from verified observations. `src/peer_stun_config.*` validates the pure STUN pool.
  - `third_party/ice-patches/` contains tracked patches for hash-pinned libjuice/libdatachannel sources; `cmake/VdsEnhancedIce.cmake` selects and verifies the patched installation. The actual ICE socket gathers mappings and runs connectivity checks.
  - `tests/nat_port_prediction_tests.cpp` covers the pure algorithm; `tests/juice_stun_probe_tests.cpp` exercises actual local STUN requests and response validation; `tests/nat_traversal_e2e.cpp` uses local virtual NATs and real ICE/DataChannel traffic.
  - Builds into `runtime/media-agent/` through the media-agent build/verify scripts.

- `scripts/`
  - Test, build, release, and local environment launch scripts.
  - JavaScript scripts are usually release/server checks.
  - PowerShell scripts usually launch local test environments or build/verify native runtime.
  - `build-media-agent.ps1` invokes `build-vds-ice.ps1` to rebuild the pinned enhanced ICE libraries before building the agent; `test-native-nat-contract.js` exercises transport generation and candidate admission through real native RPC.
  - `test-native-nat.js` is the Windows `verify:nat` entry; `native-runtime-integrity.js` compares the current algorithm/patch stamps and hashes of the agent plus both ICE DLLs across the build, runtime, and packaged runtime.

- `tools/`
  - Local helper tools. Currently includes the VDS test launcher.

- `docs/`
  - Long-lived maintenance documents.
  - `CODE_AUDIT_FINDINGS.md` is the audit log and must record issue handling results.
  - `LOGGING_DEBUG_SYSTEM.md` documents debug category behavior.
  - `MEDIA_AGENT_MODULARIZATION.md` and `MEDIA_REFACTOR_PLAN.md` capture media architecture state.

## Generated Or External Output

These paths should not be treated as source:

- `node_modules/`: npm dependencies.
- `dist/`: Electron build output and installer artifacts.
- `runtime/`: generated native runtime copied into Electron packages.
- `server/updates/`: generated desktop auto-update feed and installer copy.
- `server/public/vds_web/`: generated VDS_web static build output.
- `media-agent/build/`: native build tree.
- `media-agent/build/vds-ice/`: extracted dependency sources, patched builds, and the generated enhanced ICE installation.
- `tools/**/bin/` and `tools/**/obj/`: .NET build output.

## Command Groups

Development:

```bash
npm run dev
npm run server
npm run dev:single:native
npm run dev:dual:native
npm run dev:dual:web
npm run dev:triple:native
npm run triple:nwn
```

Checks:

```bash
npm run check:vds-web
npm run test:vds-web
npm run test:server
npm run check:logging
npm run check:server-docker
```

Native runtime:

```bash
npm run build:media-agent
npm run verify:media-agent
npm run smoke:media-agent
npm run verify:nat
```

Release:

```bash
npm run release:precheck
npm run build
npm run prepare-server-release
npm run release:check
npm run release:github
npm run build:release
```

When building media-agent in the local workspace, set `VDS_FFMPEG_SOURCE` to the prepared FFmpeg SDK path unless the script is intentionally run with a local fallback flag.

## Ownership Boundaries

- Signaling/topology bugs usually start in `server/server-core.js` and then fan out to `server/public/app-native-overrides.js` or `vds_web/src/main.ts`.
- Native preview, capture, encode, decode, and surface bugs usually start in `media-agent/src/*`; renderer fixes should only coordinate state or display diagnostics.
- NAT sampling, port prediction, and authenticated connectivity checks cross `media-agent/src/nat_port_prediction.h` and `media-agent/third_party/ice-patches/`. STUN selection and pool wiring start in `desktop/stun-server-selector.js` and `desktop/main.js`; queued candidate ownership lives in the native peer controller and Web connection code. VDS forbids TURN.
- Web room/relay bugs usually start in `vds_web/src/main.ts`; frame scheduling and cleanup start in `vds_web/src/playback-session.ts`; decoding/output start in `vds_web/src/webcodecs-*`. Capability detection and the frame wire format remain in `capabilities.ts` and `datachannel-protocol.ts`.
- Packaged-only native differences usually involve `desktop/main.js`, `runtime/media-agent/`, `dist/win-unpacked/resources/runtime/media-agent/`, or release-check runtime hash validation.
- Admin dashboard changes should stay in `server/public/admin.html` plus server snapshot fields in `server/server-core.js`.

## Cleanup Rules

- Do not move generated outputs into source directories.
- Do not commit `dist/`, `runtime/`, `server/updates/`, or `server/public/vds_web/`.
- Do not remove files from `server/public/` just because they look browser-facing; Electron uses that directory as its renderer source.
- Keep every fixed audit issue recorded in `docs/CODE_AUDIT_FINDINGS.md` with `修改意见` and `处理结果`.
- Prefer small, verified cleanup steps over broad directory reshuffles; release scripts depend on current paths.
