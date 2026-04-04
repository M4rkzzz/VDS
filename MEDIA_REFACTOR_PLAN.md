# VDS Media Refactor Plan

## 1. 目的

这份文档记录仓库在 `1.5.7` 时点的真实媒体架构、真实边界、真实验证结果、真实未解问题，以及接下来明确的执行方向。  
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

- Host 采集：`media-agent` 负责
- Host 编码：native `H.264 / H.265` codec-aware 主链路
- Host 音频：native `Opus 48k stereo` 主链路
- Peer transport：native `libdatachannel`
- Viewer 解码：native
- Viewer 画面：native surface
- Viewer 音量：native authority
- Relay：中间 viewer 直接扇出收到的 `H.264/H.265 + Opus`，不做重新解码再编码

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

## 3. 当前代码真实状态

### 3.1 版本与产物

- 桌面端版本：`1.5.7`
- 服务端版本：`1.5.7`
- 构建方式：`electron-builder + nsis`
- 更新源：`generic provider`
- 更新目录：`server/updates/`

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

需要明确：

- 这些 UI 改动已经生效
- 但文档里的旧页面描述大多已经过时，不能再拿旧 manual 里的早期 DOM 理解当前实现

## 4. 媒体主链路

### 4.1 Host

当前 host 主链路：

- 采集后端：`Windows Graphics Capture`
- 预览：native live preview surface
- 视频编码主链路：`H.264 / H.265`
- 音频编码主链路：`Opus 48k stereo`
- 硬件编码优先：会探测并优先使用自检通过的硬件编码器

当前真实限制：

- “原始分辨率”入口已从前端移除，native 侧也不再接受 `0x0` 作为原始分辨率语义
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

当前已验证的结论：

- 不开 preview 时仍出现的 `56-57fps` 上限，不是 preview 造成
- 纯本地、无 Electron、无 sender、仅 `display capture + native preview` 的 smoke 在补上 `MinUpdateInterval(1ms)` 后，`10s` 内达到约 `194fps`
- 这说明此前的 `56-57fps` 主要不是编码器、网络、viewer 或 CPU readback 自身上限，而是 WGC 在当前系统上的默认更新间隔问题

### 4.2 Viewer

当前 viewer 主链路：

- 收到 native peer 视频后，直接走 native decode
- 画面输出到 native surface
- 音频走 native 解码后播放
- viewer 音量通过 native IPC 控制

当前音频主链路：

- 首选 `Opus`
- 兼容接收 `PCMU fallback`

### 4.3 Relay

当前 relay 的真实实现不是旧版 `relayStream` browser stream 转发。

当前实现是：

- `v1` 作为上游 viewer 收到编码后的 `H.264/H.265 + Opus`
- `v1` 创建下游 relay peer
- `attachPeerMediaSource` 直接绑定 `peer-video:<upstreamPeerId>`
- native 直接把收到的编码帧扇出到下游

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

## 5. 接收侧同步与启动逻辑

这是当前项目最敏感、也是最近改动最多的部分。

### 5.1 当前已落地的策略

- H.264 启动期明确等待 `SPS/PPS + IDR`
- 在拿到可用开播点前，不盲目把普通 `P/B` 帧丢进调度队列
- 音频在视频 bootstrap 完成前直接丢弃，避免先建立错误的 A/V 锚
- steady-state 不再用“随意切视频队列前端”的方式粗暴追赶
- 当前 A/V 调度已经改为基于“本地接收时刻 + 目标延迟”排队，不再直接跨媒体比较各自 RTP 起始时间

### 5.2 当前真实结论

最近这轮修改后的结论是：

- 启动阶段全丢锁死的问题已经定位并修过
- “视频先播十几帧后 freeze”的部分根因已经收缩到接收侧调度
- 调度逻辑已经从“堵”转向“疏”，即：
  - 视频 backlog 时优先调整目标延迟追赶
  - 不再长期让视频无限抢占音频

### 5.3 当前剩余风险

接收侧现在已经能通过最新一轮本地测试，但仍然是当前第一优先级风险点：

- 长时间 soak 还不够
- 极端网络抖动下的追赶行为还需要继续观察
- relay 第二跳、第三跳叠加后的接收稳定性仍需继续验证

结论很明确：

- 当前接收侧已经从“经常 freeze”推进到了“可工作、可继续细调”
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

## 6. 质量设置现状

当前质量设置 UI 和 native 参数已经对齐：

- 编码：`H.264 / H.265`
- 分辨率：`360p / 480p / 720p / 1080p / 2k / 4k`
- 帧率：`5 / 30 / 60 / 90`
- 码率：默认 `10000 kbps`，步长 `1000`
- 硬件加速编码：开关可用
- 本地预览：开关可用
- 硬件编码器：支持自动选择，或手动指定“已通过自检”的硬件编码器
- 编码器预设：`质量 / 均衡 / 速度`
- 调优：`fastdecode / zerolatency`

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
- 接收侧启动与 steady-state 调度回归
- relay 链路的 codec-aware bootstrap 修复后继续推进
- WGC 高帧率瓶颈已定位并打穿：
  - 不加 `MinUpdateInterval` 时，本地 preview 稳定卡在约 `56-57fps`
  - 加上 `MinUpdateInterval(1ms)` 后，纯本地 `display capture + native preview` smoke `10s` 内达到约 `194fps`

但仍要强调：

- “通过测试”不等于“已经千锤不烂”
- 当前最该继续做的是 soak、重连、断链恢复、三端长时间播放

### 8.4 popup 正式方案验收项

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
- 调试日志前后端联动已收口
- PowerShell 正常运行时不再默认刷屏
- 质量设置与 native 参数贯通
- `H.265` 已进入主链路并可在 UI 中选择
- “原始分辨率”前后端都已下线
- 音频主链路从 `PCMU` 升级为 `Opus`
- relay 从 browser stream 转发切到 native encoded fanout
- relay 的 codec-aware bootstrap 已补
- 差分更新 installer cache seed 已补
- WGC 高帧率问题已定位到 `GraphicsCaptureSession.MinUpdateInterval`
- WGC session 已显式设置 `MinUpdateInterval(1ms)` / `IsCursorCaptureEnabled(...)` / `IsBorderRequired(false)`

## 11. 当前未完成项

仍然没有彻底收口的部分：

- 接收侧 A/V 调度还需继续 soak
- relay 长链稳健性还需继续验证
- popup overlay 虽已选定为正式路线，但仍需把正式验收项全部打磨完成
- `H.265` 虽已进入主链路，但双端 / 三端 / 晚加入 / 重连 / 长时间 soak 还需继续验证
- WGC 黄框虽然已有代码级关闭开关，但跨机器、跨系统、跨打包形态的最终验证还未完成
- 差分更新成功率还没有达到目标状态

## 12. 下一阶段顺序

### 阶段 A：验证并稳住 H.265 主链路

目标：

- 持续验证 `H.265` 在 host / viewer / relay 链路中的真实稳健性
- 重点覆盖双端、三端、晚加入、断线重连、长时间播放
- 继续保持 `H.264 / H.265` 都走同一套 codec-aware 主骨架，避免重新长出分叉专用路线

### 阶段 B：全链路稳健性

目标：

- 继续压缩单次建连失败率
- 继续提高首帧成功率和启动平滑度
- 继续观察 `queuedVideo / queuedAudio / dropped* / submitted* / dispatched*`
- 做更长时间的双端、三端 soak
- 强化中间 relay 节点退出后的自动恢复
- 重点消灭“连接失败 / 重连失败 / 偶发无声无画”
- 继续验证高帧率 WGC 在正式双端链路中是否稳定传递，而不是只停留在本地 preview smoke

### 阶段 C：代码打磨

目标：

- 在效果一致或更优的前提下，提高运行效率
- 逐步优化掉旧逻辑
- 在微观层面继续寻找更优算法，而不是单纯堆补丁
- 保持边界清晰，避免一边修稳健性一边再次长出旧路线兼容层

### 阶段 D：发布链继续收口

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

截至 `1.5.7` 当前仓库状态，最准确的总结是：

- native authority 已经是唯一主链路
- `H.264 / H.265 + Opus + native relay fanout` 已经落地
- 更新、UI、调试、fullscreen、质量设置都已跟这条主链路对齐
- popup overlay 已经被确定为正式打磨路线
- Win11 24H2 下 WGC 高帧率瓶颈已经定位到 `GraphicsCaptureSession.MinUpdateInterval`
- 当前最大的工程重点顺序已经明确：
  - 先验证并稳住 `H.265` 与高帧率正式链路
  - 再完善全链路稳健性
  - 最后持续打磨代码和效率

## 15. 给下一个 Agent 的交接说明

如果你是接手这个项目的下一个 agent，不要先发散找“是不是还要保留旧浏览器链路”，也不要先去碰 child embed。当前主线已经明确：native authority 是唯一媒体主链路，popup overlay 是正式打磨路线，接下来优先级是 `H.265 / 高帧率正式链路验证 -> 全链路稳健性 -> 代码打磨`。先读本文，再看 [app-native-overrides.js](/d:/project/videosharing/server/public/app-native-overrides.js)、[main.js](/d:/project/videosharing/desktop/main.js)、[main.cpp](/d:/project/videosharing/media-agent/src/main.cpp) 这三个入口文件，确认当前 host、viewer、relay、update 的真实行为；然后优先用 `npm run dev:dual:native` 和 `npm run dev:triple:native` 复现实况。处理连接问题时，先看 `native-peer-stats` 里的 `queuedVideo / queuedAudio / submittedVideo / dispatchedAudio / dropped* / receiverReason`，不要凭感觉加新阈值；处理高帧率问题时，优先确认 `GraphicsCaptureSession.MinUpdateInterval` 是否生效，再看 host / viewer FPS 指标，不要重新回到猜编码器或猜 WebRTC 的路径。处理更新问题时，先区分“服务端产物不一致”和“客户端本地 installer 基底不匹配”，不要一上来就怀疑 blockmap 生成。任何改动都要坚持 fail-fast、边界单一、不要静默 fallback 到旧 authority。
