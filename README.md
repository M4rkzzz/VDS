# VDS

VDS 是一套为“把画面稳定地给很多人看”而做的屏幕共享工具。它可以共享整个屏幕、单个窗口，也可以接入 OBS 推流；观看端可以用桌面客户端，也可以直接用浏览器加入。

它更适合那些普通会议软件不太顺手的场景：小团队远程协作、内网演示、游戏或软件测试围观、教学排障、临时直播预览，以及需要多人同时看同一画面的局域网环境。

> **置顶推荐**
>
> VDS 的重点不是做一个又重又全的会议系统，而是把“开播、发房间号、多人观看、链式转发、OBS 接入、局域网手机观看”这条链路做得直接、清楚、可控。房主只需要选择画面并开始共享，观看者拿到房间号或在公开房间里进入；当观看人数变多时，系统会尽量让观看端接力转发，减少房主单点上行压力。
>
> 简单说：它是一个偏工程实用的私有屏幕共享和 relay 工具，适合想自己部署、自己掌控链路、同时又希望使用体验尽量接近“点开就能看”的场景。

## 适合什么场景

- **局域网演示**：在公司、实验室、宿舍或工作室里快速把一个屏幕给多台设备看。
- **远程协作**：研发、测试、运维排障时，让多个人同时看同一个操作过程。
- **OBS 预览分发**：把 OBS 推来的画面接入 VDS，再分发给多个观看端。
- **手机临时观看**：iOS Safari、Android Chrome 等移动浏览器可以作为 Web 观看端参与测试和观看。
- **自部署场景**：信令服务器、更新源和后台都在自己的环境里，可控性比纯云服务更强。

## 核心能力

- Windows 桌面端一键选择屏幕或窗口并开始共享。
- 支持 native 采集和本机 OBS ingest 两种房主输入方式。
- 支持多个观看端同时加入，默认优先使用链式 relay 分担房主压力。
- 支持桌面客户端观看，也支持浏览器 Web 观看端。
- 支持公开房间列表和手动房间码加入。
- 提供 3010 后台查看实时房间、拓扑、节点状态和媒体 manifest。
- 提供诊断面板，方便定位 P2P、采集、编码、解码、relay 和浏览器能力问题。

## 1.7.1 版本概览

`1.7.1` 重点完善了 renderer/native authority 拆分后的稳定性、media-agent session ownership、native/OBS 生命周期、Web/native relay 拓扑，以及移动浏览器 Web 观看端能力检测。

主要变化：

- Renderer 侧拆分为 app state、room client、调试面板、源选择、画质设置、更新 UI、native session、peer、surface、diagnostics 和 P2P 状态机等职责模块。
- media-agent 收紧 Host、Peer、Surface、Relay、Audio、OBS ingest 的 session/controller ownership，减少共享大状态带来的时序风险。
- 修复 native/OBS 开播、停止共享、重复开播、房间创建、房间号显示、公开房间发现和 stale manifest 清理问题。
- 修复 OBS ingest 音频与 AAC manifest，OBS 推流后可正确向下游播放和 relay。
- 源缩略图改为异步加载，改进 WGC 预览时序和诊断，降低源选择、预览黑屏和预览异常对主流程的影响。
- 强化链式 relay 拓扑：默认优先链式，上游不可达时由服务端重新选择上游，并限制单上游下游容量。
- Web 观看端增强 iOS Safari、Android Chrome 和其它 Android 浏览器的能力检测、诊断导出、codec/payload format 判断和 LAN HTTP 测试路径。
- 3010 信令后台支持实时房间、拓扑、节点状态、边状态、容量和 manifest 可视化。
- 完整发布流程包含 renderer、server、Web、logging、media-agent、打包产物和 GitHub Release 校验。

## 当前媒体路径

- 房主后端：原生采集或本地 OBS ingest。
- 原生采集：Windows Graphics Capture。
- OBS ingest：本机 `127.0.0.1` SRT / MPEG-TS 输入。
- P2P 传输：原生 `libdatachannel`。
- 视频：`H.264 / H.265`。
- 音频：原生房主使用 `Opus 48k stereo`，OBS ingest 使用 `AAC 48k`。
- Relay：转发已编码音视频帧，不做浏览器端重新编码。
- 渲染：native preview / native viewer surface；Web 观看端使用 WebCodecs。

## 仓库结构

- `desktop/`：Electron 主进程、preload bridge、更新器和 native agent bridge。
- `server/`：可部署的 Node.js 信令服务器、Docker 上下文、3010 后台和更新源输出。
- `server/public/`：Electron renderer 静态资源。
- `vds_web/`：桌面 Chrome/Edge、iOS Safari、Android 浏览器 Web 观看端源码，构建产物复制到 `server/public/vds_web/`。
- `media-agent/`：原生采集、编码、解码、relay、预览和 viewer surface 实现。
- `runtime/`：构建生成的原生运行时，打包时复制进 Electron，不提交。
- `scripts/`：本地测试、发布、server 和 native 构建脚本。
- `tools/`：辅助工具，例如 VDS 测试启动器。
- `docs/`：架构、审计、日志策略、media-agent 和移动 Web QA 文档。
- `MEDIA_REFACTOR_PLAN.md`：当前媒体架构和未发布改动记录来源。

更多结构说明见 [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)。
移动 Web 真机 QA 见 [docs/WEB_MOBILE_DEVICE_QA.md](docs/WEB_MOBILE_DEVICE_QA.md)。

## 常用命令

```bash
npm install
npm run dev
npm run server
npm run dev:single:native
npm run dev:dual:native
npm run dev:dual:web
npm run dev:triple:native
npm run triple:nwn
npm run check:vds-web
npm run check:web-mobile-diagnostics
npm run check:web-mobile-code
npm run test:vds-web
npm run test:server
npm run build:vds-web
npm run build:media-agent
npm run build:release
```

## 局域网手机 Web HTTP

移动端局域网 HTTP 测试是支持路径。手机打开 `http://<局域网IP>:3000/` 即可，Web 观看端会把 RFC1918 / link-local 局域网地址识别为允许的本地测试上下文，并继续探测真实浏览器 API。如果某个浏览器在局域网 HTTP 下隐藏 WebRTC 或 WebCodecs，诊断会明确显示缺少的 API。

HTTPS 仍可作为更严格的可选路径：

```powershell
$env:VDS_HTTPS_KEY_PATH='C:\\path\\to\\lan-key.pem'
$env:VDS_HTTPS_CERT_PATH='C:\\path\\to\\lan-cert.pem'
npm run server
```

然后手机访问 `https://<局域网IP>:3000/`。iOS Safari 通常需要先在设备上信任证书或证书颁发机构，WebSocket 和媒体 API 才会稳定工作。

## 发布门禁

移动 Web 真机诊断是人工 QA 证据，不是自动发布硬门禁。手机专项测试前建议先运行：

```bash
npm run check:web-mobile-code
```

该命令只验证代码层移动 Web 适配，不要求三份真实手机诊断 JSON。需要核对某次手机导出的诊断时，可按场景单独运行：

```bash
node scripts/check-web-mobile-diagnostics.js ios-safari-leaf path/to/report.json
node scripts/check-web-mobile-diagnostics.js android-chrome-relay path/to/report.json
node scripts/check-web-mobile-diagnostics.js android-non-chrome-leaf path/to/report.json
```

## Native 测试流程

- `npm run dev:single:native`：本地 server + 1 个 native 客户端。
- `npm run dev:dual:native`：本地 server + 1 个房主 + 1 个 native 观看端。
- `npm run dev:dual:web`：本地 server + native 房主 + Web 观看端。
- `npm run dev:triple:native`：本地 server + 1 个房主 + 2 个 native 观看端。
- `npm run triple:nwn`：native 房主 + Web relay / viewer + native 观看端。

## 画质设置

桌面 UI 当前支持：

- 房主后端：`Native Push / OBS Push`。
- 编码：`H.264 / H.265`。
- 分辨率：`360p / 480p / 720p / 1080p / 2k / 4k`。
- 帧率：`5 / 30 / 60 / 90`。
- 码率：按 `1000 kbps` 步进。
- 硬件加速开关。
- 本地预览开关。
- 硬件编码器：自动或手动选择已验证编码器。
- 编码 preset：`quality / balanced / speed`。
- tune：`fastdecode / zerolatency`。
- 关键帧间隔策略。

OBS 模式当前行为：

- VDS 准备一个本机 SRT 地址，并等待 OBS 推送有效节目流。
- 默认端口为 `61080`。
- 用户可以保存自定义本地端口。
- VDS 不控制 OBS，也不依赖 `obs-websocket`。
- OBS 模式只面向本机 ingest，不是通用远程 SRT 网关。

观看端加入当前行为：

- 默认页签为 `Lobby`。
- 加入面板打开时，Lobby 会轮询 `/api/public-rooms`。
- 房主开播前可以选择房间是否公开。
- `Direct` 页签仍支持手动输入房间码。

## 发布与部署

- `npm run build:release`
  - 执行发布前检查，包括 VDS_web 构建和 media-agent verification。
  - 构建 Electron 安装包。
  - 刷新 `server/updates/`。
  - 校验打包内 media-agent runtime 与 `runtime/media-agent` 一致。
  - 校验 `dist/` 与 `server/updates/` 更新 manifest 一致。
  - 通过 GitHub CLI 发布 GitHub Release。
- `npm run release:github`
  - 要求已安装并登录 GitHub CLI `gh`。
  - 创建并推送 `v<version>` tag，上传安装包、blockmap 和 `latest.yml`。
  - 默认拒绝 dirty worktree，除非显式设置 `ALLOW_DIRTY_GITHUB_RELEASE=1`。
- `server/` 是可部署 server 目录。
- 桌面自动更新源由 `server/updates/` 提供。
- 历史发布说明见 [CHANGELOG.md](CHANGELOG.md)。

## 源码管理规则

- 构建输出不提交。
- `runtime/` 二进制不提交。
- `server/public/vds_web/` 由 `npm run build:vds-web` 生成，不提交。
- `server/updates/` 是部署输出，不作为源码提交。
- [docs/CODE_AUDIT_FINDINGS.md](docs/CODE_AUDIT_FINDINGS.md) 记录发现的问题和处理结果，用于审计连续性。
