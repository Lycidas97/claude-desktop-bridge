# 自建 Bridge Relay

本 fork 推荐 **只部署中继和 TLS 反向代理**，由 Android 客户端连接电脑端 Bridge，不公开 WebUI。

完整步骤见 [自建中继指南](../docs/RELAY-REDEPLOY.md)：从 fork 源码构建镜像、自动 TLS、持久化数据、两端地址、健康与 WSS 协议探测，以及备份和升级。

| 文件 | 用途 |
| --- | --- |
| [relay.Dockerfile](relay.Dockerfile) | Node.js 22 多阶段构建，编译协议和 Relay，不构建 Web 或桌面端 |
| [relay.Dockerfile.dockerignore](relay.Dockerfile.dockerignore) | 中继构建的源码上下文清单 |
| [relay-only.compose.yml](relay-only.compose.yml) | 首次自建的独立方案，仅 Relay + Caddy，公网 TCP 80 / 443 |
| [relay-only.env.example](relay-only.env.example) | 自己的域名、原生来源和帧预算示例 |
| [relay-only.Caddyfile](relay-only.Caddyfile) | 自动 TLS，只代理 `/ws`、`/health`、`/ready`，其他路径 404 |

在仓库根目录创建并编辑 `.env` 后：

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml config --quiet
```

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml build relay
```

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml up -d
```

Relay 的 8788 仅供 Docker 内部网络使用。数据库和备份位于 Relay 数据卷，证书另存 Caddy 数据卷。已有部署应先确认原卷与反向代理，再迁移，不直接覆盖配置或创建空卷替代原数据。

## 其他部署文件

仓库根 `docker-compose.yml`、`deploy/relay.compose.yml`、`Caddyfile` 和 `relay.nginx.conf.template` 保留上游 Web / 多服务部署方式，不是本 fork 的仅中继入口。不要在只需 Android 接入的服务器上直接启动这些配置的全部服务。

已有反向代理、Cloudflare Tunnel 或自建 STUN / TURN 可以继续复用；需自行将 `/ws`、`/health`、`/ready` 转到 Relay，并保留 WebSocket 升级和持久化数据。具体运行域名、IP、SSH 密钥路径与隧道凭据不作为公共部署示例。
