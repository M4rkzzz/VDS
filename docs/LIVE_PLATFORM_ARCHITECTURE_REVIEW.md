# 第三方直播平台视角架构评审

评审日期：2026-06-21

评审对象：VDS `1.6.9` 当前工作区

评审视角：第三方直播平台 / 实时互动直播 / 屏幕共享产品架构

## 1. 总体判断

VDS 当前不是传统“中心化直播平台”架构，而是一个以小房间、低人数、低延迟、端侧 native authority 为核心的实时屏幕共享系统。它的核心竞争点是：Windows native 采集与编码、encoded DataChannel relay、链式 fanout、web 观看兼容、明确 failfast、可诊断的 P2P 状态。

从直播平台专家视角看，当前项目已经越过了原型阶段，具备可运行的产品骨架；但整体仍是“功能驱动迭代”留下的形态：控制面、媒体面、观测面、配置面、发布面还没有完全分层，多个关键文件承担了过多职责，生产级可扩展性和可运营性不足。

一句话评价：

> 当前架构适合 1-5 人小房间低延迟屏幕共享继续打磨；如果目标是稳定服务大量第三方用户，需要把它从“端侧 P2P 产品”演进为“控制面 + 媒体面 + 可观测面 + 策略面”分层的平台架构。

## 2. 现状优点

### 2.1 媒体方向选择是清醒的

项目已经明确不再把浏览器 `<video>` 或标准 WebRTC media track 当成主媒体 authority，而是走 native capture / native decode / encoded relay。这个选择对 Windows 屏幕共享是合理的：可控、可诊断、可绕过浏览器 media pipeline 的不可控因素。

当前证据：

- `README.md` 明确 native capture、native libdatachannel、H.264/H.265、Opus/AAC、encoded fanout。
- `MEDIA_REFACTOR_PLAN.md` 明确 `native authority` 和 `vds-media-encoded-v1`。
- `media-agent/src/*` 已经把 capture、preview、peer transport、relay、OBS ingest 拆成多个模块。

### 2.2 低延迟链式 relay 的产品定位明确

服务端已经有拓扑分配、上游重选、每上游下游数限制、链路 ready 状态和 3010 后台拓扑。对小房间实时屏幕共享来说，这比盲目上 CDN/RTMP 更贴近低延迟需求。

当前证据：

- `server/server-core.js` 有 `selectViewerUpstream()`、`requestViewerReconnect()`、`connect-to-next`、`chain-reconnect`。
- `server/public/admin.html` 与 `/api/admin/rooms` 已有拓扑视图。
- `scripts/test-server-core.js` 覆盖 fanout、上游重选、capacity、half-ready viewer 等场景。

### 2.3 诊断意识强于一般早期项目

项目已经引入：P2P 诊断、native stats、logging policy、media-agent smoke/unit tests、server tests、release check、GitHub release flow。这是非常重要的基础，因为实时音视频问题不能靠猜。

当前证据：

- `scripts/release-check.js` 串联 syntax、web check、server test、logging、media-agent verify、audit、Docker context。
- `docs/CODE_AUDIT_FINDINGS.md` 记录大量问题和处理结果。
- `server/public/app-native-overrides.js` 和 `media-agent/src/*` 暴露大量 stats/reason/lastError。

## 3. 架构级问题

### P0：媒体面没有生产级兜底路径，纯端侧拓扑会限制可靠性

当前主路径是 host -> viewer -> viewer 的 encoded DataChannel relay。这个路线对小房间低延迟有价值，但它天然依赖每个 viewer 的机器性能、网络、浏览器/native 状态。一旦中间节点 CPU/GPU 抖动、窗口移动、系统省电、网络 NAT、DataChannel buffer 堵塞，下游会受影响。

直播平台通常不会把普通观众作为核心转发基础设施。成熟架构会把端侧 relay 作为优化路径，而不是唯一可靠路径。

建议：

- 保留当前 P2P/链式 relay，定义为 `low-latency direct mode`。
- 增加显式的 `managed relay mode`，由平台部署 media relay/SFU/edge relay 节点承接转发。
- 不要做静默 fallback；在房间策略中明确显示：直连模式、托管 relay 模式、混合模式。
- 服务端拓扑分配时，不只看 ready/capacity，还应看节点健康度：RTT、丢帧、bufferedAmount、decode/render fps、CPU/GPU 压力、最近重连次数。

目标架构：

```text
Client Host -> Media Edge/SFU -> Viewers
            \-> Direct P2P Chain (small room optimization)
```

### P0：控制面和信令状态仍集中在单进程内存 Map

`server/server-core.js` 当前使用进程内 `rooms = new Map()` 管理房间、host、viewer、拓扑和 manifest。单机部署简单，但平台化会遇到：进程重启房间全丢、无法水平扩展、无法跨节点调度、无法做灰度发布、无法做多地域接入。

建议：

- 抽出 Control Plane：Room Service、Session Service、Topology Service、Manifest Service。
- 引入外部状态存储：Redis 或其他低延迟 KV，保存房间、连接租约、session token、manifest version、拓扑版本。
- 给所有拓扑变更引入 `topologyVersion`，客户端只接受版本单调递增的 `chain-reconnect/connect-to-next`。
- WebSocket server 变成 stateless-ish edge gateway：负责连接和转发，房间事实以 Control Plane 为准。

阶段目标：

1. 先把 `server-core.js` 内 room/topology 逻辑拆成纯模块，保留内存实现。
2. 再给模块增加 repository 接口，默认 MemoryRepository。
3. 最后替换为 RedisRepository，并支持多 server 实例。

### P0：媒体协议是事实协议，但还不是强版本化平台协议

当前 `vds-media-encoded-v1` 已经有 hello、hello-ack、frame、chunk、manifest 校验，但平台级协议还需要更强的兼容策略：能力协商、错误码枚举、状态机、版本弃用、字段兼容、端到端 tracing。

建议：

- 建立 `docs/protocol/`，至少包含：
  - `signaling-v1.md`
  - `encoded-media-v1.md`
  - `room-topology-v1.md`
  - `error-codes.md`
- 把 `SignalMessage`、media manifest、DataChannel control/frame header 变成可生成的 schema，例如 JSON Schema 或 TypeScript source of truth。
- 每个信令消息都带：`roomId`、`senderId`、`targetId`、`attemptId`、`topologyVersion`、`mediaSessionId`、`manifestVersion`、`traceId`。
- 客户端和 media-agent 的错误原因统一进入 error code registry，避免 `reason` 字符串逐渐失控。

### P1：Renderer 层承担过多编排职责

`server/public/app-native-overrides.js` 超过 5000 行，`server/public/app.js` 超过 4500 行。它们同时处理 UI、状态机、信令、native IPC、surface layout、诊断、重连、OBS/native start/stop。这种形态会导致每次修一个媒体问题都可能影响 UI、房间生命周期或信令时序。

建议拆分为 renderer 内部模块：

```text
server/public/
  app.js
  app-state.js
  room-client.js
  debug-panel.js
  source-selection.js
  quality-settings.js
  native/
    native-session-controller.js
    native-peer-controller.js
    native-surface-controller.js
    native-diagnostics.js
    p2p-state-machine.js
```

短期不需要上打包器也可以拆，直接用浏览器原生 module 或继续 script 但按职责分文件。关键是把状态机从 UI 事件里剥离出来。

### P1：media-agent 状态结构仍偏“大一统运行时”

`AgentRuntimeState`、`PeerState` 已经比早期好很多，但仍是多个子系统共享的大状态容器。直播平台媒体进程更适合 actor/session 模型：HostSession、PeerSession、SurfaceSession、AudioSession、RelaySession 分别有清晰生命周期，互相通过消息或明确接口协作。

建议：

- 定义 `HostSessionController` 是 host capture/encode 的唯一 owner。
- 定义 `PeerSessionController` 是每个 peer transport/receiver/sender 的唯一 owner。
- Relay 不直接读写多个 peer 的内部 runtime，改为通过 `EncodedFrameBus` 或 `RelayHub` 分发。
- 所有 session 都实现统一生命周期：`create -> configure -> start -> running -> draining -> stopped -> destroyed`。
- 对外 JSON RPC 不直接操作 runtime map，而是发 command 到对应 session controller。

### P1：QoS 与自适应策略还不足

当前质量主要由 host 预设控制，诊断能看到 fps、frame counts、buffer、drop 等，但还没有形成自动 QoS 闭环。成熟直播平台至少需要根据网络和端侧负载动态做策略调整。

建议增加 QoS Controller：

- 输入指标：RTT、NACK、PLI、DataChannel bufferedAmount、send/receive fps、decode fps、render fps、audio drop、CPU/GPU 压力、WGC readback 耗时。
- 输出动作：降帧率、降码率、请求关键帧、延长 keyframe interval、切 codec、暂停本地预览、重选上游、切 managed relay。
- 策略必须可配置：低延迟优先、清晰度优先、省电优先、稳定优先。
- 每次策略动作要写入诊断和 3010 后台，便于回溯。

### P1：可观测性仍偏“本地诊断”，缺少平台运营视角

3010 后台已经能看房间和拓扑，这是好开端。但平台运维需要跨房间、跨版本、跨地区、跨客户端类型的指标聚合。

建议：

- 引入 structured event log：每个客户端、server、media-agent 输出统一 JSON 事件。
- 增加全链路 `traceId`：从 create-room/join-room 到 offer/answer/ice/datachannel/media-frame 都可关联。
- 建立 Prometheus/OpenTelemetry 风格指标：
  - room_count、viewer_count、join_success_rate
  - p2p_connect_time_ms、p2p_fail_rate、reconnect_count
  - media_first_frame_ms、video_decode_fps、audio_drop_rate
  - update_check_success_rate、media_agent_crash_count
- 3010 后台从“实时调试面板”升级为“运营健康面板”：房间列表、异常房间、版本分布、失败原因 TopN。

### P1：安全模型还停留在轻量房间级别

当前有 session token、payload limit、message rate limit、room limit，这些是必要基础。但第三方直播平台还需要更完整的身份、鉴权、权限和后台安全。

建议：

- admin 后台必须加认证，至少 bearer token / basic auth / 内网白名单。
- `/api/public-rooms` 应避免泄漏敏感房间，公开房间要有明确 host opt-in 和过期策略。
- roomId 和 sessionToken 应纳入统一 auth 模型，支持踢人、封禁、只读 viewer、host transfer。
- WebSocket 消息按角色、状态机、拓扑版本做 schema validation，不只做字段长度和简单授权。
- 更新 feed 与 installer 发布链路应明确签名校验、TLS 域名和证书续期策略。

### P2：Web 端定位需要产品化收敛

Web viewer 当前是 Chrome/Edge + WebCodecs + encoded DataChannel relay。这个技术方向合理，但 web 端不应同时承担“可观看产品”和“协议实验 harness”的混合定位。

建议拆成两层：

- `vds_web_viewer`：面向用户，稳定观看、清晰错误提示、能力检测、低噪声诊断。
- `vds_web_lab`：面向开发，协议调试、frame stats、chunk reassembly、WebCodecs 详细日志。

生产 web viewer 应把能力不支持、codec 不支持、非 HTTPS、AudioContext 未激活等问题转成明确 UX，而不是主要依赖 console/textarea 诊断。

### P2：发布和配置仍偏本地脚本化

当前 release flow 已经很强，尤其 packaged media-agent hash 校验是正确方向。但平台化后还需要配置与发布治理。

建议：

- 所有关键参数从硬编码/环境变量迁移到版本化配置：STUN/TURN、fanout limit、grace time、QoS 阈值、debug sampling、update URL。
- 增加 `config schema + config validation`，发布前校验生产配置。
- 增加 staging/prod 环境区分，不要只有本地脚本和 Docker compose。
- GitHub Release、update feed、Docker image 应形成同一个 release manifest，记录 commit、version、installer hash、server image digest、media-agent hash。

## 4. 推荐目标架构

建议把项目演进为五个平面：

```text
Client Runtime Plane
  Electron Host/Viewer
  Web Viewer
  Native media-agent

Control Plane
  Room Service
  Session/Auth Service
  Topology Service
  Manifest Service

Media Plane
  Direct P2P / Chain Relay
  Managed Relay / SFU Edge
  OBS Local Ingest Gateway

Observability Plane
  Metrics
  Structured Logs
  Traces
  Admin Console

Release & Config Plane
  Versioned Config
  Build Artifacts
  Update Feed
  GitHub/Docker Release Manifest
```

当前代码可以逐步映射：

- `server/server-core.js` 拆出 Control Plane 模块。
- `media-agent/src/*` 收敛为 Client Runtime + Media Plane client。
- `server/public/admin.html` 升级为 Observability Plane 的第一版。
- `scripts/release-check.js` 与 `prepare-server-release.js` 升级为 Release Plane 的第一版。

## 5. 优先级路线图

### Phase A：先做“架构边界收口”，不改产品行为

目标：降低改 bug 的连带风险。

1. 拆 `server/server-core.js`：
   - `room-store.js`
   - `topology-service.js`
   - `signaling-router.js`
   - `admin-snapshot.js`
2. 拆 `app-native-overrides.js`：
   - native session
   - native peer
   - surface sync
   - diagnostics
   - p2p state machine
3. 建立协议文档和错误码 registry。
4. 所有拆分保持现有测试通过，不引入新架构行为。

### Phase B：做“状态机和拓扑版本化”

目标：解决 P2P/relay 问题靠时序修补的根因。

1. 给 room topology 增加 `topologyVersion`。
2. 给每条 edge 增加 `edgeId` 和 `edgeAttemptId`。
3. 客户端只接受当前 edge 的 offer/answer/ice/datachannel 事件。
4. 3010 后台展示 topology version、edge attempt、最近失败原因。
5. server tests 覆盖 stale topology、stale edge、late ICE、late answer。

### Phase C：引入 QoS Controller

目标：从“出问题后诊断”升级为“运行中自动调节”。

1. 先只做观测，不自动动作：汇总 RTT、drop、buffer、fps、decode/render。
2. 再做低风险动作：上游重选、请求关键帧、限制下游 fanout。
3. 最后做媒体参数动作：降 fps/bitrate、切稳定策略、暂停预览。

### Phase D：平台化部署

目标：从单机信令变成可运营服务。

1. Redis room/session store。
2. 多 server 实例共享房间状态。
3. 管理后台认证。
4. release manifest 统一 installer/server image/update feed。
5. 增加 managed relay/SFU edge 的技术验证。

## 6. 具体技术建议清单

### 服务端

- 把房间生命周期和拓扑计算从 WebSocket handler 中拆出来。
- 所有信令消息使用 schema validation。
- 引入 topologyVersion 和 edgeAttemptId。
- admin API 加认证和只读权限控制。
- 增加 Redis-ready 的 repository 接口。
- 增加 join path 的可观测指标：join accepted、assigned upstream、offer sent、first media ready。

### Native media-agent

- 把 `AgentRuntimeState` 写访问限制到 session controller。
- Relay 使用 frame bus/hub，不直接穿透多个 peer runtime。
- 对 WGC、encoder、transport、surface、audio 分别输出标准化健康状态。
- 增加端侧 CPU/GPU/encoder queue/backpressure 指标。
- 对 DataChannel bufferedAmount 做主动降载策略。

### Electron renderer

- 拆分 `app-native-overrides.js`，建立明确状态机。
- UI 只订阅状态，不直接驱动复杂媒体时序。
- start/stop/share/reconnect 每条路径都有 generation/token 防 stale 写回。
- 诊断面板和业务 UI 分离，默认用户只看到可行动错误。

### Web viewer

- 将用户观看 UI 与协议实验诊断分离。
- 能力检测输出产品化建议，例如“请使用 HTTPS Edge/Chrome”“主持端请切 H.264”。
- Web relay 明确 capacity 默认 1，并把当前原因上报服务端。
- AudioContext、WebCodecs decode、DataChannel buffer 统一进入 QoS 观测。

### 发布运维

- 增加 `release-manifest.json`，记录 version、commit、installer sha512、media-agent sha256、server package hash、Docker image digest。
- release check 校验 README/CHANGELOG/MEDIA_REFACTOR_PLAN 版本一致。
- update 域名/TLS 证书纳入发布前检查。
- Docker compose 只是本地/单机部署模板，生产部署需要独立文档。

## 7. 结论

VDS 当前最有价值的方向是“低延迟 Windows 屏幕共享 + native authority + encoded relay”。不要把它改成普通 RTMP/HLS 直播工具，那会牺牲它的优势。

但如果按第三方直播平台标准要求，下一阶段重点不应该继续堆 UI 功能，而应该做架构治理：

1. 拆控制面和媒体面边界。
2. 把协议和状态机版本化。
3. 建立 QoS 与观测闭环。
4. 给 P2P 链路增加显式托管 relay/SFU 兜底模式。
5. 把发布、配置、后台、安全补成平台级能力。

推荐短期执行顺序：先拆服务端 topology 模块和 renderer native 状态机，再做 topologyVersion/edgeAttemptId，最后再引入 QoS 和 managed relay。这样风险最低，也最符合当前代码已经形成的方向。
