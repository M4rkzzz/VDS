# VDS Media Refactor Plan

## 1. 文档定位

这份文档记录当前 `videosharing` 项目的媒体架构、已验证状态、剩余风险和后续执行顺序。

它的用途：

- 真相文档：说明当前代码真实在做什么。
- 计划文档：说明接下来还应该优先处理什么。
- 交接文档：让后续接手的人快速理解媒体链路、边界和验收方式。

强制原则：

- 只写真实存在的实现。
- 只写已经验证过的链路。
- 未完成项必须明确写成风险或下一步。
- 不用“未来可能”掩盖当前事实。

最近一次对齐日期：`2026-04-26`

当前发布版本：`1.6.4`

## 2. 未发布改动记录

本区域只记录当前工作区已经发生、但尚未进入正式 release 的改动。发布新版本后，应把已发布条目移动到 `CHANGELOG.md`，并清空或重建本区域。

当前未发布改动：

- 暂无。1.6.4 已发布条目已迁移到 `CHANGELOG.md`。

当前未发布改动已验证：

- 暂无。

## 3. 当前结论

项目当前已经进入 `native authority` 路线，并且本轮 `media-agent` 模块化已经收尾。

当前主链路：

- Host backend：`native` 与 `obs-ingest`
- Host 视频：`H.264 / H.265`
- Host 音频：native host 使用 `Opus 48k stereo`，OBS ingest 使用 `AAC 48k`
- Peer transport：native `libdatachannel`
- Viewer 解码：native
- Viewer 画面：native surface
- Viewer 音量：native authority
- Relay：native encoded fanout，转发 `H.264/H.265 + Opus/AAC/PCMU`

当前已经不是旧路线：

- renderer `<video>` authority
- 前端自建 WebRTC 主媒体链路
- `process-audio-capture + Web Audio + addTrack` 主路径
- browser stream relay

显示形态：

- renderer 计算嵌入式布局矩形
- main 进程补充宿主窗口句柄
- native surface 采用 owner-attached popup overlay 方案
- 产品体验是嵌入页面，技术形态不是 Chromium child HWND

当前工程决策：

- popup overlay 作为正式路线继续打磨
- child embed 不作为近期主线
- OBS 本地 SRT ingest 是正式 host backend
- `media-agent/src/main.cpp` 已不再承载业务实现，只是进程级入口

## 4. 当前代码状态

### 4.1 主入口

- [server/public/app.js](/d:/project/videosharing/server/public/app.js)
  - 页面主流程、WebSocket、房间状态、基础 UI
  - 通过 native override 进入媒体 authority
- [server/public/app-native-overrides.js](/d:/project/videosharing/server/public/app-native-overrides.js)
  - renderer 侧 native media authority 汇聚层
  - host session、native peer、surface、relay、stats、fullscreen、viewer volume
- [desktop/main.js](/d:/project/videosharing/desktop/main.js)
  - Electron 主进程桥接
  - updater、窗口状态、fullscreen、media-agent IPC
- [desktop/media-agent-manager.js](/d:/project/videosharing/desktop/media-agent-manager.js)
  - `media-agent` 子进程生命周期和 JSON-RPC 请求管理
- [media-agent/src/main.cpp](/d:/project/videosharing/media-agent/src/main.cpp)
  - 进程级入口：bootstrap、`agent-ready`、RPC loop 调用、shutdown
- [media-agent/src/agent_rpc_router.cpp](/d:/project/videosharing/media-agent/src/agent_rpc_router.cpp)
  - JSON-RPC stdin loop、方法路由、统一 result/error 写回
- [media-agent/src/agent_runtime.h](/d:/project/videosharing/media-agent/src/agent_runtime.h)
  - `AgentRuntimeState`、`PeerState` 和主要运行时状态结构

### 4.2 media-agent 模块化结果

本轮模块化已经完成并通过验收。详细记录见：

- [docs/MEDIA_AGENT_MODULARIZATION.md](/d:/project/videosharing/docs/MEDIA_AGENT_MODULARIZATION.md)

关键结果：

- `main.cpp` 已压缩到进程级入口，不再包含媒体业务逻辑。
- JSON 协议、事件输出、运行时状态、host pipeline、host session、viewer audio/video、relay、OBS ingest、peer control、peer media binding、surface control、platform/process 工具均已拆分到独立模块。
- 已新增 CMake 单测目标 `vds-media-agent-tests`。
- 已新增质量门禁脚本：
  - `npm run test:media-agent`
  - `npm run smoke:media-agent`
  - `npm run verify:media-agent`
  - `npm run e2e:media-agent`

当前验证结论：

- `npm run build:release` 已通过，并刷新 `dist/VDS-Setup-1.6.4.exe`、`dist/VDS-Setup-1.6.4.exe.blockmap`、`server/updates/latest.yml` 和 `server/updates/VDS-Setup-1.6.4.*`。
- `npm run verify:media-agent` 已通过。
- `npm run check:logging` 已通过。
- `node --check server/public/app.js`、`node --check server/public/app-native-overrides.js`、`node --check server/server-core.js` 已通过。
- `npm run e2e:media-agent` 已通过自动门禁并输出人工验收清单。
- dual native、triple native、OBS ingest 人工端到端验证已通过。

## 5. 媒体主链路

### 5.1 Host

当前 host 有两套正式 backend。

`native` backend：

- 采集后端：Windows Graphics Capture
- 预览：native live preview surface
- 视频编码：`H.264 / H.265`
- 关键帧策略：默认 `1s`，高级选项支持 `0.5s` 和 `all-intra`；`all-intra` 只用于排障，高带宽、高负载。
- 音频编码：`Opus 48k stereo`
- 编码器选择：优先使用 native self-test 通过的硬件编码器

`obs-ingest` backend：

- 接入方式：本机 SRT listener
- 绑定范围：`127.0.0.1`
- 输入封装：MPEG-TS over SRT
- 视频：`H.264 / H.265`
- 音频：`AAC 48k`
- VDS 不控制 OBS，不接 `obs-websocket`
- OBS 模式收到有效节目流后创建房间
- OBS 断流后结束房间并回到等待/空闲状态

已确认修复：

- WGC 高帧率默认卡在约 `56-57fps` 的问题已定位到 `GraphicsCaptureSession.MinUpdateInterval`。
- native 侧已在支持的系统上显式设置 `MinUpdateInterval(1ms)`。
- WGC session 已显式设置 `IsCursorCaptureEnabled(...)` 与 `IsBorderRequired(false)`。
- WGC 目标运行中 resize 时，FramePool 已按 `frame.ContentSize()` 触发 `Recreate(...)`。
- host preview 和下游 sender 已把 `wgc-frame-pool-recreated` 作为正常过渡处理。
- “开播时目标窗口已最小化”已走启动期 placeholder，窗口恢复后 soft refresh 切回真实流与音频。

当前限制：

- OBS ingest 只作为本机 backend，不是通用远程 SRT 网关。
- OBS 默认端口为 `61080`，可持久化自定义端口。
- WGC 黄框已有代码级关闭请求，但跨系统、跨机器、跨打包形态仍应继续观察。

### 5.2 Viewer

当前 viewer 主链路：

- native peer 收到编码视频后走 native decode。
- 画面输出到 native surface。
- 音频走 native 解码后播放。
- viewer 音量通过 native IPC 控制。
- viewer 播放只保留 `passthrough` 路线。
- 旧 `synced` / A/V sync worker 已退出主路径。
- 用户可调项保留手动音频延迟。

音频能力：

- 首选 `Opus`
- 兼容 `PCMU fallback`
- 支持 `AAC`

### 5.3 Relay

当前 relay 不再走 browser stream 转发。

真实实现：

- `v1` 作为上游 viewer 收到编码帧。
- `v1` 创建下游 relay peer。
- `attachPeerMediaSource` 绑定 `peer-video:<upstreamPeerId>`。
- native 直接把编码帧扇出给下游。
- relay 音频 track 按上游真实 codec 配置。

已完成能力：

- H.264 / H.265 decoder config 与 random access bootstrap 缓存。
- 新下游接入时先发 bootstrap，再进入 steady-state。
- relay fanout 已从 `main.cpp` 模块化到 `relay_dispatch`。
- triple native 端到端人工验证已通过。

拓扑约束：

- relay 按严格链式设计。
- 不做动态“尽量浅链”分配。
- 正常目标观众数以 3 人为主。
- 极限场景按不超过 5 人规划。

## 6. UI 和产品形态

当前页面形态：

- 首页是黑白分栏入口。
- host 子页：左侧控制区，右侧预览区。
- viewer 子页：左侧播放区，右侧控制区。
- topbar、首页转场、返回转场已重写过一轮。
- 质量设置弹窗已对齐当前项目风格。
- host 质量弹窗有 `原生推流 / OBS 推流` 两个选项卡。
- OBS 选项卡默认显示本地 SRT 地址。
- OBS 端口可通过“自定义推流地址”开关展开并持久化保存。
- host 开播前可选择“公开房间至大厅”。
- viewer 加入页支持 `大厅 / 直连` 两个选项卡。

需要注意：

- 旧 manual 中部分页面描述已过时。
- 当前 UI 事实应以 `server/public/app.js` 和对应 HTML/CSS 为准。

## 7. 质量设置

当前质量设置已经对齐 native 参数：

- host backend：`原生推流 / OBS 推流`
- 编码：`H.264 / H.265`
- 分辨率：`360p / 480p / 720p / 1080p / 2k / 4k`
- 帧率：`5 / 30 / 60 / 90`
- 码率：默认 `10000 kbps`，步长 `1000`
- 硬件加速编码：开关可用
- 本地预览：开关可用
- 硬件编码器：自动选择，或手动指定已通过自检的硬件编码器
- 编码器预设：`质量 / 均衡 / 速度`
- 调优：`fastdecode / zerolatency`

OBS 模式：

- 默认端口 `61080`
- 主按钮是 `复制并开始`
- 自定义端口可展开配置
- 确认后进入 `等待 OBS 推流...`
- 收到有效 OBS 节目流后才创建房间

## 8. 验证能力

### 8.1 自动化门禁

当前最低验证基线：

- `npm run check:logging`
- `node --check server/public/app.js`
- `node --check server/public/app-native-overrides.js`
- `node --check desktop/main.js`
- `node --check desktop/preload.js`
- `node --check server/server-core.js`
- `node --check server/index.js`
- `npm run test:server`
- `npm run verify:media-agent`
- `npm audit --omit=dev`

`npm run verify:media-agent` 覆盖：

- `build:media-agent`
- CTest 单元测试
- agent 进程级 smoke

media-agent 单元测试覆盖：

- `json_protocol` 基础转义与字段提取
- OBS ingest 端口解析与 SRT URL 构造
- host pipeline encoder selection、backend、preset、tune、关键帧策略归一化与 FFmpeg 参数映射
- `surface_target` 目标识别与 peer id 提取
- H.264/H.265 Annex-B access unit 基础解析、decoder config、random access、bootstrap 判断

agent smoke 覆盖：

- agent 进程启动
- `agent-ready`
- `ping`
- `getCapabilities`
- `getStatus`
- `getStats`
- `prepareObsIngest`
- `BAD_REQUEST`
- `NOT_IMPLEMENTED`

server 单元测试覆盖：

- host resume token 冒充失败
- host 合法 resume 成功
- roomId 碰撞规避
- 单连接消息频率限制

### 8.2 本地联调脚本

当前仓库具备：

- `npm run dev`
- `npm run dev:dual`
- `npm run dev:dual:native`
- `npm run dev:triple`
- `npm run dev:triple:native`
- `npm run e2e:media-agent`

用途：

- `dev:dual:native`：两个客户端实例 native 联调，启动时不预设 host/viewer。
- `dev:triple:native`：三个客户端实例 relay 联调，启动时不预设 host/viewer/relay。
- `e2e:media-agent`：先跑 media-agent 自动门禁，再输出人工端到端验收清单。

注意：

- `dev:dual:native` 和 `dev:triple:native` 会启动 Electron 窗口。
- dual/triple 脚本默认使用 `VDS_DEBUG_PRESET=quiet`，确保多个客户端调试状态一致；需要沿用 profile 历史状态时传 `-DebugPreset profile`。
- 它们不是全自动 UI harness。
- 三端真实端到端仍需要人工观察画面、音频、状态与退出清理。

### 8.3 最近已通过的链路

截至 `2026-04-26`：

- media-agent build / CTest / smoke 已通过。
- dual native 已通过。
- triple native 已通过。
- OBS ingest 已通过。
- OBS `prepareObsIngest` 已进入 agent smoke。
- `main.cpp` 进程级入口状态已通过完整门禁验证。
- 本轮未发布修复已通过 `npm run test:server`、`npm run verify:media-agent`、`npm run check:logging` 和 `npm audit --omit=dev`。
- Phase 1 P2P 状态机手测已通过：正常直连、Trickle ICE、TURN/relay candidate 阻止、15s failfast、媒体等待、快速重连、大厅自动刷新回归。
- Phase 2 P2P 诊断报告手测已通过：调试模式可见、默认 UI 隐藏、诊断内容刷新、一键复制可用。
- Phase 3 原生采集资源占用观测手测已通过：调试模式可见、默认 UI 隐藏、采集资源内容刷新、一键复制可用。
- Phase 4 服务端生命周期基础单测已通过：host grace resume、host grace 过期销毁、旧 token 失效、旧房间不可加入。
- Phase 4 服务端生命周期手测已通过：host/viewer grace resume、grace 过期清理、空房间清理、旧房间不可加入、服务端限制配置输出。
- Phase 5 发布流程强约束已通过：`npm run release:check` 已覆盖语法、server tests、logging check、media-agent verify、production audit 和发布产物一致性校验。
- Phase 6 NAT-PMP/PCP 兜底已通过：`npm run release:check` 已通过，代码路径脑内模拟已确认只在 ICE/failfast 后短时兜底并写入诊断。

## 9. 当前已完成项

以下内容已经真实存在，不再是计划：

- native authority 成为媒体主链路。
- native host preview 可用。
- native viewer surface 可用。
- popup overlay 被确定为正式打磨路线。
- fullscreen 覆盖任务栏已修。
- Windows fullscreen 已切到窗口化全屏。
- 调试日志前后端联动已收口。
- 质量设置与 native 参数贯通。
- `H.265` 已进入主链路并可在 UI 中选择。
- “原始分辨率”前后端都已下线。
- 音频主链路从 `PCMU` 升级为 `Opus`。
- `AAC` 已进入 transport / relay / viewer playback 主链路。
- relay 从 browser stream 转发切到 native encoded fanout。
- relay codec-aware bootstrap 已补。
- host backend 支持 `native / obs-ingest`。
- OBS 本地 SRT ingest 已接入正式 host 模式。
- OBS 推流地址默认端口 `61080`，支持持久化自定义端口。
- host 支持“公开房间至大厅”。
- viewer 支持公开房间大厅与直连。
- host 建房成功后自动复制房间号。
- WGC `MinUpdateInterval(1ms)`、cursor capture、border request 已接入。
- WGC frame-pool resize recreate 已接入。
- 开播即最小化窗口支持 placeholder 与恢复 soft refresh。
- viewer 旧 `synced` / A/V sync 路线已从主线移除。
- media-agent 完成模块化收尾。
- media-agent 自动化质量门禁已建立。
- media-agent dual/triple/OBS 端到端人工验收已通过。
- 日志与调试系统本轮整理已完成，详见 [docs/LOGGING_DEBUG_SYSTEM.md](/d:/project/videosharing/docs/LOGGING_DEBUG_SYSTEM.md)。
- 高频日志已接入分类、节流、采样或包装器。
- renderer、main process、server 可恢复错误已从默认裸日志降级或节流。
- 调试子菜单已整理为 `快速模式 / 问题范围 / 输出内容 / 深度诊断`。
- 双端/三端脚本默认统一调试状态，避免不同 profile 继承不同 localStorage 调试开关。
- `npm run check:logging` 已建立为日志出口防回退门禁。
- P2P 连接状态机与 Trickle ICE 收口已完成：host/viewer 标题下方展示固定 P2P 状态，TURN/relay candidate 被阻止，初始建连 failfast、媒体等待和快速重连路径已收口。
- 调试模式 P2P 诊断报告已完成：可复制 role、room、candidate counts、selected candidate pair、RTT、帧计数、NACK/PLI/keyframe/recovery、丢弃计数和 NAT-PMP/PCP 状态。
- 原生采集资源占用观测已完成：调试模式下可复制 capture/preview/encode FPS、读回耗时、编码器、分辨率、丢弃计数和音频采集状态。
- 服务端资源生命周期清理已完成：host grace resume、过期销毁、session token 失效、viewer 状态清理、限制配置输出和稳定错误码均已收口。
- 发布流程强约束已完成：`npm run release:check` 固定覆盖 syntax check、server tests、logging check、media-agent verify、production audit 和发布产物一致性校验。
- NAT-PMP/PCP 兜底复核已完成：仅在 ICE/failfast 后短时尝试，成功通过 Trickle ICE 注入映射候选，失败明确进入 pure P2P failed 并写入诊断。

## 10. 当前未完成项与风险

仍需要继续观察或推进的部分：

- 日志调试系统本轮已收口，后续只需要在真实双端/三端场景中微调采样间隔和白名单。
- 纯 P2P 状态机、诊断、采集观测、服务端生命周期、发布强约束和 NAT-PMP/PCP 兜底均已完成；后续只按真实用户反馈做小步修正。
- popup overlay 仍需围绕跟随稳定、全屏稳定、弹窗遮挡、点击前台继续打磨。
- WGC 黄框关闭请求已接入，但跨机器、跨系统、跨打包形态仍需验证。
- 差分更新成功率还需要持续实测。
- `H.265` 已进入主链路，但仍建议继续做长时间 soak、晚加入、断线重连验证。
- OBS ingest 已通过端到端验证，但仍建议继续覆盖端口占用、断流恢复、长时间 soak、H.264/H.265 双 codec。
- 三端联调目前仍主要依赖人工观察，缺少真正自动化 UI harness。
- viewer 如果后续要重新优化播放顺滑度，必须基于新方案设计，不能回滚旧 `synced` 路线。

## 11. 下一阶段顺序

暂无。

## 12. 明确禁止

禁止重新做这些事情：

- 恢复 renderer `<video>` authority 为主方案。
- 让前端和 native 并存两套媒体 authority。
- 遇到错误时静默 fallback 到旧链路。
- 为旧 browser relay 再补长期兼容层。
- 用抽象层掩盖当前还没稳定的真实问题。
- 回滚旧 `synced` / A/V sync 作为 viewer 播放问题的默认方案。

## 13. 给下一个 Agent 的交接说明

接手时先读：

- 本文档
- [docs/MEDIA_AGENT_MODULARIZATION.md](/d:/project/videosharing/docs/MEDIA_AGENT_MODULARIZATION.md)
- [docs/LOGGING_DEBUG_SYSTEM.md](/d:/project/videosharing/docs/LOGGING_DEBUG_SYSTEM.md)
- [server/public/app-native-overrides.js](/d:/project/videosharing/server/public/app-native-overrides.js)
- [desktop/main.js](/d:/project/videosharing/desktop/main.js)
- [media-agent/src/agent_rpc_router.cpp](/d:/project/videosharing/media-agent/src/agent_rpc_router.cpp)
- [media-agent/src/agent_runtime.h](/d:/project/videosharing/media-agent/src/agent_runtime.h)

不要再把 `media-agent/src/main.cpp` 当成媒体业务主入口。它现在只是 24 行左右的进程级入口。

处理问题时的原则：

- 本轮 Phase 1-6 已全部完成并归档到第 9 节；第 11 节暂无下一阶段计划，后续按线上反馈重新立项。
- 先跑 `npm run verify:media-agent`。
- 日志相关改动必须跑 `npm run check:logging`。
- 涉及真实窗口、音频、OBS、relay 时，再跑 `npm run e2e:media-agent` 并按清单手测。
- 连接问题优先补齐并查看 P2P 诊断报告；当前过渡期先看 `native-peer-stats` 的 `queuedVideo / queuedAudio / submittedVideo / dispatchedAudio / dropped* / receiverReason`。
- 采集资源问题只能把 stats 放在调试模式或 P2P/媒体诊断范围内，默认 UI 不展示。
- relay 问题先区分“没发出去”还是“发出去但下游起播/渲染追不上”。
- WGC 高帧率问题先确认 `GraphicsCaptureSession.MinUpdateInterval` 是否生效。
- 更新问题先区分“服务端产物不一致”和“客户端本地 installer 基底不匹配”。

构建发布全流程：

1. 发布前先确认工作区变更都已记录到 `## 2. 未发布改动记录`，并确认 `package.json` 版本号是目标版本。
2. 如需要升级版本，先同步更新 `package.json`、`package-lock.json`、本文档 `当前发布版本` 和相关 changelog 草稿。
3. 运行 `npm run release:check`。该命令会执行 syntax check、server tests、logging check、media-agent verify、production audit，并校验当前 `dist` 与 `server/updates` 里的 installer、blockmap、`latest.yml` 一致性。
4. 如果只是检查当前已有产物，`npm run release:check` 通过即可进入人工验收；如果需要重新出包，先运行 `npm run build:release`。
5. `npm run build:release` 会先执行 Electron 打包，再运行 `npm run prepare-server-release`，把当前版本 installer、blockmap 和 `latest.yml` 准备到 `server/updates`。
6. 出包后必须再次运行 `npm run release:check`，确认新产物的 version、path、sha512、size 与 installer 一致，且 `dist` 与 `server/updates` 当前 installer 元数据一致。
7. 做发布手测：安装当前 `dist/VDS-Setup-<version>.exe`，确认应用可启动；如涉及更新链路，确认客户端能读取 `server/updates/latest.yml` 并识别目标版本。
8. 发布前不要删除旧版本 blockmap；`prepare-server-release` 会按保留策略保留旧 blockmap，用于提高差分更新成功率。
9. 正式发布后，把 `## 2. 未发布改动记录` 中已发布条目迁移到 `CHANGELOG.md`，清空或重建未发布区域，并更新当前发布版本。
10. 最后再跑一次 `npm run release:check`，确保发布后的文档、门禁和产物仍处于一致状态。

GitHub 更新流程：

1. 发布前检查文档版本：`README.md`、`CHANGELOG.md`、`MEDIA_REFACTOR_PLAN.md` 和 `docs/` 不应残留上一版本的主介绍文案。
2. 确认本地门禁已通过：至少包括 `npm run build:release` 和发布后的 `npm run release:check`。
3. 检查工作区：`git status -sb`，确认本次发布需要的源码、文档、脚本改动都已纳入提交范围；不要提交 `dist/`、`runtime/`、`server/updates/` 等被 `.gitignore` 排除的产物目录。
4. 提交源码：`git add <本次发布相关文件>`，然后 `git commit -m "Release <version>"`。如发布后只修正文档，可用独立提交并把 tag 更新到该提交。
5. 创建或更新 tag：`git tag -a v<version> -m "Release <version>"`；如果需要让 tag 指向修正文档后的新提交，使用 `git tag -fa v<version> -m "Release <version>"`。
6. 推送源码和 tag：`git push origin master`，然后 `git push origin v<version>`；如果 tag 被修正过，使用 `git push --force origin v<version>`。
7. 创建 GitHub Release，tag 使用 `v<version>`，标题使用 `VDS <version>`，正文从 `CHANGELOG.md` 对应版本摘取。
8. 上传 release assets：`dist/VDS-Setup-<version>.exe`、`dist/VDS-Setup-<version>.exe.blockmap`、`dist/latest.yml`。
9. 发布后复核：确认 GitHub Release 不是 draft/prerelease，确认 assets 的文件名和 size 与本地一致，确认 GitHub README 显示当前版本。
10. 如果 `gh` 指向非官方 CLI 或未登录，可用 GitHub 网页创建 release；本机 Git credential helper 能推送代码不等于 `gh release` 可用。

任何后续改动都要坚持 fail-fast、边界单一、可验证，不要静默 fallback 到旧 authority。
