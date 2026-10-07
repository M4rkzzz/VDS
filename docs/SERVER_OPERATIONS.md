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
| `ADMIN_TOKEN` | 后台页面输入的管理令牌；未配置时管理 API 返回 503 |
| `ADMIN_HOST=0.0.0.0` | Docker 内管理服务的监听地址 |
| `ICE_SERVERS_JSON` | 可选 STUN 配置；服务端过滤 TURN 地址 |

管理 API 使用 `Authorization: Bearer <ADMIN_TOKEN>`。令牌放在部署目录的 `.env`，不提交 Git，也不发送到 Docker 构建上下文。保留旧部署所需的环境参数；需要内网直接访问 3010 时，按原部署调整宿主端口映射。

公网反代必须支持 WebSocket Upgrade。使用 FRP `https2http` 时，HTTPS/WSS 在 FRP 客户端终止 TLS，再转发到本机 3000。证书过期会同时影响默认桌面客户端和浏览器入口，不能只验证容器是否运行。

## 恢复顺序

1. 记录旧容器、镜像、compose、环境和 FRP 配置，备份部署目录、更新源、证书与私钥；保护备份目录的访问权限。
2. 更新服务端代码、锁文件和完整 Web 构建产物。管理令牌存在时沿用，不存在时生成独立令牌。
3. 只构建和启动 VDS 对应的 compose 服务，保留更新源并设置 `restart: unless-stopped`。确认穿透的自动启动配置。
4. 验证内网服务，再验证严格证书校验下的公网 HTTPS/WSS。证书替换必须保留原属主、权限及 NAS 的 ACL，并重新加载实际使用证书的 FRP 代理。
5. 从公网运行真实建房、加入、offer/answer/ICE 转发、观看者与房主重连、后台拓扑和退出清理测试。完成后核对旧更新文件哈希与其他容器状态。

## 验收端点

`/api/version`、`/api/config`、`/api/public-rooms`、`/vds_web/` 及其引用的 JS/CSS 应正常响应。`/admin` 应能输入令牌并读取 `/api/admin/rooms`；无令牌和错误令牌应返回 401。独立管理端口对应 `/` 与 `/api/rooms`。

仅测试 HTTP 页面或临时跳过 TLS 验证不能证明公网入口已恢复。浏览器播放能力、实际媒体传输和跨运营商 P2P 连通仍需独立验收。
