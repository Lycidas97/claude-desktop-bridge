const I18N = {
  "brand.home": {
    en: "Bridge home",
    zh: "Bridge 首页"
  },
  "nav.features": { en: "Features", zh: "功能" },
  "nav.architecture": { en: "Architecture", zh: "架构" },
  "nav.security": { en: "Security", zh: "安全" },
  "nav.download": { en: "Download", zh: "下载" },
  "hero.eyebrow": {
    en: "Open source \u00B7 MIT \u00B7 End-to-end encrypted",
    zh: "开源 \u00B7 MIT \u00B7 端到端加密"
  },
  "hero.lede": { en: "An encrypted remote for Claude Desktop.", zh: "Claude Desktop 的加密手机遥控。" },
  "hero.text": { en: "Continue native sessions, queue instructions, review results and answer approvals from your phone. Claude Desktop manages execution and permissions.", zh: "在手机上继续原生会话、排队发送指令、查看成果并处理授权。执行和权限由 Claude Desktop 管理。" },
  "hero.download": { en: "Download", zh: "下载" },
  "hero.github": { en: "View on GitHub", zh: "查看 GitHub" },
  "hero.alt": { en: "Bridge remote control for Claude Desktop", zh: "Bridge：Claude Desktop 的加密遥控" },
  "features.eyebrow": { en: "What it does", zh: "它能做什么" },
  "features.title": { en: "Your Claude work, on your phone.", zh: "把 Claude 工作带到手机。" },
  "features.subtitle": { en: "Bridge forwards native Claude Desktop sessions through an encrypted connection.", zh: "Bridge 通过加密连接同步 Claude Desktop 原生会话。" },
  "features.one.title": { en: "One session surface", zh: "统一的会话界面" },
  "features.one.text": { en: "Send, stream, approve, answer questions and stop native Claude sessions from desktop or mobile.", zh: "在桌面或手机发送、查看流式输出、审批、回答提问和停止 Claude 原生会话。" },
  "features.two.title": { en: "End-to-end encryption", zh: "端到端加密" },
  "features.two.text": {
    en: "Per-device AES-256-GCM keys, WebRTC direct connections, and an encrypted WSS relay that never sees message content.",
    zh: "每台设备独立 AES-256-GCM 密钥，优先 WebRTC 直连，回退到永远看不到消息内容的加密 WSS 中继。"
  },
  "features.three.title": { en: "Native queues and forks", zh: "原生队列与 Fork" },
  "features.three.text": { en: "Queue the next instruction, withdraw eligible queued messages, or create a fork through Desktop.", zh: "通过 Desktop 排队下一条指令、撤回可操作的队列消息，或创建 Fork。" },
  "features.four.title": { en: "Claude Desktop integration", zh: "Claude Desktop 原生接入" },
  "features.four.text": { en: "A local Node inspector forwards explicit LocalSessions calls. Desktop owns sessions, execution and permissions.", zh: "本机 Node inspector 转发明确的 LocalSessions 调用，会话、执行和权限由 Desktop 管理。" },
  "features.five.title": { en: "Real evidence", zh: "真实成果" },
  "features.five.text": { en: "View image attachments, file-change summaries and artifact previews, and download workspace files.", zh: "查看图片附件、文件变更摘要和成果预览，并下载工作区文件。" },
  "features.six.title": { en: "Built to recover", zh: "为恢复而设计" },
  "features.six.text": { en: "Event replay, message receipts, push wake, reconnect, session archive and delete.", zh: "事件重放、消息收据、推送唤醒、重连，以及会话归档与删除。" },
  "architecture.eyebrow": { en: "Architecture", zh: "架构" },
  "architecture.title": {
    en: "Phone, desktop host, and relay.",
    zh: "手机、桌面 Host 与中继。"
  },
  "architecture.subtitle": {
    en: "Devices prefer a direct WebRTC data channel. When they cannot connect directly, traffic falls back to a self-hostable relay that stores only ciphertext and routing metadata.",
    zh: "设备优先建立 WebRTC 直连；无法直连时，流量回退到可自托管的中继，中继只保存密文和路由元数据。"
  },
  "architecture.diagram.aria": { en: "Mobile clients connect to Bridge through WebRTC or an encrypted relay; Bridge forwards Claude Desktop LocalSessions calls.", zh: "移动端通过 WebRTC 或加密中继连接 Bridge，再转发 Claude Desktop LocalSessions 调用。" },
  "architecture.note": { en: "Read the <a href=\"https://github.com/Lycidas97/claude-desktop-bridge/blob/main/docs/ARCHITECTURE.md\">architecture document</a> for native calls, events and transport.", zh: "查看<a href=\"https://github.com/Lycidas97/claude-desktop-bridge/blob/main/docs/ARCHITECTURE.md\">架构文档</a>，了解原生调用、事件与传输。" },
  "security.eyebrow": { en: "Security", zh: "安全" },
  "security.title": {
    en: "Safe boundaries are a product feature.",
    zh: "安全边界本身就是产品功能。"
  },
  "security.subtitle": {
    en: "Bridge deliberately refuses the shortcuts that make agent remotes risky.",
    zh: "Bridge 刻意拒绝那些让 Agent 远程控制变得危险的捷径。"
  },
  "security.one.title": { en: "Explicit debugger setup", zh: "明确的调试连接设置" },
  "security.one.text": { en: "On macOS, Accessibility and Automation access can open the native debugger menu once per Desktop process.", zh: "macOS 可用辅助功能与自动化权限，在每次 Desktop 进程启动后尝试一次原生调试菜单。" },
  "security.two.title": { en: "Local inspector only", zh: "仅使用本机 inspector" },
  "security.two.text": { en: "The local Node inspector forwards explicit native operations. Relay requests cannot evaluate arbitrary code.", zh: "本机 Node inspector 只转发明确的原生操作，中继请求不能任意执行代码。" },
  "security.three.title": { en: "No OAuth extraction", zh: "不提取 OAuth" },
  "security.three.text": { en: "Account credentials remain in Claude Desktop.", zh: "账号凭据留在 Claude Desktop 内。" },
  "security.four.title": {
    en: "No hidden chain-of-thought",
    zh: "不读取隐藏思考过程"
  },
  "security.four.text": {
    en: "Only bounded, user-visible context travels between devices.",
    zh: "只有有界、用户可见的上下文才会在设备间传输。"
  },
  "security.five.title": { en: "No automatic failover", zh: "不自动故障转移" },
  "security.five.text": { en: "Unavailable Claude sessions remain unavailable; Bridge does not start another executor.", zh: "Claude 不可用时明确显示不可用，Bridge 不启动其他执行器。" },
  "security.six.title": { en: "No credential migration", zh: "不迁移凭据" },
  "security.six.text": { en: "Desktop account credentials are not copied to the phone or relay.", zh: "Desktop 账号凭据不复制到手机或中继。" },
  "security.note": {
    en: 'Full details in the <a href="https://github.com/czhmartinez/claude-desktop-bridge/blob/main/docs/SECURITY.md">security model</a>.',
    zh: '完整细节见<a href="https://github.com/czhmartinez/claude-desktop-bridge/blob/main/docs/SECURITY.md">安全模型</a>。'
  },
  "download.eyebrow": { en: "Download", zh: "下载" },
  "download.title": { en: "Try it today.", zh: "现在就来试试。" },
  "download.subtitle": {
    en: "Prebuilt desktop installers and Android APKs are published for every release. The repository is MIT licensed and ready to build yourself.",
    zh: "每个版本都会发布桌面安装包和 Android APK。仓库采用 MIT 协议，也可以自己构建。"
  },
  "download.desktop.title": { en: "Desktop", zh: "桌面端" },
  "download.desktop.text": {
    en: "macOS, Windows and Linux installers",
    zh: "macOS、Windows 和 Linux 安装包"
  },
  "download.android.title": { en: "Android", zh: "Android" },
  "download.android.text": {
    en: "APK builds for side loading",
    zh: "可直接侧载的 APK"
  },
  "download.source.title": { en: "Source", zh: "源码" },
  "download.source.text": {
    en: "TypeScript monorepo with CI and QA",
    zh: "带 CI 与 QA 的 TypeScript monorepo"
  },
  "download.note": {
    en: "Quick start: <code>npm ci</code> then <code>npm run dev:desktop</code>. Requires Node.js 22.13 or newer.",
    zh: "快速开始：<code>npm ci</code>，然后 <code>npm run dev:desktop</code>。需要 Node.js 22.13 或更高版本。"
  },
  "footer.text": {
    en: "MIT licensed. Built for people who want their desktop agents to follow them.",
    zh: "MIT 协议开源。为想让桌面 Agent 跟着自己走的人而建。"
  },
  "footer.releases": { en: "Releases", zh: "发布" },
  "page.title": { en: "Bridge - Encrypted remote control for Claude Desktop", zh: "Bridge - Claude Desktop 的加密遥控" },
  "page.description": { en: "Bridge is an open-source, end-to-end encrypted phone remote for Claude Desktop.", zh: "Bridge 是开源、端到端加密的 Claude Desktop 手机遥控。" }
};

function setLanguage(lang) {
  const target = lang === "zh" ? "zh" : "en";
  document.documentElement.lang = target;
  try {
    localStorage.setItem("bridge-lang", target);
  } catch {
    // file:// and privacy modes may not expose localStorage.
  }

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = I18N[el.dataset.i18n][target];
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = I18N[el.dataset.i18nHtml][target];
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", I18N[el.dataset.i18nAriaLabel][target]);
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
    el.alt = I18N[el.dataset.i18nAlt][target];
  });

  document.title = I18N["page.title"][target];
  document.querySelector('meta[name="description"]').setAttribute("content", I18N["page.description"][target]);
  document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.langBtn === target));
  });
}

document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
  btn.addEventListener("click", () => setLanguage(btn.dataset.langBtn));
});

let storedLang = "en";
try {
  storedLang = localStorage.getItem("bridge-lang") || "en";
} catch {
  // Keep English when storage is unavailable.
}
setLanguage(storedLang);
