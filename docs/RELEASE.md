# Bridge 1.3 发布手册

## 版本与源码

发布目标为本 fork：`Lycidas97/claude-desktop-bridge`。根包、全部 npm workspace、`package-lock.json`、Android `versionName` 和 iOS `MARKETING_VERSION` 必须一致。1.3 使用 `1.3.0`；Android `versionCode` 必须高于已分发的 117，iOS 构建号同步递增。

所有平台产物必须来自同一发布提交。不要把本机 `output/`、测试 `artifacts/`、嵌套工作树、设备配置、配对链接、凭据或本机签名材料提交到仓库。

Claude Desktop 的 `LocalSessions` API 是 Claude 会话、执行、队列和权限的唯一权威。发布不得恢复旧 SDK/CLI Host、接管/交还、inbox 或执行 lane。协议 V3、配对配置 V4、电脑和设备身份、手动中继配置及已有用户数据必须保留。

## 发布闸门

使用 `.nvmrc` 指定的 Node.js 26。依赖安装与验证入口分开执行：

```bash
npm ci
```

```bash
npm run test:infra
```

```bash
npm run verify
```

```bash
npm run test:browser
```

```bash
npm run audit:runtime
```

验证入口通过 `scripts/recycle-cleanup.cjs` 将临时文件清理转到系统废纸篓或回收站：macOS 使用 `/usr/bin/trash`，Linux 需安装 `trash-cli`，Windows 使用 PowerShell 的回收站接口。自定义 Node 测试或构建命令应通过 `npm run ci:run -- …` 运行。

自动化使用隔离数据目录、合成 Native 边界和本地 Relay。不能为发布验收向真实用户会话发送模型输入、撤回真实队列消息、执行真实回退，或替换生产 Native stream。模拟测试只能证明对应接口与数据流，不能替代真实 Desktop 或手机验收。

## GitHub 发布流程

1. 在独立工作树发布分支整理源码、同步版本号与 `CHANGELOG.md`，在本地通过 `npm run ci:local` 完成全平台预检（Mac + Windows 11 + Android 16 WHPX + WSL2 Ubuntu-24.04 Linux 单测与打包），再推送到 `origin`（`Lycidas97/claude-desktop-bridge`；若先验后推，执行 `npm run ci:local -- --publish` 回写 `ci/local-distributed = success`）并创建指向 `main` 的 PR（严禁推送到 `upstream` `czhmartinez/claude-desktop-bridge`）。
2. 确认审查与 `ci/local-distributed` 绿勾无误后，使用 `gh pr merge <pr-number> --repo Lycidas97/claude-desktop-bridge --squash --match-head-commit <reviewed-sha>` 合并到 `main`。
3. 检出最新 `main`：若 Squash Merge 后的 `HEAD^{tree}` 与已验证提交一致，可直接运行 `npm run ci:local -- --publish` 将验证状态晋升回写到 `main` 目标提交（否则在 `main` 上重新运行 `npm run ci:local`，或通过 `gh workflow run ci.yml --ref main` 手动运行线上全矩阵兜底 CI）。
4. `main` 提交获得 `ci/local-distributed == "success"`（或手动 `CI` 工作流 `completed` + `success`）后自动触发 `release.yml`。`release.yml` 与 `release-assets.yml` 均强制校验目标 40 位 SHA 属于 `origin/main` 祖先且具备最新 `ci/local-distributed == "success"` 状态（或已完成的成功 `main` `CI` 运行），被取消、未完成或非 `main` 分支运行一律无效。
5. 所有平台资产统一在 GitHub Actions 洁净环境中基于同一锁定修订构建。任一必要 job 失败时保留草稿，不公开残缺发布；修复后通过工作流重跑。
6. 全部资产成功后由工作流发布。不要绕过版本校验、单独手动创建 tag，或把先前版本的安装包改名上传。

具体 job 结果、构建提交与产物哈希以 GitHub Actions 为准。无签名或未签名设备包必须在文件名和发布说明中保留 `ci`、`adhoc` 或 `unsigned` 标记。

## Windows

Windows 安装包必须在 Windows runner 或 Windows 本机构建：

```bash
npm run ci:run -- run make:windows
```

```bash
npm run ci:run -- run test:desktop:packaged:windows
```

`electron-builder` 使用 NSIS 生成 `apps/desktop/out/make/nsis.windows/x64/Bridge-<version>-Setup.exe`。验收必须实际安装到非默认目录，确认 `bridge.exe` 位于所选目录，再以隔离 profile 和本地 Relay 验证 preload、`file://` 页面、Native 能力声明、加密配对、请求响应和设备撤销。

测试的 `BRIDGE_RELAY_URL` 和 `BRIDGE_PUBLIC_RELAY_URL` 都应明确指向本地测试 Relay。Windows 上空环境变量可能被删除，不能依靠空字符串阻止回落到安装包默认公网中继。

支持可选 Authenticode：CI 使用 `BRIDGE_WIN_CERTIFICATE_BASE64` 与 `BRIDGE_WIN_CERTIFICATE_PASSWORD`；本机可使用 `BRIDGE_WIN_CERTIFICATE_FILE`，或 electron-builder 的 `WIN_CSC_LINK` 与 `WIN_CSC_KEY_PASSWORD`。证书和密码不得入库。没有有效证书时明确标记为未签名 CI 验收包，不宣称已经过 Authenticode 验证。

GitHub 托管的 Windows runner 可能不支持回收站目录操作，因此打包 QA 保留三个隔离临时目录并在日志中输出路径，不尝试删除。本机和自托管 runner 继续使用系统回收站；失败时报告原因和剩余路径，不回退到永久删除。

Windows 编译、安装和配对通过，不代表真实 Claude Desktop、DPAPI 跨重启、托盘、开机启动及手机网络切换都已完成实机验收。macOS 的 inspector 进程路径监测 helper 不在 Windows 上启用。

## macOS 与 Linux

macOS 正式签名需要有效 Developer ID 和对应公证条件。没有这些材料时，工作流使用明确标记的 ad-hoc CI 包；本机自签身份不能替代 Apple 正式分发身份，也不能打包私钥上传。

```bash
npm run ci:run -- run make:adhoc -w @bridge/desktop
```

验证应用的主进程、preload、前端资源、Native helper 解包位置和代码签名。打包态验收使用独立数据目录；不要覆盖或清空真实 Bridge 配置来跑测试。

Linux 在 Linux runner 构建 ZIP/DEB/RPM，需要 `rpm`、`fakeroot`、`dpkg` 和 `trash-cli`。没有仓库签名、打包态 UI 和托盘实机验收时，只报告已完成的构建范围。

## Android 与 iOS

Android 使用 JDK 21 和 Android SDK，沿用仓库固定调试签名，确保既有 APK 可覆盖升级：

```bash
npm run ci:run -- run build:android:debug
```

检查包名 `com.localbridge.mobile`、版本号和构建号、签名指纹、全部前端资源、原生 Capacitor 插件注册、DEX 完整性，以及没有开发服务器 URL。发布文件需记录 SHA-256，上传后应下载回验。

iOS 保留模拟器与未签名设备构建：

```bash
npm run ci:run -- run build:ios:simulator
```

```bash
npm run ci:run -- run build:ios:device
```

未签名设备 `.app` 不是可直接安装的 IPA。正式设备分发仍需要 Apple Developer、Team、证书、provisioning profile 和推送配置。

## 1.3 功能验收重点

- 原生 UUID、命令收据、幂等、rekey、终态、断线重连和历史重放；不得通过重发输入模拟队列动作。
- Send now、撤回和回退分别使用原生方法；预览无 mutation，执行前重新检查资格，部分成功如实报告。
- 回退已成功后读取断连仍返回原文；文件恢复与对话恢复保持独立资格和正确顺序。
- 历史分页与媒体延迟加载、流式上翻保位、工具名称与参数、计划和子代理历史。
- 实时权限与提问、草稿与附件的电脑/会话隔离、/btw、在线通知、模型与 Magpie 额度。
- 加密配对、分块传输、手动中继优先级、设备撤销与升级前后身份保持。

常规套件中的未确认冲突证据探针应保持显式启用，并单独记录结论；不能把它们的跳过解释为真实 Native 已验证通过。
