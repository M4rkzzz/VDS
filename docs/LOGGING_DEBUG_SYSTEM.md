# 日志与调试系统整理

## 当前目标

日志系统的目标不是“尽量多打印”，而是在排障时快速定位问题，同时不影响音视频链路性能。

当前状态：已完成本轮日志与调试系统整理。核心高频链路已经接入分类、节流和包装器；双端/三端调试脚本已改为客户端实例口径；前端调试菜单已按“快速模式 / 问题范围 / 输出内容 / 深度诊断”重新整理；renderer、main process 和 server 可恢复错误已从默认裸日志降级或节流；`check:logging` 已精确限制裸日志出口。后续只需要按真实双端/三端场景继续微调采样间隔。

本轮整理原则：

- 默认运行必须接近静默。
- 高频日志必须节流或采样。
- 错误和 warning 保留，但重复 recoverable warning 要合并。
- 可恢复错误不能默认刷 `console.error`；若 UI 已经 toast/状态提示，应进入对应调试类别。
- per-frame、per-packet、per-surface-sync 日志不能无节制输出。
- 深挖问题时可以短时全量打开，但不能作为日常模式。
- 双端/三端调试只表示多个客户端实例，不预设 host/viewer/relay；用户打开软件前并不知道自己会创建房间还是加入房间，日志和脚本命名应使用 client A / client B / client C 这类中性身份。
- 前端调试 UI 必须明确显示当前预设或自定义状态，交互事件集中绑定，避免菜单渲染、状态同步和事件处理互相穿插。

## 当前调试开关

调试配置仍采用“类别 + 通道”组合：

类别：

- `connection`：WebSocket、信令、ICE、Peer 建连与重连
- `video`：采集源、Surface、视频链路与预览同步
- `audio`：音频会话、音量、播放与原生音频桥
- `update`：版本检查、下载、安装与更新日志
- `misc`：启动、能力探测、版本信息与其它诊断

通道：

- `renderer`：renderer 常规调试输出
- `nativeEvents`：media-agent 事件摘要
- `nativeSteps`：native 控制面步骤
- `periodicStats`：host/viewer/relay 周期统计
- `mainProcess`：主进程 IPC 与桥接日志
- `agentBreadcrumbs`：media-agent stderr breadcrumb
- `agentStderr`：media-agent 原始 stderr

## 采样与节流规则

当前已接入的节流：

- `nativeSteps`：按 `category + scope` 归并，默认同类每 1 秒最多输出一次。
- `nativeEvents`：按 `category + event + state` 归并，默认同类每 1 秒最多输出一次。
- `periodicStats`：host/viewer/relay 默认同类每 5 秒最多输出一次，初始采样不节流。
- `agentBreadcrumbs`：主进程按 breadcrumb 内容归并，默认同类每 1 秒最多输出一次。
- media-agent 原生 breadcrumb：agent 内部按 step 归并，默认同类每 1 秒最多写一次 stderr。
- server 连接/建房调试日志：默认静默，设置 `VDS_VERBOSE_SERVER_LOGS=1` 后输出。
- server WebSocket 消息解析错误默认 5 秒合并一次，避免异常客户端刷屏；`VDS_VERBOSE_SERVER_LOGS=1` 下不节流。
- viewer 音频偏好应用失败等可恢复路径只进入 `audio` 调试类别，不再常驻 warning。
- renderer 画质确认、返回时停止共享、WebSocket error、源列表加载/刷新、开始原生分享失败等可恢复路径只进入对应调试类别，不再常驻 `console.error`。
- main process 桌面源枚举、capture target 列表、音频桥能力探测/调用失败等有返回兜底的路径只进入对应调试类别，不再常驻 `console.error`。
- media-agent `warning` 事件只在事件处理路径输出并节流，不再由事件摘要路径重复输出。
- 被压缩的日志会在下一次输出时附带 `suppressed=<count>`。

`VDS_VERBOSE_MEDIA_LOGS=1` 会绕过这些节流，只适合短时间深挖问题。

## 推荐使用方式

日常默认：

- 使用 `quiet`。
- 出错时先看 UI 状态和必要 warning。

普通排障：

- 使用 `diagnose`。
- 默认不开 `periodicStats`、`agentBreadcrumbs`、`agentStderr`。

视频链路排障：

- 使用 `traceVideo`。
- 会打开 step、stats 和 breadcrumb，但仍受节流保护。

双端本地复现：

- 使用 `npm run dev:dual` 或 `npm run dev:dual:native`。
- 两个窗口分别是 `Client A` 和 `Client B`，启动时不区分主持端和观看端。
- 具体谁是 host、谁是 viewer，只由运行时 UI 操作和信令结果决定。

三端本地复现：

- 使用 `npm run dev:triple` 或 `npm run dev:triple:native`。
- 三个窗口分别是 `Client A`、`Client B` 和 `Client C`，启动时不区分主持端、观看端或中继端。
- 级联链路中的 host/viewer/relay 身份，只由运行时创建房间、加入顺序和信令结果决定。

调试状态一致性：

- `dev:dual*` 和 `dev:triple*` 脚本默认传入 `VDS_DEBUG_PRESET=quiet`，所有客户端启动时使用同一调试状态。
- 若需要沿用每个客户端 profile 上次保存的调试状态，可直接运行脚本并传入 `-DebugPreset profile`。
- 可选 preset：`quiet`、`diagnose`、`traceVideo`、`verbose`、`profile`。

短时间深挖：

- 使用 `verbose` 或环境变量 `VDS_VERBOSE_MEDIA_LOGS=1`。
- 只用于短时间复现，不要长时间跑。

## 后续约束

- 新增日志必须选择明确类别和通道。
- renderer 常规日志走 `debugLog`。
- native override 步骤日志走 `logNativeStep`。
- native override 统计日志走 `logNativeStatsLine`。
- native override warning 走 `logRecoverableNativeWarning` 或 `logNativeWarningLine`。
- main process 媒体日志走 `logMainProcessDebug` / `logMainProcessWarning`。
- 新增 `console.error` 必须先判断是否为致命/不可恢复错误；可恢复错误走调试类别和 UI 状态提示。
- 新增高频日志必须先设计采样或节流 key。
- 不允许在 frame loop、audio packet loop、surface sync loop 中直接 `console.log` 或 `std::cerr`。
- 若必须记录每帧数据，应进入内存 ring buffer 或 stats snapshot，而不是逐帧输出文本。
- 提交日志相关改动前运行 `npm run check:logging`，确认没有新增裸 `console.log` / `console.warn` / `console.error` / `std::cerr` / `std::cout`。

## 自动检查

`npm run check:logging` 会扫描以下高风险区域：

- `server/public`
- `server/server-core.js`
- `desktop`
- `media-agent/src`

检查脚本只允许已知包装器和必要协议输出：

- renderer：`debugLog`
- native override：`logNativeDebug`、`logNativeStep`、`logNativeStatsLine`、`logNativeWarningLine`
- main process：`logMainProcessDebug`、`logMainProcessWarning`
- media-agent stdout：`agent_events.cpp` 的 JSON line 协议输出
- media-agent stderr：`agent_diagnostics.cpp` 的节流 breadcrumb
- 少量致命或启动级 `console.error`：server 配置错误、server 解析错误包装器、native override 初始化失败、main process 更新/agent RPC/退出清理失败路径

如果确实需要新增一个日志出口，应先补充对应包装器和节流规则，再更新检查脚本白名单。
