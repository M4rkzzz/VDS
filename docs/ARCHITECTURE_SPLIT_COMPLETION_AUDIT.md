# Architecture Split Completion Audit

更新时间：2026-06-26

## 结论

本审计用于核对 Renderer 与 media-agent 架构拆分计划的当前真实完成度。结论基于当前工作区文件、脚本门禁和源码扫描，不把“文件已存在”直接等同于“阶段完成”。

当前整体判断：

| 范围 | 粗略完成度 | 状态 | 主要原因 |
| --- | ---: | --- | --- |
| Renderer split | 约 99.990% | Partial | UI/配置/诊断/surface/peer/session 已大量模块化，`room-client` 已继续承接 host create-room/leave-room 发送 facade，建立 dispatcher 骨架，十三个 native message handler 已全部迁入 dispatcher 注册路径，且 native override 直连 `registerMessageHandler` 已有门禁禁止回退，unknown-message fallback 也已由 `room-client` 持有；create-room wire payload 已只由 room-client 构造，`native-session-controller` 也已统一暴露 `buildHostCreateRoomOptions(options = {})` 而非 message payload helper；room/viewer/host room/session resume handler 已迁入 `native-room-message-controller.js`，room-created 内部退房已通过 `roomClient.leaveRoom()` 而非手拼 wire payload，`viewer-reconnect-ready` 和 `viewer-ready` 也已通过 roomClient facade 统一构造和发送；peer signaling handler 已迁入 `native-peer-message-controller.js`，answer/ICE/offer 主体逻辑和 relay offer retry 策略已从 legacy callback 收进 peer message controller；host-viewer offer 和 relay-viewer offer 的创建、复用、关闭旧 peer、encoded DataChannel 协议校验、relay source 绑定和发送 offer 已收进 `native-peer-controller.js`，override 只保留 legacy global 转发；peer create/close lifecycle、closeAll/recreate 默认动作、peer-state、remote ICE flush effects、offer 前 UI state、connect failfast、NAT mapping fallback 主体、最终 P2P failure apply、disconnected recovery timer 动作、host/viewer stats polling 以及 peer controller 信令发送 roomClient 化已继续收进 native controllers，peer create/close/NAT 内部 helper、generic sendMessage fallback、media-state direct wrapper、native peer create/close direct wrapper、viewer connection DOM direct wrapper、host/OBS reset DOM direct wrapper 和 session effects UI direct callbacks 已从 legacy override 收回；viewer/room/media/connection/host reset/session effects legacy UI state 已收进 `native-renderer-state-controller.js`，room/peer message controller 的 viewer/host 房间 UI DOM ownership 已改为 renderer-state facade，legacy app state patch 字段归一化和 app-state 同步快照组装也已收进 renderer-state bridge，host start/stop lifecycle、带音频共享高层流程与 native audio start result 校验已收进 `native-session-controller.js` 并加门禁。剩余缺口转为 `app-native-overrides.js` 仍承担依赖注入和少量兼容 glue。 |
| media-agent session/controller split | 约 99.56% | Partial | Runtime 边界和 Peer/Surface/Audio/Relay facade 已明显收口，RelayHub 公开头已不再暴露 legacy relay backend API 或 `relay_backend::Runtime` 实现类型名，relay backend 状态和操作 API 已改由 RelayHub 私有 pimpl/runtime 持有；`relay_dispatch.h` legacy backend 声明头已删除，后端 runtime 声明迁入 `relay_backend_runtime.h`，实现文件也已从 `relay_dispatch.cpp` 重命名为 `relay_backend_runtime.cpp`，且仅 relay backend 实现和 `relay_hub.cpp` 可 include backend runtime 头；Host/Audio/OBS registry 已从单 active 成员推进为 map-backed active session 存储，并具备 ensure/activate/count 基础 API；`runtime_registry` 公开 current-session facade 已删除，registry 内部 current/snapshot alias 也已删除，业务只通过 active/session snapshot 入口；`HostSessionController` 已绑定 active Host + OBS owner，host start/stop pipeline 不再自行解析 active OBS owner，start/stop result JSON 已直接使用注入的 `ObsIngestState&` owner，started/stopped 事件 `transportReady` 字段也已改为通过 `HostSessionControllerCallbacks` 注入 snapshot，不再由 pipeline 横向读取 peer transport runtime；`host_session_runtime.*` 已删除未使用的 `current_*` host/OBS runtime 兼容 facade，默认 native reset 也已删除隐式 active OBS overload，业务不能再绕回完整 runtime + 隐式当前会话；peer create finalize 与 host video/audio sender refresh 已收回 `PeerSessionController` 私有 helper，相关 pipeline 头不再暴露完整 runtime 写入口；surface stats snapshot 和顶层 status/stats/capabilities JSON builder 已改为 const runtime 只读路径，不再持有 mutable surface/runtime 权限；start/stop/OBS prepare 已接入 mediaSessionId 激活 Host/Audio/OBS owner，RPC router 的 session id 解析和三类 owner 激活组合已收进 `session_owner_activation` facade，active OBS/audio owner 实例绑定已收进 `agent_rpc_session_bindings` facade，OBS runtime access 已删除隐式完整 runtime 重载；`AgentRuntimeState` 已不再 include 完整 `peer_transport.h` / `wgc_capture.h` / `native_surface_layout.h`，peer transport backend state/JSON 与 WGC probe state 已拆成轻量 state/snapshot 边界；smoke 已证明 prepare 后三类 active id/count 切换；status/stats 已输出三类 session id/count；但完整人工 E2E 仍未完成。 |
| 自动门禁 | 约 99.0% | Partial | 已有 renderer entry/syntax/bridge、room-client dispatcher、media-agent boundary 和统一 `check:architecture`；media-agent boundary 已覆盖 runtime include、registry 字段、relay backend include/API 调用、RelayHub 公开头 backend 类型泄漏、agent lifecycle active-session 绑定集中度、业务文件 current-session facade 回退、runtime_registry current-session facade 暴露回退、active facade 回退到 current-session、Host/Audio/OBS registry 回退到单 active 成员、registry 多 session API 缺失、runtime activate facade 缺失、业务文件直接调用 Host/Audio/OBS 底层 activate facade、RPC router 直接绑定 active owner session 回退、current host/OBS runtime facade 回退、隐式 OBS runtime access 绑定回退、OBS runtime access 单参数 overload 回退、surface snapshot const path、agent status JSON const builder；media-agent smoke 已覆盖 mediaSessionId 激活。仍缺完整人工 E2E 证明。 |

当前自动拆分推进已到手测边界：代码侧边界、门禁和服务端测试已通过，继续证明运行态正确需要启动真实 native/web/OBS/打包版场景人工验收。按“到达需要用户手测前即标记完成目标”的当前目标，本阶段可以收口；但架构本身仍不能宣称运行态完全完成。

后续剩余重点：

1. 跑完 native/web/relay/OBS/打包版人工 E2E 后再宣布运行态完成。
2. 如人工测试暴露问题，再针对具体链路继续收缩 `app-native-overrides.js` 依赖注入和 media-agent owner/snapshot 兼容层。
3. 不再做盲目大搬家，避免在手测前引入新的时序变量。

## 自动证据

当前已存在并可用于日常防回归的门禁：

| 命令 | 覆盖范围 | 证明强度 |
| --- | --- | --- |
| `npm run check:renderer-entry` | `index.html` 21 个传统 script 的顺序和文件存在性 | 强，覆盖加载顺序。 |
| `npm run check:renderer-syntax` | `server/public/**/*.js` 源码语法，当前覆盖 21 个源码文件，排除构建产物 | 中强，覆盖语法不覆盖运行时。 |
| `npm run check:renderer-bridge` | native authority wrapper 参数透传、legacy globals 简写引用、disconnected recovery timer、P2P failure/NAT finalization、peer create/close lifecycle 回退、viewer/room 状态 patch 回退到 native override / public API 暴露检查、room/peer message controller 直接拥有房间 UI DOM 回退检查、stop/OBS reset 高层 wrapper 回退检查 | 强，覆盖已发生过的 R2/R5/R6/R7 回归类型。 |
| `npm run check:media-agent-boundary` | `agent_runtime.h` include 边界、关键 runtime 字段裸访问、禁止旧 `relay_dispatch.h` include、`relay_backend_runtime.h` include 白名单、relay backend API 调用边界、`relay_hub.h` backend 类型泄漏、agent lifecycle active-session 绑定集中度、业务文件 current-session facade 回退、active facade 回退到 current-session、Host/Audio/OBS registry 单 active 成员回退、registry 多 session API 缺失、业务文件直接调用 Host/Audio/OBS 底层 activate facade、RPC router 直接绑定 active owner session 回退、current host/OBS runtime facade 调用回退、隐式 OBS runtime access 绑定回退、OBS runtime access 单参数 overload 回退、runtime/status read path 回退 include 完整 peer transport API，以及 runtime 头回退 include 完整 WGC frame source API / native surface layout API | 强，覆盖 M4/M5/M7 边界回退。 |
| `npm run check:room-client-dispatcher` | `room-client` message dispatcher API、WebSocket onmessage 入口、native override 禁止直接注册 handler、room message controller 禁止手拼 `leave-room` wire payload、native session controller 禁止手拼 `create-room` wire payload、viewer ready/reconnect-ready 统一 builder/facade、peer controller 禁止 generic sendMessage 注入 | 强，覆盖 R2 消息分发入口、native message handler 回退、房间/关键 viewer 控制信令 payload owner 回退和 peer 信令 owner 回退。 |
| `npm run check:architecture` | renderer entry/syntax/bridge、room-client dispatcher、media-agent boundary 组合 | 强，适合每轮拆分后快速跑。 |
| `npm run check:logging` | 日志策略 | 中，覆盖刷屏/分类策略。 |
| `npm run test:server` | server topology/signaling core | 中强，覆盖服务端逻辑但不覆盖真实 WebRTC/media。 |
| `npm run check:vds-web` / `npm run test:vds-web` | web viewer 类型和协议测试 | 中，覆盖 web 端编译/协议，不等价浏览器实测。 |
| `npm run verify:media-agent` | Release build + media-agent unit/smoke；smoke 覆盖 Host/Audio/OBS active session id/count 字段，并验证 `mediaSessionId` 激活后 id/count 切换 | 强，覆盖 native agent 构建、基础 smoke 和 M7 owner 激活路径。 |

## Renderer Phase Audit

| Phase | 要求 | 当前证据 | 状态 | 剩余动作 |
| --- | --- | --- | --- | --- |
| R0 | 建立 renderer 依赖盘点文档，列出 app/native bridge 全局依赖和 hook。 | `docs/RENDERER_SPLIT_MAP.md` 已存在，包含入口顺序、全局依赖、native 写回 hook、模块边界。 | Complete | 后续每次移动边界继续更新。 |
| R1 | 抽低风险 UI/配置模块：quality/source/update/debug。 | `quality-settings.js`、`source-selection.js`、`update-ui.js`、`debug-panel.js` 已存在并在 `index.html` 前置加载；`app.js` 保留 wrapper。 | Complete | 可继续减少 `app.js` 中确认开播/复制 OBS URL 等 glue。 |
| R2 | 抽 `app-state.js` 与 `room-client.js`，让房间/信令从 UI 流程剥离。 | `app-state.js`、`room-client.js` 已存在；WebSocket、pending queue、viewer join/leave facade、host create-room 发送 facade、native stop-share leave-room 发送 facade、按 `type` 注册的 message dispatcher、十三个 native message handler、unknown-message fallback 均已由 `room-client` 调度；`viewer-count-updated`、`viewer-left`、`host-disconnected`、`error`、`room-joined`、`room-created`、`session-resumed` handler body 已迁入 `native-room-message-controller.js`；`viewer-joined`、`connect-to-next`、`chain-reconnect`、`answer`、`ice-candidate`、`offer` dispatcher body 已迁入 `native-peer-message-controller.js`；legacy `handleMessage` 不再拥有 `data.type` switch；viewer/room/media/connection legacy 状态 patch 和 room/peer message controller 房间 UI DOM ownership 已收进 `native-renderer-state-controller.js` 并由 bridge 门禁防回退。 | Mostly Complete | handler body、主要状态 patch 和房间 UI ownership 已迁完，后续重点是把剩余 session glue 继续收进 room/session/app controller，减少 native override 依赖注入面。 |
| R3 | 抽 `native-diagnostics` 与 `p2p-state-machine`，不改变 peer 创建逻辑。 | `native-diagnostics.js`、`native-stats-controller.js`、`p2p-state-machine.js` 已存在；诊断日志、host/viewer stats polling、FPS DOM、P2P label、wait timer、failfast reason 已迁移；`check:renderer-syntax` 覆盖。 | Mostly Complete | 继续把 legacy 中剩余 recovery 动作执行和 UI callback 参数收进状态机。 |
| R4 | 抽 `native-surface-controller`，surface layout/window sync 脱离 peer/session。 | `native-surface-controller.js` 已存在并接入；文档记录 attach/update/detach/layout/tracking/sync 已迁移。 | Mostly Complete | legacy 仍有少量元素查询/错误日志回调，后续可收薄。 |
| R5 | 抽 `native-peer-controller`，peer lifecycle、offer/answer/ice/DataChannel 独立。 | `native-peer-controller.js` 已存在；peer create/close lifecycle、closeAll/recreate 默认动作、peer handle/signal/candidate/attempt/NAT/failfast/recovery、peer-state event+effects 串联、mediaEngine signal 入口、peer close cleanup effects 消费、peer recovery request 动作、connect failfast 默认路径、NAT mapping wait 默认路径、P2P failure/NAT finalization 统一 facade 和 disconnected recovery timer 动作大量迁入；host-viewer offer 与 relay-viewer offer 的创建/复用/重建/发送、encoded DataChannel 协议校验、relay source 绑定已进入 peer controller；`native-peer-message-controller.js` 已承接 answer/ICE/offer 主体逻辑、relay offer retry 策略和 stale upstream cleanup；`check:renderer-bridge` 防止 wrapper 丢参和内部 helper 泄漏。 | Mostly Complete | `app-native-overrides.js` 仍有依赖注入和少量状态 setter glue。目标是 controller 只通过 `roomClient` 发信令。 |
| R6 | 抽 `native-session-controller`，host native/OBS start-stop lifecycle 成为唯一入口。 | `native-session-controller.js` 已存在；host/audio start-stop RPC、manifest、generation、stop cleanup、OBS room create/teardown 已迁入；create-room helper 已统一为 `buildHostCreateRoomOptions(options = {})`，只向 `roomClient.createRoom()` 提供 options；stop/OBS reset lifecycle 高层 wrapper 已从 `app-native-overrides.js` 删除，session controller 直接持有 clear room、reset playback、reset stop UI 和 OBS waiting UI helper；native capture start 与 OBS ingest start 的 begin/ensure/start/validate/preview retry/create-room 高层流程已迁入 `runNativeCaptureHostStart()` / `runObsIngestHostStart()`；带音频共享已迁入 `runNativeCaptureHostStartWithAudio()`，native audio start result 也已由 `validateAudioStartResult()` 归一化；stop share 的 begin/cleanup/finalize/finish 高层流程已迁入 `runStopShare()`；override 只保留 legacy global 委托；bridge 门禁禁止 start/stop/audio share 主流程回流。 | Mostly Complete | `app-native-overrides.js` 仍保留低层 legacy 状态镜像 setter/getter 和 controller 依赖注入面。 |
| R7 | 删除 legacy 重复逻辑，让 `app-native-overrides.js` 变成薄入口。 | `native-entry.js` 已接入 install guard 和 legacy globals 注册；`app-native-overrides.js` 已改为 installer 函数；room/peer message controller、stats、surface、session reset 等重复逻辑已大量迁出并有门禁。 | Partial | 继续压缩剩余依赖注入面和 legacy globals；最终删除旧脚本或让它只调用 `VDS.native.install()`。 |

Renderer 下一步优先级：

1. 先拆 `app.js` 的 message dispatch/create-room/room lifecycle 到 `room-client`，因为它是 R2 当前最大缺口。
2. 再拆 `app-native-overrides.js` 中剩余 surface/session 状态 setter 和依赖注入 glue，把 controller 从“动作编排 owner”推进到更少 legacy 参数面。
3. 最后再做 R7 薄入口，不要提前删除 legacy hook。

## Media-Agent Phase Audit

| Phase | 要求 | 当前证据 | 状态 | 剩余动作 |
| --- | --- | --- | --- | --- |
| M0 | runtime ownership 盘点文档。 | `docs/MEDIA_AGENT_SESSION_OWNERSHIP_PLAN.md` 已存在并持续记录 Host/Peer/Relay/Surface/Audio owner。 | Complete | 后续迁移继续更新。 |
| M1 | 引入 `AgentContext` / `RuntimeRegistry`，减少直接拿 `AgentRuntimeState&` 任意读写。 | `agent_context.h`、`runtime_registry.*` 已存在；`check:media-agent-boundary` 限制完整 runtime include 和关键字段裸访问。 | Mostly Complete | `AgentContext` 仍偏轻，部分 controller 仍以 `AgentRuntimeState&` 作为 registry facade 入参。 |
| M2 | `PeerSessionController` 成为 peer map 唯一 owner。 | `peer_session_controller.*` 已存在；create/close/signaling/media-source 入口已迁入；旧 `peer_control_runtime.*` / `peer_media_binding_runtime.*` 已删除。 | Mostly Complete | 继续把 registry facade 从兼容 map 访问推进到真正 `PeerSessionRegistry` owner/snapshot。 |
| M3 | `SurfaceSessionController` 成为 surface map 唯一 owner。 | `surface_session_controller.*` 已存在；旧 `surface_control_runtime.*` 已删除；surface stats 聚合拆出，且 `surface_session_stats_json()` 已降为 const runtime/const surface 只读 snapshot。 | Mostly Complete | controller 内 attach/update 逻辑仍可继续拆私有 command/snapshot helper。 |
| M4 | `HostSessionController` 收紧为 host 唯一 owner。 | `host_session_controller.*`、start/stop pipeline、host runtime/state 文件已存在；RPC 已接入 controller；controller 构造时同时绑定 active HostSession 与 active ObsIngest owner，host start/stop/drain pipeline 显式接收 `ObsIngestState&`，不再自行调用 `active_obs_ingest_session(state)`；start/stop result JSON 已直接使用注入的 `ObsIngestState&` owner，不再回读 `obs_ingest_session_snapshot(state)`；host started/stopped 事件 `transportReady` 已改为通过 `HostSessionControllerCallbacks::transport_ready` 注入 snapshot，pipeline 不再调用 `peer_transport_ready(state)`；`host_session_runtime.*` 已保留显式 `HostSessionState&` / `ObsIngestState&` owner API，并删除未使用的 `current_*` host/OBS runtime 兼容 facade；start/stop/lifecycle/peer soft refresh/OBS prepare-start-stop 主调用点不再回绕隐式当前会话；`ObsIngestSessionRuntimeAccess` 的 host snapshot/codec 写回已显式绑定 host session。 | Mostly Complete | host manifest/source/audio/OBS 仍有跨 owner snapshot，需继续收进 host owner。 |
| M5 | `RelayHub` / `EncodedFrameBus` 替代 relay 直接穿透 peer runtime。 | `relay_hub.*`、`encoded_frame_bus.*` 已存在；viewer/OBS publish 已走 `relay_hub()`；`RelaySubscriberState` 已拆到独立 snapshot 头，`relay_hub.h` 不再 include legacy backend 头，也不再暴露 `relay_backend::Runtime` 类型名；legacy backend runtime 声明已从 `relay_dispatch.h` 迁入 `relay_backend_runtime.h`，旧 `relay_dispatch.h` 已删除，旧 `relay_dispatch.cpp` 已重命名为 `relay_backend_runtime.cpp`；subscriber/bootstrap/queue/worker state 已收进 `relay_backend::Runtime` 并由 `RelayHub::Backend` 私有 pimpl 持有；legacy free backend 函数已成员化为 `Runtime` 方法；`check:media-agent-boundary` 已禁止旧 dispatch 头回流，并限制 backend runtime include/API 调用只允许 backend 与 Hub。 | Mostly Complete | 后续可继续把 backend 算法拆小，或把 `Runtime` 私有实现进一步并入 Hub backend 目录/模块。 |
| M6 | 拆 `ViewerAudioSession` / `HostAudioDispatchSession`。 | `viewer_audio_session.*`、`host_audio_dispatch_session.*` 已存在；viewer playback runtime 和 host dispatch state 已下沉。 | Mostly Complete | audio registry 仍是 `current` 兼容单 session；`media_audio.*` 仍保留 decode/helper。 |
| M7 | `AgentRuntimeState` 瘦身为 registry + shared services + snapshot cache。 | `agent_runtime.h` include 已被门禁限制；关键字段裸访问扫描无命中；status/stats 聚合已通过 formatter/snapshot aggregator，surface stats 和 agent 顶层 JSON builder 现在都是 const runtime 只读路径；Host/Audio/OBS registry 已有 map-backed `active_session()`、`ensure_session()`、`activate_session()` 和 `session_count()`，status/stats 已输出 count，`runtime_registry` 公开 current-session facade 已删除，registry 内部 `current_session()` / `snapshot()` alias 也已删除；startHostSession/startAudioSession/stopHostSession/stopAudioSession/prepareObsIngest 已通过 `mediaSessionId/sessionId` 激活 active owner，RPC router 的激活策略已收进 `session_owner_activation`，active owner 绑定已收进 `agent_rpc_session_bindings`，OBS runtime access 只能显式绑定 host owner；`PeerTransportBackendInfo` 已拆到 `peer_transport_state.h`，backend JSON 已拆到 `peer_transport_state_json.*`，`WgcCaptureProbe` 已拆到 `wgc_capture_state.h`，`agent_runtime.h` 不再 include 完整 `peer_transport.h` / `wgc_capture.h` / `native_surface_layout.h`，`agent_status_json.cpp` 不再 include 完整 `peer_transport.h`，门禁禁止 current-session 调用、业务层底层 activate facade、router 直接 active binding、OBS 隐式 access 和 runtime/status 回退 include 完整 transport/WGC/surface layout API。 | Mostly Complete | 完整人工 E2E 仍未完成。 |

Media-agent 下一步优先级：

1. 继续 M4：Host/OBS session owner 收口，减少 host start/stop pipeline 对多个 facade 的横向协调。
2. 继续 M5：把 relay backend runtime 算法继续拆小或并入 Hub backend 私有实现，保留行为兼容但不让业务文件接触 backend API。
3. 继续 M7：补人工 E2E 记录，并检查 stop 后 active session 选择是否需要按生命周期归档或保留。

## Explicit Requirement Audit

| 需求 | 证据 | 状态 |
| --- | --- | --- |
| 第一阶段不切换前端构建系统，不引入 bundler。 | `index.html` 仍为普通 `<script>`；未使用 `type="module"`。 | Met |
| 保持 `app.js -> app-native-overrides.js` 加载兼容。 | `index.html` 仍先加载 `app.js`，最后加载 `app-native-overrides.js`，中间插入模块。 | Met |
| 新文件使用 IIFE + `window.VDS` 命名空间。 | 新 renderer/native 模块均位于 `server/public/*.js` / `server/public/native/*.js`，入口文档记录该约束；语法门禁覆盖。 | Mostly Met，需继续人工抽查新增文件。 |
| 不直接散落新的全局函数。 | `native-entry.js` 统一注册 legacy globals；`check:renderer-bridge` 检查部分 legacy bridge。 | Partial，仍需继续减少 legacy globals。 |
| 不改变信令协议和 JSON-RPC wire shape。 | 文档记录保持兼容；server/media-agent tests 可辅助证明。 | Needs Verification，需跑 `test:server`、`verify:media-agent` 并做人工 E2E。 |
| 每个处理项写入 `CODE_AUDIT_FINDINGS`。 | 已有 ARCH-SPLIT-P1-448 至 463。 | Met for recorded items；本审计自身需补一条记录。 |
| 每个阶段小步可验证。 | 已有多个 npm check 和 release-check 接入。 | Mostly Met，仍缺人工 E2E 自动化入口。 |
| 到达需要用户手测前即标记当前目标完成。 | 自动门禁与 server core 测试已通过；剩余验收项均为真实 native/web/OBS/打包版人工 E2E。 | Met for current goal boundary |
| 完整人工验收场景。 | 尚未在本审计周期完成。 | Missing |

## 未完成 E2E 验收

这些场景必须在宣称最终完成前执行并记录结果：

| 场景 | 当前状态 |
| --- | --- |
| 单端 native：源选择、开始共享、停止共享、再次共享 | 未验证 |
| 双端 native：host/viewer 连接、画面/声音、拖动窗口、停止共享 | 未验证 |
| 双端 web：能力检测、加入、WebCodecs 播放、错误提示 | 未验证 |
| 三端 native：host -> v1 -> v2 relay，v1 退出后 v2 重选上游 | 未验证 |
| Native-Web-Native：web 中间节点 relay，链路重连 | 未验证 |
| OBS ingest：等待 OBS、推流、断流、重新推流 | 未验证 |
| 打包版：安装包内 media-agent hash 与 runtime 一致，预览/源选择可用 | 未验证 |

## 下一轮执行建议

下一轮建议先手测，不建议继续随机清理旧代码。建议按以下顺序推进：

1. 单端 native：源选择、开始共享、带音频共享、停止共享、再次共享。
2. 双端 native / 双端 web / 三端 relay：确认连接、画面、声音、断链重选上游。
3. OBS ingest 与打包版：确认等待、推流、断流、重新推流、预览/源选择。
4. 若手测暴露具体问题，再按问题对应 controller 继续收口，并执行 `npm run check:architecture`、`npm run check:logging`、涉及范围对应测试。
