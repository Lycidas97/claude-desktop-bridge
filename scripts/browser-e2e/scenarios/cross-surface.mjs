import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sessionId } from "../config.mjs";
import { eventually, syncNativeSections, openMobileDrawer, openMobileSession, selectCustomOption, customSelectValue } from "../helpers.mjs";

export async function verifyRound4Boundaries(page, host, steps, directory, viewports, theme, baseUrl) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const proofDir = process.env.ROUND4_VISUAL_PROOF_DIR && theme === (process.env.ROUND4_VISUAL_PROOF_THEME ?? "light")
    ? resolve(process.env.ROUND4_VISUAL_PROOF_DIR)
    : undefined;
  if (proofDir) await mkdir(proofDir, { recursive: true });

  async function saveShot(targetPage, fileName) {
    await targetPage.waitForFunction(() => document.getAnimations().every(
      animation => animation.effect.getComputedTiming().iterations === Infinity || animation.playState === "finished",
    ));
    await targetPage.screenshot({ path: resolve(directory, fileName), fullPage: false });
    if (proofDir) {
      await targetPage.screenshot({ path: resolve(proofDir, fileName), fullPage: false });
    }
    viewports.push({ page: fileName, ...targetPage.viewportSize() });
  }

  // 1. Mobile (390x844): create sections, test fast touch scroll vs 320ms long-press drag onto section!
  await page.setViewportSize({ width: 390, height: 844 });
  await openMobileDrawer(page);
  const drawer = page.locator(".mobile-home-catalog");
  for (const sectionName of ["核心研发", "归档调研"]) {
    await drawer.getByRole("button", { name: "+ 分组", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建分组" });
    await dialog.getByLabel("分组名称").fill(sectionName);
    await dialog.getByRole("button", { name: "创建分组", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  }
  const coreSectionId = host.snapshot.projects.find(p => p.name === "核心研发")?.projectId;
  const researchSectionId = host.snapshot.projects.find(p => p.name === "归档调研")?.projectId;
  assert.ok(coreSectionId && researchSectionId, "Both manual sections created");

  const mobileTargetRow = drawer.locator('[data-session-id="browser-e2e-misc-sub"]');
  await mobileTargetRow.waitFor();
  const rowBox = await mobileTargetRow.boundingBox();
  const coreHeaderBox = await drawer.locator(`[data-drop-section-id="${coreSectionId}"]`).boundingBox();
  assert.ok(rowBox && coreHeaderBox, "Mobile session row and target section bounding boxes exist");

  // Fast touch scroll (>8px before 320ms) must NOT start drag
  await page.evaluate(({ x, y }) => {
    const row = document.querySelector('.mobile-home-catalog [data-session-id="browser-e2e-misc-sub"]');
    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 41, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 41, pointerType: "touch", isPrimary: true, clientX: x, clientY: y + 22 }));
  }, { x: Math.round(rowBox.x + 60), y: Math.round(rowBox.y + rowBox.height / 2) });
  await delay(350);
  assert.equal(await page.locator(".session-drag-ghost").count(), 0, "Fast touch scroll never activates long-press drag");
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 41, pointerType: "touch", isPrimary: true, clientX: x, clientY: y + 22 }));
  }, { x: Math.round(rowBox.x + 60), y: Math.round(rowBox.y + rowBox.height / 2) });

  // Real 320ms long-press hold -> activates drag ghost + highlights target section -> drop moves session!
  const startX = Math.round(rowBox.x + 80);
  const startY = Math.round(rowBox.y + rowBox.height / 2);
  const dropX = Math.round(coreHeaderBox.x + 80);
  const dropY = Math.round(coreHeaderBox.y + 18);
  await page.evaluate(({ sx, sy }) => {
    const row = document.querySelector('.mobile-home-catalog [data-session-id="browser-e2e-misc-sub"]');
    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 42, pointerType: "touch", isPrimary: true, button: 0, clientX: sx, clientY: sy }));
  }, { sx: startX, sy: startY });
  await delay(350);
  await page.evaluate(({ dx, dy }) => {
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 42, pointerType: "touch", isPrimary: true, clientX: dx, clientY: dy }));
  }, { dx: dropX, dy: dropY });
  await page.locator(".session-drag-ghost").waitFor();
  await drawer.locator(`[data-drop-section-id="${coreSectionId}"].is-drop-target`).waitFor();
  await saveShot(page, "03-mobile-longpress-drag.png");
  await page.evaluate(({ dx, dy }) => {
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 42, pointerType: "touch", isPrimary: true, clientX: dx, clientY: dy }));
  }, { dx: dropX, dy: dropY });
  await eventually(
    () => host.snapshot.sessions.find(s => s.sessionId === "browser-e2e-misc-sub")?.projectId,
    coreSectionId,
    "Mobile long-press drop moves session into 核心研发",
  );
  assert.equal(await page.locator(".session-drag-ghost").count(), 0);
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-session-dragging")), false);
  steps.push("Mobile fast touch scroll cancels cleanly while 320ms long-press drag highlights target section and moves session");

  // 2. Mobile NewChatCanvas optional session title ("会话标题（留空自动生成）") + create empty session with explicit title!
  await drawer.locator('button[aria-label^="新建会话"]').first().click();
  const mobileNewChat = page.locator(".new-chat-canvas.is-mobile");
  await mobileNewChat.waitFor();
  const mobileTitleInput = mobileNewChat.getByLabel("会话标题", { exact: true });
  assert.equal(await mobileTitleInput.getAttribute("placeholder"), "留空自动生成");
  await selectCustomOption(page, mobileNewChat.getByRole("combobox", { name: "所属分组", exact: true }), coreSectionId);
  await mobileTitleInput.fill("端到端可选自定义标题");
  const mobileStyle = mobileNewChat.getByRole("combobox", { name: "输出风格", exact: true });
  await selectCustomOption(page, mobileStyle, "Fixture personal style");
  await saveShot(page, "04a-new-chat-title-mobile.png");
  if (proofDir) {
    await page.screenshot({ path: resolve(proofDir, "04-new-chat-title-mobile-desktop.png"), fullPage: false });
  }
  await mobileNewChat.getByRole("button", { name: "创建空会话", exact: true }).click();
  const trustAndCreateBtn = mobileNewChat.getByRole("button", { name: "信任并创建", exact: true });
  await Promise.race([
    trustAndCreateBtn.waitFor({ timeout: 3_000 }).then(() => trustAndCreateBtn.click()),
    eventually(
      () => host.snapshot.sessions.some(s => s.title === "端到端可选自定义标题" && s.projectId === coreSectionId),
      true,
      "created directly",
      3_000,
    ),
  ]).catch(() => {});
  await eventually(
    () => host.snapshot.sessions.some(s => s.title === "端到端可选自定义标题" && s.projectId === coreSectionId),
    true,
    "NewChatCanvas optional title persists onto newly created session in selected section",
  );
  await page.getByRole("heading", { name: "端到端可选自定义标题", exact: true }).waitFor();
  const created = host.snapshot.sessions.find(s => s.title === "端到端可选自定义标题");
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "applyFlagSettings").at(-1).args,
    [created.sessionId, { outputStyle: "Fixture personal style" }]);
  assert.equal(created.outputStyle, "Fixture personal style");
  await openMobileDrawer(page);
  steps.push("Mobile NewChatCanvas renders optional 会话标题 input and creates an explicitly titled session in selected section");

  // 3. Mobile 9229 Inspector Callout ("Claude 调试端口未开启" + "开启调试端口"), Settings "任务通知" and 连接与电脑设置 "调试端口 9229"
  host.snapshot.claudeInspector = {
    platform: "darwin",
    state: "closed",
    port: 9229,
    pollIntervalMs: 3_000,
    clients: [],
    alerts: [],
  };
  host.snapshot.claudeDesktop = { state: "running", detail: "Claude Desktop 正在运行。", canLaunch: true, canQuit: true };
  host.snapshot.desktopApps = [{ id: "claude-desktop", name: "Claude Desktop", state: "running", detail: "Claude Desktop 正在运行。", canLaunch: true, canQuit: true }];
  host.snapshot.runtime = {
    ...host.snapshot.runtime,
    state: "unavailable",
    detail: "Claude Desktop 9229 调试端口尚未开放",
    desktopIntegration: { state: "disconnected", detail: "请开启主进程 9229 调试端口", enabled: true, canRestart: false },
  };
  await host.send({ kind: "snapshot", snapshot: host.snapshot });

  const callout = drawer.locator(".mobile-inspector-callout");
  await callout.waitFor();
  assert.match(await callout.innerText(), /Claude 调试端口未开启/u);
  await saveShot(page, "05-mobile-inspector-callout.png");

  // Settings keeps notifications; the 9229 port and its activation live in 连接与电脑设置.
  await page.locator(".mobile-drawer-dock-nav").getByRole("button", { name: "设置", exact: true }).click();
  const settingsContent = page.locator(".mobile-settings-content");
  await settingsContent.getByText("任务通知", { exact: true }).first().waitFor();
  assert.equal(await settingsContent.getByText(/调试端口/u).count(), 0, "Settings no longer repeats the debug port");
  const notifGroup = settingsContent.getByRole("group", { name: "任务通知开关", exact: true });
  await notifGroup.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem("bridge-mobile-notifications:v1")), "0");
  await notifGroup.getByRole("button", { name: "开启", exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem("bridge-mobile-notifications:v1")), "1");
  await page.setViewportSize({ width: 390, height: 1180 });
  await settingsContent.evaluate(el => { el.scrollTop = 0; });
  await saveShot(page, "06-mobile-settings-notifications.png");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "MobileSettings fits 390px viewport");

  await settingsContent.getByRole("button", { name: "连接与电脑设置" }).click();
  const hostDetails = page.locator(".mobile-host-details");
  const portRow = hostDetails.locator(".mobile-settings-row", { hasText: "调试端口 9229" });
  assert.equal(await portRow.locator(".mobile-settings-value").innerText(), "未开启");
  // The activation result replaces an earlier failed quit on the same row.
  await hostDetails.getByRole("button", { name: "退出", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "退出 Claude", exact: true }).click();
  await hostDetails.getByRole("status").getByText("Claude Desktop 未响应退出请求。", { exact: true }).waitFor();
  host.claudeActivationResult = {
    inspectorState: "closed",
    nativeReady: false,
    detail: "请在电脑的辅助功能设置中授权 Bridge。",
  };
  await hostDetails.getByRole("button", { name: "开启调试端口", exact: true }).click();
  await hostDetails.getByRole("status").getByText(host.claudeActivationResult.detail, { exact: true }).waitFor();
  await saveShot(page, "06a-mobile-inspector-permission.png");

  const closedPort = { claudeInspector: host.snapshot.claudeInspector, runtime: host.snapshot.runtime };
  host.snapshot.claudeInspector = { ...closedPort.claudeInspector, state: "listening" };
  host.snapshot.runtime = {
    ...closedPort.runtime,
    state: "ready",
    detail: "已连接",
    desktopIntegration: { ...closedPort.runtime.desktopIntegration, state: "ready", detail: "已连接" },
  };
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await portRow.getByText("已开启", { exact: true }).waitFor();
  await hostDetails.getByText(host.claudeActivationResult.detail, { exact: true }).waitFor({ state: "detached" });
  Object.assign(host.snapshot, closedPort);
  await host.send({ kind: "snapshot", snapshot: host.snapshot });

  await page.locator(".m-header:visible").getByRole("button", { name: "返回设置", exact: true }).click();
  await settingsContent.getByText("任务通知", { exact: true }).first().waitFor();

  // The catalog reports a listening port and a still-disconnected runtime separately.
  host.claudeActivationResult = { inspectorState: "listening", nativeReady: false, detail: "Claude 原生服务仍在启动。" };
  await page.locator(".m-header:visible").getByRole("button", { name: /^(?:返回|返回会话列表)$/u }).first().click();
  await callout.getByRole("button", { name: "开启调试端口", exact: true }).click();
  await callout.getByText("调试端口已开启，Claude 原生连接未就绪。Claude 原生服务仍在启动。", { exact: true }).waitFor();

  // A ready snapshot arrives before the NewChatCanvas launch reply.
  host.claudeActivationResult = undefined;
  await drawer.locator('button[aria-label^="新建会话"]').first().click();
  await mobileNewChat.getByRole("button", { name: "开启调试端口", exact: true }).click();
  await mobileNewChat.getByRole("status").getByText("调试端口已开启，Claude 原生连接已就绪。", { exact: true }).waitFor();
  assert.equal(await mobileNewChat.getByRole("button", { name: "开启调试端口", exact: true }).count(), 0);
  await saveShot(page, "06b-mobile-inspector-ready.png");
  await openMobileDrawer(page);
  steps.push("连接与电脑设置 shows the launch reply's permission failure and returns to Settings, the catalog distinguishes an open port from native readiness, and NewChatCanvas keeps the success reply visible");

  // 4. Desktop (1280x820): sidebar ... menu (重命名 + 移动到分组), NewChatCanvas title, mouse drag + dynamic unsectioned drop zone!
  const desktop = await page.context().newPage();
  const desktopErrors = [];
  desktop.on("pageerror", err => desktopErrors.push(err.message));
  await desktop.exposeFunction("r4DesktopRequest", async (input) => {
    const req = { kind: "request", requestId: randomUUID(), idempotencyKey: randomUUID(), ...input };
    host.requests.push(structuredClone(req));
    let res;
    if (req.method === "session.open") {
      res = {
        session: host.snapshot.sessions.find(s => s.sessionId === req.params.sessionId),
        history: { sessionId: req.params.sessionId, items: [], hasMore: false },
        latestSeq: host.snapshot.latestSeq,
      };
    } else if (req.method === "evidence.list") {
      res = { evidence: { sessionId: req.params.sessionId, items: [], hasMore: false } };
    } else {
      res = await host.nativeApproval.controllerRequest(req);
      await syncNativeSections(host);
    }
    const nextSnap = {
      ...host.snapshot,
      connection: "connected",
      launchAtLogin: false,
      diagnosticsEnabled: false,
      managedDesktopEnabled: false,
      claudeDesktop: host.snapshot.claudeDesktop,
      claudeInspector: host.snapshot.claudeInspector,
    };
    await desktop.evaluate(snap => window.__r4UpdateDesktop?.(snap), nextSnap);
    return { kind: "response", requestId: req.requestId, ok: true, result: res };
  });
  await desktop.addInitScript((initialSnap) => {
    window.__r4DesktopSnap = initialSnap;
    window.__r4UpdateDesktop = (next) => {
      window.__r4DesktopSnap = next;
      window.__r4ReceiveSnap?.(structuredClone(next));
    };
    window.bridgeDesktop = {
      getSnapshot: async () => structuredClone(window.__r4DesktopSnap),
      onSnapshot: (cb) => {
        window.__r4ReceiveSnap = cb;
        return () => { delete window.__r4ReceiveSnap; };
      },
      onEvent: () => () => {},
      request: input => window.r4DesktopRequest(input),
    };
  }, {
    ...host.snapshot,
    connection: "connected",
    launchAtLogin: false,
    diagnosticsEnabled: false,
    managedDesktopEnabled: false,
    claudeDesktop: host.snapshot.claudeDesktop,
    claudeInspector: host.snapshot.claudeInspector,
  });
  await desktop.setViewportSize({ width: 1280, height: 820 });
  await desktop.emulateMedia({ reducedMotion: "reduce" });
  await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const sidebar = desktop.locator(".desktop-session-sidebar");
  await sidebar.locator('[data-session-id="browser-e2e-misc-sub"]').waitFor();

  // Desktop NewChatCanvas optional title check + screenshot
  await sidebar.getByRole("button", { name: "新建会话", exact: true }).click();
  const desktopNewChat = desktop.locator(".new-chat-canvas.is-desktop");
  await desktopNewChat.waitFor();
  assert.equal(await desktopNewChat.getByLabel("会话标题", { exact: true }).getAttribute("placeholder"), "留空自动生成");
  await selectCustomOption(desktop, desktopNewChat.getByRole("combobox", { name: "输出风格", exact: true }), "Explanatory");
  await saveShot(desktop, "04b-new-chat-title-desktop.png");

  // Desktop sidebar ... menu -> hover row to reveal action button, verify 重命名 + 移动到分组, capture 01-desktop-sidebar-menu-move-rename.png!
  const miscSubRow = sidebar.locator('[data-session-id="browser-e2e-misc-sub"]');
  await miscSubRow.hover();
  await miscSubRow.getByRole("button", { name: "会话操作：同步现有脚本配置", exact: true }).click();
  const desktopSheet = desktop.locator(".m-sheet");
  await desktopSheet.getByRole("button", { name: "重命名", exact: true }).waitFor();
  await desktopSheet.getByRole("button", { name: /移动到分组/u }).waitFor();
  await saveShot(desktop, "01-desktop-sidebar-menu-move-rename.png");

  // Rename via Desktop sidebar ... menu
  await desktopSheet.getByRole("button", { name: "重命名", exact: true }).click();
  const desktopRenameModal = desktop.getByRole("dialog", { name: "重命名会话" });
  await desktopRenameModal.getByLabel("会话名称").fill("桌面侧栏重命名会话");
  await desktopRenameModal.getByRole("button", { name: "保存", exact: true }).click();
  await desktopRenameModal.waitFor({ state: "detached" });
  await eventually(
    async () => (await sidebar.locator('[data-session-id="browser-e2e-misc-sub"]').innerText()).includes("桌面侧栏重命名会话"),
    true,
    "Desktop sidebar rename updates session row title via /rename",
  );

  // Move remaining unsectioned active sessions into 归档调研 so ALL active sessions are inside manual sections!
  for (const unsec of host.snapshot.sessions.filter(s => !s.archivedAt && s.projectId === "claude-unsectioned")) {
    const targetRow = sidebar.locator(`[data-session-id="${unsec.sessionId}"]`);
    await targetRow.hover();
    await targetRow.getByRole("button", { name: `会话操作：${unsec.title}`, exact: true }).click();
    await desktop.locator(".m-sheet").getByRole("button", { name: /移动到分组/u }).click();
    await desktop.locator(".m-sheet").getByRole("button", { name: /归档调研/u }).click();
    await desktop.locator(".m-sheet").waitFor({ state: "detached" });
  }
  await eventually(
    () => host.snapshot.sessions.filter(s => !s.archivedAt).every(s => s.projectId !== "claude-unsectioned"),
    true,
    "All active sessions are now in manual sections so dynamic unsectioned drop zone can be tested",
  );

  // Mouse drag session row in Desktop sidebar -> dynamic "拖到这里移出分组（未分组）" drop zone appears -> hover it, capture 02-desktop-drag-to-section.png, and drop!
  const desktopDragRow = sidebar.locator('[data-session-id="browser-e2e-misc-sub"]');
  const dRowBox = await desktopDragRow.boundingBox();
  assert.ok(dRowBox, "Desktop draggable session row visible");
  await desktop.mouse.move(Math.round(dRowBox.x + 70), Math.round(dRowBox.y + dRowBox.height / 2));
  await desktop.mouse.down();
  await desktop.mouse.move(Math.round(dRowBox.x + 85), Math.round(dRowBox.y + dRowBox.height / 2 + 16), { steps: 4 });

  const unsectionedDropZone = sidebar.locator(".project-group-unsectioned-dropzone");
  await unsectionedDropZone.waitFor();
  assert.match(await unsectionedDropZone.innerText(), /拖到这里移出分组（未分组）/u);
  const unsecBox = await unsectionedDropZone.boundingBox();
  assert.ok(unsecBox, "Dynamic unsectioned drop zone bounding box exists");
  await desktop.mouse.move(Math.round(unsecBox.x + unsecBox.width / 2), Math.round(unsecBox.y + unsecBox.height / 2), { steps: 6 });
  await sidebar.locator(".project-group-unsectioned-dropzone.is-drop-target").waitFor();
  await desktop.locator(".session-drag-ghost").waitFor();
  await saveShot(desktop, "02-desktop-drag-to-section.png");
  await desktop.mouse.up();

  await eventually(
    () => host.snapshot.sessions.find(s => s.sessionId === "browser-e2e-misc-sub")?.projectId,
    "claude-unsectioned",
    "Dropping onto dynamic unsectioned drop zone moves session out of manual section (null -> claude-unsectioned)",
  );
  assert.equal(await desktop.locator(".session-drag-ghost").count(), 0);
  assert.deepEqual(desktopErrors, []);
  await desktop.close();
  steps.push("Desktop sidebar ... menu rename/move, NewChatCanvas title, and mouse drag onto dynamic unsectioned drop zone verified");

  // 5. Nested forks with long titles at large font scales and narrow viewports.
  const longUnbrokenTitle = `超长无空格边界压测标题_${"https://claude.ai/very/long/unbroken/path/segment/9229/inspector/".repeat(3)}尾部校验`;
  assert.ok(longUnbrokenTitle.length >= 200, "Boundary title is >= 200 chars");
  await host.nativeApproval.seedSessions([
    { sessionId: "r4-fork-root", cwd: host.nativeApproval.cwd, harnessCwd: host.nativeApproval.cwd, title: longUnbrokenTitle, lastActivityAt: Date.now() + 500 },
    { sessionId: "r4-fork-l1", cwd: host.nativeApproval.cwd, harnessCwd: host.nativeApproval.cwd, title: `一级分支_${longUnbrokenTitle}`, forkedFromSessionId: "r4-fork-root", lastActivityAt: Date.now() + 400 },
    { sessionId: "r4-fork-l2", cwd: host.nativeApproval.cwd, harnessCwd: host.nativeApproval.cwd, title: `二级分支_${longUnbrokenTitle}`, forkedFromSessionId: "r4-fork-l1", lastActivityAt: Date.now() + 300 },
    { sessionId: "r4-fork-l3", cwd: host.nativeApproval.cwd, harnessCwd: host.nativeApproval.cwd, title: `三级分支_${longUnbrokenTitle}`, forkedFromSessionId: "r4-fork-l2", lastActivityAt: Date.now() + 200 },
    { sessionId: "r4-fork-l4", cwd: host.nativeApproval.cwd, harnessCwd: host.nativeApproval.cwd, title: `四级分支_${longUnbrokenTitle}`, forkedFromSessionId: "r4-fork-l3", lastActivityAt: Date.now() + 100 },
    { sessionId: "r4-fork-l5", cwd: host.nativeApproval.cwd, harnessCwd: host.nativeApproval.cwd, title: "五级分支", forkedFromSessionId: "r4-fork-l4", lastActivityAt: Date.now() },
  ]);
  await syncNativeSections(host);
  const idleSessions = host.snapshot.sessions;
  host.snapshot.sessions = idleSessions.map(session => session.sessionId === "r4-fork-l4"
    ? { ...session, turnState: "running", ownership: "DESKTOP_NATIVE_RUNNING", isCompacting: true }
    : session);
  await host.send({ kind: "snapshot", snapshot: host.snapshot });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => {
    localStorage.setItem("bridge-font-size", "larger");
    document.documentElement.dataset.fontSize = "larger";
    document.documentElement.dataset.effectiveScale = "xlarge";
    document.documentElement.style.setProperty("--font-scale", "1.25");
  });
  const forkRoot = drawer.locator(".mobile-session-family").filter({ has: page.locator('[data-session-id="r4-fork-root"]') });
  await forkRoot.waitFor();
  const collapsedForkToggle = forkRoot.locator(".mobile-fork-toggle");
  for (let depth = 0; depth < 4 && await collapsedForkToggle.count() > 0; depth += 1) {
    await collapsedForkToggle.click();
  }
  const deepForkRow = drawer.locator('[data-session-id="r4-fork-l4"]');
  const compactionBadge = deepForkRow.locator(".session-row-status", { hasText: "正在压缩上下文" });
  await compactionBadge.waitFor();
  const deepForkBounds = await deepForkRow.evaluate(row => {
    const action = row.querySelector(".session-row-action").getBoundingClientRect();
    const title = row.querySelector(".session-row-copy strong").getBoundingClientRect();
    const catalog = row.closest(".drawer-project-list").getBoundingClientRect();
    return { actionRight: action.right, catalogRight: catalog.right, titleWidth: title.width };
  });
  assert.ok(deepForkBounds.actionRight <= deepForkBounds.catalogRight && deepForkBounds.titleWidth > 0,
    `375px compacting fork must keep the action inside the catalog and room for its title: ${JSON.stringify(deepForkBounds)}`);
  steps.push("A depth-four compacting fork at 375px and 1.25× font keeps its title and more action inside the catalog");

  host.snapshot.sessions = idleSessions;
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await compactionBadge.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => document.documentElement.style.setProperty("--font-scale", "1.3"));
  await deepForkRow.scrollIntoViewIfNeeded();
  const catalogOverflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(
    catalogOverflow.scrollWidth <= catalogOverflow.innerWidth,
    `320x568 xlarge catalog must have 0px horizontal overflow (got scrollWidth=${catalogOverflow.scrollWidth} > innerWidth=${catalogOverflow.innerWidth})`,
  );
  await saveShot(page, "07-boundary-narrow-320px-xlarge.png");

  // Also check 320x568 xlarge MobileSettings zero horizontal overflow!
  await page.locator(".mobile-drawer-dock-nav").getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".mobile-settings-content").waitFor();
  const settingsOverflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(
    settingsOverflow.scrollWidth <= settingsOverflow.innerWidth,
    `320x568 xlarge MobileSettings must have 0px horizontal overflow (got scrollWidth=${settingsOverflow.scrollWidth} > innerWidth=${settingsOverflow.innerWidth})`,
  );
  steps.push("320x568 xlarge narrow viewport with 200+ char unbroken CJK/URL titles and 4-level expanded fork tree has 0px horizontal overflow");
}

export async function verifyRound5Ux(page, host, steps, directory, viewports, theme) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const proofDir = process.env.ROUND5_VISUAL_PROOF_DIR && theme === (process.env.ROUND5_VISUAL_PROOF_THEME ?? "dark")
    ? resolve(process.env.ROUND5_VISUAL_PROOF_DIR)
    : undefined;
  if (proofDir) await mkdir(proofDir, { recursive: true });

  async function saveShot(targetPage, fileName) {
    await targetPage.waitForFunction(() => document.getAnimations().every(
      animation => animation.effect.getComputedTiming().iterations === Infinity || animation.playState === "finished",
    ));
    await targetPage.screenshot({ path: resolve(directory, fileName), fullPage: false });
    if (proofDir) {
      await targetPage.screenshot({ path: resolve(proofDir, fileName), fullPage: false });
    }
    viewports.push({ page: fileName, ...targetPage.viewportSize() });
  }

  // (c) Mobile Top-Bar `助理` Capsule on single horizontal row (`unread === 0` -> `unread === 3`, plus 320px xlarge)
  await page.setViewportSize({ width: 390, height: 844 });
  await openMobileDrawer(page);
  const drawer = page.locator(".mobile-home-catalog");
  const topbar = drawer.locator(".mobile-drawer-topbar");
  const hostSwitcher = topbar.locator(".drawer-host-switcher");
  const assistantCapsule = topbar.locator(".drawer-assistant-capsule");
  const composeBtn = topbar.locator(".drawer-compose-button");
  await assistantCapsule.waitFor();
  assert.equal(await assistantCapsule.getAttribute("aria-label"), "助理", "Unread=0 assistant capsule uses concise aria-label");
  assert.equal(await drawer.locator("button").filter({ hasText: "助理" }).count(), 1, "Zero standalone 助理 row outside .mobile-drawer-topbar");
  assert.equal(
    await topbar.evaluate(el => Boolean(el.nextElementSibling?.classList.contains("drawer-top-stack") && el.nextElementSibling.querySelector(".session-search"))),
    true,
    "Search bar sits immediately below .mobile-drawer-topbar with zero standalone 助理 row in between",
  );
  const [hostBox, assistantBox, composeBox] = await Promise.all([
    hostSwitcher.boundingBox(),
    assistantCapsule.boundingBox(),
    composeBtn.boundingBox(),
  ]);
  assert.ok(hostBox && assistantBox && composeBox, "All 3 topbar controls have visible bounding boxes");
  assert.ok(
    Math.abs((hostBox.y + hostBox.height / 2) - (assistantBox.y + assistantBox.height / 2)) <= 2,
    "Host switcher and 助理 capsule share the same horizontal row centerline",
  );
  assert.ok(
    Math.abs((assistantBox.y + assistantBox.height / 2) - (composeBox.y + composeBox.height / 2)) <= 2,
    "助理 capsule and compose button share the same horizontal row centerline",
  );
  assert.ok(hostBox.x + hostBox.width <= assistantBox.x + 1 && assistantBox.x + assistantBox.width <= composeBox.x + 1, "Topbar controls do not overlap");
  await saveShot(page, "01-mobile-topbar-assistant-capsule-dark.png");

  // Deliver 3 unread mails -> verify aria-label updates, badge stays inside capsule, and 320px + xlarge stays on one row with zero horizontal overflow
  await host.nativeApproval.assistantMail.deliver(3);
  await eventually(() => assistantCapsule.getAttribute("aria-label"), "助理，3 条未读", "Unread>0 assistant capsule updates aria-label");
  const [capsuleWithUnreadBox, unreadBadgeBox] = await Promise.all([
    assistantCapsule.boundingBox(),
    assistantCapsule.locator(".desktop-nav-badge").boundingBox(),
  ]);
  assert.ok(
    capsuleWithUnreadBox && unreadBadgeBox
    && unreadBadgeBox.x >= capsuleWithUnreadBox.x
    && unreadBadgeBox.x + unreadBadgeBox.width <= capsuleWithUnreadBox.x + capsuleWithUnreadBox.width,
    "Unread count badge renders inline inside .drawer-assistant-capsule rather than overflowing viewport",
  );
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => {
    localStorage.setItem("bridge-font-size", "larger");
    document.documentElement.dataset.fontSize = "larger";
    document.documentElement.dataset.effectiveScale = "xlarge";
    document.documentElement.style.setProperty("--font-scale", "1.3");
  });
  const [narrowHostBox, narrowAssistantBox, narrowComposeBox] = await Promise.all([
    hostSwitcher.boundingBox(),
    assistantCapsule.boundingBox(),
    composeBtn.boundingBox(),
  ]);
  assert.ok(narrowHostBox && narrowAssistantBox && narrowComposeBox);
  assert.ok(Math.abs((narrowHostBox.y + narrowHostBox.height / 2) - (narrowAssistantBox.y + narrowAssistantBox.height / 2)) <= 2, "320px xlarge host + 助理 stay on one row");
  assert.ok(Math.abs((narrowAssistantBox.y + narrowAssistantBox.height / 2) - (narrowComposeBox.y + narrowComposeBox.height / 2)) <= 2, "320px xlarge 助理 + compose stay on one row");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "320px xlarge Mobile Home has zero horizontal overflow");
  await page.evaluate(() => {
    localStorage.removeItem("bridge-font-size");
    delete document.documentElement.dataset.fontSize;
    delete document.documentElement.dataset.effectiveScale;
    document.documentElement.style.removeProperty("--font-scale");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  steps.push("Mobile top-bar 助理 capsule aligns with host switcher and compose button on one row (unread 0 and >0) with zero standalone row and 0px overflow at 320px xlarge");

  // (b) NewChatCanvas `+ 新建分组…` with 0 existing manual sections + preserved custom title & prompt draft
  assert.equal(
    host.snapshot.projects.filter(p => p.kind === "desktop-group").length,
    0,
    "Host starts with 0 manual sections before opening NewChatCanvas",
  );
  await composeBtn.click();
  const mobileNewChat = page.locator(".new-chat-canvas.is-mobile");
  await mobileNewChat.waitFor();
  const titleInput = mobileNewChat.getByLabel("会话标题", { exact: true });
  const promptInput = mobileNewChat.locator("textarea");
  const sectionTrigger = mobileNewChat.getByRole("combobox", { name: "所属分组", exact: true });
  await sectionTrigger.waitFor();
  const customTitle = "第五轮架构验证会话";
  const customPrompt = "请核查第五轮更新通道切换、子代理长报告滚动与新建分组保真";
  await titleInput.fill(customTitle);
  await promptInput.fill(customPrompt);
  await sectionTrigger.click();
  const listbox = page.getByRole("listbox");
  await listbox.waitFor();
  assert.deepEqual(
    (await listbox.getByRole("option").allInnerTexts()).map(t => t.trim()),
    ["未分组", "+ 新建分组…"],
    "0-section NewChatCanvas renders 未分组 + + 新建分组…",
  );
  await saveShot(page, "04-new-chat-create-section-dropdown.png");
  await listbox.getByRole("option", { name: "+ 新建分组…", exact: true }).click();
  const sectionDialog = page.getByRole("dialog", { name: "新建分组" });
  await sectionDialog.waitFor();
  await sectionDialog.getByLabel("分组名称").fill("第五轮新分组");
  await sectionDialog.getByRole("button", { name: "创建分组", exact: true }).click();
  await sectionDialog.waitFor({ state: "detached" });
  const createdSection = host.snapshot.projects.find(p => p.name === "第五轮新分组");
  assert.ok(createdSection, "section.create created 第五轮新分组 on host");
  await eventually(() => customSelectValue(sectionTrigger), createdSection.projectId, "Newly created section is auto-selected in 所属分组");
  assert.match(await sectionTrigger.innerText(), /第五轮新分组/u);
  assert.equal(await titleInput.inputValue(), customTitle, "Custom session title is 100% preserved across inline section creation");
  assert.equal(await promptInput.inputValue(), customPrompt, "Prompt draft is 100% preserved across inline section creation");
  await saveShot(page, "05-new-chat-section-created-modal.png");
  await openMobileDrawer(page);
  steps.push("NewChatCanvas exposes + 新建分组… even with 0 existing manual sections, auto-selects 第五轮新分组, and preserves custom title & prompt draft");

  // (d) Subagent Detail Sheet Full Scroll & Zero Clipping (~3,500+ char multi-paragraph Markdown reportText)
  const finalParagraphText = "【最终结论段落】第五轮子代理完整回报已全部渲染完毕，末尾零截断。";
  const reportParagraphs = Array.from({ length: 14 }, (_, idx) => (
    `### 阶段审计第 ${idx + 1} 节：跨端状态收敛与滚动布局核查\n\n`
    + `在第 ${idx + 1} 轮布局与协议联调中，已验证 \`.m-sheet-body\` 采用 \`grid-auto-rows: max-content\` 与 \`overflow-y: auto\`，避免隐式 \`auto\` 轨道把 \`overflow: hidden\` 的子代理卡片挤压裁切；同时后端 \`enrichNativeSubagentItems\` 完整保留多段 Markdown 回报全文（含代码块、列表与末尾总结）。\n\n`
    + `- 检查路径：\`apps/desktop/src/claude/native-history-projection.ts\`（段落序号 #${idx + 1}）\n`
    + `- 样式契约：\`apps/client/src/components/mobile/mobile.css\` 与 \`SubagentCard.tsx\` 静态流式展开`
  ));
  const longReportMarkdown = `## 第五轮子代理深度审计报告\n\n${reportParagraphs.join("\n\n")}\n\n${finalParagraphText}`;
  assert.ok(longReportMarkdown.length >= 3_200, `Subagent reportText is ${longReportMarkdown.length} chars (>= 3,200)`);

  const subagentStartAt = Date.now() - 45_000;
  const subagentDoneAt = Date.now() - 3_000;
  await host.nativeApproval.message({
    type: "system",
    subtype: "task_started",
    task_id: "r5-long-subagent",
    tool_use_id: "r5-long-subagent-call",
    description: "审计第五轮架构收敛与子代理长报告滚动",
    timestamp: subagentStartAt,
  });
  for (const event of await host.nativeApproval.message({
    type: "system",
    subtype: "task_notification",
    task_id: "r5-long-subagent",
    tool_use_id: "r5-long-subagent-call",
    status: "completed",
    usage: { tool_uses: 14 },
    summary: longReportMarkdown,
    timestamp: subagentDoneAt,
  })) {
    await host.emit(event.type, event.data, { ...(event.itemId ? { itemId: event.itemId } : {}), ...(event.turnId ? { turnId: event.turnId } : {}) });
  }
  const projectedHistory = (await host.nativeApproval.history()).items.map(item => (
    item.subagent?.agentId === "r5-long-subagent"
      ? {
          ...item,
          subagent: {
            ...item.subagent,
            agentType: "Explore",
            model: "Claude Opus 4.7",
            durationMs: 42_000,
            recentTools: [
              "Read · native-history-projection.ts",
              "Read · transcript-subagents.ts",
              "Edit · mobile.css",
            ],
            reportText: longReportMarkdown,
          },
        }
      : item
  ));
  host.history.splice(0, host.history.length, ...projectedHistory);
  const traySubagent = projectedHistory.find(item => item.subagent?.agentId === "r5-long-subagent")?.subagent;
  assert.ok(traySubagent?.reportText?.includes(finalParagraphText), "Projected subagent item carries full 3,200+ char reportText");
  const r5BackgroundTasks = [{
    id: "r5-long-subagent-call",
    kind: "subagent",
    taskId: "r5-long-subagent",
    toolUseId: "r5-long-subagent-call",
    description: "审计第五轮架构收敛与子代理长报告滚动",
    state: "completed",
    startedAt: subagentStartAt,
    updatedAt: subagentDoneAt,
    subagent: { ...traySubagent, latestText: "已完成全部 14 节架构收敛与布局核查", reportText: undefined },
  }];
  const baseConfiguration = host.nativeApproval.configuration;
  host.nativeApproval.configuration = async request => {
    const result = await baseConfiguration(request);
    if (request.params.includeBackgroundTasks) {
      result.session.backgroundTasks = structuredClone(r5BackgroundTasks);
    }
    return result;
  };

  await openMobileSession(page, sessionId);
  const completedMarker = page.locator(".conversation-stream .background-task-marker.is-completed");
  await completedMarker.waitFor();
  await eventually(
    () => host.requests.some(r => r.method === "session.configuration" && r.params?.includeBackgroundTasks === true),
    true,
    "Background tasks tray loaded before opening focused Subagent Sheet",
  );
  await completedMarker.click();

  const subagentDialog = page.getByRole("dialog", { name: "审计第五轮架构收敛与子代理长报告滚动", exact: true });
  await subagentDialog.waitFor();
  const sheetBody = subagentDialog.locator(".m-sheet-body");
  const footerAllTasksBtn = subagentDialog.getByRole("button", { name: "全部后台任务", exact: true });
  await footerAllTasksBtn.waitFor();

  const initialScrollMetrics = await sheetBody.evaluate(el => {
    const style = getComputedStyle(el);
    const card = el.querySelector(".conversation-subagent-card");
    const cardStyle = card ? getComputedStyle(card) : null;
    return {
      overflowY: style.overflowY,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      cardOverflow: cardStyle?.overflow,
      cardMaxHeight: cardStyle?.maxHeight,
      reportLength: el.querySelector(".subagent-report-section")?.textContent?.length ?? 0,
    };
  });
  assert.equal(initialScrollMetrics.overflowY, "auto", ".m-sheet-body uses overflow-y: auto without clipping");
  assert.equal(initialScrollMetrics.cardOverflow, "visible", "Static SubagentCard inside sheet is not overflow: hidden");
  assert.equal(initialScrollMetrics.cardMaxHeight, "none", "Static SubagentCard inside sheet has max-height: none");
  assert.ok(initialScrollMetrics.reportLength >= 3_000, `Full report rendered (${initialScrollMetrics.reportLength} chars)`);
  assert.ok(
    initialScrollMetrics.scrollHeight > initialScrollMetrics.clientHeight + 300,
    `Sheet body overflows vertically for scrolling (${initialScrollMetrics.scrollHeight} > ${initialScrollMetrics.clientHeight})`,
  );
  const footerBoxBefore = await footerAllTasksBtn.boundingBox();
  assert.ok(footerBoxBefore && footerBoxBefore.y + footerBoxBefore.height <= 844, "Footer 全部后台任务 button is visible before scrolling");

  const bodyBox = await sheetBody.boundingBox();
  assert.ok(bodyBox, "Sheet body has bounding box");
  await page.mouse.move(Math.round(bodyBox.x + bodyBox.width / 2), Math.round(bodyBox.y + bodyBox.height / 2));
  await page.mouse.wheel(0, 6_000);
  await sheetBody.evaluate(el => { el.scrollTop = el.scrollHeight; });

  await eventually(
    () => sheetBody.evaluate(el => el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2),
    true,
    "Scrolling .m-sheet-body reaches the bottom of the long report",
  );
  const finalPara = subagentDialog.getByText(finalParagraphText, { exact: true });
  const [finalParaBox, bodyBoxAfter, footerBoxAfter] = await Promise.all([
    finalPara.boundingBox(),
    sheetBody.boundingBox(),
    footerAllTasksBtn.boundingBox(),
  ]);
  assert.ok(finalParaBox && bodyBoxAfter && footerBoxAfter, "Final paragraph and pinned footer have bounding boxes after scroll");
  assert.ok(
    finalParaBox.y >= bodyBoxAfter.y && finalParaBox.y + finalParaBox.height <= bodyBoxAfter.y + bodyBoxAfter.height + 1,
    "Very last paragraph of 3,200+ char subagent report is cleanly visible without clipping",
  );
  assert.ok(
    Math.abs(footerBoxAfter.y - footerBoxBefore.y) <= 1 && footerBoxAfter.y + footerBoxAfter.height <= 844,
    "Footer 全部后台任务 button stays pinned visible at the bottom during scroll",
  );
  await saveShot(page, "02-subagent-sheet-scrollable-report-dark.png");
  await subagentDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await subagentDialog.waitFor({ state: "detached" });
  await openMobileDrawer(page);
  steps.push("BackgroundTasksSheet renders full 3,200+ char Markdown subagent report without clipping, scrolls cleanly to the final paragraph, and keeps 全部后台任务 pinned");

  // (a) Remote Desktop Updater Channel (`稳定版` | `预发布`) & Check-Only Action (`检查更新` only, 0 widow lines at 360px xlarge)
  async function inspectActionButtons(container) {
    return container.locator("button").evaluateAll(buttons => buttons.map(btn => {
      const style = getComputedStyle(btn);
      const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
      const lineChars = [];
      let textNode = walker.nextNode();
      while (textNode) {
        const value = textNode.nodeValue ?? "";
        for (let i = 0; i < value.length; i += 1) {
          const ch = value[i];
          if (!ch || !ch.trim()) continue;
          const range = document.createRange();
          range.setStart(textNode, i);
          range.setEnd(textNode, i + 1);
          const rect = range.getClientRects()[0];
          if (!rect) continue;
          const existing = lineChars.find(line => Math.abs(line.top - rect.top) <= 3);
          if (existing) existing.text += ch;
          else lineChars.push({ top: rect.top, text: ch });
        }
        textNode = walker.nextNode();
      }
      return {
        label: (btn.textContent ?? "").trim(),
        textWrap: style.textWrap,
        lines: lineChars.map(line => line.text),
      };
    }));
  }

  host.prereleaseLatestVersion = "1.3.5-dev.27";
  host.snapshot.host.version = "1.3.5-dev.23";
  host.snapshot.updater = {
    platform: "darwin",
    arch: "arm64",
    currentVersion: "1.3.5-dev.23",
    channel: "stable",
    autoCheck: true,
    applyMode: "prompt",
    canAutoRestart: false,
    phase: "idle",
  };
  await host.send({ kind: "snapshot", snapshot: host.snapshot });

  await page.locator(".mobile-drawer-dock-nav").getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".mobile-settings-content").getByRole("button", { name: "连接与电脑设置" }).click();
  const remoteRegion = page.locator(".mobile-host-details").getByRole("region", { name: "版本与更新", exact: true });
  await remoteRegion.waitFor();
  await remoteRegion.getByText("v1.3.5-dev.23", { exact: true }).waitFor();
  const channelGroup = remoteRegion.getByRole("group", { name: "电脑端更新通道", exact: true });
  assert.equal(await channelGroup.getByRole("button", { name: "稳定版", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await channelGroup.getByRole("button", { name: "预发布", exact: true }).getAttribute("aria-pressed"), "false");
  await remoteRegion.getByRole("button", { name: "检查更新", exact: true }).waitFor();
  assert.equal(await remoteRegion.getByRole("button", { name: /检查并|升级|下载|重启/u }).count(), 0, "Remote desktop section has zero remote download/upgrade/restart buttons");

  // Check `检查更新` under 360px + xlarge has textWrap: balance and zero 1-char widow lines
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => {
    localStorage.setItem("bridge-font-size", "larger");
    document.documentElement.dataset.fontSize = "larger";
    document.documentElement.dataset.effectiveScale = "xlarge";
    document.documentElement.style.setProperty("--font-scale", "1.3");
  });
  const macButtonsXlarge = await inspectActionButtons(remoteRegion.locator(".mobile-settings-actions"));
  assert.deepEqual(macButtonsXlarge.map(b => b.label), ["检查更新"]);
  for (const btn of macButtonsXlarge) {
    assert.equal(btn.textWrap, "balance", `${btn.label} sets text-wrap: balance`);
    assert.equal(btn.lines.some(line => line.length === 1), false, `${btn.label} at 360px xlarge must not have a 1-char widow line (got ${JSON.stringify(btn.lines)})`);
  }

  // Restore 390x844 normal scale, switch remote host to Windows, click `预发布` -> `发现 v1.3.5-dev.27` while staying check-only
  await page.evaluate(() => {
    localStorage.removeItem("bridge-font-size");
    delete document.documentElement.dataset.fontSize;
    delete document.documentElement.dataset.effectiveScale;
    document.documentElement.style.removeProperty("--font-scale");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  host.snapshot.updater = {
    platform: "win32",
    arch: "x64",
    currentVersion: "1.3.5-dev.23",
    channel: "stable",
    autoCheck: true,
    applyMode: "prompt",
    canAutoRestart: false,
    phase: "idle",
  };
  await host.send({ kind: "snapshot", snapshot: host.snapshot });

  await channelGroup.getByRole("button", { name: "预发布", exact: true }).click();
  await eventually(
    () => host.requests.some(r => r.method === "system.update" && r.params?.action === "check" && r.params?.channel === "prerelease"),
    true,
    "Clicking 预发布 sends system.update { action: 'check', channel: 'prerelease' }",
  );
  await remoteRegion.getByText("发现 v1.3.5-dev.27", { exact: true }).waitFor();
  assert.equal(await channelGroup.getByRole("button", { name: "预发布", exact: true }).getAttribute("aria-pressed"), "true");
  const winButtons390 = await inspectActionButtons(remoteRegion.locator(".mobile-settings-actions"));
  assert.deepEqual(winButtons390.map(b => b.label), ["检查更新"]);
  for (const btn of winButtons390) {
    assert.equal(btn.textWrap, "balance", `${btn.label} sets text-wrap: balance`);
    assert.equal(btn.lines.length, 1, `${btn.label} renders on a clean single line at 390x844 (got ${JSON.stringify(btn.lines)})`);
  }
  await page.locator(".mobile-settings-content").evaluate(el => { el.scrollTop = 0; });
  await saveShot(page, "03-mobile-remote-updater-channel-buttons-dark.png");

  // Check Windows `检查更新` under 360px + xlarge has zero 1-char widow lines and zero horizontal overflow
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => {
    localStorage.setItem("bridge-font-size", "larger");
    document.documentElement.dataset.fontSize = "larger";
    document.documentElement.dataset.effectiveScale = "xlarge";
    document.documentElement.style.setProperty("--font-scale", "1.3");
  });
  const winButtonsXlarge = await inspectActionButtons(remoteRegion.locator(".mobile-settings-actions"));
  assert.deepEqual(winButtonsXlarge.map(b => b.label), ["检查更新"]);
  for (const btn of winButtonsXlarge) {
    assert.equal(btn.textWrap, "balance");
    assert.equal(btn.lines.some(line => line.length === 1), false, `${btn.label} at 360px xlarge must not have a 1-char widow line (got ${JSON.stringify(btn.lines)})`);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "360px xlarge Settings has 0px horizontal overflow");
  steps.push("Remote desktop updater renders 更新通道 (稳定版 | 预发布), transitions 1.3.5-dev.23 -> 发现 v1.3.5-dev.27 via system.update check+channel, and keeps check-only 检查更新 without remote upgrade buttons or 1-char widow lines");
}
