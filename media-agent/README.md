# vds-media-agent

This directory holds the native media runtime that will replace the renderer-owned media pipeline.

## Current Scope
This is a scaffold, not the full media engine yet.

Current implementation:
- builds a small C++ executable
- speaks newline-delimited JSON over stdio
- exposes a minimal RPC surface for capability and status probing
- returns explicit `NOT_IMPLEMENTED` errors for media actions that are part of the next phases

## Build
From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-media-agent.ps1 -Configuration Release
```

The script copies the built binary to:

```text
runtime/media-agent/vds-media-agent.exe
```

That is the path the Electron main process will probe in development and packaging flows.

## Wire Protocol
Messages are newline-delimited JSON objects.

Request:

```json
{"id":1,"method":"getCapabilities","params":{}}
```

Response:

```json
{"id":1,"result":{"ready":true}}
```

Error response:

```json
{"id":1,"error":{"code":"NOT_IMPLEMENTED","message":"Method not implemented in scaffold"}}
```

Event:

```json
{"event":"agent-ready","params":{"name":"vds-media-agent","version":"0.1.0"}}
```

## Planned Responsibilities
- unified capture discovery
- per-process audio capture
- FFmpeg encode/decode
- libdatachannel peers
- native render windows
- stats and sync diagnostics
