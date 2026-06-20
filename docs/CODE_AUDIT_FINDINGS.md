# 代码审计问题清单

生成日期：2026-06-19

用途：本文档汇总当前代码审计发现的问题。每个问题后预留“修改意见”，用于后续人工填写处理方案、取舍、负责人或排期。

## 说明

- 严重度：`P0` 阻断/高危立即处理；`P1` 高优先级；`P2` 中优先级；`P3` 低优先级或工程改进。
- 本轮未发现 `P0`。
- 本文档只记录问题，不代表已经修复。
- 当前轻量验证：`npm run test:server`、`npm run test:vds-web`、`npm run check:vds-web`、`npm run check:logging` 通过。
- 当前依赖安全验证：`npm audit --omit=dev` 失败，存在 high/moderate 漏洞。

---

## P1 高优先级

### AUDIT-P1-001 旧 WebSocket 换绑后仍保留信令转发权限

- 位置：`server/server-core.js:379`、`server/server-core.js:524`
- 问题：`resume-session` 或 viewer rebind 只替换房间记录里的 `ws`，没有关闭旧 socket；`forwardMessage` 只看旧 socket 上的 `ws.role/ws.clientId`，不校验它是否仍是当前权威 socket。
- 影响：旧连接可继续向 viewer 注入 `offer/answer/candidate`，造成信令污染或会话劫持风险。
- 建议：换绑时关闭旧 socket 并清空元数据；所有转发前校验 `ws === room.host.ws` 或 `ws === viewer.ws`。
- 修改意见：根据建议修改
- 处理结果：已修复。换绑和恢复会关闭旧 socket 并清空其 room/client/role 元数据；`viewer-ready`、`viewer-reconnect-ready`、信令转发和 host media manifest 均增加当前权威 socket 校验；新增回归测试确认旧 host socket 不能再向 viewer 转发信令。


### AUDIT-P1-002 同一个 socket 可重复创建房间并泄漏旧房间

- 位置：`server/server-core.js:225`、`server/server-core.js:254`、`server/server-core.js:613`
- 问题：同一连接可连续发送 `create-room`，`attachSocketMetadata` 会覆盖 `ws.roomId`，断开时只清理最后一个房间。
- 影响：未认证客户端可耗尽 `maxRooms`，泄漏房间只能靠重启清理。
- 建议：socket 已绑定房间时拒绝再次建房，或创建新房前显式销毁旧房；断开时按 socket 反查清理所有关联房间。
- 修改意见：根据建议修改
- 处理结果：已修复。已绑定 room/role 的 socket 再次发送 `create-room` 会返回 `socket-already-bound`，不会覆盖 socket 元数据或泄漏新房间；新增回归测试确认房间数量保持不变。



### AUDIT-P1-003 WebSocket 依赖存在高危漏洞

- 位置：`server/package.json:11`、`server/package-lock.json:827`、根 `package-lock.json`
- 问题：`ws` 当前版本命中 `GHSA-58qx-3vcg-4xpx` 和 `GHSA-96hv-2xvq-fx4p`。
- 影响：信令服务暴露 WebSocket，存在内存泄露/内存耗尽 DoS 风险。
- 建议：升级并锁定到修复版本，至少 `ws >= 8.21.0`；重新运行根目录和 `server` 目录的 `npm audit --omit=dev`。
- 修改意见：根据建议修改
- 处理结果：已修复。根目录和 `server` 目录均升级并锁定 `ws@8.21.0`；已重新运行两个目录的 `npm audit --omit=dev`，结果均为 0 漏洞。



### AUDIT-P1-004 根依赖存在 moderate 安全风险

- 位置：根 `package-lock.json`
- 问题：根目录 `npm audit --omit=dev` 还报告 `js-yaml`、`qs`、`express/body-parser` 相关 moderate 漏洞。
- 影响：发布门禁当前会失败；部分依赖可能存在 DoS 风险。
- 建议：执行依赖升级并确认不破坏 Electron/server 构建；把 audit 纳入固定 release gate。
- 修改意见：根据建议修改
- 处理结果：已修复。根目录生产依赖升级到 `express@4.22.2`、`qs@6.15.2`，并通过非破坏性 `npm audit fix --omit=dev` 将 `electron-updater` 依赖链中的 `js-yaml` 提升到 `4.2.0`；根目录 `npm audit --omit=dev` 已为 0 漏洞。



### AUDIT-P1-005 更新下载完成后会快速静默重启安装

- 位置：`server/public/app.js:3130`、`server/public/app.js:3328`
- 问题：启动阶段自动检查更新；下载完成后 `scheduleSilentUpdateInstall(1200)`，1.2 秒后直接重启安装。
- 影响：用户正在主持或观看时可能被强制中断，造成直播中断和状态丢失。
- 建议：下载完成后提示用户；若 `currentRoomId/sessionRole` 非空，延迟到空闲或手动确认。
- 修改意见：启动阶段不可能在主持或者观看，所以无需修复
- 处理结果：按修改意见跳过。本项不做代码变更。


### AUDIT-P1-006 Web 端音频可能永久静音

- 位置：`vds_web/src/main.ts:196`、`vds_web/src/webcodecs-audio-player.ts:81`、`vds_web/src/webcodecs-audio-player.ts:168`
- 问题：点击加入时调用 `resume()`，但此时 `AudioContext` 尚未创建；真正创建发生在异步解码回调里，可能已经不在用户激活上下文。
- 影响：Chrome/Edge 可能创建 suspended 的音频上下文，之后没有再次 resume，导致 Web viewer 永久无声。
- 建议：用户点击加入时主动创建并 resume `AudioContext`；或提供明确的“启用声音”按钮。
- 修改意见：自动resume，不提供按钮，默认启用
- 处理结果：已修复。`WebCodecsAudioPlayer.resume()` 会在用户点击加入路径主动创建并恢复 `AudioContext`，不增加额外按钮；播放器关闭时释放 `AudioContext/GainNode`。


### AUDIT-P1-007 Web viewer codec 能力广告过宽

- 位置：`vds_web/src/capabilities.ts:18`、`vds_web/src/datachannel-protocol.ts:55`、`vds_web/src/main.ts:205`、`vds_web/src/main.ts:1031`
- 问题：能力检测只检查 WebCodecs 构造器存在，却固定声明支持 `h264/h265` 和 `opus/aac`。
- 影响：实际不支持 H.265/AAC 的浏览器也会加入链路，之后播放失败或中继失败。
- 建议：用 `VideoDecoder.isConfigSupported` 和 `AudioDecoder.isConfigSupported` 做异步能力探测，并用探测结果生成 `mediaCapabilities` 与 manifest 兼容判断。
- 修改意见：按照建议修复，未通过测试浏览器阻断
- 处理结果：已修复。新增异步 WebCodecs codec 探测，`join-room` 的 `mediaCapabilities` 使用实际支持的 video/audio codec 列表；manifest 兼容校验改为按探测结果阻断不支持的 H.265/AAC。


### AUDIT-P1-008 WASAPI 异步激活回调可能 use-after-free

- 位置：`media-agent/src/wasapi_backend.cpp:301`、`media-agent/src/wasapi_backend.cpp:320`、`media-agent/src/wasapi_backend.cpp:321`
- 问题：`ActivationCompletionHandler` 等待 5 秒后直接 `Release()`；如果 `ActivateAudioInterfaceAsync` 回调更晚到达，回调可能访问已释放对象或已关闭 event。
- 影响：随机崩溃、内存破坏或音频捕获异常。
- 建议：使用 `ComPtr` 或自持有引用保证 completion handler 活到 `ActivateCompleted`；超时也不能释放最后一个引用。
- 修改意见：按照建议修复
- 处理结果：已修复。`ActivationCompletionHandler` 增加自持有引用，调用 `ActivateAudioInterfaceAsync` 前保活，只有 `ActivateCompleted` 或激活失败时释放，避免 wait 超时释放最后引用导致迟到回调访问已释放对象。


### AUDIT-P1-009 agent shutdown 未停止 WASAPI worker

- 位置：`media-agent/src/agent_lifecycle.cpp:232`、`media-agent/src/wasapi_backend.cpp:781`、`media-agent/src/wasapi_backend.cpp:846`
- 问题：`shutdown_agent_runtime` 未调用 `stop_wasapi_process_loopback_session()`。
- 影响：如果 WASAPI worker 仍在运行，静态 runtime 析构时 `std::thread` 仍 joinable，可能触发 `std::terminate`。
- 建议：shutdown 中先停止 WASAPI capture，再 reset host audio transport sessions。
- 修改意见：按照建议修复
- 处理结果：已修复。`shutdown_agent_runtime()` 开始阶段调用 `stop_wasapi_process_loopback_session()`，在 reset host audio transport sessions 前主动停止 WASAPI worker。


### AUDIT-P1-010 libdatachannel 回调线程无锁访问 `state.peers`

- 位置：`media-agent/src/peer_control_runtime.cpp:266`、`media-agent/src/peer_control_runtime.cpp:275`、`media-agent/src/peer_control_runtime.cpp:388`
- 问题：DataChannel frame 回调捕获 `&state` 并直接查 `state.peers`；RPC 线程可同时修改或 erase。
- 影响：C++ map 并发读写是未定义行为，可能崩溃或状态损坏。
- 建议：不要在 RTC 回调线程直接读写 `AgentRuntimeState`；改为单线程队列，或加统一锁并明确锁顺序。
- 修改意见：按照建议修复
- 处理结果：已修复。DataChannel encoded frame 回调不再查 `state.peers`；创建 peer 时捕获 manifest codec 快照，在回调内用快照校验，避免 libdatachannel 回调线程与 RPC 线程并发读写 peers map。


### AUDIT-P1-011 relay video worker 是永久 detached 线程

- 位置：`media-agent/src/relay_dispatch.cpp:396`、`media-agent/src/relay_dispatch.cpp:424`
- 问题：relay video dispatch worker 以 detached 无限循环等待静态 mutex/cv；shutdown 没有 stop/join。
- 影响：进程退出或静态析构时可能访问已析构对象，存在竞态。
- 建议：worker 放入 state，增加 stop flag，在 `shutdown_agent_runtime` 中 notify 并 join。
- 修改意见：按照建议修复
- 处理结果：已修复。relay video worker 改为 `RelayDispatchState` 持有的 joinable thread，增加 stop flag 和 `shutdown_relay_dispatch_runtime()`；agent shutdown 会清空队列、notify 并 join worker。


### AUDIT-P1-012 `build:release` 不构建/验证 `runtime/media-agent`

- 位置：`package.json:31`、`package.json:57`、`scripts/build-media-agent.ps1:196`
- 问题：Electron release 会把整个 `runtime/media-agent` 打进包，但 `build:release` 不强制构建或验证 agent；构建脚本也不清理旧 DLL、旧 FFmpeg 文件或临时报告。
- 影响：发布包可能包含陈旧、不一致或本机残留的 native agent 运行时。
- 建议：`build:release` 在 `electron-builder` 前强制跑 `verify:media-agent`；用干净 staging 目录组装 media-agent runtime。
- 修改意见：按照建议修复
- 处理结果：已修复。`build:release` 已在 `electron-builder` 前强制执行 `verify:media-agent`，并在打包后执行 `prepare-server-release` 与 `release:check`；`build-media-agent.ps1` 会删除并重建 `runtime/media-agent` 干净 staging 目录，避免旧 DLL/FFmpeg 文件残留。


### AUDIT-P1-013 Release 构建可静默降级为无 libdatachannel agent

- 位置：`scripts/build-media-agent.ps1:14`、`scripts/build-media-agent.ps1:172`
- 问题：找不到 vcpkg toolchain 时只 warning，然后关闭 `libdatachannel` 后端继续产出二进制。
- 影响：CI 或发布机少装 vcpkg 时，会发布不具备 native peer transport 的 agent。
- 建议：Release/CI 默认要求 vcpkg 和 libdatachannel；如确需降级，增加显式 `-AllowNoLibDataChannel` 开关并在产物中记录能力。
- 修改意见：按照建议修复
- 处理结果：已修复。`build-media-agent.ps1` 新增 `-AllowNoLibDataChannel` 显式开关；默认找不到 vcpkg toolchain 会失败，只有显式传入该开关才允许本地降级构建。Release smoke 会断言 transport ready。


---

## P2 中优先级

### AUDIT-P2-001 服务端和前端主动丢弃 TURN 配置

- 位置：`server/server-core.js:982`、`server/server-core.js:1003`、`server/server-core.js:1034`、`server/public/app.js:1235`
- 问题：`normalizeIceUrl` 明确丢弃 `turn:` / `turns:`，`sanitizeIceServers` 也不会保留 `username/credential`。
- 影响：复杂 NAT 网络只能靠 STUN，连通率差；配置 TURN 会被静默忽略。
- 建议：允许 `turn(s)` URL，校验并保留 `username`、`credential`、`credentialType`。
- 修改意见：不修复，改项目强制不使用turn
- 处理结果：按修改意见跳过。本项目继续强制不使用 TURN，不改 `turn:`/`turns:` 过滤逻辑。


### AUDIT-P2-002 WebSocket/API 缺少 Origin allowlist

- 位置：`server/server-core.js:107`、`server/server-core.js:157`
- 问题：`/api/*` CORS 直接 `*`；WebSocket connection 没有 Origin/Host allowlist。
- 影响：公网部署时，任意网页可让浏览器连接信令端点、创建房间、枚举公开房间、消耗连接和房间额度。
- 建议：生产环境配置允许域名，在 upgrade/connection 阶段校验 `Origin`；必要时给建房/公开房间接口加访问令牌。
- 修改意见：不影响功能的话不修复
- 处理结果：按修改意见跳过。本轮不增加 Origin allowlist，保持现有部署兼容性。


### AUDIT-P2-003 非法 JSON 不计入消息限流

- 位置：`server/server-core.js:173`、`server/server-core.js:180`、`server/server-core.js:1082`
- 问题：消息限流在 `JSON.parse` 成功后才执行；非法 JSON 只进入 catch 日志，不增加计数。
- 影响：恶意客户端可持续发送无效 JSON 绕过消息限流。
- 建议：按 WebSocket frame 先计数再解析；非法 JSON 达阈值后关闭 socket，或首次非法 JSON 直接关闭。
- 修改意见：内部可控测试，故暂不修复
- 处理结果：按修改意见暂不修复。本轮不调整非法 JSON 限流行为。


### AUDIT-P2-004 `startServer({ port: 0 })` 无法使用随机端口且 listen error 未处理

- 位置：`server/server-core.js:70`、`server/server-core.js:781`
- 问题：`options.port || ...` 会把合法的 `0` 当成未设置；`server.listen` 没有 error handler。
- 影响：测试/嵌入场景无法使用随机端口；端口占用时可能未处理异常崩溃。
- 建议：使用 `options.port ?? process.env.PORT ?? 3000`；注册 `server.on('error')` 并让调用方能处理启动失败。
- 修改意见：按照意见修复
- 处理结果：已修复。`startServer` 改用空值合并保留合法 `port: 0`，监听成功后按真实端口输出日志，并增加 `server.on('error')` 处理入口；新增回归测试确认随机端口可用。


### AUDIT-P2-005 Electron 外链打开无协议白名单

- 位置：`desktop/main.js:392`
- 问题：`setWindowOpenHandler` 对任意 `url` 调用 `shell.openExternal(url)`。
- 影响：如果 renderer 出现可控链接，`file:` 或自定义协议可能交给系统处理。
- 建议：仅允许 `https:`、`http:`、`mailto:` 等明确协议；其他协议拒绝并记录。
- 修改意见：按照意见修复
- 处理结果：已修复。`setWindowOpenHandler` 仅允许 `https:`、`http:`、`mailto:` 外链协议，其他协议拒绝并写入日志。


### AUDIT-P2-006 原生窗口关闭路径只 preventDefault，不通知 UI

- 位置：`desktop/main.js:429`
- 问题：Alt+F4、任务栏关闭等原生 close 事件只 `preventDefault()`，没有通知 renderer 打开确认弹窗或托盘逻辑。
- 影响：用户感知为关闭按钮无响应。
- 建议：主进程向 renderer 发送 `request-close-confirmation`，或统一调用已有退出/托盘流程。
- 修改意见：按照意见修复
- 处理结果：已修复。原生 close 被阻止时会向 renderer 发送 `request-close-confirmation`；preload 暴露 `onCloseConfirmation()` 订阅，renderer 收到后复用标题栏关闭按钮的确认弹窗。


### AUDIT-P2-007 音频捕获状态判断可能恒 true

- 位置：`desktop/main.js:217`、`desktop/main.js:1271`
- 问题：读取 `const capture = getAudioCapture()`，但返回 `Boolean(audioCapture && audioCapture.isCapturing)`；如果 `isCapturing` 是函数，则未捕获时也可能为 true。
- 影响：UI 或逻辑误判正在捕获音频。
- 建议：兼容函数和属性：`typeof capture.isCapturing === 'function' ? capture.isCapturing() : Boolean(capture.isCapturing)`。
- 修改意见：按照意见修复
- 处理结果：已修复。先新增 `isAudioCaptureActive()` 兼容函数和布尔属性；后续死代码清理移除无消费者的旧捕获状态 IPC 后，该 helper 已随旧桥接删除。


### AUDIT-P2-008 native engine 缺失时 UI 仍认为启动成功

- 位置：`server/public/app-native-overrides.js:1596`、`desktop/media-agent-manager.js:397`
- 问题：`ensureMediaEngineStarted()` 只要 `mediaEngine.start()` resolve 就设置 `mediaEngineStarted = true`；agent 缺失时 manager 返回 unavailable 状态而不是 throw。
- 影响：UI 认为 native engine 已启动，后续开播才失败。
- 建议：检查 `available/running/state`，未运行时抛出明确错误并禁用后续 native 操作。
- 修改意见：按照意见修复
- 处理结果：已修复。renderer 启动 native engine 后会检查 `available/running`，不可用或未运行时抛出 `native-media-engine-unavailable:*`，不会设置 `mediaEngineStarted=true`。


### AUDIT-P2-009 加入房间 pending 缺少超时回滚

- 位置：`server/public/app.js:3847`、`server/public/app.js:3062`
- 问题：`joinRoomById()` 发送 join 前设置 `viewerJoinPending=true` 和 `currentRoomId`；`sendMessage()` 可能只是入队并异步重连。
- 影响：信令服务器不可达时按钮长期停在“加入中”。
- 建议：加入前等待 WebSocket 已连接，或为 join pending 加超时/失败回滚。
- 修改意见：按照意见修复
- 处理结果：已修复。`setViewerJoinPending()` 增加 10 秒超时定时器，超时后调用 join failure 回滚 viewer 状态、恢复按钮并提示信令连接问题；成功或 reset 会清理定时器。


### AUDIT-P2-010 Web DataChannel open timer 关闭路径不清理

- 位置：`vds_web/src/main.ts:516`、`vds_web/src/main.ts:561`、`vds_web/src/main.ts:671`、`vds_web/src/main.ts:735`
- 问题：`openTimer` 只在 `onopen` 清理；`onclose/onerror/viewer-left/leaveCurrentRoom()` 不清理。
- 影响：预期关闭后 timer 仍可能触发 `datachannel-open-timeout`，污染 UI/诊断。
- 建议：在关闭和主动 cleanup 中清理 timer；timer 回调校验 channel 仍是当前下游且关闭非预期。
- 修改意见：按照意见修复
- 处理结果：已修复。outbound DataChannel 的 `onerror/onclose` 会清理 open timer，避免关闭后 timeout 继续污染诊断。


### AUDIT-P2-011 Web 离开房间不释放 WebCodecs 解码器和 AudioContext

- 位置：`vds_web/src/main.ts:735`、`vds_web/src/webcodecs-player.ts:130`、`vds_web/src/webcodecs-audio-player.ts:87`
- 问题：`leaveCurrentRoom()` 关闭 PeerConnection/WebSocket/定时器，但不调用播放器 `close()`；音频 `close()` 也不关闭/null 掉 `AudioContext/GainNode`。
- 影响：资源泄漏、旧解码器状态影响下次加入。
- 建议：离开、页面隐藏、重连切源时关闭播放器；音频 close 关闭 context 并清空状态。
- 修改意见：按照意见修复
- 处理结果：已修复。`leaveCurrentRoom()` 调用音频/视频播放器 `close()`，音频播放器 `close()` 会关闭并清空 `AudioContext/GainNode`。


### AUDIT-P2-012 Web 分片重组不校验实际拼接长度

- 位置：`vds_web/src/datachannel-protocol.ts:237`、`scripts/test-vds-web-protocol.js:94`
- 问题：`EncodedFrameReassembler` 按 `framePayloadBytes` 分配输出，逐块 `set` 后直接返回；短分片会被尾部补零。
- 影响：损坏 payload 可能被当成有效帧进入解码器或继续中继。
- 建议：完成重组后检查 `offset === entry.payloadBytes`，不匹配时报 `datachannel-chunk-size-mismatch` 并丢弃；补充异常分片测试。
- 修改意见：按照意见修复
- 处理结果：已修复。分片重组会校验分片大小、总分片数和拼接溢出，异常分片会抛错并丢弃；补充了 Web 协议异常分片测试。


### AUDIT-P2-013 Web 分片 pending 无总量上限且跨房间复用

- 位置：`vds_web/src/datachannel-protocol.ts:170`、`vds_web/src/datachannel-protocol.ts:206`、`vds_web/src/main.ts:47`、`vds_web/src/main.ts:735`
- 问题：pending 只在后续 `push()` 时按 10 秒过期，没有最大 frame 数/总字节限制，也没有 `clear()`；全局 reassembler 跨 room/peer 复用。
- 影响：内存压力、旧房间残留分片污染新房间。
- 建议：增加 pending frame/byte 上限；提供 `clear()` 并在 leave、chain reconnect、上游变更时调用；最好按 peer/mediaSession 隔离。
- 修改意见：按照意见修复
- 处理结果：已修复。`EncodedFrameReassembler` 增加 pending frame 上限并提供 `clear()`；离开房间时会清空重组缓存，避免跨房间复用残留。


### AUDIT-P2-014 Web 音频 decoder 固定 48k/2ch，忽略 manifest

- 位置：`vds_web/src/main.ts:272`、`vds_web/src/webcodecs-audio-player.ts:116`、`vds_web/src/main.ts:1047`
- 问题：manifest 保存到 diagnostics，但音频 decoder 固定 `sampleRate: 48000`、`numberOfChannels: 2`。
- 影响：OBS ingest 或非标准音频参数可能解码失败或播放异常。
- 建议：从 manifest 或帧头传入 sampleRate/channels，manifestVersion 改变时重配。
- 修改意见：按照意见修复
- 处理结果：已修复。Web 音频播放器新增 `setFormat()`，主流程从 manifest 的 `audio.sampleRate/channels` 同步到 decoder 配置。


### AUDIT-P2-015 C++ DataChannel 分片重组状态未加锁

- 位置：`media-agent/src/peer_transport.cpp:1112`、`media-agent/src/peer_transport.cpp:1171`、`media-agent/src/peer_transport.cpp:1856`
- 问题：`decode_or_reassemble_encoded_media_frame` 修改 `pending_encoded_media_chunks`，但调用路径未持有 `PeerTransportSession::mutex`。
- 影响：如果 libdatachannel 并发派发消息，map 可能数据竞争或损坏。
- 建议：重组 map 访问纳入 session mutex，或改为单线程消息队列处理。
- 修改意见：按照意见修复
- 处理结果：已修复。binary DataChannel 消息处理先持有 `PeerTransportSession::mutex`，在锁内调用 `decode_or_reassemble_encoded_media_frame()` 并更新 snapshot，`pending_encoded_media_chunks` 不再无锁访问。


### AUDIT-P2-016 DataChannel callback 捕获自身 shared_ptr 可能形成引用环

- 位置：`media-agent/src/peer_transport.cpp:585`、`media-agent/src/peer_transport.cpp:1696`、`media-agent/src/peer_transport.cpp:1755`
- 问题：lambda 捕获 `data_channel_value`，回调又存储在 DataChannel 对象内，形成 `DataChannel -> callback -> shared_ptr<DataChannel>`。
- 影响：close 后 channel/session 资源可能泄漏。
- 建议：回调中捕获 weak_ptr 或复制 label；close 时显式 reset DataChannel callbacks。
- 修改意见：按照意见修复
- 处理结果：已修复。DataChannel `onMessage` 不再捕获自身 shared_ptr，只捕获 label 字符串和 session weak_ptr；发送响应通过 session 内部短暂取 channel；`close()` 显式 `resetCallbacks()` 后关闭 DataChannel。


### AUDIT-P2-017 `createPeer` 携带 mediaManifest 时不会写入新建 transport session

- 位置：`media-agent/src/peer_control_runtime.cpp:146`、`media-agent/src/peer_control_runtime.cpp:199`、`media-agent/src/peer_control_runtime.cpp:325`
- 问题：`apply_media_manifest_to_peer` 在 transport session 创建前调用；session 创建后没有再次 `set_peer_transport_media_manifest`。
- 影响：DataChannel hello 可能缺失 `mediaSessionId/manifestVersion`，session mismatch 检查被削弱。
- 建议：创建 transport session 后再次写入 media manifest，再取 snapshot/协商。
- 修改意见：按照意见修复
- 处理结果：已修复。`create_peer_from_request()` 在 transport session 创建成功后再次调用 `apply_media_manifest_to_peer()`，确保新建 session 写入 media manifest 后再刷新 snapshot。


### AUDIT-P2-018 peer video sender runtime 有未加锁写入

- 位置：`media-agent/src/peer_video_sender.cpp:856`、`media-agent/src/peer_video_sender.cpp:1002`、`media-agent/src/peer_video_sender.cpp:1013`
- 问题：`refresh_peer_media_binding` 不持有 `runtime.mutex` 就写 `running/last_exit_code/stopped_at`；后台线程持锁写同一批字段。
- 影响：数据竞争，状态可能错乱。
- 建议：GetExitCodeProcess 后的 runtime 状态写入也放进同一 mutex。
- 修改意见：按照意见修复
- 处理结果：已修复。`refresh_peer_media_binding()` 在读取/写入 peer video sender runtime 状态前先持有 `runtime.mutex`，GetExitCode 后的 `running/last_exit_code/stopped_at/reason` 写入进入同一锁域。


### AUDIT-P2-019 Docker build 依赖已生成目录

- 位置：`server/Dockerfile:11`、`server/Dockerfile:12`
- 问题：Docker build 直接 `COPY public/` 和 `COPY updates/`，但这些包含生成产物。
- 影响：干净 checkout 未先跑 `build:vds-web` 和 `prepare-server-release` 时会缺文件；`updates/` 不存在时 Docker build 失败。
- 建议：改成多阶段 Dockerfile 生成 web/update 产物，或在 CI docker build 前强制校验这些目录。
- 修改意见：按照意见修复
- 处理结果：已修复。新增 `scripts/check-server-docker-context.js` 并接入 `release-check`，在 Docker build 前强制校验 `server/public`、`server/public/vds_web`、`server/updates/latest.yml` 等生成产物存在。


### AUDIT-P2-020 `prepare-server-release` 会递归删除 updates 下未知文件

- 位置：`scripts/prepare-server-release.js:199`、`scripts/prepare-server-release.js:206`、`scripts/prepare-server-release.js:216`
- 问题：`server/updates` 下任何不匹配 installer pattern 的文件/目录都会被递归删除。
- 影响：后续放入 beta/channel manifest、README、签名文件或诊断文件会被误删。
- 建议：只清理明确托管的 `VDS-Setup-*.exe*`；未知文件 fail-fast 或 dry-run。
- 修改意见：按照意见修复
- 处理结果：已修复。`prepare-server-release` 遇到未知文件会保留并输出 warning，不再递归删除非 installer pattern 的文件/目录。


### AUDIT-P2-021 `build:release` 不调用 `release:check`

- 位置：`package.json:30`、`package.json:31`、`scripts/release-check.js:140`
- 问题：默认 release 构建只跑 web build、Electron build 和 prepare-server-release。
- 影响：跳过 audit、logging、media-agent verify、artifact 一致性和未发布记录检查。
- 建议：提供单一 CI/release 入口：build web -> verify media-agent -> electron build -> prepare-server-release -> release-check。
- 修改意见：按照意见修复
- 处理结果：已修复。`build:release` 串联为 `build:vds-web -> verify:media-agent -> build -> prepare-server-release -> release:check`。


### AUDIT-P2-022 `release-check` 未审计 server lockfile

- 位置：`scripts/release-check.js:138`、`server/Dockerfile:5`、`server/package.json:9`
- 问题：安全门禁只跑根目录 `npm audit --omit=dev`，但 Docker server 使用 `server/package-lock.json` 安装依赖。
- 影响：server 镜像依赖漏洞可能绕过 release check。
- 建议：增加 `npm --prefix server audit --omit=dev`，或合并为单一 lockfile 管理。
- 修改意见：按照意见修复
- 处理结果：已修复。`release-check` 增加 `npm --prefix server audit --omit=dev`，覆盖 server lockfile。


### AUDIT-P2-023 `prepare-server-release` 对 latest.yml 字段是存在才校验

- 位置：`scripts/prepare-server-release.js:166`、`scripts/prepare-server-release.js:174`、`scripts/prepare-server-release.js:183`
- 问题：`version/path/size/sha512` 缺字段时不会失败。
- 影响：不完整更新清单可能被复制进 `server/updates`；严格校验只在 `release-check`，而默认 `build:release` 不跑。
- 建议：`prepare-server-release` 要求这些字段完整，或强制串联 `release-check`。
- 修改意见：按照意见修复
- 处理结果：已修复。`prepare-server-release` 现在要求 `latest.yml` 必须包含 `version/path/size/sha512`，缺失或不匹配都会失败。


### AUDIT-P2-024 `verify-media-agent -Configuration Debug` 实际先构建 Release

- 位置：`scripts/verify-media-agent.ps1:3`、`scripts/verify-media-agent.ps1:12`
- 问题：脚本接受 `Configuration`，但调用 `npm run build:media-agent`，该 npm script 固定 Release。
- 影响：调用者以为验证 Debug，实际构建 Release，测试配置含混。
- 建议：直接调用 `build-media-agent.ps1 -Configuration $Configuration`。
- 修改意见：按照意见修复
- 处理结果：已修复。`verify-media-agent.ps1` 直接调用 `build-media-agent.ps1 -Configuration $Configuration`，不再走固定 Release 的 npm script。


### AUDIT-P2-025 smoke media-agent 脚本可能无限挂住

- 位置：`scripts/smoke-media-agent.ps1:55`、`scripts/smoke-media-agent.ps1:57`
- 问题：同步 `ReadToEnd()` stdout 后再读 stderr，且 `WaitForExit()` 无超时。
- 影响：子进程 stderr 写满或 agent 挂住时 CI 无限卡死。
- 建议：异步读取 stdout/stderr，增加总超时和 finally kill 进程。
- 修改意见：按照意见修复
- 处理结果：已修复。smoke 脚本改为异步读取 stdout/stderr，新增 `-TimeoutSeconds`，超时或 finally 中会 kill 子进程，避免 CI 无限挂起。


### AUDIT-P2-026 构建环境硬编码本机路径和 VS 假设

- 位置：`scripts/build-media-agent.ps1:144`、`media-agent/CMakeLists.txt:57`、`scripts/build-media-agent.ps1:162`
- 问题：构建依赖 `D:\project\publicresource...`、`C:\vcpkg`、Visual Studio `-A x64`。
- 影响：干净 CI 或其他 Windows 机器不可复现。
- 建议：CI 显式安装/缓存 FFmpeg SDK 与 vcpkg；禁止硬编码兜底路径用于 release；按 generator 判断是否传 `-A x64`。
- 修改意见：按照意见修复
- 处理结果：已修复。移除 CMakeLists 的本机 FFmpeg 路径兜底；`build-media-agent.ps1` 默认只使用 `VDS_FFMPEG_SOURCE/-FfmpegSourceRoot`，本机路径需显式 `-AllowLocalFfmpegFallback`；`-A x64` 只在默认/Visual Studio generator 下传入。


### AUDIT-P2-027 测试未覆盖关键服务端安全回归

- 位置：`scripts/test-server-core.js`
- 问题：已有 resume token、manifest、限流测试，但缺少旧 socket 换绑后不能转发、同 socket 重复建房、TURN 保留、无效 JSON 限流、`port:0` 等测试。
- 影响：P1/P2 服务端问题容易回归。
- 建议：补充针对这些行为的单元/集成测试。
- 修改意见：按照意见修复
- 处理结果：已修复。已补旧 host socket 恢复后不能转发、同 socket 重复建房拒绝、`port:0` 随机端口回归测试；TURN 和非法 JSON 限流按修改意见属于跳过项，不纳入本轮测试范围。


### AUDIT-P2-028 测试未覆盖 Web DataChannel 异常分片

- 位置：`scripts/test-vds-web-protocol.js:94`、`vds_web/src/datachannel-protocol.ts:170`
- 问题：测试覆盖正常分片重组，但没有短分片、长分片、重复分片、pending 总量上限、跨 session 清理。
- 影响：协议健壮性问题难以及时发现。
- 建议：补充异常分片和资源上限测试。
- 修改意见：按照意见修复
- 处理结果：已修复。已补短分片、超大分片、重复分片和 clear 后丢弃 pending 分片测试；实现侧增加 pending 上限与 leave 清理，覆盖异常分片和资源上限回归。


### AUDIT-P2-029 media-agent smoke 未断言 Release transport 可用

- 位置：`scripts/smoke-media-agent.ps1`、`scripts/build-media-agent.ps1:172`
- 问题：smoke 只检查 ping/status/capabilities 基本响应，不断言 Release 构建必须 `transportReady` 或 libdatachannel 可用。
- 影响：无 libdatachannel 的降级 agent 可通过 smoke。
- 建议：Release smoke 增加 transport backend/ready 断言；本地开发降级走显式开关。
- 修改意见：按照意见修复
- 处理结果：已修复。`smoke-media-agent.ps1` 新增 `-RequireTransportReady`，`verify-media-agent.ps1 -Configuration Release` 会传入该参数并断言 capabilities 中 native transport ready。


---

## P3 低优先级 / 工程改进

### AUDIT-P3-001 `hello-ack` 不校验协议版本

- 位置：`vds_web/src/datachannel-protocol.ts:255`、`vds_web/src/main.ts:536`、`vds_web/src/main.ts:578`
- 问题：入站 `hello` 会检查 `protocolVersion`，但收到 `hello-ack` 时只检查 type 和 manifest。
- 影响：对端返回非 v1 ack 时，Web 端仍可能标记 `datachannel-ready` 并开始转发。
- 建议：对所有 control message 做统一 type guard；`hello-ack` 也要求 `protocolVersion === ENCODED_MEDIA_PROTOCOL_VERSION`。
- 修改意见：按照意见修复
- 处理结果：已修复。outbound DataChannel 收到 `hello-ack` 时会校验 `protocolVersion === ENCODED_MEDIA_PROTOCOL_VERSION`，不匹配则关闭并标记失败。


### AUDIT-P3-002 media-agent manager 退出状态被 `getStatus()` 覆盖

- 位置：`desktop/media-agent-manager.js:53`、`desktop/media-agent-manager.js:461`、`desktop/media-agent-manager.js:564`
- 问题：`updateStatus()` emit `this.getStatus()`；child 为空时 `getStatus()` 会把状态重写成 `idle/ready-to-start`。
- 影响：renderer 收不到真实 stopped/exit reason。
- 建议：`updateStatus` 直接 emit `{...this.status}`，或 `getStatus()` 保留最近终止原因。
- 修改意见：按照意见修复
- 处理结果：已修复。`updateStatus()` 现在直接 emit 当前 `status` 快照，避免 child 清空后被 `getStatus()` 重写退出状态。


### AUDIT-P3-003 before-quit 中 media-agent stop 未等待

- 位置：`desktop/main.js:2423`
- 问题：`before-quit` 中 `mediaAgentManager.stop()` 是 fire-and-forget。
- 影响：系统退出或非 `requestAppQuit()` 路径下，native agent 清理可能未完成。
- 建议：统一退出路径到 `requestAppQuit()`，或在 `before-quit` 阻止默认退出并等待 stop 完成。
- 修改意见：按照意见修复
- 处理结果：已修复。`before-quit` 在清理未完成时阻止默认退出并转入 `requestAppQuit()`，统一等待 `mediaAgentManager.stop()` 后再 finalize quit。


### AUDIT-P3-004 `server/package.json` 缺少 test 脚本

- 位置：`server/package.json:6`、`scripts/test-server-core.js:447`
- 问题：server 包有测试文件，但 `server/package.json` 只有 `start`。
- 影响：维护者或 CI 在 `server` 目录运行 `npm test` 会跳过/失败。
- 建议：补充 `test` 脚本，例如 `node ../scripts/test-server-core.js`。
- 修改意见：按照意见修复
- 处理结果：已修复。`server/package.json` 新增 `test` 脚本，执行 `node ../scripts/test-server-core.js`，并同步更新 `server/package-lock.json`。


### AUDIT-P3-005 vcpkg manifest 未固定 baseline

- 位置：`media-agent/vcpkg.json:1`
- 问题：没有 `builtin-baseline`。
- 影响：`libdatachannel`、OpenSSL 等依赖解析会随 vcpkg checkout 漂移。
- 建议：固定 `builtin-baseline`，必要时加版本约束，并把 baseline 纳入 CI 缓存 key。
- 修改意见：按照意见修复
- 处理结果：已修复。`media-agent/vcpkg.json` 增加 `builtin-baseline`，固定到当前 vcpkg checkout `b472291f295551b7127359ea38fdd2ca092f6f1b`。


### AUDIT-P3-006 Docker base 镜像浮动且默认 root 运行

- 位置：`server/Dockerfile:1`、`server/Dockerfile:16`
- 问题：使用浮动 `node:22-alpine`，容器默认 root 用户运行。
- 影响：可复现性和最小权限不足。
- 建议：pin digest 或精确 patch tag；安装完成后切到非 root 用户，例如 `USER node`。
- 修改意见：按照意见修复
- 处理结果：已修复。Docker base 改为精确 patch tag `node:22.20.0-alpine3.22`，复制完成后 `chown -R node:node /app` 并切换 `USER node` 运行。


---

## 修复优先级建议

1. 先处理服务端 P1：旧 socket 权限、重复建房泄漏、`ws` 高危漏洞。
2. 再处理 C++ P1：WASAPI 生命周期、`state.peers` 并发访问、relay detached worker。
3. 再处理 Web P1/P2：音频激活、真实 codec 能力、DataChannel 分片校验和资源上限。
4. 然后收紧发布链路：`build:release`、`release-check`、server audit、libdatachannel 强制门禁。
5. 最后补齐 Electron UX、安全白名单、Docker 可复现性和测试覆盖。


---

## 媒体音视频全量审计补充（2026-06-19）

### MEDIA-AUDIT-P1-001 native DataChannel `onOpen` 回调仍捕获 DataChannel 强引用

- 位置：`media-agent/src/peer_transport.cpp:1715`、`media-agent/src/peer_transport.cpp:1741`
- 问题：`onMessage` 已改为只捕获 label，但 `onOpen` 仍捕获 `data_channel_value` shared_ptr，并在回调内直接发送 hello。DataChannel 持有回调、回调又持有 DataChannel，形成强引用环的风险。
- 影响：如果关闭/异常路径没有完整 reset 回调或释放通道，DataChannel、peer transport snapshot 及相关会话资源可能被长期保留，直播反复开关后增加泄漏和状态串扰概率。
- 建议：`onOpen` 与 `onMessage` 一致改为捕获 label/weak runtime，不捕获 DataChannel 强引用；发送 hello 通过受控的 peer/session helper 执行，并在 close/error 路径统一清空回调。
- 修改意见：按建议处理
- 处理结果：已修复。`onOpen` 不再捕获 `DataChannel` shared_ptr，改为通过 `PeerTransportSession::send_data_channel_text()` 短暂取通道发送 hello，避免回调和 DataChannel 形成强引用环。


### MEDIA-AUDIT-P1-002 native DataChannel 控制消息用字符串包含判断代替严格 JSON 校验

- 位置：`media-agent/src/peer_transport.cpp:1800`、`media-agent/src/peer_transport.cpp:1802`、`media-agent/src/peer_transport.cpp:1831`、`media-agent/src/peer_transport.cpp:1854`
- 问题：encoded media control message 通过 `string_contains` 判断 `protocol/type/protocolVersion`，`hello-ack` 分支只看 `type`，没有统一校验 `protocol === vds-media-encoded-v1`、`protocolVersion === 1`、消息结构和 session/manifest 字段。
- 影响：格式畸形或包含相同片段的文本可能驱动 `encoded_media_data_channel_ready` 状态变化；协议版本不匹配时 native 端仍可能进入 ready，导致 Web 与 native 的播放/转发状态不一致。
- 建议：复用现有 JSON 解析/转义工具实现 control message type guard，对 `hello`、`hello-ack`、`error` 全部严格校验 protocol、type、protocolVersion、manifest/session 字段，不合法时返回明确 error 并关闭通道。
- 修改意见：按建议处理
- 处理结果：已修复。新增 native control message 结构化解析，要求根对象、`protocol`、`type`、`protocolVersion` 都合法；`hello/hello-ack/error` 统一走校验和 session/manifest 检查，非法控制消息返回明确 error。


### MEDIA-AUDIT-P1-003 WGC source 启动等待无超时，可能卡死 host 启动

- 位置：`media-agent/src/peer_video_sender.cpp:602`
- 问题：`start_peer_video_sender` 在启动 WGC source 线程后使用 `condition.wait(...)` 无限等待 `finished`，如果 source 线程在创建采集源、启动进程或初始化管道阶段卡住且未调用 finish，调用方会一直阻塞。
- 影响：主播端开始直播或重建媒体 sender 时可能无响应，Electron bridge 的 invoke 最终只能按超时杀 agent，用户侧表现为直播启动失败或长时间卡住。
- 建议：改为 `wait_for/wait_until`，超时后标记 stop、关闭 stdin/process handle、join/detach 线程并返回结构化错误；同时把超时原因写入 peer media state。
- 修改意见：按建议处理
- 处理结果：已修复。WGC source 启动等待改为 15 秒 `wait_for`，超时写入 `wgc-source-start-timeout`，请求停止、关闭 stdin/process、join source thread，并向调用方返回结构化错误。


### MEDIA-AUDIT-P1-004 WGC source 线程无锁写 `stdin_write_handle`

- 位置：`media-agent/src/peer_video_sender.cpp:589`、`media-agent/src/peer_video_sender.cpp:592`、`media-agent/src/peer_video_sender.cpp:607`
- 问题：source 线程关闭 `stdin_write_handle` 后直接比较并写 `runtime->stdin_write_handle = nullptr`，该字段在 stop/refresh/cleanup 路径也会被访问和关闭，其中部分路径使用 `runtime->mutex`。
- 影响：并发停止、切源或启动失败时存在数据竞争和重复 CloseHandle 风险，可能导致采集进程 stdin handle 状态错乱，进一步造成 WGC 子进程残留或写入失败。
- 建议：统一 handle 所有权模型，所有读写和置空都在 `runtime->mutex` 下完成；关闭前先 move 出 handle，确保每个 HANDLE 只有一个关闭者。
- 修改意见：按建议处理
- 处理结果：已修复。source 线程和启动失败清理路径都在 `runtime->mutex` 下取出并置空 `stdin_write_handle`，锁外执行 `CloseHandle`，避免无锁读写和重复关闭。


### MEDIA-AUDIT-P2-001 Web relay 转发分片时只在发送前检查一次 bufferedAmount

- 位置：`vds_web/src/main.ts:650`、`vds_web/src/main.ts:667`、`vds_web/src/main.ts:878`、`vds_web/src/main.ts:895`
- 问题：bootstrap 和普通 relay frame 都在编码分片前只检查一次 `downstreamDataChannel.bufferedAmount`，随后循环发送全部分片；大帧拆分后可能在循环中把 bufferedAmount 推高到阈值以上。
- 影响：下游网络抖动时单个大关键帧或连续帧会造成 DataChannel 队列突增，增加延迟和内存压力；严重时触发浏览器关闭通道，影响多级直播 relay。
- 建议：发送每个分片前复查 bufferedAmount，并使用 `bufferedAmountLowThreshold/onbufferedamountlow` 做背压；超过阈值时丢弃当前 frame 剩余分片并记录可区分的 drop reason。
- 修改意见：按建议处理
- 处理结果：已修复。bootstrap 和普通 relay frame 在每个分片发送前调用 `canSendDataChannelMessage()` 复查 bufferedAmount，并设置 low threshold；超限时停止发送当前帧剩余分片并记录对应 drop reason。


### MEDIA-AUDIT-P2-002 Web 视频延迟解码队列无上限

- 位置：`vds_web/src/main.ts:50`、`vds_web/src/main.ts:851`、`vds_web/src/main.ts:856`、`vds_web/src/main.ts:859`
- 问题：每个收到的视频帧都会创建 `setTimeout` 并保存到 `pendingVideoDecodeTimers`，但没有最大 pending 数量或按时间/关键帧丢弃策略。
- 影响：高帧率、突发重传或主线程繁忙时 pending timer 和 payload ArrayBuffer 会堆积，导致 viewer 内存上涨、解码延迟扩大，最终表现为播放越播越慢。
- 建议：为延迟解码队列增加帧数/字节上限，超过上限时优先丢弃旧 delta 帧并等待下一关键帧；将丢弃原因写入 diagnostics。
- 修改意见：容易造成顿卡，再考虑如何改
- 处理结果：已按保守方案修复。延迟解码队列改为记录 keyframe/timestamp 的 Map，并设置 pending 上限；超限时优先取消旧 delta timer，只有新关键帧进入时才允许替换旧关键帧，避免硬性全队列丢弃造成更明显顿卡。


### MEDIA-AUDIT-P2-003 WebCodecs audio 配置失败后保留未配置 decoder 对象

- 位置：`vds_web/src/webcodecs-audio-player.ts:121`、`vds_web/src/webcodecs-audio-player.ts:137`、`vds_web/src/webcodecs-audio-player.ts:143`
- 问题：`configure()` 先创建 `AudioDecoder`，再调用 `isConfigSupported`；如果能力检测不支持或 decoder 已被关闭，函数直接 `return false`，但 `this.decoder` 仍指向未配置/不可用对象。
- 影响：后续音频帧会反复关闭并重建 decoder，错误状态不够明确；在某些浏览器实现中未配置 decoder 持有底层资源，可能放大音频失败后的 CPU/内存波动。
- 建议：先做 capability check，再创建 decoder；失败路径显式 close 并置空 `this.decoder`、`configuredCodec`，同时输出稳定的 drop reason。
- 修改意见：按建议处理
- 处理结果：已修复。`configure()` 现在先关闭并置空旧 decoder，再做 `isConfigSupported`；能力检测通过后才创建新 `AudioDecoder`，失败路径不再保留未配置 decoder。


### MEDIA-AUDIT-P2-004 Electron native peer 信令 backlog 没有容量上限

- 位置：`server/public/app-native-overrides.js:50`、`server/public/app-native-overrides.js:1018`、`server/public/app-native-overrides.js:1021`、`server/public/app-native-overrides.js:1056`、`server/public/app-native-overrides.js:2650`
- 问题：`nativePeerSignalBacklog` 和 `nativePeerSignalWaiters` 按 peerId 保存信令，但 enqueue 时没有单 peer/global 上限，也没有统一 TTL；只有 close peer 或特定 drop 路径会清理。
- 影响：异常 peerId、重复 offer 或信令乱序时，renderer 内存会随 backlog 增长；长时间直播间切换/重连后可能出现旧信令影响新 peer 或页面性能下降。
- 建议：增加 per-peer 和 global backlog 上限、等待者上限和 TTL 清理；创建新 peer 前清理同 peer 旧 waiters/backlog，并记录丢弃计数。
- 修改意见：按建议处理
- 处理结果：已修复。native peer signal backlog 增加单 peer 上限、全局上限和 TTL prune；waiter 增加单 key 上限；创建/关闭 peer 时会清理同 peer backlog/waiters，出队时去除内部 `__queuedAt` 字段。


### MEDIA-AUDIT-P3-001 viewer audio passthrough 丢包诊断不完整

- 位置：`media-agent/src/viewer_audio_playback.cpp:374`、`media-agent/src/viewer_audio_playback.cpp:379`
- 问题：PCM 队列超出最大缓存时会 `pop_front()` 丢弃旧 block，但没有累计丢弃计数；`runtime.reason` 的三元表达式两个分支都写成 `viewer-audio-passthrough-queued`。
- 影响：音频延迟、卡顿、追帧时无法从 status 中看出真实丢包/重缓冲情况，线上定位媒体质量问题困难。
- 建议：增加 queued/dropped/played PCM block 计数和最近 drop reason；区分 passthrough queued、buffer-trimmed、underflow、startup-buffering 等状态。
- 修改意见：按建议处理
- 处理结果：已修复。viewer audio runtime 新增 `pcmFramesDropped` 计数并输出到 status JSON；队列裁剪时累计丢弃帧数，reason 区分 queued、buffer-queued、buffer-trimmed。


---

## 死代码削减审计补充（2026-06-19）

### DEAD-CODE-P2-001 WebCodecsH264Player 旧兼容别名已无生产引用

- 位置：`vds_web/src/webcodecs-player.ts:316`、`scripts/test-vds-web-protocol.js:284`、`scripts/test-vds-web-protocol.js:383`、`scripts/test-vds-web-protocol.js:470`、`scripts/test-vds-web-protocol.js:556`
- 问题：`WebCodecsH264Player` 只是 `WebCodecsVideoPlayer` 的历史兼容别名，源码生产路径已使用新的通用视频播放器命名，仅测试脚本继续依赖旧名。
- 影响：保留旧别名会让 H.265/HEVC 播放路径继续暴露为 H264 命名，增加后续维护和检索噪音。
- 建议：删除旧别名，测试统一改用 `WebCodecsVideoPlayer`。
- 修改意见：待补充
- 处理结果：已处理。删除 `WebCodecsH264Player` 导出，协议测试中 4 处旧类名引用已统一到 `WebCodecsVideoPlayer`，并通过 `npm run test:vds-web`。


### DEAD-CODE-P2-002 DATA_CHANNEL_BOOTSTRAP_TIMEOUT_MS 未被使用

- 位置：`vds_web/src/datachannel-protocol.ts:6`
- 问题：`DATA_CHANNEL_BOOTSTRAP_TIMEOUT_MS` 是导出的超时常量，但源码、脚本和测试均无引用。
- 影响：导出未用常量会误导后续开发者以为 bootstrap 流程存在独立超时策略，实际运行逻辑没有使用该值。
- 建议：删除该常量，保留当前实际使用的 open/hello-ack 超时常量。
- 修改意见：待补充
- 处理结果：已处理。删除未用导出，执行源码引用搜索未发现残留，并通过 `npm run check:vds-web`。


### DEAD-CODE-P3-001 pendingVideoDecodeTimers 保存未读取 timestampUs

- 位置：`vds_web/src/main.ts:50`、`vds_web/src/main.ts:862`
- 问题：延迟视频解码队列的 timer metadata 保存 `timestampUs`，但裁剪、清理和诊断逻辑均未读取该字段。
- 影响：字段没有功能价值，会让后续维护者误以为队列按时间戳排序或诊断。
- 建议：移除未读取字段，只保留当前裁剪逻辑实际需要的 `keyframe`。
- 修改意见：待补充
- 处理结果：已处理。`pendingVideoDecodeTimers` metadata 精简为 `{ keyframe: boolean }`，移除写入处的 `timestampUs`，并通过 TypeScript 检查。


### DEAD-CODE-P3-002 peer video surface attachment 接口携带未使用 ffmpeg 参数

- 位置：`media-agent/src/surface_attachment_runtime.h:22`、`media-agent/src/surface_attachment_runtime.cpp:70`、`media-agent/src/surface_attachment_runtime.cpp:502`、`media-agent/src/surface_control_runtime.cpp:84`
- 问题：`start_peer_video_surface_attachment` 的 `FfmpegProbeResult` 参数在 Windows 和非 Windows 实现中都未使用，重启路径还需要构造 `unused_ffmpeg` 哑对象才能复用接口。
- 影响：接口暗示 peer surface 启动依赖 FFmpeg 探测结果，但实际只依赖 receiver runtime；哑对象会增加误读和无效构造。
- 建议：从 peer surface attachment 接口移除 `ffmpeg` 参数，首启调用和重启调用都直接传 receiver runtime。
- 修改意见：待补充
- 处理结果：已处理。移除 `start_peer_video_surface_attachment` 的 `ffmpeg` 参数，删除两处 `unused_ffmpeg` 哑对象，更新唯一调用点；`verify-media-agent.ps1` Release 验证通过。


### DEAD-CODE-NOTE-001 动态入口暂未削减

- 位置：`server/public/app.js`、`server/public/app-native-overrides.js`、`desktop/main.js`、`desktop/preload.js`、`media-agent/src/agent_rpc_router.cpp`
- 问题：这些文件大量使用 DOM 事件、Electron IPC、窗口全局对象、JSON-RPC 方法名和 native 回调，静态搜索容易把动态入口误判为死代码。
- 影响：误删会直接破坏 UI 操作、native bridge、直播信令或 RPC 调用链。
- 建议：后续如继续削减，应先补入口级测试或运行时覆盖记录，再按功能域逐段移除。
- 修改意见：待补充
- 处理结果：本轮未删除。只删除了可由引用搜索、TypeScript 检查和 native 构建验证支撑的低风险死代码。


### DEAD-CODE-P3-003 VDS Web 模块内部类型被多余导出

- 位置：`vds_web/src/webcodecs-player.ts:11`、`vds_web/src/diagnostics.ts:3`、`vds_web/src/diagnostics.ts:8`、`vds_web/src/datachannel-protocol.ts:15`、`vds_web/src/datachannel-protocol.ts:24`
- 问题：`VideoFrameDiagnostics`、`IceCounters`、`DiagnosticsSnapshot`、`EncodedMediaCapabilities`、`EncodedMediaControlMessage` 仅在各自模块内部用于类型标注，没有被其他模块或测试导入。
- 影响：多余的 type export 会扩大模块表面，让 ts-prune/knip 等工具持续报告噪音，也误导后续开发者把内部类型当作外部协议。
- 建议：移除这些类型的 `export`，保留模块内部类型声明。
- 修改意见：待补充
- 处理结果：已处理。5 个内部类型改为非导出类型；`npm run check:vds-web` 通过，ts-prune 剩余项只包含协议测试显式覆盖的运行时工具/常量。


### DEAD-CODE-P3-004 native gdigrab hwnd 格式化工具无调用

- 位置：`media-agent/src/platform_utils.h:15`、`media-agent/src/platform_utils.cpp:35`
- 问题：`build_gdigrab_hwnd_target()` 只有头文件声明和实现，没有任何调用点。
- 影响：该函数暗示还存在 gdigrab hwnd target 格式化链路，但实际 host capture 和 native capture 路径没有使用它，增加平台工具模块噪音。
- 建议：删除声明和实现。
- 修改意见：待补充
- 处理结果：已处理。删除函数声明和实现；C++ 头文件声明扫描未再发现该符号，`verify-media-agent.ps1` Release 验证通过。


### DEAD-CODE-P3-005 OBS ingest 微秒时间戳 helper 无调用

- 位置：`media-agent/src/obs_ingest_media.h:25`、`media-agent/src/obs_ingest_media.cpp:95`
- 问题：`packet_timestamp_us()` 只有声明和实现，没有调用点；当前 OBS ingest RTP 路径使用 `packet_timestamp_at_clock_rate()`。
- 影响：保留未用 helper 会让后续维护者误判存在微秒时间戳输出路径。
- 建议：删除声明和实现，保留实际使用的 RTP clock-rate 时间戳函数。
- 修改意见：待补充
- 处理结果：已处理。删除未调用 helper；C++ 头文件声明扫描无剩余低引用候选，`verify-media-agent.ps1` Release 验证通过。


### DEAD-CODE-NOTE-002 静态工具剩余项保留原因

- 位置：`vds_web/src/datachannel-protocol.ts:6`、`vds_web/src/datachannel-protocol.ts:7`、`vds_web/src/datachannel-protocol.ts:98`、`vds_web/src/datachannel-protocol.ts:146`、`desktop/preload.js`、`desktop/window-metadata-helper.js`、`server/public/app.js`、`server/public/app-native-overrides.js`
- 问题：ts-prune/knip 仍报告若干项，但它们属于测试可见协议工具、Electron preload/子进程入口、浏览器脚本入口或动态加载入口。
- 影响：这些项被静态工具误报；删除会破坏协议单测、Electron bridge、桌面采集元数据或浏览器端运行。
- 建议：暂不删除；后续若要继续收敛工具输出，应为 knip/ts-prune 增加项目配置，把这些入口和测试协议面列入 ignore/entry，而不是删除代码。
- 修改意见：待补充
- 处理结果：本轮保留。已通过引用搜索确认 `desktop/window-metadata-helper.js` 由 `desktop/main.js` 子进程调用，`desktop/preload.js` 由 Electron BrowserWindow preload 使用，`server/public/app*.js` 为静态页面入口；协议工具/常量由 `scripts/test-vds-web-protocol.js` 覆盖。


### DEAD-CODE-P3-006 前端样式表存在无引用选择器

- 位置：`vds_web/src/styles.css:234`、`server/public/style.css:440`、`server/public/style.css:1256`、`server/public/style.css:1367`、`server/public/style.css:1579`、`server/public/style.css:2537`
- 问题：CSS 类名扫描发现 VDS Web 和 Electron 主页面样式表中存在不再被 HTML、JS 动态创建或 native override 使用的选择器，包括 `btn-danger`（VDS Web）、`mode-buttons`、`quality-row`、`source-badge`、`source-note`、`source-preview-toggle`、`source-audio-actions`、`source-audio-process-name/meta`、`source-audio-empty`、旧 `landing-divider-*`、旧 `workspace-header/meta-grid`、`viewer-passthrough-*` 等。
- 影响：无引用样式会增加主样式表维护成本，掩盖当前实际 DOM 结构，并让后续 UI 修改误以为旧布局仍存在。
- 建议：删除确认无引用的选择器；保留 JS 仍动态创建或 DOM 仍使用的类，例如 `source-audio-process-item`、`workspace-side-*`、`landing-half-*`。
- 修改意见：待补充
- 处理结果：已处理。删除无引用 CSS 规则和组合选择器中的死类，复跑 CSS 类名扫描后 `server/public/style.css` 与 `vds_web/src/styles.css` 均无未引用类候选。


### DEAD-CODE-P3-007 HTML 中存在无引用 id 属性

- 位置：`server/public/index.html:113`、`server/public/index.html:121`、`server/public/index.html:180`、`server/public/index.html:235`、`vds_web/index.html:10`
- 问题：DOM id 扫描发现 `host-p2p-diagnostic`、`host-capture-diagnostic`、`viewer-p2p-diagnostic`、`viewer-fullscreen-volume-icon`、`app` 只在 HTML 声明处出现，没有被 JS、CSS、测试脚本或文档锚点引用。诊断卡片内部实际被脚本使用的是 output/button 子元素 id，音量图标状态依赖 class，VDS Web 根节点布局依赖 `app-shell` class。
- 影响：无引用 id 会扩大 DOM API 表面，后续维护时容易误以为外层容器或 SVG 图标存在脚本绑定。
- 建议：移除这些无引用 id 属性，保留元素、class、层级和子元素 id 不变。
- 修改意见：待补充
- 处理结果：已处理。移除 5 个无引用 id 属性；保留诊断卡片、全屏音量 SVG、VDS Web 主布局结构和所有被脚本查询的子元素 id。`remote-audio` 仅确认 id 未引用，因音频播放链路涉及 native/WebRTC/browser fallback，本轮未删除元素，等待后续媒体播放路径覆盖后再判断。
- 补充处理结果：已继续处理 `remote-audio` 的无引用 id，只移除 id 属性并保留隐藏 `<audio>` 元素；本条目累计移除 6 个无引用 id 属性。


### DEAD-CODE-P3-008 OBS AAC sample-rate helper 暴露为无外部调用 API

- 位置：`media-agent/src/obs_ingest_media.h:19`、`media-agent/src/obs_ingest_media.cpp:10`
- 问题：`aac_sample_rate_index()` 只被 `parse_aac_config()` 在 `obs_ingest_media.cpp` 内部调用，但头文件仍对外声明该 helper。
- 影响：外部头文件暴露了没有跨模块调用需求的内部实现细节，扩大了 OBS ingest media 模块 API 表面，也会让后续低引用扫描持续把它列为疑似候选。
- 建议：删除头文件声明，将 helper 限定在 `.cpp` 文件内部，保留 AAC config 解析行为不变。
- 修改意见：待补充
- 处理结果：已处理。移除 `obs_ingest_media.h` 中的 `aac_sample_rate_index()` 声明，并把实现放入 `obs_ingest_media.cpp` 的匿名 namespace；`parse_aac_config()` 继续使用该内部 helper。


### DEAD-CODE-P3-009 前端脚本存在无引用内部函数

- 位置：`server/public/app.js:527`、`server/public/app.js:534`、`server/public/app.js:685`、`server/public/app.js:689`、`server/public/app.js:1427`、`server/public/app.js:3830`、`server/public/app.js:3834`、`server/public/app-native-overrides.js:136`
- 问题：低引用函数扫描发现若干内部函数只有定义，没有被 HTML 事件、主脚本、native override、测试或脚本入口引用，包括旧 debug getter、viewer 播放/join getter、未调用的 viewer media pipeline reset helper、旧音频选择 wrapper，以及 native override 中未调用的 `shouldShowDebugLogs()`。
- 影响：这些函数保留了旧流程或旧抽象的影子，容易让后续维护者误以为仍存在二级音频选择弹窗、legacy viewer reset 调用或独立 debug getter API。
- 建议：删除无引用函数；保留被 native override 跨文件调用的函数和 requireNativeAuthorityOverride 代理函数。
- 修改意见：待补充
- 处理结果：已处理。删除 `isDebugCategoryEnabled()`、`isDebugChannelEnabled()`、`isViewerPlaybackPassthroughMode()`、`isViewerJoinLocked()`、`resetViewerMediaPipeline()`、`confirmAudioProcess()`、`skipAudioCapture()` 和 `shouldShowDebugLogs()`；保留 `queueRemoteCandidate()`、`clearPeerReconnect()`、`clearPeerConnectionTimeout()`、`clearPeerDisconnectTimer()`、`updateViewerCount()` 等跨文件调用函数。


### DEAD-CODE-P3-010 桌面 NAT 映射存在未调用 cleanup bookkeeping

- 位置：`desktop/main.js:43`、`desktop/main.js:933`、`desktop/main.js:1174`、`desktop/main.js:1196`
- 问题：`ipv4ToBuffer()` 没有调用点；`releaseActiveNatMappings()` 没有被 quit/lifecycle 入口调用，导致 `activeNatMappings` 只在 `openP2PNatMappings()` 成功分支写入，从不读取。
- 影响：这段 bookkeeping 暗示 NAT-PMP/PCP 映射会在退出时释放，但实际当前生命周期不会调用 release 逻辑；保留只写 map 会增加误导和少量状态噪音。
- 建议：删除未调用 helper、未调用 cleanup 函数和只写 map；保留实际仍被 IPC 调用的 NAT-PMP/PCP 映射请求逻辑。
- 修改意见：待补充
- 处理结果：已处理。删除 `ipv4ToBuffer()`、`releaseActiveNatMappings()`、`activeNatMappings` 以及 `openP2PNatMappings()` 中的只写记录分支；保留 `p2p-open-nat-mapping` IPC、NAT-PMP/PCP 请求和 mapped ICE candidate 构造。


### DEAD-CODE-P3-011 主页面样式表存在无引用 CSS 自定义属性

- 位置：`server/public/style.css:1373`、`server/public/style.css:1374`、`server/public/style.css:1375`、`server/public/style.css:1376`、`server/public/style.css:1379`、`server/public/style.css:1380`
- 问题：`:root` 中的 `--vds-white-strong`、`--vds-line`、`--vds-line-strong`、`--vds-muted-dark`、`--vds-radius-xl`、`--vds-radius-lg` 只定义未被任何 `var(--...)` 引用。
- 影响：未使用 design token 会扩大样式 API 表面，让后续 UI 调整误以为这些 token 仍是当前设计系统的一部分。
- 建议：删除未引用 CSS 自定义属性，保留实际被引用的 `--vds-black`、`--vds-white`、`--vds-muted-light`、`--vds-shadow`。
- 修改意见：待补充
- 处理结果：已处理。删除 6 个无引用 CSS 自定义属性；复扫后 `server/public/style.css` 与 `vds_web/src/styles.css` 均无未引用 CSS 变量候选。


### DEAD-CODE-P3-012 主页面存在只写不读的 window 调试/桥接出口

- 位置：`server/public/app.js:961`、`server/public/app.js:1067`、`server/public/app.js:1068`、`server/public/app.js:1070`、`server/public/app.js:1071`
- 问题：`window.__vdsUpdatePublicRoomsPollingState`、`window.__vdsDebugCategoryDefinitions`、`window.__vdsDebugChannelDefinitions`、`window.__vdsGetDebugConfig`、`window.__vdsGetViewerPlaybackPrefs` 只赋值没有任何读取者；native override 当前读取的是 `__vdsHandleViewerJoinSucceeded`、`__vdsRenderHostPublicListingUi`、`__vdsRenderViewerPlaybackPrefsUi`、`__vdsShouldDebugLog` 等仍保留出口。
- 影响：只写全局属性会扩大 renderer 全局 API 表面，让调试和 native bridge 边界变得不清晰。
- 建议：删除没有消费者的全局出口，保留跨脚本实际调用的桥接函数。
- 修改意见：待补充
- 处理结果：已处理。删除 5 个只写不读的 `window.__vds...` 出口；复扫后这些名称只剩审计文档记录。


### DEAD-CODE-P3-013 WASAPI audio backend probe 缓存链只写不读

- 位置：`media-agent/src/agent_runtime.h:222`、`media-agent/src/agent_runtime.h:453`、`media-agent/src/agent_lifecycle.cpp:175`、`media-agent/src/media_audio.h:47`、`media-agent/src/media_audio.cpp:784`、`media-agent/src/media_audio.cpp:827`、`media-agent/src/wasapi_backend.h:10`
- 问题：`AudioBackendProbe` 结构、`AgentRuntimeState.audio_backend_probe` 字段、`build_audio_backend_probe()` 和 `build_audio_session_state(AudioBackendProbe)` 只用于初始化时写入一份 probe 缓存，但状态/能力输出实际读取的是 `AudioSessionState audio_session`。`WasapiProbeResult.process_loopback_targeted` 也只有默认字段，没有写入或输出。
- 影响：保留这条缓存链会让音频状态来源看起来有两套并行模型，增加 WASAPI 状态维护噪音。
- 建议：删除只写 probe 缓存链和无输出字段；保留 `WasapiSessionStatus -> AudioSessionState` 的实际状态路径。
- 修改意见：待补充
- 处理结果：已处理。删除 `AudioBackendProbe`、`AgentRuntimeState.audio_backend_probe`、`build_audio_backend_probe()`、`build_audio_session_state(AudioBackendProbe)`、初始化赋值和 `WasapiProbeResult.process_loopback_targeted`；`audioBackend` JSON 继续由 `get_wasapi_process_loopback_session_status()` 构造的 `AudioSessionState` 输出。


### DEAD-CODE-P3-014 VDS Web relay keyframe cache 存在只写 timestamp 字段

- 位置：`vds_web/src/main.ts:58`、`vds_web/src/main.ts:823`
- 问题：`lastVideoKeyframeForRelay.capturedAt` 在接收关键帧时写入 `Date.now()`，但 relay bootstrap 发送逻辑只读取 `timestampUs`、`sequence`、`payload` 和 `payloadFormat`。
- 影响：只写字段会让后续维护者误以为 bootstrap keyframe 有本地捕获时间或 TTL 逻辑，但当前没有任何判断使用它。
- 建议：删除 `capturedAt` 类型字段和写入，保留实际用于去重和转发的字段。
- 修改意见：待补充
- 处理结果：已处理。移除 `capturedAt` 字段和 `Date.now()` 写入；`sendRelayBootstrapKeyframe()` 行为不变。


### DEAD-CODE-P3-015 WASAPI probe 存在只写 COM 初始化字段

- 位置：`media-agent/src/wasapi_backend.h:7`、`media-agent/src/wasapi_backend.cpp:736`
- 问题：`WasapiProbeResult.com_initialized` 只在 `probe_wasapi_backend()` 的 COM 初始化成功分支写入，但没有被 `apply_probe_to_status()`、session snapshot、状态 JSON 或失败路径读取。
- 影响：该字段让 probe 结果看起来会输出或参与 WASAPI 可用性判断，但当前实际判断只依赖 `platform_supported`、`device_enumerator_available`、`render_device_count`、`reason` 和 `last_error`。
- 建议：删除只写字段和赋值，保留 COM 初始化失败时的 `reason/last_error` 行为不变。
- 修改意见：待补充
- 处理结果：已处理。移除 `WasapiProbeResult.com_initialized` 字段和成功分支赋值，并把 probe 初始化判断改为只处理失败路径；WASAPI 状态输出和 session 行为不变。


### DEAD-CODE-P3-016 Peer media manifest 存在只写 payloadFormat 字段

- 位置：`media-agent/src/agent_runtime.h:145`、`media-agent/src/agent_runtime.h:146`、`media-agent/src/peer_control_runtime.cpp:132`、`media-agent/src/peer_control_runtime.cpp:133`
- 问题：`PeerState.expected_video_payload_format` 和 `PeerState.expected_audio_payload_format` 在 `apply_media_manifest_to_peer()` 中从 media manifest 写入，但 native peer 接收校验只读取 `expected_video_codec` 和 `expected_audio_codec`，payload format 字段没有任何消费者。
- 影响：只写字段会让后续维护者误以为 native peer 侧已根据 manifest 的 `payloadFormat` 做格式校验或分流，但当前实际播放/解码路径并不读取它。
- 建议：删除 payloadFormat 缓存字段和写入，保留 codec manifest 应用、transport codec 设置以及 encoded frame codec mismatch 校验。
- 修改意见：待补充
- 处理结果：已处理。移除 `expected_video_payload_format`、`expected_audio_payload_format` 字段和 manifest 写入；保留 `expected_video_codec`、`expected_audio_codec` 及对应 codec 校验逻辑。


### DEAD-CODE-P3-017 Native media runtime 存在只写镜像字段和计数

- 位置：`media-agent/src/agent_runtime.h:59`、`media-agent/src/agent_runtime.h:105`、`media-agent/src/agent_runtime.h:410`、`media-agent/src/agent_runtime.h:411`、`media-agent/src/agent_runtime.h:495`、`media-agent/src/peer_video_sender.cpp:168`、`media-agent/src/viewer_video_pipeline.cpp:156`、`media-agent/src/media_audio.cpp:747`、`media-agent/src/viewer_audio_playback.cpp:284`、`media-agent/src/viewer_audio_playback.cpp:306`
- 问题：`PeerVideoSenderRuntime.source_backend`、`PeerVideoReceiverRuntime.last_remote_frame_at_unix_ms`、`HostAudioDispatchState.dropped_capture_packets` 只有赋值没有读取；`AgentRuntimeState.viewer_playback_mode` 和 `AgentRuntimeState.viewer_audio_delay_ms` 只是命令处理中的顶层镜像，真正被播放线程和状态 JSON 使用的是 `viewer_audio_playback.passthrough_mode`、`viewer_audio_playback.passthrough_audio_delay_ms`。
- 影响：这些字段让运行态看起来存在额外诊断输出、延迟状态源或 capture backend 状态源，但当前没有消费者，会增加媒体运行态结构维护噪音。
- 建议：删除只写字段和赋值；保留实际生效的 codec path、remote frame counters、audio queue 行为，以及 viewer audio playback runtime 字段。
- 修改意见：待补充
- 处理结果：已处理。移除上述 5 个只写字段及对应赋值/累加；viewer 播放模式和音频延迟仍通过 `viewer_audio_playback` runtime 生效，host audio queue 满时仍执行丢弃旧包逻辑。


### DEAD-CODE-P3-018 Peer manifest 校验旧 helper 已无调用点

- 位置：`media-agent/src/peer_control_runtime.cpp:154`
- 问题：`validate_encoded_frame_against_manifest()` 原本通过 `PeerState` 读取 manifest codec 并校验 encoded frame；当前 data channel frame 回调已经在创建时捕获 `expected_video_codec`、`expected_audio_codec` 并内联执行同等校验，该 helper 没有任何调用点。
- 影响：保留旧 helper 会让 manifest 校验路径看起来仍依赖可变 `PeerState` 查询，和当前回调内捕获的实际校验路径不一致。
- 建议：删除无调用 helper，保留当前回调内的 codec mismatch 校验和 warning event 行为。
- 修改意见：待补充
- 处理结果：已处理。删除 `validate_encoded_frame_against_manifest()`；`media-manifest-video-codec-mismatch`、`media-manifest-audio-codec-mismatch` 仍由 data channel frame 回调直接产生。


### DEAD-CODE-P3-019 Server room 销毁流程存在只写 destroyedAt 字段

- 位置：`server/server-core.js:784`
- 问题：`destroyRoom()` 在删除 room 前写入 `room.destroyedAt = Date.now()`，但 room 随后立即从 `rooms` map 删除，且没有日志、测试、resume、public listing 或诊断路径读取该字段。
- 影响：只写 timestamp 会让房间生命周期看起来存在销毁时间诊断或后续清理依据，但当前实际销毁日志只读取 `destroyReason`。
- 建议：删除只写 `destroyedAt` 赋值，保留 `destroyReason` 和删除流程。
- 修改意见：待补充
- 处理结果：已处理。移除 `room.destroyedAt = Date.now()`；`destroyReason` 日志、session token 清理、viewer 状态清理和 `rooms.delete()` 行为不变。


### DEAD-CODE-P3-020 主页面 elements 映射存在未读取 source modal 项

- 位置：`server/public/app.js:1457`、`server/public/app.js:1461`、`server/public/app.js:1462`
- 问题：`elements.remoteVideoContainer`、`elements.sourceModal` 和 `elements.sourceList` 在 elements 映射中初始化，但后续没有通过 `elements.*` 读取；native override 使用自己的局部 `remoteVideoContainer`，源选择弹窗逻辑当前直接调用 `document.getElementById('source-modal')` 和 `document.getElementById('source-list')`。
- 影响：保留未读取映射项会让 DOM 绑定表看起来仍统一管理 source modal，但实际行为已经走局部查询，增加维护噪音。
- 建议：删除未读取映射项，保留 HTML id、CSS selector、native override 局部查询和现有局部 DOM 查询。
- 修改意见：待补充
- 处理结果：已处理。移除 `elements.remoteVideoContainer`、`elements.sourceModal`、`elements.sourceList` 三个未读取映射项；远端视频容器 HTML/CSS/native override 局部引用、源列表渲染、确认/取消按钮和弹窗显示/隐藏逻辑不变。


### DEAD-CODE-P3-021 Native live preview 存在无调用内部 helper

- 位置：`media-agent/src/native_live_preview.cpp:276`、`media-agent/src/native_live_preview.cpp:353`
- 问题：`resolve_placeholder_window_dimensions()` 只定义没有任何调用点；`is_embedded_content_window_class()` 与实际使用的 `is_render_widget_window_class()` 逻辑重复，但本身没有调用点。
- 影响：无调用 helper 会让 native live preview 代码看起来仍存在 placeholder 尺寸解析路径和第二套 embedded content class 判定路径，增加维护噪音。
- 建议：删除无调用 helper，保留实际被枚举回调使用的 `is_render_widget_window_class()`、`get_window_capture_rect()` 和嵌入父窗口解析逻辑。
- 修改意见：待补充
- 处理结果：已处理。删除 `resolve_placeholder_window_dimensions()` 和 `is_embedded_content_window_class()`；live preview 的窗口矩形解析、popup owner 激活和 render widget 枚举逻辑不变。


### DEAD-CODE-P3-022 主页面样式存在重复 selector 条目

- 位置：`server/public/style.css:1734`、`server/public/style.css:2817`、`server/public/style.css:2826`
- 问题：多个 selector list 中同一个 `#room-id-input` selector 连续重复两次，包括普通输入样式和 viewer 视图覆盖样式。
- 影响：重复 selector 不改变最终样式，但增加 CSS 维护噪音，也会让重复 selector 扫描持续报出同一项。
- 建议：删除重复 selector 行，保留同一规则块和声明不变。
- 修改意见：待补充
- 处理结果：已处理。移除 3 处重复 `#room-id-input` selector 条目；输入框普通样式、viewer 覆盖样式和声明内容不变。


### DEAD-CODE-P3-023 Public 目录存在无引用且内容无效的 favicon 资源

- 位置：`server/public/favicon.ico`
- 问题：`server/public/favicon.ico` 文件内容不是 ICO/PNG 图标，而是一次 301 跳转响应的 HTML 片段；项目内也没有 `rel="icon"`、`shortcut icon` 或显式 `/favicon.ico` 引用。
- 影响：该文件既不能作为有效浏览器图标渲染，也会让静态资源目录保留一个来源不明的坏资源；浏览器按约定请求 `/favicon.ico` 时反而会收到错误格式内容。
- 建议：删除该无效静态资源；如果后续需要品牌图标，再以有效 `.ico`/`.png` 资源和明确 HTML 引用补回。
- 修改意见：待补充
- 处理结果：已处理。删除 `server/public/favicon.ico`；当前前端入口未声明 favicon，Docker public 目录复制和 server 静态托管不依赖该文件。


### DEAD-CODE-P3-024 主页面和 Web viewer 存在无消费者的 HTML class token

- 位置：`server/public/index.html:135`、`server/public/index.html:182`、`server/public/index.html:202`、`server/public/index.html:243`、`server/public/index.html:305`、`server/public/index.html:316`、`server/public/index.html:362`、`server/public/index.html:371`、`server/public/index.html:395`、`server/public/index.html:404`、`server/public/index.html:414`、`vds_web/index.html:62`
- 问题：`workspace-action-card`、`workspace-join-card`、`viewer-fullscreen-icon-wave-low`、`quality-segment-group-compact` 和 `diagnostics-header` 只出现在 HTML class 属性中，没有 CSS selector、JS classList/querySelector、测试或文档消费者。
- 影响：这些 class token 不改变当前样式和行为，但会让 DOM/CSS 对齐扫描持续报告无引用标记，也会误导后续维护者以为存在专用样式钩子。
- 建议：从 HTML class 属性中删除无消费者 token，保留同一元素上仍被 CSS/JS 使用的 class、id 和 aria 属性。
- 修改意见：待补充
- 处理结果：已处理。移除上述无消费者 class token；保留 `workspace-card`、`workspace-block`、`quality-segment-group`、`quality-segment-group-wrap`、`quality-backend-options`、`viewer-fullscreen-icon-wave` 等实际样式/脚本钩子，页面结构和控件 id 不变。


### DEAD-CODE-P3-025 Native runtime 存在只写刷新标记和 waveOut 句柄镜像

- 位置：`media-agent/src/agent_runtime.h:425`、`media-agent/src/agent_runtime.h:426`、`media-agent/src/agent_runtime.h:471`、`media-agent/src/host_session_controller.cpp:178`、`media-agent/src/host_session_controller.cpp:374`、`media-agent/src/peer_media_binding_runtime.cpp:81`、`media-agent/src/viewer_audio_playback.cpp:77`、`media-agent/src/viewer_audio_playback.cpp:199`
- 问题：`host_video_sender_refresh_requested` 和 `host_video_sender_refresh_reason` 只在 host session 启停、peer media binding refresh 完成后清空，没有置 true、读取或状态输出；`ViewerAudioPlaybackRuntime.wave_out` 只是把 worker 内局部 `HWAVEOUT` 写入 runtime 后在退出时清空，没有读取点，实际播放和关闭都使用 worker 局部句柄。
- 影响：这些字段让运行态看起来存在 host video sender 延迟刷新请求队列和跨线程 waveOut 控制句柄，但当前没有消费者，会增加 native runtime 状态结构噪音。
- 建议：删除只写字段和赋值；保留现有 host media binding refresh 流程、viewer audio worker 局部 waveOut 生命周期、`stop_requested`/`cv` 停止机制和状态计数。
- 修改意见：待补充
- 处理结果：已处理。移除 `host_video_sender_refresh_requested`、`host_video_sender_refresh_reason`、`ViewerAudioPlaybackRuntime.wave_out` 及对应写入/清空；host session 启停、peer media binding refresh、viewer audio waveOut 打开/写入/重置/关闭流程不变。


### DEAD-CODE-P3-026 主页面 viewer 舞台存在无消费者的隐藏 audio 节点

- 位置：`server/public/index.html:169`
- 问题：viewer 舞台内的匿名 `<audio autoplay style="display:none"></audio>` 没有 `id`、class 或 dataset，也没有任何 `querySelector('audio')`、`createElement('audio')`、样式 selector、测试或 native override 消费者。当前主页面 WebRTC 函数要求 native authority override，浏览器 media-track fallback 不存在；`vds_web` 在收到传统 WebRTC media track 时会标记为不支持，native viewer 音频播放走 native/datachannel 管线。
- 影响：该节点不会承载当前音频播放，但会误导维护者以为存在独立 HTMLAudioElement 回放或 fallback 路径。
- 建议：删除匿名隐藏 audio 节点，保留实际使用的 `#remote-video`、native viewer 音频播放控制和 datachannel 音视频路径。
- 修改意见：待补充
- 处理结果：已处理。移除匿名隐藏 audio 节点；`#remote-video`、viewer 等待提示、全屏控制条、native viewer 音频偏好和 vds_web datachannel 播放路径不变。


### DEAD-CODE-P3-027 Runtime 目录存在无引用旧更新产物

- 位置：`runtime/updates/latest.yml`、`runtime/updates/VDS-Setup-1.4.0.exe`、`runtime/updates/VDS-Setup-1.4.0.exe.blockmap`
- 问题：旧 1.4.0 更新包位于被 `.gitignore` 排除的 `runtime/updates`，但当前更新服务、Docker 上下文校验、发布准备和 release check 均使用 `server/updates`；项目代码没有 `runtime/updates` 消费者。
- 影响：保留旧 installer 和 blockmap 会占用本地工作区空间，并误导维护者以为 runtime 目录也参与更新发布链路。
- 建议：删除 `runtime/updates` 下旧更新产物；保留 `runtime/media-agent` 本地运行时二进制和 `server/updates` 正式更新产物目录。
- 修改意见：待补充
- 处理结果：已处理。删除 `runtime/updates` 下 1.4.0 的 `latest.yml`、installer 和 blockmap；当前自动更新 feed 仍由 `server/updates` 提供，release 脚本和 Docker 校验路径不变。


### DEAD-CODE-P3-028 Native host session 存在只写 sourceId 镜像字段

- 位置：`media-agent/src/agent_runtime.h:423`、`media-agent/src/host_session_controller.cpp:171`、`media-agent/src/host_session_controller.cpp:198`、`media-agent/src/host_session_controller.cpp:367`
- 问题：`AgentRuntimeState::host_capture_source_id` 只在 `startHostSession` 请求中从 `sourceId` 写入，并在 OBS ingest 分支和停止会话时清空；捕获计划、WGC/gdigrab 选择、状态 JSON、诊断 JSON 和测试都不读取该字段。实际 native 捕获使用 `captureTargetId`、`captureHwnd`、`displayId`、`captureKind` 和 `captureState`。
- 影响：该字段会误导维护者以为 media-agent 内部仍按 Electron `sourceId` 做捕获目标解析，但当前解析已经在 renderer/main 侧完成后传入 native 所需字段。
- 建议：删除只写字段和相关赋值/清空，保留实际使用的 capture target/runtime 字段。
- 修改意见：待补充
- 处理结果：已处理。移除 `host_capture_source_id` 字段、`sourceId` 写入和两处清空；host session 请求解析、OBS ingest 分支、停止会话重置和 native 捕获计划输入不变。


### DEAD-CODE-P3-029 Relay subscriber 存在只写视频发送 deadline 字段

- 位置：`media-agent/src/agent_runtime.h:505`、`media-agent/src/relay_dispatch.cpp:475`、`media-agent/src/relay_dispatch.cpp:491`
- 问题：`RelaySubscriberState::next_video_send_deadline_steady_us` 只在 relay subscriber 注册/复用时重置为 `-1`，没有调度读取、写入更新、状态 JSON 输出或测试引用；当前 relay video dispatch worker 直接按队列 fanout，不使用 per-subscriber deadline。
- 影响：该字段会误导维护者以为 relay video fanout 已存在按订阅者 deadline 节流/调度机制，但当前没有对应实现。
- 建议：删除只写字段和两处重置赋值，保留实际输出的 `last_video_timestamp_us`、发送计数、bootstrap 状态和 worker queue。
- 修改意见：待补充
- 处理结果：已处理。移除 `next_video_send_deadline_steady_us` 字段及注册/复用时的重置；relay subscriber 注册、bootstrap 状态、fanout queue 和 runtime JSON 不变。


### DEAD-CODE-P3-030 Dist 目录存在不参与当前发布链路的历史 installer

- 位置：`dist/VDS-Setup-1.5.4.exe` 至 `dist/VDS-Setup-1.6.5.exe`
- 问题：当前 `package.json` 版本、`dist/latest.yml`、`server/updates/latest.yml` 和 `release-check` 均指向 `VDS-Setup-1.6.6.exe`；旧版本 installer 位于被 `.gitignore` 排除的 `dist/` 生成目录，不参与当前自动更新 feed、release check 或 server Docker 上下文。
- 影响：历史 installer 每个约 225MB，长期保留会显著占用本地工作区空间，并让发布目录看起来包含多个可发布主安装包。
- 建议：删除旧版本 `.exe` 主安装包，保留当前 `1.6.6` installer、`latest.yml` 以及历史 `.blockmap`，避免影响当前 release 校验和旧版本差分保留策略。
- 修改意见：待补充
- 处理结果：已处理。删除 `dist` 下 1.5.4-1.6.5 的历史 installer；`dist/latest.yml`、`dist/VDS-Setup-1.6.6.exe`、`dist/VDS-Setup-1.6.6.exe.blockmap` 和 `server/updates` 当前发布资产不变。


### DEAD-CODE-P3-031 Electron preload 暴露了无消费者桥接 API

- 位置：`desktop/preload.js:16`、`desktop/preload.js:18`、`desktop/preload.js:44`
- 问题：`electronAPI.getVersion`、`electronAPI.getPlatform` 和 `electronAPI.showNotification` 只在 preload bridge 中暴露，没有 renderer、native override、脚本、文档或测试消费者；其中 `getVersion`/`getPlatform` 也没有对应 IPC handler，`showNotification` 没有任何调用点。
- 影响：多余桥接出口扩大 preload API 面，让后续维护者误以为渲染层仍需要 Electron 版本、平台快捷读取或系统通知能力。
- 建议：删除无消费者 bridge API，保留当前实际使用的 `getAppVersion`、`getRuntimeConfig`、窗口控制、更新和 mediaEngine API。
- 修改意见：待补充
- 处理结果：已处理。移除 `getVersion`、`getPlatform` 和 `showNotification` 三个 preload 出口；当前版本显示仍通过 `getAppVersion`，运行配置仍通过 `getRuntimeConfig`。


### DEAD-CODE-P3-032 Electron 存在无消费者的旧桌面源 IPC 出口

- 位置：`desktop/preload.js:30`、`desktop/main.js:173`
- 问题：`electronAPI.getDesktopSources()` 只调用 `get-desktop-sources` IPC，但 renderer 当前源选择走 `electronAPI.mediaEngine.listCaptureTargets()`；项目内没有 `getDesktopSources` 或 `get-desktop-sources` 消费者。主进程 handler 也只服务这个旧 bridge 出口。
- 影响：旧 IPC 出口会让维护者误以为仍存在绕过 mediaEngine capture target 规范化的源列表路径。
- 建议：删除 preload bridge 出口和对应 IPC handler，保留 `listDesktopSources()` helper，因为它仍由 `listCaptureTargets()` 使用。
- 修改意见：待补充
- 处理结果：已处理。移除 `electronAPI.getDesktopSources()` 和 `ipcMain.handle('get-desktop-sources')`；源选择继续通过 `mediaEngine.listCaptureTargets()` 获取规范化 capture target。


### DEAD-CODE-P3-033 Electron mediaEngine bridge 存在无消费者控制/旧音频出口

- 位置：`desktop/preload.js:42`、`desktop/preload.js:44`、`desktop/preload.js:50`、`desktop/preload.js:79`、`desktop/main.js:186`、`desktop/main.js:188`、`desktop/main.js:220`、`desktop/main.js:1805`
- 问题：`electronAPI.mediaEngine.getStatus`、`stop`、`getAudioBackendStatus` 和 `onNativeAudioData` 没有 renderer 消费者；对应 IPC handler/事件转发只服务这些旧 bridge 出口。当前 renderer 通过 `mediaEngine.start()`、`onStatus()`、`onEvent()`、`getStats()` 和 `start/stopAudioSession()` 获取实际状态与音频信息。
- 影响：保留旧出口会扩大 preload API 面，并让维护者误以为存在独立的 native audio data 订阅路径、renderer 主动 stop agent 路径或旧音频 backend 状态路径。
- 建议：删除无消费者 bridge 出口、对应 IPC handler 和旧 `media-engine-native-audio-data` 转发；保留主进程内部 `MediaAgentManager.getStatus()/stop()` 用于生命周期和退出清理。
- 修改意见：待补充
- 处理结果：已处理。移除上述 4 个 mediaEngine bridge 出口、3 个无消费者 IPC handler 和旧 native audio data 转发；现有状态事件、media-agent 生命周期清理、音频事件 summary 和 stats 路径不变。


### DEAD-CODE-P3-034 Electron 主进程保留了无调用 runtime config IPC

- 位置：`desktop/main.js:160`
- 问题：`ipcMain.handle('get-runtime-config')` 没有 preload 或 renderer 消费者；当前 `electronAPI.getRuntimeConfig()` 在 preload 中直接返回同一组环境派生配置，不走 IPC。
- 影响：保留无调用 IPC handler 会让运行配置来源看起来存在主进程异步通道和 preload 同步通道两套实现，增加维护噪音。
- 建议：删除无调用 IPC handler，保留当前实际使用的 preload `getRuntimeConfig()`。
- 修改意见：待补充
- 处理结果：已处理。移除 `get-runtime-config` IPC handler；renderer 运行配置仍通过 `window.electronAPI.getRuntimeConfig()` 读取。


### DEAD-CODE-P3-035 原生关闭确认事件存在发送侧与接收侧断链

- 位置：`desktop/main.js:419`、`desktop/preload.js:91`、`server/public/app.js:2705`
- 问题：前期审计修复让主进程在原生 close 事件中发送 `request-close-confirmation`，但 preload 没有暴露订阅出口，renderer 也没有监听该事件；发送侧变成无消费者事件，且 Alt+F4/任务栏关闭仍无法打开确认弹窗。
- 影响：该事件链看起来已经修复关闭确认路径，实际运行时 renderer 无法接收，既形成无效事件发送，也保留用户关闭窗口无反馈的问题。
- 建议：补齐 preload 订阅出口并让 renderer 复用现有关闭确认弹窗；不要删除主进程发送侧，因为它是原生关闭入口的必要行为。
- 修改意见：待补充
- 处理结果：已处理。新增 `electronAPI.onCloseConfirmation()` 订阅 `request-close-confirmation`，renderer 收到后打开现有关闭确认弹窗；主进程 close 事件发送侧保留。


### DEAD-CODE-P3-036 Electron audio 子桥接保留旧主动捕获/事件出口

- 位置：`desktop/preload.js:117`、`desktop/main.js:188`、`desktop/main.js:784`、`desktop/main.js:1240`
- 问题：`mediaEngine.audio.requestPermission/getBackendStatus/startCapture/stopCapture/isCapturing/on()` 及其 IPC handler、`media-engine-audio-data`/`media-engine-audio-capturing` 事件转发没有 renderer 消费者；当前源音频选择只使用 `isPlatformSupported()`、`checkPermission()` 和 `getProcessList()` 做进程候选发现，实际直播音频使用 native `startAudioSession()` 和 stats/status 路径。
- 影响：旧主动捕获桥接扩大 preload API 面，并让维护者误以为 renderer 仍会直接启动 `process-audio-capture` 或订阅原始音频数据。
- 建议：删除无消费者的旧主动捕获/事件出口，保留仍被源音频候选发现使用的平台、权限和进程列表探测。
- 修改意见：待补充
- 处理结果：已处理。移除旧音频捕获/事件 preload 出口、对应 IPC handler、事件转发、`audioBridgeAttached`、`isAudioCaptureActive()` 和 `getMediaEngineAudioBridgeStatus()`；保留 `isPlatformSupported/checkPermission/getProcessList`。后续 `DEAD-CODE-P3-043` 已确认并删除无消费者的 `inspectAudioDiscovery()`。


### DEAD-CODE-P3-037 Electron debug bridge 保留旧布尔模式兼容通道

- 位置：`server/public/app.js:517`、`desktop/preload.js:35`、`desktop/main.js:282`
- 问题：renderer 当前总是优先调用 `electronAPI.setDebugConfig(config)`，preload 也始终暴露该结构化调试配置通道；旧 `setDebugMode(boolean)` 仅作为 fallback 存在，对应 `renderer-debug-mode-changed` IPC 没有实际消费者。
- 影响：旧布尔通道会让调试配置看起来仍有两套同步协议，且只能表达“全部开/关”，与当前分类/通道级配置模型不一致。
- 建议：删除旧 `setDebugMode` fallback、preload 出口和 main IPC，保留 `setDebugConfig`。
- 修改意见：待补充
- 处理结果：已处理。移除 renderer fallback 分支、`electronAPI.setDebugMode()` 和 `renderer-debug-mode-changed` IPC；结构化 `renderer-debug-config-changed` 通道保持不变。


### DEAD-CODE-P3-038 tmp/smoke 保留旧手工测试日志和 pid 文件

- 位置：`tmp/smoke/host.err.log`、`tmp/smoke/host.out.log`、`tmp/smoke/host.pid`、`tmp/smoke/server.err.log`、`tmp/smoke/server.out.log`、`tmp/smoke/server.pid`、`tmp/smoke/viewer.err.log`、`tmp/smoke/viewer.out.log`、`tmp/smoke/viewer.pid`
- 问题：`tmp/smoke` 下保留了 2026-04 的旧手工 smoke 日志和 pid 文件；当前 `scripts/smoke-media-agent.ps1` 使用进程重定向内存读取，不读写这些文件，仓内也没有脚本引用该目录。
- 影响：旧 pid/log 会误导维护者以为仍存在运行中的手工 smoke 环境或文件型 smoke 输出链路。
- 建议：删除旧临时日志和 pid；保留 `tmp/` gitignore 规则，后续手工测试需要时可重新生成临时文件。
- 修改意见：待补充
- 处理结果：已处理。确认三个 pid 当前无对应进程，项目代码无 `tmp/smoke` 引用后，删除该目录下旧日志、pid 文件和空目录。


### DEAD-CODE-P3-039 VDS Web 生产构建生成无消费者 source map

- 位置：`vds_web/vite.config.ts:10`、`server/public/vds_web/assets/*.js.map`
- 问题：Vite 配置开启 `sourcemap: true`，发布目录会生成包含 `sourcesContent` 的 `.js.map`；项目 HTML、脚本、Docker 校验和 release check 都不依赖 source map，运行时只需要 `index.html`、JS 和 CSS。
- 影响：生产静态目录保留无消费者调试产物，会增加发布体积，并把源代码内容随 public 静态目录一起发布。
- 建议：关闭生产 sourcemap，重新构建 `server/public/vds_web`，只保留运行必需产物。
- 修改意见：待补充
- 处理结果：已处理。移除 `sourcemap: true`，重新构建后 `server/public/vds_web` 不再生成 `.js.map`，JS 尾部也不再包含 `sourceMappingURL`。


### DEAD-CODE-P3-040 dist 解包目录和空 tmp 目录为可重建生成残留

- 位置：`dist/win-unpacked/`、`tmp/`
- 问题：`dist/win-unpacked/` 是 electron-builder 的解包输出目录，项目脚本、文档和 `release-check` 均不引用它；当前发布校验只依赖 `dist/latest.yml`、当前 installer 和 blockmap。`tmp/` 在删除旧 smoke 文件后为空目录。
- 影响：解包目录约 935MB，会长期占用本地工作区并让 `dist` 看起来包含另一套可发布应用目录；空 `tmp/` 目录没有运行意义。
- 建议：删除可重建的解包输出和空临时目录，保留当前 installer、`latest.yml` 和历史 blockmap。
- 修改意见：待补充
- 处理结果：已处理。删除 `dist/win-unpacked/` 和空 `tmp/`；`dist/latest.yml`、`VDS-Setup-1.6.6.exe`、当前 blockmap 和历史 blockmap 保留。


### DEAD-CODE-P3-041 docs 目录保留无消费者本地证书和私钥

- 位置：`docs/cert.pem`、`docs/cert.key`
- 问题：两个文件被 `.gitignore` 的 `*.pem`/`*.key` 规则排除，项目代码、脚本、文档和发布校验没有按路径引用；`cert.pem` 为站点证书链，`cert.key` 为私钥材料，均只是本地残留。
- 影响：无消费者证书/私钥留在工作区会造成安全风险，也会误导维护者以为 docs 下存在 TLS 配置输入。
- 建议：删除这两个 ignored 本地文件；运行环境如需证书应通过部署环境或密钥管理提供，不应从 docs 目录读取。
- 修改意见：待补充
- 处理结果：已处理。使用包含 ignored 文件的精确搜索确认只有文件自身内容匹配、没有项目消费者后，删除 `docs/cert.pem` 和 `docs/cert.key`。


### DEAD-CODE-P3-042 media-agent 头文件暴露仅限本翻译单元使用的声明

- 位置：`media-agent/src/agent_lifecycle.h`、`media-agent/src/host_capture_plan.h`、`media-agent/src/media_audio.h`、`media-agent/src/peer_media_binding_runtime.h`、`media-agent/src/peer_video_sender.h`、`media-agent/src/platform_utils.h`、`media-agent/src/surface_attachment_runtime.h`、`media-agent/src/viewer_audio_playback.h`、`media-agent/src/viewer_video_pipeline.h`、`media-agent/src/wasapi_backend.h`
- 问题：引用核对发现多项函数声明只出现在对应头文件和同名 `.cpp` 内，实际调用也都在同一翻译单元内部；它们不构成跨模块 API，却暴露在公共头文件中。
- 影响：无外部消费者的头文件声明扩大 media-agent 模块 API 面，让维护者误以为这些内部 helper 可以被其他模块调用或需要维持跨文件兼容。
- 建议：从头文件删除这些无外部消费者声明，保留同 `.cpp` 内实现与内部调用；后续如确需跨模块复用，再按真实调用重新暴露。
- 修改意见：待补充
- 处理结果：已处理。删除 `refresh_agent_runtime_state`、WGC 尺寸解析 helper、host audio packet dispatch、relay attach helper、host audio sender clear、peer video sender handle close、`wide_to_utf8`、peer surface layout update、viewer audio runtime/queue helper、scheduled video submit、`probe_wasapi_backend` 等仅本翻译单元消费的头文件声明；实现和内部调用保留。


### DEAD-CODE-P3-043 Electron 主进程保留旧音频 discovery 聚合 helper

- 位置：`desktop/main.js:41`、`desktop/main.js:774`、`desktop/main.js:1160`
- 问题：`inspectAudioDiscovery()` 旧 helper 会同步聚合 `process-audio-capture` 的平台、权限和进程列表信息，但当前源列表已改为 `createDeferredAudioDiscoverySnapshot()`，renderer 在选中源时直接通过 `mediaEngine.audio.isPlatformSupported/checkPermission/getProcessList` 做按需发现；项目内没有 `inspectAudioDiscovery` 调用点。对应 `audioCaptureLoadError` 只为该 helper 的错误快照服务，删除 helper 后也只剩写入。
- 影响：旧聚合 helper 会让维护者误以为 capture target 列表阶段仍会主动枚举音频进程，并保留一份无消费者错误缓存。
- 建议：删除 `inspectAudioDiscovery()` 和只写的 `audioCaptureLoadError`，保留实际使用的 `getAudioCapture()`、`invokeAudioCaptureOperation()` 以及三个 renderer 音频探测 IPC。
- 修改意见：待补充
- 处理结果：已处理。移除 `inspectAudioDiscovery()`、`audioCaptureLoadError` 声明及其 success/catch 写入；源列表继续返回 deferred audio snapshot，源音频候选发现继续通过 renderer 按需 IPC 执行。


### DEAD-CODE-P3-044 HostCapturePlan 保留永远为空的 fallback reason 字段

- 位置：`media-agent/src/agent_runtime.h:270`、`media-agent/src/host_capture_plan.cpp:262`、`media-agent/src/host_state_json.cpp:52`
- 问题：`HostCapturePlan::capture_fallback_reason` 只有字段声明、构建时清空和状态 JSON 输出，没有任何赋值；当前 WGC-only capture plan 的失败/不可用原因已经通过 `reason`、`validationReason` 和 `lastError` 表达。
- 影响：状态 JSON 长期输出永远为空的 `captureFallbackReason`，会误导维护者以为仍存在 gdigrab/WGC fallback 选择链路或 fallback 诊断字段。
- 建议：删除该只空字段及 JSON 输出；继续使用现有 `reason`、`validationReason`、`lastError` 描述 capture plan 状态。
- 修改意见：待补充
- 处理结果：已处理。移除 `capture_fallback_reason` 字段、构建时清空语句和 `captureFallbackReason` JSON 输出；host capture plan 的 ready/validated/reason/validationReason/lastError 输出保持不变。


### DEAD-CODE-P3-045 Host session JSON 保留永远为空的降级原因字段

- 位置：`media-agent/src/host_session_controller.cpp:311`、`media-agent/src/agent_status_json.cpp:131`
- 问题：`downgradeReason` 在 `host-session-started` 事件和 `build_host_session_json()` 中均被硬编码为空字符串；当前 codec 选择没有实际降级链路，前端只消费 `effectiveCodec`/`codec`，项目内也没有按 `downgradeReason` 分支。
- 影响：长期输出空诊断字段会让维护者误以为 native host session 仍存在 codec downgrade 诊断状态，增加状态协议噪音。
- 建议：删除永远为空的 `downgradeReason` 输出，保留前端实际使用的 `requestedCodec`、`codec` 和 `effectiveCodec`。
- 修改意见：待补充
- 处理结果：已处理。移除 `host-session-started` 事件和 host session JSON 中的空 `downgradeReason` 字段；`effectiveCodec` 仍输出当前实际 codec，前端 codec 同步路径保持不变。


### DEAD-CODE-P3-046 HostCapturePlan 保留无消费者 preferred backend 字段

- 位置：`media-agent/src/agent_runtime.h:268`、`media-agent/src/host_capture_plan.cpp:260`、`media-agent/src/host_state_json.cpp:50`
- 问题：`HostCapturePlan::preferred_capture_backend` 只在结构体默认值、构建 capture plan 时赋值为 `wgc`、以及状态 JSON `preferredCaptureBackend` 输出中出现；项目前端、脚本和 native 逻辑均不读取该字段。当前实际 capture 分支统一使用 `capture_backend`。
- 影响：无消费者的偏好字段会让状态协议看起来仍存在“偏好后端”和“实际后端”两套选择链路，但当前 WGC-only 路径没有独立偏好决策。
- 建议：删除 `preferred_capture_backend` 字段、构建赋值和 `preferredCaptureBackend` JSON 输出；保留实际被运行逻辑和诊断使用的 `captureBackend`。
- 修改意见：待补充
- 处理结果：已处理。移除 `preferred_capture_backend`、固定赋值和状态 JSON 输出；host capture 后端判断仍统一通过 `capture_backend`/`captureBackend`。


### DEAD-CODE-P3-047 HostCapturePlan 输出无消费者 command preview

- 位置：`media-agent/src/agent_runtime.h:284`、`media-agent/src/host_capture_plan.cpp:336`、`media-agent/src/host_capture_plan.cpp:384`、`media-agent/src/host_state_json.cpp:66`
- 问题：`HostCapturePlan::command_preview` 只在构建/校验 capture plan 时赋值并通过状态 JSON `commandPreview` 输出；项目前端、脚本和 native 逻辑均不读取该字段。实际执行命令由 `HostCaptureProcessState::command_line` 保存并使用，`build_ffmpeg_host_capture_command()` 仍由 host capture process 调用。
- 影响：无消费者的命令预览字段会让 capture plan 协议携带一份过期/重复的诊断信息，尤其 WGC 校验后该字段只是 `wgc-* -> ffmpeg-stdin` 文本，不参与运行决策。
- 建议：删除 `command_preview` 字段、两处赋值和 `commandPreview` JSON 输出；保留实际进程启动使用的 `command_line`。
- 修改意见：待补充
- 处理结果：已处理。移除 `HostCapturePlan::command_preview`、构建/校验赋值和 `commandPreview` JSON 输出；`build_ffmpeg_host_capture_command()` 及 host capture process 的 `command_line` 保持不变。


### DEAD-CODE-P3-048 build_host_capture_plan 保留无用 process_state 参数

- 位置：`media-agent/src/host_capture_plan.h:14`、`media-agent/src/host_capture_plan.cpp:247`、`media-agent/src/agent_lifecycle.cpp:188`、`media-agent/src/host_session_controller.cpp:65`、`media-agent/src/host_session_controller.cpp:271`
- 问题：删除 `HostCapturePlan::command_preview` 后，`build_host_capture_plan()` 不再读取 `HostCaptureProcessState`；该参数只剩声明、实现形参和调用传参，并触发编译器未引用参数警告。
- 影响：保留死参数会让 capture plan 构建接口看起来依赖 capture process 状态，增加调用端噪音，也会在 Release build 中产生新的未使用参数警告。
- 建议：从 `build_host_capture_plan()` 签名和所有调用点删除 `process_state` 参数；实际需要 capture process 的命令构建继续留在 `start_host_capture_process()`。
- 修改意见：待补充
- 处理结果：已处理。移除 `build_host_capture_plan()` 的 `process_state` 参数及三个调用点传参；capture plan 构建不再依赖 host capture process 状态，实际进程命令仍由 `start_host_capture_process()` 构建。


### DEAD-CODE-P3-049 PeerTransportSnapshot 输出固定 encoded protocol 字段

- 位置：`media-agent/src/peer_transport.h:84`、`media-agent/src/peer_transport.cpp:2595`
- 问题：`PeerTransportSnapshot::encoded_media_data_channel_protocol` 只保存固定字符串 `vds-media-encoded-v1` 并通过 `encodedMediaDataChannelProtocol` 输出；native 运行逻辑不读取该字段，前端诊断也只读取 encoded data channel 的 requested/open/ready/state/frame 计数，不读取 protocol。真正的协议校验仍使用 `kEncodedMediaProtocol` 和控制包/SDP 中的协议常量。
- 影响：snapshot 状态协议额外输出一个无消费者固定值，容易让维护者误以为 peer transport 运行时会动态选择 encoded media protocol。
- 建议：删除 snapshot 字段和 JSON 输出；保留用于协商、能力声明和测试的 `vds-media-encoded-v1` 协议常量。
- 修改意见：待补充
- 处理结果：已处理。移除 `encoded_media_data_channel_protocol` 字段和 `encodedMediaDataChannelProtocol` JSON 输出；`kEncodedMediaProtocol`、前端 capabilities 和协议测试保持不变。


### DEAD-CODE-P3-050 PeerTransportSnapshot 保留无消费者 encoded data channel message/bytes 计数

- 位置：`media-agent/src/peer_transport.h:60`、`media-agent/src/peer_transport.cpp:1074`、`media-agent/src/peer_transport.cpp:1832`、`media-agent/src/peer_transport.cpp:1907`、`media-agent/src/peer_transport.cpp:2577`
- 问题：`encoded_media_data_channel_messages_received`、`encoded_media_data_channel_bytes_sent`、`encoded_media_data_channel_bytes_received` 只在 peer transport 内累加并输出到 JSON；前端 P2P 诊断只读取 encoded data channel 的 requested/open/ready/state、frames sent/received 和 invalid frames，不读取 message/bytes 计数。
- 影响：无消费者计数扩大 snapshot 协议和状态维护面，让 encoded data channel 诊断同时存在帧计数和消息/字节计数两套粒度。
- 建议：删除无消费者的 message/bytes 计数字段、累加逻辑和 JSON 输出；保留前端实际读取的 frame/invalid 计数。
- 修改意见：待补充
- 处理结果：已处理。移除三个 encoded data channel message/bytes 计数字段、对应累加语句和 JSON 输出；`encodedMediaDataChannelFramesSent/Received/InvalidFrames` 保持不变。


### DEAD-CODE-P3-051 FFmpeg probe 输出无消费者自检细节镜像字段

- 位置：`media-agent/src/agent_runtime.h:188`、`media-agent/src/agent_runtime.h:213`、`media-agent/src/ffmpeg_probe.cpp:41`、`media-agent/src/ffmpeg_probe.cpp:378`、`media-agent/src/ffmpeg_probe.cpp:636`、`media-agent/src/ffmpeg_probe.cpp:709`
- 问题：`VideoEncoderProbeResult` 中 `supports_low_latency/requires_hw_device/hw_device_type/hw_device_ready/open_succeeded/output_succeeded` 只作为 native 自检中间状态镜像输出到 JSON，前端只读取 `name/validated/hardware/priority/reason/error`。`FfmpegProbeResult` 的 `h264_metadata_bsf_available/hevc_metadata_bsf_available` 也只由 `bitstream_filters` 派生后输出，项目没有消费者。
- 影响：这些无消费者镜像字段扩大 FFmpeg capabilities 协议，重复表达已经能由 `validated/reason/error` 或 `bitstreamFilters` 推导的信息。
- 建议：删除无消费者镜像字段、赋值和 JSON 输出；保留前端质量设置和编码选择实际使用的 encoder probe 核心字段、validated encoder 列表和 bitstream filter 原始列表。
- 修改意见：待补充
- 处理结果：已处理。移除上述 VideoEncoderProbeResult 自检细节字段、随之无调用的 `encoder_supports_low_latency()` helper 和 FFmpeg metadata bsf 布尔镜像；保留 `videoEncoderProbes` 中实际消费的 `name/exists/hardware/validated/priority/reason/error` 以及 `bitstreamFilters`。


### DEAD-CODE-P3-052 PeerTransportSnapshot 保留无消费者字节统计字段

- 位置：`media-agent/src/peer_transport.h:50`、`media-agent/src/peer_transport.cpp:955`、`media-agent/src/peer_transport.cpp:1295`、`media-agent/src/peer_transport.cpp:1907`、`media-agent/src/peer_transport.cpp:1958`、`media-agent/src/peer_transport.cpp:2563`
- 问题：`bytes_sent/bytes_received/video_bytes_sent/audio_bytes_sent/remote_video_bytes_received/remote_audio_bytes_received` 只在 peer transport snapshot 内赋值、累加并输出 JSON；前端诊断实际读取的是 `videoFramesSent/audioFramesSent/remoteVideoFramesReceived/remoteAudioFramesReceived` 以及 encoded data channel 帧计数，没有读取这些字节字段。
- 影响：无消费者字节计数扩大 peer transport 状态协议和运行时维护面，并与保留的帧计数形成重复诊断粒度。
- 建议：删除这些无消费者字节字段、累加逻辑和 JSON 输出；继续保留前端正在消费的帧计数、连接状态、RTT 和候选信息。
- 修改意见：待补充
- 处理结果：已处理。移除 `PeerTransportSnapshot` 的六个字节统计字段、发送/接收/encoded data channel 分支中的累加语句、`pc->bytesSent()/bytesReceived()` 快照赋值和对应 JSON 输出；前端读取的帧计数与连接诊断字段保持不变。


### DEAD-CODE-P3-053 HostCaptureArtifactProbe 输出无消费者探测时间和像素格式

- 位置：`media-agent/src/agent_runtime.h:352`、`media-agent/src/host_capture_process.cpp:245`、`media-agent/src/host_capture_process.cpp:318`、`media-agent/src/host_state_json.cpp:79`
- 问题：`HostCaptureArtifactProbe::last_probe_at_unix_ms` 和 `pixel_format` 只由 artifact probe 写入并通过 `lastProbeAtMs`/`pixelFormat` 输出；项目内前端、脚本和 native 逻辑均不读取。artifact 是否可用已经由 `available/ready/fileSizeBytes/width/height/frameRate/formatName/videoCodec/reason/lastError` 表达。
- 影响：状态 JSON 暴露无消费者字段，并让 ffprobe 额外请求 `pix_fmt`，增加 capture artifact 诊断协议噪音。
- 建议：删除探测时间和像素格式镜像字段及 JSON 输出；收窄 ffprobe `show_entries` 到仍输出的 codec、尺寸、帧率、格式和大小。
- 修改意见：待补充
- 处理结果：已处理。移除 `last_probe_at_unix_ms`、`pixel_format`、对应赋值/解析和 `lastProbeAtMs`/`pixelFormat` JSON 输出；ffprobe 命令不再请求 `pix_fmt`，artifact ready/reason/error 诊断保持不变。


### DEAD-CODE-P3-054 PeerTransportSnapshot 输出无消费者视频帧时间戳

- 位置：`media-agent/src/peer_transport.h:66`、`media-agent/src/peer_transport.cpp:955`、`media-agent/src/peer_transport.cpp:1293`、`media-agent/src/peer_transport.cpp:2595`
- 问题：`last_video_frame_at_unix_ms` 和 `last_remote_video_frame_at_unix_ms` 只在 peer transport 发送/接收视频帧时赋值，并通过 `lastVideoFrameAtMs`/`lastRemoteVideoFrameAtMs` 输出；项目前端、脚本和 native 逻辑均不读取这些字段。状态更新时间已有 `updated_at_unix_ms` 维护，帧活跃度诊断已有 `videoFramesSent` 和 `remoteVideoFramesReceived`。
- 影响：无消费者时间戳扩大 peer transport snapshot 协议，和 `updatedAtMs`/帧计数形成重复诊断信息。
- 建议：删除这两个只输出的时间戳字段、赋值和 JSON 输出；保留跨 receiver/surface runtime 同步使用的 `lastDecodedFrameAtMs`。
- 修改意见：待补充
- 处理结果：已处理。移除 `last_video_frame_at_unix_ms`、`last_remote_video_frame_at_unix_ms`、发送/接收赋值和 `lastVideoFrameAtMs`/`lastRemoteVideoFrameAtMs` JSON 输出；远端视频帧接收仍更新 `updated_at_unix_ms`，`lastDecodedFrameAtMs` 保持不变。


### DEAD-CODE-P3-055 PeerTransportSnapshot 输出无消费者创建时间

- 位置：`media-agent/src/peer_transport.h:64`、`media-agent/src/peer_transport.cpp:491`、`media-agent/src/peer_transport.cpp:2589`
- 问题：`PeerTransportSnapshot::created_at_unix_ms` 只在 session 构造时初始化，并通过 `createdAtMs` 输出；项目前端、脚本和 native 逻辑均不读取该字段。peer 状态变化已有 `updatedAtMs`，控制流也不依赖 snapshot 创建时间。
- 影响：无消费者创建时间扩大 peer transport 状态协议，并与仍有实际诊断价值的 `updatedAtMs` 重复表达生命周期时间信息。
- 建议：删除 snapshot 创建时间字段、初始化和 JSON 输出；保留 encoded media chunk 重组内部使用的 pending chunk `created_at_unix_ms` 超时字段。
- 修改意见：待补充
- 处理结果：已处理。移除 `PeerTransportSnapshot::created_at_unix_ms` 和 `createdAtMs` JSON 输出；构造时直接初始化 `updated_at_unix_ms`，pending encoded media chunk 的超时创建时间逻辑保持不变。


### DEAD-CODE-P3-056 PeerTransportSnapshot 保留无消费者 WebRTC 细节镜像字段

- 位置：`media-agent/src/peer_transport.h:27`、`media-agent/src/peer_transport.cpp:1542`、`media-agent/src/peer_transport.cpp:1661`、`media-agent/src/peer_transport.cpp:1694`、`media-agent/src/peer_control_runtime.cpp:415`、`media-agent/src/peer_transport.cpp:2503`、`media-agent/src/relay_dispatch.cpp:280`
- 问题：`PeerTransportSnapshot` 中 `local_description_created/data_channel_requested/data_channel_open/remote_track_count` 只作为 native WebRTC 过程镜像写入并输出 JSON；项目前端、脚本和 native 逻辑均不读取这些字段。另有 `remote_description_set/video_track_open/audio_track_open` 是 relay dispatch 的运行门控字段，但其 `remoteDescriptionSet/videoTrackOpen/audioTrackOpen` JSON 输出没有消费者。
- 影响：纯镜像字段和无消费者 JSON 输出扩大 peer transport 状态协议，重复表达可由 `connectionState/iceState/signalingState/reason`、relay runtime reason 或已保留的 configured/encoded data channel 字段覆盖的状态。
- 建议：删除纯镜像字段、对应写入语句和 JSON 输出；删除 relay 运行字段的无消费者 JSON 输出，但保留 `remote_description_set/video_track_open/audio_track_open` 字段本身及赋值，因为 relay dispatch 发送调度依赖它们；保留 `localDescriptionType`，因为本地 SDP 回调仍用它传递 offer/answer 类型；保留 backend capability 的 `videoTrackSupport/audioTrackSupport`。
- 修改意见：待补充
- 处理结果：已处理。移除 `local_description_created/data_channel_requested/data_channel_open/remote_track_count` 字段及写入语句，移除 `localDescriptionCreated/dataChannelRequested/dataChannelOpen/remoteTrackCount/remoteDescriptionSet/videoTrackOpen/audioTrackOpen` snapshot JSON 输出；恢复并保留 relay dispatch 实际读取的 `remote_description_set/video_track_open/audio_track_open` 运行字段和赋值，encoded data channel 的 requested/open/ready/state、backend track support 和 SDP 类型回调保持不变。


### DEAD-CODE-P3-057 PeerTransportSnapshot 保留无消费者远端 track/backend/source 镜像

- 位置：`media-agent/src/peer_transport.h:34`、`media-agent/src/peer_transport.h:74`、`media-agent/src/peer_transport.cpp:772`、`media-agent/src/peer_transport.cpp:1075`、`media-agent/src/peer_transport.cpp:1241`、`media-agent/src/peer_transport.cpp:1413`、`media-agent/src/peer_transport.cpp:1677`、`media-agent/src/peer_transport.cpp:2353`、`media-agent/src/peer_receiver_runtime.cpp:72`
- 问题：`remote_video_track_attached/remote_audio_track_attached/video_decoder_backend/video_source` 只在 peer transport snapshot 内赋值并通过 JSON 输出，项目内前端、脚本和 native 逻辑均不读取。实际接收端配置状态由 `videoReceiverConfigured/audioReceiverConfigured` 表达，decoder/backend 诊断已经由 `receiverRuntime` 输出，video source 对发送/接收运行逻辑没有读取路径。
- 影响：这些镜像字段让 peer transport 状态协议重复表达 receiver runtime 和 configured 状态，增加维护面；`set_peer_transport_decoder_state()` 还额外携带只用于填充该镜像字段的 `video_decoder_backend` 参数。
- 建议：删除上述 snapshot 字段、赋值和 JSON 输出；从 `set_peer_transport_decoder_state()` 签名及唯一调用点移除 `video_decoder_backend` 参数；保留 decoder ready、decoded frames、last decoded timestamp，因为它们参与 `mediaPlaneReady` 和 receiver/surface 状态同步。
- 修改意见：待补充
- 处理结果：已处理。移除 `remote_video_track_attached/remote_audio_track_attached/video_decoder_backend/video_source` 字段、对应赋值和 `remoteVideoTrackAttached/remoteAudioTrackAttached/videoDecoderBackend/videoSource` JSON 输出；`set_peer_transport_decoder_state()` 不再接收 backend 参数，`receiverRuntime.decoderBackend` 仍由接收端状态 JSON 表达。


### DEAD-CODE-P3-058 ViewerAudioPlaybackRuntime 保留无消费者累计统计计数

- 位置：`media-agent/src/agent_runtime.h:437`、`media-agent/src/viewer_audio_playback.cpp:183`、`media-agent/src/viewer_audio_playback.cpp:366`、`media-agent/src/viewer_audio_playback.cpp:399`
- 问题：`audio_packets_received/audio_bytes_received/pcm_frames_queued/pcm_frames_played/pcm_frames_dropped` 只在 viewer audio playback runtime 中累加并通过 `viewerAudioPlayback` JSON 输出，前端、脚本和 native 逻辑均不读取。实际播放/缓冲控制依赖 `pcm_queue`、`buffered_pcm_frames`、`target_buffer_frames`、`playback_primed`、`passthrough_audio_delay_ms` 和 `software_volume`。
- 影响：无消费者累计计数扩大 viewer audio 状态协议和运行时维护面，其中 `pcmFramesDropped` 还只是此前为诊断补上的计数，未形成实际消费路径。
- 建议：删除这些累计统计字段、累加逻辑和 JSON 输出；保留播放控制实际读取的缓冲、延迟、音量和队列状态字段。
- 修改意见：待补充
- 处理结果：已处理。移除五个 viewer audio 累计统计字段、播放/入队/裁剪路径中的累加语句和 `audioPacketsReceived/audioBytesReceived/pcmFramesQueued/pcmFramesPlayed/pcmFramesDropped` JSON 输出；`bufferedPcmFrames/targetBufferFrames/audioDelayMs/softwareVolume/queueDepth` 等运行字段保持不变。


### DEAD-CODE-P3-059 PeerVideoReceiverRuntime 输出固定 AV 同步占位字段

- 位置：`media-agent/src/peer_receiver_runtime.cpp:97`、`server/public/app-native-overrides.js:3284`
- 问题：`peer_video_receiver_runtime_json()` 输出的 `scheduledAudioBlocks/queuedVideoUnits/queuedAudioBlocks/avSyncRunning/avSyncAnchorInitialized/targetLatencyMs/lastVideoLatenessMs/lastAudioLatenessMs` 均为固定 `0` 或 `false`，没有对应 runtime 字段或写入路径。前端仅在周期 native debug 日志里读取 `queuedVideoUnits/queuedAudioBlocks/lastVideoLatenessMs`，这些读取在原生端固定输出下没有真实诊断价值。
- 影响：固定占位字段扩大 receiver runtime 状态协议，并让前端日志保留永远等于默认值的队列/迟到度信息，掩盖实际仍有效的 `submittedVideoUnits/dispatchedAudioBlocks/droppedVideoUnits/droppedAudioBlocks` 计数。
- 建议：删除固定占位 JSON 输出和前端周期日志中对应读取；保留有真实写入路径的接收、提交、派发、丢弃和 surface/decoder 状态字段。
- 修改意见：待补充
- 处理结果：已处理。移除八个固定 AV 同步/队列/迟到度占位 JSON 字段，并删除 native viewer 周期日志里的 `queuedVideo/queuedAudio/lastVideoLatenessMs` 输出；`scheduledVideoUnits/submittedVideoUnits/dispatchedAudioBlocks/dropped*` 等真实计数字段保持不变。


### DEAD-CODE-P3-060 PeerVideoReceiverRuntime 保留无消费者接收/调度累计字段

- 位置：`media-agent/src/agent_runtime.h:95`、`media-agent/src/viewer_video_pipeline.cpp:154`、`media-agent/src/peer_receiver_runtime.cpp:95`
- 问题：`remote_frames_received/remote_bytes_received/scheduled_video_units` 只在 viewer video pipeline 中累加，并通过 `remoteFramesReceived/remoteBytesReceived/scheduledVideoUnits` 输出到 receiver runtime JSON；项目前端、脚本和 native 逻辑均不读取这些字段。前端接收帧诊断读取 peer transport 的 `remoteVideoFramesReceived/encodedMediaDataChannelFramesReceived`，本地提交链路读取 `submittedVideoUnits/dispatchedAudioBlocks/dropped*`。
- 影响：这些无消费者累计字段扩大 receiver runtime 状态协议，且与 peer transport 的接收帧计数、receiver runtime 的提交/丢弃计数形成重复诊断粒度。
- 建议：删除三个无消费者累计字段、累加逻辑和 JSON 输出；保留真实消费的 submitted/dispatched/dropped 计数及 peer transport 接收帧计数。
- 修改意见：待补充
- 处理结果：已处理。移除 `remote_frames_received/remote_bytes_received/scheduled_video_units` 字段、viewer video pipeline 中对应累加语句，以及 `remoteFramesReceived/remoteBytesReceived/scheduledVideoUnits` JSON 输出；前端正在使用的 peer transport 帧计数和 receiver submitted/dispatched/dropped 计数保持不变。


### DEAD-CODE-P3-061 PeerVideoReceiverRuntime 输出无消费者运行状态镜像字段

- 位置：`media-agent/src/peer_receiver_runtime.cpp:91`、`server/public/app-native-overrides.js:2004`
- 问题：`peer_video_receiver_runtime_json()` 输出的 `surfaceAttached/running/decoderReady/codecPath/surface/target` 在项目内没有消费者；前端 `receiverRuntime` 只读取 `submittedVideoUnits/dispatchedAudioBlocks/droppedVideoUnits/droppedAudioBlocks/reason/lastError`。其中 decoder ready、surface 渲染和媒体就绪诊断已由 `peerTransport.decoderReady/decodedFramesRendered/mediaPlaneReady` 与 surface 状态表达。
- 影响：receiver runtime 状态 JSON 重复输出一组运行时镜像字段，扩大协议面，并与 peer transport/surface 状态形成重复诊断来源。
- 建议：仅删除无消费者 JSON 输出；保留 `surface_attached/running/decoder_ready/codec_path/surface_id/target` 等字段本身，因为 receiver/surface 生命周期和解码提交逻辑仍读取它们。
- 修改意见：待补充
- 处理结果：已处理。收窄 `receiverRuntime` JSON 到前端实际消费的 submitted/dispatched/dropped 计数和 reason/error；运行时内部仍保留 surface、decoder、codec 和 target 字段供生命周期控制、解码提交和状态同步使用。


### DEAD-CODE-P3-062 MediaBinding/RelaySubscriber 保留无消费者字节计数

- 位置：`media-agent/src/agent_runtime.h:43`、`media-agent/src/peer_video_sender.cpp:481`、`media-agent/src/peer_state_json.cpp:15`、`media-agent/src/relay_dispatch.cpp:253`
- 问题：`PeerVideoSenderRuntime::source_bytes_captured/bytes_sent`、`MediaBindingState::source_bytes_captured/bytes_sent` 和 `RelaySubscriberState::bytes_sent` 只被累加或复制到 JSON；项目前端、脚本和 native 逻辑均不读取 `sourceBytesCaptured/bytesSent`。发送链路实际依赖 `frames_sent` 作为帧序号并向前端输出帧计数，readback 性能诊断依赖帧数和耗时均值。
- 影响：无消费者字节计数扩大 sender/media binding/relay 状态维护面，并与已保留的帧计数、readback 均值形成重复诊断粒度。
- 建议：删除 source/send/relay 字节计数字段、累加/复制逻辑和 JSON 输出；保留 `frames_sent/source_frames_captured` 以及 readback 耗时统计。
- 修改意见：待补充
- 处理结果：已处理。移除 sender runtime、media binding 和 relay subscriber 中的无消费者字节计数字段及累加/复制语句，删除 `sourceBytesCaptured/bytesSent` 与 relay runtime `bytesSent` JSON 输出；`framesSent/sourceFramesCaptured` 和 readback 均值诊断保持不变。


### DEAD-CODE-P3-063 MediaBinding JSON 输出无消费者状态/身份镜像字段

- 位置：`media-agent/src/peer_state_json.cpp:10`、`server/public/app-native-overrides.js:2074`
- 问题：`peer_media_binding_json()` 输出的 `attached/senderConfigured/active/processId/kind/source/codec/codecPath/implementation/commandLine/attachedAtMs/updatedAtMs/detachedAtMs` 在项目前端、脚本和 desktop 层没有消费者。前端 host capture 诊断只读取 media binding 的尺寸、帧率、码率、`sourceFramesCaptured`、`framesSent`、readback 均值、`videoEncoderBackend`、`reason/lastError`。
- 影响：media binding 状态 JSON 暴露一组只用于 native 内部 attach/refresh 判断的镜像字段，扩大协议面，并与 peer transport、host plan、host pipeline 的状态来源重复。
- 建议：仅删除无消费者 JSON 输出；保留 `MediaBindingState` 内部字段，因为 attach 去重、relay binding、sender refresh 和生命周期控制仍读取它们。
- 修改意见：待补充
- 处理结果：已处理。收窄 `mediaBinding` JSON 到前端实际消费的捕获/发送帧计数、尺寸/帧率/码率、readback 均值、编码 backend 和 reason/error；内部状态/身份/时间/命令字段仍保留在 native 运行态。


### DEAD-CODE-P3-064 Native host manifest 读取不存在的 hostPipeline 尺寸字段

- 位置：`server/public/app-native-overrides.js:461`、`media-agent/src/host_state_json.cpp:8`、`media-agent/src/host_state_json.cpp:43`
- 问题：`buildHostMediaManifestFromStats()` 在非 OBS native host 路径读取 `hostPipeline.width/height/frameRate`，但 `host_pipeline_json()` 从不输出这些属性；实际尺寸、帧率和码率由 `hostCapturePlan` 输出并已被诊断面板读取。该读取路径等价于死 fallback，会把 manifest 尺寸退成默认 0。
- 影响：前端保留对不存在状态字段的读取，扩大误导面，并让后续维护者误以为 host pipeline 承载输出尺寸。
- 建议：删除对 `hostPipeline.width/height/frameRate` 的无效读取，改用原生状态中实际存在且权威的 `hostCapturePlan.width/height/frameRate`。
- 修改意见：待补充
- 处理结果：已处理。`buildHostMediaManifestFromStats()` 非 OBS 路径改为读取 `hostCapturePlan.width/height/frameRate`；`hostPipeline` 仍只用于编码器、硬件和 reason/error 诊断。


### DEAD-CODE-P3-065 Host pipeline/capture plan JSON 输出无消费者配置镜像字段

- 位置：`media-agent/src/host_state_json.cpp:8`、`media-agent/src/host_state_json.cpp:43`、`server/public/app-native-overrides.js:2107`、`server/public/app-native-overrides.js:3421`
- 问题：`host_pipeline_json()` 输出的 `preferHardware/requestedVideoCodec/requestedVideoEncoder/requestedPreset/requestedTune/selectedAudioEncoder/implementation` 没有前端、脚本或 desktop 消费者；`host_capture_plan_json()` 输出的 `captureHandle/captureDisplayId/inputWidth/inputHeight/inputFormat/inputTarget/codecPath/implementation` 也没有项目内消费者。前端读取 pipeline 的 ready/validated/hardware/selectedVideoEncoder/videoEncoderBackend/reason/validationReason/lastError，并读取 capture plan 的 ready/validated/captureKind/captureState/captureBackend/width/height/frameRate/bitrateKbps/reason/validationReason/lastError。
- 影响：host 状态协议携带一批只用于 native 内部配置、构建命令或诊断推导的镜像字段，扩大状态协议和前端误读面。
- 建议：删除无消费者 JSON 输出；保留 `HostPipelineState` 和 `HostCapturePlan` 内部字段，因为构建 capture plan、host pipeline、peer sender 和 OBS/preview 路径仍读取这些字段。
- 修改意见：待补充
- 处理结果：已处理。收窄 `hostPipeline` 与 `hostCapturePlan` JSON 到前端实际消费字段；恢复并保留 host capture 诊断读取的 `captureKind/captureBackend/bitrateKbps`，native 内部配置字段和命令构建输入保持不变。


### DEAD-CODE-P3-066 PeerState 顶层 remote description/candidate 镜像字段

- 位置：`media-agent/src/agent_runtime.h:132`、`media-agent/src/agent_status_json.cpp:189`、`media-agent/src/peer_control_runtime.cpp:456`、`media-agent/src/peer_media_binding_runtime.cpp:104`
- 问题：`PeerState::has_remote_description` 和 `PeerState::remote_candidate_count` 只作为 stats peers 顶层 `remoteDescription/remoteCandidateCount` 输出；项目前端、脚本和 desktop 层不读取这两个顶层字段。前端 P2P 诊断的 remote candidate 数来自 renderer meta，native transport 诊断仍由 `peerTransport.remoteCandidateCount` 输出。
- 影响：PeerState 维护一套与 peer transport snapshot 重复的远端 SDP/candidate 镜像，扩大状态同步面。
- 建议：删除 PeerState 顶层镜像字段、写入和 JSON 输出；保留 `PeerTransportSnapshot::remote_candidate_count` 以及 relay dispatch 使用的 `remote_description_set`。
- 修改意见：待补充
- 处理结果：已处理。移除 `has_remote_description/remote_candidate_count` 字段、setRemoteDescription/addRemoteIceCandidate/refresh 中的镜像写入，以及 stats peers 顶层 `remoteDescription/remoteCandidateCount` 输出；peer transport snapshot 的 candidate 计数与 remote description 门控保持不变。


### DEAD-CODE-P3-067 Audio/OBS 状态 JSON 输出无消费者底层诊断字段

- 位置：`media-agent/src/media_audio.cpp:758`、`media-agent/src/obs_ingest_state.cpp:9`、`server/public/app-native-overrides.js:2083`、`server/public/app-native-overrides.js:3141`、`scripts/smoke-media-agent.ps1:132`
- 问题：`audio_session_json()` 输出的大部分底层 WASAPI/probe/格式字段没有消费者；前端 host capture 诊断只读取 `captureActive/packetsCaptured/framesCaptured`。`obs_ingest_json()` 中 `videoReady/audioReady/listenerActive/localOnly/audioPacketsReceived/videoAccessUnitsEmitted/audioFramesForwarded/reason/lastError/startedAtMs/connectedAtMs/lastPacketAtMs/endedAtMs` 也没有项目内消费者；前端和 smoke test 读取的是 prepared/url/port、连接运行状态、媒体尺寸/帧率、音视频 codec、音频采样信息和 videoPacketsReceived。
- 影响：audio/OBS 状态协议携带大量只适合 native 内部排查的镜像字段，扩大前端状态面和维护成本。
- 建议：删除无消费者 JSON 输出；保留 `AudioSessionState` 与 `ObsIngestState` 内部字段，因为捕获、转发、准备 OBS ingest、错误处理和 worker 生命周期仍使用它们。
- 修改意见：待补充
- 处理结果：已处理。收窄 `audioBackend` JSON 到 `captureActive/packetsCaptured/framesCaptured`，收窄 `obsIngest` JSON 到前端和 smoke test 实际读取字段；native 内部 audio/OBS 运行状态保持不变。


### DEAD-CODE-P3-068 Surface attachment JSON 输出无消费者底层预览/进程字段

- 位置：`media-agent/src/surface_attachment_runtime.cpp:548`、`desktop/main.js:1805`、`server/public/app-native-overrides.js:248`、`server/public/app-native-overrides.js:2076`
- 问题：`surface_attachment_json()` 输出的 `launchAttempted/waitingForArtifact/restartCount/avgCopyResourceUs/avgMapUs/avgMemcpyUs/avgTotalReadbackUs/lastExitCode/previewSurfaceBackend/decoderBackend/codecPath/mediaPath/manifestPath/commandLine/lastStartAttemptAtMs/lastStartSuccessAtMs/lastStopAtMs/lastDecodedFrameAtMs` 在项目前端、desktop 桥和脚本中没有消费者。前端 host/viewer 诊断读取 surface 的 `target/running/decodedFramesRendered/frameIntervalStddevMs/reason/lastError`，日志摘要读取 `attached/running/decoderReady/processId/implementation/layout/windowTitle/embeddedParentDebug/surfaceWindowDebug/reason/lastError`。
- 影响：surface 状态协议携带一组只适合 native 内部生命周期和低层预览排查的镜像字段，扩大事件/状态负载，也让前端误以为这些字段可作为稳定消费面。
- 建议：删除无消费者 JSON 输出；保留 `SurfaceAttachmentState` 内部字段，因为 surface 启停、artifact/live preview、自动重启和窗口嵌入调试仍需要这些运行态数据。
- 修改意见：待补充
- 处理结果：已处理。收窄 `surface_attachment_json()` 到诊断和日志摘要实际读取的 surface 身份、运行、渲染帧、layout、window/debug、reason/error 字段，并删除因此变成无用的 live preview snapshot 局部变量；native 内部 surface 生命周期字段保持不变。


### DEAD-CODE-P3-069 Host capture process JSON 输出无消费者进程/产物镜像字段

- 位置：`media-agent/src/host_capture_process.cpp:177`、`media-agent/src/agent_status_json.cpp:36`、`media-agent/src/host_session_controller.cpp:311`
- 问题：`host_capture_process_json()` 输出的 `launchAttempted/preserveOutput/lastExitCode/implementation/outputMode/container/sessionId/outputDirectory/outputPath/manifestPath/commandLine/startedAtMs/updatedAtMs/stoppedAtMs` 在项目前端、desktop 桥和脚本中没有字段级消费者。native 控制流读取的是 `HostCaptureProcessState` 内部字段，artifact manifest 顶层仍单独保留 session、路径、容器、时间戳和 preserve 信息用于持久化排障。
- 影响：运行态状态 JSON 暴露一组只适合 native 内部生命周期或离线 manifest 排障的镜像字段，扩大前端/事件状态面，并与 `build_host_capture_manifest_json()` 顶层字段重复。
- 建议：收窄 `host_capture_process_json()` 到状态面需要的基础运行/产物大小/reason/error 字段；保留 `HostCaptureProcessState` 内部字段和 manifest 顶层输出，避免影响启动、停止、清理和 artifact 说明文件。
- 修改意见：待补充
- 处理结果：已处理。`host_capture_process_json()` 仅输出 `enabled/running/processId/outputBytes/reason/lastError`，删除无消费者镜像字段输出，并移除随之无用的 `<limits>` include；native 内部进程生命周期字段与 manifest 持久化信息保持不变。


### DEAD-CODE-P3-070 Capabilities 响应重复输出运行态状态对象

- 位置：`media-agent/src/agent_status_json.cpp:19`、`server/public/app.js:1603`、`server/public/app.js:1794`、`scripts/smoke-media-agent.ps1:99`
- 问题：`capabilities_json()` 输出的 `wgcCapture/audioBackend/hostPipeline/hostCapturePlan/hostCaptureProcess/hostCaptureArtifact/obsIngest/surfaces` 没有被项目前端、desktop 桥或脚本作为 capabilities 消费。前端质量设置读取的是 `hostBackends` 和 `ffmpeg.videoEncoders/validatedVideoEncoders/videoEncoderProbes`，smoke 验证读取 `transportReady` 或 `peerTransport.transportReady`；运行态状态对象已由 `getStatus/getStats/agent-ready` 覆盖。
- 影响：capabilities 响应混入一批运行时快照，扩大启动时能力协议和日志面，并与 status/stats/ready 响应重复。
- 建议：从 `capabilities_json()` 删除无消费者运行态对象输出；保留静态能力字段、`peerTransport` 和 `ffmpeg` 编码器能力，因为它们仍被质量设置和 smoke 验证读取。
- 修改意见：待补充
- 处理结果：已处理。`getCapabilities` 仅保留 platform/transport/codec/backend/mode/surface/method 静态能力、`peerTransport` 和 `ffmpeg`；重复运行态对象继续通过 `getStatus/getStats/agent-ready` 输出。


### DEAD-CODE-P3-071 Agent ready 事件重复携带重型运行态快照

- 位置：`media-agent/src/agent_status_json.cpp:69`、`desktop/media-agent-manager.js:521`、`scripts/smoke-media-agent.ps1:94`
- 问题：`build_agent_ready_json()` 在 `agent-ready` 启动事件中输出 `wgcCapture/audioBackend/viewerAudioPlayback/hostPipeline/hostCapturePlan/hostCaptureProcess/hostCaptureArtifact/obsIngest/surfaces/ffmpeg`，但项目内只把 `agent-ready` 当作启动信号。desktop manager 仅把 params 存入 `status.agent`，renderer 没有订阅或读取 `status.agent` 字段；smoke 只断言收到 `agent-ready` 事件。
- 影响：agent 启动事件携带一整套运行态快照，扩大启动握手输出、日志和 IPC 状态面，并与 `getCapabilities/getStatus/getStats` 重复。
- 建议：收窄 `agent-ready` 到身份和 transport ready 信息；运行态诊断继续通过显式 RPC 获取。
- 修改意见：待补充
- 处理结果：已处理。`agent-ready` 仅输出 name/version/implementation/transport/transportReady/peerDriverReady/peerTransport；重型运行态对象从 ready 事件移除，`getStatus/getStats/getCapabilities` 保持各自职责。


### DEAD-CODE-P3-072 Native getStatus 响应重复输出重型运行态对象

- 位置：`media-agent/src/agent_status_json.cpp:39`、`scripts/smoke-media-agent.ps1:32`、`server/public/app-native-overrides.js:4492`
- 问题：`build_status_json()` 输出的 `wgcCapture/audioBackend/viewerAudioPlayback/hostPipeline/hostCapturePlan/hostCaptureProcess/hostCaptureArtifact/obsIngest/surfaces/ffmpeg` 没有项目内字段级消费者。smoke 对 `getStatus` 只检查响应存在且无 error；Electron renderer 的 `onStatus` 只记录 manager 状态 debug log，且 manager 内部拦截 `getStatus` 不调用 native RPC。运行态详情由 `getStats` 和专门 RPC 消费。
- 影响：native status 响应携带一整套运行态快照，扩大 RPC 负载和协议面，并与 `getStats/getCapabilities/agent-ready` 形成重复。
- 建议：收窄 `getStatus` 到基础 ready/state/transport/host/count/message 状态；保留 `peerTransport` 以继续表达 transport backend readiness。
- 修改意见：待补充
- 处理结果：已处理。`build_status_json()` 删除无消费者重型运行态对象，仅保留基础状态、host/session 计数、`peerTransport` 和 message；详细媒体运行态仍通过 `getStats` 获取。


### DEAD-CODE-P3-073 Host session result 输出无消费者会话附属对象

- 位置：`media-agent/src/agent_status_json.cpp:93`、`server/public/app-native-overrides.js:3416`、`server/public/app-native-overrides.js:3524`
- 问题：`build_host_session_json()` 输出的 `captureTargetId/captureProcess/captureArtifact/surfaces/implementation` 没有项目前端、desktop 桥或脚本字段级消费者。native host 启动路径读取 `running/requestedCodec/effectiveCodec/pipeline/capturePlan`，OBS 启动路径读取 `running/obsIngest`；surface、capture process 和 artifact 详情由后续 `getStats` 轮询提供。
- 影响：start/stop host session result 携带一组启动流程不读取的附属运行态对象，扩大响应负载，并与 stats 状态面重复。
- 建议：收窄 host session result 到启动流程实际需要的会话状态、codec、pipeline、capture plan 和 obs ingest 信息；保留 native 内部字段与 stats 输出。
- 修改意见：待补充
- 处理结果：已处理。`build_host_session_json()` 删除 `captureTargetId/captureProcess/captureArtifact/surfaces/implementation` 输出，保留前端启动路径实际读取字段；运行态详情继续由 `getStats` 输出。


### DEAD-CODE-P3-074 Create peer result 重复输出无消费者 peer 运行态镜像

- 位置：`media-agent/src/agent_status_json.cpp:108`、`server/public/app-native-overrides.js:2362`、`server/public/app-native-overrides.js:2382`
- 问题：`build_peer_result_json()` 输出的 `role/initiator/mediaSessionId/mediaManifestVersion/expectedVideoCodec/expectedAudioCodec/implementation/mediaBinding/peerTransport/receiverRuntime` 没有项目内字段级消费者。前端创建 native peer handle 时已在 JS 本地保存 `peerId/role/initiator/kind`，`mediaEngine.createPeer()` 的 promise 只用于 await ready，不读取结果对象；peer 诊断通过 `getStats` 消费。
- 影响：createPeer result 携带一整套 peer 运行态快照，扩大响应负载，并与 peer-state 事件和 stats peers 重复。
- 建议：收窄 createPeer result 到最小确认信息；保留 peer-state 和 stats 输出供状态同步/诊断使用。
- 修改意见：待补充
- 处理结果：已处理。`build_peer_result_json()` 仅输出 `peerId/transportReady`，删除无消费者 peer 身份、manifest、binding、transport 和 receiver runtime 镜像字段。


### DEAD-CODE-P3-075 Peer-state 事件重复携带无消费者 peer 运行态快照

- 位置：`media-agent/src/agent_status_json.cpp:69`、`server/public/app-native-overrides.js:2494`、`server/public/app-native-overrides.js:2838`
- 问题：`build_peer_state_json()` 在 `peer-state` 事件中输出 `role/initiator/mediaSessionId/mediaManifestVersion/expectedVideoCodec/expectedAudioCodec/driver/transportReady/mediaBinding/peerTransport/receiverRuntime/relaySubscriberRuntime`，但前端事件处理只读取 `params.peerId` 和 `params.state`。前端本地 native peer handle 已保存 role/initiator/kind，peer 诊断由 `getStats` 轮询读取。
- 影响：peer-state 事件携带高频重复运行态快照，扩大事件负载和日志面，并与 stats peers 重复。
- 建议：将 peer-state 事件收窄到状态同步实际需要的 `peerId/state`；保留 stats peers 的详细诊断输出。
- 修改意见：待补充
- 处理结果：已处理。`build_peer_state_json()` 仅输出 `peerId/state`，删除无消费者 peer 身份、manifest、binding、transport、receiver 和 relay runtime 镜像字段。


### DEAD-CODE-P3-076 Stats peers 顶层输出无消费者 peer 镜像字段

- 位置：`media-agent/src/agent_status_json.cpp:128`、`server/public/app-native-overrides.js:2072`、`server/public/app-native-overrides.js:3131`、`server/public/app-native-overrides.js:3252`
- 问题：`build_stats_json()` 的 `stats.peers[]` 顶层输出 `initiator/mediaSessionId/mediaManifestVersion/expectedVideoCodec/expectedAudioCodec`，但前端 stats 消费只用 `peerId/role` 定位 peer，并读取 `mediaBinding/peerTransport/receiverRuntime/relaySubscriberRuntime` 做诊断和 FPS/连接状态判断。
- 影响：stats peers 顶层携带与前端本地 handle 或 native 内部会话状态重复的镜像字段，扩大高频轮询响应。
- 建议：删除无消费者顶层镜像字段，保留 `peerId/role` 和实际诊断对象。
- 修改意见：待补充
- 处理结果：已处理。`stats.peers[]` 仅保留 `peerId/role/mediaBinding/peerTransport/receiverRuntime/relaySubscriberRuntime`；删除无消费者 initiator、media session、manifest version 和 expected codec 顶层输出。


### DEAD-CODE-P3-077 Stats 顶层输出无消费者运行态快照字段

- 位置：`media-agent/src/agent_status_json.cpp:106`、`server/public/app-native-overrides.js:3128`、`server/public/app-native-overrides.js:3250`、`server/public/app.js:1794`、`scripts/smoke-media-agent.ps1:100`
- 问题：`build_stats_json()` 顶层输出的 `implementation/transportReady/peerTransport/viewerAudioPlayback/hostCaptureProcess/hostCaptureArtifact/ffmpeg` 没有项目内 `getStats` 字段级消费者。前端 host/viewer stats 轮询读取的是 `hostSessionRunning/audioBackend/hostPipeline/hostCapturePlan/obsIngest/surfaces/peers`，质量设置读取 `getCapabilities.ffmpeg`，smoke 验证读取 `getCapabilities.transportReady` 或 `getCapabilities.peerTransport.transportReady`。
- 影响：高频 stats 响应携带一批能力、进程、产物和 viewer 音频运行态快照，扩大轮询负载，也与 `getCapabilities`、专门 volume RPC、capture manifest 和内部 native 状态面重复。
- 建议：从 `getStats` 顶层删除无消费者快照字段；保留前端轮询实际消费的 host/audio/surface/peer 状态对象，并保留 `ffmpeg` 能力在 `getCapabilities` 中输出。
- 修改意见：待补充
- 处理结果：已处理。`build_stats_json()` 顶层仅保留 `hostSessionRunning/audioBackend/hostPipeline/hostCapturePlan/surfaces/peers`；删除无消费者 `implementation/transportReady/peerTransport/viewerAudioPlayback/hostCaptureProcess/hostCaptureArtifact/ffmpeg` 输出，相关 native 内部状态和 capabilities 输出保持不变。


### DEAD-CODE-P3-078 Relay subscriber runtime JSON 输出无消费者调度状态字段

- 位置：`media-agent/src/relay_dispatch.cpp:542`、`server/public/app-native-overrides.js:3304`、`media-agent/src/peer_video_sender.cpp:1000`
- 问题：`relay_subscriber_runtime_json()` 输出的 `upstreamPeerId/audioEnabled/lastVideoTimestampUs/updatedAtMs` 没有前端、desktop 或脚本字段级消费者。前端 relay stats 日志只读取 `pendingVideoBootstrap/bootstrapSnapshotSent/framesSent/reason/lastError`；native 内部 `query_relay_subscriber_state()` 仍读取完整 `RelaySubscriberState` 更新 media binding 和调度逻辑。
- 影响：stats peers 的 relay 子对象暴露了调度内部状态和时间戳镜像，扩大高频轮询协议面，并可能让前端误把内部 relay 注册细节当稳定接口。
- 建议：收窄 `relaySubscriberRuntime` JSON 到前端实际诊断字段；保留 `RelaySubscriberState` 内部字段，因为 relay 注册、音频开关、bootstrap、fanout 和 media binding 同步仍依赖它们。
- 修改意见：待补充
- 处理结果：已处理。`relay_subscriber_runtime_json()` 仅输出 `pendingVideoBootstrap/bootstrapSnapshotSent/framesSent/reason/lastError`；`upstreamPeerId/audioEnabled/lastVideoTimestampUs/updatedAtMs` 不再进入 stats JSON，relay 内部状态和调度逻辑保持不变。


### DEAD-CODE-P3-079 Peer transport snapshot JSON 输出无消费者内部协商字段

- 位置：`media-agent/src/peer_transport.cpp:2485`、`server/public/app-native-overrides.js:2005`、`server/public/app-native-overrides.js:3209`、`server/public/app-native-overrides.js:3263`
- 问题：`peer_transport_snapshot_json()` 输出的 `available/transportReady/videoTrackConfigured/audioTrackConfigured/encodedMediaDataChannelSupported/closed/localCandidateCount/gatheringState/localDescriptionType/dataChannelLabel/mediaSessionId/mediaManifestVersion/videoMid/audioMid/videoCodec/audioCodec/codecPath/updatedAtMs/lastDecodedFrameAtMs` 没有项目内 stats 字段级消费者。前端诊断读取的是 candidate pair、RTT、连接/ICE/signaling、encoded datachannel ready/state/counters、收发帧、decoder/media ready、RTCP/恢复/丢帧以及 reason/error。
- 影响：stats peers 的 peer transport 子对象暴露了大量 native 内部协商、manifest 和更新时间镜像，扩大高频轮询状态面，并与本地 handle、native 控制流和 encoded media 握手重复。
- 建议：删除无消费者 JSON 输出；保留 `PeerTransportSnapshot` 内部字段，因为 transport 门控、SDP/candidate、relay dispatch、encoded datachannel、decoder 同步和 media manifest 握手仍依赖这些字段。
- 修改意见：待补充
- 处理结果：已处理。`peer_transport_snapshot_json()` 收窄到前端诊断实际读取的 media ready、receiver configured、decoder、encoded datachannel、candidate count、收发/错误/RTCP/恢复计数、connection/ice/signaling、selected candidates、reason/error 和 RTT 字段；内部协商、manifest、codec/mid 和更新时间字段不再进入 stats JSON。


### DEAD-CODE-P3-080 Host capture 诊断读取不存在的 encodeQueueDepth 字段

- 位置：`server/public/app-native-overrides.js:2099`、`media-agent/src/peer_state_json.cpp:7`、`media-agent/src/agent_runtime.h`
- 问题：host capture 诊断报告读取 `mediaBinding.encodeQueueDepth`，但 `peer_media_binding_json()` 从不输出该字段，native `MediaBindingState` 也没有对应状态源；项目内没有其他生产者或消费者。
- 影响：诊断报告固定生成一行无效/undefined 指标，制造不存在的编码队列状态面，也让前端和 native 协议看起来不一致。
- 建议：删除这条前端诊断死读；如果后续需要编码队列深度，应先在 native sender 队列中实现真实采样，再作为新协议字段加入。
- 修改意见：待补充
- 处理结果：已处理。删除 host capture 诊断报告中的 `encodeQueueDepth` 行；未改动 `mediaBinding` JSON 和 native 状态结构，因为没有真实字段需要输出。


### DEAD-CODE-P3-081 Native host manifest 读取不存在的 pipeline 尺寸字段

- 位置：`server/public/app-native-overrides.js:461`、`server/public/app-native-overrides.js:3480`、`media-agent/src/host_state_json.cpp:8`、`media-agent/src/host_state_json.cpp:36`
- 问题：native host 创建房间和从 stats 补建 media manifest 时读取 `pipeline.width/height/frameRate`，但 `host_pipeline_json()` 不输出这些字段；真实尺寸和帧率由 `capturePlan.width/height/frameRate` 输出。
- 影响：manifest 构建路径读取不存在字段，实际依赖 `buildHostMediaManifest()` 回退到质量设置；协议上造成 pipeline 看似拥有尺寸字段的死读，也可能绕过 native capture plan 的最终验证尺寸。
- 建议：将 native host manifest 的尺寸和帧率来源改为 `capturePlan`；保留 pipeline 只表达编码器/硬件/验证状态。
- 修改意见：待补充
- 处理结果：已处理。`buildHostMediaManifestFromStats()` 和 native host start 后的 `buildHostMediaManifest()` 调用均改为读取 `hostCapturePlan/session.capturePlan.width/height/frameRate`，删除对不存在的 `pipeline.width/height/frameRate` 的死读。


### DEAD-CODE-P3-082 Native attach result 读取不存在的 peerTransport.videoTrackConfigured 字段

- 位置：`server/public/app-native-overrides.js:2746`、`media-agent/src/peer_media_binding_runtime.cpp:213`、`media-agent/src/agent_status_json.cpp:97`
- 问题：`attachNativePeerMediaSources()` 的结果来自 native `attachPeerMediaSource` RPC，而当前 native 返回 `build_peer_result_json()`，只包含 `peerId/transportReady`；前端仍读取 `attachResult.peerTransport.videoTrackConfigured` 做失败判断。
- 影响：该检查分支永远不会触发，形成对旧版 attach result 结构的死读，也让 attach 成功条件和当前协议实际返回不一致。
- 建议：删除 attach result 中不存在字段的检查；视频 track 或 datachannel 的真实状态继续由后续 offer/peer-state/stats 诊断路径验证。
- 修改意见：待补充
- 处理结果：已处理。`attachNativePeerMediaSources()` 调用改为直接 await，不再保存并检查不存在的 `attachResult.peerTransport.videoTrackConfigured`；native attach RPC 结果结构保持最小确认信息。


### DEAD-CODE-P3-083 Knip 动态入口误报缺少显式配置

- 位置：`knip.json`、`desktop/main.js:350`、`desktop/main.js:1399`、`server/public/index.html:473`、`server/public/index.html:474`、`scripts/test-vds-web-protocol.js:62`
- 问题：`knip` 将 Electron preload、窗口元数据 helper、浏览器静态脚本、Vite env 类型入口、PowerShell npm 脚本 shell 和动态加载的 protocol 测试导出报告为死代码；逐项引用链确认这些不是可删除代码，而是静态工具无法从 HTML/Electron 配置、子进程路径和动态 TS transpile 中自动推导。
- 影响：死代码基线长期包含已证实的动态入口误报，导致后续审计无法用 `knip` 结果区分真实死代码和工具边界缺失。
- 建议：新增最小 `knip.json`，显式声明动态入口、PowerShell shell binary 和 `datachannel-protocol.ts` 动态测试导出；不扩大到通配忽略整个目录。
- 修改意见：待补充
- 处理结果：已处理。新增 `knip.json`，将 `desktop/main.js/preload.js/window-metadata-helper.js`、`server/public/app.js/app-native-overrides.js`、`vds_web/src/main.ts/vite-env.d.ts`、`scripts/test-vds-web-protocol.js` 设为入口，忽略 npm scripts 使用的 `powershell` binary，并仅对 `vds_web/src/datachannel-protocol.ts` 忽略动态测试覆盖的 exports；`npx knip --reporter compact` 当前已清零。


### DEAD-CODE-P3-084 WGC capture probe JSON helper 无调用点

- 位置：`media-agent/src/host_state_json.cpp:23`、`media-agent/src/host_state_json.h:9`、`media-agent/src/agent_lifecycle.cpp:174`、`media-agent/src/host_capture_plan.cpp:245`
- 问题：`wgc_capture_probe_json()` 只剩头文件声明和实现，没有项目内调用点；WGC probe 状态本身仍通过 `probe_wgc_capture_backend()` 写入 `state.wgc_capture_backend`，并由 `build_host_capture_plan()` 用于 capture plan 验证。
- 影响：保留无调用 JSON helper 会让 WGC 能力看起来仍有独立输出协议面，但 capabilities/status/stats 已不再输出 `wgcCapture`。
- 建议：删除 `wgc_capture_probe_json()` 声明和实现；保留 WGC probe 结构、探测函数和 capture plan 消费路径。
- 修改意见：待补充
- 处理结果：已处理。删除 `wgc_capture_probe_json()` 的头文件声明和 `.cpp` 实现；`WgcCaptureProbe`、`probe_wgc_capture_backend()` 与 `state.wgc_capture_backend` 运行逻辑保持不变。


### DEAD-CODE-P3-085 Viewer audio playback JSON helper 无调用点

- 位置：`media-agent/src/viewer_audio_playback.cpp:383`、`media-agent/src/viewer_audio_playback.h:33`、`media-agent/src/agent_status_json.cpp:106`、`server/public/app-native-overrides.js:3128`
- 问题：`viewer_audio_playback_json()` 只剩头文件声明和实现，没有项目内调用点；前序 stats 收窄后 `viewerAudioPlayback` 已不再作为 `getStats` 顶层字段输出，前端 viewer 音频控制通过 volume/playback mode/audio delay RPC 结果消费状态。
- 影响：保留孤立 JSON helper 会让 viewer audio playback 看起来仍有独立 stats 协议面，扩大维护面并可能误导后续协议消费者。
- 建议：删除 `viewer_audio_playback_json()` 声明和实现；保留 viewer audio playback runtime、队列、音量、延迟和播放模式 RPC 逻辑。
- 修改意见：待补充
- 处理结果：已处理。删除 `viewer_audio_playback_json()` 的头文件声明和 `.cpp` 实现；`consume_remote_peer_audio_frame()`、viewer 本地播放队列、音量和延迟控制逻辑保持不变。


### DEAD-CODE-P3-086 Viewer audio playback 运行态遗留无消费者诊断字段

- 位置：`media-agent/src/agent_runtime.h:433`、`media-agent/src/viewer_audio_playback.cpp:70`、`media-agent/src/viewer_audio_playback.cpp:176`、`media-agent/src/viewer_audio_playback.cpp:411`
- 问题：`ViewerAudioPlaybackRuntime` 的 `implementation/reason/last_error` 在 `viewer_audio_playback_json()` 删除后不再有协议输出或控制流消费者；相关赋值只在本文件内写入，唯一读取是 worker 结束时把 `viewer-audio-running` 改写为 `viewer-audio-stopped`，没有外部观察者。
- 影响：保留这些只写诊断字段会维持已经移除的 viewer audio stats 影子状态面，并让音频错误文本看起来仍能被上层读取。
- 建议：删除 `ViewerAudioPlaybackRuntime` 中无消费者的诊断字段及其赋值；保留实际参与播放控制的 `running/ready/thread_started/playback_primed/passthrough_mode/buffered_pcm_frames/target_buffer_frames/passthrough_audio_delay_ms/software_volume/pcm_queue`。
- 修改意见：待补充
- 处理结果：已处理。删除 `implementation/reason/last_error` 字段、相关赋值和不再消费的 `decode_error` 临时变量；viewer 音频 worker、队列裁剪、音量、延迟和播放模式控制保持不变。


### DEAD-CODE-P3-087 WASAPI activation attempts/successes 无消费者计数

- 位置：`media-agent/src/wasapi_backend.h:37`、`media-agent/src/wasapi_backend.cpp:455`、`media-agent/src/media_audio.cpp:791`、`media-agent/src/agent_runtime.h:223`
- 问题：`WasapiSessionStatus.activation_attempts/activation_successes` 只在 WASAPI worker 中写入，随后复制到 `AudioSessionState.activation_attempts/activation_successes`；`audio_session_json()`、前端诊断和脚本均不读取或输出这两个计数。
- 影响：保留这条只写计数链路会让 WASAPI activation 指标看起来仍是对外状态面，但当前协议只消费 `captureActive/packetsCaptured/framesCaptured` 和 start/stop RPC 的基础状态。
- 建议：删除 `WasapiSessionStatus` 与 `AudioSessionState` 中无消费者的 activation attempts/successes 字段、写入和复制；保留 WASAPI start failure 的 `reason/last_error` 路径。
- 修改意见：待补充
- 处理结果：已处理。删除 WASAPI activation attempts/successes 字段、worker 写入和 `build_audio_session_state()` 复制；WASAPI 捕获启动、失败记录、pcm packet 回调和 stats 输出保持不变。


### DEAD-CODE-P3-088 OBS ingest 运行态遗留无消费者诊断字段

- 位置：`media-agent/src/agent_runtime.h:353`、`media-agent/src/obs_ingest_runtime.cpp:158`、`media-agent/src/obs_ingest_state.cpp:9`、`server/public/app-native-overrides.js:3131`
- 问题：`ObsIngestState` 中 `listener_active/local_only/audio_packets_received/video_access_units_emitted/audio_frames_forwarded/started_at_unix_ms/connected_at_unix_ms/last_packet_at_unix_ms/ended_at_unix_ms/reason/last_error` 已不再由 `obs_ingest_json()` 输出，前端和脚本也没有字段级消费者；这些字段只在 OBS worker 中写入或清零。`video_ready/audio_ready` 仍被 native attach/relay 开关读取，不属于本项删除范围。
- 影响：保留这些写入型诊断字段会维持已经收窄掉的 OBS stats 影子状态面，并让 stop reason、listener/local-only 和 audio/video forwarded 计数看起来仍是稳定协议或控制状态。
- 建议：删除无消费者 OBS 诊断字段及其写入；保留前端和 native 控制流实际使用的 `prepared/waiting/ingest_connected/stream_running/video_ready/audio_ready/port/width/height/frame_rate/audio_sample_rate/audio_channel_count/video_packets_received/url/listen_url/video_codec/audio_codec/pending_video_annexb_bytes`。
- 修改意见：待补充
- 处理结果：已处理。删除 OBS ingest 无消费者诊断字段、worker 写入和清零逻辑；`stop_obs_ingest_runtime()` 同步移除已无用的 `reason` 参数；OBS 等待/连接/流运行事件、manifest 字段、video ready 门控、audio relay 开关和 `videoPacketsReceived` 诊断保持不变。


### DEAD-CODE-P3-089 FFmpeg capabilities 遗留无消费者能力列表

- 位置：`media-agent/src/ffmpeg_probe.cpp:606`、`media-agent/src/ffmpeg_probe.cpp:674`、`media-agent/src/agent_runtime.h:189`、`server/public/app.js:1797`
- 问题：`FfmpegProbeResult` 的 `hwaccels/bitstream_filters/input_devices/video_decoders/audio_decoders` 只由 FFmpeg probe 采集并通过 `ffmpeg_probe_json()` 输出，项目前端、desktop 桥、脚本和 native 运行逻辑均没有字段级消费者；前端质量面板读取的是 `videoEncoders/validatedVideoEncoders/videoEncoderProbes`，native 音频编码选择读取 `audio_encoders`。
- 影响：保留这些无消费者列表会额外执行 `ffmpeg -hwaccels/-bsfs/-devices/-decoders` 探测并扩大 capabilities 协议面，但当前产品逻辑不使用这些结果。
- 建议：删除无消费者列表字段、对应 FFmpeg 探测命令、JSON 输出以及随之无调用的 `collect_flag_list()` 和 `collect_ffmpeg_devices()` helper；保留视频编码器枚举/验证、自检 probe 和音频编码器枚举。
- 修改意见：待补充
- 处理结果：已处理。删除 `hwaccels/bitstream_filters/input_devices/video_decoders/audio_decoders` 字段、采集命令、JSON 输出和两个无调用 helper；`videoEncoders/validatedVideoEncoders/videoEncoderProbes/audioEncoders` 保持不变。


### DEAD-CODE-P3-090 Surface attachment restart_count 无消费者计数

- 位置：`media-agent/src/agent_runtime.h:295`、`media-agent/src/agent_lifecycle.cpp:151`、`media-agent/src/agent_lifecycle.cpp:220`、`media-agent/src/surface_attachment_runtime.cpp:547`
- 问题：`SurfaceAttachmentState.restart_count` 在前序 `surface_attachment_json()` 收窄后不再输出，项目内也没有控制流读取；当前只在 host capture surface 自动重启和重建路径递增。
- 影响：保留该计数会维持已经删除的 `restartCount` 影子状态面，并让 surface 重启次数看起来仍可被上层诊断消费。
- 建议：删除 `restart_count` 字段和两个递增点；保留实际重启行为、surface reason/error、running/decoder 状态和渲染计数。
- 修改意见：待补充
- 处理结果：已处理。删除 `restart_count` 字段与自动重启/host capture surface restart 路径中的递增语句；surface 重启逻辑和 JSON 输出保持当前收窄后的状态。


### DEAD-CODE-P3-091 WASAPI buffer/silent packet 遗留无消费者状态字段

- 位置：`media-agent/src/wasapi_backend.h:32`、`media-agent/src/wasapi_backend.cpp:216`、`media-agent/src/wasapi_backend.cpp:540`、`media-agent/src/media_audio.cpp:783`、`media-agent/src/agent_runtime.h:210`
- 问题：`WasapiSessionStatus` 与 `AudioSessionState` 中的 `buffer_frame_count/last_buffer_frames/silent_packets` 已不再由 `audio_session_json()` 输出，项目内前端、desktop、脚本和 native 控制逻辑也没有读取；当前只在 WASAPI worker 中写入并复制到 session 快照。
- 影响：保留这条只写状态链路会维持已经收窄掉的 WASAPI buffer/silent packet 影子诊断面，并让捕获缓冲帧数和静音包计数看起来仍是可消费协议字段。
- 建议：删除 `WasapiSessionStatus` 与 `AudioSessionState` 中无消费者字段、WASAPI 写入和 `build_audio_session_state()` 复制；保留实际参与音频包派发的 `packets_captured/frames_captured`、音频格式字段和 silent 标志回调参数。
- 修改意见：待补充
- 处理结果：已处理。删除 `buffer_frame_count/last_buffer_frames/silent_packets` 字段、状态写入和 session 复制；`GetBufferSize()` 初始化检查、WASAPI PCM 包派发、silent packet 回调参数和 `captureActive/packetsCaptured/framesCaptured` 输出保持不变。


### DEAD-CODE-P3-092 Relay subscriber last_video_timestamp_us 无消费者状态字段

- 位置：`media-agent/src/agent_runtime.h:451`、`media-agent/src/relay_dispatch.cpp:464`、`media-agent/src/relay_dispatch.cpp:479`
- 问题：`RelaySubscriberState.last_video_timestamp_us` 在 `relay_subscriber_runtime_json()` 收窄后不再输出，native 内部也没有读取；当前只在 relay subscriber 注册和重注册路径重置为 0。
- 影响：保留该字段会维持已经删除的 `lastVideoTimestampUs` 影子状态面，并让 relay 订阅者状态看起来仍跟踪最后视频时间戳。
- 建议：删除 `last_video_timestamp_us` 字段和注册/重注册路径的清零赋值；保留 `frames_sent`、bootstrap 状态、reason/error 和 relay dispatch queue。
- 修改意见：待补充
- 处理结果：已处理。删除 `last_video_timestamp_us` 字段与两处清零赋值；relay subscriber 注册、bootstrap 重置、fanout worker 和 `relay_subscriber_runtime_json()` 当前输出保持不变。


### DEAD-CODE-P3-093 Relay subscriber/dispatch target 遗留无消费者身份时间字段

- 位置：`media-agent/src/agent_runtime.h:445`、`media-agent/src/agent_runtime.h:453`、`media-agent/src/agent_runtime.h:485`、`media-agent/src/relay_dispatch.cpp:213`、`media-agent/src/relay_dispatch.cpp:252`、`media-agent/src/relay_dispatch.cpp:466`、`media-agent/src/relay_dispatch.cpp:473`、`media-agent/src/relay_dispatch.cpp:479`
- 问题：`RelaySubscriberState.upstream_peer_id/updated_at_unix_ms` 在 `relay_subscriber_runtime_json()` 收窄后不再输出，`query_relay_subscriber_state()` 的消费者也只读取 bootstrap 状态、`frames_sent/reason/last_error`；`RelayDispatchTarget.upstream_peer_id` 只在收集 target 时赋值，没有读取点。
- 影响：保留这些字段会维持已经删除的 `upstreamPeerId/updatedAtMs` 影子状态面，并让 dispatch target 看起来携带上游身份但实际 fanout 仍使用函数参数中的 upstream peer id。
- 建议：删除 relay subscriber 中无消费者的上游身份和更新时间字段、删除 dispatch target 中无消费者的上游身份字段，并移除对应赋值；保留函数参数、队列任务和 bootstrap map 所需的 upstream peer id。
- 修改意见：待补充
- 处理结果：已处理。删除 `RelaySubscriberState.upstream_peer_id/updated_at_unix_ms`、`RelayDispatchTarget.upstream_peer_id` 及其赋值/更新时间写入；relay video/audio fanout 继续使用函数参数和 queued task 的 upstream peer id，media binding 同步继续读取 `frames_sent/reason/last_error`。


### DEAD-CODE-P3-094 Native live preview readback 均值无消费者字段

- 位置：`media-agent/src/native_live_preview.h:26`、`media-agent/src/native_live_preview.cpp:1523`、`media-agent/src/surface_attachment_runtime.cpp:186`
- 问题：`NativeLivePreviewSnapshot.avg_copy_resource_us/avg_map_us/avg_memcpy_us/avg_total_readback_us` 只在 live preview 渲染帧时累计，`refresh_surface_attachment_state()` 不复制这些字段，`surface_attachment_json()` 也已不再输出对应 readback 均值。
- 影响：保留这些字段会让 native live preview snapshot 看起来仍提供 readback 性能诊断，但当前状态链路已经没有消费者，且 peer video sender 的 readback 均值有独立字段和输出。
- 建议：删除 live preview snapshot 的四个 avg 字段和渲染帧时的均值累计块；保留 WGC frame 原始 timing、peer media binding readback 均值、surface 渲染帧数和 frame interval stddev。
- 修改意见：待补充
- 处理结果：已处理。删除 `NativeLivePreviewSnapshot` 四个 avg readback 字段及对应累计逻辑；live preview 渲染、surface 状态刷新、`decodedFramesRendered/frameIntervalStddevMs` 和 peer media binding readback 诊断保持不变。


### DEAD-CODE-P3-095 Native video surface thread_id 无消费者状态字段

- 位置：`media-agent/src/native_video_surface.h:26`、`media-agent/src/native_video_surface.cpp:839`、`media-agent/src/native_video_surface.cpp:1170`、`media-agent/src/agent_runtime.h:124`、`media-agent/src/peer_receiver_runtime.cpp:60`
- 问题：`NativeVideoSurfaceSnapshot.thread_id` 只在 surface 线程启动/窗口创建时写入，并复制到 `PeerVideoReceiverRuntime.thread_id`；后续没有状态 JSON 输出、控制流读取或脚本/前端消费者。
- 影响：保留该字段会维持已经收窄掉的 native surface thread 诊断面，并让 receiver runtime 看起来仍跟踪 surface UI thread id。
- 建议：删除 snapshot/runtime 中的 `thread_id` 字段和两处赋值/复制；保留 Win32 foreground/owner thread 的局部变量，因为它们参与 `AttachThreadInput` 和窗口嵌入逻辑。
- 修改意见：待补充
- 处理结果：已处理。删除 `NativeVideoSurfaceSnapshot.thread_id`、`PeerVideoReceiverRuntime.thread_id` 和相关赋值/复制；Win32 窗口线程附着、surface 创建、receiver runtime 刷新和当前 JSON 输出保持不变。


### DEAD-CODE-P3-096 Peer transport local_candidate_count 无消费者计数

- 位置：`media-agent/src/peer_transport.h:40`、`media-agent/src/peer_transport.cpp:1551`、`media-agent/src/peer_transport.cpp:2485`、`server/public/app-native-overrides.js:2146`
- 问题：`PeerTransportSnapshot.local_candidate_count` 只在 libdatachannel local candidate 回调中递增；`peer_transport_snapshot_json()` 已不输出 `localCandidateCount`，native 逻辑也没有读取。前端显示和 NAT failfast 使用的是 renderer 侧 `meta.localCandidateCount`，不是 native snapshot 字段。
- 影响：保留该字段会维持已经删除的 native `localCandidateCount` 影子状态面，并和 renderer 自有 candidate 计数形成重复概念。
- 建议：删除 `PeerTransportSnapshot.local_candidate_count` 字段和 local candidate 回调中的递增；保留 `remote_candidate_count` 输出、selected candidate pair、回调转发和 renderer 侧 candidate 计数。
- 修改意见：待补充
- 处理结果：已处理。删除 native snapshot 的 `local_candidate_count` 字段和递增；local candidate 仍通过回调发送给上层，remote candidate 计数、selected candidate 诊断和 renderer `meta.localCandidateCount` 保持不变。


### DEAD-CODE-P3-097 Peer transport gathering_state 无消费者状态字段

- 位置：`media-agent/src/peer_transport.h:59`、`media-agent/src/peer_transport.cpp:161`、`media-agent/src/peer_transport.cpp:1608`、`media-agent/src/peer_transport.cpp:1912`、`media-agent/src/peer_transport.cpp:2485`
- 问题：`PeerTransportSnapshot.gathering_state` 在 `peer_transport_snapshot_json()` 收窄后不再输出，也没有 native 控制流读取；当前只由 gathering state callback 和 `refresh_from_peer_connection_locked()` 写入。
- 影响：保留该字段和 `to_gathering_state_string()` 会维持已经删除的 `gatheringState` 影子诊断面，并继续转换一个没有消费者的 libdatachannel 状态。
- 建议：删除 `gathering_state` 字段、两处写入和随之无调用的 `to_gathering_state_string()`；保留仍输出和控制使用的 connection/ICE/signaling 状态。
- 修改意见：待补充
- 处理结果：已处理。删除 `PeerTransportSnapshot.gathering_state`、gathering callback/refresh 写入和 `to_gathering_state_string()`；peer connection state、ICE state、signaling state、candidate pair 和当前 peer transport JSON 输出保持不变。


### DEAD-CODE-P3-098 死代码复扫未确认新的安全删除点

- 位置：`media-agent/src/agent_runtime.h`、`media-agent/src/peer_transport.h`、`server/public/app.js`、`server/public/app-native-overrides.js`、`server/public/style.css`、`vds_web/src/*`、`scripts/*`
- 问题：本轮继续用低引用字段/函数扫描、CMake 源文件清单核对、JS/TS `knip` 扫描、跨脚本 `window.__vds*` 挂载点核对、CSS class/id/keyframes 与 DOM 绑定核对复扫死代码；未发现新的、可由当前证据安全删除的源码项。低引用 native 字段仍接入 JSON、时序控制、线程控制或媒体回调；低引用 JS/TS 函数多为事件入口、动态全局桥或测试入口；CSS 低计数选择器来自静态 HTML class、JS 动态状态或有效动画绑定。
- 影响：如果仅按引用次数继续删除，会误伤动态入口、跨脚本桥接、发布/诊断协议字段或媒体运行时状态；当前应把这批候选标记为已复核保留，避免后续重复把低引用等同于死代码。
- 建议：本轮不删除代码；后续若要继续压缩，应优先引入更强证据，例如编译器未引用符号报告、浏览器运行态覆盖、协议消费者清单或明确废弃的用户修改意见。
- 修改意见：待补充
- 处理结果：已处理。本轮完成复扫并保留所有未能证明无消费者的候选；`knip --reporter json` 返回空问题，`server/public/favicon.ico` 删除已由 `DEAD-CODE-P3-023` 记录，生成产物目录 `dist/` 与 `server/public/vds_web/` 受 `.gitignore` 管理且未纳入源码死代码删除。


### DEAD-CODE-P3-099 Native 头文件与实现文件冗余 include

- 位置：`media-agent/src/peer_media_binding_runtime.h:5`、`media-agent/src/obs_ingest_runtime.h:5`、`media-agent/src/relay_dispatch.h:8`、`media-agent/src/media_audio.h:8`、`media-agent/src/host_state_json.h:5`、`media-agent/src/native_live_preview.cpp:21`、`media-agent/src/native_video_surface.cpp:19`
- 问题：上述 include 在当前公开声明或实现中没有直接提供必要符号：两个 runtime 头文件不暴露 WinSock 类型；`relay_dispatch.h` 与 `media_audio.h` 已通过 `agent_runtime.h` 获得所需 peer transport 类型链；`host_state_json.h` 不直接使用 WGC 类型；两个 native preview/surface 实现文件的自身头文件已经包含 `native_surface_layout.h`。
- 影响：保留这些 include 会扩大头文件依赖面，让调用方无故继承 WinSock/peer transport/WGC/layout 依赖，并增加后续重构时的误判范围；它们属于可由构建验证证明的 include 级死代码。
- 建议：删除这些冗余 include；保留 `.cpp` 中实际需要 WinSock、peer transport、layout 构造函数或 helper 函数的直接 include。
- 修改意见：待补充
- 处理结果：已处理。删除 7 条冗余 include；`verify-media-agent.ps1 -Configuration Release` 与后续 `cmake --build media-agent/build --config Release --target vds-media-agent` 均通过，现有 FFmpeg/MSVC 警告为既有外部 SDK/弃用 API 警告。


### DEAD-CODE-P3-100 Host capture plan 头文件冗余 FFmpeg probe 依赖

- 位置：`media-agent/src/host_capture_plan.h:6`
- 问题：`host_capture_plan.h` 只在函数签名中使用 `FfmpegProbeResult`，该类型已由当前头文件直接包含的 `agent_runtime.h` 定义；没有调用 `ffmpeg_probe.h` 中的 probe/encoder/self-test API。公开声明扫描也未发现可删除的无调用 native 符号。
- 影响：保留 `ffmpeg_probe.h` 会让 host capture plan 的调用方无故继承 FFmpeg probe API 依赖，扩大头文件表面并增加死代码扫描噪音。
- 建议：删除 `host_capture_plan.h` 中的 `ffmpeg_probe.h` include；保留 `wgc_capture.h`，因为该头文件公开返回/接收 `WgcFrameSourceConfig` 与 `WgcCaptureProbe`。
- 修改意见：待补充
- 处理结果：已处理。删除 `host_capture_plan.h` 的冗余 `ffmpeg_probe.h` include；`cmake --build media-agent/build --config Release --target vds-media-agent` 通过，后续完整验证继续覆盖 native 单测和 smoke。


### DEAD-CODE-P3-101 Agent status JSON 聚合文件冗余 include

- 位置：`media-agent/src/agent_status_json.cpp:6`、`media-agent/src/agent_status_json.cpp:15`、`media-agent/src/agent_status_json.cpp:16`
- 问题：`agent_status_json.cpp` 在前序 status/capabilities/ready/stats JSON 输出收窄后，不再直接调用 `host_capture_process.h` 的 process JSON helper、`viewer_audio_playback.h` 的 playback JSON helper，也不再调用 `wgc_capture.h` 的 WGC probe JSON helper；三者当前只剩 include 行。
- 影响：保留这些 include 会让 agent status JSON 聚合文件继续继承已移除输出面的 host capture process、viewer audio playback、WGC probe 依赖，扩大重编译和死代码扫描噪音。
- 建议：删除这三条冗余 include；保留仍直接调用的 `ffmpeg_probe_json`、host state JSON、audio session JSON、OBS ingest JSON、peer/relay/surface JSON 相关 include。
- 修改意见：待补充
- 处理结果：已处理。删除 `host_capture_process.h`、`viewer_audio_playback.h`、`wgc_capture.h` 三条 include；统一验证 `verify-media-agent.ps1 -Configuration Release`、`tsc --noUnusedLocals --noUnusedParameters`、`knip --reporter compact`、`git diff --check` 均通过，`git diff --check` 仅输出既有 LF/CRLF 警告。


### DEAD-CODE-P3-102 Agent runtime 全局头文件冗余 native surface 与 WinMM 依赖

- 位置：`media-agent/src/agent_runtime.h:25`、`media-agent/src/agent_runtime.h:28`、`media-agent/src/agent_runtime.h:29`、`media-agent/src/agent_runtime.h:31`
- 问题：`agent_runtime.h` 只以 `std::shared_ptr` 保存 `NativeArtifactPreview`、`NativeLivePreview`、`NativeVideoSurface`，不需要包含三个 native surface 完整定义；同一头文件也没有直接使用 `mmsystem.h` 暴露的 `WAVEFORMATEX`、`HWAVEOUT` 或 WinMM 常量。继续保留这些 include 会让所有包含 `agent_runtime.h` 的编译单元无故继承 native preview/surface 与 WinMM 依赖。
- 影响：扩大媒体运行时核心状态头文件的依赖面和重编译范围，增加后续死代码扫描噪音；其中 WinMM 类型实际只在 `viewer_audio_playback.cpp` 等实现文件直接使用，不应从全局 runtime 状态头传递。
- 建议：删除 `agent_runtime.h` 的 `mmsystem.h`、`native_artifact_preview.h`、`native_live_preview.h`、`native_video_surface.h` include，并用前置声明表达 shared pointer 成员依赖；保留 `native_surface_layout.h`、`peer_transport.h`、`wgc_capture.h`，因为当前结构体按值持有其类型。
- 修改意见：待补充
- 处理结果：已处理。`agent_runtime.h` 已改为前置声明三个 native surface 类并删除 4 条冗余 include；统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。

### DEAD-CODE-P3-103 已复核保留：入口文件 WinSock include 顺序保护

- 位置：`media-agent/src/agent_rpc_router.cpp:5`、`media-agent/src/main.cpp:5`、`media-agent/src/agent_lifecycle.cpp:5`
- 问题：按直接符号搜索看，三个入口/生命周期文件没有直接调用 `SOCKET`、`WSAStartup`、`sockaddr` 等 WinSock API，容易被误判为冗余 include。
- 影响：实际构建验证证明这些 WinSock include 还承担 Windows 头文件顺序保护作用；删除后 `windows.h` 或下游头会先引入旧 `winsock.h`，再遇到 `winsock2.h/ws2tcpip.h` 时触发 `sockaddr`、`fd_set`、`WSAStartup` 等大量重定义错误。
- 建议：当前保留这些 include；后续若要消除此依赖，应先集中治理 Windows/WinSock include 策略，而不是按单文件符号引用删除。
- 修改意见：待补充
- 处理结果：已处理。尝试删除后运行 `verify-media-agent.ps1 -Configuration Release` 失败并暴露 WinSock/Windows include 顺序冲突，已撤回该尝试并记录为保留项，避免后续重复误删。


### DEAD-CODE-P3-104 Runtime 控制头文件冗余 agent runtime 与 WinSock 依赖

- 位置：`media-agent/src/agent_rpc_router.h:3`、`media-agent/src/peer_control_runtime.h:5`、`media-agent/src/peer_control_runtime.h:9`、`media-agent/src/surface_control_runtime.h:5`、`media-agent/src/surface_control_runtime.h:9`、`media-agent/src/peer_media_binding_runtime.h:5`
- 问题：`agent_rpc_router.h`、`peer_control_runtime.h`、`surface_control_runtime.h` 只在函数声明中使用 `AgentRuntimeState&`；`peer_media_binding_runtime.h` 只在声明中使用 `AgentRuntimeState&` 和 `PeerState&`。这些头文件不需要包含完整 `agent_runtime.h`，其中两个控制头文件也不再需要为传递依赖保留 `winsock2.h/ws2tcpip.h` 顺序保护。
- 影响：保留完整 runtime 头会让 RPC、peer control、surface control、media binding 的调用方无故继承 FFmpeg、WGC、peer transport、Windows 句柄等大型状态依赖；额外 WinSock include 还会扩大 Windows 头文件顺序约束范围。
- 建议：将上述头文件改为 `AgentRuntimeState`/`PeerState` 前置声明；保留 `.cpp` 侧直接 include 自身头和实际运行所需依赖，由实现文件承担完整类型依赖。
- 修改意见：待补充
- 处理结果：已处理。4 个头文件已改为前置声明，删除 `agent_runtime.h` 传递依赖，并删除 `peer_control_runtime.h`、`surface_control_runtime.h` 的 WinSock include；统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。


### DEAD-CODE-P3-105 Command runner 结果类型从全局 runtime 状态头迁出

- 位置：`media-agent/src/agent_runtime.h:166`、`media-agent/src/process_runner.h:3`、`media-agent/src/ffmpeg_probe.h:6`
- 问题：`CommandResult` 只服务于 `process_runner` 命令执行、FFmpeg probe 和 host pipeline 验证，不属于 agent runtime 状态模型；定义在 `agent_runtime.h` 会让所有 runtime 状态调用方继承命令执行结果类型，继续扩大核心状态头文件职责。
- 影响：保留该类型在 `agent_runtime.h` 中会让死代码扫描把命令执行辅助类型误归为媒体运行时状态，并增加 `process_runner.h` 对完整 runtime 状态头的反向依赖。
- 建议：将 `CommandResult` 定义移动到 `process_runner.h`，让 `ffmpeg_probe.h` 通过 `process_runner.h` 获得返回类型；保持 `CommandResult` 全局作用域不变，避免改变既有未限定引用语义。
- 修改意见：待补充
- 处理结果：已处理。`CommandResult` 已从 `agent_runtime.h` 迁到 `process_runner.h`，`ffmpeg_probe.h` 补充 `process_runner.h` 依赖；初次验证发现误放入 `vds::media_agent` 命名空间导致旧未限定引用失败，已修正为全局类型并复跑验证通过。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。


### DEAD-CODE-P3-106 JSON/state 头文件冗余 agent runtime 传递依赖

- 位置：`media-agent/src/agent_status_json.h:5`、`media-agent/src/host_state_json.h:5`、`media-agent/src/obs_ingest_state.h:5`
- 问题：`agent_status_json.h` 只在函数声明中使用 `AgentRuntimeState&` 和 `PeerState&`；`host_state_json.h` 只声明接收 `HostPipelineState`、`HostCapturePlan`、`HostCaptureArtifactProbe` 引用的 JSON helper；`obs_ingest_state.h` 只声明 `ObsIngestState` 引用参数及端口常量。三者都不需要在头文件层面包含完整 `agent_runtime.h`。
- 影响：保留完整 runtime 头会让状态 JSON/OBS ingest state 的轻量调用方无故继承 FFmpeg、WGC、Win32 句柄、peer transport 与 surface runtime 等大型依赖，扩大重编译范围并增加后续死代码扫描噪音。
- 建议：将这 3 个头文件改为前置声明相关状态类型；在对应 `.cpp` 中显式 include `agent_runtime.h`，由实现文件承担完整类型读取依赖。
- 修改意见：待补充
- 处理结果：已处理。`agent_status_json.h`、`host_state_json.h`、`obs_ingest_state.h` 已删除 `agent_runtime.h` include 并改为前置声明，对应 `.cpp` 已补充显式 `agent_runtime.h`；统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。


### DEAD-CODE-P3-107 Media runtime 头文件冗余 agent runtime 传递依赖

- 位置：`media-agent/src/obs_ingest_runtime.h:5`、`media-agent/src/relay_dispatch.h:8`、`media-agent/src/peer_video_sender.h:5`
- 问题：`obs_ingest_runtime.h` 只在声明中使用 `AgentRuntimeState` 引用/指针；`relay_dispatch.h` 只在声明中使用 `PeerTransportSession` shared pointer 与 `RelaySubscriberState*`；`peer_video_sender.h` 只在声明中使用 `FfmpegProbeResult`、`HostPipelineState`、`HostCapturePlan`、`PeerState` 引用。这些公开头文件不需要包含完整 `agent_runtime.h`。
- 影响：保留完整 runtime 头会让 OBS ingest、relay dispatch、peer video sender 的调用方继承 FFmpeg、WGC、Windows 句柄、surface runtime 和 peer transport 状态模型等大型依赖，扩大重编译范围和死代码扫描噪音。
- 建议：将上述头文件改为前置声明；在对应 `.cpp` 中显式 include `agent_runtime.h`，由实现文件承担完整状态结构访问依赖。
- 修改意见：待补充
- 处理结果：已处理。3 个头文件已删除 `agent_runtime.h` include 并改为前置声明，对应 `.cpp` 已补充显式 `agent_runtime.h`；统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：72%。


### DEAD-CODE-P3-108 Host pipeline 头文件冗余 agent runtime 传递依赖

- 位置：`media-agent/src/host_pipeline.h:5`、`media-agent/src/host_pipeline.cpp:7`、`media-agent/tests/media_agent_unit_tests.cpp:6`
- 问题：`host_pipeline.h` 只在函数声明中使用 `FfmpegProbeResult`、`HostCapturePlan`、`HostCaptureProcessState`、`HostPipelineState` 引用或返回类型，不需要在公开头文件层面包含完整 `agent_runtime.h`。测试文件此前通过 `host_pipeline.h` 间接获得这些完整结构定义，属于隐藏依赖。
- 影响：保留完整 runtime 头会让所有 host pipeline 调用方无故继承 FFmpeg probe、WGC、peer transport、Windows 句柄和 surface runtime 等大型状态模型；测试侧隐藏依赖也会掩盖公开头文件真实契约。
- 建议：将 `host_pipeline.h` 改为前置声明相关状态类型，在 `host_pipeline.cpp` 显式 include `agent_runtime.h`；对确实构造这些结构的测试文件补充显式 `agent_runtime.h` include。
- 修改意见：待补充
- 处理结果：已处理。`host_pipeline.h` 已删除 `agent_runtime.h` include 并改为 4 个状态类型前置声明，`host_pipeline.cpp` 与单元测试补充显式完整类型依赖；第一次验证暴露测试隐藏依赖后已修正，复跑 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：73%。


### DEAD-CODE-P3-109 Host session/lifecycle 头文件冗余 runtime 与 WinSock 传递依赖

- 位置：`media-agent/src/host_session_controller.h:6`、`media-agent/src/agent_lifecycle.h:5`、`media-agent/src/host_session_controller.cpp:6`、`media-agent/src/agent_lifecycle.cpp:15`、`media-agent/src/agent_rpc_router.cpp:11`
- 问题：`host_session_controller.h` 只在函数声明和 `std::function` 签名中使用 `AgentRuntimeState&`、`PeerState&`，不需要包含完整 `agent_runtime.h`，也不需要保留 WinSock include。`agent_lifecycle.h` 只声明接收 `AgentRuntimeState&` 的生命周期函数和返回 `HostSessionControllerCallbacks` 的工厂函数，不需要传递完整 runtime 或 host session controller 头。
- 影响：保留这些传递依赖会让 RPC、生命周期和 host session 调用方无故继承 WinSock 头、FFmpeg/WGC/peer transport/surface runtime 等大型媒体状态依赖，扩大 Windows include 顺序约束和重编译范围。
- 建议：将两个公开头文件改为前置声明；在 `host_session_controller.cpp`、`agent_lifecycle.cpp` 和实际读取 runtime 字段的 `agent_rpc_router.cpp` 中显式 include 完整依赖。
- 修改意见：待补充
- 处理结果：已处理。`host_session_controller.h` 已删除 WinSock 与 `agent_runtime.h` include，并前置声明 `AgentRuntimeState`/`PeerState`；`agent_lifecycle.h` 已删除 `agent_runtime.h` 与 `host_session_controller.h` 传递 include，并前置声明 `AgentRuntimeState`/`HostSessionControllerCallbacks`；相关 `.cpp` 补充显式完整依赖。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：74%。


### DEAD-CODE-P3-110 Host video sender soft refresh 空分支与只写标志

- 位置：`media-agent/src/peer_media_binding_runtime.cpp:43`
- 问题：`perform_host_video_sender_soft_refresh()` 末尾存在空 `if (!attempted || all_succeeded) {}` 分支；删除空块后，`attempted` 和 `all_succeeded` 两个局部变量也只剩赋值没有读取。
- 影响：空分支不改变控制流，两个只写标志会误导维护者以为软刷新后存在汇总状态处理；继续保留会增加后续死代码扫描噪音。
- 建议：删除空分支以及仅服务于该空分支的局部标志和赋值，保留每个 peer 的实际软刷新、错误记录和 breadcrumb 行为。
- 修改意见：待补充
- 处理结果：已处理。已删除 `perform_host_video_sender_soft_refresh()` 的空分支、`attempted`/`all_succeeded` 局部变量以及对应只写赋值；统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：75%。


### DEAD-CODE-P3-111 WASAPI probe 结果类型残留在公共头文件

- 位置：`media-agent/src/wasapi_backend.h:5`、`media-agent/src/wasapi_backend.cpp:3`、`media-agent/src/wasapi_backend.cpp:18`、`media-agent/src/wasapi_backend.cpp:725`
- 问题：`WasapiProbeResult` 已只在 `wasapi_backend.cpp` 内部用于构造 session status，`probe_wasapi_backend()` 也已从头文件移除并只被同一翻译单元调用；继续把 probe 结果结构放在公共头文件中会暴露无消费者的内部实现类型。
- 影响：公共 WASAPI API 表面比实际需要更大，调用方会误以为可以依赖 probe 结果结构；后续死代码扫描也会把内部 probe 字段误判为跨模块契约。
- 建议：将 `WasapiProbeResult` 移入 `wasapi_backend.cpp`，并把 `probe_wasapi_backend()` 改为内部链接函数；公共头文件只保留 session status、回调和实际 RPC/控制路径使用的函数。
- 修改意见：待补充
- 处理结果：已处理。`WasapiProbeResult` 已从 `wasapi_backend.h` 移入 `wasapi_backend.cpp`，`probe_wasapi_backend()` 已改为 `static` 内部函数并删除重复外部声明；统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：76%。


### DEAD-CODE-P3-112 媒体状态模型残留无消费者诊断字段

- 位置：`media-agent/src/peer_transport.h:12`、`media-agent/src/peer_transport.cpp:1953`、`media-agent/src/peer_transport.cpp:2457`、`media-agent/src/agent_runtime.h:221`、`media-agent/src/agent_runtime.h:244`、`media-agent/src/host_capture_plan.cpp:306`
- 问题：`PeerTransportBackendInfo.video_track_support`、`PeerTransportBackendInfo.audio_track_support` 只在 backend 探测时赋值并由 `peer_transport_backend_json()` 原样输出，项目内 smoke/front-end/desktop 只消费 `transportReady` 等字段；`HostPipelineState.implementation` 只保留默认值，`HostCapturePlan.implementation` 只在 WGC 计划中写入但不进入 `host_capture_plan_json()`，也没有项目内消费者。
- 影响：这些字段会把未使用的诊断状态伪装成跨模块契约，扩大状态模型和 JSON 输出面；后续维护者可能误以为前端能力判断或 host capture 诊断依赖这些值。
- 建议：删除两个 peer transport backend 支持标志及 JSON 输出，删除 host pipeline/plan 的无消费者 `implementation` 字段和写入；保留 `backend/mode/iceServers` 等仍有诊断价值或独立配置意义的字段。
- 修改意见：待补充
- 处理结果：已处理。已删除 `video_track_support`/`audio_track_support` 字段、赋值和 `peer_transport_backend_json()` 输出；已删除 `HostPipelineState.implementation`、`HostCapturePlan.implementation` 及 WGC plan 写入。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：77%。


### DEAD-CODE-P3-113 Peer transport snapshot 只写更新时间字段

- 位置：`media-agent/src/peer_transport.h:53`、`media-agent/src/peer_transport.cpp:475`、`media-agent/src/peer_control_runtime.cpp:419`
- 问题：`PeerTransportSnapshot.updated_at_unix_ms` 已不再由 `peer_transport_snapshot_json()` 输出，也没有项目内前端、desktop 或 native 逻辑读取；剩余代码只在 peer transport 状态变化和 close peer 路径中写入该字段。
- 影响：只写时间戳会误导维护者以为 peer transport snapshot 仍暴露更新时间诊断；保留大量写入点也增加后续状态字段审计噪音。
- 建议：删除 `updated_at_unix_ms` 字段和 peer transport/close peer 路径中的只写赋值；保留 `PeerState::MediaBindingState.updated_at_unix_ms`，因为它仍用于 media binding 状态表达。
- 修改意见：待补充
- 处理结果：已处理。已删除 `PeerTransportSnapshot.updated_at_unix_ms` 字段、`peer_transport.cpp` 内 30 处只写赋值，以及 `close_peer_from_request()` 中关闭 peer 时的漏写引用；首次验证发现漏删 `peer_control_runtime.cpp` 引用并已修复，复跑 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：78%。


### DEAD-CODE-P3-114 Peer transport snapshot 关闭状态镜像字段

- 位置：`media-agent/src/peer_transport.h:36`、`media-agent/src/peer_transport.cpp:597`、`media-agent/src/peer_control_runtime.cpp:414`
- 问题：`PeerTransportSnapshot.closed` 已不再由 `peer_transport_snapshot_json()` 输出，也没有项目内前端、desktop 或 native 逻辑读取；实际关闭控制由 `PeerTransportSession::closed` 私有标志、`connection_state/ice_state/signaling_state` 字符串和 close peer 事件承担。
- 影响：继续保留 snapshot 层 `closed` 会让维护者误以为对外 JSON 或媒体控制逻辑仍依赖该布尔字段，并在关闭路径形成只写状态镜像。
- 建议：删除 `PeerTransportSnapshot.closed` 字段和 close 路径只写赋值；保留 `PeerTransportSession::closed` 私有生命周期标志，以及 close peer 返回 JSON 中的 `closed:true` 命令结果。
- 修改意见：待补充
- 处理结果：已处理。已删除 `PeerTransportSnapshot.closed` 字段和 `PeerTransportSession::close()` 中只写赋值；首次验证暴露 `close_peer_from_request()` 中漏删的 `it->second.transport.closed = true` 并已修复。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。


### DEAD-CODE-P3-115 Peer transport snapshot backend available 镜像字段

- 位置：`media-agent/src/peer_transport.h:22`、`media-agent/src/peer_transport.cpp:467`、`media-agent/src/peer_control_runtime.cpp:170`、`media-agent/src/peer_media_binding_runtime.cpp:98`
- 问题：`PeerTransportSnapshot.available` 已不再由 `peer_transport_snapshot_json()` 输出，也没有项目内消费者；peer 创建和刷新路径只是把 `PeerTransportBackendInfo.available` 复制到 per-peer snapshot，真实能力状态仍由 backend capability JSON 的 `available/transportReady` 输出。
- 影响：该字段把全局 backend availability 伪装成 per-peer runtime 状态，增加状态模型噪音，并可能让后续维护误判 peer 级 transport readiness 的来源。
- 建议：删除 `PeerTransportSnapshot.available` 字段及构造、create peer、refresh peer transport 中的只写赋值；保留 `PeerTransportBackendInfo.available`，因为 capabilities/status 仍输出它。
- 修改意见：待补充
- 处理结果：已处理。已删除 snapshot 层 `available` 字段、`PeerTransportSession` 构造赋值，以及 create/refresh peer 路径对 backend available 的镜像写入；保留 backend capability 的 `available` 输出。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。


### DEAD-CODE-P3-116 Peer transport backend 永远 false 的 mediaPlaneReady 字段

- 位置：`media-agent/src/peer_transport.h:12`、`media-agent/src/peer_transport.cpp:1920`、`media-agent/src/peer_transport.cpp:2420`、`media-agent/src/peer_media_binding_runtime.cpp:99`
- 问题：`PeerTransportBackendInfo.media_plane_ready` 在 libdatachannel 和 stub backend 分支都固定写入 `false`，能力 JSON 中也没有项目内消费者；实际运行时媒体平面可用性由 `PeerTransportSnapshot.media_plane_ready` 根据 decoder/rendered frames 计算并被 native overrides 诊断读取。
- 影响：backend capability 层的永远 false 字段会与 per-peer snapshot 的真实媒体面状态混淆，并让能力 JSON 暴露无实际语义的诊断项。
- 建议：删除 backend info 的 `media_plane_ready` 字段、固定 false 赋值、backend JSON 输出，以及无 transport session 时向 peer snapshot 复制该字段的代码；保留 `PeerTransportSnapshot.media_plane_ready`。
- 修改意见：待补充
- 处理结果：已处理。已删除 `PeerTransportBackendInfo.media_plane_ready` 及两处固定 false 赋值、`peer_transport_backend_json()` 的 `mediaPlaneReady` 输出和 refresh fallback 中的无效复制；per-peer `PeerTransportSnapshot.media_plane_ready` 未改动。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：81%。


### DEAD-CODE-P3-117 Peer transport snapshot 本地 SDP 类型镜像字段

- 位置：`media-agent/src/peer_transport.h:55`、`media-agent/src/peer_transport.cpp:1484`、`media-agent/src/peer_transport.cpp:1493`
- 问题：`PeerTransportSnapshot.local_description_type` 不再由 `peer_transport_snapshot_json()` 输出，也没有其他项目内消费者；它只在 `onLocalDescription` 回调内写入 snapshot 后立即作为 `on_local_description` 回调参数读取。
- 影响：把一次性 callback 参数存入长期 snapshot 会扩大状态模型，并误导维护者以为 stats/diagnostics 仍暴露 local SDP type。
- 建议：删除 snapshot 字段，把 `to_description_type_string(description.type())` 的结果保留为回调局部变量，继续传给 `on_local_description`。
- 修改意见：待补充
- 处理结果：已处理。已删除 `PeerTransportSnapshot.local_description_type`，`onLocalDescription` 改为局部 `description_type` 传递；SDP type 回调语义不变。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。


### DEAD-CODE-P3-118 Peer transport snapshot 音视频 MID 只写字段

- 位置：`media-agent/src/peer_transport.h:60`、`media-agent/src/peer_transport.h:61`、`media-agent/src/peer_transport.cpp:748`、`media-agent/src/peer_transport.cpp:866`、`media-agent/src/peer_transport.cpp:1378`、`media-agent/src/peer_transport.cpp:1462`、`media-agent/src/peer_transport.cpp:1633`、`media-agent/src/peer_transport.cpp:1640`
- 问题：`PeerTransportSnapshot.video_mid` 和 `PeerTransportSnapshot.audio_mid` 已不再由 snapshot JSON 输出，也没有 native/front-end/desktop 消费者；剩余代码只在 sender/receiver 配置和 onTrack attach 时写入 snapshot。
- 影响：snapshot MID 字段会把 SDP/track 层的内部 MID 写入伪装成对外诊断契约，增加状态字段审计噪音。
- 建议：删除 snapshot 层 `video_mid/audio_mid` 字段和赋值；保留 `config.mid`、`media.mid()`、track attach 和 SDP/RTP 配置中的 MID 逻辑。
- 修改意见：待补充
- 处理结果：已处理。已删除 `PeerTransportSnapshot.video_mid/audio_mid` 及 6 处只写赋值；未改动 SDP description、track attachment 或 RTP 配置中实际使用的 MID。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。


### DEAD-CODE-P3-119 Peer transport track config 无生产者 SSRC 覆盖入口

- 位置：`media-agent/src/peer_transport.h:75`、`media-agent/src/peer_transport.h:90`、`media-agent/src/peer_transport.cpp:661`、`media-agent/src/peer_transport.cpp:798`
- 问题：`PeerVideoTrackConfig::ssrc` 和 `PeerAudioTrackConfig::ssrc` 只有 transport 内部读取分支，没有任何调用方设置 `.ssrc`；当前生产路径实际一直走 `g_next_video_ssrc` / `g_next_audio_ssrc` 自动分配。
- 影响：保留无生产者的配置入口会让调用者误以为可以从媒体绑定层固定 SSRC，也让 transport sender 配置表面比实际用法更大。
- 建议：删除 video/audio track config 的 `ssrc` 字段和条件覆盖分支，保留原有自动递增 SSRC 分配行为。
- 修改意见：待补充
- 处理结果：已处理。已删除两个 `ssrc` 配置字段，`configure_video_sender()` 和 `configure_audio_sender()` 直接使用自动递增 SSRC；全仓搜索确认不再存在 `.ssrc` 生产者缺口。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：84%。


### DEAD-CODE-P3-120 Peer video track config 临时 media binding envelope 字段

- 位置：`media-agent/src/peer_transport.h:70`、`media-agent/src/peer_transport.h:72`、`media-agent/src/peer_transport.h:73`、`media-agent/src/peer_transport.h:74`、`media-agent/src/peer_media_binding_runtime.cpp:241`、`media-agent/src/peer_media_binding_runtime.cpp:397`、`media-agent/src/peer_media_binding_runtime.cpp:639`
- 问题：`PeerVideoTrackConfig::source/width/height/frame_rate` 不被 `configure_video_sender()` 读取，也不参与 SDP/RTP 配置；这些值只在 `peer_media_binding_runtime.cpp` 中作为临时容器，随后写入 `PeerState::MediaBindingState`。
- 影响：transport config 表面混入 media binding 诊断字段，会误导维护者以为 native transport sender 直接消费 source/尺寸/帧率。
- 建议：从 `PeerVideoTrackConfig` 删除这些字段，在 media binding 层使用局部变量继续维护 `peer.media_binding.source/width/height/frame_rate`。
- 修改意见：待补充
- 处理结果：已处理。已删除 `PeerVideoTrackConfig::source/width/height/frame_rate`，OBS ingest、host capture、relay 三条绑定路径改用局部 `video_source/video_width/video_height/video_frame_rate`，保留 media binding 诊断和重配比较逻辑。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。


### DEAD-CODE-P3-121 Peer track config 未读取 enabled 与 audio channel_count 字段

- 位置：`media-agent/src/peer_transport.h:68`、`media-agent/src/peer_transport.h:78`、`media-agent/src/peer_transport.h:84`、`media-agent/src/peer_media_binding_runtime.cpp:236`、`media-agent/src/peer_media_binding_runtime.cpp:321`、`media-agent/src/peer_media_binding_runtime.cpp:392`、`media-agent/src/peer_media_binding_runtime.cpp:551`、`media-agent/src/peer_media_binding_runtime.cpp:632`、`media-agent/src/peer_media_binding_runtime.cpp:719`
- 问题：`PeerVideoTrackConfig::enabled` 和 `PeerAudioTrackConfig::enabled` 只在调用方写 `true`，transport sender 不读取；`PeerAudioTrackConfig::channel_count` 也只在 OBS/relay/host audio 绑定路径写入，没有进入 audio SDP/RTP 配置。
- 影响：这些字段扩大 track config 表面，并暗示存在启停开关或通道数协商能力，但当前实现没有对应消费逻辑。
- 建议：删除未读取字段和调用方只写赋值；保留实际被 transport 使用的 codec/mid/stream_id/track_id/payload_type/sample_rate/bitrate_kbps。
- 修改意见：待补充
- 处理结果：已处理。已删除 video/audio track config 的 `enabled` 字段和 audio config 的 `channel_count` 字段，并清理 6 处 `enabled = true` 与 3 处 `channel_count` 赋值；其他 audio session/OBS ingest 的 channel count 状态未改动。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。


### DEAD-CODE-P3-122 Peer audio track config 冗余默认 sample_rate 赋值

- 位置：`media-agent/src/peer_media_binding_runtime.cpp:556`、`media-agent/src/peer_media_binding_runtime.cpp:724`
- 问题：host audio sender 固定使用 Opus，`PeerAudioTrackConfig::sample_rate` 在 Opus 分支不被 `configure_audio_sender()` 读取；relay audio sender 对 Opus/PCMU 的 sample rate 赋值也不被读取，对 AAC 分支则等于结构默认 48000。
- 影响：冗余赋值会让维护者误以为 Opus/PCMU sender 会消费该采样率字段，增加 audio track config 审计噪音。
- 建议：删除 host/relay audio config 中无行为影响的 `sample_rate` 显式赋值；保留 OBS ingest AAC 路径的采样率赋值，因为 AAC RTP clock rate 仍读取它。
- 修改意见：待补充
- 处理结果：已处理。已删除 host process-loopback audio 和 relay audio 的冗余 `sample_rate` 赋值；OBS ingest AAC 的 `audio_config.sample_rate` 保留。统一验证 `verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check` 均通过，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：87%。


### DEAD-CODE-P3-123 Host capture process 状态结构残留无读取字段

- 位置：`media-agent/src/agent_runtime.h`、`media-agent/src/host_capture_process.cpp`
- 问题：P3-069 收窄 `host_capture_process_json()` 后，`HostCaptureProcessState::launch_attempted`、`last_exit_code`、`implementation`、`output_mode` 已没有项目内读取路径；其中 `launch_attempted/last_exit_code/output_mode` 仍有赋值，`implementation` 仅保留默认值。实际启动、停止、清理和 manifest 持久化仍依赖 `enabled/running/process_handle/command_line/container/session_id/output_path/timestamps/reason/last_error`。
- 影响：状态结构继续携带已脱离协议和控制流的残留字段，增加后续维护误读风险。
- 建议：删除这四个残留字段及对应赋值；保留 host capture process 真正参与生命周期和 artifact manifest 的字段。
- 修改意见：待补充
- 处理结果：已处理。移除 `launch_attempted/last_exit_code/implementation/output_mode` 字段，删除 `output_mode` 初始化、WGC/启动路径的 `launch_attempted` 写入、进程退出路径的 `last_exit_code` 写入，以及 manifest 顶层 `outputMode` 输出。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`。当前死代码清理进度保守估算：88%。


### DEAD-CODE-P3-124 Audio session 与 OBS ingest 残留只写 ready/probe 字段

- 位置：`media-agent/src/agent_runtime.h`、`media-agent/src/media_audio.cpp`、`media-agent/src/obs_ingest_runtime.cpp`、`media-agent/src/peer_media_binding_runtime.cpp`
- 问题：`AudioSessionState::running/platform_supported/device_enumerator_available/render_device_count/bits_per_sample/block_align` 只从 `WasapiSessionStatus` 复制后不再读取；`ObsIngestState::video_ready/audio_ready` 在 P3-067 收窄 JSON 后仍被写入，并且 media binding 只用它们重复判断已有状态。视频 ready 可由 `stream_running` 表达，音频可由 `audio_codec == "aac"` 表达，因为没有音频流时 runtime 已把 `audio_codec` 置空。
- 影响：这些字段让 audio/OBS 运行态继续维护已脱离状态协议或可由权威字段推导的镜像值，增加状态结构噪音和后续误读风险。
- 建议：删除 audio session 的无读取 probe/格式镜像字段；删除 OBS ingest 的 video/audio ready 镜像字段，并把 media binding 门控改为使用 `stream_running` 与 `audio_codec`。
- 修改意见：待补充
- 处理结果：已处理。移除 6 个 `AudioSessionState` 残留字段及 `build_audio_session_state()` 复制赋值；移除 `ObsIngestState::video_ready/audio_ready` 和 runtime 写入；OBS 视频绑定改为只检查 `stream_running`，音频 relay 开关改为 `audio_codec == "aac"`。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`。当前死代码清理进度保守估算：89%。


### DEAD-CODE-P3-125 Peer video sender 与 media binding 残留进程/命令/时间镜像字段

- 位置：`media-agent/src/agent_runtime.h`、`media-agent/src/peer_video_sender.cpp`、`media-agent/src/peer_media_binding_runtime.cpp`
- 问题：P3-063 收窄 `mediaBinding` JSON 后，`MediaBindingState::process_id/command_line` 不再输出或读取；`PeerVideoSenderRuntime::launch_attempted/process_id/started_at_unix_ms/updated_at_unix_ms/stopped_at_unix_ms/last_exit_code/command_line` 也只用于填充这些旧诊断字段或只写入不读取。实际 sender 运行仍依赖 `running`、进程/线程/管道 HANDLE、帧节奏字段、bootstrap 缓存、`reason/last_error` 和统计计数。
- 影响：保留这组镜像字段会让 sender runtime 看起来仍维护进程诊断协议，但协议层已经不消费这些值，增加状态结构和刷新逻辑噪音。
- 建议：删除 sender runtime 与 media binding 中无消费者的进程号、命令行、启动标记和时间/退出码字段；保留本地 `command_line` 变量用于 `CreateProcessW`，保留 breadcrumb 中的即时 PID 输出。
- 修改意见：待补充
- 处理结果：已处理。移除上述 9 个字段及对应赋值/复制/清空；`refresh_peer_media_binding()` 继续同步实际消费的 source frame、readback 均值、frames sent、active、reason/error；sender 启停、管道关闭和 WGC/FFmpeg 发送流程保持不变。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`。当前死代码清理进度保守估算：90%。


### DEAD-CODE-P3-126 Media binding 残留状态协议时间与实现镜像字段

- 位置：`media-agent/src/agent_runtime.h`、`media-agent/src/host_session_controller.cpp`、`media-agent/src/peer_control_runtime.cpp`、`media-agent/src/peer_media_binding_runtime.cpp`、`media-agent/src/peer_video_sender.cpp`
- 问题：P3-063 收窄 `mediaBinding` JSON 后，`MediaBindingState::sender_configured/implementation/attached_at_unix_ms/updated_at_unix_ms/detached_at_unix_ms` 没有项目内读取路径；它们只在 attach、detach、host stop、peer close 或 refresh 路径中被写入。实际 media binding 控制仍依赖 `attached/active/kind/source/codec/width/height/frame_rate/bitrate_kbps/runtime`，前端诊断仍读取 `sourceFramesCaptured/framesSent/readback 均值/videoEncoderBackend/reason/lastError`。
- 影响：这些字段让 media binding 状态结构继续维护已从协议面移除的生命周期时间和实现名镜像，增加 attach/detach 代码噪音。
- 建议：删除无读取的 sender configured、implementation 和三组时间戳字段及其赋值；保留 attach 去重和运行控制实际读取的字段。
- 修改意见：待补充
- 处理结果：已处理。移除 5 个 `MediaBindingState` 残留字段，并清理 host session、peer close、OBS ingest/host/relay attach、detach、sender stop/refresh 路径中的对应赋值；曾误删的 `HostCaptureProcessState::updated_at_unix_ms` 已恢复，因为它仍用于 artifact manifest。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`。当前死代码清理进度保守估算：91%。


### DEAD-CODE-P3-127 Surface attachment 与 peer receiver 残留协议镜像字段

- 位置：`media-agent/src/agent_runtime.h`、`media-agent/src/surface_attachment_runtime.cpp`
- 问题：P3-收窄 `surface_attachment_json()` 后，`PeerVideoReceiverRuntime` 与 `SurfaceAttachmentState` 中的 start/stop 时间戳、退出码和命令行字段已不再输出或读取；peer receiver 侧这些值只在 surface 启停时写入，再同步到 surface 状态，surface 侧也只做清空/赋值。实际 surface 控制仍依赖 `attached/running/waiting_for_artifact/decoder_ready/process_id/runtime handles/layout/reason/last_error`，前端仍消费的身份和调试字段未改动。
- 影响：保留这组镜像字段会让接收端和 surface 状态看起来仍维护旧诊断协议，增加启停路径和同步函数噪音，也留下未使用的 `time_utils.h` include。
- 建议：删除 `PeerVideoReceiverRuntime` 与 `SurfaceAttachmentState` 中无消费者的时间戳、退出码、命令行字段及对应写入/同步，并移除随之失效的 include；保留仍参与状态同步和 UI 诊断的 `launch_attempted/process_id/implementation/window/debug` 字段。
- 修改意见：待补充
- 处理结果：已处理。移除 peer receiver 的 `last_start_attempt_at_unix_ms/last_start_success_at_unix_ms/last_stop_at_unix_ms/last_exit_code/command_line`，移除 surface attachment 的对应时间戳、退出码、命令行字段和写入/同步逻辑，并删除 `surface_attachment_runtime.cpp` 中不再使用的 `time_utils.h`。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`；输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：92%。


### DEAD-CODE-P3-128 Host capture artifact probe 残留诊断字段

- 位置：`media-agent/src/agent_runtime.h`、`media-agent/src/host_capture_process.cpp`、`media-agent/src/host_state_json.cpp`
- 问题：`HostCaptureArtifactProbe::available/frame_rate/media_path/format_name` 已无项目内消费者；`captureArtifact` 自 P3-071 后只进入本地 artifact manifest，前端、desktop 桥、脚本和 native 控制流均不读取这些字段。实际 surface 启动与 artifact 判定仍依赖 `ready/file_size_bytes/width/height/video_codec/reason/last_error`，其中空文件判断可直接由 `file_size_bytes == 0` 表达。
- 影响：继续维护这些字段会让 artifact probe 采集多余 ffprobe 元数据，并让 manifest 里保留已无消费面的诊断噪音。
- 建议：删除 `available/frame_rate/media_path/format_name` 字段及 JSON 输出；ffprobe 查询收窄为 `codec_name,width,height,size`；把空文件分支改为使用 `file_size_bytes == 0`。
- 修改意见：待补充
- 处理结果：已处理。移除 4 个 artifact probe 残留字段及对应赋值、JSON 输出和 `avg_frame_rate/format_name` 解析，删除随之失效的 `<iomanip>` include。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`；输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：93%。


### DEAD-CODE-P3-129 Media binding 与 host capture 残留声明/includes

- 位置：`media-agent/src/peer_media_binding_runtime.cpp`、`media-agent/src/host_capture_process.cpp`、`media-agent/src/agent_runtime.h`
- 问题：前几轮移除 media binding 时间戳、artifact probe 诊断字段和 host capture 旧退出码后，代码中留下了无行为影响的残留：`peer_media_binding_runtime.cpp` 仍有与 header 重复的 `attach_host_video_media_binding()` 前置声明、失效的 `time_utils.h` include 和 `current_time_millis` using；`host_capture_process.cpp` 仍 include `<algorithm>`；`agent_runtime.h` 仍 include `<limits>`。
- 影响：这些残留不会改变运行行为，但会扩大模块表面和 include 图，让后续审计误以为相关时间戳/数值哨兵仍存在。
- 建议：删除重复前置声明、失效 include 和失效 using，保留仍因调用顺序需要的内部前置声明。
- 修改意见：待补充
- 处理结果：已处理。删除上述 4 处残留声明/includes/using。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`；输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：94%。


### DEAD-CODE-P3-130 Receiver/surface 解码时间戳镜像链路残留

- 位置：`media-agent/src/peer_transport.h`、`media-agent/src/peer_transport.cpp`、`media-agent/src/peer_receiver_runtime.cpp`、`media-agent/src/agent_runtime.h`、`media-agent/src/native_video_surface.*`、`media-agent/src/native_live_preview.*`、`media-agent/src/native_artifact_preview.*`、`media-agent/src/surface_attachment_runtime.cpp`
- 问题：`PeerTransportSnapshot::last_decoded_frame_at_unix_ms` 已不再由 `peer_transport_snapshot_json()` 输出，也没有控制流读取；继续通过 `set_peer_transport_decoder_state()` 传入只会维护旧诊断镜像。进一步全仓搜索发现 `PeerVideoReceiverRuntime`、`SurfaceAttachmentState` 以及 native preview snapshots 中的 `last_decoded_frame_at_unix_ms` 也只在 runtime/surface 之间同步，`surface_attachment_json()` 已不再输出 `lastDecodedFrameAtMs`，前端、desktop、脚本均无消费者。
- 影响：该时间戳链路会让 transport、receiver、surface 和 native preview 状态看起来仍维护旧解码时间诊断契约，但当前实际诊断只消费 `decoderReady/decodedFramesRendered/frameIntervalStddevMs/reason/lastError` 等字段。
- 建议：删除 transport snapshot 字段和 `set_peer_transport_decoder_state()` 的时间戳参数；删除 receiver/surface/native preview snapshots 的旧时间戳字段和同步赋值；清理随之失效的 `current_time_millis` using 与不再需要的 include。
- 修改意见：待补充
- 处理结果：已处理。已删除 transport 层 `last_decoded_frame_at_unix_ms` 字段、接口参数和赋值，`set_peer_transport_decoder_state()` 仅同步 `decoder_ready/decoded_frames_rendered`；同时删除 receiver runtime、surface attachment、native video surface、live preview、artifact preview 中旧解码时间戳字段与同步链路，并清理 `native_artifact_preview.cpp` 的失效 `time_utils.h` include 以及两个 native preview 文件中失效的 `current_time_millis` using。全仓搜索确认 `last_decoded_frame_at_unix_ms/lastDecodedFrame` 已无代码、前端或脚本引用；已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：95%。


### DEAD-CODE-P3-131 Surface/native preview 后端诊断镜像残留

- 位置：`media-agent/src/agent_runtime.h`、`media-agent/src/native_video_surface.h`、`media-agent/src/native_video_surface.cpp`、`media-agent/src/native_live_preview.h`、`media-agent/src/native_live_preview.cpp`、`media-agent/src/native_artifact_preview.h`、`media-agent/src/native_artifact_preview.cpp`、`media-agent/src/peer_receiver_runtime.cpp`、`media-agent/src/surface_attachment_runtime.cpp`
- 问题：P3-127/P3-130 收窄 surface 和 receiver 诊断后，`launch_attempted`、`preview_surface_backend`、`decoder_backend` 已不再由 `surface_attachment_json()` 或 receiver JSON 输出，也没有前端、desktop、脚本或控制流消费者；它们只在 `NativeVideoSurfaceSnapshot`、`NativeLivePreviewSnapshot`、`NativeArtifactPreviewSnapshot`、`PeerVideoReceiverRuntime`、`SurfaceAttachmentState` 之间复制。`NativeVideoSurface::Impl::decoder_backend_` 也只服务这个已失效的 snapshot 字段。
- 影响：保留这些镜像会让 surface/native preview 状态看起来仍提供旧后端诊断协议，增加状态结构和刷新同步噪音；同时让硬件解码尝试路径维护一个没有消费者的后端字符串。
- 建议：删除上述 snapshot/runtime/state 字段与赋值/同步逻辑；移除 `decoder_backend_` 成员及其赋值；保留实际运行仍依赖的 `decoder_ready/decoded_frames_rendered/frame_interval_stddev_ms/codec_path/implementation/process_id/window/debug/reason/last_error`。
- 修改意见：待补充
- 处理结果：已处理。删除 surface/native preview 后端诊断镜像字段、同步赋值和旧 JSON 名称残留；`NativeVideoSurface` 仍继续尝试 D3D11VA/DXVA2 硬件解码并用 `hw_pixel_format_` 控制 fallback，只是不再维护无消费者的后端字符串。全仓搜索确认 `launch_attempted/preview_surface_backend/decoder_backend/decoder_backend_` 以及 `launchAttempted/previewSurfaceBackend/decoderBackend` 已无剩余引用；已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`，输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：96%。


### DEAD-CODE-P3-132 Surface/native preview 媒体路径诊断镜像残留

- 位置：`media-agent/src/agent_runtime.h`、`media-agent/src/native_live_preview.h`、`media-agent/src/native_live_preview.cpp`、`media-agent/src/native_artifact_preview.h`、`media-agent/src/native_artifact_preview.cpp`、`media-agent/src/surface_attachment_runtime.cpp`
- 问题：P3-127/P3-131 收窄 surface 诊断后，`SurfaceAttachmentState::manifest_path` 只从 `HostCaptureProcessState::manifest_path` 复制但不再输出或读取；`NativeLivePreviewSnapshot::media_path` 与 `NativeArtifactPreviewSnapshot::media_path` 也只回写到 `SurfaceAttachmentState::media_path`，而该字段不再对外输出，实际 artifact preview 启动仍使用 `SurfaceAttachmentState::media_path` 和 `NativeArtifactPreviewConfig::media_path`。
- 影响：这组镜像会让 surface/native preview 状态继续维护已脱离协议的路径诊断值，增加 attachment refresh 路径噪音，并容易和仍然有效的 host manifest 路径、artifact preview 输入路径混淆。
- 建议：删除 attachment 层无消费者的 manifest path 镜像；删除 live/artifact preview snapshot 的 media path 字段和回写赋值；保留 host capture process 的 manifest path 写入、surface 启动用 media path、artifact preview config/open input 路径。
- 修改意见：待补充
- 处理结果：已处理。移除 `SurfaceAttachmentState::manifest_path`、`NativeLivePreviewSnapshot::media_path`、`NativeArtifactPreviewSnapshot::media_path` 及对应赋值/同步；保留 `HostCaptureProcessState::manifest_path` 用于 manifest 写入和 host process JSON，保留 `NativeArtifactPreviewConfig::media_path` 用于等待/打开媒体文件。全仓搜索确认 `snapshot.media_path` 与 attachment 层 `manifest_path` 镜像已无剩余引用。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`；输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：97%。


### DEAD-CODE-P3-133 Viewer playback mode 固定 passthrough 配置/API 残留

- 位置：`server/public/app.js`、`desktop/main.js`、`desktop/preload.js`、`media-agent/src/agent_rpc_router.cpp`、`media-agent/src/viewer_audio_playback.h`、`media-agent/src/viewer_audio_playback.cpp`
- 问题：viewer playback mode 只剩固定 `passthrough`：前端常量只有一个值，UI toggle 已无对应 DOM 且逻辑中被禁用；join 前仍调用 `setViewerPlaybackMode`，但 Electron/agent 侧最终忽略请求内容并强制 passthrough。实际可调项已经是 `viewerAudioDelayMs` / `setViewerAudioDelay`。
- 影响：这条模式配置链让前端偏好、join payload、Electron IPC、media-agent RPC 和 C++ handler 继续维护一个不可变选项，增加协议表面和误判空间。
- 建议：删除固定 playback mode 常量、偏好字段、join payload 字段、Electron preload/main IPC、media-agent `setViewerPlaybackMode` 路由和 C++ handler；保留 `setViewerAudioDelay` 以及 runtime 中真实参与音频排队的 passthrough delay 字段。
- 修改意见：待补充
- 处理结果：已处理。移除前端 `VIEWER_PLAYBACK_MODES`、`viewerPlaybackPrefs.mode`、`viewerPlaybackMode` join 字段和 `applyNativeViewerPlaybackPrefs()` 的 mode 参数壳；移除 Electron `setViewerPlaybackMode` preload/main IPC；移除 media-agent `setViewerPlaybackMode` 路由和 `set_viewer_playback_mode_from_request()` 声明/实现。全仓搜索确认 `setViewerPlaybackMode/media-engine-set-viewer-playback-mode/set_viewer_playback_mode_from_request/viewerPlaybackMode/viewerPlaybackModeToggle/VIEWER_PLAYBACK_MODES/viewer-playback-mode/includeMode` 已无剩余引用。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`；输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：98%。


### DEAD-CODE-P3-134 Audio backend status 独立 RPC 残留

- 位置：`desktop/main.js`、`media-agent/src/agent_rpc_router.cpp`、`media-agent/src/agent_lifecycle.h`、`media-agent/src/agent_lifecycle.cpp`
- 问题：`getAudioBackendStatus` 已无前端或 Electron preload 暴露/调用，`desktop/main.js` 仅剩 debug category 分支，media-agent 仍保留独立 RPC 路由和 `get_audio_backend_status_result()`。当前音频状态诊断已经由 `getStats()` 的 `audioBackend` 输出覆盖，并被 `app-native-overrides.js` 消费。
- 影响：保留无入口的独立音频状态 RPC 会扩大 agent 协议表面，并让 lifecycle 中维护一个只有旧路由使用的包装函数。
- 建议：删除 `getAudioBackendStatus` debug 分类、agent RPC 路由和 lifecycle 声明/实现；保留 `audio_session_json()`、`build_audio_session_state()` 及 `getStats().audioBackend` 路径。
- 修改意见：待补充
- 处理结果：已处理。移除 `getAudioBackendStatus` 在 Electron debug 分类和 media-agent RPC/lifecycle 中的残留；全仓搜索确认 `getAudioBackendStatus/get_audio_backend_status_result/media-engine-get-audio-backend-status` 已无剩余引用。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`；输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：99%。


### DEAD-CODE-P3-135 前端调试配置旧自同步 window 桥残留

- 位置：`server/public/app.js`
- 问题：`window.__vdsSetDebugModeState` 与 `window.__vdsSetDebugConfigState` 只在 `app.js` 内部由 `propagateDebugConfig()` 调用，`app-native-overrides.js` 和其它模块均不消费；调用时又把当前已经写入的 `debugConfig` 回写到自身并重复 `syncDebugUi()`。
- 影响：这两个 window 桥保留了旧的双向调试同步形态，但当前实际同步只需要 `window.electronAPI.setDebugConfig(config)` 向主进程传播；自调用桥增加全局表面和重复 UI 同步。
- 建议：删除 `propagateDebugConfig()` 中对这两个 window 桥的自调用，并删除对应全局赋值；保留 native override 实际消费的 `__vdsIsDebugModeEnabled/__vdsShouldDebugLog/__vdsRenderViewerPlaybackPrefsUi/__vdsRefreshQualitySettingsUi` 等导出。
- 修改意见：待补充
- 处理结果：已处理。移除 `__vdsSetDebugModeState/__vdsSetDebugConfigState` 自调用和全局赋值；全仓搜索确认两者已无剩余引用，其它 `__vds...` 导出仍有 native override 消费。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`；输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：99.5%。


### DEAD-CODE-P3-136 Viewer audio 非 passthrough 缓冲模式残留

- 位置：`media-agent/src/agent_runtime.h`、`media-agent/src/viewer_audio_playback.cpp`
- 问题：P3-133 删除固定 `setViewerPlaybackMode` 后，viewer audio runtime 只剩 passthrough 模式；`ViewerAudioPlaybackRuntime::passthrough_mode` 永远为 true，`target_buffer_frames` 只在不可达的非 passthrough 分支读取。
- 影响：保留该分支会让音频播放 runtime 看起来仍支持第二种缓冲模式，但当前唯一可调项是 passthrough audio delay；这会增加状态结构和 worker 等待条件噪音。
- 建议：删除 `passthrough_mode`、`target_buffer_frames` 字段和非 passthrough 分支；把队列 release time、startup buffer、max buffered frame 逻辑收窄为当前实际 passthrough 行为。
- 修改意见：待补充
- 处理结果：已处理。移除 `passthrough_mode/target_buffer_frames` 字段，折叠 worker 等待条件和 PCM 入队 release time 为 passthrough 路径，并把 startup frame helper 改为无参函数；全仓搜索确认 `passthrough_mode/target_buffer_frames` 已无剩余引用。已通过 `scripts\verify-media-agent.ps1 -Configuration Release`、`npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npx knip --reporter compact`、`git diff --check`；输出仅保留既有 FFmpeg/MSVC 警告和 Git LF/CRLF 提示。当前死代码清理进度保守估算：99.8%。


## 2026-06-19 全量代码终审（子代理并行审查）

### FINAL-AUDIT-P1-001 Viewer audio worker 打开设备失败后不可恢复

- 位置：`media-agent/src/viewer_audio_playback.cpp:64`、`media-agent/src/viewer_audio_playback.cpp:269`
- 问题：`ensure_viewer_audio_playback_runtime()` 在启动 worker 前设置 `thread_started = true`；worker 内 `waveOutOpen()` 失败时只设置 `running = false`、`ready = false` 并直接返回，没有重置 `thread_started`，后续 `ensure_viewer_audio_playback_runtime()` 会因为 `thread_started` 仍为 true 直接返回。
- 影响：一次瞬时 Windows 音频设备打开失败可能让 viewer 本地音频播放在 agent 生命周期内永久不可恢复，后续 PCM 仍会入队/丢弃但不会再启动播放线程。
- 建议：在 `waveOutOpen()` 失败分支中重置 `thread_started`，清理/通知运行状态，并记录可诊断错误；必要时允许下一次音频包触发重新启动。
- 修改意见：按建议修改
- 处理结果：已处理。`waveOutOpen()` 失败分支现在会恢复 `thread_started = false`、清理 ready/running/primed/buffered 状态并通知等待线程，后续音频包可重新触发 worker 启动；已通过 `scripts\verify-media-agent.ps1 -Configuration Release`。

### FINAL-AUDIT-P1-002 Relay bootstrap 状态在实际发送成功前被清除

- 位置：`media-agent/src/relay_dispatch.cpp:130`、`media-agent/src/relay_dispatch.cpp:342`
- 问题：`collect_relay_video_bootstrap_access_units()` 只是在收集 bootstrap access units 时就设置 `bootstrap_snapshot_sent = true`、`pending_video_bootstrap = false`；真正发送发生在后续 fanout 循环中，且 `send_peer_transport_*` 可能失败。
- 影响：如果 relay 订阅者初始 config/keyframe 发送瞬时失败，后续状态已不再标记需要 bootstrap，订阅者可能收到 delta frame 但缺少解码配置或随机访问帧，表现为黑屏直到后续关键帧或重新 attach。
- 建议：只在所有 bootstrap units 发送成功后清除 pending 状态；发送失败时重新置位 `pending_video_bootstrap` 或保留未完成状态。
- 修改意见：按建议修改
- 处理结果：已处理。relay bootstrap 收集阶段不再提前清除 `pending_video_bootstrap/bootstrap_snapshot_sent`；只有 bootstrap units 全部发送成功后才提交 bootstrap 状态，发送失败会保留 pending 以便后续重试；已通过 `scripts\verify-media-agent.ps1 -Configuration Release`。

### FINAL-AUDIT-P2-001 Artifact preview 部分打开失败路径泄漏 FFmpeg input context

- 位置：`media-agent/src/native_artifact_preview.cpp:189`、`media-agent/src/native_artifact_preview.cpp:266`
- 问题：`open_input()` 在 `avformat_open_input()` 成功后，如果 `avformat_find_stream_info()` 失败或找不到 video stream，会返回 false；调用方失败后 sleep/retry，但没有对非空 `AVFormatContext*` 调用 `avformat_close_input()`。
- 影响：对损坏、增长中或不完整 artifact 的重复 preview 尝试可能泄漏文件句柄和 FFmpeg 分配，长期运行后影响预览恢复和文件清理。
- 建议：`open_input()` 在所有成功 open 后的失败分支关闭并置空 context，或让调用方在失败且指针非空时统一 close。
- 修改意见：按建议修改
- 处理结果：已处理。`open_input()` 在 `avformat_open_input()` 成功后的 stream info 失败、video stream 缺失分支中会调用 `avformat_close_input()` 关闭并置空 context，避免 retry 泄漏；已通过 `scripts\verify-media-agent.ps1 -Configuration Release`。

### FINAL-AUDIT-P2-002 `stopHostSession` 会重启整个 media agent，生命周期边界过大

- 位置：`desktop/main.js:1733`、`server/public/app-native-overrides.js:3595`
- 问题：`media-engine-stop-host-session` 进入 `invokeMediaEngineHostSessionBridge('stopHostSession')` 后，即使 native stop 调用完成，也会 `manager.stop()`、等待 100ms、再 `manager.start()`；前端正常停止共享清理同时还会并发停止 audio session、关闭 peer。
- 影响：停止 host session 的语义扩张为重启全局 agent 进程，可能打断并发 `getStats`、surface detach、peer close、audio stop 等 RPC/事件流，造成超时、状态丢失或重启竞态。
- 建议：优先让 native `stopHostSession` 只清理 host pipeline；只有不可恢复状态才执行 agent 进程级重启，并在重启窗口串行化或拒绝其它 media IPC。
- 修改意见：按建议修改
- 处理结果：已处理。`desktop/main.js` 中 `stopHostSession` 成功或失败后不再默认 `manager.stop()/manager.start()` 重启整个 media agent，调用边界收窄为 native host pipeline 停止；已通过 `node --check desktop\main.js`、`npm run test:server`。

### FINAL-AUDIT-P2-003 Web viewer 刷新后复用 clientId 但丢失 sessionToken

- 位置：`vds_web/src/main.ts:207`、`vds_web/src/main.ts:266`、`server/server-core.js:298`
- 问题：`joinRoom()` 只从内存态 `session` 读取 `sessionToken`；`handleJoined()` 虽把 session 写入 `sessionStorage`，但启动时没有恢复读取。与此同时 Web viewer 会从 `sessionStorage` 复用同一个 `vds-web-client-id`。
- 影响：同一 tab 刷新后 clientId 仍相同但内存 session 为空，重入同房间时不带 token，服务端识别为 existing viewer 后会返回 `session-token-invalid`，断线宽限期内的观看恢复可能失败。
- 建议：启动时读取并校验 `vds-web-session`，加入同房间时带上保存 token；失败时清理陈旧 session，避免空 token 重试。
- 修改意见：按建议修改
- 处理结果：已处理。VDS Web 启动时会从 `sessionStorage` 恢复同 clientId 的 `vds-web-session` 并在 join 同房间时携带 token；`session-token-invalid` 会清理陈旧 session；页面刷新/关闭不再主动发送 `leave-room`，用户点击离开时才清理持久 session；已通过 `npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npm run build:vds-web`、`npm run test:vds-web`。

### FINAL-AUDIT-P2-004 日志门禁漏掉 `console.info`

- 位置：`scripts/check-logging-policy.ps1:11`、`vds_web/src/main.ts:94`
- 问题：日志检查正则只覆盖 `console.log|warn|error|debug`，没有覆盖 `console.info`；`vds_web/src/main.ts` 存在多处 `console.info` 诊断输出，`npm run check:logging` 仍通过。
- 影响：VDS Web 生产包可能带入未受控的高频诊断日志、敏感状态快照或性能噪声，release gate 无法拦截后续新增的 `console.info`。
- 建议：把 `console.info` 纳入日志门禁，并为 VDS Web 明确受控 wrapper/采样规则；优先扫描 `vds_web/src/**/*.ts` 源码而不是只依赖构建产物。
- 修改意见：按建议修改
- 处理结果：已处理。`scripts/check-logging-policy.ps1` 已把 `console.info` 纳入检查并扫描 `vds_web/src/*.ts`，VDS Web 裸 info 输出统一收口到 `logVdsWebInfo()` wrapper；生成目录 `server/public/vds_web/` 在日志门禁中跳过，由源码和 build 负责；已通过 `npm run check:logging`、`npm run build:vds-web`。

### FINAL-AUDIT-P3-001 preload 暴露的 native host bridge 开关与 main 执行不一致

- 位置：`desktop/preload.js:6`、`desktop/main.js:12`、`desktop/main.js:185`
- 问题：preload 暴露 `enableNativeHostSessionBridge` 时读取 `VDS_ENABLE_NATIVE_HOST_SESSION_BRIDGE !== '0'`，但 main 进程把 `ENABLE_NATIVE_HOST_SESSION_BRIDGE` 硬编码为 true，并始终注册/执行 start/stop host session IPC。
- 影响：设置 `VDS_ENABLE_NATIVE_HOST_SESSION_BRIDGE=0` 时，渲染层认为 native bridge 已关闭，但主进程仍接受 IPC，调试降级或禁用 native bridge 时会出现行为和权限边界不一致。
- 建议：main 进程使用与 preload 相同的环境变量判断，并在 IPC handler 层强制返回 disabled，而不是只依赖 renderer 侧隐藏或绕过。
- 修改意见：按建议修改
- 处理结果：已处理。`desktop/main.js` 的 `ENABLE_NATIVE_HOST_SESSION_BRIDGE` 改为读取 `VDS_ENABLE_NATIVE_HOST_SESSION_BRIDGE !== '0'`，与 preload 暴露的 runtime config 对齐，disabled 时 IPC handler 返回 disabled 结果；已通过 `node --check desktop\main.js`。

### FINAL-AUDIT-P3-002 Electron public 页面在非 Electron 路径下会加载 native override 并抛错

- 位置：`server/public/index.html:474`、`server/public/app-native-overrides.js:32`、`server/server-core.js:122`
- 问题：`index.html` 无条件加载 `app-native-overrides.js`；该脚本在没有 `window.isElectron` 或 `electronAPI.mediaEngine` 时直接抛出 `native-media-engine-unavailable`。服务端只对 `/` 且存在 `vds_web/index.html` 的非 Electron UA 做分流，直接访问 `/index.html` 或缺少 VDS Web 构建时会落到 Electron shell。
- 影响：浏览器访问公共静态页会出现顶层运行时异常；部署缺少 `vds_web` 或用户直开 `/index.html` 时，页面控制台硬错误并可能进入 native authority override 缺失失败。
- 建议：`app-native-overrides.js` 在非 Electron 环境 no-op return，或服务端把 Electron shell 与 Web public shell 分开路由，浏览器访问 `/index.html` 时重定向到 `/vds_web/` 或返回明确错误页。
- 修改意见：按建议修改
- 处理结果：已处理。`app-native-overrides.js` 在非 Electron 或缺少 `electronAPI.mediaEngine` 时直接 no-op return，不再抛出顶层 `native-media-engine-unavailable`；保留运行期 native authority 缺失的细分错误；已通过 `node --check server\public\app-native-overrides.js`。

### FINAL-AUDIT-P3-003 Docker context 检查未校验 update manifest 引用文件

- 位置：`scripts/check-server-docker-context.js:5`、`server/Dockerfile:12`、`server/updates/latest.yml`
- 问题：Docker context 检查只要求 `server/updates/latest.yml` 存在，没有解析 `latest.yml` 的 `path` / `files[].url` 并校验对应 installer 与 `.blockmap` 是否存在且非空；Dockerfile 会复制整个 `updates/` 目录。
- 影响：`npm run check:server-docker` 可能在更新包缺失时仍通过，镜像可以构建但 `/updates/latest.yml` 指向 404，自动更新链路要到部署后才暴露问题。
- 建议：解析 `latest.yml` 并校验 referenced installer、`${path}.blockmap` 存在且非空；必要时校验 sha512/size 与 installer 一致，或复用 `release-check.js` 的 manifest 校验逻辑。
- 修改意见：按建议修改
- 处理结果：已处理。`scripts/check-server-docker-context.js` 会解析 `server/updates/latest.yml` 中的 `path/url` 引用，校验 installer 和对应 `.blockmap` 存在且非空；已通过 `npm run check:server-docker`。

### FINAL-AUDIT-P4-001 Encoded relay media sequence 不具备单调性

- 位置：`media-agent/src/relay_dispatch.cpp:350`、`media-agent/src/relay_dispatch.cpp:648`、`media-agent/src/peer_transport.cpp:978`
- 问题：video relay 的 encoded sequence 使用 fanout 调用内局部 `sent_frames`，每次调用从 0 开始；audio relay 直接把 `encoded_frame.sequence` 写为 0。datachannel header 仍会序列化该 sequence。
- 影响：当前接收端若只依赖 timestamp 仍可工作，但 sequence 不能用于跨帧排序、丢包检测、去重或诊断；未来消费者若按 sequence 语义扩展，会遇到重复/非单调值。
- 建议：为每个 relay subscriber 或每条 upstream 维护音视频独立单调 sequence；若协议不承诺该字段语义，则在协议文档和诊断中明确它不可用于排序。
- 修改意见：按建议修改
- 处理结果：已处理。`RelaySubscriberState` 增加音视频独立 sequence，encoded video/audio relay 使用订阅者当前 sequence 并在真实发送成功后推进，避免每轮 fanout 或每个 audio frame 从 0 重置；已通过 `scripts\verify-media-agent.ps1 -Configuration Release`。

### FINAL-AUDIT-P4-002 VDS Web 链中位置 UI 使用 0 基字段

- 位置：`vds_web/src/main.ts:280`、`vds_web/src/main.ts:1011`、`server/public/app-native-overrides.js:4043`
- 问题：服务端协议中的 `chainPosition` 为 0 基；桌面 native viewer 显示时加 1，但 VDS Web 在加入和诊断渲染时直接显示原始 `chainPosition`。
- 影响：Web viewer 首位显示为 0，桌面 viewer 显示为 1，同一概念在两个 UI 中不一致，排障和用户理解链路位置时容易误判。
- 建议：UI 显示层统一使用 `chainPosition + 1`；协议/诊断内部继续保留 0 基字段时，应在字段名或文案中明确含义。
- 修改意见：按建议修改
- 处理结果：已处理。VDS Web 新增 `formatChainPosition()`，加入房间、链路重连和诊断渲染均以 `chainPosition + 1` 显示，协议和 diagnostics 内部仍保留 0 基字段；已通过 `npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`、`npm run build:vds-web`。


## 2026-06-19 决审补充复核

### FINAL-REVIEW-P1-001 Viewer audio worker 失败线程 joinable 导致重启崩溃

- 位置：`media-agent/src/viewer_audio_playback.cpp:67`、`media-agent/src/viewer_audio_playback.cpp:269`
- 问题：`waveOutOpen()` 失败分支把 `thread_started` 置回 false 后直接返回，但 `runtime.worker` 仍是 joinable；下一次 `ensure_viewer_audio_playback_runtime()` 只看 `thread_started`，给 joinable `std::thread` 重新赋值会触发 `std::terminate`。
- 影响：音频设备瞬时打开失败后，后续远端音频帧可能导致 media-agent 进程崩溃。
- 建议：重启前先把已结束但仍 joinable 的 worker 移出并 join，再创建新线程。
- 修改意见：按建议修改
- 处理结果：已处理。`ensure_viewer_audio_playback_runtime()` 现在在发现 `thread_started == false` 且 `worker.joinable()` 时先移动并 join 旧线程，再二次检查状态并启动新 worker；已通过 `scripts\verify-media-agent.ps1 -Configuration Release`。

### FINAL-REVIEW-P1-002 Relay audio sequence 并发分配不原子

- 位置：`media-agent/src/relay_dispatch.cpp:695`
- 问题：audio relay 先查询 `audio_sequence`，释放锁后发送，发送成功后才递增；音频 fanout 入口没有统一串行化，并发调用可能读到相同 sequence。
- 影响：encoded audio datachannel 可能出现重复 sequence，影响接收端排序、去重或丢包诊断。
- 建议：在 relay 状态锁下原子分配并递增 audio sequence；发送失败允许 sequence gap，不复用已分配序号。
- 修改意见：按建议修改
- 处理结果：已处理。新增 `reserve_relay_subscriber_audio_sequence()` 在 relay 锁下读取并递增 sequence，encoded audio 发送前先分配序号，发送失败不回退；已通过 `scripts\verify-media-agent.ps1 -Configuration Release`。

### FINAL-REVIEW-P1-003 Artifact preview stop 状态存在数据竞争

- 位置：`media-agent/src/native_artifact_preview.cpp:139`、`media-agent/src/native_artifact_preview.cpp:184`、`media-agent/src/native_artifact_preview.cpp:207`
- 问题：`stop_requested_` 和 `stop_reason_` 在 `stop()` 中持锁写入，但 worker 线程无锁读取；普通 bool/string 跨线程无统一同步存在数据竞争。
- 影响：停止流程存在未定义行为风险，可能造成停止原因错乱、读循环不能及时退出或 join 偶发卡住。
- 建议：停止标志改为 atomic，停止原因读写统一通过 mutex 复制快照。
- 修改意见：按建议修改
- 处理结果：已处理。`stop_requested_` 改为 `std::atomic<bool>` 并使用 load/store；`stop_reason_` 通过持锁读取快照后再用于关闭 surface 和写回 snapshot，避免 worker 无锁读取 string；已通过 `scripts\verify-media-agent.ps1 -Configuration Release`。

### FINAL-REVIEW-P1-004 Web viewer session restore 只读不自动恢复

- 位置：`vds_web/src/main.ts:37`、`vds_web/src/main.ts:163`、`vds_web/src/main.ts:190`
- 问题：启动时可从 `sessionStorage` 恢复 `session`，但 `bootstrap()` 只刷新配置和房间并显示等待加入，没有自动发 `join-room`；同时房间按钮因 `Boolean(session)` 被禁用。
- 影响：Web viewer 刷新后无法在断线宽限期内自动恢复，且大厅按钮可能被禁用，用户体验卡在未加入状态。
- 建议：bootstrap 成功后若存在 stored session，则以 stored roomId/token 自动 join；恢复失败清理 session 并恢复可加入状态。
- 修改意见：按建议修改
- 处理结果：已处理。新增 `restoringStoredSession` 状态；bootstrap 获取配置和房间后若存在 stored `roomId/sessionToken`，会设置恢复状态并自动调用 `joinRoom()`，失败或 token invalid 时清理 stored session；大厅按钮只在非恢复中的 active session 下禁用；已通过 `npx tsc -p vds_web\tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`。

### FINAL-REVIEW-P1-005 stopHostSession 失败后缺少 agent fallback 恢复

- 位置：`desktop/main.js:1725`、`server/public/app-native-overrides.js:3595`
- 问题：前一轮收窄 `stopHostSession` 后同时删除了失败 fallback；renderer stop flow 对 `stopHostSession` 错误 `.catch(() => {})`，可能在底层未停止时继续清理 UI 和离房。
- 影响：native stop 失败时 host capture/agent 状态可能残留，下一次开播遇到旧 session 或资源占用。
- 建议：保留失败路径的 agent stop/start fallback，但不恢复成功后的无条件重启。
- 修改意见：按建议修改
- 处理结果：已处理。`invokeMediaEngineHostSessionBridge()` 在 `stopHostSession` 抛错时会执行 `manager.stop()`、短暂等待、再 `manager.start()` 的恢复 fallback；成功路径仍不重启 agent；已通过 `node --check desktop\main.js`。

### FINAL-REVIEW-P2-001 Docker context 检查未校验 VDS Web hashed assets

- 位置：`scripts/check-server-docker-context.js:5`、`server/public/vds_web/index.html:7`
- 问题：Docker context 检查只校验 `server/public/vds_web/index.html` 存在，没有校验 index 中引用的 hashed JS/CSS assets 是否存在且非空。
- 影响：standalone Docker context gate 可能在 Web viewer 构建产物缺失或 stale 时仍通过，镜像内 `/vds_web/` 打开后资源 404。
- 建议：解析 VDS Web index 的本地 `src/href` 引用并校验对应文件存在且非空。
- 修改意见：按建议修改
- 处理结果：已处理。`check-server-docker-context.js` 现在解析 `server/public/vds_web/index.html` 中的本地 `src/href`，校验每个 `/vds_web/...` asset 存在且非空；已通过 `npm run check:server-docker`、`node --check scripts\check-server-docker-context.js`。

### FINAL-REVIEW-P2-002 日志门禁对 VDS Web wrapper 允许范围过宽

- 位置：`scripts/check-logging-policy.ps1:60`、`vds_web/src/main.ts:1244`
- 问题：前一轮用 `Select-String -Context 30,30` 判断 `console.info` 附近是否包含 `function logVdsWebInfo`，邻近裸 `console.info` 也可能被误放行。
- 影响：未来在 wrapper 附近新增裸 `console.info` 时，日志门禁可能漏报。
- 建议：把允许规则收窄为精确匹配 `logVdsWebInfo()` 函数体内的 `console.info(message);`。
- 修改意见：按建议修改
- 处理结果：已处理。日志门禁为每个匹配注入当前行号，并将 VDS Web 允许规则收窄到紧跟 `function logVdsWebInfo(message: string): void {` 的 `console.info(message);` 行；已通过 `npm run check:logging`。

### RUNTIME-FIX-P1-001 首个 native viewer 等不到上游 offer 后卡死

- 位置：`server/public/app-native-overrides.js:4056`、`server/server-core.js:472`
- 问题：首个观众加入后服务端会立即向 host 发送 `viewer-joined` 并把该 viewer 的 `connectRequestPending` 置为 true；viewer 端只在收到 host 的 `offer` 后才创建 upstream peer。运行日志显示 viewer 能收到 host 的 `ice-candidate`，但没有收到 `offer`；根因是 `createAndSendPeerOffer()` 里使用了清理过程中丢失定义的 `encodedDataChannelRequested` 变量，host 创建 peer 后在发送 offer 前抛 `ReferenceError`。
- 影响：首个观众可能已获得 `upstreamPeerId/hostId/mediaManifest`，但本地没有 peer，画面无法开始，除非用户离房重进或重启连接。
- 建议：恢复 `encodedDataChannelRequested` 的局部定义，确保 host 能正常发送 offer；同时保留 viewer 加入/恢复后的上游 offer watchdog，若短时间内仍未收到 offer 且没有 peer，则发送 `viewer-reconnect-ready`，复用既有服务端重连路径清理 pending 并重新通知上游。
- 修改意见：按建议修改
- 处理结果：已处理。`createAndSendPeerOffer()` 重新以 `pc.encodedMediaDataChannel === true` 定义 `encodedDataChannelRequested`，host 创建 native peer 后可继续等待/发送 offer；native viewer 也在 `room-joined/session-resumed` 后启动 2.5 秒 upstream offer watchdog，收到 `offer`、切换上游、host 断开等路径会取消 watchdog；超时且仍无 peer 时发送 `viewer-reconnect-ready` 触发服务端重发连接请求。已通过 `node --check server\public\app-native-overrides.js`、`node --check server\server-core.js`、`node --check server\index.js`、`npm run test:server`、`npm run check:logging`。

### RUNTIME-FIX-P1-002 native peer disconnected 后只更新 UI 不重连

- 位置：`server/public/app-native-overrides.js:2561`、`server/public/app-native-overrides.js:3694`
- 问题：host/viewer 已完成 offer/answer 并收集 host/prflx 候选后，native peer 进入 `disconnected`，但 renderer 只把 P2P UI 状态改成 `restart-attempting`，没有实际发起新的 offer 或 `viewer-reconnect-ready`。
- 影响：诊断显示两端 `signalingState: stable`、candidate 已存在，但 `connectionState/iceConnectionState: disconnected`、encoded datachannel closed，画面无法开始且不会自恢复。
- 建议：在 native peer `disconnected` 状态下启动恢复定时器；host-downstream 由 host 强制重建 offer，viewer-upstream 关闭旧 peer 并通过 `viewer-reconnect-ready` 请求上游重建。
- 修改意见：按建议修改
- 处理结果：已处理。新增 `scheduleDisconnectedPeerRecovery()`，复用 `P2P_RECONNECT_DELAYS_MS` 控制延迟和重试状态；host-downstream 调用 `createOffer(peerId, { force: true, reconnect: true })`，viewer-upstream 关闭旧 peer 后发送 `viewer-reconnect-ready`。已通过 `node --check server\public\app-native-overrides.js`、`npm run check:logging`。

### RUNTIME-FIX-P1-003 native peer 重连竞态导致 attachPeerMediaSource 命中 PEER_NOT_FOUND

- 位置：`server/public/app-native-overrides.js:2412`、`server/public/app-native-overrides.js:2420`、`server/public/app-native-overrides.js:2837`
- 问题：断线恢复或 failfast close 可能在旧的 `createAndSendPeerOffer()` / `attachNativePeerMediaSources()` 异步流程尚未结束时关闭 media-agent peer。renderer 仍持有旧 handle 并继续调用 `attachPeerMediaSource`，media-agent 返回 `PEER_NOT_FOUND: Peer has not been created`。
- 影响：Electron IPC handler 输出未处理错误，host 端 offer 创建流程中断，双端 native 重连进一步失败。
- 建议：close 开始时立即标记 handle closed；所有等待 `createPeer` ready 后继续操作前，确认 handle 仍是当前 active handle；对 stale/PEER_NOT_FOUND 旧异步结果做可恢复忽略。
- 修改意见：按建议修改
- 处理结果：已处理。`closeNativePeerConnectionImpl()` 开始即设置 `handle.closed = true`；`ensureNativePeerConnectionReady()` 和 `attachNativePeerMediaSources()` 在 await 前后校验 active handle，不再让旧异步流继续 attach；`viewer-joined`/`offer` 入口对 `native-peer-stale` 和 `PEER_NOT_FOUND` 做可恢复忽略。补充 smoke 后发现 close 清理阶段的 `detachPeerMediaSource` 也可能命中已删除 peer，`desktop/main.js` 已将该路径的 `PEER_NOT_FOUND` 降级为幂等返回，避免 Electron IPC handler 把已完成清理打印成未处理异常。已通过 `node --check server\public\app-native-overrides.js`、`node --check desktop\main.js`、`npm run check:logging`、`npm run test:server`、`scripts\smoke-media-agent.ps1`。

### RUNTIME-FIX-P1-004 native 首连阶段 disconnected 被误判为需要重连

- 位置：`server/public/app-native-overrides.js:71`、`server/public/app-native-overrides.js:1891`、`server/public/app-native-overrides.js:2545`、`server/public/app-native-overrides.js:2640`
- 问题：上一轮为了让已断开的 native peer 自恢复，在收到 `disconnected` 后直接按 `P2P_RECONNECT_DELAYS_MS` 触发恢复；但 ICE/native transport 初始建链期间也可能短暂进入 `disconnected`，此时尚未经过既有 15 秒 connect failfast 和 NAT fallback 判定，过早重连会制造多轮重复 offer/reconnect。viewer 等 upstream offer 的 watchdog 也只有 2.5 秒，host 创建 peer/offer 稍慢时可能重复发送 `viewer-reconnect-ready`。
- 影响：双端 native 首次连接可能经过数次自动重连后才连上；日志上表现为并非真实断线，却提前进入 `restart-attempting` / `viewer-reconnect-ready` 路径。
- 建议：初始建链失败仍交给 `P2P_CONNECT_FAILFAST_MS` 和 NAT fallback；`disconnected` 快速恢复只允许在 `meta.hasConnected === true` 后执行，并增加短暂 grace；viewer upstream offer watchdog 延长并限制同一上游只催一次。
- 修改意见：按建议修改
- 处理结果：已处理。`scheduleDisconnectedPeerRecovery()` 现在要求 peer 曾经成功 connected，首连阶段的 `disconnected` 只保持 checking，不再抢跑重连；已连接后断开先等待 4 秒 grace，再进入既有重连延迟序列。`VIEWER_UPSTREAM_OFFER_WAIT_TIMEOUT_MS` 从 2.5 秒放宽到 6 秒，并记录同一 upstream peer 已发送过 `viewer-reconnect-ready`，收到 offer、切换上游或清理房间时重置。

### RUNTIME-FIX-P1-005 native encoded DataChannel 双端同时主动创建导致连上即断

- 位置：`media-agent/src/peer_transport.cpp:490`、`media-agent/src/peer_transport.cpp:1705`
- 问题：renderer 双端 native 创建 peer 时都传 `encodedMediaDataChannel: true`；native agent 构造 `PeerTransportSession` 时用 `initiator || encoded_media_data_channel_requested` 判断是否主动创建 DataChannel，导致 answerer 也主动创建 `vds-media-encoded-v1`，同时还会通过 `onDataChannel` 接收 offerer 创建的通道。日志表现为每轮 `created -> answer -> connecting -> connected -> disconnected -> closed`，encoded DataChannel 处于 `requested/closed`，连接刚成功即进入重连。
- 影响：双端 native 连接可以短暂 connected，但 DataChannel 冲突/关闭被 native agent 上报成 `disconnected`，renderer 误以为 ICE 断线并反复重连，视频帧始终不发送。
- 建议：只有 offerer/initiator 主动创建 encoded DataChannel；answerer 只通过 `onDataChannel` 接受远端通道。DataChannel 自身关闭不应伪装成 peer `disconnected`，避免触发 ICE 重连路径。
- 修改意见：按建议修改
- 处理结果：已处理。`PeerTransportSession::initialize()` 改为 `initiator && encoded_media_data_channel_requested` 时才主动 `createDataChannel()`；answerer 保留 `onDataChannel` 接收路径。DataChannel `onClosed` 现在上报 `datachannel-closed`，不再向 renderer 冒充 peer `disconnected`。

### RUNTIME-FIX-P1-006 relay 下游创建 offer 时 isInitiator 传反

- 位置：`server/public/app-native-overrides.js:3875`
- 问题：`createOfferToNextViewer()` 是 viewer 作为上游给下一个 viewer 创建 offer 的路径，但调用 `createPeerConnection(nextViewerId, false, 'relay-viewer', ...)`，把 offerer 标成了 non-initiator。native agent 中 `initiator` 控制主动 `createDataChannel()` 和创建后 `setLocalDescription()`；在 encoded DataChannel 收紧为仅 initiator 主动创建后，该路径会导致 relay-downstream 不主动创建 DataChannel。
- 影响：首个 viewer 不受影响，但多级 native relay 中 viewer -> next viewer 的 offer/DataChannel 建立可能失败或依赖偶然的 attach 协商。
- 建议：`createOfferToNextViewer()` 的本端是 offerer，应传 `isInitiator=true`。
- 修改意见：按建议修改
- 处理结果：已处理。`createOfferToNextViewer()` 已改为 `createPeerConnection(nextViewerId, true, 'relay-viewer', ...)`，与 host -> viewer 的 offerer 语义保持一致。

### RUNTIME-FIX-P1-007 阶段 1：native peer 信令缺少 attemptId 隔离

- 位置：`server/public/app-native-overrides.js:1061`、`server/public/app-native-overrides.js:2431`、`server/public/app-native-overrides.js:2946`、`server/public/app-native-overrides.js:4033`
- 问题：native peer 重建时，旧 offer/answer/candidate/timer 与新 peer 仍按同一个 peerId 流转；虽然已有 stale handle 校验，但信令层没有连接尝试编号，旧 answer 或旧 candidate 仍可能在新 peer 创建后被误应用。
- 影响：断线恢复、viewer-reconnect-ready 或 DataChannel 重建时，旧异步事件可能污染当前连接尝试，表现为重复重连、candidate 串扰或 stable 状态下媒体不启动。
- 建议：按三阶段方案先落地阶段 1：给每条 native peer 连接尝试增加 `attemptId`；offerer 创建 edge attempt，answer/candidate 透传同一个 edge attempt；收到已知 attempt 且不匹配当前 edge 的信令直接丢弃。
- 修改意见：按建议修改
- 处理结果：已处理。新增 `nativePeerAttemptSeq`、`attemptId/edgeAttemptId` 和 attempt 校验 helper；native peer 创建时分配本地 attempt，offer/answer/candidate 透传当前 edge attempt；`handleAnswer()` / `handleIceCandidate()` 会丢弃 stale attempt，`handleOffer()` 会拒绝旧 offer attempt 并在新 offer 到达时更新 edge attempt；disconnected recovery timer 也校验原 handle attempt，避免旧 timer 重建新 peer。

### RUNTIME-FIX-P1-008 阶段 2：native peer 恢复动作分散在 timer 内

- 位置：`server/public/app-native-overrides.js:2554`、`server/public/app-native-overrides.js:2603`
- 问题：`scheduleDisconnectedPeerRecovery()` 的 timer 内直接按 role 执行 `createOffer()` 或 `viewer-reconnect-ready`，后续如果继续增加 DataChannel ready timeout、首帧 timeout、协议错误恢复，会形成多个入口各自 close/create，难以保证 attempt 校验和日志一致。
- 影响：恢复原因分散会增加重复重连、旧 timer 误触发和诊断不可读风险。
- 建议：阶段 2 先增加统一恢复入口 `requestPeerRecovery(peerId, reason, options)`；现有 disconnected recovery 只提交 reason 和 attempt，由统一入口决定 host-downstream / viewer-upstream 的恢复动作。
- 修改意见：按建议修改
- 处理结果：已处理。新增 `requestPeerRecovery()`，统一校验 peer/attempt、记录 `peer:recovery-requested`，并按 role 执行 host 强制重建 offer或 viewer 发送 `viewer-reconnect-ready`；`scheduleDisconnectedPeerRecovery()` 已改为调用该入口。

### RUNTIME-FIX-P1-009 阶段 3：PeerEdgeState 统一读模型先行落地

- 位置：`server/public/app-native-overrides.js:2554`
- 问题：`peerConnections`、`nativePeerHandles`、`peerConnectionMeta` 仍是分散 Map；直接一次性合并成完整状态机风险较高，容易影响现有首连和 relay 路径。
- 影响：继续在各处分别读取 handle/meta 会让后续 DataChannel timeout、首帧 timeout 和恢复策略重复实现 attempt/role/state 判断。
- 建议：阶段 3 先增加只读 `getPeerEdgeState(peerId)`，把 handle/meta/attempt/role/connection/restart 状态汇总为一个 edge 快照；先让统一恢复入口使用它，后续再逐步迁移其他路径。
- 修改意见：按建议修改
- 处理结果：已处理。新增 `getPeerEdgeState()`，`requestPeerRecovery()` 已改为读取该统一 edge 快照，不改变现有运行行为，为后续完整 PeerEdgeState 状态机迁移建立稳定边界。

### RUNTIME-FIX-P2-003 诊断控制面板默认信息密度低且健康状态刷屏

- 位置：`server/public/app-native-overrides.js:949`、`server/public/app-native-overrides.js:2061`、`desktop/main.js:680`
- 问题：P2P 诊断面板对健康 peer 也展开几十行字段，控制台在开启 nativeEvents/mainProcess 时还会持续打印 `audio-data` 与 `updateSurface request/result`，正常直播时有效信息被低价值重复字段淹没。
- 影响：功能正常时难以快速判断链路是否健康；异常发生时关键信号（ICE/DataChannel/媒体帧/attempt）不够突出，日志也容易因高频对象刷屏影响排查。
- 建议：顶边栏调试控制应能精确决定输出内容；`nativeEvents/mainProcess` 只输出低频摘要，高频对象单独放到 `highFrequency` 通道，只有顶栏勾选或短时全量 preset 才输出。诊断面板默认摘要优先，健康 peer 一行显示 role/kind、ICE/DataChannel、候选对、RTT、视频收发解码、音频收发、drop 和 attempt；异常 peer 或打开周期统计时再展开完整字段。
- 修改意见：按建议修改
- 处理结果：已处理。顶边栏新增 `高频明细` 输出通道，`短时全量` preset 默认打开，`排障/视频追踪` 默认关闭；`audio-data`、surface 高频事件和 `getStats/updateSurface` invoke 日志只在 `highFrequency` 通道开启时输出。`buildP2pDiagnosticReport()` 已改为健康 peer 单行摘要、异常/periodicStats/verbose 才展开详情。

### RUNTIME-FIX-P1-010 native relay 仍按传统 video receiver 判断上游 ready

- 位置：`media-agent/src/peer_media_binding_runtime.cpp:560`
- 问题：v2 连接 v1 时，v1 收到 `connect-to-next` 后 `attachPeerMediaSource(peer-video:<host>)` 返回 `relay-upstream-not-ready`。当前 native 主链路已经使用 encoded DataChannel，首个 viewer 的上游可能没有传统 `video_receiver_configured`，但 `encodedMediaDataChannelReady`、`encodedMediaDataChannelFramesReceived`、`decodedFramesRendered` 已经证明上游媒体可转发。
- 影响：第一个 viewer 已正常播放 host 画面，但无法作为上游给第二个 viewer 创建 relay offer；第二个 viewer 只能收到 ICE candidate，卡在等待上游连接且 `peers: none`。
- 建议：relay 上游 ready 判定兼容 encoded DataChannel：传统 video receiver configured 或 encoded DataChannel ready/已收到帧/已解码帧均可认为上游 ready；音频 relay 判定也应允许 DataChannel 上游。
- 修改意见：按建议修改
- 处理结果：已处理。`attach_relay_video_media_binding()` 新增 encoded DataChannel 上游 ready 判定，允许 `encoded_media_data_channel_ready`、已收到 encoded/remote video frame 或已解码帧作为 relay 上游就绪条件；音频转发也允许 encoded DataChannel 上游。

### RUNTIME-FIX-P1-011 viewer 异常断开 grace 过长导致链位短时陈旧

- 位置：`server/server-core.js:70`、`server/server-core.js:668`
- 问题：host 和 viewer 共用 `DISCONNECT_GRACE_MS=30000`。v1 强关客户端时服务端会保留 viewer 节点 30 秒等待恢复，v2 即使很快切到 host 或收到后续重连信令，初始 `room-joined/session-resumed` 仍可能拿到旧 `chainPosition=1`，UI 显示链中位置 2，直到 grace 到期 `finalizeViewerDisconnect()` 才重排为位置 1。
- 影响：链路实际可直连 host，但诊断/界面短时间显示旧链位，误导用户认为仍在 v1 后面。
- 建议：host 保持较长断线 grace 以保护房间；viewer 作为链中转发节点应使用独立较短 grace，默认 3 秒，并允许环境变量覆盖。
- 修改意见：按建议修改
- 处理结果：已处理。新增 `viewerDisconnectGraceMs`，默认 `min(DISCONNECT_GRACE_MS, 3000)`，可通过 `VIEWER_DISCONNECT_GRACE_MS` 覆盖；viewer WebSocket 异常断开使用该较短 grace，host 仍使用原 `disconnectGraceMs`。`/api/config` 与 `/api/version` 也返回该值便于诊断。

### RUNTIME-FIX-P1-012 host 异常断开 grace 过长导致 viewer 画面 freeze

- 位置：`server/server-core.js:72`、`server/server-core.js:668`
- 问题：host 强关客户端不会发送 `leave-room`，服务端原来按 `DISCONNECT_GRACE_MS=30000` 等待 host 恢复；viewer 在这段时间没有收到 `host-disconnected`，只能停留在最后一帧 freeze，过一会儿才显示房间断开。
- 影响：host 已经退出但 viewer UI 延迟感知，用户误以为视频卡死或 P2P 停住。
- 建议：host 异常断开也使用独立较短 grace，默认 3 秒；如果部署需要更长 host 恢复窗口，再通过环境变量单独配置。
- 修改意见：按建议修改
- 处理结果：已处理。新增 `hostDisconnectGraceMs`，默认 `min(DISCONNECT_GRACE_MS, 3000)`，可通过 `HOST_DISCONNECT_GRACE_MS` 覆盖；host WebSocket 异常断开使用该较短 grace 后广播 `host-disconnected` 并销毁房间。`/api/config` 与 `/api/version` 同步返回该值便于诊断。

### WEB-AUDIT-P1-001 web 端信令未跟随 native attemptId 隔离

- 位置：`vds_web/src/main.ts:327`、`vds_web/src/main.ts:363`、`vds_web/src/main.ts:383`、`vds_web/src/main.ts:419`、`vds_web/src/main.ts:524`
- 问题：web 端符合“只能观看和向后传递”的产品边界，代码中只有 `join-room`、`viewer-ready`、`connect-to-next`、`viewer-reconnect-ready` 等 viewer/relay 路径，没有 `create-room`、屏幕采集或 host manifest 发布路径。但 native 侧已经引入 `attemptId/edgeAttemptId` 后，web 的 answer/candidate/relay offer 仍不携带 attempt，重连或链路切换时只能依赖 peerId，旧 answer/candidate 有机会污染当前连接尝试。
- 影响：基础 web 观看和 relay 可用，但在 host/viewer 强关、链路重排或连续 `connect-to-next` 场景下，web-to-native / web-to-web relay 的抗陈旧信令能力低于 native。
- 建议：web 端加入轻量 edge attempt 状态：收到上游 offer 时记录并回传 attempt；创建下游 offer 时分配 attempt；本端 ICE candidate 透传当前 edge attempt；收到 answer/candidate 时丢弃与当前 edge 不匹配的陈旧信令，同时保持缺省 attempt 的向后兼容。
- 修改意见：按建议修改
- 处理结果：已处理。`vds_web/src/main.ts` 新增 `upstreamEdgeAttemptId/downstreamEdgeAttemptId` 和 `getSignalAttemptId()`；上游 answer、下游 offer、本端 ICE candidate 会携带当前 attempt；下游 answer 和双向 candidate 会忽略不匹配 attempt，上游 offer 会拒绝低于当前 edge 的旧 attempt。已通过 `npm run check:vds-web`、`npm run test:vds-web`、`npm run build:vds-web`。

### WEB-AUDIT-P2-002 web/native DataChannel 音频 payloadFormat 语义不一致

- 位置：`media-agent/src/peer_transport.cpp:988`、`media-agent/src/peer_transport.h:89`、`media-agent/src/media_audio.cpp:268`、`media-agent/src/relay_dispatch.cpp:736`、`vds_web/src/datachannel-protocol.ts:44`
- 问题：web/native 的 encoded DataChannel 二进制封包格式、protocol、label、version、chunk size 基本一致；但 native 发送 DataChannel 帧头时 `payloadFormat` 固定写为 `annexb`，导致音频帧头与 manifest 中的 `opus-raw` / `aac-adts` 不一致。当前 web 音频解码按 `codec` 分支，不依赖 `payloadFormat`，所以不是现有播放阻断问题。
- 影响：诊断字段会误导排查；如果后续 web 或 native 接收侧按 manifest 严格校验 payload format，音频 relay 可能被误判为格式不匹配。
- 建议：native DataChannel 帧模型增加 payload format 字段，视频发送明确 `annexb`，Opus 音频明确 `opus-raw`，AAC 音频明确 `aac-adts`；web TypeScript 协议类型同步允许这些音频 payload format。
- 修改意见：按建议修改
- 处理结果：已处理。`PeerEncodedMediaDataChannelFrame` 新增 `payload_format`，native DataChannel 编码优先使用该字段并保留默认推断；host audio、host video、relay video、relay audio 均显式填充 payload format；web 协议类型和 relay 类型同步放开 `opus-raw/aac-adts`。已通过 `npm run check:vds-web`、`npm run test:vds-web`、`npm run build:vds-web`、`VDS_FFMPEG_SOURCE=... npm run verify:media-agent`。

### WEB-AUDIT-P2-003 web relay 节点同时本地播放和向下游转发同一路音频

- 位置：`vds_web/src/main.ts:598`、`vds_web/src/main.ts:730`、`vds_web/src/main.ts:903`、`vds_web/src/webcodecs-audio-player.ts:114`
- 问题：web relay 不重新编码、不采集本地输出，协议层不存在“播放声被重新采集再发给下游”的回环路径。此前把测试环境中的双端外放听感误判为 relay 节点应默认静音，提出了 forward-only audio 策略。
- 影响：如果默认让 web relay 节点有下游时不本地播放音频，会直接破坏生产语义：v1 用户作为链中节点时仍然是观看用户，不能因为转发给 v2 就失去声音。
- 建议：撤回 forward-only audio 默认策略，保持 web viewer 始终本地播放收到的音频，同时继续原包向下游转发；同机测试双声应通过测试窗口手动静音、系统音量或后续测试模式开关处理，不应改变默认产品行为。
- 修改意见：撤回默认静音策略
- 处理结果：已撤回。已删除 `shouldPlayLocalAudio()` / `syncLocalAudioOutputPolicy()`、删除 `WebCodecsAudioPlayer.pauseOutput()` / `resumeOutput()`，音频帧恢复为始终调用 `dataChannelAudioPlayer.pushFrame()` 本地播放并继续向下游转发。

### RUNTIME-FIX-P1-013 P2P 链路失败后缺少上游重选与扇出约束

- 位置：`server/server-core.js:366`、`server/server-core.js:548`、`server/server-core.js:724`、`server/server-core.js:804`、`server/server-core.js:1324`
- 问题：服务端原来用 `chainPosition - 1` 推导 viewer 上游，链式上游不可达时只能反复请求同一个上游重连；信令授权也按数组前后关系放行，无法表达“v2 改挂 host / 其他 viewer”的拓扑。viewer 离开时只清理直接相邻后继，无法覆盖多个直接下游和重选后的父子关系。
- 影响：某段链路失败后，下游 viewer 可能卡在不可达上游；多下游或重选上游后旧授权/清理逻辑不准确，容易出现旧上游继续收到错误 `connect-to-next` 或信令被错误放行/拦截。
- 建议：服务端维护每个 viewer 的 `upstreamPeerId`，优先选择链式前序 viewer；如果该上游不可达或被本次 `viewer-reconnect-ready` 标记失败，则重新选择 host 或更早的 ready viewer；每个上游最多两个直接下游；清理时按真实父子关系重平衡，并只发送 `chain-reconnect`，等待 viewer 回 `viewer-reconnect-ready` 后再通知新上游建连接。
- 修改意见：按建议修改
- 处理结果：已处理。新增 `MAX_DOWNSTREAMS_PER_UPSTREAM` / `maxDownstreamsPerUpstream`，默认 2；viewer 对象保存 `upstreamPeerId`；新增 `selectViewerUpstream()`、`rebalanceViewerUpstreams()`、`notifyViewerCurrentUpstream()`、`isViewerDirectDownstream()` 等拓扑 helper；`forwardMessage()` 改为按当前父子关系授权；viewer 离开后按真实拓扑重平衡并等待客户端 ready 再建链。补充 `testViewerReconnectReselectsUpstreamWithFanoutLimit()` 覆盖链式优先、失败上游排除和 host 扇出上限。已通过 `node --check server/server-core.js`、`node --check scripts/test-server-core.js`、`npm run test:server`、`node --check server/public/app-native-overrides.js`、`npm run check:vds-web`、`npm run test:vds-web`、`npm run check:logging`。

### RUNTIME-FIX-P1-014 viewer-reconnect-ready 同时承担确认与失败排除语义

- 位置：`server/server-core.js:520`、`server/server-core.js:366`、`server/server-core.js:804`、`server/public/app-native-overrides.js:1956`、`server/public/app-native-overrides.js:2668`、`scripts/test-server-core.js:416`
- 问题：服务端一度把 `viewer-reconnect-ready.upstreamPeerId` 当作“失败上游”排除；但客户端在收到 `chain-reconnect` 后也会用同一个字段表示“我已准备连接的新上游”。这会把新上游错误排除，典型表现是 viewer 已确认切到 host，但服务端不再通知 host 建链，导致重连卡住或只能等待后续恢复。
- 影响：链路重排后的首轮重连可能被服务端自己阻断；在 fanout 限制场景下还可能静默得到空上游，使 native/web 端进入等待或错误 fallback。
- 建议：拆分协议语义：`upstreamPeerId` 只作为当前/目标上游上下文，失败排除使用独立 `failedUpstreamPeerId`；服务端如果找不到合法上游，必须返回明确错误并保留待重连状态，不能发送空上游。
- 修改意见：按建议修改
- 处理结果：已处理。服务端 `handleViewerReconnectReady()` 仅读取 `failedUpstreamPeerId` 作为排除项；native 的上游 offer 超时和断线恢复上报补充 `failedUpstreamPeerId`；join/reconnect 若无法选出合法上游会返回 `upstream-capacity-unavailable`，不会把空 `upstreamPeerId` 发给客户端；`notifyReconnectTargets()` 在无合法上游时保留 `needsChainReconnect`，后续拓扑变化可继续重试。新增 `testViewerReconnectReportsUnavailableWhenFanoutIsFull()` 覆盖所有合法上游满载时不绕过 fanout、不通知旧上游。已通过 `node --check server/server-core.js`、`node --check scripts/test-server-core.js`、`node --check server/public/app-native-overrides.js`、`npm run test:server`、`npm run check:logging`、`npm run check:vds-web`、`npm run test:vds-web`、`npm run build:vds-web`。

### RUNTIME-FIX-P1-015 web relay 单下游实现未反馈给服务端拓扑选择

- 位置：`vds_web/src/main.ts:40`、`vds_web/src/main.ts:224`、`server/server-core.js:945`、`server/server-core.js:1299`、`server/server-core.js:1349`
- 问题：native 端按 peerId 管理多条 `host-downstream/relay-downstream`，一个节点带两个下游不会天然串线；但 web 端目前只有单例 `downstreamPc/downstreamPeerId/downstreamDataChannel`，收到第二个 `connect-to-next` 会关闭并覆盖第一条下游连接。服务端全局默认每个上游最多 2 个下游，如果不识别 web 单下游能力，可能把两个直接下游分配给 web relay。
- 影响：web relay 被安排第二个直接下游时，第一个下游可能被本地关闭或丢失转发；现象会像信令串线/下游掉线，但根因是拓扑分配超过 web 客户端实现能力。
- 建议：把直接下游承载能力纳入 `mediaCapabilities`，服务端选择上游时使用 `min(全局上限, 节点声明上限)`；web 明确声明 `maxDirectDownstreams: 1`，native 未声明时继续使用服务端默认 2。
- 修改意见：按建议修改
- 处理结果：已处理。`sanitizeMediaCapabilities()` 保留 `maxDirectDownstreams`；新增 `getUpstreamDirectDownstreamLimit()`，`selectViewerUpstream()` 与 `rebalanceViewerUpstreams()` 按节点能力限制直接下游数；web join-room 能力声明新增 `maxDirectDownstreams: 1`。补充 `testViewerCapabilityLimitsDirectDownstreams()` 覆盖 web-like 节点已有一个下游后，服务器不会再把第二个 fallback 下游分给它，而会选择其他可用上游。已通过 `node --check server/server-core.js`、`node --check scripts/test-server-core.js`、`node --check server/public/app-native-overrides.js`、`npm run test:server`、`npm run check:logging`、`npm run check:vds-web`、`npm run test:vds-web`、`npm run build:vds-web`。

### RUNTIME-FIX-P2-004 信令服务器缺少实时拓扑/manifest 观察后台

- 位置：`server/server-core.js:80`、`server/server-core.js:826`、`server/index.js:5`、`server/public/admin.html:1`
- 问题：排查 P2P 链路时只能依赖各客户端诊断文本和控制台日志，无法从服务端全局视角实时确认房间列表、真实 `upstreamPeerId` 拓扑、节点 ready/pending 状态、直接下游计数和当前 media manifest。
- 影响：多 viewer、链路重排、web/native 混合 relay 场景下，难以快速判断问题发生在服务端拓扑分配、信令转发、客户端建链还是 manifest 兼容。
- 建议：给信令服务器增加只读后台，独立端口展示实时房间、拓扑边、节点状态、manifest 与容量限制；后台不暴露 session token，不参与业务信令。
- 修改意见：按建议修改，后台端口固定 3010
- 处理结果：已处理。`startServer()` 新增可选 `adminPort`，生产入口 `server/index.js` 传入 `ADMIN_PORT || 3010`；新增独立 admin HTTP 服务，`/api/rooms` 返回 `buildAdminSnapshot()`，包含 activeConnections、limits、rooms、nodes、edges、mediaManifest；新增 `server/public/admin.html`，每秒轮询并展示房间摘要、实时拓扑、节点 online/media/relay/pending 状态、直接下游计数和 manifest JSON。已通过 `node --check server/server-core.js`、`node --check server/index.js`、`node --check scripts/test-server-core.js`、`npm run test:server`、`npm run check:logging`，并已启动验证 `http://127.0.0.1:3010/` 返回 200、`http://127.0.0.1:3010/api/rooms` 返回有效 JSON。

### RUNTIME-FIX-P1-016 WGC host 预览 attachSurface 触发 media-agent 崩溃后降级无预览

- 位置：`media-agent/src/surface_attachment_runtime.cpp:267`、`media-agent/src/native_live_preview.cpp:900`
- 问题：host powershell 日志先显示 `attachSurface embedded-host-preview -> host-capture-artifact` 时 layout 已是 `visible:true`，但 media-agent 在 `nativeLivePreview:source-create-begin target=window hwnd=...` 后以 `3221225477` 退出。改为 artifact 预览后，第二次日志显示 `Host capture artifact path is not available yet` 被作为 `SURFACE_ATTACH_FAILED` 返回，renderer 仍按 attach 失败重启为无预览开播。
- 影响：WGC 主采集已占用窗口捕获链路时，再为 host 预览创建第二路 `wgc-live-preview` 可能触发 native 崩溃；预览失败不应拖死整个 media-agent，也不应导致 host 永久无预览。
- 建议：WGC host 预览默认不要再创建第二路 live WGC source，改走 ffmpeg artifact preview 兜底；保留 `VDS_ENABLE_WGC_LIVE_PREVIEW=1` 作为显式调试开关，便于后续单独复查 live preview 崩溃。artifact path/decodable payload 未 ready 是正常启动过渡态，attachSurface 应返回成功并登记 surface，等待后续 artifact ready 自动启动预览，不能作为致命 attach 失败。
- 修改意见：按建议修改
- 处理结果：已处理。`surface_attachment_runtime.cpp` 新增 `is_wgc_live_preview_enabled()`；WGC host surface 默认使用 `ffmpeg-native-artifact-preview`，只有显式设置 `VDS_ENABLE_WGC_LIVE_PREVIEW=1` 才走 `wgc-live-preview`。`surface_control_runtime.cpp` 对 host capture surface 的 `waiting_for_artifact` 状态改为 attach 成功并写入 `attached_surfaces`，不再返回 `SURFACE_ATTACH_FAILED`；后续 `refresh_host_capture_runtime()` 已有 artifact ready 自动启动预览逻辑。已使用 `VDS_FFMPEG_SOURCE=D:\project\publicresource\ffmpeg-master-latest-win64-gpl-shared` 完成 `npm run verify:media-agent`，Release 构建、单元测试、smoke test 均通过，并已复制新 `runtime/media-agent/vds-media-agent.exe`；同时通过 `node --check server/public/app-native-overrides.js`、`node --check desktop/main.js`。

### RUNTIME-FIX-P2-001 native host 默认预览导致本机采集测试卡顿

### RUNTIME-FIX-P1-018 viewer 移动窗口导致 native surface 播放卡住

- 位置：`server/public/app-native-overrides.js:1240`、`server/public/app-native-overrides.js:1547`、`desktop/main.js:423`
- 问题：viewer 观看时移动 Electron 窗口，主进程会连续发送 `window-bounds-changed`。renderer 原来对每次 bounds 变化调用 `forceEmbeddedSurfaceResyncBurst()`，一次事件会安排多轮强制 layout sync；拖动窗口时事件频率很高，会形成 `updateSurface` 风暴。同时 embedded surface 的 `__syncKey` 只记录 DOM 相对坐标，不记录最终 screen x/y，窗口移动但 DOM rect 不变时容易依赖强制 invalidate，状态竞争下 surface 可能短时间停在旧位置或卡住。
- 影响：P2P/DataChannel 仍可能正常，但原生 viewer surface 跟随窗口移动时被高频 update 或旧坐标拖住，用户看到画面 freeze；日志中能看到窗口焦点/层级同步与 surface/peer detach/close/recreate 交织。
- 建议：窗口 bounds 变化单独走轻量 coalesced surface sync：每帧最多一次 update，拖动结束后补一次 final sync；layout key 纳入最终 screen 坐标，窗口移动即使 DOM rect 不变也能自然触发 update。
- 修改意见：按建议修改
- 处理结果：已处理。`buildSurfaceLayout()` 的 `__syncKey` 已加入最终 `x/y`；新增 `scheduleWindowBoundsSurfaceSync()`，对窗口移动事件合并为 requestAnimationFrame + 120ms final sync，替换原来每个 `window-bounds-changed` 都触发完整 resync burst 的路径，减少拖动窗口时的 `updateSurface` 风暴并保证最终 screen 坐标推送到 media-agent。已通过 `node --check server/public/app-native-overrides.js`。


### RUNTIME-FIX-P2-006 3010 后台拓扑只显示列表不够直观

- 位置：`server/public/admin.html:1`
- 问题：信令后台已有实时 nodes/edges/manifest 数据，但页面主要用节点列表和边文本展示拓扑，多 viewer、链路重排或 pending/reconnect 状态下不够直观。
- 影响：排查上游选择、fanout 限制、链式 relay 和重连 pending 时，需要人工把列表关系拼成图，效率低。
- 建议：在 3010 后台加入图形拓扑画布，按 host/viewer 层级自动布局节点，用连线颜色/虚线表达 ready、pending、waiting，同时保留节点摘要和 manifest JSON。
- 修改意见：按建议修改
- 处理结果：已处理。`admin.html` 已改为 SVG 连线 + 绝对定位节点的实时拓扑图：host/viewer 分层展示，上游下游容量、online/offline、media/relay/pending/reconnect 状态直接显示在节点上，边按 ready/pending/waiting 着色；右侧保留节点摘要和实时 manifest。已通过 `node --check server/server-core.js` 和内联脚本 `new Function()` 语法校验。


### RUNTIME-FIX-P1-017 host 停止共享后同一 socket 无法再次创建房间

- 位置：`server/server-core.js:772`、`server/public/app-native-overrides.js:3857`、`scripts/test-server-core.js:638`
- 问题：产品语义要求 host 停止共享时删除房间，再次共享时创建全新房间。但服务端 `destroyRoom()` 删除房间时只把 `room.host.ws` 置空，没有清除 WebSocket 对象自身的 `ws.roomId/ws.role/ws.clientId`。同一 host socket 后续再发 `create-room` 会被 `handleCreateRoom()` 误判为 `socket-already-bound`。
- 影响：host 点击停止共享后 UI 清空了房间，再次点击共享虽然发送了新 `create-room`，但服务端拒绝，客户端无法收到 `room-created`，表现为“没有房间”。
- 建议：销毁房间时必须同步解绑所有参与 socket 的 metadata；保留重复 create-room 拒绝逻辑，但仅针对仍真实绑定有效房间的 socket。增加回归测试覆盖同一 host socket `create-room -> leave-room -> create-room`。
- 修改意见：按停止共享删除房间、再次共享创建新房间的语义修复
- 处理结果：已处理。`destroyRoom()` 现在会在清空 `room.host.ws` 和 viewer `ws` 前调用 `clearSocketMetadata()`，确保 host 主动 `leave-room` 删除房间后同一 WebSocket 可重新创建新房间；补充 `testHostCanCreateNewRoomAfterLeavingPreviousRoom()` 覆盖二次建房路径。已通过 `node --check server/server-core.js`、`node --check scripts/test-server-core.js`、`node --check server/public/app-native-overrides.js`、`npm run test:server`。


### RUNTIME-FIX-P1-016 补充更正：保留 WGC live preview 并收住 source 创建崩溃

- 位置：`media-agent/src/surface_attachment_runtime.cpp:53`、`media-agent/src/wgc_capture.cpp:731`、`desktop/main.js:726`
- 问题：前一版把 WGC host 预览默认降级到 `ffmpeg-native-artifact-preview`，但当前 WGC host session 默认没有启用 `VDS_ENABLE_AGENT_HOST_CAPTURE_PROCESS=1`，因此没有 `capture.ts` artifact path，实际会稳定进入 `surface-waiting-for-artifact-path` 黑屏。用户明确要求继续使用 `wgc-live-preview`，并收住 `nativeLivePreview:source-create-begin` 后 media-agent 崩溃。
- 影响：artifact 默认兜底会把崩溃问题变成稳定黑屏；同时无法定位 `wgc-live-preview` 真正失败边界。
- 建议：恢复 `wgc-live-preview` 默认路径，artifact 仅作为显式降级开关；公共 WGC source 创建入口应串行化并捕获 WinRT 创建异常，把 `CreateForWindow`、FramePool、Session、`StartCapture` 等失败转为可诊断错误，不能让 media-agent 普通异常退出。
- 修改意见：按用户补充意见修改
- 处理结果：已处理。`surface_attachment_runtime.cpp` 已恢复 WGC host surface 默认使用 `wgc-live-preview`；仅在 `VDS_DISABLE_WGC_LIVE_PREVIEW=1` 或 `VDS_ENABLE_WGC_LIVE_PREVIEW=0` 时显式降级到 artifact preview。`wgc_capture.cpp` 为 `create_wgc_frame_source()` 增加全局创建互斥，并捕获 `winrt::hresult_error`、`std::exception` 和未知异常，返回 `wgc-source-create-*` 错误；上一轮可确认崩溃位置是 WGC source 创建边界，若仍发生 `0xC0000005`，下一轮日志可进一步区分 HRESULT/异常与 WinRT/驱动层 SEH 访问冲突。已使用 `VDS_FFMPEG_SOURCE=D:\project\publicresource\ffmpeg-master-latest-win64-gpl-shared` 完成 `npm run verify:media-agent`，Release 构建、单元测试、smoke test 均通过，并已复制新 `runtime/media-agent/vds-media-agent.exe`。

### RUNTIME-FIX-P2-005 surface enrich 高频日志绕过顶栏高频开关

- 位置：`desktop/main.js:726`
- 问题：`getStats/updateSurface` invoke 日志已按 `highFrequency` 通道收敛，但 `enrichEmbeddedSurfaceOptions()` 自己仍在 `mainProcess` 通道打印每次 surface enrich input/output。host 预览布局同步会高频调用 `updateSurface`，导致控制台持续刷 `[media-engine surface] enrich ...`。
- 影响：顶边栏关闭高频明细后仍有大量重复 surface 日志，诊断信息密度低，也会增加主进程 JSON 序列化和控制台 IO。
- 建议：surface enrich input/output 与 non-embedded 细节归入 `highFrequency` 通道，普通 `mainProcess` 只保留低频 invoke/错误摘要。
- 修改意见：按建议修改
- 处理结果：已处理。`desktop/main.js` 将 `[media-engine surface] enrich input/output` 和 `non-embedded surface request` 从 `mainProcess` 通道移动到 `highFrequency` 通道；顶边栏未开启“高频明细”时不再输出这类重复布局日志。已通过 `node --check desktop/main.js`。


- 位置：`server/public/app.js:232`、`server/public/app-native-overrides.js:3435`
- 问题：运行反馈确认总审计前本地预览不卡，卡顿与预览默认开启没有直接因果关系；将默认预览关闭属于误判。
- 影响：若保留该改动，会改变既有开播体验且掩盖真实卡顿源。
- 建议：撤回默认关闭预览改动，继续定位实际性能回归。
- 修改意见：撤回该项修改
- 处理结果：已撤回。`qualitySettings.previewEnabled` 已恢复为 `true`；本项不再作为卡顿修复项。已继续定位到 `getStats` invoke 级完整日志输出导致的性能风险，见 `RUNTIME-FIX-P2-002`。

### RUNTIME-FIX-P2-002 getStats invoke 级完整日志导致本机交互卡顿

- 位置：`desktop/main.js:682`、`desktop/main.js:1697`、`server/public/app-native-overrides.js:3211`、`server/public/app-native-overrides.js:3333`
- 问题：native host/viewer stats polling 会周期性调用 `mediaEngine.getStats({})`；在 mainProcess/video 调试开启时，`invokeMediaEngine()` 会对每次 `getStats` 的完整结果执行 `JSON.stringify(summarizeMediaEnginePayload(result))` 并打印 `[media-agent invoke] getStats result`。该结果包含 surfaces、peers、debug 字符串等较大对象，运行日志中已观察到连续大 JSON 输出。
- 影响：双端本机采集时，主进程持续序列化和写控制台大对象，会占用 Electron 主进程/控制台 IO，放大 WGC/编码负载下的鼠标卡顿和 UI 延迟。
- 建议：`getStats` 不走普通 invoke 级完整日志；保留 renderer `periodicStats` 轻量摘要。只有显式设置 `VDS_VERBOSE_MEDIA_LOGS=1` 时才允许完整 invoke 日志。
- 修改意见：按建议修改
- 处理结果：已处理。`shouldLogMediaInvoke()` 对 `getStats` 增加非 verbose 跳过逻辑，普通 mainProcess 调试不再打印完整 `getStats request/result`；需要极限排查时仍可用 `VDS_VERBOSE_MEDIA_LOGS=1` 打开。已通过 `node --check desktop\main.js`、`npm run check:logging`。

### RUNTIME-FIX-P1-019 安装包无法枚举最小化窗口捕获目标

- 位置：`desktop/main.js:1405`
- 问题：开发环境下 `process.execPath` 是 `electron.exe`，最小化窗口元数据 helper 会设置 `ELECTRON_RUN_AS_NODE=1` 并正常执行 `desktop/window-metadata-helper.js`；安装包中 `process.execPath` 是 `VDS.exe`，旧判断未设置 `ELECTRON_RUN_AS_NODE`，导致子进程按应用入口启动而不是 Node helper，最终无法获得 minimized window metadata。
- 影响：开发环境调起客户端可以看到最小化窗口捕获目标，安装包安装后的客户端看不到，表现为 dev/prod 行为不一致。
- 建议：只要用 Electron 可执行文件启动 JS helper，就显式设置 `ELECTRON_RUN_AS_NODE=1`，不要依赖可执行文件名判断是否为 `electron.exe`。
- 修改意见：按建议修改
- 处理结果：已处理。`getTopLevelWindowMetadataMapFromHelper()` 现在对子进程 env 无条件设置 `ELECTRON_RUN_AS_NODE=1`，确保 packaged `VDS.exe` 也以 Node 模式执行 `window-metadata-helper.js`，恢复安装包枚举最小化窗口能力。

### RUNTIME-FIX-P2-007 观看画面出现约一秒一顿的周期性卡顿

- 位置：`server/public/app.js:246`、`server/public/app-native-overrides.js:452`、`media-agent/src/host_pipeline.cpp:236`
- 问题：默认关键帧策略是 `1s`，编码器每秒强制 IDR/GOP 边界，10Mbps/1080p 场景下 IDR 帧容易形成 DataChannel 与解码突发；同时 native host/viewer stats 每 2 秒轮询一次，双端同机或多客户端错峰时可能表现为约 1 秒一次的轻微抢占。
- 影响：媒体链路已连接且平均 FPS 正常，但用户看到“流畅一秒、咯噔一下”的周期性顿挫，尤其在高码率、同机双端、开启预览/诊断面板时更明显。
- 建议：默认关键帧间隔调到 `2s`，减少 IDR 突发密度；保留 `1s/0.5s/all-intra` 作为手动诊断或低延迟恢复选项。native stats 轮询从 2 秒放宽到 5 秒，避免诊断采样参与流畅度竞争。
- 修改意见：按建议修改
- 处理结果：已处理。默认 `qualitySettings.keyframePolicy`、media-agent `HostPipelineState/AgentRuntimeState` 默认值和 unknown policy fallback 均改为 `2s`；FFmpeg sender 对 `2s` 输出 `-g fps*2` 和 `force_key_frames expr:gte(t,n_forced*2)`；media manifest 的 `keyframeIntervalMs` 按当前策略输出 500/1000/2000；native host/viewer stats polling 改为 5000ms。已保留 UI 中 `1s`、`0.5s`、`All-Intra` 选项用于手动回退或诊断。

### RUNTIME-FIX-P1-020 打包版 media-agent 落后于开发运行时导致预览差异

- 位置：`package.json:31`、`package.json:33`、`scripts/release-check.js:1`
- 问题：开发环境运行 `runtime/media-agent/vds-media-agent.exe`，安装包运行 `dist/win-unpacked/resources/runtime/media-agent/vds-media-agent.exe`。现场比对发现两者 SHA256 不一致，说明安装包内 agent 是旧二进制；同时旧 `build:release` 在打包后执行 `release:check`，而 `release:check` 又会重新跑 `verify:media-agent`，存在“打包后 runtime 被重新生成，安装包未同步”的流程漏洞。
- 影响：开发版和打包版实际运行的 native preview/WGC 崩溃收敛代码不同，表现为打包版更容易无预览或行为和测试版不一致。
- 建议：发布流程拆成打包前检查和打包后校验。打包前允许 `build:vds-web`、`verify:media-agent` 生成运行时；打包后禁止再重建运行时，只校验 installer、server updates 和 packaged media-agent 哈希一致。
- 修改意见：按建议修改
- 处理结果：已处理。新增 `release:precheck` 和 `release:check --postbuild` 两阶段入口；`build:release` 改为 `release:precheck -> electron-builder -> prepare-server-release -> release:check -> release:github`。`release:check` 打包后不再执行 `verify:media-agent`，并新增 `validatePackagedMediaAgentRuntime()` 比对 `runtime/media-agent/vds-media-agent.exe` 与 `dist/win-unpacked/resources/runtime/media-agent/vds-media-agent.exe` 的 SHA256，不一致会直接失败并提示重新打包。已通过 `node --check scripts/release-check.js`。

### RUNTIME-FIX-P1-021 Web 端依赖 crypto.randomUUID 导致能力检测前崩溃

- 位置：`vds_web/src/main.ts:1235`、`server/server-core.js:138`
- 问题：Web viewer 初始化 clientId 时直接调用 `crypto.randomUUID()`。部分浏览器版本、非安全上下文或被代理/嵌入后的环境没有该函数，脚本在能力检测前抛出 `TypeError: crypto.randomUUID is not a function`，页面停在“P2P：能力检测中”。
- 影响：Web 端完全无法进入 capability detect、房间列表和加入流程；浏览器控制台只显示旧 bundle 的初始化异常。
- 建议：clientId 生成需要兼容 fallback：优先 `randomUUID`，其次 `getRandomValues` 手动生成 UUID v4，最后退到时间戳和 `Math.random` 的非安全唯一值。同时 Web 入口 HTML 不应缓存，避免浏览器继续加载旧 hashed bundle。
- 修改意见：按建议修改
- 处理结果：已处理。`getClientId()` 改为调用 `createClientUuid()`，兼容 `crypto.randomUUID` 缺失场景；`server-core` 对 `/`、`/vds_web`、`/vds_web/` 和 `/admin` 入口 HTML 设置 `Cache-Control: no-store`，避免入口页缓存导致继续引用旧 JS。已通过 `npm run check:vds-web`、`npm run test:vds-web`、`npm run build:vds-web`、`node --check server/server-core.js`、`npm run test:server`；构建后的 `server/public/vds_web/index.html` 已指向新 bundle `index-BBw8ihmu.js`，旧 `index-DZl3WkvK.js` 不在当前构建目录中。

### ROBUSTNESS-P1-001 Web viewer 重复加入可打穿加入状态机

- 位置：`vds_web/src/main.ts:149`、`vds_web/src/main.ts:202`、`vds_web/src/main.ts:1006`
- 问题：Web viewer 的加入入口没有 `viewerJoinPending` 等价锁。用户双击“加入”、恢复旧 session 时同时手动加入、加入中刷新大厅再点房间，可能在同一 socket 或同一 clientId 上发出多次 `join-room`，旧响应和新响应交错后会覆盖 `session/upstreamPeerId/diagnostics`。
- 影响：极端 UI 操作下 Web viewer 可能停在等待上游、重复建 peer、收到与当前房间不匹配的 offer/candidate，或者按钮状态与真实 room/session 不一致。
- 建议：Web viewer 加入流程应有单一 pending gate；pending 期间禁用直连输入、加入按钮、刷新大厅、模式切换和房间列表按钮；成功、错误、manifest 不兼容、主动离开时释放 gate。
- 修改意见：按建议修改
- 处理结果：已处理。`vds_web/src/main.ts` 新增 `joinPending` 和 `setJoinPending()`，`joinRoom()` 在 pending 或已入房时直接返回，发起 join 前锁定 UI；`handleJoined()`、server `error`、manifest failure、join catch 和 `leaveCurrentRoom()` 会释放 pending。大厅房间按钮渲染和已存在按钮同步纳入 pending 禁用逻辑。

### ROBUSTNESS-P1-002 Electron host 重复确认共享可并发启动 native session

- 位置：`server/public/app.js:2428`、`server/public/app.js:3315`、`server/public/app.js:3702`
- 问题：停止共享已有 `stopScreenShareInFlight`，但开始共享流程没有同级锁。用户可在质量弹窗、源选择弹窗中重复点击确认，或在 source/audio 异步发现阶段连续触发确认，导致多条 `startScreenShareWithSource/startHostSession/create-room` 并发执行。
- 影响：极端操作下可能创建多个 native host session、重复发 `create-room`、按钮状态和实际房间状态错位，后续停止共享只清理其中一条路径时留下预览/peer/manifest 残留。
- 建议：开始共享流程增加全局 pending gate，覆盖质量确认、OBS 启动、源选择确认、音频候选发现和 native start；pending 期间禁用确认/刷新/开始按钮，成功后由运行态按钮隐藏接管，失败/取消/停止时统一释放。
- 修改意见：按建议修改
- 处理结果：已处理。`server/public/app.js` 新增 `shareStartInFlight` 与 `resetShareStartPendingUi()`；`confirmQualitySelection()` 在进入 OBS/source 流程前加锁并禁用开始/确认按钮；`confirmSourceAndShare()` 禁用源确认和刷新按钮，失败时释放；`cancelSourceSelection()` 和 `stopScreenShare()` 统一释放 pending 状态，避免重复启动 native session 或 create-room。已通过 `node --check server/public/app.js`。
