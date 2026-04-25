# Changelog

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
