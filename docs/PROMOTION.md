# Bridge 推广手册

## 定位

Bridge 是开源、端到端加密的 Claude Desktop 手机遥控。当前分支专注
macOS + Android + Claude Desktop（含 Claude-3p），会话执行、队列和权限由 Desktop 管理。
独立 Codex、Hermes、DSH 适配及跨 Agent 接力已下线。

## 目标人群

- 离开电脑后仍需继续 Claude 会话、查看任务和处理授权的人。
- 希望自行托管中继，并保留本机账号与工作区设置的人。
- 使用 Claude Desktop 内部模型和 Magpie 额度功能的人。

## 演示内容

1. 手机扫描电脑二维码，建立加密配对。
2. 打开已有会话、查看原生历史和任务状态。
3. 排队下一条指令，或使用原生 Fork 继续分支工作。
4. 处理授权与提问，查看成果和附件。
5. 展示断线重连、收据和事件恢复；不自动重发不确定的输入。

## 对外描述草稿

**中文**：在 Android 手机上继续电脑里的 Claude 工作。

**英文**：Open-source, end-to-end encrypted phone remote for Claude Desktop.

仓库与下载：https://github.com/Lycidas97/claude-desktop-bridge

建议 Topics：`claude-desktop`、`electron`、`android`、`webrtc`、
`end-to-end-encryption`、`remote-control`、`typescript`、`selfhosted`。

可发布到 Claude、Android 和自托管相关社区。配 15–30 秒演示，链接到本 fork 的
README、Releases、架构和安全文档。历史 OpenAI 申请材料另见
[归档草稿](OPENAI-OPEN-SOURCE.md)，其中旧多 Agent 能力不代表当前支持范围。

## 必须准确表达的边界

- Claude Desktop 是执行权威，Bridge 转发原生操作和事件。
- 手机与电脑间正文端到端加密；Relay 可见路由元数据与密文。
- macOS 可通过辅助功能和 System Events 自动化权限，按 Desktop 进程尝试一次原生调试菜单；需要本机 Node inspector。
- 不提取账号 OAuth，不复制凭据，不合并历史，不启动第二套执行器。
- 验证覆盖以本仓库报告为准；不要把合成测试写成真实模型执行验收。
