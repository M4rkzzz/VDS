# VDS 服务端恢复与维护

信令、公开房间、Web 观看端和管理后台由同一个 Node.js 服务提供。服务器只传递信令与拓扑，音视频仍由客户端纯 P2P 传输，禁止 TURN。Docker 基础运行时为 Node 22.23.3 / Alpine 3.24。

## 2026-10-10：桌面 1.7.8 原生预览修复已发布

发布源码 `8c31bad` 对应不可变 `v1.7.8`，已推送 [正式 Release](https://github.com/M4rkzzz/VDS/releases/tag/v1.7.8)，四份资产大小和 GitHub SHA256 与最终构建一致。默认 HTTPS 更新源已切到 1.7.8，签名清单、地图哈希、头尾 206 Range 和 1.7.7 更新识别通过。安装包 235,413,781 字节，SHA256 `f8792a536c2675b2824a69846f5b98adb3eb31e13643f7826bab2c0e53ead961`。

实际 NsisUpdater 从真实公网源完成 1.7.7→1.7.8 差分：7 次 Range、1,358,114 字节安装包数据，加地图 476,707 字节，共 1,834,821 字节；无全包请求，重组完整哈希一致。新版本已认证基线在隔离缓存建立通过，没有执行安装或替换用户客户端。桌面 266/266、Web 164/164、原生 CTest 26/26、八轮原生真实预览及最终桌面包三轮实际界面开播/嵌入式预览/停止重开通过。

本次只添加 1.7.8 桌面资产并切换清单/签名；NAS 信令与 Web 保留 `vds-signaling:1.7.7`，API 1.7.7。全部七个容器 ID、启动时间和运行状态一致，19 份旧版本化更新文件哈希不变，证书与 FRP 未动。旧清单/签名、逐文件哈希及容器快照在 `/vol1/1000/docker/vds/ops/release-1.7.8-before`，暂存和最终核验在 `/vol1/1000/docker/vds/releases/1.7.8`。本轮预览修复需桌面更新到 1.7.8；保留纯 P2P、无 TURN、六位一次性房号与免管理令牌，没有新增媒体运行配额。

## 2026-10-10：1.7.7 服务端与 Web 已部署

NAS 信令与 Web 已升级至 `vds-signaling:1.7.7`，image SHA256 为 `8c086dd36f097c8cff4e592909868d312df41cc139b2b5691dc21e8e8c236ece`。实际 `/api/version` 从 1.7.3 升至 1.7.7；此前桌面 1.7.6 的发布记录仍准确，桌面版本与当时的服务端版本分别记录。发布源码 `c7b2c15` 对应不可变 `v1.7.7` 标签。

部署前在独立容器核对 34 份服务端与 Web 源文件哈希，验证六位私房、公网 `public-rooms` 与可信内网 `all-rooms` 两种管理 scope，并完成 15 项实际 WebSocket 重连回归。部署后 API、镜像与源文件哈希一致；公网严格 TLS 下的房主断线、重连及待处理观看者连接恢复验证通过。本轮核验的是部署与信令恢复，实际跨运营商 P2P 媒体仍需独立验收。

部署前可信内网全量快照为零房间，没有中断用户房间；只替换 signaling 服务，其他六个容器的 ID、启动时间及运行状态保持原样，包括原先停止的容器。服务端部署阶段原有 19 份更新文件哈希不变，生产环境、端口、挂载以及 TLS、证书、FRP 配置保留。完整服务端与 Web 回滚快照在私密目录 `/vol1/1000/docker/vds/ops/release-1.7.7-before/server-snapshot`，部署前镜像、文件、其他容器与更新文件基线在同目录的 `deployment-baseline.json`；暂存、隔离预检与部署结果在 `/vol1/1000/docker/vds/releases/1.7.7`。

桌面 1.7.7 已构建并通过完整发布前后检查和最终安装包启动验证，已发布 [正式 Release](https://github.com/M4rkzzz/VDS/releases/tag/v1.7.7)；四份 GitHub 资产大小/SHA256 与本地最终构建一致。默认 HTTPS 更新源已切到 1.7.7，原始清单签名、签入的地图哈希、安装包头尾 206 Range 及真实 NsisUpdater 的 1.7.6 更新识别通过。安装包 235,413,552 字节，SHA256 `f5ae89f091387d720514d13186fac15a73cd2263e0cb33632bb751caef140a75`。

实际 NsisUpdater 从真实公网 HTTPS 源完成 1.7.6→1.7.7 差分下载：6 次 Range、1,006,460 字节安装包数据，加地图 476,739 字节，共 1,483,199 字节；没有全包请求，重组完整哈希一致。在隔离缓存建立 1.7.7 已认证基线通过；未执行安装或替换用户客户端。最终核验其他六个容器保持原样、17 份旧版本化更新文件哈希不变；更新源切换未重启新的 signaling，restartCount 为零，隔离预检容器已删除。`releases/1.7.7/after-verification.json` 保存核验结果。保持纯 P2P、禁止 TURN，不增加媒体运行配额。

## 2026-10-09：桌面 1.7.6 冷启动修复已发布

修复源码 `3f10853` 对应 `v1.7.6`，已推送 [正式 Release](https://github.com/M4rkzzz/VDS/releases/tag/v1.7.6)，四份资产大小与 SHA256 均与最终本地产物一致。默认 HTTPS 更新源已切到 1.7.6，原始清单签名、地图哈希、安装包头尾 206 Range 和 1.7.5 更新识别通过。新安装包 235,392,071 字节，SHA256 `bafa9494486365a3ff4d2b3fabb1aaa96498716da2bf7cc59d4f755b076362af`。

实际 NsisUpdater 从真实公网 HTTPS 源完成 1.7.5→1.7.6 差分下载：8 次 Range，安装包数据 1,434,585 字节，地图 476,614 字节，共 1,911,199 字节；没有全包请求，重组完整哈希一致。生产公钥与公网清单下建立 1.7.6 已认证基线也通过。验证均使用隔离缓存，未执行安装或替换用户客户端；基线缺失或校验失败仍按原规则全量下载，取消不回退。

仅添加版本化桌面资产并切换清单/签名，NAS 信令镜像仍为 `vds-signaling:1.7.3-short-rooms`，API 仍为 1.7.3。全部七个容器 ID、启动时间、运行状态一致，没有重启；15 份旧版本化更新文件哈希不变，证书与 FRP 未动。旧清单、签名、更新文件哈希和容器状态在私密备份 `/vol1/1000/docker/vds/ops/release-1.7.6-before`，暂存与最终核验记录在 `/vol1/1000/docker/vds/releases/1.7.6`。保持纯 P2P 与原六位一次性房号，不增加媒体运行配额。

## 2026-10-09：桌面 1.7.5 差分修复已发布

修复源码 `cba4753` 对应 `v1.7.5`，已推送 [正式 Release](https://github.com/M4rkzzz/VDS/releases/tag/v1.7.5)，四份资产的大小及 SHA256 与最终本地构建一致。默认 HTTPS 更新源已切到 1.7.5，清单签名、签入的地图 SHA512/大小、安装包头尾 Range 和 1.7.4 更新识别通过。生产公钥及真实公网清单下，1.7.5 在隔离 NSIS 缓存建立已认证基线通过。旧 1.7.3/1.7.4 必须先全量升级一次；此后有效基线可进行已认证差分，基线缺失或失败自动全量，取消不回退。

新地图大小/哈希由离线签名覆盖；客户端下载和重组前核验已安装版本、旧 EXE 与旧地图，完成后复验整个新 EXE。同进程损坏缓存会清理并重下；发布准备不再从本地旧版本重建产物覆盖或补拷历史地图。实际 1.7.4/1.7.5 安装包由修复代码进行隔离签名 HTTPS 实测，7 次 Range 传送 995,123 字节安装包数据，加两地图共 1,471,641 字节，未请求全包，重组哈希正确。该实测未执行安装，不代表旧客户端已开启差分。

只添加版本化 1.7.5 资产并切换清单/签名，NAS 信令仍为 `vds-signaling:1.7.3-short-rooms`，API 仍为 1.7.3，没有重启任何容器。四个容器 ID/启动时间、全部旧发行包/地图、证书和 FRP 不变。新安装包 235,382,490 字节，SHA256 `46be13efcf4b70d22187f9af9869c1dd9ce7fce80a6b50599b1b258c051a1585`。旧清单、签名、更新文件哈希及容器状态可从私密备份 `/vol1/1000/docker/vds/ops/release-1.7.5-before` 回退；暂存目录为 `/vol1/1000/docker/vds/releases/1.7.5`。以下差分禁用和未修复记录保留为此前版本的历史审计，当前实现以本节为准。

## 2026-10-09：桌面 1.7.4 更新源已发布

桌面 WGC、预览与音视频会话恢复修复源码为 `197b3d5`，`v1.7.4` 标签对应同一源码；[正式 Release](https://github.com/M4rkzzz/VDS/releases/tag/v1.7.4) 四份资产大小及 SHA256 与最终本地产物一致。默认 HTTPS 更新源已切换为 1.7.4，原始清单签名、三个小文件哈希和安装包头尾 206 Range 验证通过，真实 NsisUpdater 已确认 1.7.3 可识别 1.7.4；保留签名认证与全量下载路线。

本次只在 `/vol1/1000/docker/vds/server/updates` 添加新的版本化安装包、地图并切换签名清单。NAS 信令仍为 `vds-signaling:1.7.3-short-rooms`，API 版本仍为 1.7.3；没有重启信令或其他三个容器，全部 ID/启动时间、旧安装包与地图、证书及 FRP 保持原样。安装包 235,379,496 字节，SHA256 `e991c41479a6ee2b44dea40f7bee5b175d938b53f6b8e7e7017b17d3ec5379a7`。发布暂存文件在 `/vol1/1000/docker/vds/releases/1.7.4`；旧清单、签名、旧 updates 哈希和容器状态在私密备份 `/vol1/1000/docker/vds/ops/release-1.7.4-before`，可成对恢复旧清单与签名回退更新源。以下保留此前服务端部署历史。

## 2026-10-08 六位一次性房号热修（已上线）

线上服务端已将新房号改为固定 6 位，字符集为 `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`，仅对应当前活动房间，关闭或失效后旧码作废，不保留额外旧码兼容。随机生成并检查当前 Map，碰撞最多重试 32 次，sessionToken 不变；Web 加入入口先 trim 再转大写。

已部署镜像 `vds-signaling:1.7.3-short-rooms`，image SHA256 为 `fd6443089caed6ed2b4e0e0920bef3a52e97ad5672659cdbd2ea53c9d882d756`；容器 core/Web HTML/JS 哈希与本地热修一致。API 版本仍为 1.7.3，仅更新服务端与 Web，现有桌面无需重装；已发布 v1.7.3 标签、GitHub 四资产和默认更新源内容保持原样。

preflight 双 scope 与六位私房、严格 TLS 公网两观看者的直接/接力信令、恢复、伪造 token 拒绝和退出清理通过。另验证私房过期后旧码拒绝、新六位重建及加入/清理，公网隐藏而可信内网 3010 可见，不泄漏 sessionToken。完整 check 为 Web 151/151、桌面 213/213、静态响应 7/7，core/revival/reconnect 通过；Web 两资产与本地一致，gzip/immutable 及原更新源签名/三个小文件哈希/安装包头尾 206 Range 通过。

NAS 全部 updates 逐文件 SHA256、其他三个容器 ID/启动时间不变，证书与 FRP 未动。热修前 core/Web/compose 和旧镜像保存在私密备份 `/vol1/1000/docker/vds/ops/room-code-6-before`，可回滚。下方十二位私房验证保留为原始发布历史；本轮信令验收不代表实际跨运营商媒体连通。

## 2026-10-08：1.7.3 已发布并部署

发布源码 `c4ebf0a` 已推 GitHub master，`v1.7.3` 标签对应同一源码；[GitHub Release](https://github.com/M4rkzzz/VDS/releases/tag/v1.7.3) 的安装包、blockmap、清单及签名四份资产大小/digest 与本地一致。默认 HTTPS 更新源先切至 1.7.3，原始签名、三个小文件哈希、安装包头尾 Range 和旧 1.7.2 真实 NsisUpdater 识别新版本均通过，再部署 NAS 服务。

NAS 使用 `vds-signaling:1.7.3`，preflight 双后台 scope 通过后仅替换 VDS 容器。原 compose 端口、3 秒房主宽限和 updates 只读挂载保留，其他三个容器 ID/启动时间不变。旧部署连同 updates 私密备份至 `/vol1/1000/docker/vds/ops/release-1.7.3-before`，旧安装包未清理，证书和 FRP 未改动。

公网 `/api/version` 为 1.7.3，Web 两个构建资产与源文件一致，gzip/immutable 及更新清单/签名 no-store 通过。公网严格 TLS 与内网 3000 的建房、加入、两跳 offer/answer/ICE、房主/观看者恢复、伪造 token 拒绝、公开拓扑和退出清理通过；自有 12 位私房在公网 public-rooms 中隐藏、可信内网 3010 all-rooms 可见，两处不泄漏 sessionToken，主动离开后房间已删除。这些是信令与部署验证，真实跨运营商 P2P、WGC GPU 和长时物理音画仍待验收；不新增运行配额，Windows 安装包仍无 Authenticode 签名。

## 部署内容

`server/` 的 `package.json`、锁文件、`index.js`、`server-core.js`、`Dockerfile`、`.dockerignore`、完整 `public/` 和 `updates/` 构成部署目录。

Git 不包含 `public/vds_web/` 和 `updates/`。从 Git 更新时，需要先构建 Web 观看端，并保留原部署的更新目录。不能仅克隆仓库就直接替换线上目录。

`npm run prepare-server-release` 用于发布新安装包，会更新 manifest 并按保留策略清理历史安装包。单纯恢复信令和后台时不要运行它；已有更新源应先备份并核对哈希。

## 配置与入口

| 配置或入口 | 用途 |
| --- | --- |
| `3000` | 信令 WebSocket、公开 API、Web 页面、更新文件和 `/admin` |
| `3010` | 独立管理页面及管理 API；仓库默认只映射宿主本机 |
| `ADMIN_HOST=0.0.0.0` | Docker 内管理服务的监听地址 |
| `ICE_SERVERS_JSON` | 可选 STUN 配置；服务端过滤 TURN 地址 |

管理页面和 API 无需管理令牌，直接读取房间与拓扑。接口只读、响应禁止缓存，快照不包含房主或观看者的会话令牌；恢复房间连接仍需合法会话身份。1.7.3 已将公网 3000 的管理快照限制为公开房间（`scope=public-rooms`），3010 保留全量视图（`scope=all-rooms`），因此 3010 只向本机或可信内网提供。保留旧部署所需的环境参数；需要内网直接访问 3010 时，按原部署调整宿主端口映射。部署目录的 `.env` 不提交 Git，也不发送到 Docker 构建上下文。

当前新房固定 6 位，仅保留当前活动房间，不另设旧码兼容，现有桌面无需重装。1.7.3 原始部署的十二位房号与客户端优先迁移记录保留为历史；此次热修未重新发布桌面或切换更新源。

公网反代必须支持 WebSocket Upgrade。使用 FRP `https2http` 时，HTTPS/WSS 在 FRP 客户端终止 TLS，再转发到本机 3000。证书过期会同时影响默认桌面客户端和浏览器入口，不能只验证容器是否运行。

## 2026-10-08 静态响应优化（已随 1.7.3 部署）

1.7.3 使用 compression 1.8.2，压缩级别 4、阈值 1 KiB，仅压缩适用文本响应。`/updates`、安装包、blockmap、Range/206 和 SSE 不压缩，更新清单及签名保持原始内容。

仅 `vds_web/assets/` 内匹配构建 hash 命名的资源返回 `public, max-age=31536000, immutable`；HTML、`latest.yml` 和 `latest.yml.sig` 返回 `no-store`。普通静态文件不会因带查询参数就获得一年缓存；部署应同时更新 HTML 与其引用的 assets，不能给更新目录统一添加 immutable。

发布前本地构建的实际 gzip 响应为 JS 97,293 → 28,428 字节、CSS 7,045 → 2,247 字节，7 项静态响应回归通过。此结果只说明对应文本传输体积；没有改变 WebSocket 信令或客户端 P2P 媒体传输。线上已验证新 assets 的 gzip 与缓存策略。

Docker 用 `COPY --chown=node:node` 设置部署文件属主，去掉后续递归 `RUN chown`，保留 `USER node`。根目录 Express/ws 仅用于开发；`server/package.json` 仍将 Express、ws 和 compression 作为生产依赖，容器继续执行 `npm ci --omit=dev`。这些改动已随 1.7.3 发布部署，不新增连接、码率或运行时长配额。

此前 235,375,656 字节的本地 1.7.2 包仅为优化验证基线，未覆盖线上同版本资产。正式 1.7.3 安装包为 235,378,402 字节，已通过离线签验、40 个 ASAR 源文件与范围检查、原生 runtime 一致性及实际安装启动退出，哈希见 [项目现状](PROJECT_STATUS.md)。

## 恢复顺序

1. 记录旧容器、镜像、compose、环境和 FRP 配置，备份部署目录、更新源、证书与私钥；保护备份目录的访问权限。
2. 更新服务端代码、锁文件和完整 Web 构建产物。后台直接访问，删除旧部署中已无用途的 `ADMIN_TOKEN` 配置。
3. 只构建和启动 VDS 对应的 compose 服务，保留更新源并设置 `restart: unless-stopped`。确认穿透的自动启动配置。
4. 验证内网服务，再验证严格证书校验下的公网 HTTPS/WSS。证书替换必须保留原属主、权限及 NAS 的 ACL，并重新加载实际使用证书的 FRP 代理。
5. 从公网运行真实建房、加入、offer/answer/ICE 转发、观看者与房主重连、后台拓扑和退出清理测试。完成后核对旧更新文件哈希与其他容器状态。

## 验收端点

`/api/version`、`/api/config`、`/api/public-rooms`、`/vds_web/` 及其引用的 JS/CSS 应正常响应。`/admin` 应自动读取 `/api/admin/rooms`，无凭据访问返回 200；新版本确认该接口不会枚举非公开房号、节点或 manifest。独立管理端口对应 `/` 与 `/api/rooms`，同样直接访问，保留全量视图。

仅测试 HTTP 页面或临时跳过 TLS 验证不能证明公网入口已恢复。浏览器播放能力、实际媒体传输和跨运营商 P2P 连通仍需独立验收。

## 离线更新签名（1.7.3 起）

2026-10-08 源码新增 `latest.yml.sig`，使用项目外离线 Ed25519 私钥签署原始清单。发布主流程继续使用 `npm run build:release`；`prepare-server-release` 在本地 staging 签名和验包，`release:check` 核验包内公钥及两处产物，`release:github` 上传安装包、blockmap、清单和签名共四份资产。仅准备本地文件可运行 `node scripts/update-signature.js sign --dir dist` 和 `verify --dir dist`，不能直接对 live 更新目录运行 staging 脚本。

本机私钥位于 `%LOCALAPPDATA%\VDS\release-signing\release-ed25519-private.pem`，目录 ACL 仅当前用户与 SYSTEM；公钥位于 `desktop/update-trust.json`。私钥应另做受保护的离线备份，不进入 Git、安装包或 NAS。换钥需要通过已有信任链先分发包含新公钥的客户端，不能只替换服务器文件。

部署更新源时，先完整上传安装包与 blockmap，再切换匹配的一对 `latest.yml` / `latest.yml.sig`，保留可恢复旧文件。新客户端缺签名或清单/包不匹配时仅拒绝更新，不阻断正常启动与媒体播放。1.7.3/1.7.4 客户端停用差分，先全量迁移一次；1.7.5 起使用认证基线和地图的差分链路，缺失基线或失败自动全量，取消不回退。Windows Authenticode 仍未配置。已经发布的 1.7.2 不含新公钥，首次迁移仍须可信分发，不能宣称旧包已受新签名保护。

以下为 1.7.3 阶段的历史复核，当前修复见 1.7.5 章节：当时真实 NsisUpdater 的正常下载、篡改拒绝、取消重试和有效缓存通过，但已复现坏包缓存后的同进程重试需重启才重新下载，安装拒绝仍有效，已发布桌面代码尚未修复。本机缓存 `installer.exe` 是 235,378,402 字节的 1.7.3，`current.blockmap` 仍描述 239,871,320 字节的 1.7.2，基线不配对；当前禁差分不受影响，按现有实现直接重新开启会使用错配基线拼包，校验失败后回退全量。恢复差分前需绑定 installer/map 的版本与哈希，认证地图并校验边界，当前未实现这些恢复条件。公网旧 1.7.2/新 1.7.3 地图及 206 Range 均可读；静态差分计划为 9 个 Range、2,188,956 字节，加两份地图共 2,670,939 字节，约为全量的 1.135%。这只是算法计划，未执行差分，不是实测下载流量。

发布准备脚本的 `copyVersionedArtifacts` 仍会把本地重建的同版本旧 blockmap 覆盖到 staging 更新目录。当前本地 1.7.2 地图对应 235,375,656 字节的重建包，公网正式旧地图对应 239,871,320 字节，二者不能混用；本轮已逐文件确认线上旧地图未被覆盖。后续发布应保护正式旧发行地图的原字节，不能用同版本重建文件替代。旧 1.7.2 客户端仍可能尝试差分；新版禁差分不代表旧客户端同样禁用。

## HTTPS 证书渠道

现有 PassNAT 免费域名支持添加用于验证的 TXT 记录，说明见 [PassNAT HTTPS 文档](https://doc.passnat.com/docs/app/https/)。本轮通过该渠道完成 Let’s Encrypt DNS-01 签发，继续使用原有 FRP `https2http` 配置，无需开放公网 80 端口或切换挑战代理。

申请时读取 PassNAT 本地连接器已有的服务凭据，选择与 `_acme-challenge.<域名>` 匹配的最长根域名，将相对记录名和 ACME 验证值提交为 TXT。至少两家公共 DNS 查询返回匹配值后再提交验证。平台的验证 TXT 会自动过期，无需删除域名。

ACME 账户、证书私钥和服务凭据保存在受限目录，不属于 VDS 管理令牌，也不提交 Git 或分发给客户端。新证书必须先核对域名、私钥配对、完整证书链和有效期，再保留原文件 ACL 原子替换，重新加载对应 FRP 代理并严格验证公网 TLS。

恢复主机已配置 `/etc/cron.d/vds-cert-renew`，每天主机当地时间 04:17 执行一次 `ops/vds-renew-dns.py`。证书剩余超过 21 天时直接退出，不调用 API、不重启代理；进入续期窗口后复用 `ops/dns-renew-state/production` 的既有 ACME 账户完成 DNS-01。正常运行和 `--check` 的未到期分支、离线自测均已在 NAS 验证；实际到期续期尚未发生。

任务没有常驻进程，只有证书成功签发、校验和安装后才重载 VDS 对应代理。签发失败保留原服务；安装后重载或公网校验失败时回滚证书和原配置。日志在 `ops/dns-renew.log`，续期结果在 `ops/dns-renew-state/last-result.json`；首次续期前不会生成该结果文件。运维脚本与 cron 备份位于 `ops/renewal-tools-20261007.tar.gz`，运维目录、账户和日志保持私有访问权限。
