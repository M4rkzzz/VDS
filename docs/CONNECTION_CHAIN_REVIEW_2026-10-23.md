# 连接链全程复查：2026-10-23

本轮从房间信令一直检查到连接退出，复用本地 UU/GameViewer 反编译证据与现有 VDS 测试，修复两处连接阶段之间的事件交接问题。保持纯 P2P，没有增加 TURN、探测 socket 数量、媒体运行配额或常驻扫描线程。改动处于本地未发布状态，项目版本仍为 1.7.13。

## 整条链路与检查结果

| 阶段 | VDS 当前实现与本次检查 | 验证及边界 |
| --- | --- | --- |
| 入房、会话身份 | 服务端绑定当前权威 WebSocket，恢复会话校验 token；转发限制相邻节点。WebSocket 建连有独立超时。 | 服务端本地恢复测试通过。会话恢复凭证不是管理令牌，本轮未新增管理鉴权要求。 |
| 解析与候选收集 | 现有增量 DNS/STUN 路径允许已解析目标先推进；不同端口但相同公网 IP 的 STUN 结果不被误当作独立映射证据。 | DNS progress、same-address STUN、late STUN、SDP candidates 回归通过。没有以扩充域名数量替代映射辨识。 |
| NAT 观察与探测 | 已有端口模型、主 socket 探索、候选范围采样和多出口观察；临时探测归属于连接代次。 | prediction、allocation model、paced recovery、exploration plans、full egress、standard multiexit 等回归通过；不是重新测出公网随机 NAT 成功率。 |
| TCP 路径 | 已有 active/passive/simultaneous-open、TCP STUN 和端口映射候选。建连与认证阶段分别计时。 | TCP ICE、active bind、SO、延迟、分片读写及真实映射 DataChannel 通过。浏览器端能力与原生端不同，不能假定所有路径都对称可用。 |
| ICE 选路与 nomination | 既有修复区分临时 selected 和最终 nominated，保留迟到可用路径的机会。 | delayed nomination、late path、standard peer 回归通过；没有缩短正常 ICE 生命周期。 |
| DTLS / SCTP / DataChannel | 既有启动交接处理覆盖先到 DTLS 首包；本轮发现 C++ 发出的 `datachannel-closed` 到达桌面控制器后被忽略。 | early handshake/callback 回归通过；本轮将通道关闭接入终止恢复，并阻止迟到的 connected 撤销该恢复。 |
| 媒体就绪 | 原生协议校验媒体会话、manifest 与 hello；网页按真实解码进展判定播放。 | OBS/SRT 音视频及 WGC 视频均有真实新增帧验证，不把 connected 或历史累计帧数当作恢复完成。 |
| 信令与媒体分别存活 | 本轮发现网页在 WebSocket 断开时销毁仍健康的 P2P 和会话凭证。现改用服务端已有 resume-session。 | 只断信令时保留媒体；媒体也失效才请求新 offer。连续拒绝两次替换 WebSocket 后仍能恢复原会话。 |
| 重连、换代和级联 | 前几轮已补齐桌面失败恢复、旧 SDP/旧回调隔离、级联下游独立恢复；本轮补齐通道关闭事件及网页信令换代。 | 桌面真实 JS 控制器配合模拟 RPC 验证代次；真实网页级联覆盖刷新和上游退出。没有将其等同于三台原生设备的跨网测试。 |
| 退出与资源回收 | 用户离开会取消本轮信令重试和异步返回；连接代次约束临时 socket 与映射租约的归属。 | 原生 cleanup ownership 3/3，PCP/NAT-PMP/UPnP 创建、续租、释放及真实 TCP DataChannel 通过；两条媒体烟测 nativeStopped=true。 |

## UU 对照的依据

本轮复核的是已有本地反编译产物，没有新增 UU 运行时注入或重新反编译。分析对象为历史记录中的 `streamer.dll` 4.42.0.2770，SHA256 `ab8ade084c4f714fe5b21d1324b7e5d13e41bb036d4382e4bc231383b3d56e79`。

- [ICE restart / 打洞线程重置](../REA/evidence/rea/vds-p2p-mcp/code-bootstrap.json)：`0x18020dc94`。
- [策略选择和代次判断](../REA/evidence/rea/vds-p2p-mcp/code-strategy.json)：`0x18020ed58`；[随机映射分支](../REA/evidence/rea/vds-p2p-mcp/code-bothrandom.json)：`0x1802112fc`。
- [可写路径建立后结束旧探测](../REA/evidence/vds-handshake-handoff/writable-stop.txt)：`0x180214641` 更新 owner+0x730。
- [临时探测集合重置](../REA/evidence/rea/vds-p2p-mcp/code-reset.json)：`0x180211988`。

可借鉴的关键是：观察结果驱动策略、连接操作有明确代次、路径建立后退出旧探测、各阶段有各自的完成条件。UU 的 writable 判断本身不能证明 DTLS 已完成；这些证据也不能证明 UU 使用了 VDS 的 Web 会话恢复协议。本轮两项生产修复均针对 VDS 自身代码实现。

## 本轮修复

### 原生通道关闭事件接入恢复

`peer_transport.cpp` 的 DataChannel onClosed 会发布 `peer-state: datachannel-closed`，但桌面控制器只处理通用连接状态。即使底层已报告媒体通道关闭，上层仍可能认为曾经 connected 就足够。

现在将该事件接入已有失败恢复，并在当前 handle 标记媒体通道已经终止。随后到达的 connected 不再取消恢复；显式关闭的 handle 不会被重新拉起。房主、观看者及级联下游均覆盖，既有 transportGeneration 检查继续隔离旧事件。

修改前快照运行新增因果测试：11 项中 2 项失败；最终实现通过。真实 WGC 烟测也收到了对应故障代次的 C++ 通道关闭事件。原生桌面上层恢复由控制器回归验证，不能把网页烟测说成完整原生 UI 故障注入。

### 网页信令断开时保留可用媒体

新增 `SignalingRecovery` 只管理断线期间的信令恢复操作。健康媒体继续播放，恢复时发送 `needsMediaReconnect:false`；媒体失效则退役旧上游并请求重新协商。恢复请求发出后媒体又断开的情况，也会在确认会话后触发媒体恢复。

替换 WebSocket 在确认前再次断开，会立即废弃旧操作并进入退避，不空等确认截止时间；离开房间或更换会话后，旧 Promise 不得再发送恢复。会话已过服务端保留期时重新加入原房间，凭证无效时明确结束。重试只发生在断线期间，间隔最高 5 秒，没有新增尝试次数配额，也没有新增健康媒体轮询。现有其他媒体恢复策略未在本轮改写。

修改前入口在同一因果回归中 27 项有 1 项失败，原因正是断信令直接清掉媒体和会话。最终实现通过。

## 实测结果

- 桌面/Web JavaScript：**538/538**；架构、TypeScript、Web 构建通过；本地服务端会话恢复测试通过。
- `scripts/test-native-nat.js`：**31/31 CTest**，495.85 秒。之后的 runtime integrity、cleanup、RPC 代次/凭证/纯 P2P 契约、TCP STUN 及真实映射 DataChannel 检查全部通过。31 项不是 31 组随机 NAT 都接通，也不是完整 media-agent 全测试集。
- OBS/SRT → 原生 → 网页：只断信令且拒绝两次替换连接后，原生连接代次不变，继续新增 12 帧；信令和媒体同时断开、仅媒体断开分别用 **976ms / 1084ms** 达到至少 12 帧新增画面，实际新增 **15/15 视频帧、39/33 音频块**。
- WGC → 原生 → 网页：同样的仅信令故障保留原代次并新增 15 帧；两次媒体故障分别 **2280ms / 1735ms**，新增 **14/15 帧**。确认真实原生 `datachannel-closed` 事件到达。
- 两条媒体烟测均完成离开重入、刷新、网页级联刷新和上游退出后恢复；OBS 还覆盖两次推流源重启。两份结果 `warnings=[]`、`consoleErrors=[]`、`nativeStopped=true`。

耗时包含等待足够的新帧，不是首像素恢复延迟。音频静音输出，只验证解码持续推进，没有人工听感结论。选中的是本机 UDP host 直连，未使用 TURN；本地虚拟接口地址和端口不代表跨运营商网络。

原始报告、负例与源码指纹见 [证据汇总](../REA/evidence/vds-connection-chain-2026-10-23/summary.json)。复跑媒体故障测试：先构建 Web，再运行 `node scripts/test-local-playback-e2e.js --connection-recovery`，WGC 路径追加 `--wgc`。原生网络回归运行 `npm run verify:nat`（需要 Windows 原生构建和 CMake）。

## 当前结论与未验证部分

整条链路上，本轮找到并补齐的是“底层通道已死，上层不恢复”和“仅信令掉线，却主动毁掉健康媒体”两处交接缺陷。此前的 NAT/ICE 策略通过现有回归，本轮没有靠增加 socket 或重试数量制造覆盖率提升。

仍没有两台跨运营商实机，也没有同网络、同时间的 UU 对照；因此不宣称达到或超过 UU 的 WAN 接通率。长时间移动网络切换、物理音画同步及真实设备休眠恢复不在本轮烟测结论内。源码及 Web 构建已本地验证，尚未打包、推送 GitHub 或部署服务器。
