# 个人助理架构 v5

本文定义个人助理的目标架构和分阶段验收条件。Bridge 负责接收邮件、同步待办与日历、展示状态并执行用户已批准的提案。Claude Desktop 负责会话执行、原生队列、工具权限与历史。用户可以手动引用邮件、上传文件和核对提案。外部事件自动投递默认关闭，须由用户在当前托管绑定中开启，并满足[运行时投递条件](SECURITY.md#外部邮件自动投递门禁)。[Issue 222 的用户决议](https://github.com/Lycidas97/claude-desktop-bridge/issues/222#issuecomment-7011727311)撤销了原实机启用门禁，实测结果及缺口仍保留。

## 交付顺序

| 阶段 | 交付边界 |
| --- | --- |
| [#213](https://github.com/Lycidas97/claude-desktop-bridge/issues/213) | 多账号收件、托管工作区装配、单顶栏与稳定输入栏。自动投递关闭 |
| [#222](https://github.com/Lycidas97/claude-desktop-bridge/issues/222) | 对实际交付的托管档位做工具与后台投递实机验收 |
| [#223](https://github.com/Lycidas97/claude-desktop-bridge/issues/223) | 收件入库后即可开发双端附件，独立于自动投递 |
| [#214](https://github.com/Lycidas97/claude-desktop-bridge/issues/214) | 托管绑定可选开启邮件事件触发，复用原生收据对账与批次卡。压缩命令的实测证据单独记录 |
| [#215](https://github.com/Lycidas97/claude-desktop-bridge/issues/215) · [#216](https://github.com/Lycidas97/claude-desktop-bridge/issues/216) | 同步待办与日程，再交付统一提案、确认和按后端执行 |
| [#217](https://github.com/Lycidas97/claude-desktop-bridge/issues/217) | 实测记忆文件能力、专职子代理与原生压缩归因，逐步启用维护 |

阶段 1–2 只为已交付的业务建表，记忆与偏好留到阶段 3。

## 数据与模块归属

| 归属 | 持有的数据与职责 |
| --- | --- |
| `service-runtime.ts` | 组装助理服务、窄工具网关和原生 broker，管理关闭、系统恢复与防挂起生命周期 |
| `plugins/assistant-mail/` | 复用 `assistant.sqlite` 存放账号关联、业务事件、绑定及后续触发批次、日程和提案。原始邮件存放在同级 `raw-mail/`，凭据由系统安全凭据后端管理 |
| Desktop 助理协调层 | 装配工作区、调用现有原生 broker、将业务变化接入快照与事件流。Controller 提供 RPC 路由、capability 汇总与发布 |
| `claude/` 与 `ConversationStateStore` | 单一 inspector 接入及原生投递收据。Desktop 提供会话、队列和 transcript 的权威状态 |
| `packages/protocol/` 与客户端 | 协议定义能力、请求与响应。客户端渲染业务投影、保留草稿和有界缓存，按 Host 隔离 |

新增能力通过现有 E2EE 通道发布。Relay 按设备转发密文，推送只发送 `bridge-wake`。已有邮件 RPC、`mailRefId` 和缓存键继续可读。业务变化在持久化后发布，重连通过现有快照和有界分页或事件恢复同步。[Bridge 架构](ARCHITECTURE.md) · [邮件插件契约](../plugins/assistant-mail/README.md)

## 托管会话与投递资格

现有 `plugin.assistant-mail.bind` 继续支持用户选择原生会话和手动引用邮件。托管初始化使用单独入口，展示将被信任的 `<userData>/private/assistant/workspace/`。用户确认后，宿主先写入受控的 `.mcp.json`、`.claude/settings.json` 和引导文件，再由现有原生建会话接口申请信任并创建会话。设置并核对原生权限模式后提交绑定。托管资格记录与 `nativeSessionId`、工作区物理路径和策略版本关联。归档或删除成功后保留历史引用并提示换绑。断连和暂时缺席分别展示 `unavailable` 和 `missing`，保留绑定记录。[现有绑定入口](../apps/desktop/src/controller/assistant-mail.ts#L160) · [原生会话创建](../apps/desktop/src/claude/claude-desktop-bridge.ts#L745)

Stage 1–2 的唯一托管档位为 `stage1-fenced-workspace`。内建 `Read / Glob / Grep` 默认只读工作区。主助理可通过 `Read / Glob / Grep` 读取用户在 **助理设置 → 可读目录** 明确授权的外部文件夹。守卫只接受当前托管主会话的授权，默认没有外部目录。`Write / Edit / MultiEdit` 仍只写 `outputs/`。配置、规则、上传文件对模型只读。守卫排除 `.mcp.json`，外部授权范围也排除 Bridge 数据目录及其上下级。授权目录中的普通文件可能包含凭据，例如 `.env`。原生 `@` 文件引用由项目级设置控制，见[目录权限边界](SECURITY.md#托管助理的搜索与只读目录)。主助理仅新增 `WebSearch`，搜索词会传给搜索服务；`WebFetch`、Shell、跨会话操作及继承的非助理 MCP 仍禁用。发信和提案执行仍需用户确认。`dontAsk` 控制权限问询，最终工具集合和受控路径由原生配置及守卫共同约束。Stage 3 若开放记忆写入，须按新档位重新过门禁。[阶段 0 实测](SECURITY.md#外部邮件自动投递门禁)

### 打包与工具网关

桌面构建复用 `buildMailMcp(outfile)`，将 `assistant-mcp.cjs` 与 `assistant-fs-guard.cjs` 一起输出到桌面 `dist/`。首选由 `process.execPath` 配合 `ELECTRON_RUN_AS_NODE=1` 启动，以 `app.getAppPath()` 解析 `app.asar/dist/`。macOS 和 Windows 以签名安装包、实际 Desktop 子进程启动结果为准。仅在托管项目内注册助理 MCP。

复用本机回环窄网关及 `private/assistant/mail-tools.json` 描述符。描述符的独立随机令牌留在宿主私有目录，适配器每次调用重读描述符。网关拒绝浏览器 Origin、鉴权后按工具契约校验请求。MCP 提供业务查询、分析状态更新和后续提案创建与修订。发信、提交审批、账号管理及 inspector 操作由各自宿主接口持有。按需读取的邮件、附件和外部日程文本附带 `untrusted_external` 及 `authorizesActions: false`。[现有网关](../plugins/assistant-mail/README.md#MCP-tools-and-local-authority)

### 启用条件

- `#213` 交付装配、邮箱配置和 UI，`automaticDelivery` 保持 `false`。围栏尚未通过实机验证时，托管会话只用于受控验收。收件、双端列表和旧绑定的手动入口可独立交付。
- `#222` 按 **`stage1-fenced-workspace`** 验收。目标版本、模型和最终合并配置以实际安装环境为准。验证工作区内读取与 `outputs/` 写入、工作区外和受控目录的拒绝、递归搜索范围、继承 MCP 与跨会话拒绝、子代理的实际权限，以及守卫缺失、异常和超时时的闭锁行为。守卫校验物理路径，新文件从最近的现存祖先解析，`Glob/Grep` 缺省路径按调用的 cwd 解析。验收覆盖递归结果集和原生 `@` 文件引用，因为文件引用可能在工具调用前展开。配置 `onFailure: "block"` 后实测失败行为。工具目录用于检测变化及告警，实测提供执行证据。
- `#214` 只在用户开启主动模式且绑定仍满足已验证的会话、档位和运行环境时提交。换绑、策略变化或能力失配后停止新的提交，保留业务数据与手动处理。已进入原生队列的消息沿用 Desktop 队列控制，界面显示其当前状态。

实机验收覆盖 Bridge 两种关窗路径后的新增投递、真实锁屏时间戳、原 UUID 断线对账。配对手机、安装包、目标模型和最终策略的实测记录入库。[装配 #213](https://github.com/Lycidas97/claude-desktop-bridge/issues/213) · [实机 #222](https://github.com/Lycidas97/claude-desktop-bridge/issues/222) · [Hook 失败语义](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails)

## 多邮箱收件与凭据

每个启用账号独立维护 TLS IMAP IDLE 连接、水位、重连和错误状态。保留原 `accountKey` 身份算法和 `(accountKey, mailbox, uidValidity, uid)` 去重键。迁移已有单账号配置时复用原 Keychain 项和已提交水位。首次启用或邮箱 UID 世代变化时从服务器当前水位开始，同世代重连补扫未收邮件。完整原文可读后才提交事件与水位。账号停用或移除只影响该账号，历史邮件仍可按原引用查询。凭据变更准备成功后再替换健康接收器。

账号配置在桌面与手机的助理设置中提供，由主机能力决定是否可编辑。macOS 使用 Keychain。未配备凭据后端的平台显示 `credentialsSupported: false`。账号列表与连接状态经现有 E2EE 通道同步，密码只用于配置请求与主机凭据后端，脱敏错误码用于界面与诊断。后台服务负责接收器生命周期，`resume` 补扫各启用源。防应用挂起只在产品明确需要持续工作的生命周期内持有，停用或后台服务退出时释放。系统睡眠期间的工作由唤醒后补扫恢复。[多邮箱与装配 #213](https://github.com/Lycidas97/claude-desktop-bridge/issues/213)

## 客户端与两类文件

助理页提供唯一顶栏，复用单个 `ConversationView`。切换对话、收件和日程时只替换中间阅读区。设置和待批全页可隐藏输入栏，并保留同一草稿和上传状态所有者。收件、日程、待批与设置使用发丝分隔行，提案确认放在流内或独立确认页。保留必要的账号、状态、错误与确认信息。当前页面会在离开对话子页时卸载会话视图。以「上传进行中 → 切到收件 → 切回 → 上传完成」和草稿保持验证新结构。[当前挂载点](../apps/client/src/components/assistant/AssistantPage.tsx#L118)

| 文件来源 | 存放位置和读法 |
| --- | --- |
| 用户上传与助理产物 | 图片通过现有原生消息附件提交，文件通过现有上传器写入托管会话 `.bridge-uploads/`。助理产物写入 `outputs/`，可走 `{ sessionId, path }` 做大小预检、分片下载及受支持的客户端查看。需要服务端 `artifact.preview` 的场景使用已有 `artifactId`，该 RPC 目前只接收 `artifactId` |
| 邮件附件 | 原始字节留在 `.eml`。独立的邮件附件 capability 通过 `{ mailRefId, attachmentId }` 提供元数据、大小预检、安全预览与有界分片租约。适配器可复用查看器和无状态图片处理。禁用 HTML 执行和外链加载。MCP 仅按需读取受支持附件的有界纯文本，返回不可信来源标记 |

邮件分页只取有界元数据。邮件附件沿用 20 MiB 传输上限和大文件预览确认，传输使用现有按设备隔离和临时密文交付语义。[文件 RPC](../apps/desktop/src/controller/controller-rpc.ts#L731) · [邮件附件 #223](https://github.com/Lycidas97/claude-desktop-bridge/issues/223)

## 外部事件投递

助理库保存事件和批次关联，原生收据库保存发送结果。用户启用主动模式后，新事件与其待提交记录由同一业务事务写入，去重键由来源和稳定标识确定。启用前的收件继续由用户手动处理。以首条待处理事件开始一个有界三秒合并窗口，到时固定 `batchId`、目标会话、`idempotencyKey` 和 `eventRefs[]`。提交文本只含宿主生成的批次号、事件类型和内部引用。主题、正文、发件人、附件名和日程备注留在按需读取接口中。

| 观察到的状态 | 助理侧动作 |
| --- | --- |
| 未调用 broker，Desktop 或门禁暂不可用 | 保留待提交。目标会话变更时暂停已选定目标的批次，交由用户决定是否处理 |
| 首次提交 | 先持久化批次和固定幂等键，再经同一个 `startTurn` 提交。空闲会话直接接收，忙碌会话由原生 `later` 排队 |
| `submitting` 跨进程重启 | 按 `idempotencyKey` 查原生持久化收据。命中就补记原 `commandId` 并按其状态恢复。确认没有收据且当前仍满足门禁时，才可用原键提交，因为 broker 在调用 Desktop 前写入收据 |
| 收据为 `submitted`、`queued` 或 `uncertain` | 保留原关联。即时回包缺少 `queued` 或历史暂缺消息都不触发重投。`uncertain` 用原 `commandId` 做 `confirm`，未确认时保留原状态 |
| 原生 `steers_rekeyed` | 通过稳定 `commandId` 跟随收据中的当前 UUID。已观察到的别名仅用于时间线归并。现有 `confirm` 匹配收据中的当前 UUID |
| 原生失败、撤回或会话删除 | 显示投递结果，保留业务事件供用户手动处理 |

同一批次在时间线投影为一个节点，显示该批次的全部事件卡和各自状态。按目标会话和原生 UUID 归并批次与消息。使用现有 `system` 事件来源标识宿主提交，并通过批次关联区分助理触发与其他系统事件。触发提交不消费人工草稿。区分「事件已记录」「原生已提交或已接收」「业务已处理」。模型回合结束不会自动标记业务完成。

断线和重启验收覆盖原生接受后、批次尚未写入 `commandId` 时退出。恢复后断言使用原收据且原生发送计数为一。另测忙碌排队即时回包无 `queued`、rekey 后同批多卡归并、换绑后旧批次不改投。关窗、真实锁屏和强制睡眠分别记录实际接收时间。系统恢复触发接收源补扫，补扫不计为锁屏即时投递。[投递 #214](https://github.com/Lycidas97/claude-desktop-bridge/issues/214) · [原生 broker](../apps/desktop/src/claude/claude-desktop-bridge.ts#L1279) · [现有实机证据](testing.md#desktop-自动邮件投递门禁)

## 日程与待办

本地待办、CalDAV `VEVENT` / `VTODO` 和 macOS EventKit 转成统一的待办与日程视图。规范记录保留 `sourceId`、目标集合或日历、后端对象标识及版本，并保留时区、全天与重复实例身份。界面明确区分数据源能力，后端不支持的写操作在对应源禁用。系统权限和可用凭据决定实际可用性，跨平台构建无需 EventKit helper。

用户可以在 UI 直接编辑本地待办与日程。模型通过只读查询获取列表和空档，外部同步内容附带宿主生成的来源标记。到期提醒按记录、版本及提醒窗口持久化去重，再走同一触发通道。会话换绑或压缩后从业务库读取未结事项。[多源同步 #215](https://github.com/Lycidas97/claude-desktop-bridge/issues/215)

## 提案与执行

模型把发信、改日程和改待办提交为提案。`proposal.create` 与 `proposal.update_pending` 只写提案，每次修订形成不可变的 `(proposalId, revision, payloadHash)`，并固定目标账号、后端、对象、基准版本和规范化载荷。待批页按提案记录显示。对话内联卡要求宿主能核对提案所属的会话和回合。关联未确认时在待批页展示。用户可让助理修改或手动编辑，两种编辑方式都生成新版本。

确认界面通过受 capability 门控的 `assistant.proposal.commit` 提交提案 ID、版本与载荷哈希。宿主使用已认证连接的身份，在同一事务内核对版本和哈希并将 `pending` 改为 `executing`。过期版本、重复提交或已撤销提案不会发起外部调用。聊天文本、模型工具或邮件内容只能形成建议。每张提案独立执行，有关联的回信和日历变更各自记录结果。

| 后端 | 提交契约 |
| --- | --- |
| SMTP | 二次确认抽屉固定并展示最终 `From`、全部信封收件地址、主题、正文和版本。展示 `To/Cc`，如产品支持 `Bcc` 也必须展示，否则拒绝这类载荷。异域 `Reply-To` 变化明确标出。执行从已批准载荷生成信封，先记录尝试再发送 |
| CalDAV / VTODO | 更新和删除使用原 `If-Match`。创建对选定资源地址用 `If-None-Match: *`。条件失败显示 `conflict` |
| SQLite 本地项 | 条件写校验记录版本。适合同库提交的业务变更和执行结果放在同一事务 |
| EventKit | 保存或删除前核对原生标识、修改时间和规范字段。该校验可拦截已发生的改动，系统无跨进程原子条件写保证 |

外部执行回包丢失时保留不确定结果。宿主重启发现 `executing` 且缺少明确结果时，先按持久化执行记录核对。已经进入外部提交阶段的尝试保持不确定。SMTP 显示 `delivery_uncertain` 并允许用户核查，已发送文件夹缺少副本无法证明未发送。遇到未能确认的外部写入先刷新或核对对应来源，禁止自动重放。验收覆盖打开确认后另一端修改提案、双端重复确认、最终信封含多个收件地址、消费后中断以及各后端的冲突结果。[提案执行 #216](https://github.com/Lycidas97/claude-desktop-bridge/issues/216)

## 记忆与压缩

Stage 3 在业务闭环通过后独立实施。`CLAUDE.md` 和用户核准的 `PROFILE.md` 是自动加载的规则区。宿主通过同一提案机制提交 `PROFILE.md` 变更，展示前后 diff，比较基准内容哈希后原子替换。执行记录保存预期结果哈希，重启时据此区分已写入、未写入和需要用户核对。

`memory/threads/` 和 `memory/notes/` 是模型按需读取的资料区，统一按低信任资料处理。新档位实测通过后，记忆子代理可在这两个目录内写入。若需要自动加载 `memory/INDEX.md`，内容限于宿主生成的固定格式标识和时间。标题、文件自取名、摘要及正文仅在按需浏览时展示。原生 `autoMemory` 保持关闭。人工发起的回合也可能引用此前读入的邮件，所以资料来源统一按低信任处理。授权取决于已批准的规则和提案。

邮件分拣与日程规划子代理分别查询自己的业务数据并提出建议。记忆子代理可以整理资料区，规则改动仍走用户审批。阶段 3 验收需实际核对子代理继承的权限和各角色的写入范围。

先验证用户显式 `/compact` 和带参数 `/compact <focus>` 在真实 Desktop 的行为。自动维护在会话空闲、达到已知上下文阈值且无待提交事件时整理资料。宿主使用现有 `backgroundTaskDetails(sessionId)` 刷新任务状态，确认派生任务结束且索引已落盘后，才向仍空闲的原生会话提交 `/compact`。收到新工作便放弃本次待提交的压缩。只有可归因的新 `compact_boundary` 代表成功，`postTokens` 可缺省。无法可靠区分压缩来源或确认后台排空时保留手动压缩。提交不确定时按原收据核对。 [记忆与压缩 #217](https://github.com/Lycidas97/claude-desktop-bridge/issues/217) · [转录约束](subsystems/desktop-transcript.md)
