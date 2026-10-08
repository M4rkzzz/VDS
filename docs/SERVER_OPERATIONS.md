# VDS 服务端恢复与维护

信令、公开房间、Web 观看端和管理后台由同一个 Node.js 服务提供。服务器只传递信令与拓扑，音视频仍由客户端纯 P2P 传输，禁止 TURN。Docker 基础运行时为 Node 22.23.3 / Alpine 3.24。

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

新服务端生成 12 位房号，仍接受旧 6 位房号。本轮已先发布支持 12 位输入的 1.7.3 桌面再部署服务端；旧版 1.7.2 桌面手动输入最多 6 位，需要升级才能手动加入新房，不能只靠旧房号兼容测试认定旧桌面完全兼容。

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

部署更新源时，先完整上传安装包与 blockmap，再切换匹配的一对 `latest.yml` / `latest.yml.sig`，保留可恢复旧文件。新客户端缺签名或清单/包不匹配时仅拒绝更新，不阻断正常启动与媒体播放。差分更新停用，客户端下载完整安装包；Windows Authenticode 仍未配置。已经发布的 1.7.2 不含新公钥，首次迁移仍须可信分发，不能宣称旧包已受新签名保护。

## HTTPS 证书渠道

现有 PassNAT 免费域名支持添加用于验证的 TXT 记录，说明见 [PassNAT HTTPS 文档](https://doc.passnat.com/docs/app/https/)。本轮通过该渠道完成 Let’s Encrypt DNS-01 签发，继续使用原有 FRP `https2http` 配置，无需开放公网 80 端口或切换挑战代理。

申请时读取 PassNAT 本地连接器已有的服务凭据，选择与 `_acme-challenge.<域名>` 匹配的最长根域名，将相对记录名和 ACME 验证值提交为 TXT。至少两家公共 DNS 查询返回匹配值后再提交验证。平台的验证 TXT 会自动过期，无需删除域名。

ACME 账户、证书私钥和服务凭据保存在受限目录，不属于 VDS 管理令牌，也不提交 Git 或分发给客户端。新证书必须先核对域名、私钥配对、完整证书链和有效期，再保留原文件 ACL 原子替换，重新加载对应 FRP 代理并严格验证公网 TLS。

恢复主机已配置 `/etc/cron.d/vds-cert-renew`，每天主机当地时间 04:17 执行一次 `ops/vds-renew-dns.py`。证书剩余超过 21 天时直接退出，不调用 API、不重启代理；进入续期窗口后复用 `ops/dns-renew-state/production` 的既有 ACME 账户完成 DNS-01。正常运行和 `--check` 的未到期分支、离线自测均已在 NAS 验证；实际到期续期尚未发生。

任务没有常驻进程，只有证书成功签发、校验和安装后才重载 VDS 对应代理。签发失败保留原服务；安装后重载或公网校验失败时回滚证书和原配置。日志在 `ops/dns-renew.log`，续期结果在 `ops/dns-renew-state/last-result.json`；首次续期前不会生成该结果文件。运维脚本与 cron 备份位于 `ops/renewal-tools-20261007.tar.gz`，运维目录、账户和日志保持私有访问权限。
