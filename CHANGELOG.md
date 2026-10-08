# Changelog

## Unreleased

## 1.7.3

- 修复进程音频选择：弹窗提前异步发现音频，显示加载与失败状态，隔离迟到结果；窗口 PID 直接使用已有 WASAPI 进程树采集，不再要求当前活跃音频会话必须精确匹配窗口 PID；整屏允许手选活跃音频进程，不强制系统混音。
- 修复房间过期恢复：未确认的建房/加入重发原请求，房主复用当前媒体重建并显示服务端确认的新房号，观看者清理失效会话；取消或停止不复活旧任务，取消刷新释放界面忙状态。与现有公网 1.7.2 的严格 TLS 协议兼容实测通过，仅使用自有私有临时房，未推送媒体。
- 修复原生异常分片、Annex-B 缓冲和慢下游发送积压，减少逐片事件输出，完善媒体关停与 FFmpeg 进程树清理。
- 修复信令身份碰撞、字段透传和半开连接；免令牌公网后台仅显示公开房间，新房号为 12 位，旧 6 位房号仍可加入。补齐 IPC/JSON/RPC 边界、桌面与 Web 握手取消、日志轮转、Web 分片空闲清理及 CGNAT 判定。
- 更新链新增离线 Ed25519 清单签名和安装包大小/哈希复验，生产源固定 HTTPS，停用未认证差分下载。先分发支持 12 位房号和更新公钥的新桌面，再更新服务端；旧客户端首次迁移仍需可信分发。
- 减少媒体热路径重复工作：`audio-data` 诊断仅在已有 `VDS_VERBOSE_MEDIA_LOGS=1` 时生成；WGC 复用 CPU 缓冲并在 GPU 回读前执行原有采样，就绪判断直接读取布尔状态；Web 播放端单 AU 一次 NAL 扫描、按需 AVCC、小参数集独立副本；relay 锁外分析 NAL，取消逐订阅者 `live_units` 整份复制。
- Windows 包仅保留目标架构 Koffi，根 Express/ws 改开发依赖，服务端保留运行依赖；修正平台过滤覆盖主文件白名单，增加真实 builder matcher 与发布 ASAR 范围检查，删除停用差分后的无用安装包缓存副本。单配置 Ninja 默认 Release，保留原生测试。
- 服务端使用 compression 1.8.2 压缩适用文本，仅构建 hash assets 一年 immutable，HTML、更新清单及签名 no-store，updates/Range 不压缩；Docker 使用 `COPY --chown`，去掉递归 chown。
- 完整 check（Web 148/148、桌面 213/213、静态响应 7/7）、构建与真实本机 1080p60 B0 八阶段恢复通过；原生优化轮 CTest 23/23 通过，此次音频选择/房间修复未再改动 native。1.7.3 安装包为 235,378,402 字节，离线签验、40 源文件与 ASAR 一致性、native 完整性、打包界面房间恢复及实际安装启动退出通过；真实进程 loopback 采集通过，未据此宣称进程音频编码或端到端播放验收。
- 保持纯 P2P、禁止 TURN，不新增 FPS、码率、分辨率或运行时长配额。Windows 安装包仍无 Authenticode 签名；本机短测不代表性能提升、真实 WGC GPU、物理声卡长跑或跨运营商验收。

## 1.7.2

### 中文

- 增强纯 P2P 连接：从实际 ICE UDP socket 获取多个 STUN 映射样本，按稳定步长预测端口，并进行有限邻域多端口连通性检查；自行实现 libjuice/libdatachannel 补丁，继续禁止 TURN。
- 整理 Web 播放会话，原生端分离解码与呈现；两种播放器按源帧率、短突发和实际音频进度调整缓冲，保留合法长音频单元，不增加固定帧率、分辨率或运行时长限制。
- 统一共享源 PTS 与 `sourceEpoch` 媒体代次，隔离换源后的旧数据；使用 waveOut/Web Audio 输出位置驱动视频，无音频或零音量时回退单调时钟，并改善关键帧恢复和重连后的实时追赶。
- 修复过期 socket、取消或迟到的加入确认、surface 恢复、上游重选、media-agent 停启和 OBS 断流清理，补充连接、播放与生命周期回归。
- 更新至 Electron 42.11.11，整理依赖和原生构建完整性检查，固定增强 ICE 的源包及补丁。
- 恢复 Docker 信令与后台、FRP HTTPS/WSS 入口和 DNS 验证证书续期；管理后台按要求免管理令牌访问，保留房间会话身份隔离。
- Windows 构建未签名。跨运营商实机连通与长时间物理音画同步仍待验收；本地回归与虚拟 NAT 结果不代表实际网络连接率或性能提升。

### English

- Enhanced pure P2P connectivity with mapping samples from multiple STUN services on the actual ICE UDP socket, stable-step port prediction, and bounded connectivity checks on neighboring ports. Kept TURN disabled and implemented the libjuice/libdatachannel patches within this project.
- Consolidated the Web playback session and separated native decoding from presentation. Both players adapt buffering to source frame rate, short bursts, and actual audio progress while preserving valid long audio units, without adding fixed frame-rate, resolution, or runtime limits.
- Added shared source PTS and `sourceEpoch` isolation for source changes. Video follows waveOut/Web Audio output progress, falls back to a monotonic clock when audio is absent or muted, and benefits from improved keyframe recovery and reconnect catch-up.
- Fixed stale sockets, canceled or late join acknowledgments, surface recovery, upstream reselection, media-agent restart, and OBS disconnect cleanup, with connection, playback, and lifecycle regressions.
- Updated to Electron 42.11.11, refreshed dependencies and native runtime integrity checks, and pinned the enhanced ICE sources and patches.
- Restored the Docker signaling service and dashboard, FRP HTTPS/WSS access, and DNS certificate renewal. Removed dashboard management tokens as requested while retaining room session identity isolation.
- Windows builds are unsigned. Connectivity between different ISPs and long-running physical audio/video synchronization still require real-device validation; local regressions and virtual NAT results do not establish a real-world connection rate or performance gain.

## 1.7.1

### 中文

- 发布完整 1.7.1 Windows 安装包、blockmap 与 `latest.yml`，并上传到 GitHub Release。
- 完成 GitHub 发布流程校验：发布前检查、Electron 打包、server 更新源准备、发布后 artifact 一致性校验和 GitHub asset 上传均通过。
- 移动 Web 真机诊断改为人工 QA 证据，不再作为自动发布硬门禁；保留单份诊断 JSON 的场景校验能力。
- README 改为中文主页，补充当前媒体路径、局域网手机 HTTP、测试命令、发布门禁、画质设置和部署说明。
- 继续保留 1.7.x 主线改动：renderer/native authority 模块化、media-agent session/controller ownership、native/OBS 生命周期修复、Web/native relay 拓扑增强、3010 后台拓扑可视化和移动浏览器 Web 观看端适配。

### English

- Published the full 1.7.1 Windows installer, blockmap, and `latest.yml` to GitHub Release.
- Completed release validation: precheck, Electron packaging, server update-feed preparation, postbuild artifact consistency checks, and GitHub asset upload all passed.
- Changed mobile Web real-device diagnostics from an automated release gate to manual QA evidence while keeping per-report scenario validation.
- Localized the GitHub README homepage to Chinese with media path, LAN mobile HTTP, test commands, release gates, quality settings, and deployment notes.
- Kept the 1.7.x mainline improvements around renderer/native-authority modularization, media-agent session ownership, native/OBS lifecycle fixes, Web/native relay topology, the 3010 topology dashboard, and mobile browser Web viewer support.

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
