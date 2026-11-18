import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root, sessionId, originalTitle } from "../config.mjs";
import { eventually } from "../helpers.mjs";

export async function verifyDesktopDiagnostics(page, host, steps, baseUrl) {
  await page.addInitScript((snapshot) => {
    window.bridgeDesktop = {
      getSnapshot: async () => structuredClone(snapshot),
      onSnapshot: receive => { window.receiveDiagnosticsSnapshot = receive; return () => { delete window.receiveDiagnosticsSnapshot; }; }, onEvent: () => () => {},
      checkClaudeDesktopDeveloperSettings: async () => ({ supported: false, enabled: false, profiles: [] }),
      openAccessibilitySettings: async () => { window.accessibilitySettingsOpened = (window.accessibilitySettingsOpened ?? 0) + 1; },
      setDiagnosticsEnabled: async (enabled) => {
        snapshot.diagnosticsEnabled = enabled;
        return structuredClone(snapshot);
      },
    };
    window.updateDiagnosticsInspector = status => {
      snapshot.claudeInspector = status;
      window.receiveDiagnosticsSnapshot?.(structuredClone(snapshot));
    };
  }, { ...host.snapshot, sessions: [], projects: [], diagnosticsEnabled: false, launchAtLogin: false,
    managedDesktopEnabled: false, connection: "connected",
    claudeInspector: { platform: "win32", state: "closed", port: 9229, pollIntervalMs: 3000, clients: [], alerts: [],
      startup: { state: "failed", recordedAt: 1794697200000, detail: "自动开启失败：历史权限错误 (-2700)" } },
    claudeDesktop: { state: "running", detail: "Isolated fixture", canLaunch: false, canQuit: true } });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const inspector = page.getByRole("region", { name: "调试连接监测", exact: true });
  await inspector.getByRole("status").filter({ hasText: "调试端口未开放" }).waitFor();
  const guidance = inspector.getByText("如需连接，请在 Claude Desktop 中按 Alt 显示菜单，再勾选 Developer › Enable Main Process Debugger，Bridge 会自动连接。", { exact: true });
  await guidance.waitFor();
  const history = inspector.locator("details").filter({ hasText: "历史启动记录" });
  assert.equal(await history.getAttribute("open"), null, "Historical startup failures default to collapsed");
  await history.locator("summary").click();
  await history.getByText("自动开启失败：历史权限错误 (-2700)", { exact: true }).waitFor();
  const recordedAt = await history.locator("time").getAttribute("datetime");
  assert.equal(recordedAt, new Date(1794697200000).toISOString());
  assert.equal(await inspector.locator(".inline-error").count(), 0, "A historical permission failure is not a current error");
  await page.evaluate(() => window.updateDiagnosticsInspector({ state: "listening", port: 9229, pollIntervalMs: 3000,
    clients: [{ pid: 42, name: "Bridge", approved: true, executablePath: "/Applications/Bridge.app/Contents/MacOS/Bridge" }], alerts: [],
    startup: { state: "failed", recordedAt: 1794697200000, detail: "自动开启失败：历史权限错误 (-2700)" } }));
  await inspector.getByRole("status").filter({ hasText: "调试端口已开放 · 1 个连接进程" }).waitFor();
  await inspector.getByText("PID 42 · Bridge · 认可路径", { exact: true }).waitFor();
  assert.equal(await guidance.count(), 0, "The closed-port action disappears when the port opens");
  assert.equal(await history.locator("time").getAttribute("datetime"), recordedAt, "Port recovery does not rewrite history time");
  assert.equal(await inspector.locator(".inline-error").count(), 0);
  await page.evaluate(() => window.updateDiagnosticsInspector({ platform: "darwin", state: "closed", port: 9229, pollIntervalMs: 3000, clients: [], alerts: [],
    startup: { state: "accessibility-required", detail: "请在辅助功能中添加 /Applications/Bridge.app，授权后自动继续。" } }));
  await inspector.getByText("请在辅助功能中添加 /Applications/Bridge.app，授权后自动继续。", { exact: true }).waitFor();
  await inspector.getByRole("button", { name: "打开辅助功能设置", exact: true }).click();
  assert.equal(await page.evaluate(() => window.accessibilitySettingsOpened), 1);
  assert.equal(await history.count(), 0, "Pending Accessibility consent is not historical startup failure");
  steps.push("Desktop shows Windows Alt guidance, real socket state, stable history and actionable macOS Accessibility consent");
  await page.getByRole("button", { name: "诊断与关于", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: /后台诊断记录/u });
  assert.equal(await toggle.isChecked(), false);
  await page.getByText("后台诊断记录", { exact: true }).click();
  await eventually(() => toggle.isChecked(), true, "Desktop uses the returned enabled state");
  assert.equal(await page.evaluate(async () => (await window.bridgeDesktop.getSnapshot()).diagnosticsEnabled), true);
  await page.getByText("后台诊断记录", { exact: true }).click();
  await eventually(() => toggle.isChecked(), false, "Desktop uses the returned disabled state");
  assert.equal(await page.evaluate(async () => (await window.bridgeDesktop.getSnapshot()).diagnosticsEnabled), false);
  steps.push("Desktop recorder checkbox defaults off and renders returned local setting states");
}

export async function verifyDesktopQuota(page, host, steps, directory, viewports, baseUrl) {
  const requests = [];
  let failure = "";
  let finishRead;
  let holdRead = false;
  await page.exposeFunction("settingsRequest", input => {
    assert.equal(input.method, "plugin.magpie-quota.list");
    requests.push(input.params);
    const response = failure ? { ok: false, error: { code: "INTERNAL", message: failure } } : {
      ok: true, result: { status: "available", fetchedAt: Date.now(), accounts: [{
        provider: "claude", name: "隔离额度账号", windows: [{ name: "5 hours", remaining: 73 }],
      }] },
    };
    return holdRead ? new Promise(resolveRead => { finishRead = () => resolveRead(response); }) : response;
  });
  await page.addInitScript(snapshot => {
    window.settingsSnapshot = snapshot;
    window.bridgeDesktop = {
      getSnapshot: async () => structuredClone(window.settingsSnapshot),
      onSnapshot: receive => { window.receiveSettingsSnapshot = receive; return () => { delete window.receiveSettingsSnapshot; }; },
      onEvent: () => () => {},
      request: input => window.settingsRequest(input),
      checkClaudeDesktopDeveloperSettings: async () => ({ supported: false, enabled: false, profiles: [] }),
    };
  }, { ...host.snapshot, sessions: [], projects: [], devices: [], diagnosticsEnabled: false, launchAtLogin: false,
    host: { ...host.snapshot.host, capabilities: [...host.snapshot.host.capabilities, "plugin.magpie-quota.v1"] },
    updater: { platform: "darwin", arch: "arm64", currentVersion: host.snapshot.host.version, channel: "stable", autoCheck: true, applyMode: "prompt", canAutoRestart: false, phase: "idle" },
    managedDesktopEnabled: false, connection: "connected",
    claudeDesktop: { state: "running", detail: "Isolated fixture", canLaunch: false, canQuit: true } });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "开发者工具", exact: true }).waitFor();
  assert.deepEqual(requests, [], "Settings do not read quota before entering its group");
  await page.getByRole("button", { name: "模型与网关", exact: true }).click();
  assert.equal(await page.getByRole("navigation", { name: "设置分组", exact: true }).getByRole("button", { name: "Magpie 额度", exact: true }).count(), 1, "Quota has its own settings group");
  assert.equal(await page.getByRole("button", { name: "Magpie 额度", exact: true }).count(), 1, "Quota has one settings entry");
  assert.equal(await page.locator(".magpie-quota-board").count(), 0, "Model settings do not duplicate the quota dashboard");
  await page.getByRole("button", { name: "Magpie 额度", exact: true }).click();
  await page.locator(".magpie-quota-account > header > strong").filter({ hasText: "隔离额度账号" }).waitFor();
  assert.deepEqual(requests, [{ refresh: false }], "First dashboard mount makes an ordinary read");
  assert.equal(await page.locator(".magpie-quota-board").count(), 1);
  viewports.push({ page: "desktop-quota", ...page.viewportSize() });
  await page.screenshot({ path: resolve(directory, "desktop-quota.png"), fullPage: true });

  holdRead = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await eventually(() => requests.length, 2, "Manual refresh reaches the existing quota RPC");
  assert.deepEqual(requests[1], { refresh: true });
  assert.equal(await page.getByRole("button", { name: "读取中…", exact: true }).isDisabled(), true);
  finishRead();
  holdRead = false;
  await page.getByRole("button", { name: "刷新", exact: true }).waitFor();
  failure = "隔离额度读取失败";
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "隔离额度读取失败" }).waitFor();
  await page.locator(".magpie-quota-account > header > strong").filter({ hasText: "隔离额度账号" }).waitFor();
  steps.push("The unique desktop quota group lazily reads refresh:false, refreshes with refresh:true, disables during a pending read, and retains prior data on refresh errors");

  for (const [group, heading] of [["Claude 接入", "开发者工具"], ["连接与启动", "启动"], ["外观与显示", "外观"], ["诊断与关于", "版本更新"]]) {
    await page.getByRole("button", { name: group, exact: true }).click();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    assert.equal(await page.locator(".magpie-quota-board").count(), 0);
  }
  const desktopUpdaterRegion = page.getByRole("region", { name: "版本更新", exact: true });
  await desktopUpdaterRegion.getByRole("button", { name: "检查更新", exact: true }).waitFor();
  await desktopUpdaterRegion.getByRole("link", { name: "GitHub Releases", exact: true }).waitFor();
  assert.equal(await desktopUpdaterRegion.getByText("空闲静默重启").count(), 0);
  assert.equal(await desktopUpdaterRegion.getByText("下载完成后").count(), 0);
  await page.evaluate(() => {
    window.settingsSnapshot.updater = {
      ...window.settingsSnapshot.updater,
      phase: "available",
      latestVersion: "1.3.5",
      releaseUrl: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5",
    };
    window.receiveSettingsSnapshot(structuredClone(window.settingsSnapshot));
  });
  const jumpLink = desktopUpdaterRegion.getByRole("link", { name: "前往下载 v1.3.5", exact: true });
  await jumpLink.waitFor();
  assert.equal(await jumpLink.getAttribute("href"), "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5");
  assert.equal(await jumpLink.getAttribute("target"), "_blank");
  assert.equal(await desktopUpdaterRegion.getByRole("link", { name: "GitHub Releases", exact: true }).count(), 0);
  await page.getByRole("button", { name: "手机配对与设备", exact: true }).click();
  await page.getByRole("button", { name: "添加手机", exact: true }).waitFor();
  steps.push("Leaving quota preserves developer tools, startup, appearance, diagnostics, updates and the device pairing entry");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Magpie 额度", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: failure }).waitFor();
  assert.equal(await page.locator(".magpie-quota-account").count(), 0, "First-read failure has no stale data from a prior page");
  const beforeDisabled = requests.length;
  await page.evaluate(() => {
    window.settingsSnapshot.host.capabilities = window.settingsSnapshot.host.capabilities.filter(value => value !== "plugin.magpie-quota.v1");
    window.receiveSettingsSnapshot(structuredClone(window.settingsSnapshot));
  });
  await page.getByText("电脑连接后读取额度", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "刷新", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "连接与启动", exact: true }).click();
  await page.getByRole("heading", { name: "启动", exact: true }).waitFor();
  await page.getByRole("button", { name: "Magpie 额度", exact: true }).click();
  await page.getByText("电脑连接后读取额度", { exact: true }).waitFor();
  assert.equal(requests.length, beforeDisabled, "Missing quota capability prevents requests across navigation");
  await page.setViewportSize({ width: 860, height: 620 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Seven settings groups fit a compact desktop");
  viewports.push({ page: "desktop-quota-disabled", ...page.viewportSize() });
  await page.screenshot({ path: resolve(directory, "desktop-quota-disabled.png"), fullPage: true });
  steps.push("First-read errors are visible; absent capability disables refresh and makes no request, including after returning to quota");
}

export async function verifyDesktopConversation(page, host, steps, directory, viewports, baseUrl) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const axeSource = await readFile(resolve(root, "node_modules/axe-core/axe.min.js"), "utf8");
  const photoBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#2c6873";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 72px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("D1", 180, 120);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const imageBytes = Buffer.from(photoBase64, "base64");
  const imageMsgId = "desktop-native-img";
  host.nativeImages.set(`${imageMsgId}:0`, imageBytes);
  const binaryPayload = "desktop-workspace-binary-payload-v1";
  await writeFile(resolve(host.nativeApproval.harnessCwd, "bundle.zip"), binaryPayload);

  const now = Date.now();
  const toolUse = (id, input, name) => ({ type: "assistant", uuid: id, timestamp: now - 40_000, message: { content: [{ type: "tool_use", id, name, input }] } });
  const toolDone = (id, content) => ({ type: "user", uuid: `${id}-result`, timestamp: now - 39_000, message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
  for (const message of [
    toolUse("desktop-plan-1", {
      scope: "first_task",
      items: [
        { content: "提取共享对话叶子", status: "completed" },
        { content: "对齐桌面对话能力", status: "in_progress" },
      ],
    }, "mcp__ccd_turn__update_plan"),
    toolUse("desktop-tool-read", { file_path: "/fixture/DesktopSessionsPane.tsx" }, "Read"),
    toolDone("desktop-tool-read", "Read ok"),
    toolUse("desktop-tool-bash", { command: "git status --short" }, "Bash"),
    toolDone("desktop-tool-bash", "clean worktree"),
    {
      type: "assistant",
      uuid: "desktop-assistant-reply",
      timestamp: now - 30_000,
      message: {
        id: "desktop-assistant-reply",
        content: [{ type: "text", text: "桌面端已接入共享叶子组件，可下载构建产物 [安装包下载](bundle.zip)。" }],
      },
    },
    {
      type: "system",
      subtype: "task_started",
      task_id: "desktop-bg-subagent",
      tool_use_id: "desktop-bg-call",
      description: "Verify desktop parity",
      timestamp: now - 20_000,
    },
  ]) {
    await host.nativeApproval.message(message);
  }
  const queuedSeed = await host.syncNativeQueue(await host.nativeApproval.enqueue("桌面排队待处理消息"), { pushEvents: false });
  const subagentInfo = host.history.find(item => item.subagent?.agentId === "desktop-bg-subagent")?.subagent;
  const backgroundTasks = [{
    id: "desktop-bg-call",
    kind: "subagent",
    taskId: "desktop-bg-subagent",
    toolUseId: "desktop-bg-call",
    description: "Verify desktop parity",
    state: "running",
    startedAt: now - 20_000,
    updatedAt: now - 10_000,
    subagent: subagentInfo,
  }];
  const nativeConfiguration = host.nativeApproval.configuration;
  host.nativeApproval.configuration = async request => {
    const result = await nativeConfiguration(request);
    if (request.params.includeBackgroundTasks) {
      result.session.backgroundTasks = structuredClone(backgroundTasks);
    }
    return result;
  };

  const toDesktopSnapshot = current => ({
    ...structuredClone(current),
    connection: "connected",
    launchAtLogin: false,
    diagnosticsEnabled: false,
    managedDesktopEnabled: false,
    claudeDesktop: { state: "running", detail: "隔离 Native 宿主", canLaunch: false, canQuit: true },
  });
  await page.exposeFunction("desktopBridgeRequest", input => host.desktopRequest(input));
  await page.exposeFunction("desktopBridgeGetSnapshot", () => toDesktopSnapshot(host.snapshot));
  host.onDesktopPayload = async payload => {
    if (payload.kind === "snapshot") {
      await page.evaluate(next => window.__desktopReceiveSnapshot?.(next), toDesktopSnapshot(payload.snapshot)).catch(() => {});
    } else if (payload.kind === "event") {
      await page.evaluate(event => window.__desktopReceiveEvent?.(event), payload.event).catch(() => {});
    }
  };
  await page.addInitScript(initialSnapshot => {
    window.__desktopSnapshot = initialSnapshot;
    window.bridgeDesktop = {
      getSnapshot: () => window.desktopBridgeGetSnapshot(),
      onSnapshot: receive => {
        window.__desktopReceiveSnapshot = next => {
          window.__desktopSnapshot = next;
          receive(structuredClone(next));
        };
        return () => { delete window.__desktopReceiveSnapshot; };
      },
      onEvent: receive => {
        window.__desktopReceiveEvent = event => receive(structuredClone(event));
        return () => { delete window.__desktopReceiveEvent; };
      },
      request: input => window.desktopBridgeRequest(input),
    };
  }, toDesktopSnapshot(host.snapshot));

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const sidebar = page.locator(".desktop-session-sidebar");
  await sidebar.locator(`[data-session-id="${sessionId}"] .session-row-hit`).click();
  await page.locator(".desktop-conversation .m-header").getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  assert.equal(await page.locator(".composer-mode").count(), 0, "Desktop conversation does not reintroduce a composer mode selector");

  const stream = page.locator(".desktop-conversation-stream");
  const queuedBubble = stream.locator("article.conversation-item.user").filter({ hasText: "桌面排队待处理消息" });
  await queuedBubble.getByRole("button", { name: "立即发送", exact: true }).waitFor();
  await queuedBubble.getByRole("button", { name: "复制这条消息", exact: true }).waitFor();
  assert.equal(await queuedBubble.getByRole("status").innerText(), "已排队");
  assert.equal(await page.getByRole("status", { name: "消息排队状态" }).count(), 0);
  assert.equal(await page.locator(".session-activity.queued").count(), 0);
  await page.getByRole("button", { name: "后台任务，1 个运行中", exact: true }).waitFor();
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.effect.getComputedTiming().iterations === Infinity || animation.playState === "finished"));
  await page.evaluate(axeSource);
  const axeIssues = await page.evaluate(async () => {
    const wcag = await window.axe.run(document.querySelector(".desktop-conversation"), {
      resultTypes: ["violations"],
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    const contrast = await window.axe.run(document.querySelector(".desktop-conversation"), {
      runOnly: { type: "rule", values: ["color-contrast"] },
      resultTypes: ["violations", "incomplete"],
    });
    return [
      ...wcag.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })),
      ...contrast.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })),
      ...contrast.incomplete.filter(item => item.nodes.some(node => [...node.any, ...node.all, ...node.none].some(check => check.data?.contrastRatio < 4.5))).map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })),
    ];
  });
  assert.deepEqual(axeIssues, [], "Desktop conversation WCAG 2A/2AA and color-contrast (including queued 立即发送 button)");
  viewports.push({ page: "desktop-conversation-parity", ...page.viewportSize() });
  await page.screenshot({ path: resolve(directory, "desktop-conversation-parity.png"), fullPage: true });

  await host.emit("assistant.completed", { text: "排队消息之后的回复" }, { itemId: "after-desktop-queue" });
  await stream.getByText("排队消息之后的回复", { exact: true }).waitFor();
  await sidebar.hover();
  await queuedBubble.getByRole("button", { name: "复制这条消息", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await queuedBubble.evaluate(message => {
    const bubble = message.querySelector(".conversation-bubble");
    const withdraw = message.querySelector(".queued-cancel-button");
    return withdraw.getBoundingClientRect().right - parseFloat(getComputedStyle(withdraw).paddingRight) - bubble.getBoundingClientRect().right;
  }), 0, "The older queue actions align with the bubble edge while copy is hidden");

  await queuedBubble.getByRole("button", { name: "立即发送", exact: true }).click();
  await eventually(() => host.nativeApproval.calls.filter(call => call.method === "promoteQueuedMessage").length, 1, "Desktop 立即发送 calls promoteQueuedMessage once");
  assert.deepEqual(host.nativeApproval.calls.find(call => call.method === "promoteQueuedMessage").args, [sessionId, queuedSeed.receipt.messageId]);
  await eventually(() => queuedBubble.getByRole("button", { name: "撤回", exact: true }).isEnabled(), true, "Cancel remains enabled after deferred 立即发送");
  assert.equal(await queuedBubble.getByRole("button", { name: "立即发送", exact: true }).isDisabled(), true, "立即发送 disables after promotion request");
  await queuedBubble.getByRole("button", { name: "撤回", exact: true }).click();
  await queuedBubble.getByRole("status").filter({ hasText: "已取消" }).waitFor();
  assert.equal(await queuedBubble.getByRole("button", { name: "撤回", exact: true }).count(), 0);
  await sidebar.hover();
  assert.equal(await queuedBubble.evaluate(message => {
    const bubble = message.querySelector(".conversation-bubble");
    const status = message.querySelector(".delivery-state");
    return status.getBoundingClientRect().right - bubble.getBoundingClientRect().right;
  }), 0, "The older cancelled status aligns with the bubble edge");
  steps.push("Desktop 立即发送, 撤回, and the cancelled status align with the bubble edge while older utilities are hidden");

  await eventually(() => stream.locator(".task-plan-card").count(), 1, "Desktop stream renders TaskPlanCard");
  assert.equal(await stream.locator(".task-plan-progress").innerText(), "1/2 已完成");
  assert.equal(host.requests.filter(request => request.method === "session.tool.detail").length, 0, "Desktop tool group does not eagerly fetch tool details");
  await stream.locator(".conversation-tool-group summary").click();
  await stream.locator(".conversation-tool-row").filter({ hasText: "git status --short" }).click();
  const toolDialog = page.getByRole("dialog", { name: "Bash", exact: true });
  await toolDialog.waitFor();
  await eventually(async () => {
    const content = await toolDialog.innerText();
    return content.includes("已完成") && content.includes("git status --short") && content.includes("clean worktree");
  }, true, "Desktop tool row lazily loads tool input and execution output");
  assert.equal(host.requests.filter(request => request.method === "session.tool.detail").length, 1);
  await toolDialog.getByRole("button", { name: "关闭工具详情", exact: true }).click();
  await toolDialog.waitFor({ state: "hidden" });

  await stream.locator(".background-task-marker").click();
  const taskSheet = page.getByRole("dialog").filter({ hasText: "Verify desktop parity" });
  await taskSheet.waitFor();
  await page.screenshot({ path: resolve(directory, "desktop-background-tasks.png"), fullPage: true });
  await taskSheet.getByRole("button", { name: "关闭", exact: true }).click();
  await taskSheet.waitFor({ state: "hidden" });

  await page.evaluate(() => {
    window.__desktopCopied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async value => { window.__desktopCopied.push(value); } },
    });
  });
  const assistantBubble = stream.locator("article.conversation-item.assistant").filter({ hasText: "桌面端已接入共享叶子组件" });
  const copyReply = assistantBubble.getByRole("button", { name: "复制这条回复", exact: true });
  await sidebar.hover();
  await copyReply.waitFor({ state: "hidden" });
  const collapsedHeight = await assistantBubble.evaluate(reply => reply.getBoundingClientRect().height);
  await assistantBubble.hover();
  await copyReply.waitFor();
  assert.equal(await assistantBubble.evaluate(reply => reply.getBoundingClientRect().height), collapsedHeight,
    "Hovering an older desktop message must preserve its height");
  await sidebar.hover();
  await copyReply.waitFor({ state: "hidden" });
  await assistantBubble.press("Tab");
  await copyReply.waitFor();
  assert.equal(await page.locator(":focus").getAttribute("class"), "markdown-file-link");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").getAttribute("aria-label"), "复制这条回复");
  await page.keyboard.press("Enter");
  await assistantBubble.getByRole("button", { name: "已复制", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__desktopCopied), ["桌面端已接入共享叶子组件，可下载构建产物 [安装包下载](bundle.zip)。"]);
  steps.push("Desktop conversation supports TaskPlanCard, lazy ToolCallDetailSheet, BackgroundTaskMarker sheet jump, and message copy");

  await assistantBubble.getByRole("button", { name: "安装包下载", exact: true }).click();
  const downloadConfirm = page.getByRole("alertdialog", { name: "确认下载工作区文件？", exact: true });
  await downloadConfirm.waitFor();
  const downloadEvent = page.waitForEvent("download");
  await downloadConfirm.getByRole("button", { name: "确认下载", exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "bundle.zip");
  assert.equal(await readFile(await download.path(), "utf8"), binaryPayload);
  await downloadConfirm.waitFor({ state: "hidden" });
  steps.push("Desktop non-media workspace path link confirms and completes chunked download via downloadBridgeSessionFile");

  const imageAttachment = {
    id: `native-image:${imageMsgId}:0`,
    name: "image-1.png",
    mimeType: "image/png",
    size: imageBytes.length,
    nativeImage: { messageUuid: imageMsgId, imageIndex: 0 },
  };
  host.history.push({
    id: imageMsgId,
    sessionId,
    role: "user",
    text: "桌面原生参考图消息",
    createdAt: Date.now(),
    origin: "claude-desktop",
    delivery: "completed",
    attachments: [imageAttachment],
  });
  await host.emit("user.message.accepted", {
    text: "桌面原生参考图消息",
    attachments: [imageAttachment],
    delivery: "completed",
    messageId: imageMsgId,
  }, { itemId: imageMsgId });
  const imageBubble = stream.locator("article.conversation-item.user").filter({ hasText: "桌面原生参考图消息" });
  const thumbnail = imageBubble.locator(".conversation-image-preview");
  await thumbnail.scrollIntoViewIfNeeded();
  await eventually(() => thumbnail.locator("img").evaluate(node => node.complete && node.naturalWidth > 0), true, "Desktop lazy-loads native reference thumbnail");
  const thumbnailState = () => thumbnail.evaluate(button => ({
    src: button.querySelector("img")?.src,
    height: button.getBoundingClientRect().height,
  }));
  const loadedThumbnail = await thumbnailState();
  await host.emit("assistant.delta", { text: "图片之后的流式回复" }, { itemId: "desktop-image-stream" });
  await stream.getByText("图片之后的流式回复", { exact: true }).waitFor();
  assert.deepEqual(await thumbnailState(), loadedThumbnail, "Streaming updates preserve the loaded thumbnail and its height");
  assert.equal(host.requests.filter(({ method, params }) => method === "artifact.transfer.open" && params.nativeImage?.messageUuid === imageMsgId).length, 1,
    "Streaming updates do not start a second thumbnail transfer");
  await thumbnail.locator("img").click();
  const mediaViewer = page.getByRole("dialog").last();
  await mediaViewer.waitFor();
  await eventually(() => mediaViewer.locator("img").evaluate(node => node.complete && node.naturalWidth > 0), true, "Desktop opens full native image in media viewer");
  await mediaViewer.getByRole("button", { name: /关闭/u }).first().click();
  steps.push("Desktop renders reference-based native image thumbnails and opens full-size media viewer");

  host.events.length = 0;
  host.history.length = 0;
  const baseTime = Date.now();
  for (let index = 0; index < 120; index += 1) {
    host.history.push({
      id: `desktop-history-${String(index).padStart(3, "0")}`,
      sessionId,
      role: index % 2 ? "assistant" : "user",
      text: `桌面分页条目 ${String(index + 1).padStart(3, "0")}。${"用于验证桌面对话历史向前加载时保持阅读锚点不跳动。".repeat(3)}`,
      createdAt: baseTime - (120 - index) * 1_000,
      origin: "claude-desktop",
    });
  }
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const openCountBefore = host.requests.filter(request => request.method === "session.open" && request.params.sessionId === sessionId).length;
  const historyCountBefore = host.requests.filter(request => request.method === "session.history").length;
  await sidebar.locator(`[data-session-id="${sessionId}"] .session-row-hit`).click();
  await page.locator(".desktop-conversation .m-header").getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  await eventually(() => host.requests.filter(request => request.method === "session.open" && request.params.sessionId === sessionId).length > openCountBefore, true, "Selecting session requests session.open");
  assert.equal(host.requests.filter(request => request.method === "session.open" && request.params.sessionId === sessionId).at(-1).params.limit, 50);
  await eventually(() => stream.locator("article.conversation-item").count(), 50, "Desktop renders initial 50 history items");
  await eventually(() => stream.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop < 4), true, "Desktop pins initial session load to the bottom");

  const captureTopAnchor = () => stream.evaluate(root => {
    root.scrollTop = 0;
    const rect = root.getBoundingClientRect();
    const node = [...root.querySelectorAll(":scope > [data-stream-key]")].find(candidate => {
      const bounds = candidate.getBoundingClientRect();
      return bounds.bottom > rect.top + 1 && bounds.top < rect.bottom;
    });
    if (!node) throw new Error("Visible desktop stream anchor required");
    const anchor = { key: node.getAttribute("data-stream-key"), offset: node.getBoundingClientRect().top - rect.top, height: root.scrollHeight };
    for (let index = 0; index < 4; index += 1) root.dispatchEvent(new Event("scroll"));
    return anchor;
  });
  const assertDesktopAnchor = async expected => {
    await eventually(async () => {
      const actual = await stream.evaluate((root, target) => {
        const node = [...root.querySelectorAll(":scope > [data-stream-key]")].find(candidate => candidate.getAttribute("data-stream-key") === target.key);
        return node ? node.getBoundingClientRect().top - root.getBoundingClientRect().top : null;
      }, expected);
      return actual !== null && Math.abs(actual - expected.offset) <= 4;
    }, true, "Desktop history prepend preserves visible message anchor offset within 4px");
  };

  let releaseHistory;
  host.historyGate = new Promise(resolveGate => { releaseHistory = resolveGate; });
  const firstAnchor = await captureTopAnchor();
  try {
    await eventually(() => host.requests.filter(request => request.method === "session.history").length, historyCountBefore + 1, "Top scroll triggers one session.history request");
    await stream.evaluate(root => { for (let index = 0; index < 4; index += 1) root.dispatchEvent(new Event("scroll")); });
    assert.equal(host.requests.filter(request => request.method === "session.history").length, historyCountBefore + 1, "Duplicate top scrolls do not duplicate in-flight session.history");
  } finally {
    host.historyGate = undefined;
    releaseHistory();
  }
  await eventually(() => stream.evaluate((root, height) => root.scrollHeight > height + 100, firstAnchor.height), true, "Older page prepends into desktop stream");
  await assertDesktopAnchor(firstAnchor);
  assert.ok(await stream.evaluate(root => root.scrollTop > 32), "Anchor compensation moves desktop scrollTop away from 0");

  host.failHistoryOnce = true;
  await captureTopAnchor();
  await stream.getByRole("alert").filter({ hasText: "隔离历史请求失败" }).waitFor();
  const retryAnchor = await stream.evaluate(root => {
    const rect = root.getBoundingClientRect();
    const node = [...root.querySelectorAll(":scope > [data-stream-key]")].find(candidate => candidate.getBoundingClientRect().bottom > rect.top + 1);
    return { key: node.getAttribute("data-stream-key"), offset: node.getBoundingClientRect().top - rect.top };
  });
  await stream.getByRole("button", { name: "重试加载更早消息", exact: true }).click();
  await stream.locator(".load-older-button").waitFor({ state: "hidden" });
  await assertDesktopAnchor(retryAnchor);
  const streamKeys = await stream.locator(":scope > [data-stream-key]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-stream-key")));
  assert.equal(new Set(streamKeys).size, streamKeys.length, "Desktop paginated stream has no duplicate keys");
  await page.screenshot({ path: resolve(directory, "desktop-history-pagination.png"), fullPage: true });
  steps.push("Desktop top-scroll pagination loads 50-item pages via session.history, retains failed cursors for retry, and preserves reading position");

  // Desktop 会话操作 Sheet: 同步此会话 + keyboard-accessible 删除会话 ConfirmationDialog focus trap & restore
  if (!host.snapshot.host.capabilities.includes("session.visibility.v1")) {
    host.snapshot.host.capabilities.push("session.visibility.v1");
  }
  await page.evaluate(next => window.__desktopReceiveSnapshot?.(next), toDesktopSnapshot(host.snapshot));

  const menuTrigger = page.locator(".desktop-conversation .m-header").getByRole("button", { name: "会话操作", exact: true });
  await menuTrigger.focus();
  await page.keyboard.press("Enter");
  const sessionMenuSheet = page.getByRole("dialog", { name: originalTitle, exact: true });
  await sessionMenuSheet.waitFor();
  const syncOpenCountBefore = host.requests.filter(request => request.method === "session.open" && request.params.sessionId === sessionId).length;
  await sessionMenuSheet.getByRole("button", { name: /同步此会话/u }).click();
  await eventually(() => host.requests.filter(request => request.method === "session.open" && request.params.sessionId === sessionId).length, syncOpenCountBefore + 1, "Desktop 同步此会话 re-opens session transcript");
  await sessionMenuSheet.getByRole("button", { name: /已同步/u }).waitFor();

  const targetSession = host.snapshot.sessions.find(candidate => candidate.sessionId === sessionId);
  targetSession.turnState = "idle";
  targetSession.pendingCount = 0;
  await page.evaluate(next => window.__desktopReceiveSnapshot?.(next), toDesktopSnapshot(host.snapshot));

  const deleteActionButton = sessionMenuSheet.getByRole("button", { name: /删除会话/u });
  await eventually(() => deleteActionButton.isEnabled(), true, "Idle desktop session enables 删除会话");
  await deleteActionButton.focus();
  await page.keyboard.press("Enter");
  const deleteAlert = page.getByRole("alertdialog", { name: "删除会话", exact: true });
  await deleteAlert.waitFor();
  assert.equal(await deleteAlert.evaluate(node => node.contains(document.activeElement)), true, "Opening delete ConfirmationDialog moves focus into alertdialog");
  await page.keyboard.press("Tab");
  assert.equal(await deleteAlert.getByRole("button", { name: "删除会话", exact: true }).evaluate(node => node === document.activeElement), true, "Tab moves to confirm button inside alertdialog");
  await page.keyboard.press("Tab");
  assert.equal(await deleteAlert.getByRole("button", { name: "取消", exact: true }).evaluate(node => node === document.activeElement), true, "Tab wraps inside alertdialog");
  await page.keyboard.press("Escape");
  await deleteAlert.waitFor({ state: "hidden" });
  assert.equal(await deleteActionButton.evaluate(node => node === document.activeElement), true, "Canceling delete ConfirmationDialog restores focus to 删除会话 menu item");
  await page.keyboard.press("Escape");
  await sessionMenuSheet.waitFor({ state: "hidden" });
  assert.equal(await menuTrigger.evaluate(node => node === document.activeElement), true, "Closing 会话操作 Sheet restores focus to 会话操作 trigger");
  steps.push("Desktop 会话操作 Sheet supports 同步此会话 and keyboard focus trap/restore across 删除会话 ConfirmationDialog");
}
