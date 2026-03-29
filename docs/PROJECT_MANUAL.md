# VDS 项目全量技术手册

更新时间: 2026-03-29

本文基于当前仓库代码静态审阅编写，目标是把这个项目的执行路径、模块边界、状态流转、时序常量、媒体链路、信令协议、发布链路、第三方依赖和仓库内的遗留实现一次性说清楚。

## 1. 先给结论

这个仓库当前真正参与运行的自研代码不多，核心只有 6 个 JS 文件加 2 个前端静态文件:

- `desktop/main.js`
- `desktop/preload.js`
- `server/index.js`
- `server/server-core.js`
- `server/public/app.js`
- `scripts/prepare-server-release.js`
- `server/public/index.html`
- `server/public/style.css`

实际产品形态是:

1. 一个 Electron 桌面端客户端
2. 一个 Node.js 信令服务器
3. 一个共享的前端页面 `server/public/*`
4. 一个基于 WebRTC 的级联转发屏幕共享方案

项目的核心设计不是“一对多的单源直连”，而是“链式级联”:

`Host -> Viewer#1 -> Viewer#2 -> Viewer#3 -> ...`

因此 Host 理论上只需要持续向链头上传一份媒体流，后续观众由前一个观众继续向下游转发。这个设计降低了 Host 的上行压力，但把链上稳定性变成了系统的首要问题，所以代码里花了很多篇幅在:

- WebSocket 断线重连
- 会话恢复
- 上游切换
- ICE 重新协商
- viewer 离场后的链重建

## 2. 仓库总览

### 2.1 顶层目录职责

| 目录/文件 | 角色 | 说明 |
| --- | --- | --- |
| `desktop/` | 桌面端主进程与预加载层 | Electron 主进程、托盘、自动更新、屏幕源枚举、进程音频 IPC |
| `server/` | 信令服务与 Web 前端 | Express 静态服务、WebSocket 信令、Docker 部署、前端资源 |
| `scripts/` | 构建后处理 | 把桌面更新包复制到 `server/updates/` |
| `dist/` | 构建产物 | Electron Builder 输出，不是源码 |
| `runtime/` | 运行时产物缓存 | 当前代码没有直接引用，属于本地工作目录 |
| `resources/obs-studio-32.0.4-vdoninja-nat/` | 大型第三方源码树 | 随仓库附带的 OBS Studio 源码，当前 JS 运行链路不直接调用 |
| `node_modules/` | 依赖安装结果 | 非手写业务代码 |
| `package.json` | 顶层打包/开发清单 | Electron 客户端依赖与打包配置 |
| `README.md` | 简述文档 | 当前仅提供简要目录与命令说明 |

### 2.2 体量

仓库当前总文件数约为:

- 全仓库: 14636
- `node_modules/`: 8962
- `resources/obs-studio-32.0.4-vdoninja-nat/`: 5153

也就是说，这个仓库绝大多数文件并不是当前业务逻辑本身，而是:

- Node 依赖
- 打包产物
- OBS 上游源码

因此阅读时必须区分:

- 当前产品运行路径
- 第三方附带源码
- 构建产物

### 2.3 当前“源码真相”

当前产品真正的 source of truth 是:

- Electron 主进程: `desktop/main.js`
- Electron 预加载桥: `desktop/preload.js`
- 信令服务: `server/server-core.js`
- 前端逻辑: `server/public/app.js`
- 前端结构样式: `server/public/index.html`、`server/public/style.css`

其中 `server/public/app.js` 一份文件就有 3080 行，是整个项目的逻辑中心。

## 3. 运行形态

### 3.1 三个执行上下文

当前项目在运行时分成三个主要上下文:

1. Electron Main Process
   负责窗口、托盘、自动更新、屏幕源枚举、桌面能力开关、音频捕获 IPC。
2. Renderer / Browser Page
   负责 UI、WebSocket、WebRTC、媒体采集、状态管理、链式转发。
3. Node Signaling Server
   负责房间管理、链路编排、消息转发、断线宽限、更新资源托管。

### 3.2 两种部署形态

前端页面 `server/public/*` 同时服务两种模式:

1. Electron 模式
   Electron 本地加载 `server/public/index.html`
2. 浏览器模式
   Express 通过静态目录直接对外服务同一套前端文件

这也是为什么前端代码里大量存在 `if (window.isElectron)` 判断。

### 3.3 客户端与服务器关系

桌面端不会在本地启动信令服务器。它默认直接连一个远端地址:

- 默认 `SERVER_URL`: `https://boshan.s.3q.hair`

也就是说:

- 桌面客户端是前端应用
- 服务端是独立部署的
- 自动更新也从同一个服务端地址拉取

## 4. 项目主链路总图

### 4.1 启动总图

```text
Electron app start
  -> desktop/main.js
     -> 创建 BrowserWindow
     -> 加载 server/public/index.html
     -> 注入 preload.js
     -> 暴露 electronAPI

Renderer app start
  -> server/public/app.js
     -> 读取运行配置
     -> 等用户选择 Host / Viewer
     -> 建立 WebSocket
     -> 协商 WebRTC

Node server start
  -> server/index.js
     -> startServer()
     -> Express 静态托管 + WebSocket 信令
```

### 4.2 媒体总图

Host 端:

1. 选分辨率/码率/帧率/编码偏好
2. 选屏幕或窗口
3. Electron 下可再选一个进程做音频捕获
4. 形成 `localStream`
5. 创建房间
6. 给链头观众发 WebRTC offer

Viewer 端:

1. 加入房间
2. 从服务器得知自己的上游是谁
3. 接收上游 offer
4. 返回 answer
5. 收到媒体后把流显示到本地
6. 发送 `viewer-ready`
7. 如果后面还有观众，则自己再向下游发 offer

## 5. 顶层配置与打包

### 5.1 顶层 `package.json`

顶层包名是 `screenshare-relay`，当前仓库版本是 `1.4.7`。

脚本:

- `npm run dev` / `npm run start`: 启动 Electron
- `npm run server`: 启动 Node 信令服务器
- `npm run build`: `electron-builder`
- `npm run rebuild`: 重新编译 Electron 原生依赖
- `npm run prepare-server-release`: 复制更新产物到 `server/updates/`
- `npm run build:release`: 先打桌面包，再准备服务端更新目录

顶层依赖:

- `electron-updater`: 桌面自动更新
- `express`: HTTP 静态服务
- `ws`: WebSocket 信令
- `process-audio-capture`: Electron 进程音频捕获
- `koffi`: 已用于 Windows 前台全屏窗口检测与回退源生成

开发依赖:

- `electron`
- `electron-builder`
- `electron-rebuild`

### 5.2 Electron Builder 配置

当前桌面包配置的几个关键点:

- `appId`: `com.vds.app`
- `productName`: `VDS`
- 输出目录: `dist/`
- Windows 目标: `nsis`
- 安装包命名: `VDS-Setup-${version}.exe`
- 自动更新 provider: `generic`
- 自动更新 URL: `https://boshan.s.3q.hair/updates/`

一个重要事实:

桌面包 `build.files` 只打入:

- `desktop/**/*`
- `server/public/**/*`

也就是:

- 桌面包里没有 `server/server-core.js`
- 桌面包里没有本地信令服务器
- 桌面包本质上只带客户端界面和 Electron 壳

## 6. Electron 主进程

文件: `desktop/main.js`

### 6.1 主职责

这个文件负责:

- 打开 Electron 窗口
- 设置 Chromium/WebRTC 启动参数
- 注入音频捕获 IPC
- 枚举屏幕/窗口源
- 管理托盘
- 转发自动更新事件
- 暴露少量 IPC 能力给 renderer

### 6.2 Chromium / WebRTC 启动开关

主进程在启动时追加了如下特性开关:

- `MediaFoundationVideoEncoder`
- `WebRTC-H264WithH264EncoderImpl`
- `WebRTC-AV1-Encoder`
- Blink 特性 `WebRTC-AV1`
- 禁用 `UseSoftwareVP9Encoder`

含义:

- 尽量打开 H.264 和 AV1 编码路径
- 尽量避免走软件 VP9 编码
- 更偏向系统或硬件能力

如果环境变量 `HW_ACCEL=false`:

- `disable-gpu`
- `disable-software-rasterizer`

这意味着可以强行关闭 GPU 路径，但也可能让某些桌面捕获/编解码能力退化。

### 6.3 音频捕获 IPC

`setupAudioCaptureIpc()` 来自 `process-audio-capture/dist/main`。

主进程不自己实现进程音频抓取，而是把第三方库的 IPC 能力直接挂进 Electron。

renderer 最终通过 preload 提供的这些接口访问:

- 平台是否支持
- 权限检查
- 权限申请
- 进程列表
- 开始抓取
- 停止抓取
- 是否正在抓取
- 音频数据事件订阅

### 6.4 窗口安全策略

窗口配置:

- `nodeIntegration: false`
- `contextIsolation: true`
- `webSecurity: true`
- `frame: false`
- 自定义标题栏

附加限制:

- 新窗口统一被拦截，外链改为 `shell.openExternal`
- `will-navigate` 拦截非当前页面导航
- `Ctrl+Shift+I` 可切换 DevTools

### 6.5 屏幕源枚举

`desktopCapturer.getSources()` 使用:

- `types: ['window', 'screen']`
- 缩略图尺寸 `320x180`
- `fetchWindowIcons: true`

返回给 renderer 的字段:

- `id`
- `name`
- `appIcon`
- `thumbnail`

### 6.6 自动更新

主进程的自动更新策略:

- `autoDownload = false`
- `autoInstallOnAppQuit = true`

renderer 会先触发 `check-for-updates`，主进程配置 feed URL 为:

- `${SERVER_URL}/updates/`

随后主进程把以下状态推给 renderer:

- `checking`
- `available`
- `not-available`
- `downloading`
- `downloaded`
- `error`

### 6.7 托盘行为

关闭按钮并不直接退出，而是走 renderer 的自定义弹窗。

托盘逻辑:

- 最小化到托盘时隐藏主窗口
- 双击托盘恢复
- 托盘菜单可显示窗口或退出程序

## 7. Preload 桥

文件: `desktop/preload.js`

### 7.1 作用

preload 是 renderer 和 Electron 主进程之间唯一的官方桥梁。

它通过 `contextBridge.exposeInMainWorld` 暴露:

- `window.electronAPI`
- `window.isElectron = true`

### 7.2 暴露给前端的能力

#### 基础能力

- `getAppVersion()`
- `getPlatform()`
- `getRuntimeConfig()`
- `getDesktopSources()`

#### 窗口能力

- `minimize()`
- `minimizeToTray()`
- `maximize()`
- `close()`
- `isMaximized()`
- `onMaximizedChange()`

#### 自动更新能力

- `checkForUpdates()`
- `downloadUpdate()`
- `quitAndInstall()`
- `onUpdateStatus()`

#### 音频抓取能力

挂在 `electronAPI.audioCapture` 下。

#### 通知能力

- `showNotification(title, body)`

当前前端代码没有明显使用系统通知。

### 7.3 一个容易忽略的事实

`preload.js` 自己根据环境变量构造 `getRuntimeConfig()`，没有调用主进程里的 `ipcMain.handle('get-runtime-config')`。

因此:

- `desktop/main.js` 里的 `get-runtime-config` IPC 目前没有被使用
- 运行配置实际来自 preload 本地常量，不来自 IPC 往返

## 8. 服务端

文件:

- `server/index.js`
- `server/server-core.js`

### 8.1 `server/index.js`

这里只做一件事:

- 调 `startServer({ baseDir: __dirname, port: process.env.PORT || 3000 })`

### 8.2 `server/server-core.js` 的职责

这是整个信令层核心。

负责:

- 提供前端静态页面
- 提供 `/updates` 自动更新资源
- 提供 `/api/config`、`/api/version`
- 建立 WebSocket Server
- 维护房间表 `rooms`
- 编排 Host 与 Viewer 的链式拓扑
- 在断线宽限期内保留会话

### 8.3 HTTP 层

#### 静态资源

- 根目录: `public/`
- 更新目录: `/updates`

#### API

- `GET /api/config`
  返回:
  - `version`
  - `iceServers`
  - `disconnectGraceMs`
- `GET /api/version`
  返回:
  - `version`
  - `disconnectGraceMs`

#### CORS

仅对 `/api/*` 路径加了宽松 CORS:

- `Access-Control-Allow-Origin: *`

### 8.4 运行配置

服务端核心环境变量:

- `PORT`
- `DISCONNECT_GRACE_MS`
- `ICE_SERVERS_JSON`
- `TURN_URL`
- `TURN_USERNAME`
- `TURN_PASSWORD`

ICE 配置优先级:

1. `ICE_SERVERS_JSON`
2. `TURN_URL` 前插
3. 默认 STUN 列表

默认 STUN:

- `stun:stun.cloudflare.com:3478`
- `stun:stun.linphone.org:3478`
- `stun:stun.freeswitch.org:3478`
- `stun:stun.pjsip.org:3478`
- `stun:stun.sip.us:3478`
- `stun:stun.ippi.fr:3478`
- `stun:stun.easyvoip.com:3478`
- `stun:stun.ekiga.net:3478`

### 8.5 房间模型

`rooms` 是 `Map<roomId, room>`。

房间对象结构:

- `id`
- `host`
  - `clientId`
  - `ws`
  - `disconnectTimer`
- `viewers: []`
- `createdAt`

viewer 结构:

- `clientId`
- `ws`
- `chainPosition`
- `mediaReady`
- `relayEstablished`
- `disconnectTimer`

其中:

- `createdAt` 当前未参与后续逻辑
- `relayEstablished` 仅被置位，未被后续逻辑消费

### 8.6 房间 ID 与安全模型

房间号由:

- `Math.random().toString(36).substring(2, 8).toUpperCase()`

生成。

特点:

- 6 位
- Base36
- 全大写
- 无鉴权

这意味着:

- 任何知道房间号的人都能尝试加入
- 没有 host token / viewer token
- 没有密码
- 没有签名校验

### 8.7 链式编排逻辑

Viewer 加入房间时:

1. 服务端把他追加到 `room.viewers`
2. `chainPosition = room.viewers.length` 旧值
3. 返回:
   - `hostId`
   - `upstreamPeerId`
   - `chainPosition`

规则:

- 第 0 个 viewer 的上游是 Host
- 第 N 个 viewer 的上游是第 N-1 个 viewer

如果新加入的是第 0 个 viewer:

- 服务端通知 Host: `viewer-joined`

如果新加入的是后续 viewer:

- 服务端检查前一个 viewer 是否 `mediaReady`
- 如果已 ready，通知前一个 viewer: `connect-to-next`

### 8.8 断线宽限

服务端断线策略:

- Host 或 Viewer 的 WebSocket `close` 时，不立刻销毁
- 进入 `disconnectGraceMs` 宽限
- 默认 30000ms

如果在宽限期内收到了 `resume-session`:

- 清掉定时器
- 恢复 socket 引用
- 返回 `session-resumed`

如果超时:

- Host: 房间整体销毁，通知全部 viewer `host-disconnected`
- Viewer: 从链上摘除，并触发链重建

### 8.9 Viewer 离场后的重排

当某个 viewer 真正离场:

1. 从 `room.viewers` 中删除
2. 后续所有 viewer 的 `chainPosition` 重新编号
3. 给 Host 发 `viewer-left`
4. 给受影响的后续 viewer 发 `chain-reconnect`
5. 如果离开的是链头:
   - 通知 Host 重新连新的第 0 个 viewer
6. 如果离开的是链中间:
   - 如果前一个 viewer 已 `mediaReady`
   - 通知前一个 viewer 去连新的后继

这套逻辑就是“级联重建”的核心。

## 9. 前端结构

文件:

- `server/public/index.html`
- `server/public/style.css`
- `server/public/app.js`

### 9.1 页面组成

前端页面同时支持 Electron 和纯浏览器访问。

主要 UI 区块:

- 模式选择面板
- Host 面板
- Viewer 面板
- 自定义标题栏
- 关闭确认弹窗
- 更新下载弹窗
- 屏幕源选择弹窗
- 画质设置弹窗
- 音频进程选择弹窗
- 错误 toast

### 9.2 两种角色

#### Host 面板

展示:

- 当前状态
- 房间号
- 观众数
- 本地预览视频
- 开始共享 / 停止共享

#### Viewer 面板

展示:

- 房间号输入
- 当前房间号
- 连接状态
- 自己在链中的位置
- 远端视频

### 9.3 标题栏差异

如果不是 Electron:

- 隐藏自定义标题栏

所以 Web 版本本质是同一套页面，但去掉桌面壳交互。

## 10. `server/public/app.js` 全景

这是全项目最复杂的文件。

### 10.1 这份文件的真实情况

它不是纯净单版实现，而是“新旧两版混合共存”:

- 存在一批 `legacy*` 函数
- 还存在若干“同名函数前后重复定义”
- 后定义会覆盖前定义

因此阅读时必须以“最后一次定义”为准。

明确存在旧实现残留的函数包括:

- `legacyConnectWebSocket`
- `legacyDisconnectWebSocket`
- `legacyWaitForWsConnected`
- `legacySendMessage`
- `legacyCreatePeerConnection`
- `legacyCheckForUpdates`
- `legacyCreateOffer`
- `legacyCreateOfferToNextViewer`
- `legacyHandleOffer`
- `legacyHandleAnswer`
- `legacyHandleIceCandidate`

还有一组同名但被后文覆盖的函数:

- `stopScreenShare`
- `resetViewerState`
- `handleMessage`
- `createPeerConnection`
- `preferH264Codec`
- `preferAV1Codec`
- `createOffer`
- `createOfferToNextViewer`
- `handleOffer`
- `handleAnswer`
- `handleIceCandidate`

### 10.2 全局状态

前端维护的核心状态包括:

#### WebSocket 状态

- `ws`
- `wsConnected`
- `wsConnectPromise`
- `wsReconnectAttempts`
- `wsReconnectTimer`
- `pendingReconnect`
- `resumeOnNextConnect`
- `pendingMessages`
- `wsManualClose`

#### 会话状态

- `clientId`
- `isHost`
- `sessionRole`
- `currentRoomId`
- `hostId`
- `myChainPosition`
- `upstreamPeerId`

#### 媒体状态

- `localStream`
- `relayStream`
- `relayPc`
- `viewerReadySent`
- `videoStarted`
- `upstreamConnected`

#### WebRTC 管理状态

- `peerConnections`
- `peerConnectionMeta`
- `peerReconnectState`
- `pendingRemoteCandidates`

#### 音频状态

- `audioContext`
- `audioDataHandler`
- `audioMediaStreamDest`
- `audioQueue`
- `isAudioPlaying`
- `audioTimer`

#### 画质状态

- `qualitySettings`
  - `width: 1920`
  - `height: 1080`
  - `bitrate: 10000 kbps`
  - `frameRate: 60`
  - `codecPreference: 'none'`

### 10.3 一个非常关键的事实: `clientId` 只存在内存里

`clientId` 是:

- `runtimeConfig.clientId || ('client_' + Math.random().toString(36).substring(2, 11))`

但当前 runtimeConfig 根本没有提供持久化 clientId。

这意味着:

- WebSocket 短时断开后，本页内存还在，能 resume
- 但页面刷新、应用重启、崩溃重启后，`clientId` 改了
- 所谓 session resume 并不能跨重启，只能跨“连接闪断”

这点对理解恢复能力很重要。

## 11. 前端 UI 流程

### 11.1 Host 进入流程

1. 用户点击“我要分享屏幕”
2. `showHostPanel()`
3. 切 UI 到 host 面板
4. `isHost = true`
5. 拉 `/api/config`
6. 建 WebSocket
7. 状态进入 `Connecting...`

### 11.2 Viewer 进入流程

1. 用户点击“我要观看”
2. `showViewerPanel()`
3. 切 UI 到 viewer 面板
4. `isHost = false`
5. 拉 `/api/config`
6. 建 WebSocket

### 11.3 返回流程

Host 返回:

- `goBack()`
- 调 `stopScreenShare()`
- 断开 WebSocket
- 回到模式选择

Viewer 返回:

- `goBackViewer()`
- 调 `leaveRoom()`
- 回到模式选择

## 12. WebSocket 层

### 12.1 建链逻辑

当前生效的是新版 `connectWebSocket()`。

特点:

- 幂等
- 有 `wsConnectPromise` 防并发
- 连接成功后刷新版本信息
- 只在 Electron 下做自动更新检查
- 如果此前处于会话中，会自动发 `resume-session`
- 连接成功后冲刷 `pendingMessages`

### 12.2 断线重连

重连采用指数退避:

- 基础延迟: 1000ms
- 最大延迟: 30000ms

即:

- 1s
- 2s
- 4s
- 8s
- 16s
- 30s 封顶

### 12.3 消息排队

如果信令暂时断开:

- `sendMessage()` 默认会把消息进 `pendingMessages`
- 同时触发 `connectWebSocket()`

只有显式 `queueIfDisconnected: false` 的场景不会排队，比如:

- 主动离房
- 主动停共享

### 12.4 会话恢复

如果 WebSocket 非手动关闭:

- `resumeOnNextConnect = Boolean(currentRoomId && sessionRole)`

下一次连接成功后自动发:

- `resume-session`
  - `roomId`
  - `clientId`
  - `role`
  - `needsMediaReconnect`

其中 viewer 的 `needsMediaReconnect` 取决于:

- `sessionRole === 'viewer' && !upstreamConnected`

## 13. 信令协议清单

### 13.1 客户端发给服务端

| 消息 | 发送方 | 关键字段 | 含义 |
| --- | --- | --- | --- |
| `create-room` | Host | `clientId` | 创建房间 |
| `join-room` | Viewer | `roomId`, `clientId` | 加入房间 |
| `resume-session` | Host/Viewer | `roomId`, `clientId`, `role`, `needsMediaReconnect` | WebSocket 断线后恢复 |
| `offer` | Host/Viewer | `targetId`, `sdp`, `roomId` | WebRTC offer |
| `answer` | Host/Viewer | `targetId`, `sdp`, `roomId` | WebRTC answer |
| `ice-candidate` | Host/Viewer | `targetId`, `candidate`, `roomId` | ICE 候选 |
| `viewer-ready` | Viewer | `roomId`, `clientId`, `chainPosition` | 已收流，可继续向下游扩链 |
| `leave-room` | Host/Viewer | `roomId`, `clientId` | 主动离房 |

### 13.2 服务端发给客户端

| 消息 | 接收方 | 关键字段 | 含义 |
| --- | --- | --- | --- |
| `room-created` | Host | `roomId`, `clientId` | 房间创建成功 |
| `room-joined` | Viewer | `roomId`, `hostId`, `upstreamPeerId`, `chainPosition`, `isFirstViewer` | 加房成功 |
| `session-resumed` | Host/Viewer | `role`, `roomId`, `viewerCount`, `hostId`, `upstreamPeerId`, `chainPosition` | 恢复成功 |
| `viewer-joined` | Host | `viewerId`, `viewerChainPosition`, `reconnect` | Host 需要去连链头 viewer |
| `connect-to-next` | Viewer | `nextViewerId`, `nextViewerChainPosition` | 当前 viewer 需要去连下游 |
| `offer` | Peer | `fromClientId`, `sdp` | 转发的 offer |
| `answer` | Peer | `fromClientId`, `sdp` | 转发的 answer |
| `ice-candidate` | Peer | `fromClientId`, `candidate` | 转发的 ICE |
| `viewer-left` | Host | `viewerId`, `leftPosition` | 有观众离开 |
| `chain-reconnect` | Viewer | `newChainPosition`, `upstreamPeerId` | 该 viewer 上游已变化，需要重建 |
| `host-disconnected` | Viewer | 无 | Host 最终离开，房间销毁 |
| `error` | 任意 | `code`, `message` | 业务错误 |

### 13.3 协议里已经存在但当前基本未消费的字段

这些字段在代码里出现，但当前闭环不完整或根本没被消费:

- `createdAt`
- `relayEstablished`
- `viewerChainPosition`
- `isFirstViewer`
- `isRelay`
- `iceRestart`

## 14. Host 侧媒体采集

### 14.1 入口

点击“开始共享”时，当前生效逻辑并不立刻抓屏，而是:

1. 打开画质设置弹窗
2. 用户确认后再进入源选择

### 14.2 画质设置项

可配置:

- 分辨率
  - 1080p
  - 720p
  - 480p
- 码率
- 帧率
  - 60
  - 45
  - 30
- 编码偏好
  - `none`
  - `h264`
  - `av1`

### 14.3 屏幕源选择

Electron 下:

- 用 `electronAPI.getDesktopSources()`
- 用户从缩略图网格中选窗口或屏幕

浏览器下:

- 不走自定义源选择 UI
- 直接 `getDisplayMedia()`

### 14.4 Electron 屏幕采集

Electron 模式下，视频采集走:

- `navigator.mediaDevices.getUserMedia()`
- `chromeMediaSource: 'desktop'`
- `chromeMediaSourceId: sourceId`

并把 `qualitySettings` 写入:

- `width`
- `height`
- `frameRate`
- `maxWidth`
- `maxHeight`
- `maxFrameRate`

### 14.5 浏览器屏幕采集

浏览器模式下走:

- `navigator.mediaDevices.getDisplayMedia()`

附带约束:

- `displaySurface: 'window'`
- `audio: true`
- `surfaceSwitching: 'include'`
- `selfBrowserSurface: 'exclude'`
- `preferCurrentTab: false`

## 15. 进程音频捕获链路

### 15.1 只在 Electron 下存在

浏览器版不支持“选某个进程的音频”。

Electron 下，屏幕源选完后，代码会尝试:

1. 检查平台支持
2. 检查权限
3. 必要时申请权限
4. 拉进程列表
5. 弹出“音频进程选择”对话框

### 15.2 自动模式与手动模式

代码里其实存在两条音频路径:

1. 自动从 `sourceId` 解析 PID，再匹配进程
2. 用户显式选择 PID

当前主要使用的是用户选择 PID 的路径:

- `startScreenShareWithAudio(sourceId, audioPid)`
- `captureWindowAudioWithPid(_sourceId, pid)`

### 15.3 音频重建方式

项目没有直接拿系统音频轨来发，而是:

1. 从 `process-audio-capture` 收到音频块事件 `audio-data`
2. 把块放进 `audioQueue`
3. 自己在 renderer 里建一个 `AudioContext`
4. 自己构造 `AudioBuffer`
5. 自己调度播放到 `MediaStreamDestination`
6. 再把这个 destination 的音轨加进共享流

换句话说，它是“进程 PCM -> Web Audio 重排 -> MediaStream 音轨”。

### 15.4 音频调度时序

音频调度里有两个很关键的常量:

- `SCHEDULE_AHEAD_TIME = 0.1`
  - 提前 100ms 调度
- `processAudioQueue()` 通过 `setTimeout(..., 25)` 驱动
  - 每 25ms 扫一次队列

每个音频包的处理逻辑:

1. `sampleCount = buffer.length / channels`
2. `audioContext.createBuffer(channels, sampleCount, sampleRate)`
3. 把交错 PCM 拆到每个 channel
4. `createBufferSource()`
5. 只连接 `audioMediaStreamDest`
6. 不连本地扬声器

这意味着:

- 本地不会因为这段代码自动把进程音频放出来
- 音频只进入发送流

### 15.5 资源清理

停共享/离房时会清理:

- `stopCapture()`
- `audioDataHandler()`
- `audioTimer`
- `audioQueue`
- `audioContext.close()`
- `audioMediaStreamDest = null`

## 16. Host 共享建立流程

Host 侧实际流程:

1. 用户确认画质
2. 用户确认屏幕源
3. 可选确认音频进程
4. 生成 `localStream`
5. 本地预览挂到 `localVideo`
6. 监听 `videoTrack.onended`
   - 系统停止共享时自动 `stopScreenShare()`
7. 向服务端发 `create-room`
8. 收到 `room-created`
9. 等第一个 viewer
10. 收到 `viewer-joined`
11. 发 offer 给链头 viewer

## 17. Viewer 收流与转发流程

### 17.1 加房

Viewer 点击加入时:

1. 读取房间号
2. `sendMessage({ type: 'join-room', roomId, clientId })`
3. 收到 `room-joined`
4. 保存:
   - `currentRoomId`
   - `sessionRole = 'viewer'`
   - `myChainPosition`
   - `hostId`
   - `upstreamPeerId`
5. UI 显示“等待上游”

### 17.2 收上游媒体

收到上游 `offer` 后:

1. `handleOffer()`
2. 创建或复用一个 `RTCPeerConnection`
3. `setRemoteDescription`
4. `createAnswer`
5. `setLocalDescription`
6. 等待本地 ICE warmup
7. 发送 `answer`

当 `pc.ontrack` 收到流:

1. 保存 `relayStream = stream`
2. 如果这是当前 viewer 的上游流:
   - `upstreamConnected = true`
   - `videoStarted = true`
   - 把流挂到 `remoteVideo`
   - UI 状态改为 `Connected`
3. 如果这是第一次拿到上游流:
   - 发 `viewer-ready`

### 17.3 向下游转发

服务端在合适时机会给当前 viewer 发:

- `connect-to-next`

此时 viewer 执行:

- `createOfferToNextViewer(nextViewerId)`

具体步骤:

1. 等 `relayStream` 最多 10 秒
2. 新建 RTCPeerConnection
3. 把 `relayStream` 的 tracks 全部 `addTrack`
4. 设 codec preference
5. `createOffer`
6. `setLocalDescription`
7. `setVideoBitrate`
8. `waitForLocalIceWarmup`
9. 发送给下游

这一层逻辑说明:

- Viewer 既是接收端，也是转发端
- 每个 viewer 只向一个“下一个 viewer”发流

## 18. WebRTC 连接管理

### 18.1 管理模型

`peerConnections` 是 `Map<peerId, RTCPeerConnection>`。

Host 语义:

- `peerId` 理论上可以是多个 viewer
- 但在当前级联设计里，正常只需要对链头 viewer 建连接

Viewer 语义:

- 一个上游 PC
- 一个下游 PC

### 18.2 元信息 `peerConnectionMeta`

每个 peer 附带 meta:

- `isInitiator`
- `kind`
  - `host-viewer`
  - `relay-viewer`
  - `upstream`
  - 其他
- `hasConnected`
- `connectTimeoutId`
- `disconnectTimerId`
- `localCandidateCount`
- `localCandidateTypes`
- `restartAttempts`
- `restartInProgress`
- `selectedCandidatePairLogged`

### 18.3 ICE 候选缓存

如果 ICE candidate 先到了，但:

- 还没创建 PC
- 或还没 `remoteDescription`

就先进入:

- `pendingRemoteCandidates`

等远端描述就绪后 `flushRemoteCandidates()` 一次性灌入。

### 18.4 本地 ICE warmup

在发 offer/answer 之前，代码不会立刻发送，而是等待一个“小预热窗口”。

关键常量:

- `INITIAL_ICE_GATHER_MIN_WAIT_MS = 1500`
- `INITIAL_ICE_GATHER_MAX_WAIT_MS = 4500`
- `INITIAL_ICE_CANDIDATE_TARGET = 2`

退出条件:

1. 至少过了 1.5 秒，且
2. 已拿到至少 2 个本地 candidate
   或
3. ICE gathering 已 complete
   或
4. 总等待到 4.5 秒超时

这相当于在连接建立速度和首包完整度之间做了一个折中。

### 18.5 建连超时与掉线宽限

关键常量:

- `PEER_CONNECT_TIMEOUT_MS = 15000`
- `PEER_DISCONNECT_GRACE_MS = 4000`

含义:

- 主动发起方 15 秒还没建好，视为失败
- 已连接 PC 短暂进入 `disconnected` 时，先宽限 4 秒再处理

### 18.6 Peer 重连退避

关键常量:

- `PEER_RECONNECT_BASE_DELAY_MS = 1000`
- `PEER_RECONNECT_MAX_DELAY_MS = 8000`

即 peer 级别的重新发 offer 也走指数退避:

- 1s
- 2s
- 4s
- 8s 封顶

### 18.7 ICE Restart

关键常量:

- `ICE_RESTART_LIMIT = 1`

策略:

1. 先试一次 `pc.createOffer({ iceRestart: true })`
2. 如果失败或超时，再走彻底重建 PC

所以恢复逻辑分两层:

- 轻量恢复: ICE restart
- 重量恢复: close + rebuild + new offer

## 19. 编码、码率、统计

### 19.1 码率设置

`setVideoBitrate(pc)` 会找 video sender，然后:

- `parameters.encodings[0].maxBitrate = qualitySettings.bitrate * 1000`
- `parameters.encodings[0].maxFramerate = qualitySettings.frameRate`

注意:

- 只调视频 sender
- 不调音频 sender
- 用的是 `maxBitrate`，不是目标恒定码率

### 19.2 编码偏好

当前生效逻辑主要靠:

- `RTCRtpSender.getCapabilities('video')`
- `transceiver.setCodecPreferences(preferredCodecs)`

支持两种偏好:

- `video/av1`
- `video/h264`

如果选不到:

- 回退浏览器默认协商顺序

### 19.3 一个很重要的细节: 当前 SDP munging 实际上失效

文件前半段曾实现过:

- `preferH264Codec(sdp)`
- `preferAV1Codec(sdp)`

它们会改 `m=video` payload 顺序。

但在文件后半段，这两个函数被重新定义成:

- 直接 `return sdp`

所以当前真正生效的是:

- `setCodecPreferencesForPC()`

而不是 SDP 文本改写。

### 19.4 WebRTC 统计日志

代码会记录:

- inbound video
- outbound video
- codec
- candidate pair

定时器:

- `startStatsLogging()` 每 3000ms 打一次

但它有一个重要限制:

- 全局只有一个 `statsInterval`
- 任何新连接开始统计时，都会覆盖前一个

所以它不是“每个连接各打一份 stats”，而是“最后一个启动统计的连接独占日志定时器”。

### 19.5 已选 ICE Pair 日志

连接成功时还会额外尝试打印:

- local candidate type/protocol
- remote candidate type/protocol
- RTT

这有助于判断当前到底走的是:

- host
- srflx
- relay
- udp / tcp

## 20. 断线与恢复

### 20.1 WebSocket 层恢复

断 WebSocket 后:

1. 指数退避重连
2. 成功后自动 `resume-session`
3. Host 恢复 viewerCount
4. Viewer 恢复 roomId / chainPosition / upstreamPeerId

### 20.2 上游媒体恢复

如果 viewer 的上游 peer 失败:

1. 先试 ICE restart
2. 失败则 `resetViewerMediaPipeline()`
3. 清空所有 peerConnections
4. 清空当前远端视频
5. UI 改成“Recovering...”
6. 等新的上游重新对它发 offer

### 20.3 `chain-reconnect`

当链中前面有人离开时，服务端会给受影响 viewer 发:

- `chain-reconnect`

viewer 收到后会:

- 更新 `myChainPosition`
- 更新 `upstreamPeerId`
- `resetViewerMediaPipeline('Rebuilding upstream...')`

这会直接把 viewer 自己现有的上下游连接都清掉，等待新的拓扑重建。

### 20.4 `viewer-ready` 的作用

只有 viewer 真正拿到了上游媒体流，才会发 `viewer-ready`。

服务端收到这个消息后，才会允许它继续扩到下一个 viewer。

这是一道关键闸门，避免:

- 下游在上游还没拿到流时就盲目扩链

## 21. 关键时序表

| 名称 | 数值 | 所在层 | 用途 |
| --- | --- | --- | --- |
| `DISCONNECT_GRACE_MS` | 默认 30000ms | 服务端/桌面配置 | WebSocket 会话宽限 |
| WebSocket reconnect base | 1000ms | 前端 | 信令重连 |
| WebSocket reconnect max | 30000ms | 前端 | 信令重连封顶 |
| `PEER_RECONNECT_BASE_DELAY_MS` | 1000ms | 前端 | Peer 重发 offer |
| `PEER_RECONNECT_MAX_DELAY_MS` | 8000ms | 前端 | Peer 重发 offer 封顶 |
| `PEER_CONNECT_TIMEOUT_MS` | 15000ms | 前端 | 主动建连超时 |
| `PEER_DISCONNECT_GRACE_MS` | 4000ms | 前端 | 已建连短断宽限 |
| `INITIAL_ICE_GATHER_MIN_WAIT_MS` | 1500ms | 前端 | 本地 candidate 预热最短等待 |
| `INITIAL_ICE_GATHER_MAX_WAIT_MS` | 4500ms | 前端 | 本地 candidate 预热最长等待 |
| `INITIAL_ICE_CANDIDATE_TARGET` | 2 | 前端 | 至少等到 2 个 candidate |
| `ICE_RESTART_LIMIT` | 1 | 前端 | 最多尝试 1 次 ICE restart |
| Relay stream wait | 10000ms | 前端 | viewer 向下游转发前等上游流 |
| Stats interval | 3000ms | 前端 | WebRTC stats 输出 |
| Audio schedule ahead | 100ms | 前端 | 音频预调度 |
| Audio queue tick | 25ms | 前端 | 音频队列轮询 |
| `waitForWsConnected()` timeout | 10000ms | 前端 | 等 WebSocket 成功 |

## 22. 当前前端代码里的生效逻辑与遗留逻辑

### 22.1 生效逻辑

以文件后半段最后定义为准:

- 新版 WebSocket 重连/恢复
- 新版 peer meta / reconnect / ICE restart
- 新版 `createPeerConnection`
- 新版 `createOffer`
- 新版 `createOfferToNextViewer`
- 新版 `handleOffer/Answer/IceCandidate`
- 新版 `stopScreenShare`
- 新版 `resetViewerState`
- 新版 `handleMessage`

### 22.2 遗留逻辑

文件中仍保留:

- 旧版 WebSocket 实现
- 旧版 peer 连接处理
- 旧版更新检查
- 旧版 SDP codec munging
- 旧版 track 转 relayPc 逻辑

这些代码本身不一定“没价值”，但它们不再是当前执行路径。

### 22.3 为什么这件事重要

因为你在追 bug 时如果只看文件前半段，很容易得出错误结论。

例如:

- 你会误以为 H.264/AV1 一定会做 SDP 顺序重写
- 实际不会

## 23. 已知非显性问题与设计事实

### 23.1 `clientId` 不持久化

结果:

- 只能恢复“连接闪断”
- 不能恢复“应用重启/页面刷新”

### 23.2 `get-runtime-config` IPC 未被使用

主进程实现了:

- `ipcMain.handle('get-runtime-config', ...)`

但 preload 没有调用它。

### 23.3 `koffi` 依赖当前已接入主链路

`desktop/main.js` 会在 Windows 下直接 `require('koffi')`，通过 `user32.dll`
读取前台窗口标题、PID 与矩形，为独占全屏游戏生成一个显示器采集回退源。

### 23.4 `runtime/updates/` 当前代码未引用

自动更新真正使用的是:

- `server/updates/`
- `SERVER_URL/updates/`

`runtime/updates/` 更像本地残留目录。

### 23.5 若干字段未闭环

包括:

- `createdAt`
- `relayEstablished`
- `viewerChainPosition`
- `isFirstViewer`
- `isRelay`
- `iceRestart`

### 23.6 统计日志不是多连接并行

只有一个全局 `statsInterval`。

### 23.7 中文文本存在编码异常迹象

源码里大量中文注释和 UI 文本显示为乱码字符序列，说明文件编码或终端解码链存在不一致。

这不影响 JS 语法，但会影响:

- 可读性
- 维护成本
- 潜在 UI 文案正确显示

### 23.8 安全模型很弱

当前没有:

- 登录鉴权
- 房间密码
- token
- 房主签名
- 端到端业务级授权

依赖的只是:

- 随机 roomId
- 内存内 clientId

## 24. 前端与服务端的分工边界

### 24.1 服务端负责

- 房间存在性
- 链位置
- 上游是谁
- 什么时候让谁连谁
- 断线宽限
- 链重排
- HTTP 配置下发

### 24.2 前端负责

- 真正的媒体采集
- 真正的 WebRTC 协商
- 真正的 ICE 管理
- 真正的音频重建
- 真正的 UI 状态
- 真正的 peer 重试

所以这是一个“薄信令服务 + 重前端状态机”的项目。

## 25. 发布链路

### 25.1 桌面端发布

执行:

```bash
npm run build
```

会生成:

- `dist/VDS-Setup-${version}.exe`
- `dist/VDS-Setup-${version}.exe.blockmap`
- `dist/latest.yml`

### 25.2 服务端更新资源准备

执行:

```bash
npm run prepare-server-release
```

脚本会:

1. 读取顶层 `package.json` 版本号
2. 自动寻找当前版本对应的构建目录，优先兼容 `dist-${version}/`
3. 更新 `server/updates/latest.yml`
4. 把当前版本的安装包与 blockmap 复制到 `server/updates/`
5. 保留最近 3 个版本的 `.exe + .blockmap`，不再整目录清空

### 25.3 一键发布链路

```bash
npm run build:release
```

等价于:

1. `npm run build`
2. `npm run prepare-server-release`

### 25.4 Docker 服务端

`server/Dockerfile` 非常简单:

1. 基于 `node:22-alpine`
2. `npm ci --omit=dev`
3. 拷贝:
   - `index.js`
   - `server-core.js`
   - `public/`
   - `updates/`
4. 暴露 3000
5. `node index.js`

`docker-compose.yml` 只启动一个 `signaling` 服务，并设置:

- `PORT=3000`
- `DISCONNECT_GRACE_MS=30000`

这说明线上部署模型是:

- 同一个容器同时负责前端静态文件、信令服务、自动更新资源托管

## 26. OBS 源码树说明

目录:

- `resources/obs-studio-32.0.4-vdoninja-nat/`

### 26.1 它是什么

这是一整份 OBS Studio 上游源码树，不是一个小插件目录。

它包含:

- `libobs/`
- `frontend/`
- `plugins/`
- `libobs-d3d11/`
- `libobs-opengl/`
- `libobs-metal/`
- `libobs-winrt/`
- `docs/`
- `deps/`
- `test/`

### 26.2 它与当前产品的关系

按当前仓库搜索结果看:

- 自研 JS/Electron/Node 代码没有直接引用这个 OBS 源码目录
- 顶层 Electron 打包也没有把它打入桌面包
- 这份源码当前更像“附带的上游资产”或未来扩展素材

因此:

- 它不是当前 VDS 运行主链的一部分
- 但它确实存在于仓库里

### 26.3 为什么用户会觉得它相关

因为这个目录里确实有大量“视频编解码、输出、连接、线程、媒体 IO”实现，而且它比当前 VDS 自研代码更复杂。

如果你的目标是“理解仓库里所有媒体相关源码资产”，这棵树必须被单独看待。

### 26.4 OBS 核心媒体结构

#### `libobs/`

OBS 后端核心，负责:

- 场景/源/滤镜框架
- 编码器框架
- 输出框架
- 服务框架
- 音视频主管线

#### `libobs/media-io/`

媒体 IO 核心目录，包含:

- `audio-io.c`
- `video-io.c`
- `audio-resampler-ffmpeg.c`
- `video-scaler-ffmpeg.c`
- `format-conversion.c`
- `media-remux.c`

#### 图形后端

- `libobs-d3d11/`
- `libobs-opengl/`
- `libobs-metal/`
- `libobs-winrt/`

#### `frontend/`

OBS 桌面 UI 前端。

#### `plugins/`

各种源、输出、编码器、服务。

### 26.5 OBS 文档里写明的媒体线程模型

OBS 自带文档 `docs/sphinx/backend-design.rst` 明确了:

- 图形渲染线程
- 视频编码/输出线程
- 音频处理线程

并描述了:

- 视频帧从渲染纹理到视频队列再到编码器/输出
- 音频每 1024 样本 tick 一次，在 48kHz 下约 21ms 一次
- 编码后包进入输出层，必要时做音视频交织

这些说明对理解 OBS 源码非常关键，但要强调:

- 这是 OBS 自己的后端设计
- 不是当前 VDS WebRTC 前端的直接执行路径

### 26.6 OBS 编码/输出相关插件目录

仓库内可见的典型媒体插件目录包括:

- `plugins/obs-ffmpeg/`
- `plugins/obs-x264/`
- `plugins/obs-nvenc/`
- `plugins/obs-qsv11/`
- `plugins/obs-webrtc/`
- `plugins/obs-outputs/`
- `plugins/rtmp-services/`

其中:

#### `plugins/obs-ffmpeg/`

包含:

- FFmpeg 输出
- mux
- NVENC / VAAPI / OpenH264 / AV1 相关桥接
- 音频编码器

#### `plugins/obs-x264/`

是 x264 编码插件。

#### `plugins/obs-nvenc/`

是 NVIDIA NVENC 插件，含 CUDA / D3D11 / OpenGL 路径。

#### `plugins/obs-webrtc/`

当前目录可见:

- `whip-output.cpp`
- `whip-service.cpp`

说明 OBS 这棵树内部自己也有 WebRTC/WHIP 输出相关能力。

### 26.7 手册边界说明

由于 OBS 这棵树本身是 5000+ 文件级别的大型上游项目，本文只做“与当前仓库相关的资产级说明”，不逐文件复述 OBS 全源码。

如果后续需要，应该单独再写一份:

- `docs/OBS_SUBTREE_MANUAL.md`

专门覆盖 `resources/obs-studio-32.0.4-vdoninja-nat/`。

## 26.8 2026-03-29 补充

- 自动更新日志改成按启动会话切分的 `update-YYYYMMDD-HHMMSS-SSS.log`，避免新一轮检查覆盖旧日志。
- `electron-updater` 运行时显式设置 `useMultipleRangeRequest: false`，用于兼容当前更新源对差分下载的 Range 支持。
- Windows 下桌面源枚举新增前台独占全屏窗口回退源，表现为 “Fullscreen -> Display Capture”，用于解决全屏游戏不出现在普通 `window` 源列表里的问题。
- `server/public/app.js` 的进程音频重建链路新增周期性音画重同步机制：默认目标音频提前量 90ms，AV1 模式 180ms，并按 750ms/500ms 周期回正。

## 27. 文件级索引

### 27.1 自研核心文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | 桌面端开发/打包主清单 |
| `desktop/main.js` | Electron 主进程、自动更新、托盘、桌面源枚举 |
| `desktop/preload.js` | Electron 能力桥接 |
| `server/index.js` | 服务端入口 |
| `server/server-core.js` | 房间管理、链式编排、静态托管、更新托管 |
| `server/public/index.html` | 页面骨架 |
| `server/public/style.css` | 样式 |
| `server/public/app.js` | UI + WebSocket + WebRTC + 音频重建 + 自动更新 UI |
| `server/package.json` | 服务端精简依赖清单 |
| `server/Dockerfile` | 服务端镜像 |
| `server/docker-compose.yml` | 服务端容器启动配置 |
| `scripts/prepare-server-release.js` | 自动更新资源整理 |

### 27.2 生成物目录

| 目录 | 说明 |
| --- | --- |
| `dist/` | Electron Builder 输出 |
| `server/updates/` | 供自动更新服务使用的静态目录 |
| `runtime/updates/` | 当前代码未接线的运行产物目录 |

## 28. 维护建议

如果继续迭代这个项目，优先建议做的不是“再加功能”，而是先做结构清理:

1. 把 `server/public/app.js` 拆模块
2. 删掉或迁出 `legacy*` 和被覆盖的旧定义
3. 持久化 `clientId`，把会话恢复扩展到应用重启级
4. 给信令协议补鉴权或最少补 host token
5. 明确 `runtime/updates/` 与 `server/updates/` 的职责
6. 决定 OBS 源码树到底是附带资料、未来依赖，还是应该拆仓

## 29. 最后一句话总结

当前 VDS 的本体，是一个“Electron 壳 + 单页前端状态机 + Node 信令服务”的 WebRTC 级联转发屏幕共享系统。

真正值得精读的是:

- `server/public/app.js`
- `server/server-core.js`
- `desktop/main.js`

而 `resources/obs-studio-32.0.4-vdoninja-nat/` 虽然体量巨大、媒体实现丰富，但在当前版本里属于仓库携带的大型第三方源码资产，不是 VDS 主链路运行时的直接一环。
