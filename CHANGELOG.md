# Changelog

## 1.7.0

### 中文

- 完成 renderer 与 native authority 的第一轮模块化拆分，新增 app state、room client、调试面板、源选择、画质设置、更新 UI、native session/peer/surface/diagnostics/P2P 状态机等边界模块。
- 完成 media-agent session/controller ownership 收口，Host、Peer、Surface、Relay、Audio、OBS ingest 等路径改为更清晰的 session owner 与 registry/facade 模型。
- 修复 native/OBS 开始共享、停止共享、重复开播、房间创建、房间号显示、公开房间发现和 stale manifest 清理等生命周期问题。
- 修复 OBS ingest 音频链路与 AAC manifest，OBS 推流后可正确发布音视频 manifest 并向下游播放/转发。
- 修复源选择缩略图与 WGC 预览的多处时序问题，源缩略图改为异步加载，WGC 预览失败改为诊断化处理而不是拖垮主流程。
- 强化 Web/native relay 拓扑稳健性：优先链式 relay，上游不可达时服务端重新协商上游，并限制单上游下游容量。
- 新增/收紧 renderer 入口、renderer 语法、native bridge、room-client dispatcher、media-agent boundary、logging、server、VDS_web 与 media-agent 发布门禁。
- 改进 3010 信令后台，支持实时房间、拓扑、节点状态、边状态、容量和 manifest 可视化。

### English

- Completed the first renderer/native-authority modularization pass with dedicated app state, room client, debug panel, source selection, quality settings, update UI, native session, peer, surface, diagnostics, and P2P state-machine boundaries.
- Tightened media-agent session/controller ownership so Host, Peer, Surface, Relay, Audio, and OBS ingest paths are owned through clearer session owners plus registry/facade access.
- Fixed native/OBS share start, stop-share, repeated share, room creation, room-code display, public-room discovery, and stale-manifest cleanup lifecycle issues.
- Fixed OBS ingest audio and AAC manifest handling so OBS streams publish the correct audio/video manifest for playback and relay.
- Fixed source thumbnail and WGC preview timing issues, moved thumbnails to async loading, and made WGC preview failures diagnostic instead of fatal to the main flow.
- Improved Web/native relay topology robustness with chain-first routing, server-side upstream reselection when an upstream is unreachable, and per-upstream downstream capacity limits.
- Added and tightened release gates for renderer entry order, renderer syntax, native bridge wiring, room-client dispatch, media-agent boundaries, logging, server tests, VDS_web tests, and media-agent verification.
- Improved the 3010 signaling admin dashboard with live rooms, topology, node state, edge state, capacity, and manifest visualization.

## 1.6.9

- hardened WGC live preview source creation so SEH access violations are captured as diagnostics instead of terminating `media-agent`
- changed WGC live preview update cadence from fixed 1ms to frame-rate-based intervals to reduce preview overrun risk
- added staged WGC source creation diagnostics for capture item, frame pool, session, property, and start-capture failures
- added single native test launcher support and kept dual/triple native and web relay scripts documented
- tightened server topology selection so only fully relay-ready viewers can be assigned as downstream upstreams
- refreshed README/project structure documentation for the current 1.6.9 release state

## 1.6.8

- fixed packaged Electron minimized-window capture discovery by always launching `window-metadata-helper.js` with `ELECTRON_RUN_AS_NODE=1`, matching dev behavior where minimized windows are visible as capture targets
- documented the packaged-only root cause in `CODE_AUDIT_FINDINGS`
- refreshed installer, blockmap, update manifest, and GitHub Release assets for the patched desktop build

## 1.6.7

- improved native P2P signaling robustness with attempt isolation, stale signal filtering, and cleaner peer teardown for reconnecting host/viewer/relay edges
- added server-side upstream reselection with per-upstream downstream limits, including web relay capacity awareness and topology cleanup after viewer exits
- fixed host stop-share/re-share lifecycle so stopping share destroys the room and the same socket can create a fresh room without stale binding
- restored WGC live preview as the default native host preview path and hardened WGC source creation against WinRT creation failures
- improved native viewer surface stability while moving the window by coalescing bounds-driven surface sync and tracking final screen coordinates
- added a signal admin dashboard on port 3010 with graphical topology, node state, edge state, capacity, and live media manifests
- reduced diagnostic log noise by moving high-frequency surface, stats, and native event details behind the high-frequency debug channel
- integrated GitHub Release publishing into the full release build flow with `gh` asset upload, tag creation, and dirty-worktree protection
- expanded release and runtime validation around server topology, VDS_web protocol behavior, logging policy, and media-agent verification

## 1.6.6

- improved Web H.265 playback sizing by configuring WebCodecs from the media manifest with codec-aware coded/display dimensions and safe fallback when unsupported
- fixed native-capture H.265 Web viewer cropping where Edge reported a smaller HEVC visible/display rect than the intended coded frame
- improved OBS ingest H.265 handling so Web playback adapts to the actual incoming stream resolution instead of assuming the desktop quality preset
- added Web viewer console diagnostics for H.265 keyframes, WebCodecs configuration, and VideoFrame coded/display/visible/source rectangles
- expanded VDS_web protocol tests for HEVC 1080p, 2K, and mismatched manifest-vs-decoded stream dimensions
- kept the failed `hevc_metadata width/height` sender-side experiment out of the release path after confirming it could suppress Web video keyframes

## 1.6.5

- added the VDS_web Chrome/Edge viewer with DataChannel encoded media playback, WebCodecs video/audio decode, manual audio delay, volume control, fullscreen playback, and a Windows-app-aligned viewer interface
- unified native and web relay direction around `vds-media-encoded-v1` DataChannel encoded media, including media manifest sync, session/version handshake checks, chunked large-frame delivery, bootstrap keyframe forwarding, and failfast diagnostics
- improved Native-Web-Native and Native-Web-Web relay recovery so middle-node exits can trigger chain reconnect, reconnect-ready signaling, stale-peer cleanup, and restored host/viewer negotiation without stale failfast UI
- fixed DataChannel viewer diagnostics and counters, including video-only receive FPS, absolute viewer counts, audio receive accounting, early ICE candidate caching, and clearer encoded DataChannel state reporting
- improved Web playback reliability with Opus/AAC/H.265 capability handling, continuous WebCodecs audio scheduling to reduce pops, and stale DataChannel error suppression after successful reconnect
- improved Windows startup/share stability by isolating Win32/Koffi window metadata discovery in a helper process while keeping minimized-window detection, and by clearing `ELECTRON_RUN_AS_NODE` in dev startup
- added `dual:web` and `triple:nwn` local test scripts plus VDS_web TypeScript, build, and protocol tests to the release gate

## 1.6.4

- improved session resume and server protocol safety with unguessable tokens, payload limits, room/viewer limits, message rate limits, and collision-safe room IDs
- improved connection recovery stability by bounding pending messages, handling invalid WebSocket JSON safely, and making teardown paths more reliable
- added compact P2P state visibility on host and viewer screens, including gathering, checking, connected, media waiting, reconnecting, failed, and NAT mapping states
- added debug-only P2P diagnostics with copyable candidate counts, selected candidate pair, RTT, frame counters, loss recovery counters, and NAT-PMP/PCP fallback details
- added debug-only native capture diagnostics for capture FPS, preview FPS, encode/send FPS, readback timings, encoder state, dropped frames, and audio capture state
- improved native/media-agent reliability around Windows window title reads, special path quoting, invoke timeouts, and WASAPI callback isolation
- improved the viewer lobby refresh experience so automatic refresh is silent while manual refresh still updates visible feedback
- tightened server room lifecycle cleanup so host grace resume remains possible while expired rooms invalidate session tokens and clean viewer state
- added a fixed `npm run release:check` gate that validates syntax, server tests, logging policy, media-agent verification, production audit, and update artifact metadata
- refined NAT-PMP/PCP as a short last-chance pure-P2P fallback after ICE/failfast only, with mapped srflx candidates injected through Trickle ICE when available
- documented the build and release handoff flow for future maintainers

## 1.6.3

- added RTP loss recovery on the native peer transport with NACK retransmission support, PLI handling, and keyframe request diagnostics
- added Trickle ICE candidate forwarding plus pure-P2P failfast reporting for clearer connection failures
- added last-chance NAT-PMP / PCP port mapping after P2P failfast, then injects mapped srflx candidates through Trickle ICE when available
- added advanced keyframe policy controls for `1s`, `0.5s`, and `all-intra` troubleshooting
- tightened pure-P2P ICE policy by filtering TURN/TURNS configuration from server and renderer paths
- expanded P2P diagnostics and release validation coverage

## 1.6.2

- added a public-room lobby with `Lobby / Direct` join tabs, auto-refreshing room list polling, and manual refresh
- added host-side public room exposure control plus live room visibility state in the host panel
- auto-copy the room code on successful room creation, including OBS ingest room startup
- kept viewer playback on the passthrough-only path with manual audio delay and removed the old synced path from the current mainline
- refreshed installer, blockmap, update manifest, and server release outputs for the new desktop version

## 1.6.0

- fixed WGC frame-pool recreation on live window resize so host preview and viewer no longer corrupt together
- stabilized minimized-window startup restore with startup-only placeholder plus soft refresh audio/video recovery
- polished viewer stage presentation and refreshed installer, blockmap, and update manifest for the new desktop version

## 1.5.9

- polished the source selection modal with simplified subtitles plus sticky refresh and confirm controls
- refined viewer fullscreen underbar behavior and native surface layout handling around maximize and fullscreen flows
- refreshed installer, blockmap, and update manifest for the new desktop version

## 1.5.8

- fixed relay bootstrap handoff and rejoin behavior for the `host -> v1 -> v2` native chain
- tightened viewer disconnect handling and native surface cleanup during relay leave/reconnect flows
- refreshed installer, blockmap, and update manifest for the new desktop version

## 1.5.7

- release rollover for the latest native media stack and packaging outputs
- refreshed installer, blockmap, and update manifest for the new desktop version

## 1.5.6

### Media

- landed codec-aware native video path for `H.264 / H.265`
- enabled H.265 selection in desktop quality settings
- kept relay on native encoded fanout instead of browser-side re-encode
- tightened bootstrap and startup gating around decoder config plus random access frames

### Capture and Performance

- fixed Win11 24H2 WGC high-FPS capture by setting `GraphicsCaptureSession.MinUpdateInterval(1ms)` when supported
- explicitly set WGC cursor capture and border flags when the platform exposes those properties
- added local preview toggle in quality settings
- added host/viewer FPS diagnostics in the UI

### Encoder Detection

- replaced raw FFmpeg encoder listing with per-encoder self-test validation
- added manual hardware encoder selection from the validated encoder list
- improved hardware/software encoder messaging in the quality settings UI

### Reliability and Diagnostics

- fixed screen/display capture source mapping issues in native host session startup
- reduced repeated encoder self-test spam during repeated host entry
- gated verbose native stderr behind video debug logging
- improved native stats and host/viewer diagnostics for capture, send, receive, and render flow
