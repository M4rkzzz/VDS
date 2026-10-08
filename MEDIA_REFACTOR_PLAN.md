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

最近一次对齐日期：`2026-10-08`

两种播放器的轻量稳帧改造已落地，见 [播放稳帧改造与验收](docs/PLAYBACK_STABILITY_PLAN.md)。共享源 PTS、媒体代次、参考链背压、解码与呈现分离及输出音频时钟已接入。队列随源帧率、短突发和实际音频进度调整，合法长音频单元按实际时长消费，不增加固定帧率、分辨率、换源次数或运行时长限制。2026-10-07 的开发验证已通过统一 `npm run check`、原生 CTest 15/15、Web 行为回归 125/125、实际 1080p30/60 与零音量八阶段恢复，以及当时 1.7.1 本地产物的一致性与实际启动检查。

当前源码版本：`1.7.2`，已于 2026-10-08 发布至 [GitHub Release](https://github.com/M4rkzzz/VDS/releases/tag/v1.7.2) 与默认公网自动更新源。发布前后门禁、NSIS 构建、35 个源码/静态文件与原生 runtime 完整性、实际打包程序启动退出均通过；原生 CTest 15/15，生产依赖审计均为 0。安装包为 239,871,320 字节，SHA256 `62E5BBAEBED840A654CBA841060DEF9F395171FE321F996D6240F67BE78192CB`，GitHub 三份资产哈希一致。NAS 信令与 Web 服务已更新为 1.7.2，公网 HTTPS/WSS 和 1.7.1 至 1.7.2 的更新元数据识别均通过。Windows 构建仍未签名，跨运营商实机连通与长时间物理音画同步仍待验收。

## 2. 未发布改动记录

本区域先列当前未发布改动。已发布摘要记录在 `CHANGELOG.md`，下方保留实现详情与历史验证供维护追溯。

当前未发布改动：

- 暂无。下列改动已进入 1.7.2，发布摘要见 [CHANGELOG.md](CHANGELOG.md)。

### 1.7.2 已发布改动详情

- 连接与播放专项：修复旧 socket、取消/迟到 join 确认、surface 串行挂载与丢失恢复；服务端换上游先确认，浏览器刷新和失联后恢复媒体握手。
- 播放器专项：WebCodecs 探测/关闭/并发/失效恢复，有界待处理帧；原生音频 packet padding、空包忽略与 waveOut 在途背压。
- 播放架构整理：Web 新增 `EncodedMediaPlaybackSession`，集中帧重组、视频调度、音视频播放器和关闭清理；`main.ts` 保留房间、连接与编码接力，播放状态和错误不再覆盖连接/接力诊断。保留现有媒体协议和两种解码后端。
- 两端稳帧：原生增加独立解码和调度 worker，约 20 ms 序号缺口等待与关键帧恢复，窗口线程只画 GDI。压缩输入按源帧率、250 ms 突发窗口和实际音频领先量伸缩，原生另有 32 MiB 压缩内存预算和已到期 500 ms 陈旧数据清理；不裁掉正常聚包来满足固定帧数。Web 按真实 decodeQueueSize、待输出数和 B 帧重排量预留呈现位置，manifest 的 frameRate/fps 都用于源帧率估计。原生待呈现通常 2 帧，Web 通常 2 帧、B 帧时通常 3 帧；32 MiB BGRA 估算是软目标，4K 通常保留 1 帧，合法单幅大图仍可播放。预算不含解码器与当前显示资源。
- 媒体时钟与源切换：房主共享 64 位源 PTS，修正 OBS 时间基换算，旧 RTP 兼容入口单独处理回绕；v1 增加可选 sourceEpoch，接力每个媒体绑定生成新的短输出代次并在上游换代时更新，支持保留下游连接的 A → B → A 切源。退役代次保留到接收会话关闭，不设换源次数上限，旧代次不能借历史淘汰重新播放。WGC 使用捕获 QPC，其他 Annex B 与 WASAPI 入口仍含源采样时间估计。
- 输出与效率：有效 waveOut/Web Audio 输出位置驱动视频，无音频回退单调时钟，目标缓冲 20–60 ms。原生设备目标 60 ms、总积压目标 120 ms 加用户延迟，合法的不可拆长单元可临时扩大软件预算；8 kHz AAC 128 ms 单帧仍能正常播放，消费后恢复目标。已有音频 worker 从压缩块游标逐个取 AAC ADTS 单元或短 PCMU 段，500 ms 清理只针对已到期且设备输出未继续前进的数据。复用 swresample 转换非 48 kHz 双声道，不另加线程或变速系统。Web 按实际音频单元时长等待，AAC 用可信输入源 PTS 排程，兼容 Chrome 输出样本时钟连续但源 PTS 有间隙的情况。原生音频空闲事件等待，Web 诊断 JSON/DOM 最多刷新 4 Hz。
- Web 重连追赶与静音：仅在已配置、运行且同 codec 的较新源 PTS/序号到达时取消旧待提交音频尾部、重新锚定，正常 235 ms 聚包完整消费。已确认的 B 帧在等待呈现时暂停内部停滞工作计时，恢复提交后真正无输出仍恢复；未声明帧率时用实际帧间隔伸缩输入。用户零音量时视频回退单调时钟，恢复音量后接回当前音频位置，不重建上下文或音源。
- 实际关键帧恢复：严格校验真实 DataChannel keyframe-request、当前连接与 manifest 身份，并以 500 ms 合并节流。桌面把已接受的请求接到现有房主软刷新控制路径，首次 bootstrap 期间不反复刷新；OBS 等待外部编码器 IDR。刷新请求待处理 peer 集合跟随当前生命周期清理，不增加 peer 数量硬限。
- 纯 P2P 专项：原生端接收服务器 STUN 池，按可达性将首选服务排在最前，与最多四个服务一起从实际 ICE UDP socket 采样；有效样本符合稳定步长时线性预测，其他情况做有限邻域多端口检查，每个 peer 最多 16 个推测候选。自行实现端口算法及 libjuice/libdatachannel 补丁，不移植 UU 代码。transport 代次和 ICE ufrag 隔离旧候选与请求；修复 PCP 源地址、响应关联、多网卡网关与并发映射，保持禁止 TURN。
- 原生依赖可重复构建：固定 libjuice 1.7.0、libdatachannel 0.24.1 源包哈希，仓库保存增强 ICE 补丁；CMake 校验安装标记与补丁版本，构建和 runtime 使用配套 DLL。
- 实际本机媒体验证：最终增强 runtime 的合成 OBS SRT → native → Web 播放、刷新、Web 二跳和上游离线恢复通过；真实 H264/AAC/Opus 解码和打包应用的 NAT/IPv6/代次 IPC 验证通过。`npm run verify:playback` 与 `npm run verify:nat` 可重复执行；跨运营商连通与长时音画仍需两端验收。

- 小范围依赖更新：Electron 42.11.11、electron-builder 26.17.0、electron-updater 6.8.9、Vite 8.3.3；保留 TypeScript 6、Express 4、Koffi 2，替换废弃的 electron-rebuild 包。
- 修复媒体代理停启、跨活动 session owner 切换、过期 host start 和 OBS 断流清理；加入生命周期行为回归。
- 修复 Web 信令与 peer 的过期回调、取消加入、关键帧缓存跨会话残留，以及 Annex B 转 AVCC 的 NAL 边界。
- 修复服务端 WebSocket 错误隔离和退出后换房；管理后台按要求免管理令牌访问，保留房间会话身份隔离，增加统一 `npm run check` 与生产依赖检查。
- 恢复 Docker 信令和后台、FRP HTTPS/WSS 入口，并通过 DNS 验证取得证书、配置轻量自动续期；本轮桌面和 Web 改动已随 1.7.2 发布。

稳帧改造历史验证（2026-10-07，开发版本 1.7.1）：

- 当前原生 Release 与 CTest 15/15 通过，79.65 秒；调度 17591 项、音频 1420 项、源代次 8251 项及实际 DataChannel 关键帧控制 210 项断言通过，含新配置缓存更新回归。真实隐藏窗口 FFmpeg/GDI 覆盖 H.264 B 帧、独立配置加同序号 IDR、正常 60 fps 聚包、关闭重开及并发提交关闭。约 235 ms 同批 14 视频帧和 11 AAC 单元的专项中，280 视频帧全部解码、265 帧绘制、220 AAC 单元全部消费，压缩视频/音频预算丢弃与参考链重置为 0，峰值压缩输入 16 帧、待呈现 2 帧。原生 NAT 合约与 runtime 完整性检查通过；runtime SHA256 为 `94AF26910AEB58103B13B5991B6F858A9E39FF834706D930613CE0047382ABC1`。
- 最终源码的统一 `npm run check` 通过，含 Web 125/125 行为回归、3 个协议/帧/生命周期脚本与 TypeScript，视频 49 项、音频 45 项，桌面 88/88 回归。最终 Electron 42 真解码分别消费 H.264 3 帧、AAC 9 块、Opus 9 块、8 kHz AAC 6 块、带源 PTS 间隙 AAC 9 块，各项无丢弃，画布色彩断言通过；B 帧等待、重连音频追赶、零音量回退与合法音频软预算均有行为回归。
- 实际 SRT → native → Web 的 1080p30 B2、1080p60 B0 八阶段均通过，含同 peer 两次源重启及 Web 二跳恢复，使用同一原生 runtime。30 fps 测试持续 30.201 秒呈现 901 帧即 29.833 fps，消费 1409 AAC 即 46.654 单元/秒，视频和音频均无新增丢弃。60 fps 测试持续 30.146 秒呈现 1781 帧即 59.079 fps，消费 1394 AAC 即 46.242 单元/秒，音频无新增丢弃，视频新增 5 次迟到呈现丢弃。
- 30/60 fps 每秒采样的 ready 峰值分别为 3/2 帧，压缩待处理峰值 9/17 帧，decoderQueue 均为 0，BGRA 估算 25,067,520/16,711,680 字节；滚动 128 样本迟到 P95 的最大采样值为 13.035/14.518 ms，60 fps 记录最大迟到 42.866 ms。这些是采样峰值而非全过程峰值。两次源重启时，30 fps 分别丢弃 24/24 个、60 fps 分别丢弃 48/24 个旧积压 AAC 以恢复实时播放；稳态零音频丢弃不代表恢复阶段零丢弃。
- 用户零音量的实际 1080p30 B2 八阶段通过，持续 30.001 秒呈现 895 帧即 29.832 fps，消费 1397 AAC，期间视频和音频均无新增丢弃，audioClockValid=false，确认视频使用既有单调时钟回退。该场景不是全零源或物理输出音画验收。
- 新版 E2E 使用 60 fps offscreen、音频图音量 100% 与 webContents 静音；静音仍可能使用软件虚拟输出，不能证明物理听感或音画偏差。改造前的隐藏窗口即时绘制基线约 29.9/59.8 fps，环境不同，不用于宣称 CPU 或内存下降。GDI/Canvas 计数不能替代物理 Vsync；真实 50 ms 音画仍需实机验收。
- 2026-10-07 使用 `npm run build -- --publish never` 得到的历史 NSIS 产物为 `dist/VDS-Setup-1.7.1.exe`，239,871,520 字节，SHA256 `5B3255317DA7E000126FF944F403DFEE2A56AA70B1BEBD0744400DE9A6C26154`。35 个源码/静态资源与 ASAR 精确匹配；Agent/juice/datachannel 与 build/runtime/package 一致，latest.yml SHA512 与 blockmap 验证通过。实际打包 Electron 42.11.11 的 preload/native API、四 STUN 含 IPv6、transport 代次与关闭、14 项捕获枚举、音频平台和正常退出通过，无测试进程残留或诊断异常。该开发产物未运行安装向导、未签名、未公开发布，不能替代本次 1.7.2 安装包的验证。

此前连接复兴阶段历史验证（开发版本 1.7.1）：

- `npm run check`、桌面回归 75/75、Web 行为回归 17/17、Web 构建及 Docker context 检查通过；原生 Release 和 CTest 6/6 分两组执行通过，含 54 条 RPC 生命周期序列；`npm run verify:nat` 通过算法、实际 STUN 报文、真实 DataChannel、Manager 合约及 runtime 一致性。播放会话 7 项行为回归及最终 runtime 的六阶段实际 Web 播放通过。
- 本机严格虚拟 NAT 的 8 个场景通过：标准候选基线不能连通；四 STUN 预测、100 ms 分批 trickle、双方按远端地址端口分别映射及过滤的场景均建立真实 DataChannel，双向传输 4096 字节。成功场景步长 1，每侧实际检查 5 个推测端口。单 STUN 邻域和噪声分配场景做有限检查但未连通；预算外不扩张尝试，关闭后停止发包。真实跨运营商连接仍需两端验收。
- 稳帧改造前的增强 ICE 版本也已通过本地 Windows NSIS、源码/静态资源、原生 DLL 与安装包 manifest 一致性及实际打包应用冒烟。当时稳帧版本的产物与核验结果见上方历史记录，属于本地未签名、未公开发布的 1.7.1。
- 两套生产依赖 `npm audit --omit=dev` 均为 0；开发构建工具链仍有 8 个 moderate 告警，无 high/critical，未强制降级或覆盖传递依赖。
- 本机真实解码、短时持续合成 SRT、刷新与接力恢复已验证；发布前仍需跨运营商双端、实际采集、长时音画、手机浏览器和预览 stop/restart 验收。具体问题和未修改范围见 `docs/CODE_AUDIT_FINDINGS.md` 的 2026-10-07 记录。

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
- VDS_web 不能按 WebRTC media track 模型承担 native viewer 的 relay 节点职责。
- Web relay 正式方向改为 `DataChannel encoded frame relay`，与 Windows native 端统一到 `vds-media-encoded-v1` 协议。
- Windows 端默认使用 DataChannel encoded media：对端不支持、版本不兼容、codec 不支持、首帧/bootstrap 超时、DataChannel 未打开或协议握手失败时，都要 failfast，不允许长时间卡在“连接中/relay 检测中”，也不静默切回旧 media track 主链路。

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

- `npm run build:release` 已通过，并刷新 `dist/VDS-Setup-1.6.6.exe`、`dist/VDS-Setup-1.6.6.exe.blockmap`、`server/updates/latest.yml` 和 `server/updates/VDS-Setup-1.6.6.*`。
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
- 当前原生解码和 PTS 调度在 worker 中完成，窗口线程只绘制；有效 waveOut 输出时钟驱动视频，短缓冲按源帧率与输出进度调整。
- 浏览器 viewer 使用 `EncodedMediaPlaybackSession`、WebCodecs、单 rAF Canvas 与 Web Audio；纯编码接力独立于本地显示丢帧。

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
- 音视频沿 DataChannel 按上游真实 codec 转发编码内容；旧 RTP 兼容入口保留独立时钟换算。

已完成能力：

- H.264 / H.265 decoder config 与 random access bootstrap 缓存。
- 新下游接入时先发 bootstrap，再进入 steady-state。
- relay fanout 已从 `main.cpp` 拆到 `relay_backend_runtime` 与独立 bootstrap/timing 模块。
- triple native 端到端人工验证已通过。
- Web 编码接力、本机 SRT 至 Web 二跳与接力节点离线后恢复已有实际页面自动验收。

拓扑与容量：

- 服务端优先选择前一个已就绪观看者，失败或容量不足时查找其他可用观看者或房主；拓扑可以分支。
- 每个上游的容量与实际能力参与分配，leaf 观看者不承担 relay。
- 房间容量由既有服务端配置决定，当前默认每房间 16 位观看者；3/5 人是历史联调规模，不是当前程序的观众硬上限。
- 本轮播放器与刷新队列未新增 peer 总数限制，跨运营商成功率和多人带宽承载仍按实机样本验收。

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
- 合成 SRT、真实房间服务和实际 Web 页面已有自动端到端 harness；WGC 实际采集、三台设备、物理显示与听感仍需实机观察。
- viewer 轻量稳帧已通过本机实际 1080p30/60 和同 peer 换源恢复；下一步重点是实际采集、真实网络抖动、全零音频源及长时物理音画验收，不回滚旧 `synced` 路线。
- 纯 P2P 增强 ICE 已通过严格虚拟 NAT 与真实 DataChannel；实际移动宽带和联通宽带互通仍需两端样本。双方 UDP 无法通过或 NAT 任意随机分配时可能无法建立连接，不能据本机结果承诺与 UU 相同的成功率。

## 11. 下一阶段顺序

### Phase W1：DataChannel encoded media 协议定义

状态：已开始，已落地 Web 端初版协议骨架。

目标：

- 明确采用 `DataChannel encoded frame relay`，不再继续尝试标准 WebRTC media sender 注入式 relay。
- 定义协议名：`vds-media-encoded-v1`。已完成。
- 定义握手字段：`protocolVersion`、`role`、`supportedVideoCodecs`、`supportedAudioCodecs`、`maxFrameBytes`、`bootstrapRequired`。已完成；`clockRate` 后续按音视频分流补齐。
- 定义数据帧 envelope：`streamType`、`codec`、`timestampUs`、`sequence`、`keyframe`、`config`、`payload`。已接入；v1 可选 `sourceEpoch` 隔离 retained peer 下的媒体换源，保留旧帧兼容。
- 定义控制消息：`hello`、`hello-ack`、`keyframe-request`、`bootstrap`、`stats`、`error`、`close`。握手及错误通路已接入，`keyframe-request` 已贯通真实 DataChannel 接收、relay 传递和当前房主软刷新；配置与 IDR 的媒体 bootstrap 由现有帧协议承载。
- 禁止把 DataChannel bytes 静默转换成 canvas/WebCodecs 重编码 relay 作为“成功”。

### Phase W2：Windows native 自动检测与 failfast 适配

状态：基础实现已落地，已完成信令能力透传、renderer 默认启用、native peer transport 主动创建/接受 DataChannel、DataChannel encoded frame 入站解码入口、native host/OBS/relay DataChannel 出站 fanout；Win-Win 端到端已实测有画面有声音，后续继续补 Web 音频和三端 soak。

目标：

- Win native 默认使用 `vds-media-encoded-v1` DataChannel encoded media，不再把 `rtc::Track` media path 作为默认主链路。
- 对端明确不支持 `vds-media-encoded-v1` 时 failfast；当前已能主动创建或接受 `vds-media-encoded-v1` DataChannel。
- 自动检测对端协议版本、codec、最大帧尺寸、bootstrap 能力。当前 server 已透传能力，Win renderer 已能识别协议版本。
- 失败原因必须可区分：`datachannel-protocol-unsupported`、`datachannel-version-mismatch`、`datachannel-codec-unsupported`、`datachannel-open-timeout`、`datachannel-bootstrap-timeout`、`datachannel-frame-invalid`。
- 检测失败必须 failfast，不能长期显示“连接中/relay 检测中”。当前已覆盖 DataChannel open/ack timeout、`datachannel-version-mismatch`、`datachannel-frame-invalid*`、发送失败和连接失败路径。
- 诊断报告显示 encoded DataChannel 状态和计数。当前 native stats 已暴露 `encodedMediaDataChannel*` 字段。
- DataChannel encoded frame ingest 已接入现有 native video/audio receiver 入口；native host/OBS/relay fanout 已可把上游 encoded frame 通过 DataChannel 发给下游。下一步重点验证 Web/Web 和 Win/Web/Win 三端组合里的 bootstrap、音频播放和长时间稳定性。

### Phase W3：VDS_web DataChannel relay harness

状态：基础实现已落地，Web viewer 可接收上游 encoded frame 统计，并在下游 DataChannel ready 后按 `vds-media-encoded-v1` envelope 转发；Web 作为 DataChannel 下游已增加 H.264 WebCodecs canvas 播放验证路径；Web->Web relay 已增加 DataChannel 大帧分片、重组和最近关键帧 bootstrap。

目标：

- VDS_web viewer 收到上游 encoded frames 后，通过 `vds-media-encoded-v1` DataChannel 转发给下游。
- Web 端只负责 encoded frame relay，不承诺作为标准 WebRTC media sender relay。
- 下游如果是 Web，先以 WebCodecs H.264 canvas 播放器和诊断 harness 验证；下游如果是 Win native，走新增 native DataChannel ingest。
- relay 成功标准：`encodedFramesReceived > 0`、`dataChannelFramesForwarded > 0`、`reencodePathUsed = false`。
- relay 失败必须给出明确协议失败原因。

### Phase W4：解码与播放边界

当前实现与验收边界：

- Web 使用 WebCodecs 视频与音频解码、Canvas 呈现和已有 Web Audio 输出；支持矩阵按设备实际探测的 `H.264/H.265 + Opus/AAC` 和 payload format 决定，不默认宣称全部支持。
- Win native 继续支持 `H.264/H.265 + Opus/AAC/PCMU`，解码与显示保持原生 authority。
- `EncodedMediaPlaybackSession` 持有帧重组、媒体代次、短重排、两个播放器和关闭清理；房间、连接恢复与原编码内容接力独立于本地呈现。
- 视频按源 PTS 和有效音频输出时钟呈现；无音频时回退单调时钟。不增加第二套播放体系、AudioWorklet 或重编码接力。
- 自动化已覆盖真实 H.264/AAC/Opus、合法长音频单元及生命周期恢复；H.265、手机、真实采集和长期可见可听的音画精度仍按实机验收。

### Phase W5：回归与发布门禁

目标：

- 增加协议单测：握手成功、版本不兼容、codec 不支持、首帧超时、非法帧拒绝。
- 当前已增加 `npm run test:vds-web`，覆盖 DataChannel frame envelope encode/decode、非法 frame 拒绝，以及 WebCodecs H.264 canvas 播放关键路径。
- 增加 server 信令测试：Web viewer capability 宣告不破坏旧 Windows 客户端。
- 增加 dual:web 手测清单：Win host + Web viewer、Web relay unsupported、DataChannel 协议 failfast。
- 发布前继续跑 `npm run release:check`，并补充 DataChannel 协议专项验证。

## 12. 明确禁止

禁止重新做这些事情：

- 恢复 renderer `<video>` authority 为主方案。
- 让前端和 native 并存两套媒体 authority。
- 遇到错误时静默 fallback 到旧链路。
- 为旧 browser relay 再补长期兼容层。
- 用抽象层掩盖当前还没稳定的真实问题。
- 回滚旧 `synced` / A/V sync 作为 viewer 播放问题的默认方案。
- 增加固定帧率、分辨率、换源次数、peer 总数或运行时长上限来规避正常输入；容量与停滞判断必须结合源时长、实际输出进度和参考链状态。
- 接入 TURN 或服务器媒体中继；端口预测与多端口检查继续在实际 ICE socket 和既有纯 P2P 通路内完成。

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

- 本轮 Phase 1-6 已全部完成并归档到第 9 节；新的第 11 节已改为 VDS_web DataChannel encoded media 后续计划。
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
3. 运行 `npm run release:check`。该命令会执行 syntax check、VDS_web TypeScript check、VDS_web build、server tests、logging check、media-agent verify、production audit，并校验当前 `dist` 与 `server/updates` 里的 installer、blockmap、`latest.yml` 一致性。
4. 如果只是检查当前已有产物，`npm run release:check` 通过即可进入人工验收；如果需要重新出包并发布 GitHub Release，先确认 `gh auth status` 通过，再运行 `npm run build:release`。
5. `npm run build:release` 会先构建 VDS_web 静态产物，再执行 Electron 打包，运行 `npm run prepare-server-release` 把当前版本 installer、blockmap 和 `latest.yml` 准备到 `server/updates`，随后执行 `npm run release:check` 和 `npm run release:github`。
6. `npm run release:github` 会使用 tag `v<version>`、标题 `VDS <version>`、`CHANGELOG.md` 对应版本内容创建 GitHub Release，并上传 `dist/VDS-Setup-<version>.exe`、`dist/VDS-Setup-<version>.exe.blockmap`、`dist/latest.yml`。
7. 做发布手测：安装当前 `dist/VDS-Setup-<version>.exe`，确认应用可启动；如涉及更新链路，确认客户端能读取 `server/updates/latest.yml` 并识别目标版本。
8. 发布前不要删除旧版本 blockmap；`prepare-server-release` 会按保留策略保留旧 blockmap，用于提高差分更新成功率。
9. 正式发布后，把 `## 2. 未发布改动记录` 中已发布条目迁移到 `CHANGELOG.md`，清空或重建未发布区域，并更新当前发布版本。
10. 最后再跑一次 `npm run release:check`，确保发布后的文档、门禁和产物仍处于一致状态。

GitHub 更新流程：

1. 发布前检查文档版本：`README.md`、`CHANGELOG.md`、`MEDIA_REFACTOR_PLAN.md` 和 `docs/` 不应残留上一版本的主介绍文案。
2. 确认本地门禁已通过：至少包括 `npm run release:check`；完整发布现在由 `npm run build:release` 自动串联 GitHub Release。
3. 检查工作区：`git status -sb`，确认本次发布需要的源码、文档、脚本改动都已纳入提交范围；不要提交 `dist/`、`runtime/`、`server/updates/` 等被 `.gitignore` 排除的产物目录。
4. 提交源码：`git add <本次发布相关文件>`，然后 `git commit -m "Release <version>"`。如发布后只修正文档，可用独立提交并把 tag 更新到该提交。
5. 推送源码：`git push origin master`。
6. 运行 `npm run build:release`。该命令会在 GitHub 发布阶段创建缺失的 `v<version>` tag、推送 tag、创建 Release，并上传 assets。
7. 如果 Release 已存在，默认失败；确认需要覆盖时设置 `GITHUB_RELEASE_REPLACE=1` 后重新运行 `npm run release:github`。
8. 如果必须在未提交工作区发布，设置 `ALLOW_DIRTY_GITHUB_RELEASE=1`；常规正式发布不要使用该开关。
9. 发布后复核：确认 GitHub Release 不是 draft/prerelease，确认 assets 的文件名和 size 与本地一致，确认 GitHub README 显示当前版本。
10. 如果 `gh` 指向非官方 CLI 或未登录，可用 GitHub 网页创建 release；本机 Git credential helper 能推送代码不等于 `gh release` 可用。

任何后续改动都要坚持 fail-fast、边界单一、可验证，不要静默 fallback 到旧 authority。
