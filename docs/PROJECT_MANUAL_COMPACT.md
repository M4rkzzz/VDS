# VDS 项目压缩手册

## 1. 项目本质

VDS 当前是一个基于 WebRTC 的级联转发屏幕共享系统，组成只有三层:

1. Electron 桌面客户端
2. 浏览器前端页面
3. Node.js 信令服务器

核心拓扑不是“一对多直连”，而是:

`Host -> Viewer#1 -> Viewer#2 -> Viewer#3 -> ...`

Host 只推一份流给链头，后续 Viewer 继续向下游转发。

## 2. 真正参与运行的代码

当前主链路只看这些文件:

- `desktop/main.js`
- `desktop/preload.js`
- `server/index.js`
- `server/server-core.js`
- `server/public/app.js`
- `server/public/index.html`
- `server/public/style.css`
- `scripts/prepare-server-release.js`

仓库里最大的 `resources/obs-studio-32.0.4-vdoninja-nat/` 是整棵 OBS Studio 源码树，当前版本没有直接接入 JS/Electron 运行链路。

## 3. 启动链路

### 桌面端

`desktop/main.js` 负责:

- 创建 Electron 窗口
- 加 WebRTC/编解码启动开关
- 暴露桌面源枚举
- 注入 `process-audio-capture` IPC
- 管理托盘
- 处理自动更新

`desktop/preload.js` 负责把主进程能力桥接到前端:

- 窗口控制
- 屏幕源列表
- 音频捕获
- 自动更新

### 服务端

`server/index.js` 只调用 `startServer()`。

`server/server-core.js` 负责:

- Express 静态托管
- `/api/config`
- `/api/version`
- `/updates`
- WebSocket 信令
- 房间与链式拓扑管理

### 前端

`server/public/app.js` 负责:

- UI
- WebSocket 连接与恢复
- WebRTC 协商
- 屏幕采集
- 进程音频抓取后重建音轨
- 级联转发

## 4. Host 流程

1. 进入 Host 面板
2. 拉 `/api/config`
3. 建 WebSocket
4. 选画质
5. 选屏幕/窗口
6. Electron 下可选一个进程做音频捕获
7. 形成 `localStream`
8. 发 `create-room`
9. 收到 `room-created`
10. 等链头 Viewer
11. 收到 `viewer-joined`
12. 给链头发 WebRTC offer

## 5. Viewer 流程

1. 输入房间号
2. 发 `join-room`
3. 收到 `room-joined`
4. 得到:
   - `hostId`
   - `upstreamPeerId`
   - `chainPosition`
5. 等上游发 offer
6. 回 answer
7. 收到媒体后显示到 `remoteVideo`
8. 发 `viewer-ready`
9. 若服务端要求扩链，则对下一个 Viewer 发 offer

## 6. 服务端编排逻辑

房间结构:

- 一个 Host
- 一个按顺序排列的 `viewers[]`

规则:

- 第 0 个 Viewer 上游是 Host
- 第 N 个 Viewer 上游是第 N-1 个 Viewer

当 Viewer 离开时:

1. 服务端重排后续 `chainPosition`
2. 通知 Host `viewer-left`
3. 通知受影响 Viewer `chain-reconnect`
4. 让新的上游重新去连新的下游

## 7. 断线恢复

### WebSocket 恢复

前端会自动重连，并在恢复后发 `resume-session`。

退避:

- 1s
- 2s
- 4s
- 8s
- 16s
- 30s 封顶

### 服务端会话宽限

`DISCONNECT_GRACE_MS` 默认 `30000ms`。

含义:

- Host 或 Viewer 掉线后不会立刻销毁
- 宽限期内同一 `clientId` 能恢复会话

注意:

- `clientId` 只保存在前端内存里
- 所以只能恢复“连接闪断”
- 不能恢复“应用重启/页面刷新”

### Peer 恢复

WebRTC 层也有恢复:

- 先尝试一次 ICE restart
- 不行再销毁并重建 PeerConnection

## 8. 媒体链路

### 视频

Host 采集桌面后直接把 `localStream` 发给链头。

Viewer 拿到上游流后:

- 一边本地播放
- 一边把这份 `relayStream` 转发给下游

### 音频

Electron 下不是直接拿系统共享音轨，而是:

1. 用 `process-audio-capture` 抓指定进程音频块
2. 在 renderer 里用 `AudioContext` 重建
3. 输出到 `MediaStreamDestination`
4. 再把这条音轨并入共享流

这是一条“PCM 数据 -> Web Audio -> MediaStream”链。

## 9. 编码与网络

默认 ICE:

- `stun:stun.cloudflare.com:3478`
- `stun:stun.linphone.org:3478`
- `stun:stun.freeswitch.org:3478`
- `stun:stun.pjsip.org:3478`
- `stun:stun.sip.us:3478`
- `stun:stun.ippi.fr:3478`
- `stun:stun.easyvoip.com:3478`
- `stun:stun.ekiga.net:3478`

服务端可通过环境变量覆盖:

- `ICE_SERVERS_JSON`
- `TURN_URL`
- `TURN_USERNAME`
- `TURN_PASSWORD`

画质参数来自前端 UI:

- 分辨率
- 帧率
- 码率
- 编码偏好 `none/h264/av1`

实际生效方式主要是:

- `RTCRtpSender.setParameters()` 设置 `maxBitrate`
- `setCodecPreferences()` 设编码偏好

## 10. 关键时序常量

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `DISCONNECT_GRACE_MS` | 30000ms | 服务端会话宽限 |
| `PEER_CONNECT_TIMEOUT_MS` | 15000ms | 主动建连超时 |
| `PEER_DISCONNECT_GRACE_MS` | 4000ms | Peer 短断宽限 |
| `INITIAL_ICE_GATHER_MIN_WAIT_MS` | 1500ms | 发送 SDP 前最短预热 |
| `INITIAL_ICE_GATHER_MAX_WAIT_MS` | 4500ms | 发送 SDP 前最长预热 |
| `INITIAL_ICE_CANDIDATE_TARGET` | 2 | 至少等到 2 个 candidate |
| `ICE_RESTART_LIMIT` | 1 | 最多 1 次 ICE restart |
| Relay wait | 10000ms | 等待 `relayStream` 最长时间 |
| Stats interval | 3000ms | WebRTC stats 打印周期 |
| Audio target lead | 默认 90ms / AV1 180ms | 音频目标提前量 |
| Audio sync check | 默认 750ms / AV1 500ms | 音频定期回正周期 |
| Audio schedule ahead | 默认 120ms / AV1 180ms | 音频预调度窗口 |
| Audio poll | 25ms | 音频队列轮询周期 |

## 11. 当前代码里的重要事实

### `server/public/app.js` 有明显历史残留

文件里保留了:

- `legacy*` 版本函数
- 多个前后重定义的同名函数

真正生效的是文件后半段最后一次定义。

### 当前未完全闭环或未消费的字段

- `createdAt`
- `relayEstablished`
- `viewerChainPosition`
- `isFirstViewer`
- `isRelay`
- `iceRestart`

### `koffi` 当前已直接用于 Windows 全屏窗口检测

`desktop/main.js` 会在 Windows 下通过 `koffi + user32.dll` 读取前台窗口标题、PID 和矩形，
为独占全屏游戏补一个“Fullscreen -> Display Capture”的回退源。

### `runtime/updates/` 当前不在主链路中

自动更新真正用的是:

- `dist/`
- `server/updates/`
- `${SERVER_URL}/updates/`

## 12. 发布链路

### 桌面构建

```bash
npm run build
```

输出到 `dist/`:

- 安装包
- blockmap
- `latest.yml`

### 更新资源准备

```bash
npm run prepare-server-release
```

会把桌面更新相关文件复制到:

- `server/updates/`

### 一键发布

```bash
npm run build:release
```

### 服务端部署

`server/Dockerfile` 和 `server/docker-compose.yml` 会把:

- 静态前端
- 信令服务
- 自动更新资源

一起打成一个可部署容器。

## 12.1 2026-03-29 补充

- 自动更新现在会把日志写到按启动会话切分的 `update-YYYYMMDD-HHMMSS-SSS.log`，避免新一轮检查覆盖旧日志。
- `electron-updater` 运行时已显式关闭 multi-range，配合 `.blockmap` 和 `server/updates/` 的最近 3 版本保留策略测试差分更新。
- Windows 下桌面源列表会额外补一个前台独占全屏窗口的显示器采集回退项，解决全屏游戏不出现在普通 window 源列表里的问题。
- 进程音频重建链路新增周期性音画重同步：默认 90ms 目标音频提前量，AV1 模式 180ms，并按 500ms/750ms 周期回正。

## 13. OBS 目录怎么理解

`resources/obs-studio-32.0.4-vdoninja-nat/` 是完整 OBS 源码资产，里面当然包含:

- `libobs`
- `media-io`
- `obs-ffmpeg`
- `obs-x264`
- `obs-nvenc`
- `obs-webrtc`

这些目录本身覆盖了大量视频编解码、输出、线程、音视频管线实现，但在当前 VDS 版本里，它们不是 Electron/Node/前端主链路直接调用的模块。

结论:

- 如果你要理解“VDS 当前怎么跑”，主看 JS 代码
- 如果你要理解“仓库里附带了哪些大型媒体底座源码”，再单独研究 OBS 子树

## 14. 一句话结论

当前项目的本体，是一个“Electron 客户端 + 浏览器前端状态机 + Node 信令服务”的 WebRTC 级联屏幕共享系统；最关键的代码在 `server/public/app.js`、`server/server-core.js`、`desktop/main.js`，而 OBS 源码树目前主要是仓库附带资产，不是当前运行主干。
