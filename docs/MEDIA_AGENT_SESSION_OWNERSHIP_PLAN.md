# Media Agent Session Ownership Plan

更新时间：2026-06-24

完成度审计入口：`docs/ARCHITECTURE_SPLIT_COMPLETION_AUDIT.md`。该文档按 M0-M7 逐项记录当前证据、完成状态、剩余动作和未完成 E2E 场景；当前 media-agent split 仍为 Partial，不能把 runtime boundary 门禁通过等同于最终 session/controller 架构完成。

## 当前结论

`media-agent/src/agent_runtime.h` 当前已经瘦身为 registry + shared capability snapshot 的组合入口：host、peer、surface、audio、OBS ingest、FFmpeg/WGC/peer transport 等主字段不再由业务代码裸读写，当前源码扫描显示这些字段的直接访问集中在 `runtime_registry.cpp`。`agent_rpc_router.cpp` 已持有 Host/Peer/Surface/Audio/OBS session/controller facade，核心 RPC 已通过 controller 或 session command 进入。

当前补充：新增 `scripts/check-media-agent-boundary.js` 与 `npm run check:media-agent-boundary`，自动校验 `agent_runtime.h` 只允许 `main.cpp` / `runtime_registry.cpp` include，并校验业务代码不得直接访问 `AgentRuntimeState` 的 peer/host/audio/OBS/surface/capability registry 字段；`release-check.js` 已把该检查纳入发布前/后检查链。

当前补充：`check-media-agent-boundary.js` 已扩展 relay backend include 门禁，旧 `relay_dispatch.h` 已删除并禁止回流；`relay_backend_runtime.h` 只允许 `relay_backend_runtime.cpp` 与 `relay_hub.cpp` include；新增业务代码必须通过 `relay_hub.h` 访问 relay lifecycle/publish/query facade。

当前补充：`check-media-agent-boundary.js` 已继续扩展 relay backend API 调用门禁，除 `relay_backend_runtime.h` / `relay_backend_runtime.cpp` / `relay_hub.cpp` 外，源码不得直接调用或声明 relay backend 注册、查询、fanout 等内部 API。

当前补充：`check-media-agent-boundary.js` 已新增单 session registry facade 门禁，除 `runtime_registry.cpp` 外，源码不得直接调用 `host_sessions.current_session()` / `audio_sessions.snapshot()` / `obs_ingest_sessions.current_session()` 等兼容 registry 访问；业务代码必须通过 `runtime_registry` 的 `active_*_session()` 或 `*_session_snapshot()` facade。

当前补充：legacy relay backend 函数已收拢到 `vds::media_agent::relay_backend` namespace，`relay_hub.cpp` 通过 namespace alias 委托 backend；这让 backend API 在代码层面区别于 `RelayHub` facade，后续把实现迁入 Hub 私有 backend 时调用点更集中。

当前补充：旧 `relay_dispatch.cpp` 已重命名为 `relay_backend_runtime.cpp`；内部 `RelayDispatchState` / `relay_dispatch_state()` 已先重命名为 `RelayBackendState` / `relay_backend_state()`，随后继续收口为 `relay_backend::Runtime` pimpl；该 runtime 由 `RelayHub` 私有持有，subscriber/bootstrap/queue/worker state 不再依赖文件级 static 单例。
当前补充：新增 `npm run check:architecture` 作为 renderer/media-agent 拆分健康度快速总入口，已包含 `check:media-agent-boundary`，发布检查通过该组合入口覆盖 media-agent runtime 边界。

当前阶段仍保持 JSON-RPC wire shape 和 `getStats`/`getStatus` 输出兼容，不改变 media 行为。剩余工作主要是把兼容单 session registry 进一步演进为真正多 session/snapshot owner，并继续清理文档中标记的 legacy glue，而不是继续迁移裸 `AgentRuntimeState` 字段访问。

当前补充：Host/Audio/OBS 三类兼容单 session registry 已新增 `active_session_id()` facade，并通过 `runtime_registry` 暴露 `active_host_session_id()` / `active_audio_session_id()` / `active_obs_ingest_session_id()`；`getStatus` 与 `getStats` 额外输出 `hostSessionId` / `audioSessionId` / `obsIngestSessionId`，在不破坏既有字段的前提下让当前 owner identity 可观测，后续多 session 化时可以替换默认 active id。

当前补充：`scripts/smoke-media-agent.ps1` 已新增 active session id 断言，要求 `getStatus` 与 `getStats` 响应都包含非空 `hostSessionId`、`audioSessionId`、`obsIngestSessionId`，避免后续 status/stats owner identity 输出回退。

当前补充：`check-media-agent-boundary.js` 已新增 current host/OBS runtime facade 回退门禁，除 `host_session_runtime.h/cpp` 的兼容声明/实现外，源码不得直接调用 `revalidate_current_host_capture_plan()`、`start_current_host_capture_process()`、`prepare_current_obs_ingest_session()`、`stop_current_obs_ingest_session()` 等旧 current-session helper；新调用点必须传入显式 `HostSessionState&` / `ObsIngestState&`。

当前补充：`check-media-agent-boundary.js` 已新增隐式 OBS runtime access 绑定回退门禁，除 `obs_ingest_session.h/cpp` 的兼容声明/实现外，源码不得调用单参数 `make_obs_ingest_runtime_access(runtime_state)`；新调用点必须显式传入 `HostSessionState&`。

当前补充：surface stats snapshot 已降为只读权限。`SurfaceSessionRegistry` / `runtime_registry` 新增 const `for_each_surface()` facade，`surface_session_stats_json()` 改为接收 `const AgentRuntimeState&`，`surface_attachment_json()` 新增 const formatter；mutable formatter 仅用于 attach/update result 刷新状态后委托只读 formatter。`check-media-agent-boundary.js` 已固化这些 const snapshot 边界。

当前补充：agent status/stats/capabilities JSON builder 已降为只读入口。`capabilities_json()`、`build_status_json()`、`build_agent_ready_json()`、`build_stats_json()` 均接收 `const AgentRuntimeState&`；`getStatus/getStats/getCapabilities` 仍先 refresh mutable runtime，再用 const builder 输出 JSON。`check-media-agent-boundary.js` 已固化这些只读签名。

## 当前 RPC 到 runtime helper 映射

| RPC method | 当前入口 | 当前 owner 问题 | 目标 owner |
| --- | --- | --- | --- |
| `startHostSession` | `start_host_session_from_request` | host session 与 peer sender/source 状态交叉 | `HostSessionController` |
| `stopHostSession` | `stop_host_session` | host stop 需要清理多个 runtime 区域 | `HostSessionController` |
| `createPeer` | `create_peer_from_request` | 直接创建/写 `runtime_state.peers` | `PeerSessionController` |
| `closePeer` | `close_peer_from_request` | peer transport/receiver/sender 清理分散 | `PeerSessionController` |
| `setRemoteDescription` | `PeerSessionController::set_remote_description_from_request` | 信令状态由 peer controller 写入 peer/transport snapshot | `PeerSessionController` |
| `addRemoteIceCandidate` | `PeerSessionController::add_remote_ice_candidate_from_request` | ICE 写入和 peer existence 检查由 peer controller 处理 | `PeerSessionController` |
| `attachPeerMediaSource` | `PeerSessionController` -> `peer_media_source_pipeline` | request body 已迁入 pipeline，底层 host/relay attach helper 仍在 media binding runtime | `PeerSessionController` + `HostSessionController` source interface |
| `detachPeerMediaSource` | `PeerSessionController` -> `peer_media_source_pipeline` | request body 已迁入 pipeline，底层 sender cleanup helper 仍在 media binding runtime | `PeerSessionController` |
| `attachSurface` | `attach_surface_from_request` | 直接写 `attached_surfaces` 和 peer receiver binding | `SurfaceSessionController` |
| `updateSurface` | `update_surface_from_request` | layout/surface recovery 写入口分散 | `SurfaceSessionController` |
| `detachSurface` | `detach_surface_from_request` | detach 与 peer receiver 状态耦合 | `SurfaceSessionController` |
| `setViewerVolume` | `set_viewer_volume_from_request` | viewer audio playback runtime 直接暴露 | `ViewerAudioSession` |
| `setViewerAudioDelay` | `set_viewer_audio_delay_from_request` | delay queue 与 playback runtime 混合 | `ViewerAudioSession` |
| `getStats` | `get_stats_result` / `host_state_json.*` / `audio_state_json.*` / `peer_snapshot_aggregator.*` / `surface_snapshot_aggregator.*` | host/audio/peer/surface stats 已由 formatter 或 snapshot aggregator 聚合 | session snapshots aggregator |

## 当前 owner 盘点

### Host

当前相关文件：

- `host_session_controller.*`
- `host_capture_plan.*`
- `host_pipeline.*`
- `host_capture_process.*`
- `host_state_json.*`
- `peer_video_sender.*`
- `obs_ingest_session.*`
- `obs_ingest_constants.h`
- `obs_ingest_media.*`
- `obs_ingest_state.*`

当前共享状态：

- `AgentRuntimeState::host_session_running`
- `host_backend`
- `host_capture_target_id`
- `host_requested_codec` / `host_codec`
- `host_capture_kind` / `host_capture_state` / `host_capture_title` / `host_capture_hwnd` / `host_capture_display_id`
- `host_width` / `host_height` / `host_frame_rate` / `host_bitrate_kbps`
- `host_pipeline`
- `host_capture_plan`
- `host_capture_process`
- `host_capture_artifact`
- `ObsIngestSessionRegistry obs_ingest_sessions` 当前以 `current` 兼容字段承载 OBS ingest prepared/worker/stream snapshot

目标规则：

- `HostSessionController` 是 host capture/encode/audio/OBS manifest 的唯一写 owner。
- peer sender 只能通过明确 frame/source interface 读取 host 输出，不能直接改 host runtime。
- host stop 统一进入 draining -> stopped，不允许各 RPC 分散清理 host 资源。

### Peer

当前相关文件：

- `peer_control_runtime.*`
- `peer_media_binding_runtime.*`
- `peer_transport.*`
- `peer_receiver_runtime.*`
- `peer_state_json.*`
- `peer_video_sender.*`

当前共享状态：

- `AgentRuntimeState::peers`
- `PeerState::transport`
- `PeerState::transport_session`
- `PeerState::media_binding`
- `PeerState::receiver_runtime`
- `PeerState::PeerVideoSenderRuntime`
- `PeerState::PeerVideoReceiverRuntime`

目标规则：

- `PeerSessionController` 是 peer map 唯一 owner。
- 新代码不得直接 `runtime_state.peers[...]` 创建 peer；创建、查找、删除先走 registry helper，后续收敛到 controller。
- peer receiver/sender/transport 生命周期跟随 `PeerSession` phase。

### Relay

当前相关文件：

- `relay_dispatch.*`
- `viewer_video_pipeline.*`
- `media_audio.*`
- `peer_media_binding_runtime.*`

当前共享状态：

- relay subscriber registry 已从 `agent_runtime.h` 下沉到 `relay_backend::Runtime` 私有状态
- relay video bootstrap cache 已从 `agent_runtime.h` 下沉到 `relay_backend::Runtime` 私有状态
- relay pending video dispatch queue/worker 已从 `agent_runtime.h` 下沉到 `relay_backend::Runtime` 私有状态
- `RelaySubscriberState` 作为公开查询 snapshot 类型迁入 `relay_subscriber_state.h`
- `RelayUpstreamVideoBootstrapState` 已从 `agent_runtime.h` 下沉为 `relay_backend_runtime.cpp` 私有状态

目标规则：

- `RelayHub` 维护 subscriber 和 bootstrap。
- `EncodedFrameBus` 是 audio/video encoded frame 分发边界。
- viewer decode pipeline 和 audio pipeline 只 publish，不直接穿透 peer runtime fanout。
- `agent_runtime.h` 不暴露 relay dispatch worker、pending queue、bootstrap cache 等内部结构；需要查询 subscriber snapshot 的业务文件只能通过 `RelayHub` / `relay_subscriber_state.h` 的公开类型。

### Surface

当前相关文件：

- `surface_control_runtime.*`
- `surface_attachment_runtime.*`
- `surface_target.*`
- `native_surface_layout.*`
- `native_live_preview.*`
- `native_video_surface.*`
- `native_artifact_preview.*`

当前共享状态：

- `AgentRuntimeState::attached_surfaces`
- `SurfaceAttachmentState::preview_runtime`
- `SurfaceAttachmentState::live_preview_runtime`
- `SurfaceAttachmentState::peer_runtime`
- `SurfaceAttachmentState::surface_layout`

目标规则：

- `SurfaceSessionController` 是 surface map 唯一 owner。
- peer receiver runtime 不能外部直接改 `attached_surfaces`。
- surface attach/update/detach 输出统一 snapshot，便于前端诊断。

### Audio

当前相关文件：

- `media_audio.*`
- `viewer_audio_playback.*`
- `wasapi_backend.*`

当前共享状态：

- `AudioSessionRegistry audio_sessions` 当前以 `current` 兼容字段承载 WASAPI capture session snapshot
- viewer playback queue/worker/volume/delay 已从 `AgentRuntimeState` 下沉为 `viewer_audio_playback.cpp` 私有状态，由 `ViewerAudioSession` 访问 facade 管理
- host audio dispatch queue/encoder/worker 已从 `AgentRuntimeState` 头文件下沉为 `HostAudioDispatchSession` 私有状态

目标规则：

- `ViewerAudioSession` 拥有 viewer playback queue、delay、volume。
- `HostAudioDispatchSession` 拥有 host capture packet queue、encoder、dispatch sessions。
- `media_audio.*` 最终只保留 codec conversion/encode/decode helper。

## 已落地的基础类型

本阶段新增：

- `session_lifecycle.h`
  - `SessionPhase`
  - `SessionSnapshot`
  - `session_phase_to_string()`
  - `PeerState` / `SurfaceAttachmentState` 已接入 `SessionPhase` 和 `phase_reason`，create/attach/update/detach/close 路径开始维护生命周期快照
  - `peer-state`、peer result、`getStats().peers[]`、surface attachment JSON 已输出 `sessionPhase` / `phaseReason` 以便后续 controller 拆分期间观察 owner 生命周期
- `agent_context.h`
  - `AgentContext`
  - 统一持有 `AgentRuntimeState&`
  - 后续 controller command 可从这里获得 runtime 和 event helper
- `runtime_registry.h/cpp`
  - `find_peer()` / `ensure_peer()` / `erase_peer()` / `has_peer()`
  - `find_surface()` / `ensure_surface()` / `erase_surface()` / `has_surface()`
  - `current_host_session()` / `current_audio_session()` / `current_obs_ingest_session()`
- `host_session_controller.h/cpp`
  - 在已有 start/stop helper 外新增 `HostSessionController` 类包装
  - `agent_rpc_router.cpp` 已把 `startHostSession/stopHostSession` 入口切到 controller
- `peer_session_controller.h/cpp`
  - 包装 `createPeer/closePeer/setRemoteDescription/addRemoteIceCandidate/attachPeerMediaSource/detachPeerMediaSource` 旧 helper
  - `agent_rpc_router.cpp` 已把 peer 相关 RPC 入口切到 controller
- `surface_session_controller.h/cpp`
  - 包装 `attachSurface/updateSurface/detachSurface` 旧 helper
  - `agent_rpc_router.cpp` 已把 surface 相关 RPC 入口切到 controller

这些 helper/controller 暂不改变 JSON-RPC wire shape，也不改旧 runtime helper 内部行为；它们先把 RPC ownership 入口收束到可继续演进的位置。

## 迁移顺序

1. 保留旧 helper，但让新代码通过 `runtime_registry` 查找/创建 peer 和 surface。
2. `PeerState` / `SurfaceAttachmentState` 已先补生命周期字段，后续 controller 迁移不再只依赖 `reason` 字符串推断运行阶段。
3. `PeerSessionController` 已新增并接入 RPC，`peer_control_runtime.*` 已删除，peer request command 入口已收敛到 controller。
   - 当前补充：`build_status_json()` 的 `peerCount` 和 `build_stats_json()` 的 `peers[]` 已改为通过 `peer_snapshot_aggregator.*` 聚合，status 聚合器不再直接遍历 `state.peers`，也不再为只读聚合构造 `PeerSessionController`。
   - 当前补充：agent shutdown 的 receiver handles close 和 transport sessions close 已经由 `PeerSessionController` 入口委托到 `peer_lifecycle_pipeline.*`，shutdown 顺序保持不变。
   - 当前补充：host session start/stop 中的 host-downstream peer media binding 批量 attach/detach 已迁入 `PeerSessionController`，host controller 只保留调用点。
   - 当前补充：agent refresh 和 audio start/stop 触发的批量 peer transport/host sender/audio sender refresh 已经由 `PeerSessionController` 入口委托到 `peer_refresh_pipeline.*`。
   - 当前补充：旧 create/close/setRemoteDescription/addIce 全局 free-function 名称已无源码调用方；createPeer/closePeer/addRemoteIceCandidate/setRemoteDescription 均已迁入 `PeerSessionController`。
   - 当前补充：`closePeer` request 的 registry find/erase、surface detach、transport/receiver/audio/relay cleanup 已迁入 `PeerSessionController::close_from_request()`；`peer_control_runtime.*` 不再持有 closePeer backend。
   - 当前补充：`addRemoteIceCandidate` request 的 peer lookup、transport candidate apply、snapshot refresh 和 fallback peer-state event 已迁入 `PeerSessionController::add_remote_ice_candidate_from_request()`；`peer_control_runtime.*` 不再持有 addIce backend。
   - 当前补充：`setRemoteDescription` request 的 peer lookup、manifest apply、transport remote description apply、snapshot refresh 和 fallback peer-state event 已迁入 `PeerSessionController::set_remote_description_from_request()`；manifest apply/codec normalization 已拆到 `peer_media_manifest.*` 供 create/setRemoteDescription 共用。
   - 当前补充：`createPeer` request 的 peer state 初始化、transport callback 构造、host-downstream media binding attach、initial negotiation、registry ensure 和 peer-state/warning result 已迁入 `PeerSessionController::create_from_request()`；`peer_control_runtime.h/cpp` 已删除并从 CMake 移除。
   - 当前补充：createPeer 中的 transport callback 构造、signal/peer-state/warning event 输出、remote audio/video frame 消费和 encoded datachannel manifest gate 已拆入 `peer_transport_callback_factory.*`，controller 只传入 peer callback context。
   - 当前补充：createPeer 中的 host-downstream media attach、initial local description negotiation、registry ensure、peer-state/warning result 输出已拆入 `peer_create_pipeline.*`，controller 只保留 request parse、transport session create 和 pipeline 调用。
   - 当前补充：closePeer 的 surface detach、media binding close prepare、receiver/transport cleanup、viewer-upstream relay/audio cleanup、closed event 和 erase/result 输出已收回 `PeerSessionController::close_from_request()` 本体；`peer_close_pipeline.*` 已删除，closePeer request 不再通过外部 free-function pipeline 暴露 runtime。
   - 当前补充：setRemoteDescription/addRemoteIceCandidate 的 peer lookup、manifest apply、transport signaling write、snapshot refresh、fallback peer-state event 和 OK/error result 已收回 `PeerSessionController` 本体；`peer_signaling_pipeline.*` 已删除，signaling request 不再通过外部 free-function pipeline 暴露 runtime。
   - 当前补充：host start/stop 触发的 host-downstream media binding 批量 attach/detach 已拆入 `peer_host_binding_pipeline.*`，controller 只保留 host binding command 调用。
   - 当前补充：peer count 与 `getStats.peers[]` JSON 聚合已拆入 `peer_snapshot_aggregator.*`，`PeerSessionController` 的只读 count/stats API 已删除。
   - 当前补充：shutdown close-all receiver handles / transport sessions 已拆入 `peer_lifecycle_pipeline.*`，controller 只保留兼容入口。
   - 当前补充：transport refresh、host video sender refresh、host audio sender refresh 已拆入 `peer_refresh_pipeline.*`，controller 只保留兼容入口。
   - 当前补充：createPeer transport callback holder、transport session 创建和 transport success/failure 状态写回已拆入 `peer_transport_session_factory.*`，controller 只保留调用点。
   - 当前补充：createPeer request parse、BAD_REQUEST result、初始 PeerState configure、receiver runtime 创建和 media manifest apply 已拆入 `peer_create_request_config.*`，controller 只保留 create pipeline 编排。
   - 当前补充：attach/detach media source command 已经由 `PeerSessionController` 入口委托到 `peer_media_source_pipeline.*`，controller 不再直接依赖 `peer_media_binding_runtime.h`。
   - 当前补充：detachPeerMediaSource request body 已迁入 `peer_media_source_pipeline.cpp`；底层 detach helper 已迁入 `peer_media_detach_binding.*`。
   - 当前补充：attachPeerMediaSource request body 已迁入 `peer_media_source_pipeline.cpp`；relay source attach helper 已迁入 `peer_relay_source_binding.*`；host/OBS/audio source binding 已迁入 `peer_host_source_binding.*`。
   - 当前补充：peer transport refresh、host video sender soft refresh、host audio sender refresh 的真实实现已迁入 `peer_refresh_pipeline.cpp`；`peer_media_binding_runtime.*` 已删除，`media-agent/CMakeLists.txt` 不再编译旧 runtime。
4. `SurfaceSessionController` 已新增并接入 RPC；surface attach/update/detach request command 已迁入 controller 本体，旧 `surface_control_runtime.*` 与中间 `surface_command_pipeline.*` 均已删除。
   - 当前补充：`build_status_json()` 的 `surfaceCount` 和 `build_stats_json()` 的 `surfaces[]` 已改为通过 `surface_snapshot_aggregator.*` 聚合，status 聚合器不再直接遍历 `state.attached_surfaces`，也不再为只读聚合构造 `SurfaceSessionController`。
   - 当前补充：host capture surface refresh、stop all surfaces、restart host capture surfaces 已迁入 `SurfaceSessionController`，`agent_lifecycle.cpp` 只保留兼容 wrapper。
   - 当前补充：`SurfaceSessionController` 的 host capture surface refresh/stop/restart 和 peer surface detach 批量路径已显式维护 `SessionPhase` / `phase_reason`，覆盖 draining、starting、running、stopped、failed 等 lifecycle snapshot。
   - 当前补充：closePeer 时按 peer id 停止并删除 surface attachment 已迁入 `SurfaceSessionController::detach_peer_surfaces()`。
   - 当前补充：`SurfaceControlCommandResult` 已从旧 runtime 头拆到 `surface_control_result.h`；attach/update/detach request command 均已迁入 `SurfaceSessionController` 本体；`surface_session_controller.cpp` 不再 include `surface_control_runtime.h` 或 `surface_command_pipeline.h`。
5. 收紧 `HostSessionController`，让 host manifest/source/audio 统一由 host owner 写入。
6. `HostSessionController` 已有 class 包装和 RPC 接入，下一步把 host manifest/source/audio 写入口继续收进该 controller。
7. 引入 `RelayHub` / `EncodedFrameBus`，替代 relay 直接穿透 peer runtime。
8. 拆 `ViewerAudioSession` / `HostAudioDispatchSession`。
9. 最后瘦身 `AgentRuntimeState` 为 registry + shared services + snapshot cache。

## M7 当前进展：RuntimeState stats 聚合瘦身

本阶段新增/调整：

- `peer_snapshot_aggregator.*` 持有 `peer_session_count()` / `peer_session_stats_json()`
- `PeerSessionController::close_all_receiver_handles()`
- `PeerSessionController::close_all_transport_sessions()`
- `peer_host_binding_pipeline.*` 持有 host-downstream 批量 attach/detach 窄入口
- `PeerSessionController::refresh_transport_runtime()`
- `PeerSessionController::perform_host_video_sender_soft_refresh()`
- `PeerSessionController::refresh_host_audio_senders()`
- `peer_state_json.cpp` 持有 `build_peer_state_json()` / `build_peer_result_json()`
- `peer_state_json.cpp` 持有 `build_peer_ok_json()`
- `peer_state_json.cpp` 持有 `build_peer_closed_result_json()`
- `peer_state_json.cpp` 持有 `build_peer_stats_json()`
- `surface_snapshot_aggregator.*` 持有 `surface_session_count()` / `surface_session_stats_json()`
- `SurfaceSessionController::refresh_host_capture_surfaces()`
- `SurfaceSessionController::stop_all()`
- `SurfaceSessionController::restart_host_capture_surfaces()`
- `SurfaceSessionController::detach_peer_surfaces()`
- `surface_control_result.h` 持有 `SurfaceControlCommandResult`
- `runtime_registry.cpp` 持有 `peer_count()` / `surface_count()` / `for_each_peer()` / `for_each_mutable_peer()` / `for_each_surface()` facade
- `surface_state_json.cpp` 持有 `surface_attachment_json()` / `build_surface_result_json()`
- `surface_state_json.cpp` 持有 `build_surface_detached_result_json()`
- `HostSessionController::append_status_json_fields()`
- `HostSessionController::append_stats_json_fields()`
- `HostSessionController::session_json()`
- `HostAudioDispatchSession::stats_json()`
- `audio_state_json.cpp` 持有 `audio_session_json()`
- `agent_status_json.cpp` 的 `build_status_json()` 不再直接读取 `state.peers.size()`，改为通过 `peer_snapshot_aggregator.*::peer_session_count()`。
- `agent_status_json.cpp` 的 `build_stats_json()` 不再直接遍历 `state.peers` 拼 peer stats JSON，改为通过 `peer_snapshot_aggregator.*::peer_session_stats_json()`。
- `PeerSessionController::count()` / `stats_json()` 已删除；controller 不再承担只读 peer 聚合职责。
- `runtime_registry.h` 已和 `agent_runtime.h` 解耦，公共头只保留 registry facade 所需前置声明；底层 `runtime_state.peers` / `runtime_state.attached_surfaces` map 访问集中在 `runtime_registry.cpp`。
- `ffmpeg_probe.h` 已和 `agent_runtime.h` 解耦，公共头只保留现有全局 `FfmpegProbeResult` 前置声明；完整 probe/result 字段访问留在实现文件侧。
- `host_capture_plan.h` 已和 `agent_runtime.h` / `wgc_capture.h` 解耦，公共头只保留 host plan/pipeline 与 WGC probe/config 前置声明；完整 capture plan 字段和 WGC backend 依赖留在实现文件侧。
- `host_capture_process.h` 已和 `agent_runtime.h` 解耦，公共头只保留 host process/artifact/pipeline/probe 前置声明；默认空 artifact probe 逻辑由实现文件内两参 overload 承接。
- `PeerSessionController` 已接管 agent shutdown 时 receiver handles close 和 transport sessions close 两个批量 peer lifecycle 操作；`agent_lifecycle.cpp` 不再直接依赖 peer receiver runtime close helper。
- `PeerSessionController` 已接管 host-downstream peer media binding 批量 attach/detach；`host_session_controller.cpp` 不再持有 peer 遍历、peer-state event emit 或 peer transport renegotiation fallback 细节。
- `PeerSessionController` 已作为 agent refresh 和 audio start/stop 中批量 peer refresh 的入口；`agent_lifecycle.cpp` / `media_audio.cpp` 不再直接调用 `refresh_peer_transport_runtime()`、`perform_host_video_sender_soft_refresh()`、`refresh_host_audio_senders()` free functions。
- `agent_status_json.cpp/h` 不再持有 peer event/result JSON builder；`peer-state` event 和 peer RPC result JSON builder 已迁入 `peer_state_json.*`。
- `peer_control_runtime.cpp` 不再持有 setRemoteDescription/addIceCandidate OK result JSON builder；`build_peer_ok_json()` 已迁入 `peer_state_json.*`。
- `peer_control_runtime.cpp` 不再持有 closePeer closed result JSON builder；`build_peer_closed_result_json()` 已迁入 `peer_state_json.*`。
- `agent_status_json.cpp` 的 `build_status_json()` 不再直接读取 `state.attached_surfaces.size()`，改为通过 `surface_snapshot_aggregator.*::surface_session_count()`。
- `agent_status_json.cpp` 的 `build_status_json()` 不再直接拼 host status 字段，改为通过 `HostSessionController::append_status_json_fields()` 输出 `hostSessionRunning/hostBackend`。
- `agent_status_json.cpp` 的 `build_stats_json()` 不再调用 legacy `build_surface_attachments_json(state)`，改为通过 `surface_snapshot_aggregator.*::surface_session_stats_json()`。
- `SurfaceSessionController::count()` / `stats_json()` 已删除；controller 不再承担只读 surface 聚合职责。
- `host_session_controller.cpp` 不再直接遍历 `state.peers` 附加/解绑 host downstream media binding，改为通过 `runtime_registry` 的 `for_each_mutable_peer()` facade。
- `HostSessionController` 已新增 host capture surface 只读 facade：`is_running()`、`capture_artifact_ready()`、`ffmpeg_probe()`、`capture_plan()`、`capture_process()`、`capture_artifact()`；`SurfaceSessionController` 的 host capture surface refresh/restart 和 surface attach legacy helper 已改为通过 host owner 读取这些 snapshot，而不是直接读取 host runtime 字段。
- `HostSessionController::refresh_capture_runtime()` 已接管 host capture runtime refresh：窗口恢复检测、WGC capture handle/state 更新、capture plan re-validate、capture process refresh、artifact probe 和 manifest persist 都在 host owner 内执行；`agent_lifecycle.cpp::refresh_host_capture_runtime()` 仅保留触发 host refresh 和后续 surface refresh 的编排。
- `HostSessionController::stop_capture_process(reason)` 已接管 agent shutdown 时 host capture process 停止写入口；`shutdown_agent_runtime()` 保持原 shutdown 顺序，但不再直接调用 `stop_host_capture_process()` 或传入 host capture 内部字段。
- `HostSessionController::initialize_default_capture_runtime()` 已接管 agent 初始化时默认 host capture process/pipeline/plan 构建与验证；`initialize_agent_runtime()` 仍负责 FFmpeg/WGC/audio/transport probe 顺序，但不再直接写默认 host capture runtime 字段。
- `HostSessionController::revalidate_capture_plan()` 已接管 host video sender soft refresh 触发的 capture plan revalidate 写入口；`peer_media_binding_runtime.cpp` 只读取 host owner 暴露的 capture plan snapshot 来决定是否等待有效 plan。
- `HostSessionController` 已补齐 host video binding 只读 facade：`video_codec()`、`width()`、`height()`、`frame_rate()`、`bitrate_kbps()`、`pipeline()`、`ffmpeg_probe()`；`peer_media_binding_runtime.cpp` 的 host/OBS video binding 路径不再直接读取 `state.host_*` 或 `state.ffmpeg` 字段，OBS ingest 自身状态仍由 OBS runtime 持有。
- `ObsIngestSession::snapshot()` 已新增为 OBS ingest 只读 snapshot owner；`HostSessionController::obs_ingest_snapshot()` 仅转调用该 session facade，`peer_media_binding_runtime.cpp` 的 OBS host binding 路径不再直接读取 `state.obs_ingest_sessions.current`。
- `peer_control_runtime.cpp` 的 createPeer host-downstream 自动 media attach 判断已改为通过 `HostSessionController::is_running()`，不再直接读取 `state.host_session_running`。
- OBS ingest runtime 已通过 host snapshot/runtime facade 读取 host backend/capture target、判断 host session 是否正在运行、判断当前 backend 是否 OBS ingest，并在收到 OBS video packet 后通过显式 `set_host_video_codec` callback 更新 host codec；OBS runtime 不再直接读写这些 host session 字段。
- OBS backend 判定 helper 已从 `obs_ingest_runtime.h/.cpp` 公共 API 移除，改为 `host_session_controller.cpp` 内部 `is_obs_ingest_backend_state()`；外部调用统一走 `HostSessionController::is_obs_ingest()`。
- `start_host_session_from_request()` / `stop_host_session()` 已从 `host_session_controller.h` 公共 API 移除，降为 `host_session_controller.cpp` 匿名 namespace 内部 helper；外部只通过 `HostSessionController::start_from_request()` / `stop()` 操作 host session lifecycle。
- `host_session_controller.cpp` 已把 host start 请求配置应用和 stop 默认 native reset 拆成内部 lifecycle helper：`apply_host_session_start_request()` / `reset_host_session_to_default_native()`；start/stop 编排层不再直接内联大段 config apply/reset 写入。
- `host_session_controller.cpp` 已把 host start 的 backend 分支拆成内部 lifecycle helper：`start_obs_ingest_host_session()` / `start_native_capture_host_session()`；通用 start 编排层只负责 restart cleanup、request apply 和 backend dispatch。
- `host_session_controller.cpp` 已把 host restart/stop 共享资源 drain 拆成内部 lifecycle helper：`drain_running_host_session()`；该 helper 显式保留 restart 与 stop share 两条不同停止顺序，start/stop 编排层只调用 drain helper。
- `drain_running_host_session()` 内部的底层动作已继续收窄：host capture stop 和 downstream detach 仍保留命令 helper，OBS stop 通过 `host_session_runtime.*` 的窄 facade 进入已绑定的 `ObsIngestSession` owner。
- `HostSessionController::stop_obs_ingest_session()` 已成为 agent shutdown 停 OBS ingest runtime 的 facade；`shutdown_agent_runtime()` 不再直接 include 或调用 `obs_ingest_runtime.h/.cpp` 的 stop helper，并保持原 shutdown 顺序。
- `ObsIngestSession` facade 已新增，封装 `session_json()`、`prepare()`、`clear_prepared()`、`start_worker()` 和 `stop()`；`host_session_controller.cpp` 不再直接 include `obs_ingest_runtime.h` 或直接写 OBS worker/stop_requested。
- `ObsIngestSession` 已接管 prepared session reset、UDP port validation/prepare、worker start/stop cleanup、media-state payload、OBS ingest worker 主循环和 `prepareObsIngest` request 解析；`agent_rpc_router.cpp` 持有显式绑定 `ObsIngestState& + ObsIngestSessionRuntimeAccess` 的 `ObsIngestSession` facade 并调用实例方法。
- `obs_ingest_constants.h` 已新增为 OBS virtual upstream id 的轻量 owner；`ObsIngestSession` 和 `peer_media_binding_runtime.cpp` 不再为了 `kObsIngestVirtualUpstreamPeerId` include runtime RPC 头。
- `obs_ingest_runtime.h/.cpp` legacy RPC wrapper 已删除，`media-agent/CMakeLists.txt` 不再编译 `src/obs_ingest_runtime.cpp`。
- `peer_media_binding_runtime.cpp` 不再直接遍历 `state.peers` 执行 host sender soft refresh、transport refresh、host audio sender refresh，改为通过 `for_each_mutable_peer()` facade。
- `agent_lifecycle.cpp` 不再直接遍历 `state.attached_surfaces` 或 `state.peers` 执行 surface refresh/stop/restart、shutdown receiver/transport close，改为通过 `for_each_surface()` / `for_each_mutable_peer()` facade。
- `SurfaceSessionController` 已接管 host capture surface refresh、stop all surfaces、restart host capture surfaces 三个批量 surface lifecycle 操作；`agent_lifecycle.cpp` 只保留旧函数名 wrapper 调用 controller。
- `SurfaceSessionController` 已接管 closePeer 的 peer surface stop/erase；`peer_control_runtime.cpp` 不再直接遍历 surface 或调用 `erase_surface()`。
- `SurfaceSessionController` 公共头已和 `surface_control_runtime.h` 解耦，只暴露 `surface_control_result.h` 的 result 类型和前置声明；legacy surface runtime helper 头只在 controller 实现文件内部 include。
- `PeerSessionController` 公共头已和 `agent_runtime.h`、`peer_control_runtime.h`、`peer_media_binding_runtime.h` 解耦，只暴露 `peer_control_result.h` / `peer_media_binding_result.h` 的 result 类型和前置声明；legacy peer media binding helper 头已进一步下沉到 `peer_media_source_pipeline.cpp` 内部。
- `peer_control_runtime.cpp` 的 closePeer surface cleanup 已进一步改为调用 `SurfaceSessionController::detach_peer_surfaces()`，surface 遍历/erase 留在 surface owner 内部。
- `surface_attachment_runtime.*` 不再持有 surface JSON builder；surface attach/update result 和 `getStats.surfaces[]` 共享的 JSON builder 已迁入 `surface_state_json.*`，无调用方的 `build_surface_attachments_json()` 已删除。
- `audio_state_json.h` / `surface_state_json.h` 已和 `agent_runtime.h` 解耦，公共头只保留 snapshot/state 前置声明；完整 runtime 结构依赖留在实现文件侧。
- `AudioSessionState` 已从 `agent_runtime.h` 迁入独立 `audio_session_state.h`，`AudioSessionCommandResult` 已从 `media_audio.h` 迁入独立 `audio_session_result.h`；`AgentRuntimeState` 不再直接持有 `audio_session` 字段。
- `PeerVideoReceiverRuntime` 已从 `PeerState` 嵌套结构迁入独立 `peer_video_receiver_state.h`，`PeerState` 保留同名 alias 兼容旧路径；audio decode、viewer video pipeline、peer receiver runtime、surface attachment 公共头已改用顶层 receiver runtime 类型，减少对 `agent_runtime.h` 的公共依赖。
- `PeerVideoSenderRuntime` 已从 `PeerState` 嵌套结构迁入独立 `peer_video_sender_state.h`，`PeerMediaBindingState` 已从 `PeerState::MediaBindingState` 迁入独立 `peer_media_binding_state.h`，`PeerState` 保留同名 alias 兼容旧路径；`peer_state_json.h` 已改为前置声明 `PeerState` / `PeerMediaBindingState`，不再向调用方暴露 `agent_runtime.h`。
- `agent_context.h` 已从直接 include `agent_runtime.h` 改为前置声明 `AgentRuntimeState`；当前 media-agent 公共头层执行 `rg '#include "agent_runtime\\.h"' media-agent/src -g '*.h'` 已无命中，完整大 runtime 定义只在需要字段访问的实现文件侧引入。
- `VideoEncoderProbeResult` / `FfmpegProbeResult` 已从 `agent_runtime.h` 迁入独立 `ffmpeg_probe_state.h`；`agent_runtime.h` 仅组合该 state 作为兼容字段，`ffmpeg_probe.cpp` 已直接依赖 probe state 而不再 include 完整 runtime。
- `HostPipelineState`、`HostCapturePlan`、`HostCaptureProcessState`、`HostCaptureArtifactProbe` 已从 `agent_runtime.h` 迁入独立 `host_session_state.h`；host state JSON、capture plan、pipeline、capture process 实现文件已直接依赖轻量 host/probe state 头，不再为了字段访问 include 完整 runtime。
- `HostSessionState` 已引入 `host_session_state.h`，并聚合 host running/backend/capture target/codec/encoder/capture config/pipeline/capture plan/capture process/capture artifact；`AgentRuntimeState` 不再直接暴露这些顶层 `host_*` 字段。
- `HostSessionRegistry` 已引入 `session_registries.h`；`AgentRuntimeState` 当前持有 `host_sessions.current` 兼容单 session registry，和 `peer_sessions` / `surface_sessions` registry 形态对齐。
- `host_session_controller.cpp` 已迁到 `state.host_sessions.current.*` / `state_.host_sessions.current.*` 访问路径，`rg` 确认旧 `state.host_session` / `state_.host_session` 兼容字段访问已清零。
- `SurfaceAttachmentState` 已从 `agent_runtime.h` 迁入独立 `surface_attachment_state.h`；surface runtime 和 surface JSON 实现文件已直接依赖 surface state，`agent_runtime.h` 仅组合该 state 作为兼容 `attached_surfaces` map 字段。
- 当前补充：surface stats 聚合已改为只读 snapshot 路径：`surface_session_stats_json(const AgentRuntimeState&)` 通过 const surface iteration 聚合 `getStats.surfaces[]`，不会再获得 mutable runtime/surface 权限；attach/update result 仍保留 mutable formatter 的刷新行为。
- 当前补充：agent 顶层 JSON 聚合也已改为只读 snapshot 路径：`agent_status_json.h` 四个 builder 全部接收 `const AgentRuntimeState&`，避免只读输出阶段获得 mutable runtime 权限。
- `ObsIngestState` 已从 `agent_runtime.h` 迁入独立 `obs_ingest_session_state.h`；OBS ingest JSON helper 已直接依赖 OBS state，`AgentRuntimeState` 当前持有 `obs_ingest_sessions.current` 兼容单 session registry。
- `PeerState` 已从 `agent_runtime.h` 迁入独立 `peer_session_state.h`；peer JSON 和 peer video sender 实现文件已直接依赖 peer/host/probe state，`agent_runtime.h` 当前只保留 `AgentRuntimeState` 组合字段，peer state 具备后续下沉到 PeerSessionRegistry 的独立类型边界。
- `PeerSessionRegistry` / `SurfaceSessionRegistry` 已引入 `session_registries.h`；`AgentRuntimeState` 不再直接暴露 `peers` / `attached_surfaces` map 字段，而是持有 `peer_sessions` / `surface_sessions` registry，现有 `runtime_registry` facade 继续保持外部 API 不变。
- `PeerSessionRegistry` / `SurfaceSessionRegistry` 的底层 map 已私有化为 `peers_` / `surfaces_`，对外只暴露 `find/ensure/erase/count/for_each` 等 registry 方法；`runtime_registry.cpp` 已改为调用这些方法，业务代码不再能绕过 facade 直接访问 peer/surface map。
- `PeerSessionController` / `SurfaceSessionController` 已删除未使用的 public `find()` 方法，不再向 controller 调用方暴露可变 `PeerState*` / `SurfaceAttachmentState*` 指针入口；外部应继续走命令方法、stats JSON 或后续明确 snapshot API。
- `peer_control_runtime.h/cpp` 已删除；createPeer/closePeer/addRemoteIceCandidate/setRemoteDescription 均由 `PeerSessionController` 直接拥有，CMake 不再编译 legacy peer control runtime helper。
- `PeerSessionController::close_from_request()` 已直接拥有 closePeer command：解析 peerId、通过 registry facade 查找/删除 peer、调用 `SurfaceSessionController::detach_peer_surfaces()`、关闭 media binding/receiver/transport、清理 viewer-upstream relay bootstrap 和 viewer audio，并输出原 closed result JSON。
- `PeerSessionController::add_remote_ice_candidate_from_request()` 已直接拥有 addRemoteIceCandidate command：解析 peerId/candidate/sdpMid、执行 peer lookup、调用 transport candidate apply、刷新 transport snapshot，并保持无 transport fallback event 与 OK/error result JSON。
- `PeerSessionController::set_remote_description_from_request()` 已直接拥有 setRemoteDescription command：解析 peerId/type/sdp、执行 peer lookup、应用 media manifest、调用 transport remote description apply、刷新 transport snapshot，并保持无 transport fallback event 与 OK/error result JSON。
- `peer_media_manifest.h/cpp` 已新增为 peer media manifest apply 和 codec normalization helper，`createPeer` 与 `setRemoteDescription` 共享同一 manifest 写入逻辑。
- `PeerSessionController::create_from_request()` 当前作为 createPeer command facade：request parse/初始 state 配置由 `peer_create_request_config.*` 负责，transport callback/session 创建由 `peer_transport_session_factory.*` 负责，host-downstream attach、initial negotiation 和 registry/result 输出由 `peer_create_pipeline.*` 负责。
- `peer_transport_callback_factory.h/cpp` 已新增为 createPeer transport callback owner；callback factory 负责 local description/candidate signal、transport state event、warning event、remote video/audio frame 消费、encoded datachannel audio/video 分发和 manifest codec mismatch gate。
- `peer_create_pipeline.h/cpp` 已新增为 createPeer 收尾 pipeline owner；pipeline helper 负责 host-downstream attach、initial negotiation、registry store、created peer-state event、transport warning event 和 create result JSON。
- `peer_close_pipeline.h/cpp` 已删除；closePeer request 的 peer lookup、surface detach、media binding close prepare、receiver/transport close、viewer-upstream relay bootstrap 清理、viewer audio stop、closed peer-state event、registry erase 和 close result JSON 已由 `PeerSessionController::close_from_request()` 直接拥有。
- `peer_signaling_pipeline.h/cpp` 已删除；setRemoteDescription/addRemoteIceCandidate 的 request parsing、peer lookup、media manifest apply、transport remote description/candidate write、transport snapshot refresh、fallback peer-state event 和 OK/error result JSON 已由 `PeerSessionController` 直接拥有。
- `peer_host_binding_pipeline.h/cpp` 已新增为 host-downstream peer binding pipeline owner；pipeline helper 负责遍历 host-downstream peers、调用 host video attach/detach callback、写 media binding failure state、必要时重新生成 local description，并保留 attach 成功的 `media-source-attached` event。
- `peer_snapshot_aggregator.h/cpp` 已新增为 peer snapshot aggregation owner；aggregation helper 负责 peer count 和 `peers[]` stats JSON 拼接，只通过 `runtime_registry` facade 读取 peer registry，并复用既有 `build_peer_stats_json(peer)`。
- `peer_lifecycle_pipeline.h/cpp` 已新增为 peer shutdown lifecycle pipeline owner；pipeline helper 负责全量 receiver handle close 和 transport session close，controller 不再直接遍历 peer registry 执行 shutdown close-all。
- 当前补充：`peer_lifecycle_pipeline.cpp` 已移除 stale `agent_runtime.h` include，改为显式依赖 `peer_session_state.h` 和 `runtime_registry.h`；shutdown close-all helper 仍通过 registry facade 遍历 peer，不直接暴露完整 runtime 结构。
- `peer_refresh_pipeline.h/cpp` 已新增为 peer refresh pipeline owner；pipeline helper 负责 transport runtime refresh、host video sender soft refresh 和 host audio sender refresh，controller 不再直接调用 peer media binding legacy refresh helper。
- 当前补充：host video sender soft refresh 和 host audio sender refresh 已收回 `PeerSessionController` 私有 helper；`peer_refresh_pipeline.*` 现在只保留 transport runtime refresh 共享入口，门禁阻止公开 pipeline 重新暴露 host video/audio sender refresh。
- `peer_transport_session_factory.h/cpp` 已新增为 peer transport session creation owner；factory helper 负责 createPeer 的 callback holder、transport session 创建、manifest re-apply、transport snapshot 和 create success/failure phase/reason 写回。
- `peer_create_request_config.h/cpp` 已新增为 peer create configure owner；configure helper 负责 createPeer request parse、BAD_REQUEST result、初始 `PeerState` phase/reason、receiver runtime 创建和 media manifest apply。
- `peer_media_source_pipeline.h/cpp` 已新增为 attach/detach media source command owner；pipeline 已接管 attach/detach request parse、peer lookup、source 校验、attach/detach failure state、renegotiation、transport refresh、peer-state event 和 result JSON。
- 当前补充：`peer_media_source_pipeline.cpp` 已移除 stale `agent_runtime.h` include，改为显式依赖 `peer_session_state.h` 与 `runtime_registry.h`；attach/detach media source command 继续只通过 registry facade 访问 peer 和 snapshots。
- 当前补充：`detachPeerMediaSource` request body 已从 `peer_media_binding_runtime.*` 迁入 `peer_media_source_pipeline.cpp`；pipeline 负责 request parse、peer lookup、detach failure state、renegotiation、transport refresh、peer-state event 和 result JSON。
- 当前补充：`attachPeerMediaSource` request body 已从 `peer_media_binding_runtime.*` 迁入 `peer_media_source_pipeline.cpp`；legacy media binding runtime 只保留底层 host/relay attach helper 和 detach binding helper。
- `peer_relay_source_binding.h/cpp` 已新增为 relay source binding owner；relay upstream lookup、codec/audio readiness gate、encoded datachannel relay subscriber 注册、relay video/audio sender config 和 relay media binding state 写入已从 `peer_media_binding_runtime.cpp` 迁入该 helper。
- `peer_host_source_binding.h/cpp` 已新增为 host source binding owner；host capture/OBS ingest readiness gate、host video sender config/start、OBS relay subscriber 注册、host audio sender configure/clear 和 host media binding state 写入已从 `peer_media_binding_runtime.cpp` 迁入该 helper。
- `AudioSessionRegistry` 已引入 `session_registries.h`；`AgentRuntimeState` 当前持有 `audio_sessions.current` 兼容单 session registry，start/stop audio 和 host audio stats 由 audio owner 访问，peer media binding 的 host audio sender 判断已改为 `HostAudioDispatchSession::capture_ready()`，agent lifecycle 的 WASAPI status sync 已改为 `HostAudioDispatchSession::refresh_session_status()`。
- `surface_control_runtime.cpp` 不再持有 detachSurface detached result JSON builder；`build_surface_detached_result_json()` 已迁入 `surface_state_json.*`。
- `agent_status_json.cpp` 的 `build_stats_json()` 不再直接拼 host stats 字段，改为通过 `HostSessionController::append_stats_json_fields()` 输出 `hostSessionRunning/hostPipeline/hostCapturePlan`。
- `agent_status_json.cpp` 的 `build_stats_json()` 不再直接拼 audio stats 字段，改为通过 `HostAudioDispatchSession::stats_json()` 输出 `audioBackend`。
- `media_audio.*` 不再持有 audio stats JSON builder；`startAudioSession/stopAudioSession` result 和 `getStats.audioBackend` 共享的 `audio_session_json()` 已迁入 `audio_state_json.*`。
- `getStats` JSON 字段保持不变：`peers[]` 仍输出 `peerId/role/sessionPhase/phaseReason/mediaBinding/peerTransport/receiverRuntime/relaySubscriberRuntime`。
- `getStats` JSON 字段保持不变：`surfaces[]` 仍输出原 `surface_attachment_json()` 内容。
- host session start/stop 返回的 JSON 不再由 `agent_status_json.cpp` 的 `build_host_session_json()` 生成，改为由 `host_session_controller.cpp` 内部 `host_session_json()` 生成，并通过 `HostSessionController::session_json()` 暴露 read facade。
- host session JSON 字段保持不变：`running/backend/requestedCodec/codec/effectiveCodec/pipeline/capturePlan/obsIngest`。
- `HostSessionController` 已在构造函数中绑定 `HostSessionState& session_`；controller 成员方法的 status/stats 输出、capture runtime refresh、capture process stop、host snapshot getter/setter 均通过该 session 引用访问 host state，`state_.host_sessions.current` 的直接访问面收缩到构造绑定和 namespace lifecycle helper。
- `host_session_controller.cpp` 的 namespace lifecycle helper 已继续收窄为显式 `HostSessionState&`：`host_session_json()`、`refresh_default_native_host_plan()`、`apply_host_session_start_request()`、`reset_host_session_to_default_native()`、`start_obs_ingest_host_session()`、`start_native_capture_host_session()`、`stop_host_capture_session_for_reason()`、`drain_running_host_session()` 均通过 session 参数读写 host state；完整 runtime 仅保留 FFmpeg/WGC/OBS/peer transport 等跨服务依赖。
- `start_host_session_from_request()` / `stop_host_session()` 内部 helper 已改为由 `HostSessionController` 传入已绑定的 `HostSessionState& session_`；`host_session_controller.cpp` 内 `host_sessions.current` 访问只剩构造函数绑定，start/stop helper 不再自行解析兼容 registry current。
- `runtime_registry` 已新增 current session facade：`current_host_session()`、`current_audio_session()`、`current_obs_ingest_session()`；`HostSessionController`、`HostAudioDispatchSession`、`ObsIngestSession` 构造绑定均改为通过这些 facade 获取当前 session，业务/session controller 不再直接拼写 `host_sessions.current` / `audio_sessions.current` / `obs_ingest_sessions.current`。
- `HostSessionRegistry`、`AudioSessionRegistry`、`ObsIngestSessionRegistry` 的 session 状态已从公开 `current` 字段推进为私有 map-backed active session；公开入口只保留 `active_session()` / `ensure_session()` / `activate_session()` / `session_count()` / `active_session_id()`，不再暴露 `current_session()`。

当前仍未完成：

- host start/stop 的 config apply/reset 写入已拆为命名 lifecycle helper，并已写入 `AgentRuntimeState::host_sessions.current` 兼容单 session registry；后续需要继续把该 registry 升级为真正 HostSessionSnapshot/owner，而不是只保留 current 字段。
- 当前补充：`HostSessionController` 成员方法已持有 `HostSessionState& session_`，但 `apply_host_session_start_request()`、`reset_host_session_to_default_native()`、`start_obs_ingest_host_session()`、`start_native_capture_host_session()` 等 namespace helper 仍直接接收 `AgentRuntimeState&` 并写 `host_sessions.current`；后续应继续把这些 helper 改为显式接收 `HostSessionState&` 与必要服务依赖。
- 当前补充：上述 namespace helper 已改为显式接收 `HostSessionState&`；`host_sessions.current` 在 host controller 实现内仅保留在 start/stop 入口局部绑定和 controller 构造绑定。后续应继续把 `HostSessionState&` 绑定从兼容 registry 迁入真正 HostSessionRegistry owner，而不是由 helper 自行解析 current。
- 当前补充：`start_host_session_from_request()` / `stop_host_session()` 已进一步改为接收 controller 传入的 `HostSessionState&`，host controller 实现内不再有 start/stop 入口局部 `host_sessions.current` 绑定；当前仅构造函数负责从兼容 registry 绑定单 session。
- 当前补充：host/audio/OBS 三类 active session 绑定已集中到 `runtime_registry.cpp` facade；业务 controller 只调用 `active_*_session()`，不再直接知道兼容 registry 字段位置。`runtime_registry` 公开 current-session facade 已删除，后续真正升级 registry owner 时优先替换 active facade 的 session id 选择实现。
- 当前补充：三类 registry 的状态字段已私有化为 map-backed active session，外部只能通过 `active_session()` 或 `runtime_registry` facade 访问；后续迁移到多 session registry 时可在 registry 内部替换 active session id 选择策略，不再影响业务 controller。
- 当前补充：三类只读 session snapshot 统一通过 `runtime_registry` 暴露 `host_session_snapshot()` / `audio_session_snapshot()` / `obs_ingest_session_snapshot()`，内部直接读取 registry `active_session()`；registry 本身不再暴露 `snapshot()` alias。`getStats.audioBackend` 聚合已改为读取 `audio_session_snapshot()` 后直接格式化，不再为了只读 JSON 构造可写 `HostAudioDispatchSession`。
- 当前补充：`check-media-agent-boundary.js` 已把上述访问边界固化为自动门禁，禁止业务代码直接拼写 `host_sessions.current_session()`、`audio_sessions.snapshot()`、`obs_ingest_sessions.current_session()` 等兼容 registry facade，并禁止 `session_registries.h` 重新暴露 current/snapshot alias，避免后续 owner 收口回退。
- 当前补充：host session result JSON 中的 `obsIngest` 字段已改为通过 `obs_ingest_session_snapshot()` + `obs_ingest_json()` 读取只读状态，不再为了只读 JSON 构造 `ObsIngestSession`。
- 当前补充：agent status/stats 的 host 字段聚合已从 `HostSessionController::append_*_json_fields()` 迁到 `host_state_json.*` 的只读 formatter，并直接读取 `host_session_snapshot()`；`HostSessionController` 不再暴露只读 JSON append 方法。
- 当前补充：`ObsIngestSession::prepare_from_request()` 的 host-active guard 已改为通过 `ObsIngestSessionRuntimeAccess::host_session_snapshot` 读取 host snapshot，不再为了只读判断构造 `HostSessionController`；OBS worker 的 host codec 写回也改为通过显式 `set_host_video_codec` callback 完成。
- 当前补充：`peer_host_source_binding.cpp` 的 host video / OBS ingest media binding 已改为读取 `host_session_snapshot()`，并通过 `ffmpeg_probe_result(state)` 显式传入 probe service；该文件不再构造 `HostSessionController` 只读 host 状态。
- 当前补充：`peer_host_source_binding.cpp` 内部 OBS ingest binding helper 已改为接收 `HostSessionState` 与 `ObsIngestSessionSnapshot`，不再在 helper 内部接收完整 `AgentRuntimeState&` 或自行读取 host/OBS registry；外层 `attach_host_video_media_binding()` 仍作为当前兼容入口负责读取 snapshot 后注入。
- 当前补充：`peer_host_source_binding.cpp` 内部 native host video binding helper 已拆为 `attach_native_host_video_media_binding()`，显式接收 `HostSessionState`、`FfmpegProbeResult` 和 `AudioSessionState`，不再在非 OBS sender 配置/启动子流程中读取 ffmpeg/audio runtime facade；外层兼容入口负责读取 snapshot 后注入。
- 当前补充：`peer_host_source_binding.h` 已新增 `HostVideoBindingContext` 与 snapshot 版 `attach_host_video_media_binding(context, ...)`；完整 `AgentRuntimeState&` overload 退化为兼容包装器，只负责组装 host/ffmpeg/audio/OBS snapshots 后转发到 context 入口。
- 当前补充：`peer_refresh_pipeline.cpp::refresh_all_host_video_senders()` 的 soft refresh 路径已切到 `HostVideoBindingContext` overload；该路径在 revalidate capture plan 后显式组装 host/ffmpeg/audio/OBS snapshots，不再通过完整 runtime wrapper 调用 host video binding。
- 当前补充：`peer_media_source_pipeline.cpp::attach_peer_media_source_command()` 的 host source attach 路径已切到 `HostVideoBindingContext` overload；relay source 路径仍走 relay binding，host source 路径显式组装 host/ffmpeg/audio/OBS snapshots 后进入 host video binding。
- 当前补充：`peer_create_pipeline.cpp::attach_host_downstream_media_if_running()` 的 createPeer host-downstream 自动 attach 路径已切到 `HostVideoBindingContext` overload；该路径在 host running guard 通过后显式组装 host/ffmpeg/audio/OBS snapshots，不再通过完整 runtime wrapper 调用 host video binding。
- 当前补充：`agent_lifecycle.cpp::make_start_host_session_callbacks()` 的 host video attach callback 已切到 `HostVideoBindingContext` overload；内部路径不再调用完整 `AgentRuntimeState&` host video binding wrapper，runtime wrapper 仅保留为外部兼容入口。
- 当前补充：`peer_host_source_binding.h/cpp` 已删除完整 `AgentRuntimeState&` host video binding overload；该模块公共入口只剩 `HostVideoBindingContext` 版本，且实现文件不再 include `agent_runtime.h` / `runtime_registry.h`。
- 当前补充：`peer_media_detach_binding.cpp` 已移除 stale `agent_runtime.h` include，改为显式 include `peer_session_state.h` 取得 `PeerState` 完整类型；detach helper 继续只接收 `PeerState&`，不暴露完整 runtime。
- 当前补充：OBS ingest 只读 snapshot 已抽为 `make_obs_ingest_session_snapshot(const ObsIngestState&)`，`ObsIngestSession::snapshot()`、`HostSessionController::obs_ingest_snapshot()` 和 peer host-source OBS binding 均复用该 helper；只读 snapshot 路径不再需要构造 `ObsIngestSession`。
- 当前补充：`prepareObsIngest` RPC 入口已改为复用 `agent_rpc_router.cpp` 中的 `ObsIngestSession` 实例 facade；`ObsIngestSession::prepare_from_request()` 不再是公开静态函数，也不再在方法内部重新构造第二个 session facade。
- 当前补充：`SurfaceSessionController` 的 host capture surface attach/refresh/restart 已改为读取 `host_session_snapshot()` 和 `ffmpeg_probe_result()`，不再构造 `HostSessionController` 读取 host capture/pipeline/probe 状态。
- 当前补充：`peer_create_pipeline.cpp::attach_host_downstream_media_if_running()` 的 host running guard 已改为读取 `host_session_snapshot()`，create peer 路径不再为了只读 running 判断构造 `HostSessionController`。
- 当前补充：audio capture readiness 已抽为 `audio_session_capture_ready(const AudioSessionState&)`；peer host-source binding 和 peer refresh 的只读 audio guard 改为读取 `audio_session_snapshot()`，仅在需要 register/unregister transport session 或实际 audio session 命令时构造 `HostAudioDispatchSession`。
- 当前补充：`peer_refresh_pipeline.cpp::refresh_all_host_video_senders()` 已不再构造 `HostSessionController`；host running guard 读取 `host_session_snapshot()`，需要写回 capture plan 的软刷新重校验收口到 `host_session_runtime.*::revalidate_host_capture_plan(runtime, session)`，peer refresh 显式绑定当前 host session 后调用 capture-plan command facade。
- 当前补充：`ObsIngestSession::run_worker()` 已不再构造 `HostSessionController`，也不再接收完整 `AgentRuntimeState*`；media-state payload 通过 `ObsIngestSessionRuntimeAccess` 读取 host snapshot/transport ready，OBS video codec 写回通过显式 host codec callback 完成。
- 当前补充：`agent_lifecycle.cpp` 的 host capture refresh、default capture init、shutdown OBS stop 和 shutdown capture stop 已不再构造 `HostSessionController`；这些 lifecycle command 已收口到 `host_session_runtime.*` 的窄 facade，`HostSessionController` 自身也委托同一套 facade 保持行为一致。
- 当前补充：`HostSessionController` public API 已瘦身为 `start_from_request()` / `stop()` 两个 RPC command 方法；旧只读 getter、lifecycle facade wrapper 和 codec/capture setter 已删除，host 只读状态读取统一走 snapshot/runtime facade。
- 当前补充：host session command result JSON formatter 已从 `host_session_controller.cpp` 迁到 `host_state_json.*`；formatter 显式接收 `HostSessionState` 和 `ObsIngestState` snapshot，不再从 controller 文件里读取完整 runtime。
- 当前补充：`host_session_runtime.*` 的 facade 实现已真正从 `host_session_controller.cpp` 迁入 `host_session_runtime.cpp`；窗口恢复检测、默认 capture plan 刷新、capture artifact probe/manifest persist、OBS stop 和 capture process stop 不再驻留在 host command controller 文件内。
- 当前补充：`apply_host_session_start_request()` / `reset_host_session_to_default_native()` 已迁入 `host_session_runtime.*`；host command controller 文件不再承载 request JSON apply 或默认 native reset 的字段级写入逻辑。
- 当前补充：host start 的 OBS/native backend helper 已迁入 `host_session_start_pipeline.*`，`HostSessionController` 只保留 start request apply、restart drain、按 backend 分派和 stop command 编排。
- 当前补充：`host_session_controller.cpp`、`host_session_start_pipeline.cpp`、`host_session_stop_pipeline.cpp` 已移除 stale `agent_runtime.h` include，改为显式依赖 `host_session_state.h` 及各 runtime/registry facade；host controller/start/stop 仍传递 `AgentRuntimeState&` 作为 command/facade 入口，但实现不直接依赖完整 runtime 头或字段布局。
- host start pipeline 仍直接写 `AgentRuntimeState` 的 host pipeline、capture plan、capture process 和 OBS worker 字段；后续需要进一步迁成 HostSessionSnapshot/OBS session owner。
- 当前补充：host stop/drain helper 已迁入 `host_session_stop_pipeline.*`，`HostSessionController` 文件只保留 start request 分派和 class 方法委托。
- 当前补充：host start/stop pipeline 对 OBS ingest 的 prepare/clear/start/stop 调用已收口到 `host_session_runtime.*` 窄 facade，pipeline 不再直接 include 或构造 `ObsIngestSession`。
- 当前补充：`HostSessionController` 构造时已同时绑定 active `HostSessionState&` 和 active `ObsIngestState&`；`host_session_start_pipeline.*` / `host_session_stop_pipeline.*` 的 start/stop/drain 入口显式接收 `ObsIngestState&`，不再在 pipeline 内自行调用 `active_obs_ingest_session(state)` 解析 OBS owner。`check-media-agent-boundary.js` 已新增门禁，防止 start/stop pipeline 回退到内部解析 active OBS owner。
- 当前补充：`host_session_runtime.*` 已删除 `reset_host_session_to_default_native(runtime_state, session)` 隐式 active OBS overload；默认 native reset 只能通过显式 `ObsIngestState&` owner 入口执行，门禁已防止该二参 overload 回流。
- 当前补充：host start/stop pipeline 的 command result JSON 已改为 `host_session_json(session, obs_ingest)`，直接读取已注入的 OBS owner；pipeline 内不再为了 `obsIngest` 字段回读 `obs_ingest_session_snapshot(state)`。`check-media-agent-boundary.js` 已新增门禁，防止 start/stop pipeline 重新通过 runtime snapshot 格式化 OBS result JSON。
- 当前补充：host started/stopped 事件 payload 的 `transportReady` 字段已改为通过 `HostSessionControllerCallbacks::transport_ready` provider 注入；`host_session_start_pipeline.cpp` / `host_session_stop_pipeline.cpp` 不再调用 `peer_transport_ready(state)` 或 include runtime registry 来横向读取 peer transport snapshot。边界门禁已覆盖该回退。
- 当前补充：native host start 的 capture process 启动已收口到 `host_session_runtime.*::start_host_capture_process(runtime, session)`；start pipeline 不再直接调用底层全局 capture process helper 或读取 FFmpeg probe。
- 当前补充：host start/stop pipeline 的 host-downstream attach/detach 已改为调用 `peer_host_binding_pipeline.*` 窄入口，不再直接构造 `PeerSessionController`；`peer_host_binding_pipeline.cpp` 也改为依赖 `host_session_command.h`，不再 include controller class 头。
- 当前补充：`PeerSessionController::attach_host_downstream_media_bindings()` / `detach_host_downstream_media_bindings()` 过时 wrapper 已删除；host-downstream 批量绑定只保留 `peer_host_binding_pipeline.*` 窄入口。
- 当前补充：`runtime_registry` 已新增 `for_each_mutable_peer_with_role()`；`peer_host_binding_pipeline.*` 不再遍历全部 peer 后自行筛选 `host-downstream`，role 过滤收口到 registry facade。
- 当前补充：`peer_host_binding_pipeline.cpp` 已移除 stale `agent_runtime.h` include，改为显式依赖 `peer_session_state.h` 与 `runtime_registry.h`；host-downstream 批量绑定 pipeline 继续只通过 role-filtered registry facade 遍历 peer。
- 当前补充：role-filtered peer 遍历已进一步下沉到 `PeerSessionRegistry::for_each_mutable_with_role()`；`runtime_registry::for_each_mutable_peer_with_role()` 只保留转发 facade。
- 当前补充：`peer_refresh_pipeline.*` 的 host video/audio sender refresh 也已改用 `for_each_mutable_peer_with_role(..., "host-downstream", ...)`，不再在 refresh pipeline 中手写 host-downstream role 过滤。
- 当前补充：`host_session_runtime.*` 已新增显式 `HostSessionState&` owner API：`revalidate_host_capture_plan()`、`initialize_default_capture_runtime()`、`refresh_host_capture_runtime()`、`start_host_capture_process()`、`stop_host_capture_process()`、`set_host_video_codec()`；旧 `current_*` 函数仅保留为兼容 wrapper。
- 当前补充：host start/stop pipeline、agent lifecycle、host video sender soft refresh 和 OBS codec 写回主调用点已改为传入显式 `HostSessionState&`，不再回绕 `current_*` host runtime facade；`drain_running_host_session()` 也改为接收当前 session 引用，重启和停止路径使用同一个 owner。
- 当前补充：`host_session_runtime.*` 已新增显式 `ObsIngestState&` owner API：`prepare_obs_ingest_session()`、`clear_obs_ingest_prepared()`、`start_obs_ingest_worker()`、`stop_obs_ingest_session()`；host OBS start、native start clear-prepared、host drain/stop、agent shutdown 均已显式绑定当前 OBS ingest session 后调用，旧 `current_obs_*` 函数仅保留为兼容 wrapper。
- 当前补充：`ObsIngestSessionRuntimeAccess` 已新增显式 `HostSessionState&` 绑定入口；RPC loop 和 `host_session_runtime.*` 创建 OBS ingest facade 时都传入同一个 host session owner，OBS worker 的 host snapshot 读取与视频 codec 写回不再隐藏调用 `current_host_session()`。
- 当前补充：agent status/stats 的 peer count 和 peers JSON 已改为直接调用 `peer_snapshot_aggregator.*`；`PeerSessionController::count()` / `stats_json()` 只读 API 已删除，controller 继续收敛为 command owner。
- 当前补充：agent status/stats 的 surface count 和 surfaces JSON 已改为直接调用 `surface_snapshot_aggregator.*`；`SurfaceSessionController::count()` / `stats_json()` 只读 API 已删除，controller 继续收敛为 command owner。
- 当前补充：`peer_snapshot_aggregator.cpp` 与 `surface_snapshot_aggregator.cpp` 已移除 stale `agent_runtime.h` include，分别显式依赖 `peer_session_state.h` / `surface_attachment_state.h` 与 `runtime_registry.h`；snapshot 聚合层继续只通过 registry facade 读取 count/stats。
- `host_session_start_pipeline.*` / `host_session_stop_pipeline.*` 内部仍委托 legacy capture process stop 和 peer host binding pipeline；后续需要继续迁成真正 capture session drain 和 downstream detach command owner。
- `ObsIngestSession` 已接管 prepare/clear/stop/start worker、worker 主循环、stream metadata 写入和只读 snapshot 输出，但内部仍直接写 `obs_ingest_sessions.current` 兼容单 session registry；后续应继续把该 registry 升级成真正 OBS ingest session owner/snapshot。
- `runtime_registry` facade 已成为当前剩余 peer/surface registry 访问点，registry 内部 map 已不再公开；这是 M7 的中间态，后续应继续把 `find/ensure/erase/count/for_each` 方法升级为更明确的 PeerSession/SurfaceSession owner 命令和 snapshot API。
- 当前补充：`PeerSessionController` / `SurfaceSessionController` 已不再公开未使用的 `find()` 指针 API；后续如需查询 peer/surface，应新增只读 snapshot 或具体 command，而不是重新暴露可变 state 指针。
- 当前补充：peer request command 的旧全局 free-function API 与 `peer_control_runtime.*` 文件已删除；create/close/setRemoteDescription/addRemoteIceCandidate 的真实写入 owner 已迁入 `PeerSessionController`。后续应继续把 controller 内的大 createPeer callback 构造拆成 PeerSession/transport factory，而不是重新引入 runtime helper。
- 当前补充：`peer_session_controller.cpp` 已移除 stale `agent_runtime.h` include，改为显式依赖 `peer_session_state.h` 与 `runtime_registry.h`；PeerSessionController 仍持有 `AgentRuntimeState&` 作为 command owner 的 registry facade 入口，但实现不直接依赖完整 runtime 头或字段布局。
- 当前补充：createPeer callback 构造已拆成 `peer_transport_callback_factory.*`；后续可继续把 host-downstream attach、initial negotiation 和 registry ensure 拆为更明确的 PeerSession create pipeline。
- 当前补充：host-downstream attach、initial negotiation 和 registry ensure 已拆成 `peer_create_pipeline.*`；后续可继续把 createPeer 的 transport session 创建本身拆进 PeerSession/transport owner。
- 当前补充：peer create finalize 已收回 `PeerSessionController` 私有 helper；`peer_create_pipeline.h` 不再暴露 `AgentRuntimeState&` finalize 写入口，只保留 attach/initial negotiation 子步骤，边界门禁已覆盖该回退。
- 当前补充：`peer_create_pipeline.cpp` 与 `peer_refresh_pipeline.cpp` 已移除 stale `agent_runtime.h` include，改为显式依赖 `peer_session_state.h` 与所需 host/audio/OBS/transport state 头；create/refresh pipeline 仍通过 `runtime_registry.h` facade 访问 registry 和 snapshots，不直接依赖完整 runtime 头。
- 当前补充：createPeer host-downstream 自动 attach 的 host/ffmpeg/audio/OBS snapshot 组装已从 `peer_create_pipeline.cpp` 上移到 `PeerSessionController::create_from_request()` owner 边界；`attach_host_downstream_media_if_running()` 现在只接收 `HostVideoBindingContext`，不再自行读取 host/OBS/audio registry。
- 当前补充：closePeer cleanup 已从临时 `peer_close_pipeline.*` 收回 `PeerSessionController::close_from_request()`；后续可继续评估 setRemoteDescription/addRemoteIceCandidate 的 signaling pipeline 是否也应收回 controller 或保持窄 helper。
- 当前补充：setRemoteDescription/addRemoteIceCandidate 已从临时 `peer_signaling_pipeline.*` 收回 `PeerSessionController`；`PeerSessionController` 现在直接拥有 create/close/signaling 四个核心 peer request command。
- 当前补充：host-downstream media binding 批量 attach/detach 已拆成 `peer_host_binding_pipeline.*`；peer count/stats JSON 已拆成 `peer_snapshot_aggregator.*`；shutdown close-all 已拆成 `peer_lifecycle_pipeline.*`；refresh 批处理真实实现已拆成 `peer_refresh_pipeline.*`；createPeer transport session 创建已拆成 `peer_transport_session_factory.*`；create request configure 已拆成 `peer_create_request_config.*`；attach/detach media source command 已拆成 `peer_media_source_pipeline.*`，且 attach/detach request body 均已完成真实迁移；relay source binding 已拆成 `peer_relay_source_binding.*`；host source binding 已拆成 `peer_host_source_binding.*`；detach media binding 与 transport close cleanup 已拆成 `peer_media_detach_binding.*`；`peer_media_binding_runtime.*` 已删除。后续 peer 侧重点应转向 registry owner/snapshot API，而不是继续维护 legacy runtime 文件。
- 当前补充：surface attach/update/detach request command 已从 `surface_control_runtime.*` 和中间 `surface_command_pipeline.*` 完整迁入 `SurfaceSessionController` 本体；`surface_control_runtime.*`、`surface_command_pipeline.*` 均已删除，`media-agent/CMakeLists.txt` 不再编译旧 surface command 文件。后续 surface 侧重点应继续把 controller 本体内的 attach 逻辑拆成私有 helper/snapshot command，而不是重新引入外部 command pipeline。
- 当前补充：`surface_session_controller.cpp` 已移除 stale `agent_runtime.h` include，改为显式依赖 `peer_session_state.h`、`surface_attachment_state.h` 和 `runtime_registry.h`；controller 仍持有 `AgentRuntimeState&` 作为 registry facade 入口，但实现不直接依赖完整 runtime 头或字段布局。
- `AudioSessionRegistry` 目前仍只是 `current` 兼容单 session 容器；audio start/stop、status refresh、stats 和 host capture ready 判断已由 `HostAudioDispatchSession` 访问，后续应继续把 registry 升级为真正 session owner/snapshot，而不是保留兼容 `current` 字段。
- 当前补充：`HostAudioDispatchSession` 已在构造时绑定 `AudioSessionState* session_`，`capture_ready()`、`refresh_session_status()`、`start_from_request()`、`stop_from_request()` 和 `stats_json()` 均通过该 session 指针访问 audio state；`audio_sessions.current` 的直接访问面收缩到构造绑定。
- `ObsIngestSessionRegistry` 目前仍只是 `current` 兼容单 session 容器；后续应继续把 prepare/start/stop worker、stream metadata 和 pending Annex-B cache 收进 OBS/Host session owner，避免业务文件直接读写 `obs_ingest_sessions.current`。
- 当前补充：`ObsIngestSession` 非静态方法已持有 `ObsIngestState& session_`，`session_json()`、`snapshot()`、`prepare()`、`clear_prepared()`、`start_worker()`、`stop()` 不再直接拼写 `state_.obs_ingest_sessions.current`；`run_worker()` 已改为显式接收 `ObsIngestState* session`，并通过该引用读写 waiting/connected/running/metadata/pending Annex-B/stop flag。直接访问 current 字段的范围收缩到兼容构造绑定，后续可继续把 OBS worker 需要的跨服务依赖从 `AgentRuntimeState*` 拆成更小 worker context。
- 当前补充：OBS worker 的 `media-state` payload helper 已改为显式接收同一个 `ObsIngestState& session`，不再为了输出 `obsIngest` JSON 从 `AgentRuntimeState` 重新构造 `ObsIngestSession(state)`；worker 侧跨 session 读取/写入通过 `ObsIngestSessionRuntimeAccess` 的窄 callback 完成。
- 当前补充：OBS worker 的 `media-state` payload helper 已进一步改为显式接收 `HostSessionState&` snapshot 和 `transportReady` snapshot；payload formatter 本身不再接收完整 `AgentRuntimeState&`。
- 当前补充：`ObsIngestSessionRuntimeAccess` 已新增为 OBS ingest owner 的窄依赖入口，显式注入 `host_session_snapshot`、`peer_transport_ready` 和 `set_host_video_codec`；RPC loop 与 `host_session_runtime.*` 的 prepare/clear/start/stop 路径均绑定显式 `HostSessionState&` + `ObsIngestState&`，不再直接 `ObsIngestSession(runtime_state)` 构造，也不再在 runtime access 内隐藏查找 current host session。
- 当前补充：`ObsIngestSession(AgentRuntimeState&)` 兼容构造入口已删除；OBS ingest owner 现在只能通过显式 `ObsIngestState& + ObsIngestSessionRuntimeAccess` 构造，防止新代码重新绕回完整 runtime 构造。

## M6 当前进展：ViewerAudioSession facade

本阶段新增：

- `viewer_audio_session.h/cpp`
  - `ViewerAudioSession::set_volume_from_request()`
  - `ViewerAudioSession::get_volume_from_request()`
- `ViewerAudioSession::set_delay_from_request()`
- `ViewerAudioSession::consume_remote_peer_frame()`
- `ViewerAudioSession::stop()`
- `viewer_audio_playback.h/cpp` 公开面已收窄为：
  - `viewer_audio_playback_is_active()`
  - `set_viewer_audio_software_volume()`
  - `get_viewer_audio_software_volume()`
  - `set_viewer_audio_delay_ms()`
  - `stop_viewer_audio_playback_runtime()`
  - `queue_viewer_audio_pcm_block()`
- `host_audio_dispatch_session.h/cpp`
  - `HostAudioDispatchSession::register_transport_session()`
  - `HostAudioDispatchSession::unregister_transport_session()`
  - `HostAudioDispatchSession::reset_transport_sessions()`
  - `HostAudioDispatchSession::set_capture_active()`
  - `HostAudioDispatchSession::dispatch_capture_packet()`
  - `HostAudioDispatchSession::start_from_request()`
  - `HostAudioDispatchSession::stop_from_request()`
  - `HostAudioDispatchSession::attach_wasapi_callbacks()`

当前边界：

- `agent_rpc_router.cpp` 的 `setViewerVolume` / `getViewerVolume` / `setViewerAudioDelay` 已从直接调用 `viewer_audio_playback` helper 改为调用 `ViewerAudioSession`。
- 音量/延迟 request 解析、software volume fallback、WASAPI render session volume 调用已迁入 `ViewerAudioSession`。
- `peer_control_runtime.cpp` 收到 remote audio frame 或 encoded data channel audio frame 后已通过 `ViewerAudioSession::consume_remote_peer_frame()` 进入本地播放/relay 逻辑。
- relay audio publish、codec 归一化、PCM decode、startup random access gate 和 dispatched/drop 统计写入已迁入 `ViewerAudioSession`。
- `agent_lifecycle.cpp` 和 close viewer-upstream peer 路径已通过 `ViewerAudioSession::stop()` 停止 viewer audio playback。
- `viewer_audio_playback.*` 现在持有私有 playback runtime，负责 PCM queue、WASAPI playback worker、queue buffering、软件音量和延迟；`AgentRuntimeState` 不再承载 viewer playback worker/queue。
- `peer_media_binding_runtime.cpp` 中 host audio sender register/unregister 路径已改为 `HostAudioDispatchSession` facade。
- `agent_lifecycle.cpp` 的 agent shutdown host audio transport reset 已改为 `HostAudioDispatchSession::reset_transport_sessions()`。
- host audio capture active flag、capture packet queue、Opus encoder、dispatch worker 和 transport session registry 已迁入 `host_audio_dispatch_session.cpp` 私有实现；`media_audio.cpp` 的 WASAPI PCM callback 只调用 `HostAudioDispatchSession::dispatch_capture_packet()`。
- `agent_rpc_router.cpp` 的 `startAudioSession` / `stopAudioSession` 已改为直接调用 `HostAudioDispatchSession::start_from_request()` / `stop_from_request()`；`media_audio.cpp` 不再持有 start/stop audio RPC 入口。
- WASAPI event/PCM callback 挂接已改为由 `HostAudioDispatchSession::attach_wasapi_callbacks()` 负责；`media_audio.*` 不再 include `agent_runtime.h`、`agent_events.h` 或 `host_audio_dispatch_session.h`。
- `audio_transport_config.h` 已新增为 transport audio sample rate/channel count/bitrate 常量的轻量 owner；`peer_media_binding_runtime.cpp` 不再为了常量 include `media_audio.h`。
- WASAPI status -> `AudioSessionState` 转换已收进 `host_audio_dispatch_session.cpp` 内部 helper；`media_audio.*` 不再声明或实现 `build_audio_session_state()`，也不再 include `audio_session_state.h`、`audio_state_json.h` 或 `wasapi_backend.h`。
- `media_audio.h` 不再 include `audio_transport_config.h`；transport audio 常量只由需要编码/绑定配置的 `.cpp` 直接 include，`media_audio.h` 公共面只剩 decode/reset API。
- `AgentRuntimeState` / `agent_runtime.h` 不再暴露 `HostAudioDispatchState`。

后续规则：

- 新增 host audio transport registry、capture active 或 PCM dispatch 调用应先走 `HostAudioDispatchSession`，不要重新在 `media_audio.*` 暴露底层 helper。
- 新增 viewer audio RPC、remote audio consume 或 playback lifecycle 调用应先走 `ViewerAudioSession`，不要从业务文件直接调用 `viewer_audio_playback` 底层 facade。
- 当前补充：`ViewerAudioSession` 已删除无实际用途的 `AgentRuntimeState& state_` 成员和 `AgentRuntimeState&` 构造入口；调用方均使用默认构造，viewer audio facade 不再暴露完整 runtime 依赖。
- 当前 M6 host/viewer audio owner 切片已完成；后续可继续把 `media_audio.*` 的 decode helper 从 runtime 头文件依赖中剥离，或进入 M7 RuntimeState 瘦身。

## M5 当前进展：RelayHub / EncodedFrameBus 兼容边界

本阶段新增：

- `encoded_frame_bus.h/cpp`
  - `EncodedFrame`
  - `EncodedFrameBatch`
  - `EncodedFrameBus::publish_video()` / `publish_audio()`
- `relay_hub.h/cpp`
  - `RelayHub::publish_video_units()`
  - `RelayHub::publish_audio_frame()`
  - `relay_hub()` 全局兼容入口

当前边界：

- `viewer_video_pipeline.cpp` 收到上游视频后不再直接调用 `fanout_relay_video_units()`，改为 `relay_hub().publish_video_units(...)`。
- `viewer_audio_playback.cpp` 收到上游音频后不再直接调用 `fanout_relay_audio_frame()`，改为 `relay_hub().publish_audio_frame(...)`。
- `obs_ingest_session.cpp` 的 OBS 音视频包发布也已改为 `relay_hub().publish_*`。
- `RelayHub` 内部仍委托现有 relay backend runtime，保留原 subscriber、bootstrap、队列、backpressure 和发送逻辑，因此本切片不改变 relay 行为。
- subscriber 注册/注销、subscriber runtime 查询、upstream bootstrap 清理和 relay runtime shutdown 已收敛到 `RelayHub` facade；业务文件不再直接 include `relay_dispatch.h`。
- `RelayBackendState`、`RelayUpstreamVideoBootstrapState`、`QueuedRelayVideoDispatch` 和 `RelayDispatchTarget` 已从 `agent_runtime.h` 下沉为 `relay_backend::Runtime` / `relay_backend_runtime.cpp` 私有实现；`RelaySubscriberState` 因为 stats 查询仍需要公开 snapshot，已移动到 `relay_subscriber_state.h`。
- `relay_backend_runtime.*` 仍是兼容实现，后续可继续把 subscriber registry、bootstrap ownership 和分发 worker 迁入 `RelayHub` 私有实现或拆成更小 backend 模块。
- 当前补充：`relay_backend_runtime.cpp` 已移除 stale `agent_runtime.h` include，改为显式 include `peer_transport.h` 获取 transport snapshot/send API；Relay backend 继续只管理私有 subscriber/bootstrap/dispatch queue runtime。
- 当前补充：`RelaySubscriberState` 已从 `relay_dispatch.h` 迁入独立 `relay_subscriber_state.h`；`relay_hub.h` 只暴露 RelayHub facade 与 subscriber snapshot 类型，不再 include legacy `relay_dispatch.h` 或把 `register_relay_subscriber()` / `fanout_relay_*()` backend API 传染给调用方。
- 当前补充：legacy `relay_dispatch.h` 已删除，后端 runtime 声明迁入 `relay_backend_runtime.h`，后端实现文件已从 `relay_dispatch.cpp` 重命名为 `relay_backend_runtime.cpp`；`relay_hub.cpp` 与 `relay_backend_runtime.cpp` 是唯二允许 include backend runtime 头的文件，业务和公开 facade 只能 include `relay_hub.h` / snapshot state。
- 当前补充：`peer_relay_source_binding` 已改为 `RelayVideoBindingContext` 入口，source 解析、self-reference guard 和 upstream peer registry lookup 移到 `peer_media_source_pipeline.cpp`；relay binding helper 本体不再 include `agent_runtime.h` / `runtime_registry.h`，也不再调用 `find_peer()`。

后续规则：

- 新增的 encoded audio/video 发布路径应走 `RelayHub` 或 `EncodedFrameBus`，不要从新代码直接调用 `fanout_relay_*`。
- 新增的 subscriber/relay lifecycle 路径应走 `RelayHub`，不要从新代码直接调用 `register_relay_subscriber()` / `clear_relay_upstream_bootstrap_state()` 等 legacy API。
- 旧 relay backend runtime 暂时作为 `RelayHub` backend 存在；只有当 subscriber/bootstrap ownership 进一步并入 `RelayHub` 私有 backend 后，才继续拆小或删除兼容 backend API。
- 当前补充：该规则已有自动门禁覆盖，`check-media-agent-boundary.js` 会阻止任何源码 include 旧 `relay_dispatch.h`，并阻止除 `relay_backend_runtime.cpp` / `relay_hub.cpp` 之外的源码 include `relay_backend_runtime.h`。
- 当前补充：门禁也会阻止业务源码直接调用 legacy relay backend 函数；白名单仅限 backend 声明/实现与 `RelayHub` 委托实现。
- 当前补充：backend 函数已不再位于全局命名空间，而是收拢到 `vds::media_agent::relay_backend`，避免和业务 facade 处在同一符号层级。
- 当前补充：backend 状态已继续从命名后的 `RelayBackendState` / `relay_backend_state()` 文件级 static 入口，收口为 `relay_backend::Runtime` pimpl；`RelayHub` 私有持有 runtime，并在 `shutdown_runtime()` / 析构中停止 dispatch worker。
- 当前补充：legacy `register_relay_subscriber()` / `fanout_relay_*()` / `query_relay_subscriber_state()` 等 free backend API 已成员化为 `Runtime` 方法；`RelayHub` 不再调用 relay backend free functions，而是通过私有 backend pimpl 执行 register/query/fanout/shutdown。
- 当前补充：`relay_hub.h` 已不再前置声明或拼写 `relay_backend::Runtime`，公开头只暴露 `RelayHub` facade、`EncodedFrameBus` 和 `RelaySubscriberState`；backend 类型名被收进 `relay_hub.cpp` 的 `RelayHub::Backend` pimpl。`check-media-agent-boundary.js` 已增加门禁，禁止 `relay_hub.h` 重新暴露 `relay_backend` 实现名。

## 验证命令

## M6/M7 补充：RPC loop host audio owner 持有方式

- `agent_rpc_router.cpp` 现在在 RPC loop 初始化阶段持有一个持久 `HostAudioDispatchSession` facade，与 `HostSessionController`、`PeerSessionController`、`SurfaceSessionController` 和 `ViewerAudioSession` 的 owner 持有方式保持一致。
- `startAudioSession` / `stopAudioSession` 不再各自临时构造 host audio dispatch owner，只调用 RPC loop 持有的 facade。
- RPC loop 创建 `HostAudioDispatchSession` 时注入同作用域的 `PeerSessionController`，audio start/stop 后刷新 host audio sender 时优先复用该 peer controller；其它调用点未注入时仍保留通过 `AgentRuntimeState` 构造临时 peer controller 的兼容 fallback。
- RPC loop 创建 `HostAudioDispatchSession` 时同时注入 `transportReady` snapshot provider；audio started/stopped 事件里的 `transportReady` 字段优先读取该 provider，未注入的兼容调用点才 fallback 到 `AgentRuntimeState.peer_transport_backend.transport_ready`。
- RPC loop 创建 `HostAudioDispatchSession` 时已改为传入 `current_audio_session(runtime_state)`，完整 `AgentRuntimeState&` 构造函数保留为兼容层并委托到 `AudioSessionState&` 构造入口；audio owner 的主 RPC 路径不再以完整 runtime 作为构造入参。
- `runtime_registry` 已新增 peer transport 只读 facade：`peer_transport_backend()` / `peer_transport_ready()`；`agent_status_json.cpp` 的 capabilities/status/agent-ready JSON 不再直接拼写 `state.peer_transport_backend`，改为通过 facade 读取，JSON 输出字段保持不变。
- 当前补充：`agent_status_json.cpp` 已移除 stale `agent_runtime.h` include；status/capabilities/stats JSON 聚合层继续通过 `runtime_registry.h` facade 与 snapshot aggregator 读取状态，不直接依赖完整 runtime 头或字段布局。
- peer transport facade 使用面继续扩大：`initialize_agent_runtime()` 的 backend 初始化写入、RPC host audio `transportReady` provider、`refresh_all_peer_transport_runtime()` 的无 transport session fallback snapshot 已改为通过 `peer_transport_backend()` / `peer_transport_ready()` 访问，减少业务文件直接拼写 runtime 字段名。
- peer create/close 相关路径已继续迁移到 peer transport facade：create request 初始 snapshot、transport session factory ready gate、controller create ready gate、close result ready 字段均不再直接读取 `runtime_state.peer_transport_backend`。
- 当前补充：`configure_peer_create_request()` 已改为接收 `PeerTransportBackendInfo` snapshot，不再接收完整 `AgentRuntimeState&`；`PeerSessionController::create_from_request()` 作为 owner 入口负责通过 `peer_transport_backend(runtime_state_)` 取一次 snapshot 后注入配置阶段，create request parsing/config 阶段不再暴露完整 runtime 依赖。
- 当前补充：`PeerTransportCallbackContext` 已删除未使用的 `AgentRuntimeState*`，`peer_transport_callback_factory.*` 不再 include/前置声明完整 runtime；`create_transport_for_peer_session()` 已改为接收 `transport_ready` snapshot bool，不再为了 ready gate 暴露完整 `AgentRuntimeState&` 或 include `runtime_registry.h`。
- surface attach/update/detach 事件 payload 的 `transportReady` 字段已改为通过 `peer_transport_ready(runtime_state_)` 输出；surface controller 不再为了事件布尔值直接拼写 `runtime_state_.peer_transport_backend`。
- `agent_status_json.cpp` 的 `getStats.audioBackend` 聚合已改为用 `current_audio_session(state)` 构造 `HostAudioDispatchSession`；stats 输出层不再为了 audio stats 用完整 runtime 构造 host audio facade。
- host session started/stopped 事件 payload 的 `transportReady` 字段已进一步从 `peer_transport_ready(state)` facade 调用收口为 `HostSessionControllerCallbacks::transport_ready` provider 注入；host start/stop pipeline 不再为了事件布尔值直接读取 peer transport runtime。
- OBS ingest prepare/result 与 waiting/connected/running/ended 事件 payload 的 `transportReady` 字段已改为通过 `peer_transport_ready(state)` 输出；OBS ingest session 不再为了事件布尔值直接拼写 `state.peer_transport_backend`。
- 当前补充：`obs_ingest_session.cpp` 已移除 stale `agent_runtime.h` include；OBS ingest facade 所需状态改为显式 include `obs_ingest_session_state.h`，host/transport/codec 写回继续通过 `ObsIngestSessionRuntimeAccess` 与 `runtime_registry`/`host_session_runtime` facade 注入。
- `HostAudioDispatchSession::transport_ready()` 的兼容 fallback 已改为通过 `peer_transport_ready(*state_)` 读取；host audio facade 不再直接拼写 `state_->peer_transport_backend`。
- lifecycle audio status refresh 已改为显式绑定 `current_audio_session(state)` 构造 `HostAudioDispatchSession`；peer host source binding 中仅用于 register transport session 的路径也改为默认 host audio dispatch facade，不再为了全局 transport registry 注册传入完整 `AgentRuntimeState&`。
- 当前补充：`configure_host_audio_sender()` 已改为接收 `AudioSessionState` snapshot，不再为了 `audio_session_capture_ready()` 检查接收完整 `AgentRuntimeState&`；`attach_host_video_media_binding()` 和 `refresh_all_host_audio_senders()` 在各自 owner 边界读取一次 `audio_session_snapshot()` 后注入 host audio sender 配置。
- `HostAudioDispatchSession` 已删除完整 `AgentRuntimeState&` 构造入口和 `state_` fallback；公共头不再前置声明 `AgentRuntimeState`，audio facade 的 transport readiness 只能通过显式 provider 注入，host audio sender refresh 只能通过显式 `PeerSessionController` 注入。
- `runtime_registry` 已新增 `ffmpeg_probe_result()` / `wgc_capture_backend()` capability snapshot facade；初始化、capabilities JSON 和 host session capture/pipeline 路径不再直接拼写 `state.ffmpeg` / `state.wgc_capture_backend`。
- 当前补充：`agent_lifecycle.cpp` 与 `agent_rpc_router.cpp` 已移除 stale `agent_runtime.h` include；lifecycle/RPC loop 仍接收 `AgentRuntimeState&` 作为 registry/controller facade 入口，但实现文件不再依赖完整 runtime 头或字段布局，所需 FFmpeg probe 完整类型改为显式 include `ffmpeg_probe_state.h`。
- 当前补充：`agent_lifecycle.cpp` 新增 cpp 内部 `AgentLifecycleSessions`，在生命周期入口一次性绑定 host/audio/OBS active session、peer controller、surface controller 和 host audio dispatch owner；refresh/init/shutdown 不再各自散落 session lookup 与临时 controller 创建。`check-media-agent-boundary.js` 已新增门禁，要求 `agent_lifecycle.cpp` 只能在该绑定结构中出现三处 active-session 调用。
- 当前补充：`runtime_registry` 新增 `active_host_session()` / `active_audio_session()` / `active_obs_ingest_session()` facade；agent lifecycle、RPC loop、host session controller、host start/stop pipeline、peer refresh 和 OBS runtime access 的主业务路径已从 `current_*_session()` 迁到 `active_*_session()`。`runtime_registry` 公开 current-session facade 已删除；旧 `prepare_current_*` / `stop_current_*` 等兼容函数名仅保留在 `host_session_runtime.*`，内部也绑定 `active_*_session()`。`check-media-agent-boundary.js` 已禁止 runtime_registry 重新暴露 current-session facade。
- 当前补充：`HostSessionRegistry` / `AudioSessionRegistry` / `ObsIngestSessionRegistry` 已新增 registry 级 `active_session()`，内部状态成员从 `current_` 改为 map-backed active session；`current_session()` / `snapshot()` 兼容别名已删除。`runtime_registry` 的 active 与 snapshot facade 均直接调用 registry `active_session()`，门禁会阻止 current/snapshot alias 回退。
- 当前补充：Host/Audio/OBS registry 的 active session 存储已从单个 `active_` 成员推进为 `std::map<sessionId, State>`，默认 active id 仍为 `host-default` / `audio-default` / `obs-ingest-default`；当前行为保持单 active session，但内部形态已经能承接后续多 session 查找。media-agent unit tests 已新增 registry active/current/snapshot alias 断言，边界门禁禁止回退到单 `active_` state 成员。
- 当前补充：Host/Audio/OBS registry 已继续新增 `ensure_session(sessionId)`、`activate_session(sessionId)` 和 `session_count()`；unit tests 覆盖创建 secondary session、切换 active session、空 id 激活失败和状态保持。边界门禁要求三类 registry 都暴露这些多 session 基础 API。
- 当前补充：Host/Audio/OBS 的业务 session id 选择已接入首条真实路径。renderer `startHostSession()` / `startAudioSession()` 会补 `mediaSessionId`；agent RPC router 会从 `mediaSessionId` / `sessionId` 激活 Host/Audio/OBS 或 Audio active owner，并在对应 RPC 分支内按当前 active owner 创建 HostSessionController、ObsIngestSession 和 HostAudioDispatchSession，不再在 RPC loop 启动时永久绑定默认 session。runtime_registry 已暴露 `activate_host_session()` / `activate_audio_session()` / `activate_obs_ingest_session()` facade，unit tests 覆盖 runtime activate facade 与 session count。
- 当前补充：stop/prepare 请求的 session id 透传已补齐。renderer `stopHostSession()` / `stopAudioSession()` 会补 `mediaSessionId`；OBS prepare 请求通过 `__vdsEnsureCurrentHostMediaSessionId` / `__vdsGetCurrentHostMediaSessionId` hook 获取当前 media session id，并随 `refresh/port` 一起传给 mediaEngine。
- 当前补充：media-agent smoke 已覆盖 `mediaSessionId` owner 激活路径：`prepareObsIngest` 携带固定 smoke session id 后，再通过 `getStatus` / `getStats` 断言 Host/Audio/OBS 三类 active session id 均切换到该 id，且三类 session count 至少为 2。
- 当前补充：`runtime_registry` 已新增 `host_session_count()`、`audio_session_count()`、`obs_ingest_session_count()` facade；`getStatus` / `getStats` 现在输出 `hostSessionCount`、`audioSessionCount`、`obsIngestSessionCount`。media-agent smoke test 已断言三类 session count 字段存在且不小于 1。
- 本切片不改变 JSON-RPC method、request/response shape，也不改变 host audio start/stop 的内部实现，只减少 RPC 分发层对 session owner 的重复创建。
- 当前补充：`session_owner_activation.h/cpp` 已从 `agent_rpc_router.cpp` 拆出 Host/Audio/OBS owner 激活策略。RPC router 不再自己解析 `mediaSessionId/sessionId` 或决定三类 owner 激活组合，只调用 `activate_media_owner_sessions_from_request()` / `activate_audio_owner_session_from_request()` 后再进入对应 controller。
- 当前补充：`check-media-agent-boundary.js` 已新增门禁，除 `runtime_registry.*` 的 facade 声明/实现和 `session_owner_activation.cpp` 外，业务文件不得直接调用 `activate_host_session()` / `activate_audio_session()` / `activate_obs_ingest_session()`，防止 RPC/业务层重新绕过统一 owner activation facade。
- 当前补充：`agent_rpc_session_bindings.h/cpp` 已从 `agent_rpc_router.cpp` 拆出 active owner session 绑定细节。RPC router 不再直接调用 `active_obs_ingest_session()` / `active_host_session()` / `active_audio_session()` 或 `make_obs_ingest_runtime_access()`；OBS ingest 与 host audio 的 active owner 实例绑定统一通过 `bind_active_obs_ingest_session()` / `bind_active_host_audio_dispatch()` 完成。
- 当前补充：边界门禁已要求 `agent_rpc_router.cpp` 不得重新直接绑定 active owner session，避免 router 从纯 method 分发层退回 session lookup/绑定层。
- 当前补充：`make_obs_ingest_runtime_access(AgentRuntimeState&)` 隐式重载已删除，OBS ingest runtime access 只能通过 `make_obs_ingest_runtime_access(runtime_state, host_session)` 显式绑定 host owner。边界门禁会阻止 `obs_ingest_session.h` 重新暴露单参数隐式 overload。


```powershell
npm run check:architecture
npm run check:media-agent-boundary
npm run verify:media-agent
```
