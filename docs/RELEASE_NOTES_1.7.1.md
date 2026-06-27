# VDS 1.7.1

本次发布已完成完整 Windows 安装包构建、更新源校验和 GitHub Release 发布。

## 下载

- `VDS-Setup-1.7.1.exe`：Windows 安装包
- `VDS-Setup-1.7.1.exe.blockmap`：差分更新 blockmap
- `latest.yml`：桌面自动更新 manifest

## 重点更新

- 完善 renderer/native authority 模块化后的稳定性，职责边界覆盖 app state、room client、UI、native session、peer、surface、diagnostics 和 P2P 状态机。
- 收紧 media-agent Host、Peer、Surface、Relay、Audio、OBS ingest 的 session/controller ownership，降低共享运行时状态带来的时序风险。
- 修复 native/OBS 开播、停止共享、重复开播、房间创建、房间号显示、公开房间发现和 stale manifest 清理问题。
- 修复 OBS ingest 音频和 AAC manifest，OBS 推流后可正确播放、转发并向下游发布 manifest。
- 改进源选择和 WGC 预览：缩略图异步加载，预览异常进入诊断路径，减少黑屏和预览初始化失败对主流程的影响。
- 强化 Web/native relay 拓扑：默认优先链式，上游不可达时由服务端重新选择上游，并限制单上游下游容量。
- 增强 Web 观看端移动浏览器支持：iOS Safari、Android Chrome 和其它 Android 浏览器的能力检测、诊断导出、codec/payload format 判断和 LAN HTTP 测试路径。
- 改进 3010 信令后台：实时展示房间、拓扑、节点/边状态、容量和 manifest。
- 移动 Web 真机诊断改为人工 QA 证据，不再作为自动发布硬门禁；仍保留单份诊断 JSON 的场景校验能力。

## 验证情况

本次发布构建已通过：

- `release:precheck`
- `check:vds-web`
- `test:vds-web`
- `check:web-mobile-diagnostics`
- `test:server`
- `check:architecture`
- `check:logging`
- `verify-media-agent`
- `npm audit --omit=dev`
- `npm --prefix server audit --omit=dev`
- `check-server-docker-context`
- Electron installer build
- `prepare-server-release`
- `release:check`
- GitHub Release asset upload

## 注意事项

- 当前安装包未配置代码签名证书，Windows 可能显示未知发布者提示。
- 移动 Web 真机表现仍建议按 `docs/WEB_MOBILE_DEVICE_QA.md` 做手工 QA，特别是 iOS Safari 音频、Android Chrome relay 和局域网 HTTP 场景。
- 构建产物 `dist/`、`runtime/`、`server/public/vds_web/` 和 `server/updates/` 不作为源码提交。
