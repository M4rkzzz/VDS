# VDS Media Refactor Plan

## 1. 目的

这份文档记录仓库在 `1.6.2` 时点的真实媒体架构、真实边界、真实验证结果、真实未解问题，以及接下来明确的执行方向。  
它同时承担三种职责：

- 真相文档：说明当前代码真实在做什么
- 计划文档：说明接下来优先级和验收目标
- 交接文档：让后来接手的人能快速理解当前系统、风险和约束

强制原则：

- 只写真实存在的实现
- 只写已经验证过的链路
- 未完成项必须明确写成风险或下一步
- 不允许用“以后可能”掩盖当前事实

产品定位约束：

- 项目目标是“稳定可用的工具”
- 不是内测展示品
- 也不是面向公开发行的泛用产品
- 所有取舍以稳定可用优先，而不是追求概念完整或形式漂亮

## 2. 当前结论

项目当前已经完全进入 native authority 路线。

当前主链路是：

- Host backend：`media-agent` 负责，正式支持 `native` 与 `obs-ingest`
- Host 视频：`H.264 / H.265` codec-aware 主链路
- Host 音频：native host 走 `Opus 48k stereo`，OBS ingest host 走 `AAC 48k`
- Peer transport：native `libdatachannel`
- Viewer 解码：native
- Viewer 画面：native surface
- Viewer 音量：native authority
- Relay：中间 viewer 直接扇出收到的 `H.264/H.265 + Opus/AAC/PCMU`，不做重新解码再编码

当前已经不是旧的：

- renderer `<video>` authority
- WebRTC 主要由前端自己建链
- `process-audio-capture + Web Audio + addTrack` 为主的旧路径

当前显示形态的真实状态是：

- renderer 会计算“嵌入式”布局矩形
- main 进程补充宿主窗口句柄
- native surface 当前实际仍运行在 owner-attached overlay popup 方案上
- 也就是说：产品体验上是嵌进页面，技术形态上仍不是 Chromium 真正 child HWND 终态

这条显示路线当前可用，已支撑日常调试与联调。  
当前决策已经明确：

- popup overlay 路线继续打磨成正式方案
- 不再把 child embed 当作近期主目标
- child embed 只保留为背景知识，不再作为主线工程牵引
- OBS 本地 SRT ingest 已进入正式 host 模式，不再是旁路试验能力

## 3. 当前代码真实状态

### 3.1 版本与产物

- 桌面端版本：`1.6.2`
- 服务端版本：`1.6.2`
- 构建方式：`electron-builder + nsis`
- 更新源：`generic provider`
- 更新目录：`server/updates/`
- 当前已准备好的发布产物：`VDS-Setup-1.6.2.exe` + `latest.yml`

### 3.2 当前主入口

- [app.js](/d:/project/videosharing/server/public/app.js)
  - 页面主流程、WebSocket、房间状态、基础 UI
  - 通过 native override 接管媒体 authority
- [app-native-overrides.js](/d:/project/videosharing/server/public/app-native-overrides.js)
  - renderer 侧媒体 authority 汇聚层
  - host session、native peer、surface attach/update/detach、stats、relay 控制、fullscreen、viewer volume
- [main.js](/d:/project/videosharing/desktop/main.js)
  - 主进程桥接
  - updater、窗口状态、fullscreen、media-agent IPC
- [media-agent/src/main.cpp](/d:/project/videosharing/media-agent/src/main.cpp)
  - native 媒体 authority 主实现
- [peer_transport.cpp](/d:/project/videosharing/media-agent/src/peer_transport.cpp)
  - native transport

### 3.3 当前页面形态

当前前端 UI 已经不是早期默认布局。

当前真实状态：

- 首页是黑白分栏入口
- host 子页：左侧控制区，右侧预览区
- viewer 子页：左侧播放区，右侧控制区
- topbar、首页转场、返回转场已经重写过一轮
- 质量设置弹窗已改为项目当前风格，并支持更紧凑的分行布局
- host 质量弹窗现在有 `原生推流 / OBS 推流` 两个选项卡
- OBS 选项卡默认只显示一行本地 SRT 地址，默认端口是 `61080`
- OBS 端口可通过“自定义推流地址”开关展开并持久化保存
- host 开播前可选择“公开房间至大厅”，开播后该位置会切成当前公开状态文案
- viewer 加入页已改成 `大厅 / 直连` 两个选项卡，默认进入大厅并轮询公开房间列表

需要明确：

- 这些 UI 改动已经生效
- 但文档里的旧页面描述大多已经过时，不能再拿旧 manual 里的早期 DOM 理解当前实现

## 4. 媒体主链路

### 4.1 Host

当前 host 已经分成两套正式 backend：

- `native host backend`
  - 采集后端：`Windows Graphics Capture`
  - 预览：native live preview surface
  - 视频编码主链路：`H.264 / H.265`
  - 音频编码主链路：`Opus 48k stereo`
  - 硬件编码优先：会探测并优先使用自检通过的硬件编码器
- `obs-ingest backend`
  - 接入方式：本机 `SRT listener`
  - 接入范围：只允许 `127.0.0.1`
  - 输入封装：`MPEG-TS over SRT`
  - 视频：只接受 `H.264 / H.265`
  - 音频：只接受 `AAC 48k`
  - VDS 不控制 OBS，不接 `obs-websocket`
  - OBS 模式不显示 VDS host preview；只在收到有效节目流后建房
  - OBS 中途断流时，房间立即结束并回到等待/空闲 UI

当前真实限制：

- “原始分辨率”入口已从前端移除，native 侧也不再接受 `0x0` 作为原始分辨率语义
- OBS 模式不是通用远程 SRT 网关，只是本机 ingest backend
- OBS 默认端口是 `61080`，也允许手动改成固定自定义端口；但仍只绑定本机
- 当前画质设置支持：
  - `H.264 / H.265`
  - 本地预览开关
  - 手动指定已通过自检的硬件编码器

当前已确认的关键修复：

- Win11 24H2 下，`GraphicsCaptureSession.MinUpdateInterval` 不设置时，WGC 高帧率采集会稳定卡在约 `56-57fps`
- native 侧现已在支持该属性的系统上显式设置 `MinUpdateInterval(1ms)`
- WGC session 现已显式设置：
  - `IsCursorCaptureEnabled(...)`
  - `IsBorderRequired(false)`
- WGC 在目标窗口运行中发生尺寸变化时，`FramePool` 现已按 `frame.ContentSize()` 触发 `Recreate(...)`
- `host preview` 和下游 sender 都已把 `wgc-frame-pool-recreated` 视为正常过渡帧，而不是致命错误
- “开播时目标窗口已最小化”现已走启动期 placeholder，窗口恢复后通过 video sender soft refresh 切回真实流与音频

当前已验证的结论：

- 不开 preview 时仍出现的 `56-57fps` 上限，不是 preview 造成
- 纯本地、无 Electron、无 sender、仅 `display capture + native preview` 的 smoke 在补上 `MinUpdateInterval(1ms)` 后，`10s` 内达到约 `194fps`
- 这说明此前的 `56-57fps` 主要不是编码器、网络、viewer 或 CPU readback 自身上限，而是 WGC 在当前系统上的默认更新间隔问题
- 这也说明“窗口缩放后 host preview 和 viewer 同时花屏”的问题不在 viewer 布局层，而在更上游的 WGC frame-pool 尺寸变化处理
- OBS 本地推流已经完成基础联调：当前本机 OBS `H.264/AAC` 推流可进 viewer，且音频已确认可播放

### 4.2 Viewer

当前 viewer 主链路：

- 收到 native peer 视频后，直接走 native decode
- 画面输出到 native surface
- 音频走 native 解码后播放
- viewer 音量通过 native IPC 控制
- viewer 播放当前只保留原始 `passthrough` 路线
- viewer 不再提供 `synced / passthrough` 切换
- viewer 当前只保留手动音频延迟，不再保留旧的接收侧 A/V sync 调度

当前音频主链路：

- 首选 `Opus`
- 兼容接收 `PCMU fallback`
- 正式支持接收与播放 `AAC`

### 4.3 Relay

当前 relay 的真实实现不是旧版 `relayStream` browser stream 转发。

当前实现是：

- `v1` 作为上游 viewer 收到编码后的 `H.264/H.265 + Opus/AAC/PCMU`
- `v1` 创建下游 relay peer
- `attachPeerMediaSource` 直接绑定 `peer-video:<upstreamPeerId>`
- native 直接把收到的编码帧扇出到下游
- relay 音频 track 会按上游真实 codec 配置，不再默认 host 音频一定是 `Opus`

当前拓扑约束已经明确：

- relay 按严格链式设计
- 不做“尽量浅链”的动态分配
- 正常场景目标观众数以 3 人为主
- 极限场景按不超过 5 人规划

这意味着：

- 不经过 viewer 重新解码再编码
- 延迟和损耗都显著低于旧 browser relay

为保证第二跳可解码，relay 现在已经补了：

- H.264 / H.265 decoder config / random access bootstrap 缓存
- 新下游接入时先发 bootstrap，再发正常视频 AU

需要明确补充一个当前未收口事实：

- 当前 `viewer-upstream passthrough` 唯一路线下，`host -> v1` 单跳通常可稳定播放
- 但 `host -> v1 -> v2` 的第二跳 relay 当前仍不稳定
- 真实表现不是单一一种，而是几种回归形态来回出现：
  - `v2` 有声音无画面
  - `v2` 前几秒像慢速播放，随后卡住
  - `v2` 初始收到大量视频帧，随后接收速率掉到极低
- 当前最强怀疑是：relay 视频 sender 仍然没有完全从本地 viewer 播放策略里解耦出来

## 5. 接收侧启动逻辑与播放现状

这里需要明确写出现状，而不是保留已经下线的旧描述。

### 5.1 当前已落地的策略

- H.264 启动期明确等待 `SPS/PPS + IDR`
- 在拿到可用开播点前，不盲目把普通 `P/B` 帧丢进调度队列
- 音频在视频 bootstrap 完成前直接丢弃，避免先播出没有对应画面的声音
- viewer steady-state 当前只保留原来的直通播放
- viewer 侧旧的 A/V sync worker、目标延迟调度和播放模式切换都已退出主路径
- viewer 现在的唯一用户可调节项是手动音频延迟

### 5.2 当前真实结论

最近这轮修改后的结论是：

- 旧 `synced` 路线主观效果不如原始直通，已经从当前主线移除
- 当前默认也是唯一路线：`passthrough local playback + manual audio delay`
- 接收侧当前最重要的真实问题已经不再是“旧 A/V sync 参数怎么调”，而是：
  - 直通本身的观感还要继续验证
  - relay 第二跳的视频稳健性仍未收口

### 5.3 当前剩余风险

接收侧当前剩余风险仍然明确：

- 直通播放虽然更符合当前主观体验，但还没有形成“永久不用再碰”的结论
- 长时间 soak 还不够
- relay 第二跳、第三跳叠加后的接收稳定性仍需继续验证
- 如果后续要重新做顺滑度优化，必须是新方案，不能回滚旧 `synced` / A/V sync 逻辑

结论很明确：

- 当前 viewer 播放已经先收缩到单一路线，减少了行为分叉
- 但这里还不是“永久免维护”状态

### 5.4 当前验收目标

连接稳健性的核心验收目标已经明确：

- 重点避免连接失败
- 重点避免重连失败
- 重点避免偶发无声无画
- 成功连接的标准不是“连上就算成功”，而是 `5 秒内音画稳定`

自动恢复约束：

- 中间 relay 节点退出后，下游要自动接回
- 下游恢复必须自动协商，不依赖用户重新点加入

### 5.5 当前未收口的 relay regression

截至这次文档更新，最需要如实同步的问题不是单跳接收，而是：

- 当前唯一的 `viewer-upstream passthrough` 路线下，第二跳 relay 视频输出仍然不稳

最近这轮真实观察到的现象：

- `v1` 通常有声音、有画面，`native-peer-stats` 也能持续增长
- `v2` 的问题集中在视频，不稳定形态包括：
  - `framesReceived` 一开始冲很高，但 `framesRendered` 明显追不上
  - `framesReceived` 前期增长后几乎停住
  - 只有声音没有画面
  - 先慢速播放再卡死
- 当前最强怀疑是：问题不只是“解码器缺关键帧”这么简单，而是 relay sender 的起播、bootstrap、以及和本地 viewer 启动门控之间仍存在耦合

最近已经试过、但没有最终收口的方向：

- relay 视频从同步 fanout 改成异步队列
- relay bootstrap 改成“完整 GOP 回放”
- relay bootstrap 改成“只发 snapshot 再等下一次随机接入点”
- relay bootstrap 限制历史长度
- 删除 relay video 的应用级 pacing
- 在 `consume_remote_peer_video_frame(...)` 里提前复制 `relay_decode_units`，避免被本地 startup gate 直接挡住

这些尝试说明：

- 代码里确实存在可疑耦合点
- 但当前分支还没有把 `passthrough local playback` 和 `relay downstream sender` 真正彻底拆干净
- 因此不能把“relay 问题已经定位并修复”写成事实

## 6. 质量设置现状

当前质量设置 UI 和 native 参数已经对齐：

- host backend：`原生推流 / OBS 推流`
- 编码：`H.264 / H.265`
- 分辨率：`360p / 480p / 720p / 1080p / 2k / 4k`
- 帧率：`5 / 30 / 60 / 90`
- 码率：默认 `10000 kbps`，步长 `1000`
- 硬件加速编码：开关可用
- 本地预览：开关可用
- 硬件编码器：支持自动选择，或手动指定“已通过自检”的硬件编码器
- 编码器预设：`质量 / 均衡 / 速度`
- 调优：`fastdecode / zerolatency`

OBS 模式当前真实 UI：

- 默认只显示一行本地 `SRT` 地址
- 默认端口固定为 `61080`
- 主按钮是 `复制并开始`
- 打开“自定义推流地址”后，才会展开端口输入框和保存按钮
- 确认后进入 `等待 OBS 推流...`，收到有效 OBS 节目流后才真正创建房间

当前硬件能力显示逻辑已修正为：

- 优先展示 native self-test 验证通过的编码器
- 不再把“FFmpeg 编进去了但机器不能用”的编码器误报成可用

后续编码路线约束：

- `H.265` 不是可有可无的附加项
- 当前已经进入主链路，但还需要继续做完整双端、三端、晚加入、重连、长时间 soak 验证
- 目标不是只有 host 单跳可演示，而是完整 `host -> viewer -> relay viewer` 链路稳健可用

## 7. 更新与打包现状

### 7.1 当前打包链

- 桌面包：`NSIS`
- 发布脚本：`npm run build:release`
- 更新目录刷新脚本：`prepare-server-release`
- `runtime/media-agent` 已通过 `extraResources` 打包，避免再被错误塞进 `app.asar`
- `1.6.2` 已完成打包，并已把产物复制到 `server/updates/`

### 7.2 当前自动更新链

真实状态：

- feed URL：`${SERVER_URL}/updates/`
- `useMultipleRangeRequest: false`
- `server/updates/` 作为真正更新源目录
- 差分更新客户端已补本地 `installer.exe` cache seed 逻辑

边界说明：

- 第一次从手动安装包升级时，仍可能走整包
- 只要成功经历过一次自动下载，后续差分更新才有稳定前提

当前更新目标约束已经明确：

- 第一次整包可接受
- 但后续版本升级必须把差分更新成功率做高
- 这件事的优先级高于“功能看起来已经能 fallback 到整包”

### 7.3 当前与 WGC 边框相关的真实状态

- native 代码层面已经显式加入 `IsBorderRequired(false)` 开关
- 这意味着在支持该属性的系统上，不再只靠系统默认值，而是主动请求关闭黄框
- 但“所有机器、所有打包形态、所有系统版本都已验证完全消失”这件事，目前还不能写成已完全收口
- 是否仍存在 package identity / 系统策略 / 权限模型导致的个别机器残留问题，还需要继续做跨机器验证

## 8. 当前验证能力

### 8.1 静态检查

当前每次改动后的最低验证基线：

- `node --check server/public/app.js`
- `node --check server/public/app-native-overrides.js`
- `node --check desktop/main.js`
- `node --check server/index.js`
- `powershell -ExecutionPolicy Bypass -File scripts/build-media-agent.ps1 -Configuration Release`

### 8.2 本地联调脚本

当前仓库已具备：

- `npm run dev`
- `npm run dev:dual`
- `npm run dev:dual:native`
- `npm run dev:triple`
- `npm run dev:triple:native`

其中：

- `dev:dual:native` 用于 host/viewer 双端 native 联调
- `dev:triple:native` 用于 `host -> v1 -> v2` relay 联调

### 8.3 最近已通过的链路

最近这轮修改后，已经明确通过过的测试类型：

- 单跳 native host -> viewer 基本建连
- 本机 OBS -> viewer 基础联调已通过：`H.264/AAC` 有音有画
- 接收侧启动与 steady-state 调度回归
- WGC 高帧率瓶颈已定位并打穿：
  - 不加 `MinUpdateInterval` 时，本地 preview 稳定卡在约 `56-57fps`
  - 加上 `MinUpdateInterval(1ms)` 后，纯本地 `display capture + native preview` smoke `10s` 内达到约 `194fps`
- `1.6.2` 已完成 `npm run build:release`，且 server `/api/version` 已返回 `1.6.2`

但仍要强调：

- “通过测试”不等于“已经千锤不烂”
- 当前最该继续做的是 soak、重连、断链恢复、三端长时间播放
- `host -> v1 -> v2` 在当前 viewer 唯一直通路径下的 relay 视频链路，目前不能写成“已通过”

### 8.4 当前调试与 smoke 能力的真实边界

当前仓库虽然有：

- `npm run dev:dual:native`
- `npm run dev:triple:native`

但这些脚本本质上只是：

- 拉起本地 server
- 拉起多实例 Electron 窗口

它们还不是“全自动可回归 smoke harness”。当前仓库里没有一套现成脚本，能在不人工点 UI 的情况下自动完成：

- host 建房
- viewer 1 加入
- viewer 2 加入
- 自动收集并对比三端 relay 统计

因此接手时必须面对一个现实：

- 当前三端 relay 复现主要还是依赖人工操作 + 日志观察
- 不要把 `dev:triple:native` 误当成已经成型的自动化回归体系

### 8.5 popup 正式方案验收项

popup overlay 作为正式方案，当前最重要的验收点已经明确为：

- 跟随稳定
- 全屏稳定
- 弹窗遮挡正确
- 点击前台正确

后续所有 popup 相关改动都必须围绕这 4 项，而不是继续分散在无关细节上。

## 9. 分层边界

### 9.1 `server/public/app.js`

负责：

- 页面初始化
- WebSocket 连接与房间 UI
- 质量弹窗 UI
- 通过 override hook 进入 native authority

不负责：

- 自己建媒体 authority peer
- 自己控制 `<video>` 播放 authority
- 自己决定 relay 媒体绑定

### 9.2 `server/public/app-native-overrides.js`

负责：

- renderer 侧媒体 authority 汇聚
- host session 启停
- native peer 创建 / 关闭 / SDP / ICE
- surface attach / update / detach
- relay 控制
- viewer volume / fullscreen / stats

不负责：

- 主窗口创建
- DOM 静态结构
- native agent 内部实现

### 9.3 `desktop/main.js`

负责：

- `BrowserWindow`
- `media-agent` JSON RPC 桥
- fullscreen
- 更新器
- tray
- 窗口 bounds / handle 上下文

不负责：

- DOM 子元素布局计算
- 媒体编解码
- 房间业务状态机

### 9.4 `media-agent`

负责：

- host capture
- native encode / transport / decode
- relay fanout
- host preview / viewer surface
- viewer volume authority
- stats 与错误上报

不负责：

- WebSocket 房间逻辑
- HTML UI 状态
- source modal 业务交互

## 10. 当前已完成项

以下内容已经真实存在，不再是计划：

- native host preview 可用
- native viewer surface 可用
- fullscreen 覆盖任务栏已修
- Windows fullscreen 已切到窗口化全屏实现
- 调试日志前后端联动已收口
- 与当前 6 类 native reliability 问题直接相关的高频诊断日志，默认都已收口到详细调试开关
- PowerShell 正常运行时不再默认刷屏
- 质量设置与 native 参数贯通
- `H.265` 已进入主链路并可在 UI 中选择
- “原始分辨率”前后端都已下线
- 音频主链路从 `PCMU` 升级为 `Opus`
- `AAC` 已正式进入 transport / relay / viewer playback 主链路
- relay 从 browser stream 转发切到 native encoded fanout
- relay 的 codec-aware bootstrap 已补
- relay 新下游起播已改为优先回放缓存 GOP，并在 bootstrap 成功后切回 steady-state
- host backend 已支持 `native / obs-ingest`
- OBS 本地 `SRT` ingest 已接入正式 host 模式，并支持 `H.264 / H.265 + AAC`
- OBS 模式现在会等待有效节目流后再建房，断流会立即结束房间
- OBS 推流地址已改成默认固定端口 `61080`，并支持持久化自定义端口
- host 已支持“公开房间至大厅”开关，viewer 加入页已支持公开房间大厅与手动刷新
- host 建房成功后会自动复制房间号到系统剪贴板
- `viewer-left` 已补上游通知，`v2` 重连不再依赖残留旧下游 peer 被动超时
- 关闭 `relay-downstream` 时不再误停 `viewer-upstream` 的原生音频运行时
- 差分更新 installer cache seed 已补
- WGC 高帧率问题已定位到 `GraphicsCaptureSession.MinUpdateInterval`
- WGC session 已显式设置 `MinUpdateInterval(1ms)` / `IsCursorCaptureEnabled(...)` / `IsBorderRequired(false)`
- 运行中窗口 resize 导致的 `host preview + viewer` 同时花屏问题已定位到 WGC frame-pool 未随 `ContentSize` 变化重建，并已补上 `Recreate(...)`
- Host 停止直播已改为先更新 UI、再并行回收 native 资源
- Host 首次开播已增加 readiness gate；preview surface attach 失败时会自动降级为无预览重试
- Windows 独占全屏目标已补 Win32 synthetic capture target fallback
- “开播即最小化窗口”现已支持启动期占位画面；窗口恢复后通过 video sender soft refresh 接回真实视频与音频
- 手动音频选择已改成列表点击选中，不再只靠“更改音频进程”循环切换
- 画面源选择弹窗已补精简副标题，以及滚动时常驻的刷新 / 确认 / 取消控件
- Viewer fullscreen 已补播放器式 underbar 基础形态，并接入原生音量控制
- 非 fullscreen 模式下 maximize / restore 引发的 viewer native surface 定位错误已修
- Viewer 非 fullscreen 舞台背景与容器比例已经收紧，播放区外的空白区已改为项目当前深灰舞台风格
- viewer 端旧的 `synced` / A/V sync 播放模式已从当前主线移除，只保留直通播放与手动音频延迟

## 11. 当前未完成项

仍然没有彻底收口的部分：

- relay 长链稳健性还需继续验证
- `viewer-upstream passthrough -> relay-downstream` 视频链路仍有明显 regression，当前没有收口
- popup overlay 虽已选定为正式路线，但仍需把正式验收项全部打磨完成
- host preview 的 `native_live_preview` popup attach 仍存在偶发失败，当前正在继续收窄 owner hook / layout / attach 时序问题
- viewer fullscreen underbar 当前已基本可用，但交互细节仍在打磨，不能写成最终完成
- `H.265` 虽已进入主链路，但双端 / 三端 / 晚加入 / 重连 / 长时间 soak 还需继续验证
- OBS 本地推流模式虽已基本可用，但 `H.264/H.265` 双 codec、长时间 soak、断流恢复、端口占用报错等还需继续验证
- OBS 模式当前仍只支持本机 `127.0.0.1` + `AAC 48k`，不能写成“任意 SRT sender 都已正式支持”
- WGC 黄框虽然已有代码级关闭开关，但跨机器、跨系统、跨打包形态的最终验证还未完成
- 差分更新成功率还没有达到目标状态
- 三端 smoke 还缺真正自动化 harness，当前排障效率受人工点击和人工抄日志限制
- viewer 端如果后续要重新引入“更平滑的播放策略”，必须基于新方案重新设计，不能把旧 `synced` 当作待恢复路线

## 12. 下一阶段顺序

### 阶段 A：收口 OBS 本地推流模式

目标：

- 持续验证 OBS `H.264 / H.265 + AAC` 在 host / viewer / relay 链路中的真实稳健性
- 覆盖默认端口、自定义端口、端口占用、重复开始/停止、断流立即结束房间
- 保持 OBS ingest 只是一套 host backend，不允许重新长出旁路专用业务状态机

### 阶段 B：全链路稳健性

目标：

- 先收口 `v1 passthrough + v2 relay` 当前 regression，再谈更长 soak
- 继续压缩单次建连失败率
- 继续提高首帧成功率和启动平滑度
- 继续观察 `queuedVideo / queuedAudio / dropped* / submitted* / dispatched*`
- 做更长时间的双端、三端 soak
- 强化中间 relay 节点退出后的自动恢复
- 重点消灭“连接失败 / 重连失败 / 偶发无声无画”
- 继续验证高帧率 WGC 在正式双端链路中是否稳定传递，而不是只停留在本地 preview smoke
- 不再把“恢复旧 A/V sync”列为备选方向，viewer 稳定性问题优先在现有直通主链路上定位

### 阶段 C：验证并稳住 H.265 主链路

目标：

- 持续验证 `H.265` 在 native host 与 OBS host 两条 backend 中的真实稳健性
- 重点覆盖双端、三端、晚加入、断线重连、长时间播放
- 继续保持 `H.264 / H.265` 都走同一套 codec-aware 主骨架，避免重新长出分叉专用路线

### 阶段 D：代码打磨

目标：

- 在效果一致或更优的前提下，提高运行效率
- 逐步优化掉旧逻辑
- 在微观层面继续寻找更优算法，而不是单纯堆补丁
- 保持边界清晰，避免一边修稳健性一边再次长出旧路线兼容层

### 阶段 E：发布链继续收口

目标：

- 差分更新继续实测
- 明确线上保留版本策略
- 提高后续版本差分更新成功率
- 评估是否真的需要独立 `MSIX` 实验线，而不是直接切主线

## 13. 明确禁止

禁止重新做这些事情：

- 恢复 renderer `<video>` authority 为主方案
- 让前端和 native 并存两套媒体 authority
- 遇到错误时静默 fallback 到旧链路
- 为旧 browser relay 再补长期兼容层
- 用“抽象层”掩盖当前还没稳定的真实问题

## 14. 本次文档更新结论

截至 `1.6.2` 当前仓库状态，最准确的总结是：

- native authority 已经是唯一主链路
- `H.264 / H.265 + Opus / AAC + native relay fanout` 已经落地
- OBS 本地 `SRT` ingest 已经进入正式 host backend，并且基础音视频联调已通过
- 更新、UI、调试、fullscreen、质量设置都已跟这条主链路对齐
- popup overlay 已经被确定为正式打磨路线
- Windows fullscreen 已切成窗口化全屏，任务栏覆盖和 maximize / restore viewer surface 错位问题都已收口
- 观看端 fullscreen underbar 已经进入“可用并继续打磨”的状态，而不是还没有形态
- Win11 24H2 下 WGC 高帧率瓶颈已经定位到 `GraphicsCaptureSession.MinUpdateInterval`
- WGC 运行中尺寸变化现在已经会触发 frame-pool 重建，`host preview` 和 `viewer` 不再共用一条会稳定产出坏帧的旧采集路径
- “开播即最小化窗口”当前已经能通过启动期 placeholder + 恢复 soft refresh 接回真实视频与音频
- OBS 推流地址当前默认固定为 `61080`，并支持持久化自定义端口；UI 已改成“复制并开始”的直接工作流
- viewer 加入页现在已有公开房间大厅；host 可以在开播前决定是否把房间公开到大厅
- host 建房成功后，房间号会立即复制到系统剪贴板
- viewer 当前只保留原始 `passthrough` 播放，旧 `synced` / A/V sync 路线已从主线移除；音频只保留手动延迟控制
- 当前最大的未收口问题已经明确收缩到：当前 `viewer-upstream passthrough` 唯一路线下，`host -> v1 -> v2` 的 relay 视频第二跳仍不稳定
- 当前最大的工程重点顺序已经明确：
  - 先继续收口 OBS 本地推流模式的边界与稳定性
  - 再收口 `v1 passthrough + v2 relay` 当前 regression
  - 再验证并稳住 `H.265` 与高帧率正式链路
  - 最后持续打磨代码、效率与发布链

## 15. 给下一个 Agent 的交接说明

如果你是接手这个项目的下一个 agent，不要先发散找“是不是还要保留旧浏览器链路”，也不要先去碰 child embed。当前主线已经明确：native authority 是唯一媒体主链路，popup overlay 是正式打磨路线，viewer 当前只保留原始直通播放；眼前第一优先级已经不是抽象架构，而是收口一个非常具体的 regression：当前 `viewer-upstream passthrough` 唯一路线下，`host -> v1 -> v2` 的第二跳 relay 视频仍不稳定。先读本文，再看 [app-native-overrides.js](/d:/project/videosharing/server/public/app-native-overrides.js)、[main.js](/d:/project/videosharing/desktop/main.js)、[main.cpp](/d:/project/videosharing/media-agent/src/main.cpp) 这三个入口文件，确认当前 host、viewer、relay、update 的真实行为；然后优先用 `npm run dev:dual:native` 和 `npm run dev:triple:native` 复现实况。

最近一轮已经做过、但还不能写成“修好了”的尝试包括：

- relay 视频异步 fanout
- 多种 bootstrap 策略切换：完整 GOP、snapshot、等待 live random access、压缩 bootstrap 历史长度
- 删除 relay video 应用级 pacing
- 让 relay 在本地 viewer startup gate 之前就复制并发送 `relay_decode_units`
- 增加 `relaySubscriberRuntime` 和前端 `[media-engine native-relay-stats]` 日志

这些改动说明调试方向已经逼近真实问题，但也说明一件事：当前分支里有不少“为定位问题而做的实验性改动”，不要把它们当成已经验收通过的最终解。接手时先看日志，再决定保留还是回退，不要继续在未证实的假设上叠补丁。

排查 relay regression 时，先盯这几组事实：

- `v1` 是否稳定：看 `native-peer-stats` 里的 `framesReceived / framesRendered / dispatchedAudio`
- `v2` 是否真没收到视频：看 `framesReceived`
- `v2` 是收到后渲染跟不上，还是 sender 根本没送：结合 `[media-engine native-relay-stats]` 里的 `videoFramesSent / pendingBootstrap / bootstrapSnapshotSent / relayFramesSent / relayReason`

处理连接问题时，先看 `native-peer-stats` 里的 `queuedVideo / queuedAudio / submittedVideo / dispatchedAudio / dropped* / receiverReason`，不要凭感觉加新阈值。处理 relay sender 问题时，先确认“是没发出去，还是发出去但下游起播/渲染追不上”，不要一上来就把锅甩给 FFmpeg、surface 或 ICE。处理高帧率问题时，优先确认 `GraphicsCaptureSession.MinUpdateInterval` 是否生效，再看 host / viewer FPS 指标，不要重新回到猜编码器或猜 WebRTC 的路径。处理更新问题时，先区分“服务端产物不一致”和“客户端本地 installer 基底不匹配”，不要一上来就怀疑 blockmap 生成。任何改动都要坚持 fail-fast、边界单一、不要静默 fallback 到旧 authority。
