# Media Agent 模块化路线

本文档定义 `media-agent` 向商业级可维护架构演进的边界、阶段和验收标准。当前目标不是一次性重写，而是在保持现有 native authority 行为稳定的前提下，逐步把 `src/main.cpp` 中的职责拆成可测试、可替换、可观测的模块。

## 收尾状态

- 收尾日期：2026-04-26
- 当前结论：本轮 `media-agent` 模块化已完成并通过自动化与人工端到端验收。
- 入口状态：`src/main.cpp` 已收敛为进程级入口，只负责 bootstrap、agent-ready、RPC loop 调用和 shutdown。
- 质量门禁：`npm run verify:media-agent` 与 `npm run e2e:media-agent` 已通过。
- 后续原则：新增媒体链路或重构线程/FFmpeg/Win32 资源前，必须同步扩展单元测试、smoke 或端到端验收清单。

## 目标

- 稳定性：模块拆分不得改变现有 host、viewer、relay、OBS ingest 主链路行为。
- 可维护性：单一源文件不再同时承担协议、运行时状态、采集、编解码、传输、预览和录制。
- 可测试性：纯逻辑模块可以脱离 native 设备和窗口环境做单元测试。
- 可观测性：模块边界保留统一错误码、状态快照和 breadcrumb。
- 可替换性：采集、编码、传输、渲染、ingest 后端可以通过清晰接口演进，而不是互相直接读写实现细节。

## 目标模块

### protocol

职责：

- JSON-RPC payload 构造
- JSON 字符串转义/反转义
- 请求字段提取
- 事件 payload 辅助构造

当前状态：

- 已新增 `src/json_protocol.h`
- 已新增 `src/json_protocol.cpp`
- `main.cpp` 与 `wasapi_backend.cpp` 已开始复用该模块
- 已新增 `src/agent_events.h`
- 已新增 `src/agent_events.cpp`
- `emit_event` 与 `write_json_line` 已从 `main.cpp` 外移，统一事件输出锁
- `append_nullable_int64` 已进入 `json_protocol`，供状态 JSON 模块复用
- 基础转义和字段提取已进入 `media-agent/tests/media_agent_unit_tests.cpp`

### agent_status_json

职责：

- agent ready/status/capabilities/stats JSON
- peer state/result JSON
- host session result JSON

当前状态：

- 已新增 `src/agent_status_json.h`
- 已新增 `src/agent_status_json.cpp`
- agent capabilities/status/ready/stats、peer state/result、host session JSON 已从 `main.cpp` 外移

### agent_lifecycle

职责：

- status/capabilities/stats 前的运行时刷新
- host capture runtime refresh
- host session callback 组装
- agent shutdown 清理顺序
- WASAPI callback 绑定

当前状态：

- 已新增 `src/agent_lifecycle.h`
- 已新增 `src/agent_lifecycle.cpp`
- getStatus/getCapabilities/getStats 的 refresh 包装已从 `main.cpp` 外移
- agent bootstrap 初始化、FFmpeg/WGC/WASAPI probe、host pipeline/plan 初始化已从 `main.cpp` 外移
- host capture runtime refresh、surface attachment restart helper、shutdown cleanup 已从 `main.cpp` 外移
- WASAPI callback 绑定已移入 `media_audio`
- `main.cpp` 只保留进程级 bootstrap、agent-ready 和 shutdown

### agent_rpc_router

职责：

- JSON-RPC stdin loop
- 方法路由
- result/error 统一写回
- host session callback 接线

当前状态：

- 已新增 `src/agent_rpc_router.h`
- 已新增 `src/agent_rpc_router.cpp`
- JSON-RPC 方法分发与统一 result/error 写回已从 `main.cpp` 外移

### runtime

职责：

- `AgentRuntimeState`
- `PeerState`
- host / viewer / relay / OBS 运行时状态结构
- 生命周期状态转换

拆分原则：

- 先搬结构体声明和纯状态刷新函数
- 不在第一阶段移动线程入口和 FFmpeg / Win32 调用
- 状态写入必须集中持有锁，避免拆分后扩大竞态面

实际文件：

- `agent_runtime.h`

当前状态：

- 已新增 `src/agent_runtime.h`
- `AgentRuntimeState`、`PeerState`、host/viewer/relay/OBS 主要运行时状态已从 `main.cpp` 外移
- host audio dispatch 状态已随 `media_audio` 外移

### host_pipeline

职责：

- FFmpeg host capture command 构造
- encoder probe / encoder selection
- host audio sender 配置

实际文件：

- `host_pipeline.h`
- `host_pipeline.cpp`
- `ffmpeg_probe.h`
- `ffmpeg_probe.cpp`
- `host_capture_plan.h`
- `host_capture_plan.cpp`
- `host_capture_process.h`
- `host_capture_process.cpp`

当前状态：

- 已新增 `src/ffmpeg_probe.h`
- 已新增 `src/ffmpeg_probe.cpp`
- FFmpeg 二进制发现、能力探测、编码器自检、探测 JSON、编码器偏好辅助函数已从 `main.cpp` 外移
- 已新增 `src/host_pipeline.h`
- 已新增 `src/host_pipeline.cpp`
- host FFmpeg capture command、peer video sender command、编码器后端识别、preset/tune 归一化、pipeline selection/validation 已从 `main.cpp` 外移
- 已新增 `src/host_capture_plan.h`
- 已新增 `src/host_capture_plan.cpp`
- WGC display/window 输入尺寸解析、WGC frame source config、native host capture plan 生成与 capture plan validation 已从 `main.cpp` 外移
- 已新增 `src/host_capture_process.h`
- 已新增 `src/host_capture_process.cpp`
- host capture process 状态初始化、artifact 路径初始化、artifact ffprobe、manifest 写入、process JSON、process refresh/stop/start 已从 `main.cpp` 外移
- 已新增 `src/host_state_json.h`
- 已新增 `src/host_state_json.cpp`
- host pipeline、WGC capture probe、host capture plan、host capture artifact 的纯状态 JSON 已从 `main.cpp` 外移
- 已新增 `src/host_session_controller.h`
- 已新增 `src/host_session_controller.cpp`
- start/stop host session 编排、OBS ingest host session 分支、host-downstream peer attach/detach 遍历已从 `main.cpp` 外移
- host session 的 RPC 路由已移入 `agent_rpc_router`

### viewer_pipeline

职责：

- viewer video surface attach/update/detach
- viewer audio playback queue
- remote video/audio frame consume
- decoder runtime state

实际文件：

- `viewer_pipeline.h`
- `viewer_pipeline.cpp`
- `viewer_audio_playback.h`
- `viewer_audio_playback.cpp`

当前状态：

- 已新增 `src/viewer_audio_playback.h`
- 已新增 `src/viewer_audio_playback.cpp`
- viewer audio playback queue、waveOut worker、passthrough buffering 已从 `main.cpp` 外移
- viewer audio playback 状态 JSON 已从 `main.cpp` 外移到 viewer audio 模块
- remote audio frame consume、relay audio fanout、viewer PCM decode/playback dispatch 已从 `main.cpp` 外移到 viewer audio 模块
- set/get viewer volume、viewer playback mode、viewer audio delay RPC 控制面已从 `main.cpp` 外移到 viewer audio 模块
- 已新增 `src/viewer_video_pipeline.h`
- 已新增 `src/viewer_video_pipeline.cpp`
- remote video frame consume、Annex-B decode unit scheduling、random access bootstrap、relay video fanout、native surface submit/recovery 已从 `main.cpp` 外移
- 已新增 `src/surface_target.h`
- 已新增 `src/surface_target.cpp`
- host capture surface / peer video surface / peer media source 的目标识别与 peer id 提取已从 `main.cpp` 外移
- 已新增 `src/surface_attachment_runtime.h`
- 已新增 `src/surface_attachment_runtime.cpp`
- host capture surface attachment、peer video surface attachment、surface layout update、surface attachment JSON 已从 `main.cpp` 外移
- 已新增 `src/surface_control_runtime.h`
- 已新增 `src/surface_control_runtime.cpp`
- attachSurface、updateSurface、detachSurface RPC 编排已从 `main.cpp` 外移
- 已新增 `src/peer_receiver_runtime.h`
- 已新增 `src/peer_receiver_runtime.cpp`
- peer video receiver close-begin、句柄关闭后的状态复位、surface snapshot 同步、decoder transport 状态回写、receiver runtime JSON 已从 `main.cpp` 外移
- viewer remote audio/video consume 已完成第一轮模块化

### peer_video_sender

职责：

- peer video sender runtime handle 管理
- media binding sender 状态刷新
- sender stop / cleanup
- 后续承接 sender source readback 与 FFmpeg pump

当前状态：

- 已新增 `src/peer_video_sender.h`
- 已新增 `src/peer_video_sender.cpp`
- peer video sender handle close、media binding refresh、sender stop/cleanup 已从 `main.cpp` 外移
- peer video sender start、FFmpeg process launch、WGC source readback thread、FFmpeg stdout pump 已从 `main.cpp` 外移
- sender runtime 只保留 sender 生命周期和状态同步，不再承接 peer media binding 编排

### peer_media_binding_runtime

职责：

- host video media binding attach/refresh/detach
- OBS ingest media binding attach
- relay media binding attach
- host audio sender configure/clear/refresh
- peer transport runtime snapshot refresh
- transport close 前的 media binding cleanup

当前状态：

- 已新增 `src/peer_media_binding_runtime.h`
- 已新增 `src/peer_media_binding_runtime.cpp`
- host/OBS/relay media binding attach、detach、transport close prepare、host audio sender refresh、peer transport runtime refresh 已从 `main.cpp` 外移
- attach/detachPeerMediaSource RPC 分支的请求解析、错误返回、协商触发和 peer-state event 已从 `main.cpp` 外移

### peer_control_runtime

职责：

- peer create / close 编排
- remote description / ICE candidate 控制面处理
- peer transport callbacks 绑定
- peer close 时 surface、receiver、relay、viewer audio 清理

当前状态：

- 已新增 `src/peer_control_runtime.h`
- 已新增 `src/peer_control_runtime.cpp`
- createPeer、closePeer、setRemoteDescription、addRemoteIceCandidate 编排已从 `main.cpp` 外移
- peer 控制面的 RPC 路由已移入 `agent_rpc_router`

### media_audio

职责：

- host audio dispatch session registry
- WASAPI PCM -> Opus sender pipeline
- viewer remote audio decode helper
- PCMU decode

当前状态：

- 已新增 `src/media_audio.h`
- 已新增 `src/media_audio.cpp`
- host audio dispatch、Opus encode/send、PCMU decode、AAC/Opus viewer decode 已从 `main.cpp` 外移
- audio session 状态映射与 JSON 序列化已从 `main.cpp` 外移
- start/stop audio session RPC 控制面、media-state/warning 事件和 host audio sender refresh 已从 `main.cpp` 外移
- 已删除未使用的 host PCMU encode 旧路径

### relay

职责：

- relay subscriber registry
- upstream bootstrap cache
- video/audio fanout
- dispatch worker

实际文件：

- `relay_dispatch.h`
- `relay_dispatch.cpp`

当前状态：

- 已新增 `src/relay_dispatch.h`
- 已新增 `src/relay_dispatch.cpp`
- relay subscriber registry、upstream bootstrap cache、video/audio fanout、dispatch worker 已从 `main.cpp` 外移
- relay subscriber runtime JSON 已从 `main.cpp` 外移
- viewer/host/OBS 调用 relay 的入口已在各自 runtime 模块中收敛

### obs_ingest

职责：

- OBS ingest port validation
- SRT listener URL
- ingest worker
- AAC ADTS framing
- OBS media state payload

实际文件：

- `obs_ingest_state.h`
- `obs_ingest_state.cpp`
- `obs_ingest_media.h`
- `obs_ingest_media.cpp`
- `obs_ingest_runtime.h`
- `obs_ingest_runtime.cpp`

当前状态：

- 已新增 `src/obs_ingest_state.h`
- 已新增 `src/obs_ingest_state.cpp`
- OBS ingest 状态 JSON 已从 `main.cpp` 外移
- OBS ingest 端口范围、默认端口解析、SRT publish/listen URL 构造已从 `main.cpp` 外移
- 已新增 `src/obs_ingest_media.h`
- 已新增 `src/obs_ingest_media.cpp`
- AAC config 解析、ADTS framing、packet timestamp helper 已从 `main.cpp` 外移
- 已新增 `src/obs_ingest_runtime.h`
- 已新增 `src/obs_ingest_runtime.cpp`
- OBS ingest prepare/clear/stop、loopback UDP port validation、FFmpeg demux worker、relay fanout 入口已从 `main.cpp` 外移
- prepareObsIngest RPC 控制面已从 `main.cpp` 外移
- OBS host backend 的会话编排已移入 `host_session_controller`
- OBS peer media binding 分支已移入 `peer_media_binding_runtime`

### platform

职责：

- Win32 handle / window title / process handle helpers
- path probing
- command execution
- time helpers

实际文件：

- `platform_utils.h`
- `platform_utils.cpp`
- `process_runner.h`
- `process_runner.cpp`
- `time_utils.h`

当前状态：

- 已新增 `src/platform_utils.h`
- 已新增 `src/platform_utils.cpp`
- Win32 UTF-8/UTF-16 转换、Windows error formatting、窗口标题解析、gdigrab hwnd 目标和命令行 path quoting 已从 `main.cpp` 外移
- 已新增 `src/process_runner.h`
- 已新增 `src/process_runner.cpp`
- 子进程命令输出捕获和命令解析失败判断已从 `main.cpp` 外移

### string_utils

职责：

- ASCII lower-case copy
- line splitting

当前状态：

- 已新增 `src/string_utils.h`
- 已新增 `src/string_utils.cpp`
- `to_lower_copy` 与 `split_lines` 已从 `main.cpp` 外移

### native_surface_layout

职责：

- embedded surface layout 结构
- layout JSON parse / serialize

当前状态：

- 已新增 `src/native_surface_layout.cpp`
- `build_surface_layout_from_json` 与 `surface_layout_json` 已从 `main.cpp` 外移

### peer_state_json

职责：

- peer media binding / peer result / peer state JSON
- 后续承接 peer state event payload

当前状态：

- 已新增 `src/peer_state_json.h`
- 已新增 `src/peer_state_json.cpp`
- peer media binding JSON 已从 `main.cpp` 外移

## 执行阶段

### Phase 1：低风险纯逻辑拆分

验收：

- `main.cpp` 不再包含 JSON 协议基础工具
- WASAPI 不再维护重复 JSON 转义
- `npm run build:media-agent` 通过

当前状态：

- 已完成。
- 已额外完成 `time_utils`，收敛 `main.cpp`、`peer_transport.cpp`、native preview/surface 中重复的时间函数。
- 已额外完成 `video_access_unit`，收敛 H.264/H.265 Annex-B access unit 解析，并删除未使用的 H.265 AUD 查找旧函数。

### Phase 2：状态结构外移

验收：

- `AgentRuntimeState`、`PeerState` 及主要子状态进入独立头文件
- `main.cpp` 通过独立头文件访问状态结构
- 不改变现有 JSON-RPC 方法和 payload

当前状态：

- 已完成主要结构外移。
- `main.cpp` 已收敛为进程级入口，不再持有业务状态操作函数。

### Phase 3：host / viewer / relay 拆分

验收：

- host capture、viewer playback、relay fanout 各自有独立源文件
- 每个模块只暴露最小必要入口
- cross-module 调用必须经过 runtime/protocol/transport 明确接口

当前状态：

- relay fanout 已完成第一轮模块化。
- viewer audio playback 已完成第一轮模块化。
- media audio 已完成第一轮模块化。
- viewer audio 控制面已完成第一轮模块化。
- audio session 控制面已完成第一轮模块化。
- FFmpeg probe / encoder self-test 已完成第一轮模块化。
- host pipeline selection / command builder 已完成第一轮模块化。
- host capture plan / validation / WGC dimension resolver 已完成第一轮模块化。
- host capture process / artifact manifest / artifact probe 已完成第一轮模块化。
- host 纯状态 JSON 已完成第一轮模块化。
- agent status/capabilities/stats 汇总 JSON 已完成第一轮模块化。
- agent lifecycle / bootstrap / status refresh / shutdown cleanup 已完成第一轮模块化。
- peer transport backend/snapshot JSON 已移入 transport 模块。
- peer media binding JSON 已完成第一轮模块化。
- peer media binding runtime 和 attach/detachPeerMediaSource 控制面已完成第一轮模块化。
- peer create/close/signaling 控制面已完成第一轮模块化。
- OBS ingest 状态 JSON 已完成第一轮模块化。
- OBS ingest media/runtime worker 和 prepare 控制面已完成第一轮模块化。
- viewer remote video/audio consume 已完成第一轮模块化。
- surface target helper、surface attachment runtime、peer receiver runtime helper、peer video sender stop/refresh helper 已完成第一轮模块化。
- surface attach/update/detach 控制面已完成第一轮模块化。
- peer video sender start/source/pump 已完成第一轮模块化。
- host session start/stop orchestration 已完成第一轮模块化。
- platform/process 工具已完成第一轮模块化。
- `main.cpp` 只保留 agent bootstrap、agent-ready 事件输出、RPC loop 调用和 shutdown。
- JSON-RPC 方法路由、统一 result/error 写回 helper 已移入 `agent_rpc_router`。

### Phase 4：测试和质量门禁

验收：

- protocol、encoder selection、OBS port validation、Annex-B access unit 解析有单元测试
- 构建脚本支持 CI 中单独构建 `media-agent`
- 保留端到端手测脚本：dual native、triple native、OBS ingest

当前状态：

- 已新增 `media-agent/tests/media_agent_unit_tests.cpp`
- 已新增 CMake 测试目标 `vds-media-agent-tests`
- 已新增 `scripts/test-media-agent.ps1`
- 已新增 `scripts/smoke-media-agent.ps1`
- 已新增 `scripts/verify-media-agent.ps1`
- 已新增 `scripts/manual-media-agent-e2e.ps1`
- 已新增 npm 脚本 `test:media-agent`
- 已新增 npm 脚本 `smoke:media-agent`
- 已新增 npm 脚本 `verify:media-agent`，串联 build、CTest 单测和 agent smoke
- 已新增 npm 脚本 `e2e:media-agent`，先跑自动门禁，再打印人工端到端验收步骤
- 已覆盖 `json_protocol` 基础转义/字段提取
- 已覆盖 OBS ingest 端口解析与 SRT URL 构造
- 已覆盖 host pipeline encoder selection、encoder backend/preset/tune 归一化
- 已覆盖 `surface_target` 目标识别与 peer id 提取
- 已覆盖 H.264/H.265 Annex-B access unit 基础解析、decoder config/random access/bootstrap 判断
- `ctest --test-dir media-agent/build -C Release --output-on-failure` 已通过
- `npm run test:media-agent` 已通过
- `npm run smoke:media-agent` 已通过，覆盖 agent 进程启动、agent-ready、ping/getCapabilities/getStatus/getStats、prepareObsIngest 基础 JSON-RPC，以及 BAD_REQUEST/NOT_IMPLEMENTED 错误路径
- `npm run verify:media-agent` 已通过，用作当前模块化质量门禁
- `npm run e2e:media-agent` 已通过自动门禁并输出端到端手测清单
- dual native、triple native 与 OBS ingest 端到端验证已通过

端到端手测结果：

- 验证日期：2026-04-26
- dual native：已通过。覆盖 host native capture、viewer native surface、音频播放、peer close/reconnect。
- triple native：已通过。覆盖 host -> relay -> viewer 级联转发、relay fanout、上游断开后的状态恢复。
- OBS ingest：已通过。覆盖 OBS SRT 推流地址准备、prepare/start/stop ingest、音视频 fanout、下游 peer attach/detach。
- 验收口径：已观察 agent JSON-RPC 响应、前端状态、native surface 画面和退出清理，不只以窗口启动成功作为通过标准。

### Phase 4 结论

- 当前模块化质量门禁已具备：构建、单元测试、进程级 smoke、人工端到端清单。
- 当前 media-agent 模块化工作已达到可收尾状态。
- 后续新增媒体链路或重构线程/FFmpeg/Win32 资源时，必须先扩展对应单元测试或 smoke，再更新端到端验收清单。

## 约束

- 不做大爆炸式重写。
- 每次拆分必须能独立构建通过。
- 优先拆纯逻辑，再拆线程和系统资源。
- 不把商业级理解成“更多抽象层”；只有能降低维护风险、测试成本或替换成本的边界才保留。
