# Renderer Split Map

更新时间：2026-06-24

当前门禁补充：`scripts/check-room-client-dispatcher.js` 已禁止 `app-native-overrides.js` 直接调用 `roomClient.registerMessageHandler(...)`；native message handler 只能由 `native-room-message-controller.js` / `native-peer-message-controller.js` 注册。

当前门禁补充：`scripts/check-renderer-bridge.js` 已禁止 disconnected recovery timer 动作回流到 `app-native-overrides.js`，并禁止 `native-peer-controller.js` public API 暴露 `armPeerDisconnectTimer` / `prepareDisconnectedRecovery` / `prepareDisconnectedRecoveryRetry`。

当前拆分补充：`native/native-stats-controller.js` 已接入，承接 host/viewer stats polling、FPS DOM 指示、host encoder detail、OBS/minimized 状态刷新和 viewer media-ready 后的 viewer-ready 发送副作用；`app-native-overrides.js` 仅保留同名兼容 wrapper 和依赖注入。

当前拆分补充：`native/native-peer-message-controller.js` 已承接 `answer` / `ice-candidate` 的主体逻辑，包括 answer signal 日志、remote answer finalize、queued ICE flush UI/log、ICE finalize 和 P2P state effect 消费；`app-native-overrides.js::handleAnswer()` / `handleIceCandidate()` 仅保留 legacy global wrapper。

当前拆分补充：`native/native-peer-message-controller.js` 已承接 `offer` 的主体逻辑，包括 upstream offer wait timer 清理、viewer upstream switch 状态写入、remote offer decision、flush queued ICE、recreate peer、viewer surface attach、flush+answer 和 stale upstream cleanup 调度；`app-native-overrides.js::handleOffer()` 仅保留 legacy global wrapper。

当前拆分补充：`native/native-peer-message-controller.js` 已承接 offer 后的 stale viewer upstream peer cleanup，直接调用 `nativePeerController.scheduleStalePeerCleanup()` 并通过注入的 `closePeerConnection()` 关闭旧上游；`app-native-overrides.js` 不再注入或定义 `closeStaleViewerUpstreamPeers()`。

当前拆分补充：`native/native-peer-controller.js` 已承接 peer-state event 与 effects 的串联入口，新增 `handlePeerStateEvent(params)` 统一执行 `applyPeerStateEvent()` 和 `applyPeerStateEffects()`；`app-native-overrides.js::handleNativePeerStateEvent()` 仅保留 media-engine 事件转交。

当前拆分补充：`native/native-peer-controller.js` 已承接 mediaEngine `signal` 事件的完整处理入口，新增 `handleLocalSignalEventAndSend(params, options)` 统一执行 signal state/backlog、candidate payload 决策、relay candidate block 日志、本地 candidate 统计和最终信令发送；`app-native-overrides.js::forwardNativeMediaSignal()` 仅保留 media-engine signal 事件转交。

当前拆分补充：`native/native-peer-controller.js` 已承接 peer close cleanup effects 的消费入口，新增 `applyPeerCloseCleanupEffects(peerId, cleanupDecision)` 统一执行 handle 删除、renderer peer/meta 外部删除回调、pending/signal/timer/reconnect 清理、viewer wait timer 清理和诊断刷新；`app-native-overrides.js` 不再保留本地 cleanup effects 解释器。

当前拆分补充：`native/native-peer-controller.js` 已承接 peer recovery request 的动作入口，新增 `requestPeerRecovery(peerId, reason, options)` 统一执行 recovery decision、`peer:recovery-requested` 日志、host force offer 和 viewer `viewer-reconnect-ready` 发送；`app-native-overrides.js::requestPeerRecovery()` 仅保留 attempt/source 兼容委托。

当前拆分补充：connect failfast 定时器到点后的 ready 判断、失败原因分类和 `finalizeP2pFailureWithNatMapping(..., 'connect-failfast')` 触发已由 `native-peer-controller.js::armPeerConnectFailfast()` 默认路径持有；`app-native-overrides.js` 不再保留 `armPeerConnectFailfast()` helper。

当前拆分补充：NAT mapping 后等待直连仍失败的默认动作已由 `native-peer-controller.js::armPeerNatMappingWait()` 持有，包括 ready 判断、P2P failed UI 状态、viewer 失败文案和关闭 peer；`app-native-overrides.js` 不再传入 NAT mapping wait timeout callback。

完成度审计入口：`docs/ARCHITECTURE_SPLIT_COMPLETION_AUDIT.md`。该文档按 R0-R7 逐项记录当前证据、完成状态、剩余动作和未完成 E2E 场景；当前 Renderer split 仍为 Partial，不应仅因模块文件存在或门禁通过就判断完成。

当前补充：`room-client.js` 已新增 `buildCreateRoomMessage()` / `createRoom()`，host create-room 的发送 facade 和 native stop-share 的 leave-room 发送 callback 已改为通过 `VDS.roomClient`；消息分发、房间 UI 生命周期和 create-room ACK 处理仍暂留 legacy 路径。

当前补充：`room-client.js` 已新增 `registerMessageHandler()` / `unregisterMessageHandler()` / `dispatchMessage()`，WebSocket `onmessage` 现在先进入 `dispatchMessage(data)`，无注册 handler 时再 fallback 到 legacy `handleMessage` adapter；新增 `scripts/check-room-client-dispatcher.js` / `npm run check:room-client-dispatcher` 并接入 `check:architecture` 和 release check。

当前补充：`viewer-count-updated` 已从 `app-native-overrides.js` 继续迁入 `native/native-room-message-controller.js`，由 controller 注册 `handleViewerCountUpdatedMessage`，legacy switch 和 override 本地 handler 均不得回流；`check-room-client-dispatcher.js` 已校验该消息必须由 room message controller 注册。

当前补充：`viewer-left` 已从 `app-native-overrides.js` 继续迁入 `native/native-room-message-controller.js`，保持原顺序先更新人数/app state，再关闭离开 viewer peer；legacy switch、override 本地 handler 和 override 直接注册均不得回流。

当前补充：`host-disconnected` 已从 `app-native-overrides.js` 继续迁入 `native/native-room-message-controller.js`，保持原顺序弹出断开提示、清理 viewer upstream offer wait timer、再 reset viewer state；legacy switch、override 本地 handler 和 override 直接注册均不得回流。

当前补充：`error` 已从 `app-native-overrides.js` 继续迁入 `native/native-room-message-controller.js`，保持原顺序先释放 OBS 建房 pending，再让 `window.__vdsHandleViewerJoinError(data)` 尝试接管，未处理时继续 `showError(data.message)`；legacy switch、override 本地 handler 和 override 直接注册均不得回流。

当前补充：`room-joined` 已从 `app-native-overrides.js` 继续迁入 `native/native-room-message-controller.js`，保持原顺序清理 relay retry、记忆 manifest、清空旧 peer、同步 viewer room/app state、启动 upstream offer wait timer 和切换 viewer UI；legacy switch、override 本地 handler 和 override 直接注册均不得回流。

当前补充：`room-created` 已从 `app-native-overrides.js` 继续迁入 `native/native-room-message-controller.js`，保持原顺序释放 OBS pending、校验 host media session ACK、处理 stale ACK 退房、OBS 等待退房、host room/app state、自动复制房间号、host P2P 状态和 stats polling；legacy switch、override 本地 handler 和 override 直接注册均不得回流。

当前补充：`session-resumed` 已从 `app-native-overrides.js` 继续迁入 `native/native-room-message-controller.js`，保持原顺序先同步基础 session state/manifest，再按 host/viewer 两条恢复路径处理 OBS 状态、host UI/stats polling、viewer peer 清理、upstream offer wait timer 和恢复文案；legacy switch、override 本地 handler 和 override 直接注册均不得回流。

当前补充：`viewer-joined` 已从 `app-native-overrides.js` 继续迁入 `native/native-peer-message-controller.js`，保持原顺序记忆 manifest、校验 native host session、非 reconnect 更新人数/app state、调用 `createOffer()` 并吞掉 stale peer error；legacy switch、override 本地 handler 和 override 直接注册均不得回流。

当前补充：`connect-to-next` 已从 `app-native-overrides.js` 继续迁入 `native/native-peer-message-controller.js`，保持原顺序记忆 manifest、调用 `createOfferToNextViewer()`，失败时记录 recoverable warning、关闭目标 peer 并 `scheduleRelayOfferRetry()`；legacy switch、override 本地 handler 和 override 直接注册均不得回流。

当前补充：`viewer-joined`、`connect-to-next`、`chain-reconnect`、`answer`、`ice-candidate`、`offer` 已从 `app-native-overrides.js` 继续迁入 `native/native-peer-message-controller.js`；peer message controller 现在承接 host viewer offer、relay next offer、链路重选、answer/ICE/offer 六个 peer signaling dispatcher body。viewer joined/relay connect 保持原 offer 创建和 retry 行为，chain reconnect 保持原链位/上游切换和 `viewer-reconnect-ready` payload，answer/ICE/offer 已由 peer message controller 执行主体逻辑，offer 保持 stale native peer error 吞吐和 `signal:offer:stale-ignored` 日志；legacy switch、override 本地 handler 和 override 直接注册均不得回流。

当前补充：十三个 native message handler body 已全部迁出 `app-native-overrides.js`：房间/viewer/session 类由 `native/native-room-message-controller.js` 持有，peer signaling/recovery 类由 `native/native-peer-message-controller.js` 持有；`app-native-overrides.js` 仍负责装配依赖和 legacy globals。

当前补充：`room-client.dispatchMessage()` 已持有 unknown-message fallback，未注册消息会走 `handleUnhandledMessage(data)`，可选通知 legacy adapter 的 `onUnhandledMessage`，否则按连接日志记录未知消息；不再调用 app/native 的 legacy `handleMessage` adapter。`app-native-overrides.js` 的 `handleMessage()` 已收薄为兼容 hook，不再包含 `switch (data.type)`。

当前补充：`native/native-room-message-controller.js` 的 `room-created` stale ACK 退房和 OBS 等待推流退房已改为调用 `roomClient.leaveRoom()`，不再手拼 `{ type: 'leave-room' }`，`app-native-overrides.js` 也不再向 room message controller 注入通用 `sendMessage`；`check-room-client-dispatcher.js` 已新增门禁防止该 wire payload 重新散落。

当前补充：`room-client.js` 已新增 `buildViewerReconnectReadyMessage()` / `sendViewerReconnectReady()`，上游 offer timeout、chain reconnect 和 peer recovery 的 `viewer-reconnect-ready` 控制信令均改为通过该 facade 发送；`native-peer-message-controller.js` 不再接收通用 `sendMessage` 注入，`check-room-client-dispatcher.js` 已禁止 native override / peer message controller 手拼该 wire payload。

当前补充：`room-client.js` 已新增 `buildViewerReadyMessage()` / `sendViewerReady()`，viewer 媒体 ready 后的 `viewer-ready` 控制信令已从 `native-stats-controller.js` 手拼 payload 改为通过 roomClient facade 发送；`app-native-overrides.js` 不再向 nativeStats 注入通用 `sendMessage`，dispatcher 门禁已覆盖该回退。

当前补充：`native/native-peer-controller.js` 的信令发送不再接收 legacy generic `sendMessage` fallback；`app-native-overrides.js` 只向 peer controller 注入 `roomClient`，`sendSignalMessage()` 只通过 `roomClient.sendSignal()` / `roomClient.sendMessage()` 发送 offer/answer/ICE，dispatcher 门禁禁止 generic sendMessage 注入回流。

当前补充：`native/native-session-controller.js` 不再手拼 `{ type: 'create-room' }`；`buildHostCreateRoomMessage()` 已改为 `buildHostCreateRoomOptions()`，只向 `roomClient.createRoom()` 提供 options，create-room wire payload 只由 `room-client.js::buildCreateRoomMessage()` 构造。`check-room-client-dispatcher.js` 已新增门禁禁止 native session controller 回退到手拼 create-room payload。

## 当前入口加载顺序

`server/public/index.html` 仍使用传统 `<script>` 顺序加载，不使用 bundler，不使用 `type="module"`。

当前第一阶段入口为：

```html
<script src="app-state.js"></script>
<script src="debug-panel.js"></script>
<script src="quality-settings.js"></script>
<script src="source-selection.js"></script>
<script src="room-client.js"></script>
<script src="update-ui.js"></script>
<script src="app.js"></script>
<script src="native/native-diagnostics.js"></script>
<script src="native/native-stats-controller.js"></script>
<script src="native/native-media-engine-controller.js"></script>
<script src="native/p2p-state-machine.js"></script>
<script src="native/native-surface-controller.js"></script>
<script src="native/native-peer-controller.js"></script>
<script src="native/native-peer-message-controller.js"></script>
<script src="native/native-session-controller.js"></script>
<script src="native/native-room-message-controller.js"></script>
<script src="native/native-viewer-controls.js"></script>
<script src="native/native-viewer-fullscreen-controls.js"></script>
<script src="native/native-entry.js"></script>
<script src="app-native-overrides.js"></script>
```

`app-state.js` 创建 `window.VDS.state`，当前由 `app.js` 通过 `window.__vdsPatchAppState` / `window.__vdsSyncAppState` 镜像旧局部状态，旧局部变量仍是权威来源。`room-client.js` 已持有 WebSocket 对象、connect/disconnect/reconnect、outbound pending message queue、`sendMessage/enqueue/flush/remove`、队列清理、`waitForWsConnected` 超时等待，并已承接 viewer `join-room` / `leave-room` payload 构造和发送 facade；create-room wire payload 也只由 room-client 构造，native session controller 只传 create-room options；native room-created 的 stale ACK/OBS wait 退房已通过 `roomClient.leaveRoom()` 发送，`viewer-reconnect-ready` 和 `viewer-ready` 也已通过 roomClient facade 发送；offer/answer/ICE 发送也已由 native peer controller 通过注入的 roomClient 完成，不再接收 generic sendMessage fallback；房间 UI 生命周期和部分 create-room 状态编排仍暂留旧路径。`debug-panel.js` 已承接 debug preset/config 归一化、菜单渲染/绑定、日志开关判断和 native 日志 hook 读取；`app.js` 只保留旧函数名 wrapper 与受控 console sink，旧 debug 常量/helper/菜单 DOM 生成逻辑已删除。`update-ui.js` 已承接更新检查、更新日志、下载/安装弹窗状态和 updater listener。`quality-settings.js` 已承接质量设置默认值、OBS ingest prefs、配置归一化、能力探测、OBS preview prepare 状态、质量弹窗 render/bind。`source-selection.js` 已承接源枚举、源列表刷新、源选择弹窗、缩略图列表、窗口音频进程匹配和确认源后启动共享的桥接流程。`native/native-diagnostics.js` 已作为 R3 模块接入，承接 native 日志 gate、rate limit、payload 摘要、recoverable warning helper、P2P 诊断报告格式化、host capture 诊断报告格式化、latest P2P stats snapshot 缓存、latest host capture diagnostic report 缓存、mediaEngine event summary logging、mediaEngine warning event logging、mediaEngine audio-data no-op 消费、mediaEngine event/status listener binding 和 event 诊断预处理；`native/native-media-engine-controller.js` 已接入，承接 mediaEngine start in-flight 去重、started 状态、capabilities 日志触发和 mediaEngine event 业务路由；`app-native-overrides.js` 通过 bridge 创建 diagnostics/media-engine controller，Electron native 路径缺模块会 fail-fast，诊断报告、快照缓存、mediaEngine 诊断预处理、mediaEngine 事件绑定、mediaEngine event router 和 mediaEngine start lifecycle wrapper 直接委托模块对象。`native/p2p-state-machine.js` 已承接 P2P UI label、状态 DOM 写入、peer meta `p2pUiState` 写入、失败原因分类、viewer media wait timer 和 upstream offer wait timer；`native/native-surface-controller.js` 已作为 R4 模块接入，承接 surface element 描述、layout 构建、layout key、embedded surface registry、surface generation、sync failure count、attach/detach command flow、host preview/peer viewer surface lifecycle、单 surface update command flow、sync all 批量同步循环、单次 sync RAF 调度、滚轮驱动 sync burst、surface tracking loop、window bounds surface sync 调度、强制 resync burst 和 surface layout 事件绑定；`native/native-peer-controller.js` 已作为 R5 模块接入，承接 peer meta、peer handle registry、signal queue、candidate backlog、attempt、peer ready/stale、media source attach、NAT/failfast/recovery、remote offer/answer/ice 和 stale cleanup 决策；`native/native-room-message-controller.js` 已作为 R2/R7 房间消息 controller 接入，承接 viewer-count/viewer-left/host-disconnected/error/room-joined/room-created/session-resumed 七个 handler body；`native/native-peer-message-controller.js` 已作为 R5/R7 信令消息 controller 接入，承接 viewer-joined/connect-to-next/chain-reconnect/answer/ice-candidate/offer 六个 peer signaling dispatcher body，以及 relay offer retry 的 failfast、耗尽、定时重试和清理策略；`app-native-overrides.js` 不再保留 peer controller 可选降级分支。

## 当前大文件职责

R5 当前补充边界：`native/native-peer-controller.js` 现在还承接 native peer state event 写入、native peer signal state update、media offer signal 判定/等待、offer/answer signal prepare、offer/answer send message builder 与发送 facade、remote description RPC wrapper、remote offer/answer intake decision、remote ICE RPC wrapper、remote ICE candidate backlog、native peer attempt id 生成、remote ICE intake decision、remote ICE candidate key/duplicate registry、local ICE candidate counters/types/NAT mapping candidate cache、peer attempt helpers 和 edge snapshot、close peer mediaEngine RPC/handle registry 删除、peer connect/disconnect timer 的 arm/clear ownership、disconnected recovery attempt/delay preparation、peer recovery decision snapshot/viewer reconnect payload、peer-state event+effects 串联入口，以及 relay offer retry timer 存储；`createPeerHandleRegistry()` 已承接 peer handle registry / attempt id 生成，`createSignalRegistry()` 已承接 signal backlog/waiter registry，`app-native-overrides.js` 不再直接持有 `nativePeerHandles`、`nativePeerAttemptSeq`、`nativePeerSignalBacklog` 或 `nativePeerSignalWaiters`，缺 native-peer-controller / registry 时直接 fail-fast；relay offer retry 策略和 stale upstream cleanup 已迁入 `native-peer-message-controller.js`；candidate relay 过滤、剩余 recovery 等信令动作执行、关闭时机、NAT mapping/failfast 策略回调、disconnected recovery 动作执行回调和 surface 外层清理仍暂留 `app-native-overrides.js`；answer/ICE/offer message 主体已迁入 `native-peer-message-controller.js`。

R6 当前边界：`native/native-session-controller.js` 已接入，承接 host/audio session 的 start/stop mediaEngine RPC wrapper、stop host+audio 组合命令、host start result validation、mediaSessionId 生成/重置、host media manifest 构建、native capture host room create facade、host create-room payload 构造与发送 facade、OBS host room create/teardown、host start begin effects、native host start codec effects、host-session-started/stopped 与 OBS media-state effects、media-state update effects、host start generation/in-flight 控制、failed host start 清理顺序、host start success effects、stop share 资源清理前段（stats stop、preview detach、peer close、host/audio stop）、stop 后段状态/UI reset callback 编排和 host stop-share 控件绑定；native capture start 与 OBS ingest start 的 begin/ensure/start/validate/preview retry/create-room 高层流程已迁入 `runNativeCaptureHostStart()` / `runObsIngestHostStart()`，stop share 的 begin/cleanup/finalize/finish 高层流程已迁入 `runStopShare()`；`app-native-overrides.js` 的 `startScreenShareWithSource()`、`startScreenShareWithObsIngest()` 和 `stopScreenShare()` 只保留 legacy global 委托；`currentHostBackend`、`hostPreviewRequested`、`obsRoomCreatePending` 和 `obsIngestStreamActive` 已由 `native-session-controller.js` 的 `createSessionState()` facade 承接，legacy 只通过 getter/setter 读写；房间 create/leave 的底层发送实现仍通过注入回调完成。

R6 当前补充边界：`native-session-controller.js::createSessionState()` 已持有 native backend、host preview requested、OBS room pending 和 OBS stream active 的默认值；`app-native-overrides.js` 正常路径不再传入重复默认对象，缺 `native-session-controller.js` / session state factory 时直接 fail-fast，不再保留等价本地默认状态。

R7 当前起步边界：`native/native-entry.js` 已接入脚本顺序，暴露 `VDS.nativeEntry.installLegacyOverrides()`、`markLegacyOverridesInstalled()`、`setRuntimeFlags()`、`isNativePeerDriverActive()`、`registerLegacyGlobals()` 和 `getState()`；`app-native-overrides.js` 已从自执行 IIFE 改为 legacy installer 函数，并由 native-entry 调用。旧业务逻辑仍留在 `app-native-overrides.js`，本阶段已迁 install guard/装配入口、native peer driver active flag owner 和 legacy global hook 注册桥；`native-entry.installLegacyOverrides()` 现在负责 install guard 写入、installer 调用和返回 hook map 注册，`app-native-overrides.js` 底部已删除缺 native-entry 时的 standalone auto-install 降级路径。

R7 当前补充边界：`native/native-viewer-controls.js` 已接入，承接 viewer 音量 UI 状态、延迟 `setViewerVolume`、静音切换、音量输入处理、音量刷新和 fullscreen 音量拖动状态；`native/native-viewer-fullscreen-controls.js` 已接入，承接 viewer fullscreen underbar 显隐、音量 popover hide timer、fullscreen controls hide timer、光标轮询、fullscreen transition promise、Esc/exit/toggle 状态和 viewer fullscreen/volume 控件事件绑定；`app-native-overrides.js` 只保留元素查询和错误日志回调。

### `server/public/app.js`

现状职责混合：

- DOM 初始化、按钮状态、弹窗渲染。
- debug 面板旧入口 wrapper；debug preset/config、菜单 render/bind 和日志开关判断已迁到 `debug-panel.js`。
- 质量弹窗确认开播和复制 OBS URL 跨模块流程仍暂留；质量设置默认值、OBS ingest prefs、配置归一化、能力探测、OBS preview prepare 状态、质量弹窗 render/bind 已迁到 `quality-settings.js`。
- 源选择旧入口 wrapper；源枚举、源列表刷新、源选择弹窗、音频进程匹配和确认源桥接已迁到 `source-selection.js`。
- 消息分发、房间 UI 生命周期和房间 create 暂留；WebSocket 对象、connect/disconnect/reconnect、outbound pending message queue、wait facade 以及 viewer join/leave payload facade 已迁到 `room-client.js`；native remote ICE candidate backlog 已迁到 `native/native-peer-controller.js`，`app.js` 仅保留 legacy 兼容 map 和 clear hook。
  - 当前补充：`app.js::createPeerConnection()` legacy wrapper 已补齐第四个 `options` 参数透传，native override 创建 peer 时不再丢失 `mediaManifest` / `encodedMediaDataChannel` 等配置。
- update 检查旧入口 wrapper；更新检查、下载、安装、日志弹窗状态已迁到 `update-ui.js`。
- 诊断按钮 glue 和 clipboard glue。
- legacy `startScreenShare*`、`stopScreenShare` 入口。

### `server/public/app-native-overrides.js`

现状职责混合：

- native authority install guard。
- native host start/stop、OBS ingest start/stop。
- native peer create/offer/answer/ice/DataChannel 编排。
- embedded host preview 和 peer surface attach/update/detach。
- fullscreen surface z-order 和窗口 layout sync。
- P2P UI state、failfast、reconnect/recovery 状态。
- P2P/capture diagnostics 报告和日志节流。
- 覆盖旧全局函数，让 `app.js` 走 native 实现。

## `app.js` 提供给 native override 的主要全局依赖

这些依赖在拆分前必须保持兼容，后续通过 `window.VDS` 或 controller dependency 注入替换。

| 名称 | 当前用途 | 后续归属 |
| --- | --- | --- |
| `sessionRole` | 判断 host/viewer 流程和诊断输出 | `VDS.state.role` |
| `currentRoomId` | 信令、诊断、房间生命周期 | `VDS.state.roomId` |
| `currentClientId` | 信令 peer id、诊断 | `VDS.state.clientId` |
| `qualitySettings` | native host session 参数、OBS 参数 | `VDS.qualitySettings` |
| `sendMessage(data, options)` | 发送信令和房间控制消息 | `VDS.roomClient.sendMessage` |
| `showError(message)` | native failfast/user-visible error | `app.js` legacy wrapper -> UI module |
| `startScreenShareWithSource(source)` | legacy start 入口，被 native 覆盖 | `VDS.nativeSession.startWithSource` |
| `startScreenShareWithObsIngest(options)` | legacy OBS start 入口，被 native 覆盖 | `VDS.nativeSession.startWithObsIngest` |
| `stopScreenShare()` | legacy stop 入口，被 native 覆盖 | `VDS.nativeSession.stop` |
| `getNativeAuthorityOverride(name, currentImpl)` | native override 安装查询 | `native-entry.js` compatibility glue |
| `requireNativeAuthorityOverride(name, currentImpl)` | 强制 native override | `native-entry.js` compatibility glue |
| `window.__vdsResetShareStartPendingUi()` | native 建房 ACK/失败后释放按钮 | `VDS.nativeSession` -> UI callback |
| `window.__vdsRefreshQualitySettingsUi()` | native capability 更新后刷新质量 UI | `VDS.qualitySettings.render` |
| `window.__vdsIsDebugModeEnabled()` | native 日志开关读取 | `VDS.debugPanel` |
| `window.__vdsShouldDebugLog(category, channel)` | native 分类日志开关读取 | `VDS.debugPanel` |

## native override 写回给 `app.js` 的 hook

这些 hook 当前是 `app.js` 调用 native 功能的兼容面，拆分时需要逐步移动到 `native/native-entry.js`。

| hook | 当前用途 | 后续归属 |
| --- | --- | --- |
| `window.__vdsNativeAuthorityOverridesInstalled` | install guard，避免重复覆盖 | `native/native-entry.js` |
| `window.isNativePeerDriverActive` | 判断 native peer driver 是否接管 | `native/native-entry.js` |
| `window.isNativePeerHandle` | 判断 peer handle 是否 native | `native/native-peer-controller.js` |
| `window.startScreenShareWithSource` | 覆盖 app.js 同名入口 | `native/native-session-controller.js` |
| `window.startScreenShareWithObsIngest` | 覆盖 OBS start 入口 | `native/native-session-controller.js` |
| `window.startScreenShareWithAudio` | 覆盖带音频 start 入口 | `native/native-session-controller.js` |
| `window.stopScreenShare` | 覆盖 stop 入口 | `native/native-session-controller.js` |
| `window.createPeerConnection` | 覆盖 peer 创建入口 | `native/native-peer-controller.js` |
| `window.createOffer` | host -> viewer offer | `native/native-peer-controller.js` |
| `window.createOfferToNextViewer` | relay 上游 -> 下游 offer | `native/native-peer-controller.js` |
| `window.handleOffer` | viewer 收 offer | `native/native-peer-message-controller.js` + `native/native-peer-controller.js` |
| `window.handleAnswer` | host/upstream 收 answer | `native/native-peer-message-controller.js` + `native/native-peer-controller.js` |
| `window.handleIceCandidate` | ICE 分发 | `native/native-peer-message-controller.js` + `native/native-peer-controller.js` |
| `window.closePeerConnection` | 关闭单 peer | `native/native-peer-controller.js` |
| `window.clearAllPeerConnections` | 关闭全部 peer | `native/native-peer-controller.js` |
| `window.handleMessage` | 覆盖主消息分发，接入 native | `room-client.js` + native controllers |
| `window.setViewerConnectionState` | viewer 状态 UI | `native/p2p-state-machine.js` |
| `window.__vdsBuildP2pDiagnosticReport` | 复制 P2P 诊断 | `native/native-diagnostics.js` |
| `window.__vdsRenderP2pDiagnosticReport` | 渲染 P2P 诊断 | `native/native-diagnostics.js` |
| `window.__vdsBuildHostCaptureDiagnosticReport` | 复制 host capture 诊断 | `native/native-diagnostics.js` |
| `window.__vdsRenderHostCaptureDiagnosticReport` | 渲染 host capture 诊断 | `native/native-diagnostics.js` |

## 目标模块边界

第一阶段保持旧行为，后续按下面边界迁移：

| 文件 | owner | 迁移原则 |
| --- | --- | --- |
| `app-state.js` | app 运行状态、订阅、generation | 只保存状态和 selectors，不操作 DOM/信令/native |
| `debug-panel.js` | debug config、日志分类开关、诊断按钮 glue | 不读写 peer/session 内部状态 |
| `quality-settings.js` | 质量弹窗和参数归一化 | 输出纯配置，不启动 session |
| `source-selection.js` | 源枚举和源选择弹窗 | 只返回用户选择，不创建房间 |
| `room-client.js` | WebSocket、信令队列、房间控制消息 facade | 不操作 native surface，不直接渲染媒体状态 |
| `update-ui.js` | 更新检查 UI | 与房间/媒体隔离 |
| `native/native-diagnostics.js` | native diagnostics 和日志节流 | 只读快照，不写业务状态 |
| `native/native-stats-controller.js` | native host/viewer stats polling、FPS DOM 和 media-ready 副作用 | 不处理信令 offer/answer/ice，不创建 peer |
| `native/native-media-engine-controller.js` | mediaEngine start lifecycle / event router | 启动去重、started 状态、capabilities 日志触发和 mediaEngine event 业务路由 |
| `native/p2p-state-machine.js` | P2P UI state/failfast/recovery | 不发信令，不操作 DOM 细节 |
| `native/native-surface-controller.js` | surface attach/update/detach/layout sync | 不创建 peer，不改 manifest |
| `native/native-peer-controller.js` | peer lifecycle 和信令编排 | 通过 `roomClient` 发信令，通过 surface/p2p controller 更新外部效果 |
| `native/native-session-controller.js` | host native/OBS start-stop lifecycle | manifest 唯一写入口，stop share 唯一清理入口 |
| `native/native-viewer-controls.js` | viewer 音量控件状态 | 音量 UI、延迟应用、静音切换和刷新入口 |
| `native/native-viewer-fullscreen-controls.js` | viewer fullscreen 控件状态 | underbar/popup 显隐、鼠标轮询、fullscreen toggle/exit/Esc 状态和控件事件绑定 |
| `native/native-entry.js` | install guard 和 legacy bridge | 只做装配，不承载业务逻辑 |

## 兼容策略

1. 新文件都使用 IIFE 和 `window.VDS` 命名空间。
2. 不新增散落全局函数；必须兼容旧调用时，只在 `app.js` 或 `native-entry.js` 桥接。
3. `app.js -> app-native-overrides.js` 的加载顺序暂时保留，先在其前面加入 `app-state.js`。
4. 每次只移动一个 owner 边界，不同时改信令协议、JSON RPC wire shape 和 UI 行为。
5. 所有迁移中间态必须可启动、可语法检查、可通过 logging policy。

## 第一阶段完成状态

- 已新增 `server/public/app-state.js`。
- 已新增 `server/public/room-client.js`，并已由 `app.js` 安装底层 adapter；当前 `room-client.js` 持有 WebSocket 对象、connect/disconnect/reconnect、outbound pending message queue、`sendMessage/enqueue/flush/remove/clear`、`waitForWsConnected`，以及 viewer join/leave 的 payload builder 和发送 facade。消息分发、房间 UI 生命周期、create-room 和 native override host 路径仍暂时委托旧函数。
- 已新增并接入 `server/public/debug-panel.js`，debug preset/config、菜单 render/bind、日志开关判断和 native debug hook 读取已由 `VDS.debugPanel.createController()` 接管；`app.js` 仅保留 `syncDebugUi/setDebugConfig/debugLog/openDebugMenu/closeDebugMenu/toggleDebugMenu/renderDebugMenu/bindDebugMenuUi` 等兼容 wrapper 和受控 `logSink`。
- 已新增并接入 `server/public/update-ui.js`，更新检查、更新日志、下载/安装弹窗状态已迁出 `app.js`；`app.js` 只保留 `registerUpdateStatusListener/registerUpdateLogListener/initializeStartupTasks/getUpdateManifestUrl/hideUpdateModal/renderUpdateModal/applyUpdateStatus/requestQuitAndInstall/initVersion/checkForUpdates` wrapper。
- 已新增并接入 `server/public/quality-settings.js`，质量设置默认值、OBS ingest prefs、配置归一化、能力探测、OBS preview prepare 状态和质量弹窗 render/bind 已从 `app.js` 迁出到 `VDS.qualitySettings.createController()`；`app.js` 保留复制 OBS URL 和确认后启动共享流程。
- 已新增 `server/public/source-selection.js`，通过 `VDS.sourceSelection.createController()` 持有源枚举/刷新状态、源选择弹窗 DOM、缩略图列表、窗口音频进程匹配、确认源后调用 start-share callback；`app.js` 只保留 `showSourceSelection/refreshSources/showSourceModal/confirmSourceAndShare/cancelSourceSelection/updateSourceAudioUi` wrapper。
- 已新增并接入 `server/public/native/native-diagnostics.js`，通过 `VDS.nativeDiagnostics.create()` 承接 native debug gate、日志节流、payload 摘要、日志分类、recoverable native warning、P2P 诊断报告格式化、host capture 诊断报告格式化以及 host/viewer/relay stats summary 与 periodic log fields 构造；`app-native-overrides.js` 同名日志函数继续作为兼容 wrapper，P2P 与 host capture 报告 builder 现在只收集/传递快照并委托 diagnostics 对象，host/viewer stats polling 只保留 `getStats()`、DOM/UI 状态副作用和 viewer-ready 副作用；非 Electron/Web 路径在创建 diagnostics 前早返回，Electron native 路径缺 `native-diagnostics.js` 时直接 fail-fast。
  - 当前补充：低频 debug gate / rate limit / debug log / stats line direct wrapper 已删除；`app-native-overrides.js` 中对应调用点直接使用 `nativeDiagnostics.shouldShowDebugLogsFor()`、`shouldEmitNativeDebugLog()`、`logNativeDebug()` 和 `logNativeStatsLine()`。
  - 当前补充：latest P2P stats snapshot 与 latest host capture diagnostic report 的 getter/setter direct wrapper 已删除；manifest 构建、诊断报告渲染和 stats polling 调用点直接使用 `nativeDiagnostics.getLatestP2pStatsSnapshot()` / `setLatestP2pStatsSnapshot()` / `getLatestHostCaptureDiagnosticReport()` / `setLatestHostCaptureDiagnosticReport()`。
  - 当前补充：`logNativeMediaCapabilities()`、`buildHostCaptureDiagnosticReportFromStats()` 和 `buildHostCaptureDiagnosticReport()` helper 已删除；mediaEngine capabilities logging、host capture report build 和 legacy host capture report hook 直接使用 `nativeDiagnostics`。
  - 当前补充：`logNativeStep()` 与 `getNativeDebugCategoryFromScope()` direct wrapper 已删除；surface、NAT/failfast/recovery、offer/answer/ICE、room lifecycle 和初始化配置日志调用点直接使用 `nativeDiagnostics.logNativeStep()`。
  - 当前补充：`logRecoverableNativeWarning()` direct wrapper 已删除；peer recovery、host/viewer stats、audio start、relay retry 和 viewer fullscreen/mute 错误日志调用点直接使用 `nativeDiagnostics.logRecoverableNativeWarning()`。
  - 当前补充：native stats polling 默认 interval 与 host/viewer polling timer registry 已由 `native-diagnostics.js` 持有；`app-native-overrides.js` 不再持有 `nativeStatsPollingIntervalMs`、`nativeHostStatsIntervalId` 或 `nativeViewerStatsIntervalId`，host/viewer stats polling 通过 diagnostics facade 启停。
  - 当前补充：host/viewer periodic stats 的 peer/surface/frame 摘要和 host/viewer/relay 日志字段构造已迁入 `native-diagnostics.js::buildHostStatsSummary()` / `buildViewerStatsSummary()`；`app-native-overrides.js` 只消费 summary 做 FPS DOM、OBS/minimized UI、诊断渲染、viewer ready 和连接状态副作用。
  - 当前补充：host/viewer FPS 采样状态已迁入 `native-diagnostics.js::resetHostFpsSample()` / `updateHostFpsSample()` / `resetViewerFpsSample()` / `updateViewerFpsSample()`；`app-native-overrides.js` 只保留 DOM 写入 wrapper，不再持有帧计数采样变量。
  - 当前补充：缺 `native-diagnostics.js` 的 fallback bridge 已删除；Electron native 路径统一通过 `native-entry.js::createRequired()` 创建 diagnostics，缺模块时抛出 `native-diagnostics-unavailable`，正常路径唯一 diagnostics snapshot/cache/polling owner 是 `native-diagnostics.js`。
- `native/native-media-engine-controller.js` 的 start lifecycle 已进一步收口；`ensureMediaEngineStarted()` direct wrapper 已删除，native/OBS host start、preview retry 和 native UI 初始化直接调用 `nativeMediaEngineController.ensureStarted()`。
- 已新增并接入 `server/public/native/p2p-state-machine.js`，通过 `VDS.p2pStateMachine.create()` 承接 P2P UI label、状态 DOM 写入、peer meta 状态写入、失败原因分类、viewer media wait timer、viewer upstream offer wait timer 和 upstream offer timeout 后的 reconnect-once 状态；`app-native-overrides.js` 只保留旧函数名 wrapper 和状态/信令回调注入。
  - 当前补充：`app-native-overrides.js` 已通过 `native-entry.js::createRequired()` 创建 P2P state machine；Electron native 路径缺 `native/p2p-state-machine.js` 时抛出 `p2p-state-machine-unavailable`。P2P 状态文案、失败分类、viewer media wait、viewer upstream offer wait、reconnect-once guard 的 legacy fallback 已删除，同名 wrapper 直接委托 `p2p-state-machine.js`。
  - 当前补充：viewer media wait / upstream offer wait 的剩余裸调用点已改为直接调用 `p2pStateMachine`，`app-native-overrides.js` 不再通过旧 wrapper 间接清理或 arm 这些 timer。
  - 当前补充：P2P UI state/status direct wrapper 已删除；peer failure/recovery、remote ICE effects、viewer connected UI 和 host waiting-viewer UI 调用点直接使用 `p2pStateMachine.setP2pStateForPeer()` / `setStatusElementState()`。
  - 当前补充：单点 `withP2pTimeout()` helper 已删除；NAT mapping 超时逻辑内联在 `attemptLastChanceNatMapping()`，保持 6000ms 和 `nat-mapping-timeout` 错误文案不变。
- 已新增并接入 `server/public/native/native-surface-controller.js`，通过 `VDS.nativeSurface.createController()` 承接 surface element 描述、surface layout 构建、layout key、embedded surface registry、surface generation、sync failure count、attach/detach command flow、host preview/peer viewer surface lifecycle、单 surface update command flow、sync all 批量同步循环、单次 sync RAF 调度、滚轮驱动 sync burst、surface tracking loop、window bounds surface sync 调度、强制 resync burst 和 surface layout 事件绑定；`createSurfaceRegistry()` 已承接正常 controller 路径的 surface entry/generation/failure count registry，`app-native-overrides.js` 不再直接持有 `attachedEmbeddedSurfaces` / `embeddedSurfaceGenerations` / `surfaceSyncFailureCounts` map；窗口 bounds 获取/保存仍由 legacy 注入 getter/setter 回调，具体绑定和 resync 调度由 controller 执行。
  - 当前补充：surface sync recoverable warning 节流状态已迁入 `native-surface-controller.js`，`app-native-overrides.js` 同名函数仅作为 legacy wrapper，正常路径委托 controller。
  - 当前补充：surface tracking 移除流程已通过 `nativeSurfaceController.removeSurfaceTracking()` 闭环到 controller 内部，legacy wrapper 不再手写 generation/delete/clear/stop 顺序。
  - 当前补充：`removeEmbeddedSurfaceTracking()` 与 `forceEmbeddedSurfaceResync()` direct wrapper 已删除；viewer fullscreen resync 和 session cleanup 注入直接调用 `nativeSurfaceController.forceResync()` / `removeSurfaceTracking()`。
  - 当前补充：surface 连续 sync 失败后的 recover/reattach 流程已迁入 `nativeSurfaceController.recoverSurface()`，controller 不再回调 legacy 文件执行恢复。
  - 当前补充：surface sync 最大失败次数、滚轮同步 burst 帧数和 tracking interval 默认值已由 `native-surface-controller.js` 正常路径持有；`app-native-overrides.js` 不再向 controller 传入重复默认配置，缺 controller 时不再启动 legacy surface sync/tracking fallback loop。
  - 当前补充：legacy `embeddedSurfaceRegistry` bridge 已删除；`app-native-overrides.js` 不再创建 surface registry facade，surface entry/generation/failure count 只由 `native-surface-controller.js` 内部 registry 持有，legacy 同名 wrapper 直接委托 `nativeSurfaceController`。
  - 当前补充：`nativeSurfaceController` 本体创建已收为 `native-entry.js::createRequired()`，缺 `native-surface-controller.js` 时抛出 `native-surface-controller-unavailable`；legacy surface RAF/timer fallback 仍保持不可达 no-op 历史分支。
  - 当前补充：surface recoverable warning、clear warning、tracking remove、recover/reattach 和 surface element describe 的 legacy fallback 实现已删除；`app-native-overrides.js` 同名 wrapper 只直接委托 `native-surface-controller.js`。
  - 当前补充：surface layout/key/update/attach/detach 的 legacy 本地实现已删除；`buildSurfaceLayout/getSurfaceLayoutKey/syncEmbeddedSurface/attachEmbeddedSurface/detachEmbeddedSurface` 空 wrapper 也已删除，`app-native-overrides.js` 仅保留仍有调用点的 host preview、peer surface detach 和强制 resync wrapper 并直接委托 `native-surface-controller.js`。
  - 当前补充：surface layout 事件绑定已迁入 `native-surface-controller.js::bindLayoutEvents()`；`onWindowBoundsChange`、`onMaximizedChange`、`ResizeObserver`、window resize/scroll/wheel 和 `visualViewport` resize/scroll 不再由 `app-native-overrides.js` 手写绑定。
  - 当前补充：初始化时的 `electronApi.getWindowBounds()` 也已迁入 `native-surface-controller.js::bindLayoutEvents()`，legacy 仅通过 `setCurrentWindowBounds()` 注入写回当前窗口 bounds。
  - 当前补充：无调用的 surface registry、surface recovery、host start cancel/create room、native audio start/stop、peer signal queue/media-offer、peer handle/set/entries、peer media source 和 answer creation legacy wrapper 已删除，避免 controller ownership 旁边残留假入口。
- 已新增并接入 `server/public/native/native-peer-controller.js`，通过 `VDS.nativePeer.createController()` 承接 peer meta 默认结构创建、`ensurePeerMeta`、native peer handle registry facade、native peer signal backlog/waiter queue、native peer state event 写入、native peer signal state update、media offer signal 判定/等待、offer/answer signal prepare、offer/answer send message builder、native peer handle 构造/attempt 序列、peer ready/stale 等待、peer media source attach、remote description RPC wrapper、remote offer/answer intake decision、remote ICE RPC wrapper、remote ICE candidate backlog、remote ICE intake decision、remote ICE candidate key/duplicate registry、local ICE candidate counters/types/NAT mapping candidate cache、peer attempt helpers/edge snapshot、close peer mediaEngine RPC/handle registry 删除、peer connect/disconnect timer arm/clear、disconnected recovery attempt/delay preparation、peer recovery decision snapshot/viewer reconnect payload 和 relay offer retry timer 存储；`native-peer-message-controller.js` 已承接 relay offer retry 的 failfast、耗尽、定时重试、清理策略和 stale upstream cleanup；candidate relay 过滤、P2P UI 状态写回以及 createPeer 后续 UI/failfast/NAT mapping/disconnected recovery 动作执行/offer/answer 后续执行/close 高层流程仍暂留 `app-native-overrides.js`。
  - 当前补充：信令 `attemptId` 解析已迁入 `native-peer-controller.js`，`app-native-overrides.js` 的 `getSignalAttemptId()` 仅作为 legacy wrapper 优先委托 controller，缺模块时保留原解析逻辑。
  - 当前补充：信令 SDP 描述归一化和 remote description 相等判断已迁入 `native-peer-controller.js`，legacy wrapper 直接委托 controller，模块缺失时由 bridge fail-fast。
  - 当前补充：remote ICE candidate 去重 key 构造已由 `native-peer-controller.js` 统一提供，legacy helper 直接委托 controller。
  - 当前补充：ICE candidate 文本提取、pure P2P relay-candidate 过滤和 stale native peer error 分类已迁入 `native-peer-controller.js`，legacy 同名 helper 只做代理委托。
  - 当前补充：native 本地 candidate signal payload 构造、attemptId 附加和 relay candidate block 决策已由 `native-peer-controller.js::prepareLocalIceCandidateSignal()` 接管；legacy 只保留 blocked 日志、本地候选统计和 `sendMessage`。
  - 当前补充：mediaEngine `signal` 事件的 peer id 解析、local description 状态更新、signal backlog 入队、local ICE candidate payload 决策、blocked relay 日志、本地 candidate 统计和最终 signal message 发送已由 `native-peer-controller.js::handleLocalSignalEventAndSend()` 串联；legacy signal 分支只保留一行事件转交。
  - 当前补充：native 本地 candidate signal 发送 facade 现在复用 `native-peer-controller.js::sendSignalMessage()`；blocked 日志和本地候选统计也已进入 `handleLocalSignalEventAndSend()`，模块缺失时由 bridge fail-fast。
  - 当前补充：native signal peer id 解析已由 `native-peer-controller.js::getSignalPeerId()` 持有，并在 `handleLocalSignalEvent()` 内部使用；legacy 已删除 `getNativeSignalPeerId()` wrapper。
  - 当前补充：remote ICE candidate 的 queue/apply/duplicate/block 执行路径已迁入 `native-peer-controller.js::handleRemoteIceCandidate()` / `applyRemoteIceCandidate()`；当前正常路径进一步通过 `finalizeRemoteIceCandidate()` 返回 log/UI effects，legacy `handleIceCandidate()` 只消费 effects。
  - 当前补充：queued remote ICE candidate 的取出、逐条 apply 以及 flush result 的 blocked 日志/P2P UI effects 消费已迁入 `native-peer-controller.js`；legacy override 已删除本地 `flushQueuedRemoteCandidates()` / effects 解释器，`native-peer-message-controller.js` 只保留轻量委托。
  - 当前补充：remote answer 的 ignore/flush/apply decision 和 remote description apply 已迁入 `native-peer-controller.js::handleRemoteAnswer()` / `applyRemoteDescription()`；`native-peer-message-controller.js::handleAnswerMessage()` 现在承接 signal 日志、remote answer finalize、ignore 日志和 queued candidate flush；legacy `handleAnswer()` 只保留全局兼容委托。
  - 当前补充：remote answer apply 后的 queued ICE flush 已迁入 `native-peer-controller.js::finalizeRemoteAnswer()`，`native-peer-message-controller.js::handleAnswerMessage()` 正常路径消费 ignore 日志和 flush result 的 UI/log；legacy `handleAnswer()` 不再持有该主体逻辑。
  - 当前补充：remote offer 的 ignore/flush/reuse/recreate decision 和 reuse remote description apply 已迁入 `native-peer-controller.js::handleRemoteOffer()`；`native-peer-message-controller.js::handleOfferMessage()` 现在承接 signal 日志、viewer 状态写入和 controller facade 串联。
  - 当前补充：remote offer recreate 分支是否需要关闭旧 peer 已由 controller 的 `shouldCloseExisting` 决定；`native-peer-message-controller.js::handleOfferMessage()` 只通过注入的 `recreatePeerForRemoteOffer()` 执行关闭和创建动作，不再由 legacy offer handler 自行编排。
  - 当前补充：remote offer apply 后的 queued ICE flush + answer 发送组合已迁入 `native-peer-controller.js::flushQueuedAndCreateAnswer()`；`native-peer-message-controller.js::handleOfferMessage()` 在 surface attach 后调用组合 facade 并消费 flush 结果写 UI/log。
  - 当前补充：answer signal 等待与 answer message 构造已由 `native-peer-controller.js::prepareAnswerMessage()` 串起，legacy `createAndSendPeerAnswer()` 只负责发送 message 和返回 SDP。
  - 当前补充：answer message 发送已迁入 `native-peer-controller.js::createAndSendAnswer()`，controller 通过注入的 `sendMessage`/roomClient facade 发信令，legacy 仅保留兼容入口。
  - 当前补充：offer message 构造和发送 facade 已迁入 `native-peer-controller.js::prepareOfferMessage()` / `sendSignalMessage()`，legacy `createAndSendPeerOffer()` 只保留 P2P UI 状态切换和兼容入口。
  - 当前补充：offer 发送前的 P2P UI 状态切换也已迁入 `native-peer-controller.js::createAndSendOffer()`，legacy `createAndSendPeerOffer()` 不再直接写 `gathering/restart-attempting`。
  - 当前补充：viewer 切换上游后的 stale peer id 选择和延迟清理调度已迁入 `native-peer-controller.js::scheduleStalePeerCleanup()`，legacy 只提供 active upstream 判断和具体 close 回调。
  - 当前补充：批量关闭 peer 时的 peer id 选择、循环编排和默认单 peer close 动作已迁入 `native-peer-controller.js::closeAllPeers()`；legacy `clearNativePeerConnectionsImpl()` 不再注入 close 回调。
  - 当前补充：单 peer close finally 中是否清 viewer upstream wait timer/reconnect retry 的决策已迁入 `native-peer-controller.js::preparePeerCloseCleanup()`，legacy 只执行具体 timer/reconnect/diagnostic 回调。
  - 当前补充：单 peer close finally 中 handle/map/meta 删除、pending remote candidate、signal state 和 connect/disconnect timer 清理 flags 也已纳入 `preparePeerCloseCleanup()`，legacy 只按 flags 执行原回调。
  - 当前补充：`clearNativePendingRemoteCandidates()` direct wrapper 已删除；peer close cleanup effects 和 fallback cleanup 直接调用 `nativePeerController.clearPendingRemoteCandidates()`。
  - 当前补充：无调用的 `getPeerEdgeState()` direct wrapper 已删除；edge snapshot 只保留在 `native-peer-controller.js` owner 内。
  - 当前补充：peer close cleanup effects 的消费入口已迁入 `native-peer-controller.js::applyPeerCloseCleanupEffects()`，`closeNativePeerConnectionImpl()` finally 直接调用 controller，legacy 不再解释 cleanup effects。
  - 当前补充：`preparePeerCloseCleanup()` 现在同时输出按顺序排列的 cleanup `effects`，`native-peer-controller.js::applyPeerCloseCleanupEffects()` 正常路径直接消费 effects；renderer map/meta 删除、viewer wait timer 和诊断刷新通过注入回调执行。
  - 当前补充：peer close lifecycle 已收口为 `native-peer-controller.js::closePeerConnection()` 高层入口，内部完成 handle 校验、cleanup decision、peer video surface detach、mediaEngine close 和 cleanup effects；legacy `closeNativePeerConnectionImpl()` 只委托 controller。
  - 当前补充：viewer 收到 offer 时的上游切换纯决策已迁入 `native-peer-controller.js::prepareViewerUpstreamSwitch()`，legacy 只执行 `upstreamPeerId` 写入、viewer 状态重置、timer 清理和 UI 文案回调。
  - 当前补充：remote offer 对应的 `edgeAttemptId` 写入已迁入 `native-peer-controller.js::applyRemoteOfferAttempt()`，legacy `handleOffer()` 正常路径不再直接写 peer meta attempt 字段。
  - 当前补充：recreate peer 后的 remote offer attempt 写入 + remote description apply 已迁入 `native-peer-controller.js::applyRecreatedRemoteOffer()`，legacy 不再保留兼容两步降级路径。
  - 当前补充：remote offer recreate 分支里的关闭旧 peer + 创建 upstream peer 顺序已迁入 `native-peer-controller.js::recreatePeerForRemoteOffer()` 编排，默认使用 controller 内部 `closePeerConnection()` / `createPeerConnection()`；legacy 不再注入具体 close/create 回调。
  - 当前补充：viewer remote offer 后的 peer video surface attach 已迁入 `native-peer-controller.js::attachViewerRemoteOfferSurface()` 作为 peer-to-surface facade，controller 通过注入的 `native-surface-controller` 执行实际 attach，legacy 不再保留 surface attach 降级路径。
  - 当前补充：create peer 后的 `attemptId` / `edgeAttemptId` meta 初始化已迁入 `native-peer-controller.js` 私有路径；legacy 不再直接调用 meta 初始化 helper。
  - 当前补充：peer create lifecycle 已收口为 `native-peer-controller.js::createPeerConnection()` 高层入口，内部完成 signal clear、handle create、legacy map 同步、meta 初始化、P2P gathering 和 failfast arm；legacy `createNativePeerConnectionImpl()` 只补充当前 manifest 默认值并委托 controller。
  - 当前补充：connect failfast timer 的 meta/timer guard、超时 ready 判断、失败分类和 NAT fallback finalize 触发已由 `native-peer-controller.js::armPeerConnectFailfast()` 默认路径承接；legacy 只在 create peer 后调用 controller arm 方法。
  - 当前补充：connect failfast 15000ms 默认值已由 `native-peer-controller.js` 正常路径持有；`app-native-overrides.js` 正常路径不再向 `armPeerConnectFailfast()` 传入重复 timeout，`app.js` 不再暴露 native P2P failfast 常量。
  - 当前补充：NAT mapping 后等待直连成功的 connect timer 和等待失败后的 P2P failed UI、viewer 失败文案、关闭 peer 动作已由 `native-peer-controller.js::armPeerNatMappingWait()` 默认路径承接；legacy 只在成功发送映射候选后 arm wait。
  - 当前补充：P2P failfast/ICE failed 进入 NAT fallback 前的 peer/meta/handle 可 finalize 判断已迁入 `native-peer-controller.js::prepareP2pFailureFinalization()`；legacy `finalizeP2pFailureWithNatMapping()` 只消费准备结果并执行 NAT mapping fallback、UI/log 和 close 动作。
  - 当前补充：P2P failure + NAT fallback + final apply 已收口为 `native-peer-controller.js::finalizeP2pFailureWithNatMapping()` 唯一公共入口；connect failfast 默认路径和 peer-state `finalizeP2pFailure` effect 均在 controller 内部调用该入口，legacy 只传递当前 `roomId`。
  - 当前补充：native peer-state `failed` 后触发 failure finalize 的 reason/source 已由 `native-peer-controller.js::applyPeerStateEvent()` 通过 `failureFinalization` 返回，legacy 只消费 payload 调用 `finalizeP2pFailureWithNatMapping()`。
  - 当前补充：native peer-state 事件的 UI/timer/recovery/failure 外部动作已由 `native-peer-controller.js::applyPeerStateEvent()` 同步输出标准 `effects`，并由 `native-peer-controller.js::handlePeerStateEvent()` 串联 `applyPeerStateEvent()` / `applyPeerStateEffects()` 统一消费；`app-native-overrides.js::handleNativePeerStateEvent()` 只保留一行事件转交。
  - 当前补充：disconnected recovery 定时器到点后的 stale/closed/connected 二次校验已迁入 `native-peer-controller.js::prepareDisconnectedRecoveryRetry()`，legacy 只消费 ready/log payload 并执行实际 `requestPeerRecovery()` 外部动作。
  - 当前补充：disconnected recovery timer 的 arm、到点 retry 校验、`peer:disconnected-recovery` 日志、`requestPeerRecovery()` 调用和失败后 `restartInProgress` 回滚已迁入 `native-peer-controller.js::scheduleDisconnectedRecovery()`；`app-native-overrides.js` 删除本地 `scheduleDisconnectedPeerRecovery()` 和对应注入回调。
  - 当前补充：`requestPeerRecovery()` 的 recovery decision、日志、host force offer 和 viewer reconnect-ready 发送已迁入 `native-peer-controller.js::requestPeerRecovery()`；legacy wrapper 只传递 attempt/source 参数。
  - 当前补充：disconnected recovery 的 `[750,1500]` 重试延迟默认值已由 `native-peer-controller.js::prepareDisconnectedRecovery()` 正常路径持有；`app-native-overrides.js` 不再传入重试延迟，`app.js` 不再暴露 native P2P reconnect 常量。
  - 当前补充：relay offer retry 的 `[750,1500]` 重试延迟默认值已由 `native-peer-controller.js::schedulePeerReconnect()` 正常路径持有；`scheduleRelayOfferRetry()` 不再直接读取重试延迟常量。
  - 当前补充：本地 ICE candidate 统计已由 `native-peer-controller.js::handleLocalSignalEventAndSend()` 内部的 `rememberLocalIceCandidateForSignal()` 执行，legacy 不再保留 `rememberLocalIceCandidateForPeer()` facade。
  - 当前补充：P2P 诊断 peer entries 组装已迁入 `native-peer-controller.js::buildPeerDiagnosticEntries(statsPeers)`，legacy 只传入 stats peers 并把结果交给 `native-diagnostics.js` 格式化。
  - 当前补充：NAT mapping fallback 主体编排已迁入 `native-peer-controller.js::attemptLastChanceNatMapping()` 私有路径，包括 begin/result/error/finish 状态转移、`mediaEngine.openNatMapping()`、6000ms timeout、UI/log、mapped ICE candidate 信令发送、NAT wait timer arm 和诊断刷新；legacy 不再保留 `attemptLastChanceNatMapping()` wrapper。
  - 当前补充：NAT mapping 的 `begin/apply-result/apply-error/finish/send-mapped-candidates` helper 已收回为 `native-peer-controller.js` 私有实现，不再从 controller return API 暴露给 legacy 调用。
  - 当前补充：native peer handle 查询/删除/count/ids、signal attempt、session description normalize、stale error 判断、signal state clear、media offer 判定等纯工具 direct wrapper 已从 `app-native-overrides.js` 删除；调用点直接使用 `nativePeerController`。
  - 当前补充：relay offer retry 的剩余 reconnect state 调用点已改为直接使用 `nativePeerController.getPeerReconnectState()` / `clearPeerReconnect()` / `schedulePeerReconnect()`，legacy 不再暴露 `clearNativePeerReconnect()` 等 reconnect timer 假 owner。
  - 当前补充：connect failfast 与 NAT mapping wait timeout 的二次 ready 判断已迁入 `native-peer-controller.js::prepareConnectFailfastTimeout()` / `prepareNatMappingWaitTimeout()`；两者默认 timeout 动作均已继续收进 controller。
  - 当前补充：最终 P2P failed 状态写入、`peer-connect-failed` payload 组装、P2P failed UI、viewer 失败文案和 close 外部动作已由 `native-peer-controller.js::finalizeP2pConnectionFailureAndApply()` 私有路径串联；legacy `finalizeP2pFailureWithNatMapping()` 仅委托统一 facade 并传递 `roomId`。
  - 当前补充：P2P UI state label 的默认表已只保留在 `native/p2p-state-machine.js`；`app-native-overrides.js` 删除重复 `P2P_UI_STATE_LABELS`，状态文案通过 state machine 统一读取。
  - 当前补充：viewer media wait 和 upstream offer wait 的默认超时已由 `native/p2p-state-machine.js` 正常路径持有；`app-native-overrides.js` 不再定义和传入重复 wait timeout 配置。
  - 当前补充：native peer signal backlog/TTL/waiter 默认限制已由 `native-peer-controller.js` 自己持有；`app-native-overrides.js` 不再向 controller 传入重复 signalMax* 配置，也不再为缺 native-peer-controller registry 保留本地 backlog/waiter Map。
  - 当前补充：缺 `native-peer-controller.js` 时的 peer signal/handle registry fallback Map 已删除；`app-native-overrides.js` 不再维护 fallbackSignalBacklog/fallbackSignalWaiters/fallbackPeerHandles/fallbackPeerAttemptSeq，registry 缺失时 fail-fast。
  - 当前补充：`nativePeerController` 本体创建也已收为 `native-entry.js::createRequired()`，缺 `native-peer-controller.js` 时抛出 `native-peer-controller-unavailable`，不再让后续大量 legacy signal/peer fallback 分支成为可达运行路径。
  - 当前补充：peer attempt helper、signal queue clear/enqueue/wait/drop 和 media-offer 判定/等待的 legacy 本地实现已删除；`app-native-overrides.js` 同名 wrapper 直接委托 `native-peer-controller.js`，不再读取 `nativePeerSignalRegistry` backlog/waiter 细节。
  - 当前补充：peer handle/signal registry bridge 已从 `app-native-overrides.js` 删除；legacy 文件不再创建 `nativePeerHandleRegistry` / `nativePeerSignalRegistry`，peer handle attempt、handle get/set/delete/count/ids 和 signal queue registry 只由 `native-peer-controller.js` 内部持有。
  - 当前补充：NAT mapping candidate limit、NAT mapping connect wait 和 disconnected recovery grace 的默认值已由 `native-peer-controller.js` 正常路径持有；`app-native-overrides.js` 不再全局定义对应常量。
  - 当前补充：peer 基础 helper 的 legacy 本地实现已继续收口；native peer handle 判定、session description 归一化、remote candidate key/text、pure P2P candidate 过滤、remote description 相等判断、signal peer id、signal state update、signal backlog prune、signal payload sanitize、stale peer error 分类和 reconnect timer helper 均直接委托 `native-peer-controller.js`，`app-native-overrides.js` 不再持有对应本地算法或 `peerReconnectState`。
  - 当前补充：peer diagnostics entries、local/remote candidate 记忆、pending remote candidate queue、edge state snapshot、peer close/close-all、offer/answer message 生成与发送、local ICE signal payload 和 clear-all pending hook 已直接委托 `native-peer-controller.js`；`app-native-overrides.js` 删除对应不可达本地 fallback、旧 pending queue 引用和本地 offer/answer payload builder。
  - 当前补充：NAT mapping、P2P failfast、peer recovery、disconnected recovery、peer-state event、remote offer/answer/ice、viewer upstream stale cleanup 的 remaining legacy fallback 已删除；`app-native-overrides.js` 不再保留 `nativePeerController && typeof ...` 或 `if (nativePeerController)` 可选分支，peer 主路径只通过 `native-peer-controller.js` 做状态/attempt/timer/信令决策。
- 已新增并接入 `server/public/native/native-session-controller.js`，通过 `VDS.nativeSession.createController()` 承接 `startHostSession/stopHostSession/startAudioSession/stopAudioSession/stopHostAndAudioSessions` 的 mediaEngine RPC wrapper，承接 `parseCaptureSource()` 的 native capture source 归一化和 `prepareNativeCaptureHostStart()` 的 native capture start request 准备/日志，承接 native preview start/retry/fallback-notice 纯决策，承接 `validateHostStartResult()` 的 native/OBS host start 返回校验，承接 `validateAudioStartResult()` / `startNativeAudioForShare()` 的音频启动校验和“音频失败仅降级画面”正常路径，承接 `ensureMediaSessionId/resetMediaSessionId/buildHostMediaManifest/buildHostMediaManifestFromStats/buildHostMediaManifestFromObsIngest`，承接 `buildHostCreateRoomMessage()` 的 host create-room payload 构造和 `createHostRoom()` 的等待 WebSocket、发送建房消息、释放 pending UI 编排，承接 `createNativeCaptureHostRoom()` 的 native capture manifest 构建、manifest 记忆和 create-room 正常路径，承接 `ensureObsHostRoomCreated()` 的 OBS 建房 readiness/pending/UI/manifest/create-room 正常路径，承接 `teardownObsHostRoom()` 的 close peers、leave-room、OBS room state reset、playback reset、UI reset 和 `obs-ingest:room-ended` 日志顺序，承接 `buildHostStartBeginEffects()` 的 native/OBS start begin 状态 effects，承接 `buildNativeHostStartCodecEffects()` 的 native start effective codec 归一化和 codec UI lock effects，承接 `buildHostSessionStartedEffects()` / `buildHostSessionStoppedEffects()` 的 native host session started/stopped 状态 effects 编排，承接 `buildObsMediaStateEffects()` 的 OBS waiting/connected/stream-running/ended 状态 effects 编排，承接 `applyEffects()` 的标准 native session effects 消费分发，承接 `beginHostStart/finishHostStart/cancelHostStart/isHostStartCurrent`，承接 `beginStopShare/finishStopShare` 的 stop share in-flight guard、取消开播、stopping UI 和 begin 日志外层 lifecycle，承接 `cleanupFailedHostStart()` 的 host preview attached reset、host preview tracking remove、host/audio session stop 和 failed-start UI reset 顺序，承接 `buildHostStartSuccessEffects()` 的 native/OBS host start 成功后 session/UI/stats effects 顺序，承接 `cleanupStopResources()` 的 stop stats、detach preview、close peers、stop host/audio sessions 顺序，并承接 `finalizeStopState()` 的 host stopped、leave-room、room state reset、playback reset、UI reset callback 编排；`app-native-overrides.js` 保留 legacy 兼容入口、legacy state 镜像、具体 DOM 写入和 `rememberMediaManifest()` 状态镜像，模块缺失时由 bridge fail-fast。
  - 当前补充：host session media-state 分类表已迁入 `native-session-controller.js::isHostSessionMediaState()`；`app-native-overrides.js` 不再持有 `HOST_SESSION_MEDIA_STATES`，只通过 session controller/static facade 判断是否应忽略 stop 后残留事件。
  - 当前补充：`lockCodecUiToNativeH264()` helper 已删除；session effects 注入、native host start 和 native UI 初始化直接调用 `window.__vdsRefreshQualitySettingsUi()`。
  - 当前补充：`normalizeNativeVideoCodec()` renderer 重复实现已删除；`native-session-controller.js` 现在导出 `normalizeVideoCodec()`，renderer 的 `setNativeEffectiveCodec` effect 直接使用 session controller 归一化。
  - 当前补充：media-state update 判断树已迁入 `native-session-controller.js::buildMediaStateUpdateEffects()`；`app-native-overrides.js::applyNativeMediaStateUpdate()` 只传入当前 host/session 上下文并消费 effects，stop 后残留过滤、backend 更新、surface-detached tracking 清理、OBS/host-session effects 均由 session controller 产出。
  - 当前补充：`nativeSessionController` 和 `nativeSessionState` 本体创建已收为 `native-entry.js::createRequired()`，缺 `native-session-controller.js` 时抛出 `native-session-controller-unavailable`；`nativeSessionState` 缺 factory 时抛出 `native-session-state-unavailable`，不再由 legacy 文件维护 fallbackCurrentHostBackend/hostPreview/OBS pending/OBS active 状态。
  - 当前补充：mediaSessionId reset、host start generation/in-flight、host media manifest 构造、OBS/native stats manifest 构造和 host create-room 发送 facade 已直接委托 `native-session-controller.js`；`app-native-overrides.js` 删除对应本地 manifest/create-room fallback 和只服务旧 fallback 的 manifest dimension resolver。
  - 当前补充：`nativeSessionState` getter/setter direct wrapper 已从 `app-native-overrides.js` 删除；调用点直接使用 `native-session-controller.js::createSessionState()` 返回对象读写 current backend、host preview、OBS room pending 和 OBS stream active，legacy 不再暴露这些假 owner 函数名。
  - 当前补充：host/audio session RPC wrapper、audio start validation、stop resources cleanup、stop finalization、begin/finish stop share、failed-start cleanup 和 host start effects 分发已直接委托 `native-session-controller.js`；`app-native-overrides.js` 删除对应 mediaEngine 直连 fallback、Promise.all stop fallback 和 legacy effects switch。
  - 当前补充：host start generation、start-current 判断、host session start/stop、manifest build、stop cleanup/finalize/finish 和 host-start effects 的 direct wrapper 已删除；`app-native-overrides.js` 调用点直接使用 `nativeSessionController`，只保留仍需本地参数组装的 helper。
  - 当前补充：native/OBS host start 主流程里的 start-begin effects、source prepare、preview policy、start result validation、codec effects、success effects、preview fallback notice、native capture create-room 和 OBS success effects 已直接委托 `native-session-controller.js`；`app-native-overrides.js` 删除这些路径的不可达本地 fallback，只保留实际启动顺序、surface attach、retry loop 和错误展示。
  - 当前补充：host stop-share 按钮 capture-phase 绑定已迁入 `native-session-controller.js::bindHostControlEvents()`；`app-native-overrides.js` 只注入按钮元素、host session running 判断、`stopScreenShare()` 回调和错误展示回调。
  - 当前补充：带音频共享高层流程已迁入 `native-session-controller.js::runNativeCaptureHostStartWithAudio()`；`app-native-overrides.js::startScreenShareWithAudio()` 只保留 legacy 入口委托，不再直接启动 native audio session 或本地处理 audio 降级异常。
  - 当前补充：`native-session-controller.js::validateAudioStartResult()` 已补回 native audio start result 归一化，明确识别 `captureActive/audioCaptureActive` 和 `ready`，避免 legacy 对 `ok` 字段的脆弱判断。
- 已新增并接入 `server/public/native/native-entry.js`，通过 `VDS.nativeEntry.installLegacyOverrides()` 承接 native legacy installer 调用、install guard 写入和返回 hook map 注册，通过 `markLegacyOverridesInstalled()` 保留 installer 内 guard 写入能力，通过 `setRuntimeFlags()` / `isNativePeerDriverActive()` 承接 native peer driver active flag，通过 `registerLegacyGlobals()` 统一注册 legacy `window.*` hook，并暴露 install/runtime 状态快照；`app-native-overrides.js` 仍保留旧业务逻辑和同名全局 wrapper，但不再写托管路径 install guard、不再主动注册 legacy globals，也不再在缺 native-entry 时自行安装，`__vdsClearNativePendingRemoteCandidates` 等兼容 hook 均随返回 hook map 交给 entry 注册。
  - 当前补充：`legacyGlobalBindings.isNativePeerHandle` 已改为显式委托 `native-peer-controller.js::isNativePeerHandle()`；`app-native-overrides.js` 不再通过对象简写引用已迁走的同名本地函数，避免 native-entry 注册 globals 时触发 `ReferenceError`。
- 已在 `index.html` 中把 `app-state.js`、`room-client.js`、`debug-panel.js`、`update-ui.js`、`quality-settings.js`、`source-selection.js` 放到 `app.js` 前加载，并把 `native/native-diagnostics.js`、`native/native-stats-controller.js`、`native/native-media-engine-controller.js`、`native/p2p-state-machine.js`、`native/native-surface-controller.js`、`native/native-peer-controller.js`、`native/native-peer-message-controller.js`、`native/native-session-controller.js`、`native/native-room-message-controller.js`、`native/native-viewer-controls.js`、`native/native-viewer-fullscreen-controls.js`、`native/native-entry.js` 放在 `app-native-overrides.js` 前加载。
  - 当前补充：`native/native-renderer-state-controller.js` 已加入 `p2p-state-machine.js` 之后、surface/peer/session controllers 之前加载，作为 legacy renderer room/viewer/media 状态 patch 的集中 facade。
- 当前补充：`index.html` 的 renderer 入口顺序已对齐拆分计划，并新增 `scripts/check-renderer-entry.js` / `npm run check:renderer-entry` 自动校验 21 个脚本的顺序和文件存在性；`release-check.js` 已把该检查纳入发布前/后检查链。
- 当前补充：`native-renderer-state-controller.js` 已承接 `setViewerRoomState`、`setHostRoomState`、`setSessionRoomState`、`setViewerResumeState`、`setViewerMediaState`、`markViewerRoomJoinedPending`、`setUpstreamPeerId`、`setChainPosition` 和 viewer reconnect pending 状态 patch；并新增 `createLegacyAppStateBridge()` 统一解释旧 `app.js` 局部变量 patch 字段，新增 `createAppStateSyncBridge()` 统一组装 `mediaManifest + overrides` 的 app-state 同步快照。`app-native-overrides.js` 已删除 `applyNativeRendererStatePatch()`，`syncRendererAppState()` 也只委托 sync bridge；override 只向 bridge 注入低层 setter、manifest getter 和旧 app sync 函数。`check-renderer-bridge.js` 已阻止这些多字段状态 setter、legacy patch 解释函数、关键 patch 字段解释和 app-state 同步快照组装回流到 override。
- 当前补充：新增 `npm run check:architecture` 作为拆分健康度快速总入口，串联 renderer entry/syntax/bridge 与 media-agent boundary 四类门禁；`release-check.js` 改为调用该组合入口，避免后续新增架构门禁时遗漏发布链路。
- 当前补充：新增 `scripts/check-renderer-bridge.js` 与 `npm run check:renderer-bridge`，自动校验 `app.js` native authority wrapper 参数完整透传，以及 `app-native-overrides.js` 的 `legacyGlobalBindings` 简写导出不引用未声明本地符号；`release-check.js` 已把该检查纳入发布前/后检查链。
- 当前补充：新增 `scripts/check-renderer-syntax.js` 与 `npm run check:renderer-syntax`，递归 `node --check` 覆盖 `server/public` 源码 JS（排除 `vds_web` 打包产物）；`release-check.js` 已把该检查纳入发布前/后检查链，避免新增 renderer 模块后只检查旧入口文件。
- `app.js` 已把旧房间/session 变量镜像到 `VDS.state`，并向 `VDS.roomClient` 安装 legacy adapter；旧局部变量仍是权威来源，避免本阶段改变时序。

## 验证命令

```powershell
node --check server/public/app-state.js
node --check server/public/room-client.js
npm run check:renderer-entry
npm run check:renderer-syntax
npm run check:renderer-bridge
npm run check:architecture
node --check server/public/debug-panel.js
node --check server/public/update-ui.js
node --check server/public/quality-settings.js
node --check server/public/source-selection.js
node --check server/public/native/native-diagnostics.js
node --check server/public/native/native-stats-controller.js
node --check server/public/native/p2p-state-machine.js
node --check server/public/native/native-surface-controller.js
node --check server/public/native/native-peer-controller.js
node --check server/public/app.js
node --check server/public/app-native-overrides.js
npm run check:logging
```
