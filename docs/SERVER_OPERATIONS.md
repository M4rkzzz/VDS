# VDS 服务端恢复与维护

信令、公开房间、Web 观看端和管理后台由同一个 Node.js 服务提供。服务器只传递信令与拓扑，音视频仍由客户端纯 P2P 传输，禁止 TURN。Docker 基础运行时为 Node 22.23.3 / Alpine 3.24。

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

管理页面和 API 无需管理令牌，直接读取房间与拓扑。接口只读、响应禁止缓存，快照不包含房主或观看者的会话令牌；恢复房间连接仍需合法会话身份。保留旧部署所需的环境参数；需要内网直接访问 3010 时，按原部署调整宿主端口映射。部署目录的 `.env` 不提交 Git，也不发送到 Docker 构建上下文。

公网反代必须支持 WebSocket Upgrade。使用 FRP `https2http` 时，HTTPS/WSS 在 FRP 客户端终止 TLS，再转发到本机 3000。证书过期会同时影响默认桌面客户端和浏览器入口，不能只验证容器是否运行。

## 恢复顺序

1. 记录旧容器、镜像、compose、环境和 FRP 配置，备份部署目录、更新源、证书与私钥；保护备份目录的访问权限。
2. 更新服务端代码、锁文件和完整 Web 构建产物。后台直接访问，删除旧部署中已无用途的 `ADMIN_TOKEN` 配置。
3. 只构建和启动 VDS 对应的 compose 服务，保留更新源并设置 `restart: unless-stopped`。确认穿透的自动启动配置。
4. 验证内网服务，再验证严格证书校验下的公网 HTTPS/WSS。证书替换必须保留原属主、权限及 NAS 的 ACL，并重新加载实际使用证书的 FRP 代理。
5. 从公网运行真实建房、加入、offer/answer/ICE 转发、观看者与房主重连、后台拓扑和退出清理测试。完成后核对旧更新文件哈希与其他容器状态。

## 验收端点

`/api/version`、`/api/config`、`/api/public-rooms`、`/vds_web/` 及其引用的 JS/CSS 应正常响应。`/admin` 应自动读取 `/api/admin/rooms`，无凭据访问返回 200。独立管理端口对应 `/` 与 `/api/rooms`，同样直接访问。

仅测试 HTTP 页面或临时跳过 TLS 验证不能证明公网入口已恢复。浏览器播放能力、实际媒体传输和跨运营商 P2P 连通仍需独立验收。

## HTTPS 证书渠道

现有 PassNAT 免费域名支持添加用于验证的 TXT 记录，说明见 [PassNAT HTTPS 文档](https://doc.passnat.com/docs/app/https/)。本轮通过该渠道完成 Let’s Encrypt DNS-01 签发，继续使用原有 FRP `https2http` 配置，无需开放公网 80 端口或切换挑战代理。

申请时读取 PassNAT 本地连接器已有的服务凭据，选择与 `_acme-challenge.<域名>` 匹配的最长根域名，将相对记录名和 ACME 验证值提交为 TXT。至少两家公共 DNS 查询返回匹配值后再提交验证。平台的验证 TXT 会自动过期，无需删除域名。

ACME 账户、证书私钥和服务凭据保存在受限目录，不属于 VDS 管理令牌，也不提交 Git 或分发给客户端。新证书必须先核对域名、私钥配对、完整证书链和有效期，再保留原文件 ACL 原子替换，重新加载对应 FRP 代理并严格验证公网 TLS。

恢复主机已配置 `/etc/cron.d/vds-cert-renew`，每天主机当地时间 04:17 执行一次 `ops/vds-renew-dns.py`。证书剩余超过 21 天时直接退出，不调用 API、不重启代理；进入续期窗口后复用 `ops/dns-renew-state/production` 的既有 ACME 账户完成 DNS-01。正常运行和 `--check` 的未到期分支、离线自测均已在 NAS 验证；实际到期续期尚未发生。

任务没有常驻进程，只有证书成功签发、校验和安装后才重载 VDS 对应代理。签发失败保留原服务；安装后重载或公网校验失败时回滚证书和原配置。日志在 `ops/dns-renew.log`，续期结果在 `ops/dns-renew-state/last-result.json`；首次续期前不会生成该结果文件。运维脚本与 cron 备份位于 `ops/renewal-tools-20261007.tar.gz`，运维目录、账户和日志保持私有访问权限。
