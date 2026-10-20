# 媒体模块复审与升级建议

审阅日期：2026-10-19。对象是当前工作区（HEAD `380eca6` 加未提交改动），不是仅审阅该提交。覆盖 WGC/预览、逐 peer 编码、媒体 DataChannel、原生播放与音频、WebCodecs。此次未修改产品源码、未发布；新增隔离复现和本报告。UU 对照使用本地已提取的反编译证据，没有新增 UU 运行测试或宣称取得完整源码。

## 结论

当前优先级应放在发送端恢复和重复采集编码。原生观看端已有 D3D11VA → VideoProcessor → SwapChain、交换链就绪等待、呈现失败回退及重试、解码上下文恢复；不能继续用“只有 GDI”描述它。单独的房主本地预览仍走 WGC CPU 回读和 GDI。两者要区分。

### P1：失效编码器可能被当作仍在等待首帧

`peer_video_sender_state.h:74` 的关键帧处理函数仅检查 pending bootstrap，就返回 `host-encoder-awaiting-bootstrap`，没有检查发送器是否已经停止。`peer_video_sender.cpp:823` 的管道结束只设置 running=false；`:880` 的进程退出检查也没有发起恢复。`peer_session_controller.cpp:94` 只在 soft_refresh_requested=true 时重建。

触发条件：编码器在首个完整 IDR 发出前退出，或发送失败置 pending bootstrap 后编码器退出。源和连接可能仍存在，但后续关键帧请求继续等待一个已停止的生产者。正常运行且已经完成 bootstrap 的发送器仍可通过关键帧请求进入现有重启路径，不应把缺陷扩大成“所有编码器退出都永远不能恢复”。

隔离程序直接调用当前生产头文件中的处理函数，得到：

```
warming=host-encoder-awaiting-bootstrap
dead=host-encoder-awaiting-bootstrap refresh=0
```

这是实际处理函数的状态复现，未终止真实 FFmpeg 或模拟真实显卡崩溃。修复应区分 starting/running/recovering/failed，只有活着且正常推进的生产者才能抑制重复重启。进程退出、管道失败交给同一个恢复负责人；保留连接和主机时钟，重新建立编码引用链。关键帧请求不应成为失效进程唯一的唤醒来源。验收要包含首个 IDR 前崩溃、已播放后崩溃、恢复期间停止，以及恢复失败后的错误可见性。

### P2：DataChannel 活动状态被 RTP 条件覆盖

`peer_refresh_pipeline.cpp:36` 已按 DataChannel/RTP 分支计算 active，随后调用 `refresh_peer_media_binding`；后者在 `peer_video_sender.cpp:907` 又强制要求 video_track_open。纯编码 DataChannel 路径无需打开 RTP video track。因此 active 可以在实际持续发送时变成 false。无 runtime 的 relay 分支 `:863` 也有同类条件。

这是代码路径确认的状态缺陷，本次未证明它直接造成 UI 卡死或断流。应统一使用媒体就绪判断，并分别保留 transport ready、producer running、recent frame 三类状态。用 DataChannel-only、RTP-only 和 relay 三种路径验证，不能靠“有画面”代替状态断言。

## 值得升级的部分

| 顺序 | 当前证据 | 建议与验收 |
| --- | --- | --- |
| 1：共享同源采集编码 | 非 OBS 路径 `peer_host_source_binding.cpp:301` 对每个 peer 调用 sender；`peer_video_sender.cpp:287` 启动独立 FFmpeg，并创建自己的 WGC 源 | 按源身份、源代次和完整编码配置建立生产者，观看者只订阅不可变 AU。复用现有 frame bus/relay 分发思路，逐订阅者保留背压和 bootstrap 状态。1→多观看者时编码器数量应只随配置组变化；慢观看者不能阻塞其他人，晚加入要拿到新 IDR，单人离开不能停止共享源。不能声称所有成本降为一份，网络发送仍随观看者增长。 |
| 2：主机预览复用和资源池 | `native_live_preview.cpp:934` 单独创建 WGC；`:1496/1500` 每次 paint 建 DC/Bitmap；`:1514` 复制整帧，`:1577` 另一次复制到缓冲 | 小步先缓存 GDI 资源、交换帧引用；共享采集层完成后订阅同源帧。预览慢绘制不能拖住编码，预览关闭不能影响分享。GPU 纹理预览可作为后续路径。 |
| 3：异步回读，再推进同 GPU 编码 | `wgc_capture.cpp:716/721` CopyResource 后立即阻塞 Map；`host_pipeline.cpp:288` 用 CPU BGRA rawvideo 管道输入，随后普通 scale/pad | 先做 staging 槽复用与非阻塞就绪检查，明确帧槽所有权、时间戳、尺寸变化和停止语义。再验证同 GPU NV12/硬件帧进入编码器；不要把“启用 AMF/NVENC/QSV”当成已经零回读。1080p60 的 BGRA 原始像素负载约 498 MB/s/路，这是尺寸算术，不是实测内存带宽或性能收益。 |
| 4：编码器原生关键帧控制 | `peer_video_sender_state.h:75` 设置 soft refresh；控制器走强制重新绑定 sender，重新启动编码进程 | 在编码接口支持时直接请求新 IDR；聚合共享源上的并发请求，保留可靠的周期 IDR 和异常重建。进程管道暂不具备原生控制时，不宜把不存在的 stdin 控制协议当成方案。 |
| 5：弱网按媒体时效处理 | Native `peer_transport.cpp:688` 和 Web `main.ts:594` 仅设置 unordered，没有部分可靠参数。已有 bufferedAmount 背压和音频预留；`SendAdmission::sent` 统计的是入队字节速率，不能视为实际可用网络带宽 | 实验区分控制/配置、关键帧和可过期视频，结合帧依赖、反馈和新 IDR 恢复。不同 channel 仍可能共享同一 SCTP 拥塞窗口。不能直接全改不可靠传输，也不能认定现有背压可以撤回已经提交的旧数据。验收突发丢包、带宽骤降再恢复、音频连续性、旧帧年龄和恢复首帧。 |
| 后续：音频输出与跨显卡/HDR | 原生音频仍是 waveOut (`viewer_audio_playback.cpp:351/395/506`)；D3D 直呈只接收所支持的 SDR NV12 路径 (`native_d3d11_presenter.cpp:201`) | 可实验 WASAPI 事件驱动输出与设备时钟；先用长时漂移、设备切换和实际延迟对照证明收益，再考虑替换。跨适配器、HDR/10-bit、Web AudioWorklet 应独立立项，当前证据不足以把它们列为马上必须重写的缺陷。 |

异步 Map 的公开机制可返回“GPU 尚未完成”，需要调度下一次处理，不能把失败结果当成有效像素；详见[微软 D3D11_MAP_FLAG](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_map_flag)。staging 轮转可能增加排队时间，因此验收同时测 Map 阻塞和端到端帧龄，不能只测吞吐。

unordered 与有限重传/生命周期是独立配置，见 [W3C RTCDataChannelInit](https://www.w3.org/TR/webrtc/#dom-rtcdatachannelinit)。WASAPI/IAudioClient3 提供可查询的共享模式引擎周期，但设备支持和实际收益需验证，见[微软低延迟音频](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/low-latency-audio)。这些方向均不要求 TURN，也不增加用户帧率、分辨率或运行时长配额。

## UU/GameViewer 可以借鉴什么

本次复核的原始静态证据：

- `0x180b34ab0`：帧队列校验、取得 capture slot、无新处理时复用已有帧并更新时间；`0x180b32ad0`：硬件帧队列交付、无效预处理结果传播。适合借鉴明确的帧槽所有权、采集与编码解耦。证据：[预处理](../REA/evidence/rea/vds-deep-dive/preprocess-reuse.txt)、[交付](../REA/evidence/rea/vds-deep-dive/frame-queue-delivery.txt)。不能由此断言 UU 跨所有观看者只编码一次。
- `0x180b12cc0`：输入纹理不兼容时丢弃 renderer 的 allocator 引用，按共享纹理/适配器信息选择资源。适合借鉴按设备身份管理资源的方式。证据：[设备选择](../REA/evidence/rea/vds-deep-dive/device-selection.txt)。不把释放逻辑当作完整恢复成功证明。
- `0x180b181d0`：等待交换链就绪。VDS 当前已经获取等待句柄并集成到窗口调度，此项应保留而非重复重写。证据：[等待函数](../REA/evidence/rea/vds-deep-dive/present-wait.txt)、`native_d3d11_presenter.cpp:122`、`native_video_surface.cpp:933`。

UU 的收益不能从字符串、函数名或固定参数推算。共享生产者是针对 VDS 当前结构的建议；媒体部分可靠/FEC 的具体参数没有足够 UU 实测证据，不直接照抄。

## 本次验证与边界

- 五项现有 CTest 通过：视频 AU、原生播放调度、relay 时序、host clock、source timing。通过的是现有测试覆盖，不是以上发现已修复。
- bootstrap liveness 隔离复现已编译执行，证明生产处理函数无法区分这两个状态；没有把“成功复现 bug”的退出码算作功能验收。
- 未修改产品代码；未重复真实采集播放 e2e、弱网长时测试、跨显卡或音频设备切换。本轮性能收益均为结构判断，没有报估算百分比。
- 测试源码、日志和关键文件指纹见 [复审证据](../REA/evidence/vds-media-review-2026-10-19/summary.json)。

建议分两批：先修编码器死亡恢复与 active 状态，再落地同源共享采集编码及预览复用；GPU 编码输入和媒体过期策略分别用独立对照推进。


## 2026-10-19 修复落地与烟测

以下为前述审阅之后的实现，前文“未修改产品代码”是审阅阶段记录。

- 编码器 EOF、写入失败会标记失败并发出一次恢复事件，桌面控制线程合并后重建。首个 IDR 前死亡不会再误报为正常 warmup。失败重建保留恢复状态并退避重试，不设置次数上限；停止或过期代次不唤醒旧会话。
- 同一源 epoch、采集目标、完整 FFmpeg 编码命令共用 WGC 和编码进程。每个观看者保留独立的传输、bootstrap、错误和发送计数。共享时单人关键帧请求等待下一周期 IDR，不重启其他人的编码。最后一个订阅者离开才停止生产者；异常重建保留原传输、媒体 epoch 和最终序列号。
- active 按 DataChannel / RTP 实际路径和生产者存活判断。统计新增 attached、active、producerId、producerProcessId、producerSubscribers、recoveryPending，便于实际核对。
- 同目标且采集帧率满足预览配置时，预览复用最新不可变 CPU 帧，采集缓冲按引用生命周期复用，绘制不再复制整帧。共享源消失或不再提供新鲜帧时回到独立 WGC；预览关闭不停止发送。尚未替换 GDI，也未做不同编码配置之间的采集共享。
- 双观看者退出测试发现信令 rebalance 会强制重连仍健康的同一上游。现改为保留连接、只同步 chainPosition，Web 和桌面消费 preserveMedia 通知；Web 保留 session 对象身份，不废弃现有事件处理器。

验收：Release 原生构建、Web 构建、架构和 TypeScript 检查通过；9 项针对性 C++ 测试、27 项 JS 回归、server-core 和 16 个 server-reconnect 场景通过。WGC 生命周期测试在沙箱内创建 frame pool 失败，正常桌面权限重跑通过，两份日志均保留。

真实 WGC → AMF H264 → 两个直连 WebCodecs 观看者共用同一 producerId / FFmpeg PID。强制终止测试所属编码器后，两者自动恢复，transportGeneration 与 sourceEpoch 不变；恢复等待期间没有用测试 getStats 轮询替代生产事件唤醒。单人退出保持生产者；最后一人退出后预览回退；重新加入后预览再次复用。真实 Electron 原生观看端两轮退出重入帧数为 37→322、16→325，走 GPU 呈现、CPU readback 为 0，退出无残留测试进程。这里的零回读仅指播放呈现，采集编码仍经过 CPU BGRA。

保持纯 P2P，没有新增帧率、分辨率、码率、观看人数或时长配额。恢复退避只避免故障时重复创建进程，不节流正常媒体。网络打包和发送仍随观看者增长，不宣称全链路零拷贝或固定性能提升。烟测为本机短时场景，未替代跨运营商、长时弱网、窗口尺寸变化、跨 GPU/HDR 和进程音频验证；Web 阶段有少量 presentation-superseded 丢帧，没有宣称零丢帧。

二进制已同步至 `runtime/media-agent/vds-media-agent.exe`，SHA256 为 `def2742d98d8221a744afc6bd6709d4cfa64475464c3253cfbe9c762f24ad373`。本轮未推送、发布安装包或部署远端信令服务。

共享烟测复现：设置 `VDS_PLAYBACK_E2E_SHARED_PRODUCER=1`，运行 `node scripts/test-local-playback-e2e.js --wgc`。证据、脚本和文件指纹见 [验收记录](../REA/evidence/vds-media-producer-2026-10-19/summary.json)。


## 1.7.11 发布与部署验收

- GitHub 发布标签 `v1.7.11` 对应 `d75851e`；四份资产大小和 GitHub SHA256 与本地正式构建一致。安装包为 235,451,209 字节，SHA256 `51af958bf6651dbe4c9bb644ded8bb6dd27d1ff472646e097ca3d0ddd626f0c9`。
- 全部发布检查项完成：Web 164/164、桌面 342/342、服务静态 7/7、原生 54/54，server-core/revival/reconnect、架构、类型、日志、原生 RPC、包内指纹和打包后门禁通过；生产依赖审计 0 漏洞。
- 发布前门禁首次因 UPnP 夹具随机选中 Windows 保留端口而失败，复现为 `EACCES`，已让模拟路由器正确返回端口冲突；150 次实际请求中 6 次冲突恢复。随后原生预览持续帧断言在静态桌面失败，加入 16×16 测试专属动态源后，原断言不变，八轮预览创建及持续增长通过。两类初次失败日志均保留；修正后逐项补完门禁，没有跳过失败项。
- 最终打包程序验证：三轮开播、预览、调试按钮、停止重开，实际帧数 20/21/19；两轮观看与离开重入持续增长到 341/346 帧。明确断言 renderer 来自 app.asar、agent 来自包内 resources；播放走 D3D11，CPU readback 为 0，正常退出无测试进程残留。隐藏 UI 夹具以定时器驱动布局 tick，原生采集/编码/呈现时钟未改；不据此宣称可见窗口视觉动画已验收。
- NAS 信令/Web 从 1.7.7 升至 1.7.11，先完成候选镜像和 16 个重连场景，再在无活跃房间时切换，保留私有回滚备份。公网严格 TLS 的建房、加入、过期恢复、私房隐藏和退出清理通过。
- 默认 HTTPS 源使用真实 NsisUpdater 从正式 1.7.10 基线下载 1.7.11：10 次 206 Range，安装包差异 2,276,839 字节，blockmap 476,787 字节，共 2,753,626 字节，比全包少约 98.83%；禁止全包回退，重组完整包签名/哈希验证成功。另核对清单签名、头尾 Range、Web 两份资产及 gzip/immutable、新版后续差分基线。未运行安装程序，不修改用户已安装客户端。

原始发布证据位于本地 `tmp/release-1.7.11-*`、`tmp/public-differential-1.7.11-result.json`。仍保持纯 P2P，无新增运行配额；这些结果不替代跨运营商实机成功率或长时间弱网验收。

## 1.7.11 多观看端长时间烟测

2026-10-19 使用正式包 `dist/win-unpacked/resources/runtime/media-agent/vds-media-agent.exe`，SHA256 与上述发布版本一致。宿主控制模块与 app.asar 内文件逐字节一致，本地 Web 资源与 1.7.11 部署清单一致。宿主使用真实 WGC / AMF H264，四个独立 WebCodecs 页面直连，选择的 ICE 候选对均非 relay；本机信令服务器不转发媒体。

- 配置 1920×1080、30 fps；稳定观察窗口累计 30 分钟，加入故障恢复和切换后，四端阶段实际为 **31 分 13 秒**。186 份周期样本记录解码、实际呈现、预览、生产者 PID、私有内存与句柄。
- **6/6 次编码器强制终止后自动恢复**。恢复等待期间不调用测试侧 `getStats`，由生产 `HostVideoRefreshWakeup` 唤醒重建；四端均新增至少 90 帧才算恢复，transportGeneration 与 sourceEpoch 不变。观测耗时 4.076–4.174 秒，包含额外约 3 秒帧增长确认，不能当作黑屏时长。
- **6/6 次预览关闭重开、6/6 次单观看端离开重入**保持共享生产者身份。**3/3 次全员离开重入**验证旧编码器退出、预览回退独立 WGC 并新增至少 5 帧、重新加入后恢复共享。四端持续共用一个采集编码生产者。
- 稳定的约 10 秒采样窗口中，实际呈现为 **26.65–30.24 fps**；大于 30 的短窗值含诊断采样边界误差。没有静帧、意外断流或低于源帧率 80% 的稳定采样窗口；有正常的过期呈现帧丢弃，不宣称零丢帧。
- 原生引擎私有内存 **137.7–174.9 MiB**，首尾为 164.0 / 145.8 MiB；句柄 **1180–1242**，首尾为 1242 / 1196，未观察到持续累积。编码器私有内存为 155.3–170.7 MiB。通过记录的 PID 额外核验末次生产者和原生引擎均已退出。
- 整体脚本退出码 0；最终报告 `ok=true`，warnings、consoleErrors 均为空。四端长测之后的原有两端死亡恢复、单端保留播放和预览回退检查也通过。

本轮未复现需要修改生产代码的问题。新增可重复的长测夹具，补强实际呈现推进和最终进程退出断言，以及失败时保留证据。没有改变运行配额、媒体策略或纯 P2P 路线。帧率阈值和超时仅为测试断言，不进入产品运行逻辑。

本轮边界：同一台机器上的四个 Web 观看页面与包内原生宿主；不是四台跨运营商电脑，也没有重跑原生观看窗口长测、进程音频、弱网或跨 GPU 场景。预览验证采集帧推进和复用状态，未据此宣称可见窗口交互完成长测。测试使用 16×16 自有动态窗口提供确定的桌面变化，不保存采集图像。

复现命令（PowerShell）：

```powershell
$env:VDS_MEDIA_AGENT_PATH = "$PWD/dist/win-unpacked/resources/runtime/media-agent/vds-media-agent.exe"
$env:VDS_PLAYBACK_E2E_SHARED_PRODUCER = '1'
$env:VDS_PLAYBACK_E2E_SOAK_MS = '1800000'
$env:VDS_PLAYBACK_E2E_WIDTH = '1920'
$env:VDS_PLAYBACK_E2E_HEIGHT = '1080'
$env:VDS_PLAYBACK_E2E_FPS = '30'
node scripts/test-local-playback-e2e.js --wgc
```

本地原始证据：`tmp/soak-1.7.11-artifact-verification.json`、`tmp/soak-1.7.11-30min-result.json`、`tmp/soak-1.7.11-30min-summary.json`、`tmp/soak-1.7.11-30min-final-cleanup.json`、`tmp/soak-1.7.11-30min.log`。首次短测证据保存在 `tmp/soak-1.7.11-calibration-result.json`。

补强断言后另以相同 1080p / 30 fps 配置运行完整六轮短回归，退出码 0、21 项恢复与切换事件通过，实际呈现增长及最终编码器、原生引擎退出检查通过；无 warnings / consoleErrors。证据为 `tmp/soak-1.7.11-final-regression-result.json`。两次脚本语法检查和 `git diff --check` 通过。长测原始数据不因补强断言而重写，呈现速率结论由长测保留的周期样本独立核算。

## 2026-10-20：观看窗口移动、Web 音频与刷新恢复

用户确认移动的是观看端 VDS 窗口；另外反馈网页有声时卡顿、刷新后停在等待上游。本轮没有增加依赖、限帧或运行配额，保持纯 P2P。

- **窗口移动**：原生布局 RPC 跨线程直接移动正处于 BeginPaint/Present 的窗口。改为交给窗口线程，合并尚未处理的布局；移动不再复制旧位置的客户区像素，父窗口排除 D3D 子窗口绘制区域，静帧在位置变化后重新呈现。新增忙绘制线程回归，HEAD 旧实现确定性失败于 `RPC layout must not block on a busy native painting thread`，修复后通过。独立 `--window-motion` 模式检查可见测试窗口四向移动后的屏幕像素及 D3D 子窗口原点，GDI/D3D11 均通过。旧实现可见移动曾出现一次黑像素失败，之后未稳定复现，不能据此宣称所有显卡上的确定性复现。
- **Web 音频**：自适应缓冲变化直接平移已建立的播放时间线，增长时插入静音，下降时裁掉采样。500 个连续 Opus 块、110ms 用户延迟、18ms 周期抖动回归中，旧实现额外产生 40ms 静音，新实现为 0。现在保持已排定的连续时间线，新的目标用于启动和断粮恢复。原有超时、解码恢复、AAC 批量输入测试通过。
- **刷新恢复**：服务器向房主发送重连标志，却在向观看转发端发送 `connect-to-next` 时丢失它；原生转发端复用刷新前的旧连接，未发送新 offer。已贯通重连标志并替换旧 transport，普通重复通知仍复用当前协商。新增真实 WebSocket 转发拓扑刷新和实际 renderer 控制器回归。

验证：

- `npm run check` 全通过：Web 165/165、桌面 343/343、服务静态 7/7，以及协议、生命周期、架构、类型、server-core/revival/reconnect。
- Release 原生引擎和播放集成重新编译，通过 B 帧、配置分离、尺寸变化、GPU/GDI 切换、解码器死亡恢复、1080p60 音视频批量输入、可见四向移动测试。
- 真实 OBS SRT → native DataChannel → WebCodecs/WebAudio：直连网页刷新、转发下游网页刷新、源重启两次、转发上游退出后重新分配均恢复新帧。20 秒稳定段视频 14.88/15fps、音频 46.52/46.875 块/秒，零音频丢弃，886 个 WebAudio 调度块间没有空隙。源重启有清理旧音频和等待关键帧的丢弃，不称全流程零丢帧。
- 最终布局合并构建再跑完整媒体烟测，通过新增连续性断言，525 个音频调度块间零空隙。两次媒体烟测均无 warnings/consoleErrors，引擎正常停止。声音输出保持静音，验证真实解码和 WebAudio 调度，未做远端听感或跨运营商弱网验收。

证据：`tmp/native-motion-negative.txt`、`tmp/native-motion-visible.txt`、`tmp/native-motion-regression.txt`、`tmp/window-audio-refresh-summary.json`、`tmp/local-playback-e2e-result.json`、`tmp/web-audio-refresh-final.txt`。本地运行时和 Web 构建已更新，尚未生成新版本安装包、推送或部署本轮更改。
