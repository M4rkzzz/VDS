# vds-media-agent

`media-agent` is the native Windows media runtime used by the Electron client.
It owns the production media authority for native capture, OBS ingest, encoded
peer transport, relay fanout, viewer decode/playback, native surfaces, and media
diagnostics.

## Current Scope

Current implementation:

- speaks newline-delimited JSON-RPC over stdio
- reports capabilities, status, stats, and agent-ready events
- manages native host sessions for Windows Graphics Capture and local OBS ingest
- builds FFmpeg-based host capture, encode, artifact, and ingest pipelines
- integrates optional libdatachannel peer transport for native WebRTC/DataChannel
- supports encoded media relay for H.264/H.265 video and Opus/AAC audio paths
- manages native viewer audio playback and native video surface attachment
- emits structured status snapshots and throttled diagnostics

Some unsupported or build-disabled methods may still return `NOT_IMPLEMENTED`.
The current module boundary and acceptance history are tracked in
`../docs/MEDIA_AGENT_MODULARIZATION.md`.

## Build

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-media-agent.ps1 -Configuration Release
```

The script copies the built binary to:

```text
runtime/media-agent/vds-media-agent.exe
```

That is the path the Electron main process probes in development and packaging
flows.

## Runtime Dependencies

The build requires an FFmpeg SDK root containing `include/` and `lib/`. Set
`VDS_FFMPEG_SOURCE` when the SDK is not available at the default project-local
search path.

When a vcpkg toolchain is available, the build script enables libdatachannel and
copies the required runtime DLLs beside `vds-media-agent.exe`. Without vcpkg, the
agent can still build, but native peer transport is reported unavailable.

## Wire Protocol

Messages are newline-delimited JSON objects.

Request:

```json
{"id":1,"method":"getCapabilities","params":{}}
```

Response:

```json
{"id":1,"result":{"platform":"win32","implementation":"native-media-agent"}}
```

Event:

```json
{"event":"agent-ready","params":{"name":"vds-media-agent","version":"0.1.0","implementation":"native-media-agent"}}
```

Unsupported method response:

```json
{"id":1,"error":{"code":"NOT_IMPLEMENTED","message":"Method is not implemented by this media-agent build"}}
```

## Verification

Useful commands from the repository root:

```powershell
npm run smoke:media-agent
npm run test:media-agent
npm run verify:media-agent
```

For full product validation, also run the Electron dual/triple client scripts and
the Web viewer flow documented in the root `README.md`.
