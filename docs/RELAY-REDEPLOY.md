# 自建 Bridge 中继

本指南使用本 fork 的源码构建 Relay，由 Caddy 自动申请和续期 HTTPS 证书。服务器运行 **Relay + TLS 反向代理**，不部署 WebUI。电脑和 Android 客户端连接同一个 `wss://你的域名/ws`。

部署模板随本仓库 `main` 维护。下面的克隆命令取得当前模板；若改用某个 Release tag，请先确认该 tag 包含 `deploy/relay-only.compose.yml`。

## 准备

- 一台 Linux 服务器，已安装 Docker Engine 与 Docker Compose v2 或更新版本。
- 一个自己的域名，A / AAAA 记录指向该服务器。配置 IPv6 时，也要保证对应地址可达。
- 公网 TCP **80、443** 可达，且没有其他服务占用它们。80 用于证书申请与 HTTPS 跳转，443 用于 WSS。

Relay 的 **8788 只在 Docker 网络内使用**，不映射到宿主机。最小方案不运行 Web、STUN 或 TURN 服务；直连不可用时使用加密 WSS 中继。已有 Nginx / Caddy 的服务器应复用现有反向代理，不要再启动一套争用 80 / 443 的 Caddy。

## 首次安装

以下操作从一个新的源码目录开始；已有部署的升级与数据迁移见后文。

```bash
git clone --branch main https://github.com/Lycidas97/claude-desktop-bridge.git bridge-relay
```

```bash
cd bridge-relay
```

记录本次源码提交，便于复查和回退：

```bash
git rev-parse HEAD
```

创建本地配置：

```bash
cp deploy/relay-only.env.example .env
```

编辑 `.env`，将 `BRIDGE_DOMAIN=relay.example.com` 改为你自己的域名。域名字段不带 `https://` 或 `/ws`。其余默认值可用于 Android + 电脑端；真实配置不提交到 Git。

| 参数 | 用途 |
| --- | --- |
| `BRIDGE_DOMAIN` | Caddy 申请证书和接收连接的域名 |
| `BRIDGE_ALLOWED_ORIGINS` | 来源配置，示例保留原生客户端来源；它不代替设备配对认证 |
| `BRIDGE_RELAY_IMAGE` | 本地构建的镜像名，默认 `bridge-relay:local` |
| `BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE` | 每连接帧预算，默认 6000；活跃流式会话需要保留足够预算 |

先检查配置，再构建源码镜像：

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml config --quiet
```

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml build relay
```

构建使用 [relay.Dockerfile](../deploy/relay.Dockerfile)：Node.js 26 LTS Alpine 多阶段镜像，先编译 `packages/protocol` 和 `apps/relay`，再生成运行镜像。服务器不需要另装 Node.js，也不需要构建 Android、Electron 或 Web 客户端。Dockerfile 专用上下文清单只发送根构建清单、协议和中继源码，不包含本机依赖、打包产物或 `.env`。

启动中继和 Caddy：

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml up -d
```

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml ps
```

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml logs --tail 80 relay caddy
```

Relay 就绪后 Caddy 启动并申请证书。首次申请需要域名、DNS 和公网 80 / 443 均已配置正确。

## 验证连接

下面示例中的 `relay.example.com` 均替换为自己的域名。

```bash
curl -fsS https://relay.example.com/health
```

```bash
curl -fsS https://relay.example.com/ready
```

两者应返回 HTTP 200。HTTPS 根路径和 `/metrics` 应为 404：该配置仅代理 `/ws`、`/health`、`/ready`。

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://relay.example.com/
```

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://relay.example.com/metrics
```

用仓库自带的协议探测脚本核验公网 WSS。脚本在 Relay 容器内执行，服务器不需要额外安装 npm 依赖：

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml \
  exec -T -e BRIDGE_RELAY_URL=wss://relay.example.com/ws relay \
  node --input-type=module < scripts/relay-contract-probe.mjs
```

预期输出 `ok: true`、当前协议的 `ROOM_NOT_FOUND` 和旧协议的 `UPGRADE_REQUIRED`。探测使用随机的不存在房间，不发送模型请求，也不使用真实配对凭据。只有健康接口通过而协议探测失败时，优先检查 TLS 和 WebSocket 升级链路。

## 配置电脑与 Android

在两端填写完全相同的中继地址，例如 `wss://relay.example.com/ws`：

1. **电脑 Bridge**：“状态”中的中继地址，保存并重连。
2. **Android**：“电脑 → 电脑行 ⋯ → 连接与电脑设置”中的中继地址，保存并重连。
3. 首次使用，通过电脑端的一次性二维码或配对链接添加电脑；已有配对迁移中继后继续使用原身份。
4. 确认电脑在线，再打开会话检查列表同步和连接诊断。

只改服务器地址不会自动改写两端已保存的中继设置。两端显式保存的地址优先于安装包默认值，升级保留手动配置。本方案不依赖上游公共中继。

FCM / APNs 系统推送需要单独配置服务凭据，最小模板未启用。前台通信通过现有加密连接完成；手机后台行为还受系统限制。需要 WebRTC 自建 STUN / TURN 时另行配置 ICE，WSS 中继本身不要求公开 3478。

## 数据、备份与升级

Compose 项目名固定为 `bridge-relay`，使用三个命名卷：

| 卷 | 内容 |
| --- | --- |
| `relay-data` | `/data/bridge-relay.db`、SQLite WAL 与 `/data/backups` |
| `caddy-data` | TLS 证书与 ACME 状态 |
| `caddy-config` | Caddy 运行配置 |

中继启动时和此后每天生成 SQLite 备份，保留最近七份。卷内备份仍在同一台服务器上，重要数据需另做离机备份。保留 Relay 数据卷才能延续既有房间、连接身份与离线队列；Caddy 证书卷同样应作为私有数据保管。

需要拷贝完整 Relay 数据时，先停止它，短暂断开连接；将整个 `/data` 复制到源码目录之外，再启动：

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml stop relay
```

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml cp relay:/data "../bridge-relay-backup-$(date +%Y%m%d-%H%M%S)"
```

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml start relay
```

升级前记录提交并备份数据；使用默认镜像名时，可保留当前镜像作为回退入口：

```bash
docker image tag bridge-relay:local bridge-relay:before-upgrade
```

```bash
git pull --ff-only
```

```bash
docker compose --env-file .env -f deploy/relay-only.compose.yml up -d --build relay
```

然后重新检查 `/health`、`/ready` 与 WSS 协议探测。更新容器继续使用原命名卷，不需要清空配对、数据库或队列。若需回退到保留的镜像：

```bash
BRIDGE_RELAY_IMAGE=bridge-relay:before-upgrade docker compose --env-file .env -f deploy/relay-only.compose.yml up -d --no-build relay
```

已有其他 Compose 项目或手动部署时，先确认原数据卷的名称和挂载路径。新模板默认创建自己的卷，不会自动发现旧卷；迁移应先备份、停止旧中继，再把新服务的 `relay-data` 映射到原卷。不要同时启动两个中继写同一份 SQLite。

## 排查

| 现象 | 检查 |
| --- | --- |
| Caddy 无法申请证书 | 域名的 A / AAAA、80 / 443、防火墙与端口占用；查看 Caddy 日志 |
| Relay 不健康 | Relay 日志、数据卷权限和磁盘空间；就绪检测使用容器内 `/ready` |
| HTTPS 正常，WSS 不通 | `/ws` 是否被代理，CDN 是否支持 WebSocket，两端 URL 是否含正确路径 |
| 手机显示电脑离线 | 两端是否使用同一中继，电脑后台服务是否运行，电脑端连接诊断 |
| 宿主机访问不了 8788 | 此模板只在 Docker 网络内开放该端口；从公网用 HTTPS / WSS 检查 |
| 网页根路径返回 404 | 符合预期，本方案未部署 WebUI |

配置文件入口见 [deploy](../deploy/README.md)，数据与权限边界见 [安全模型](SECURITY.md)。
