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
- gathers mappings from up to four configured STUN URLs on the actual ICE UDP socket,
  predicts stable sequential port allocation, and tries bounded port neighborhoods
  through authenticated ICE checks; VDS does not configure TURN
- isolates transport generations and current ICE credentials across peer replacement
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

The regular build installs the vcpkg manifest dependencies, then invokes
`scripts/build-vds-ice.ps1` to rebuild libjuice 1.7.0 and libdatachannel 0.24.1 from
hash-pinned source archives with the tracked patches in `third_party/ice-patches/`.
The generated installation is under `build/vds-ice/installed/`. CMake verifies its
feature marker and patch/algorithm hashes before selecting it; changing these
sources requires rebuilding the enhanced dependencies. The runtime contains the
matching `juice.dll` and `datachannel.dll` beside the agent.

To rebuild only the enhanced libraries after the manifest dependencies are ready:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-vds-ice.ps1 -Configuration Release
```

## Runtime Dependencies

The build requires an FFmpeg SDK root containing `include/` and `lib/`. Set
`VDS_FFMPEG_SOURCE` when the SDK is not available at the default project-local
search path.

The standard Windows peer-enabled build uses Visual Studio 2022 C++, CMake, Git,
and a vcpkg toolchain. vcpkg supplies OpenSSL, usrsctp, SRTP and other base
dependencies; the tracked build script supplies the enhanced ICE libraries and
copies their runtime DLLs beside `vds-media-agent.exe`. A build without peer
transport can still run local media operations, but cannot provide native P2P.

## Pure P2P Traversal

`createPeer` accepts a validated `stunServers` pool of at most four URL entries and
a legacy `stunServer` primary. Each URL resolves to at most two addresses, with
resolved endpoints deduplicated. Validated STUN responses on the media socket are
ordered by the successful first-send sequence of IPv4 probes; IPv6 probes do not
consume that sequence. Linear prediction needs at least three consecutive samples
for the same mapped IPv4 address with a constant nonzero step whose
absolute value is at most 16. Unknown mappings use ±1 and ±2 around at most four
verified ports; stable mappings do not need speculative candidates.

A peer advertises at most 16 low-priority speculative candidates through the
existing signaling path. Candidates carry the current ICE `ufrag`, and the native
RPC/controller boundary associates requests and events with `transportGeneration`.
The current controllers pass the expected generation on operations; ordinary
legacy requests and candidates may omit these identity fields. Speculative
candidates require both the expected transport generation and current ICE ufrag.
A predicted endpoint must pass an authenticated ICE connectivity check before
carrying DataChannel traffic. Once a working pair is selected, other speculative
checks stop; closing the peer releases the ICE agent. The algorithm and library
patches are VDS implementations and contain no UU code.

Peer transport diagnostics include `stunServers`, `selectedStunServer`,
`natTraversalEnabled`, `natProbeObservations`, `natPortStep`,
`predictedLocalCandidates`, `predictedRemoteCandidates`, and
`transportGeneration`. `natProbeObservations` reports the underlying valid IPv4
mapping samples, including repeated equal mappings merged into one candidate.
A zero step means no linear allocation was confirmed.
Two STUN endpoints can support ordinary ICE and bounded neighborhood checks;
at least three distinct reachable IPv4 endpoints are needed for linear sampling.
Browser ICE controls its own socket scheduling; it can receive native speculative
candidates but cannot use the native socket implementation directly.

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
npm run verify:nat
```

CTest includes the pure port algorithm, real local STUN probes with source and
transaction validation, and a virtual-NAT fixture using real ICE, DTLS, SCTP and
DataChannel payload exchange. The fixture hides host candidates
and does not use TURN. The native RPC contract can also be exercised directly:

```powershell
node scripts/test-native-nat-contract.js runtime/media-agent/vds-media-agent.exe
```

These local fixtures establish behavior under their simulated mapping and
filtering rules. Cross-carrier networks, real router mappings and long-running
media require two-device acceptance.

`verify:nat` requires a Windows build with the enhanced dependencies and registered
NAT CTests. It compares current patch/algorithm stamps and the SHA256 hashes of
the built agent, `juice.dll`, and `datachannel.dll` against the runtime, then runs
the algorithm, STUN probes, virtual-NAT DataChannel fixture, and native RPC contract. Release
checks also compare those three files with the packaged runtime.

For full product validation, also run the Electron dual/triple client scripts and
the Web viewer flow documented in the root `README.md`.
