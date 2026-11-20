import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root, sessionId } from "../config.mjs";
import { desktopFixtureRequest, eventually, openMobileDrawer, customSelectValue } from "../helpers.mjs";

export function addOlderCatalogSessions(snapshot) {
  const source = snapshot.sessions.find(session => session.sessionId === sessionId);
  snapshot.sessions.push(
    { ...source, sessionId: "catalog-oldest", title: "更早的目录会话", lastActivityAt: source.lastActivityAt - 120_000, turnState: "waiting" },
    { ...source, sessionId: "catalog-recent", title: "第三个近期会话", lastActivityAt: source.lastActivityAt - 60_000 },
  );
}

export async function verifySessionCatalog(page, host, steps, directory, viewports, baseUrl) {
  async function verifyRecentSessions(catalog) {
    const group = catalog.locator(".project-group").filter({ has: page.locator(`[data-session-id="${sessionId}"]`) });
    const header = catalog.locator(".project-group-open").filter({ hasText: host.snapshot.sessions.find(session => session.sessionId === sessionId).projectName });
    const roots = group.locator(".session-row-v2:not(.is-fork-child)");
    const oldest = catalog.locator('[data-session-id="catalog-oldest"]');
    const fork = group.locator('[data-session-id="browser-e2e-fork"]');
    const branchToggle = group.locator('[data-session-id="browser-e2e-parent"] .session-family-chevron');
    const showOlder = group.getByRole("button", { name: "显示其余 1 个会话 1 个待处理", exact: true });

    await eventually(() => roots.count(), 3, "An expanded section shows only three recent roots");
    assert.deepEqual((await roots.evaluateAll(rows => rows.map(row => row.dataset.sessionId))).sort(), ["browser-e2e-parent", sessionId, "catalog-recent"].sort());
    assert.equal(await oldest.count(), 0);
    assert.equal(await header.locator(".project-count-pill").textContent(), "4");
    await branchToggle.click();
    await fork.waitFor();
    assert.equal(await roots.count(), 3, "An open fork does not consume a slot");
    await showOlder.press("Enter");
    await oldest.locator(".session-row-status.waiting").waitFor();
    assert.equal(await roots.count(), 4);
    await header.click();
    await oldest.waitFor({ state: "detached" });
    await header.click();
    await oldest.waitFor();
    await fork.waitFor();
    await group.getByRole("button", { name: "收起较早会话", exact: true }).click();
    await oldest.waitFor({ state: "detached" });
    await branchToggle.click();
    await fork.waitFor({ state: "detached" });

    const search = catalog.getByPlaceholder("搜索项目或会话");
    await search.fill(host.snapshot.sessions.find(session => session.sessionId === sessionId).projectName);
    await oldest.waitFor();
    assert.equal(await roots.count(), 4, "Search shows all matching roots");
    assert.equal(await showOlder.count(), 0);
    await search.fill("");
    await oldest.waitFor({ state: "detached" });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  const axeSource = await readFile(resolve(root, "node_modules/axe-core/axe.min.js"), "utf8");
  async function capture(name) {
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.effect.getComputedTiming().iterations === Infinity || animation.playState === "finished"));
    await page.evaluate(axeSource);
    const violations = await page.evaluate(async () => (await window.axe.run(document, {
      resultTypes: ["violations"], runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    })).violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })));
    assert.deepEqual(violations, [], `${name} accessibility`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.getBoundingClientRect().height >= 100), true, `${name} has content without horizontal overflow`);
    viewports.push({ page: name, ...page.viewportSize() });
    await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
  }
  async function verifyRowMetadata(row) {
    const bounds = await row.locator(".session-row-copy small").evaluate(element => {
      const { left, right, top, height } = element.getBoundingClientRect();
      const title = element.previousElementSibling.getBoundingClientRect();
      return { left, right, top, height, titleBottom: title.bottom, viewportWidth: innerWidth };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewportWidth && bounds.top >= bounds.titleBottom && bounds.height > 1,
      `Activity and summary appear beneath the title: ${JSON.stringify(bounds)}`);
  }
  const catalogSession = host.snapshot.sessions.find(session => session.sessionId === sessionId);
  catalogSession.currentSummary = "正在验证链路压缩";
  addOlderCatalogSessions(host.snapshot);
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await openMobileDrawer(page);
  const mobileCatalog = page.locator(".mobile-home-catalog");
  const mobileMetadataRow = mobileCatalog.locator(`[data-session-id="${sessionId}"]`);
  await mobileMetadataRow.getByText(/· 正在验证链路压缩/u).waitFor();
  await verifyRecentSessions(mobileCatalog);
  await verifyRowMetadata(mobileMetadataRow);
  const savedMobileSnapshot = structuredClone(host.snapshot);
  assert.equal(await mobileMetadataRow.locator(".session-state-dot.completed").count(), 0);
  catalogSession.lastCompletedTurnId = "mobile-background-result";
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await mobileMetadataRow.locator(".session-state-dot.completed").waitFor();
  await capture("mobile-catalog");
  const seenKey = `bridge-seen-session-completions:${host.pairing.roomId}`;
  // Model another tab persisting a fork acknowledgement after this catalog cached its state.
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ "browser-e2e-fork": "fork-result" })), seenKey);
  await mobileMetadataRow.locator(".session-row-hit").click();
  await page.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key) ?? "{}")[id] === "mobile-background-result", { key: seenKey, id: sessionId });
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key))["browser-e2e-fork"], seenKey), "fork-result");
  await openMobileDrawer(page);
  await mobileMetadataRow.waitFor();
  assert.equal(await mobileMetadataRow.locator(".session-state-dot.completed").count(), 0);
  for (const session of host.snapshot.sessions) {
    session.turnState = "running";
    session.ownership = "DESKTOP_NATIVE_RUNNING";
  }
  const collapsedGroups = page.locator(".mobile-home-catalog .project-group:not(.expanded):not(.archived-group) .project-group-open");
  while (await collapsedGroups.count() > 0) {
    await collapsedGroups.first().click();
  }
  await page.locator(".mobile-home-catalog .mobile-fork-toggle").first().click();
  await page.locator('.mobile-home-catalog [data-session-id="browser-e2e-fork"]').waitFor();
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await page.locator('.mobile-home-catalog .session-row-v2.has-forks .session-state-dot.running').first().waitFor();
  await page.locator('.mobile-home-catalog [data-session-id="browser-e2e-fork"] .session-state-dot.running').waitFor();
  for (const font of ["standard", "large", "larger"]) {
    await page.evaluate((nextFont) => {
      document.documentElement.dataset.fontSize = nextFont;
      document.documentElement.dataset.effectiveScale = nextFont === "larger" ? "xlarge" : nextFont === "large" ? "large" : "normal";
      const scale = nextFont === "larger" ? "1.25" : nextFont === "large" ? "1.125" : "1";
      document.documentElement.style.setProperty("--font-scale", scale);
    }, font);
    const mobileAlign = await page.evaluate(() => {
      const midY = (el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      };
      const forkedRow = document.querySelector(".mobile-home-catalog .session-row-v2.has-forks");
      const plainRow = document.querySelector('.mobile-home-catalog [data-session-id="browser-e2e-fork"]');
      return {
        forkedTitleDelta: Math.abs(midY(forkedRow.querySelector(".session-family-chevron")) - midY(forkedRow.querySelector(".session-row-copy strong"))),
        childTitleDelta: Math.abs(plainRow.querySelector(".session-tree-elbow").getBoundingClientRect().top + 5 - midY(plainRow.querySelector(".session-row-copy strong"))),
        forkedChevronDelta: Math.abs(midY(forkedRow.querySelector(".session-family-chevron")) - midY(forkedRow.querySelector(".session-row-action"))),
        forkedBadgesDelta: Math.abs(midY(forkedRow.querySelector(".session-row-badges")) - midY(forkedRow.querySelector(".session-row-action"))),
        plainBadgesDelta: Math.abs(midY(plainRow.querySelector(".session-row-badges")) - midY(plainRow.querySelector(".session-row-action"))),
      };
    });
    assert.ok(mobileAlign.forkedTitleDelta <= 1.5 && mobileAlign.childTitleDelta <= 1.5, `Mobile ${font} fork chevron and connector align with their titles: ${JSON.stringify(mobileAlign)}`);
    assert.ok(mobileAlign.forkedChevronDelta <= 1.5, `Mobile ${font} forked chevron aligns with action: ${JSON.stringify(mobileAlign)}`);
    assert.ok(mobileAlign.forkedBadgesDelta <= 1.5, `Mobile ${font} forked dot aligns with action: ${JSON.stringify(mobileAlign)}`);
    assert.ok(mobileAlign.plainBadgesDelta <= 1.5, `Mobile ${font} non-forked dot aligns with action: ${JSON.stringify(mobileAlign)}`);
  }
  const parentRow = mobileCatalog.locator('[data-session-id="browser-e2e-parent"]');
  const chevron = parentRow.locator(".session-family-chevron");
  await chevron.scrollIntoViewIfNeeded();
  const icon = await chevron.locator("svg").boundingBox();
  assert.ok(icon);
  const x = icon.x + icon.width / 2;
  const y = icon.y + icon.height / 2;
  await page.mouse.click(x - 19, y);
  assert.ok(await mobileCatalog.isVisible(), "Clicking left of the fork arrow keeps the session catalog open");
  assert.equal(await chevron.getAttribute("aria-expanded"), "false", "Clicking left of the fork arrow collapses the branch");
  await page.mouse.click(x + 19, y);
  assert.ok(await mobileCatalog.isVisible(), "Clicking right of the fork arrow keeps the session catalog open");
  assert.equal(await chevron.getAttribute("aria-expanded"), "true", "Clicking right of the fork arrow expands the branch");
  await mobileCatalog.locator('[data-session-id="browser-e2e-fork"]').waitFor();
  await parentRow.locator(".session-row-action").click();
  const parentMenu = page.getByRole("dialog", { name: "主会话", exact: true });
  await parentMenu.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await chevron.getAttribute("aria-expanded"), "true", "The session menu leaves the fork expanded");
  await chevron.click();
  steps.push("Mobile fork arrow expands and collapses 19px from either side of its center, and the adjacent session menu remains accessible");
  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = "standard";
    document.documentElement.dataset.effectiveScale = "normal";
    document.documentElement.style.setProperty("--font-scale", "1");
  });
  host.snapshot.sessions = savedMobileSnapshot.sessions;
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await eventually(() => page.locator(`[data-session-id="${sessionId}"] .session-state-dot.running`).count(), 0, "Restore idle catalog state");
  await page.getByRole("button", { name: "调整顺序", exact: true }).click();
  await page.getByRole("dialog", { name: "项目顺序" }).waitFor();
  await capture("mobile-project-order");
  await page.getByRole("dialog", { name: "项目顺序" }).getByRole("button", { name: "关闭", exact: true }).click();
  await parentRow.getByText("主会话", { exact: true }).click();
  await page.getByRole("heading", { name: "主会话", exact: true }).waitFor();

  await page.exposeFunction("catalogRequest", async input => {
    const request = desktopFixtureRequest(input);
    return { kind: "response", requestId: request.requestId, ok: true,
      result: await host.nativeApproval.controllerRequest(request) };
  });
  await page.addInitScript(snapshot => {
    window.__catalogSnapshot = snapshot;
    window.__updateCatalog = next => {
      window.__catalogSnapshot = next;
      window.__catalogReceive?.(structuredClone(next));
    };
    window.bridgeDesktop = {
      getSnapshot: async () => structuredClone(window.__catalogSnapshot),
      onSnapshot: receive => { window.__catalogReceive = receive; return () => { delete window.__catalogReceive; }; },
      onEvent: () => () => {},
      request: input => window.catalogRequest(input),
    };
  }, { ...host.snapshot, connection: "connected", launchAtLogin: false, diagnosticsEnabled: false,
    managedDesktopEnabled: false,
    host: { ...host.snapshot.host, capabilities: [...host.snapshot.host.capabilities.filter(value => value !== "plugin.magpie-quota.v1"), "session.visibility.v1"] },
    claudeDesktop: { state: "running", detail: "隔离 Native 宿主", canLaunch: false, canQuit: true } });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const sidebar = page.locator(".desktop-session-sidebar");
  const headers = sidebar.locator('.project-group-open[aria-controls^="desktop-project-"] .project-group-toggle-copy strong');
  const desktopMetadataRow = sidebar.locator(`[data-session-id="${sessionId}"]`);
  await desktopMetadataRow.getByText(/· 正在验证链路压缩/u).waitFor();
  await verifyRecentSessions(sidebar);
  steps.push("Mobile and Desktop show three recent roots, reveal older sessions independently of fork and section toggles, and show all search matches");
  await verifyRowMetadata(desktopMetadataRow);
  assert.equal(await sidebar.locator('.project-group-open[aria-controls="desktop-archived-sessions"] .project-group-toggle-copy strong').textContent(), "已归档");
  const initialOrder = await headers.allTextContents();
  assert.equal(initialOrder.length, 2);
  const selected = sidebar.locator(".session-row-v2.active");
  assert.equal(await selected.count(), 1, "Desktop highlights the selected shared row");
  assert.notEqual(await selected.evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
  const beforePermissionJump = await page.evaluate(() => structuredClone(window.__catalogSnapshot));
  await page.evaluate(() => {
    const snapshot = structuredClone(window.__catalogSnapshot);
    snapshot.permissions = [{ requestId: "older-permission", sessionId: "catalog-oldest", toolUseId: "older-tool", toolName: "Bash", input: {}, createdAt: Date.now(), canAllowAlways: false }];
    window.__updateCatalog(snapshot);
  });
  const olderRow = sidebar.locator('[data-session-id="catalog-oldest"]');
  assert.equal(await olderRow.count(), 0);
  await sidebar.getByRole("button", { name: /有操作待你授权.*更早的目录会话/u }).click();
  await sidebar.locator('[data-session-id="catalog-oldest"].active').waitFor();
  await olderRow.getByText("待授权", { exact: true }).waitFor();
  await sidebar.getByRole("button", { name: "收起较早会话", exact: true }).click();
  await olderRow.waitFor({ state: "detached" });
  await page.locator(".desktop-conversation").getByRole("heading", { name: "更早的目录会话", exact: true }).waitFor();
  await page.evaluate(snapshot => window.__updateCatalog(snapshot), beforePermissionJump);
  await desktopMetadataRow.locator(".session-row-hit").click();
  steps.push("Desktop permission alert reveals and selects an older session; folding the list keeps its conversation open");
  await sidebar.locator(".mobile-fork-toggle").click();
  await sidebar.locator('[data-session-id="browser-e2e-fork"]').waitFor();
  assert.equal(await sidebar.locator('[data-session-id="browser-e2e-btw-archived"]').count(), 0, "Archived sidechats do not appear inline under active parent branches");
  const desktopArchivedToggle = sidebar.locator('.project-group-open[aria-controls="desktop-archived-sessions"]');
  await desktopArchivedToggle.click();
  await sidebar.locator('#desktop-archived-sessions [data-session-id="browser-e2e-btw-archived"]').waitFor();
  assert.match(await sidebar.locator('#desktop-archived-sessions [data-session-id="browser-e2e-btw-archived"]').innerText(), /已归档/u);
  await desktopArchivedToggle.click();
  await sidebar.locator('[data-session-id="browser-e2e-fork"] .session-row-hit').click();
  assert.equal(await sidebar.locator('[data-session-id="browser-e2e-fork"]').evaluate(element => element.classList.contains("active")), true);
  const savedCatalog = await page.evaluate(() => structuredClone(window.__catalogSnapshot));
  await page.evaluate(id => {
    const snapshot = structuredClone(window.__catalogSnapshot);
    snapshot.sessions.find(session => session.sessionId === id).lastCompletedTurnId = "desktop-background-result";
    window.__updateCatalog(snapshot);
  }, sessionId);
  await desktopMetadataRow.locator(".session-state-dot.completed").waitFor();
  await desktopMetadataRow.locator(".session-row-hit").click();
  await desktopMetadataRow.locator(".session-state-dot.completed").waitFor({ state: "detached" });
  await page.evaluate(snapshot => window.__updateCatalog(snapshot), savedCatalog);
  steps.push("Mobile and Desktop show activity and summary, mark an unopened result, and clear it on opening");
  const contrastChecks = [];
  await page.evaluate(axeSource);
  for (const state of ["running", "waiting", "queued"]) {
    for (const selectedId of [sessionId, "browser-e2e-fork", "browser-e2e-btw-archived"]) {
      await page.evaluate(({ snapshot, selectedId, state }) => {
        for (const session of snapshot.sessions) session.pendingCount = 2;
        const session = snapshot.sessions.find(session => session.sessionId === selectedId);
        Object.assign(session, { turnState: state, ownership: state === "running" ? "DESKTOP_NATIVE_RUNNING" : "DESKTOP_NATIVE_IDLE" });
        delete session.archivedAt;
        snapshot.permissions = state === "waiting" ? [{ requestId: "catalog-contrast-permission", sessionId: selectedId, toolUseId: "catalog-contrast-tool", toolName: "Bash", input: { command: "synthetic contrast fixture" }, createdAt: Date.now(), canAllowAlways: false }] : [];
        window.__updateCatalog(snapshot);
      }, { snapshot: savedCatalog, selectedId, state });
      const row = sidebar.locator(`[data-session-id="${selectedId}"]`);
      await row.locator(".session-row-hit").click();
      assert.equal(await row.evaluate(element => element.classList.contains("active")), true, "Contrast check uses the selected row");
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.effect.getComputedTiming().iterations === Infinity || animation.playState === "finished"));
      const violations = await page.evaluate(async () => {
        const result = await window.axe.run(document.querySelector(".desktop-session-sidebar"), {
          runOnly: { type: "rule", values: ["color-contrast"] }, resultTypes: ["violations", "incomplete"],
        });
        return [...result.violations, ...result.incomplete.filter(item => item.nodes.some(node =>
          [...node.any, ...node.all, ...node.none].some(check => check.data?.contrastRatio < 4.5)
        ))].map(item => ({ id: item.id, nodes: item.nodes.map(node => ({ target: node.target, detail: node.failureSummary })) }));
      });
      contrastChecks.push({ selectedId, state, violations });
      assert.deepEqual(violations, [], `Desktop ${state} status contrast with selected ${selectedId}`);
      if (selectedId === "browser-e2e-fork") await sidebar.screenshot({ path: resolve(directory, `desktop-selected-${state}.png`) });
    }
  }
  await writeFile(resolve(directory, "desktop-status-contrast.json"), JSON.stringify(contrastChecks, null, 2));
  await page.evaluate(snapshot => window.__updateCatalog(snapshot), savedCatalog);
  await sidebar.locator('[data-session-id="browser-e2e-fork"] .session-row-hit').click();
  steps.push("Desktop status contrast passes for selected main/fork/sidechat rows in running, waiting and queued states");
  await page.evaluate(sessionId => {
    const snapshot = structuredClone(window.__catalogSnapshot);
    Object.assign(snapshot.sessions.find(session => session.sessionId === sessionId), { turnState: "running", ownership: "DESKTOP_NATIVE_RUNNING", pendingCount: 2 });
    window.__updateCatalog(snapshot);
  }, sessionId);
  await sidebar.locator(`[data-session-id="${sessionId}"]`).getByLabel("2 条排队消息", { exact: true }).waitFor();
  assert.doesNotMatch(await sidebar.locator(`[data-session-id="${sessionId}"]`).innerText(), /桌面运行中/u);
  const runningDot = await sidebar.locator(`[data-session-id="${sessionId}"] .session-state-dot.running`).boundingBox();
  const pendingBadge = await sidebar.locator(`[data-session-id="${sessionId}"]`).getByLabel("2 条排队消息", { exact: true }).boundingBox();
  assert.ok(Math.abs((runningDot.y + runningDot.height / 2) - (pendingBadge.y + pendingBadge.height / 2)) < 4, "Running dot and pending count stay on the same row");
  await capture("desktop-catalog");
  steps.push("mobile/Desktop share family rows; Desktop retains archived sidechats, selection and fork navigation");

  const activeGroupToggles = sidebar.locator(".project-group:not(.archived-group) .project-group-open");
  const toggleCount = await activeGroupToggles.count();
  for (let index = 0; index < toggleCount; index += 1) {
    if ((await activeGroupToggles.nth(index).getAttribute("aria-expanded")) === "true") {
      await activeGroupToggles.nth(index).click();
    }
  }
  assert.equal(await sidebar.locator("[data-session-id]").count(), 0);
  for (let index = 0; index < toggleCount; index += 1) {
    if ((await activeGroupToggles.nth(index).getAttribute("aria-expanded")) === "false") {
      await activeGroupToggles.nth(index).click();
    }
  }
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await sidebar.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await sidebar.waitFor({ state: "visible" });
  const orderTrigger = sidebar.getByRole("button", { name: "调整顺序", exact: true });
  await orderTrigger.focus();
  await orderTrigger.press("Enter");
  const orderDialog = page.getByRole("dialog", { name: "项目顺序" });
  await orderDialog.waitFor();
  assert.equal(await orderDialog.evaluate(element => element.contains(document.activeElement)), true, "Desktop order dialog takes keyboard focus");
  await orderDialog.getByRole("button", { name: "关闭", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await orderDialog.getByRole("button", { name: "完成", exact: true }).evaluate(element => element === document.activeElement), true, "Shift+Tab wraps to the last dialog control");
  await page.keyboard.press("Tab");
  assert.equal(await orderDialog.getByRole("button", { name: "关闭", exact: true }).evaluate(element => element === document.activeElement), true, "Tab wraps to the first dialog control");
  await page.keyboard.press("Escape");
  await orderDialog.waitFor({ state: "detached" });
  assert.equal(await orderTrigger.evaluate(element => element === document.activeElement), true, "Escape restores focus to the order trigger");
  await orderTrigger.press("Enter");
  await orderDialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  const handle = await orderDialog.locator(".project-order-handle").first().boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await orderDialog.locator(".is-placeholder").waitFor();
  await page.keyboard.press("Escape");
  await orderDialog.locator(".is-placeholder").waitFor({ state: "detached" });
  await page.mouse.up();
  assert.equal(await orderDialog.isVisible(), true, "Escape during drag cancels the drag and keeps the dialog open");
  assert.deepEqual(await orderDialog.locator(".project-order-row strong").allTextContents(), initialOrder);
  await orderDialog.getByRole("button", { name: `拖动「${initialOrder[1]}」调整顺序`, exact: true }).press("Home");
  await capture("desktop-project-order");
  await orderDialog.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await orderTrigger.evaluate(element => element === document.activeElement), true, "Close button restores focus to the order trigger");
  const manualOrder = [...initialOrder].reverse();
  await eventually(() => headers.allTextContents(), manualOrder, "Manual project order updates the Desktop catalog");
  await page.reload({ waitUntil: "domcontentloaded" });
  await sidebar.locator(`[data-session-id="${sessionId}"]`).waitFor();
  assert.deepEqual(await headers.allTextContents(), manualOrder, "Desktop project order survives reload");
  await page.evaluate(projectName => {
    const snapshot = structuredClone(window.__catalogSnapshot);
    snapshot.sessions.find(session => session.projectName === projectName).lastActivityAt = Date.now();
    window.__updateCatalog(snapshot);
  }, initialOrder[0]);
  assert.deepEqual(await headers.allTextContents(), manualOrder, "Activity does not move fixed projects");
  await sidebar.getByRole("button", { name: "调整顺序", exact: true }).click();
  await orderDialog.getByRole("button", { name: "按最近活动重排", exact: true }).click();
  await orderDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await eventually(async () => (await headers.allTextContents())[0], initialOrder[0], "Explicit activity reorder moves the newest project first");
  steps.push("Desktop collapse/expand, manual ordering, reload persistence, fixed activity order and explicit activity reorder");

  await page.setViewportSize({ width: 860, height: 620 });
  await capture("desktop-catalog-compact");
  const scroll = await page.locator(".desktop-project-list").evaluate(element => ({ overflow: getComputedStyle(element).overflowY, height: element.clientHeight }));
  assert.equal(scroll.overflow, "auto");
  assert.ok(scroll.height > 0, "Desktop retains its own catalog scroll container");
  await page.setViewportSize({ width: 1200, height: 800 });
  for (const state of ["ready", "not-managed"]) {
    await page.evaluate(state => {
      const snapshot = structuredClone(window.__catalogSnapshot);
      snapshot.sessions = []; snapshot.projects = [];
      snapshot.runtime.desktopIntegration.state = state;
      window.__updateCatalog(snapshot);
    }, state);
    await sidebar.getByText(state === "ready" ? "暂无活跃会话" : "未检测到 Claude Desktop", { exact: true }).waitFor();
    await sidebar.locator(".session-catalog-empty-action").click();
    await page.locator(".new-chat-canvas").getByRole("button", { name: "选择文件夹", exact: true }).click();
    await page.getByRole("dialog", { name: "选择文件夹" }).waitFor();
    await page.getByRole("dialog", { name: "选择文件夹" }).getByRole("button", { name: "关闭", exact: true }).click();
    await capture(`desktop-empty-${state}`);
  }
  steps.push("Desktop distinguishes disconnected/ready empty catalogs and opens creation from both");
}

export function addScrollProjects(host, count) {
  const session = host.snapshot.sessions.find(session => session.sessionId === sessionId);
  while (host.snapshot.projects.length < count) {
    const index = host.snapshot.projects.length;
    const projectId = `scroll-project-${index}`;
    host.snapshot.projects.push({ ...host.snapshot.projects[0], projectId, name: `Scroll project ${index}`, cwd: `/browser-e2e/${projectId}` });
    host.snapshot.sessions.push({ ...session, sessionId: `scroll-session-${index}`, projectId, projectName: `Scroll project ${index}`, title: `Scroll session ${index}` });
  }
}

export async function verifyProjectGrouping(page, host, steps, directory) {
  await openMobileDrawer(page);
  const drawer = page.locator(".mobile-home-catalog");
  const groups = drawer.locator(".project-groups > .project-group:not(.archived-group)");
  const headers = groups.locator(".project-group-open strong");
  const mainGroup = groups.filter({ has: page.locator(`[data-session-id="${sessionId}"]`) });
  const parent = host.snapshot.sessions.find(session => session.sessionId === "browser-e2e-parent");
  const worktree = host.snapshot.sessions.find(session => session.sessionId === sessionId);
  const orderKey = `bridge-project-order:${host.pairing.roomId}`;
  const savedOrder = JSON.stringify([...host.snapshot.projects].reverse().map(project => project.projectId));
  assert.equal(host.snapshot.projects.length, 2);
  assert.equal(worktree.projectId, parent.projectId);
  assert.equal(worktree.parentSessionId, undefined, "Sharing a repository cannot invent a fork relationship");
  assert.notEqual(worktree.cwd, parent.cwd, "The worktree keeps its actual Native cwd");
  assert.equal(host.snapshot.projects.find(project => project.projectId === parent.projectId).cwd, parent.cwd);
  assert.deepEqual(await headers.allTextContents(), ["other-project", "claude-desktop-bridge"]);
  assert.equal(await mainGroup.locator('[data-session-id="browser-e2e-parent"]').count(), 1);
  assert.equal(await mainGroup.locator(".project-count-pill").innerText(), "2");
  const primaryForkToggle = mainGroup.locator(".mobile-fork-toggle");
  const archiveEntry = drawer.locator(".archived-group .project-group-open");
  assert.equal(await primaryForkToggle.count(), 1);
  assert.equal((await primaryForkToggle.innerText()).trim(), "1 个 Fork 分支");
  assert.equal(await drawer.locator('[data-session-id="browser-e2e-fork"]').count(), 0);
  assert.equal(await drawer.locator('[data-session-id="browser-e2e-btw-archived"]').count(), 0);
  await primaryForkToggle.click();
  await mainGroup.locator('[data-session-id="browser-e2e-fork"]').waitFor();
  assert.equal(await primaryForkToggle.count(), 0, "Expanded fork tree omits the extra toggle header row");
  assert.equal(await mainGroup.locator('[data-session-id="browser-e2e-parent"] .session-family-chevron').getAttribute("aria-expanded"), "true");
  assert.equal(await drawer.locator('[data-session-id="browser-e2e-btw-archived"]').count(), 0);
  assert.equal(await mainGroup.locator(".is-archived-fold").count(), 0);
  assert.equal(await archiveEntry.locator(".project-count-pill").innerText(), "1");
  await page.screenshot({ path: resolve(directory, "project-fork-expanded.png"), fullPage: true });
  steps.push("Native fixture projection groups linked worktrees under the repository; active forks exclude archived sidechats, which appear only in the archive area");

  const archivedSidechat = host.snapshot.sessions.find(session => session.sessionId === "browser-e2e-btw-archived");
  const search = drawer.getByPlaceholder("搜索项目或会话", { exact: true });
  await search.fill(archivedSidechat.title);
  await eventually(() => drawer.locator("[data-session-id]").count(), 0, "Searching an archived sidechat cannot surface it as an active root");
  assert.equal(await archiveEntry.locator(".project-count-pill").innerText(), "1");
  await search.fill(worktree.title);
  await eventually(() => headers.allTextContents(), ["claude-desktop-bridge"], "Searching the worktree title keeps its repository project");
  assert.equal(await drawer.locator(`[data-session-id="${sessionId}"]`).count(), 1);
  await search.fill("");
  await eventually(() => headers.allTextContents(), ["other-project", "claude-desktop-bridge"], "Clearing search restores saved project order");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), orderKey), savedOrder);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileDrawer(page);
  await drawer.locator(`[data-session-id="${sessionId}"]`).waitFor();
  assert.deepEqual(await headers.allTextContents(), ["other-project", "claude-desktop-bridge"]);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), orderKey), savedOrder);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Project list fits the phone viewport");

  await archiveEntry.click();
  const archivedContainer = drawer.locator("#mobile-archived-sessions");
  await archivedContainer.locator('[data-session-id="browser-e2e-btw-archived"] .session-row-hit').click();
  const parentChainButton = page.locator(".fork-chain-bar").getByRole("button", { name: "主会话：主会话", exact: true });
  await parentChainButton.waitFor();
  await parentChainButton.click();
  await page.getByRole("heading", { name: "主会话", exact: true }).waitFor();
  assert.equal(await page.locator(".fork-chain-bar").count(), 0, "Parent session does not render outbound child fork chain bar");
  await page.locator(".m-header:visible").getByRole("button", { name: "会话操作", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: /^(?:分支|侧聊|分支与侧聊)\s+\d+/u }).count(), 0, "Parent session menu does not duplicate child forks");
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await openMobileDrawer(page);
  if ((await archiveEntry.getAttribute("aria-expanded")) === "true") await archiveEntry.click();
  await drawer.locator(`[data-session-id="${sessionId}"]`).waitFor();

  const forkSnapshot = host.snapshot.sessions.find(session => session.sessionId === "browser-e2e-fork");
  forkSnapshot.archivedAt = Date.now();
  await host.emit("session.archived", { archived: true, archivedAt: forkSnapshot.archivedAt }, { sessionId: "browser-e2e-fork" });
  await eventually(() => mainGroup.locator(".mobile-fork-group").count(), 0, "Archiving the last active fork removes the parent's fork fold");
  assert.equal(await primaryForkToggle.count(), 0);
  assert.equal(await mainGroup.locator('[data-session-id="browser-e2e-parent"] .session-family-chevron').count(), 0);
  assert.equal(await archiveEntry.locator(".project-count-pill").innerText(), "2");
  await archiveEntry.click();
  await archivedContainer.locator('[data-session-id="browser-e2e-fork"]').waitFor();
  assert.equal(await archivedContainer.locator('[data-session-id="browser-e2e-btw-archived"]').count(), 1);
  assert.deepEqual(await archivedContainer.locator(".session-row-status").allTextContents(), ["已归档", "已归档"]);
  await search.fill(forkSnapshot.title);
  assert.equal(await archivedContainer.locator('[data-session-id="browser-e2e-fork"]').count(), 1);
  assert.equal(await archivedContainer.locator('[data-session-id="browser-e2e-btw-archived"]').count(), 0);
  await search.fill(archivedSidechat.title);
  assert.equal(await archivedContainer.locator('[data-session-id="browser-e2e-btw-archived"]').count(), 1);
  assert.equal(await archivedContainer.locator('[data-session-id="browser-e2e-fork"]').count(), 0);
  await search.fill("");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Archived sessions fit the phone viewport");
  await page.screenshot({ path: resolve(directory, "archived-sessions.png"), fullPage: true });
  await archiveEntry.click();
  steps.push("archivedAt forks and sidechats remain searchable in the archive area with the correct count and archived badges; the active parent has no empty fold");

  assert.equal(host.requests.filter(request => request.method.startsWith("turn.")).length, 0);
  await writeFile(resolve(directory, "project-catalog.json"), JSON.stringify({ projects: host.snapshot.projects, sessions: host.snapshot.sessions }, null, 2));
  await page.screenshot({ path: resolve(directory, "project-list.png"), fullPage: true });

  const openOrderSheet = () => drawer.getByRole("button", { name: "调整顺序", exact: true }).click();
  await openOrderSheet();
  const orderSheet = page.getByRole("dialog", { name: "项目顺序" });
  await orderSheet.waitFor();
  await orderSheet.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  const orderRowTitles = orderSheet.locator(".project-order-row strong");
  assert.deepEqual(await orderRowTitles.allTextContents(), ["other-project", "claude-desktop-bridge"]);
  assert.equal(await orderSheet.locator(".project-order-handle").count(), 2);

  const firstHandle = orderSheet.getByRole("button", { name: "拖动「other-project」调整顺序" });
  const secondRow = orderSheet.locator(".project-order-row").nth(1);
  const handleBox = await firstHandle.boundingBox();
  const secondBox = await secondRow.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  const ghost = page.locator(".project-order-ghost");
  await ghost.waitFor();
  await ghost.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  const liftBox = await ghost.boundingBox();
  const sourceBox = await orderSheet.locator(".project-order-row.is-placeholder").boundingBox();
  assert.ok(Math.abs(sourceBox.height - liftBox.height / 1.02) < 1, "The placeholder keeps the lifted row's height");
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 80, handleBox.y + handleBox.height / 2 + 18);
  const movedBox = await ghost.boundingBox();
  assert.ok(Math.abs(movedBox.x - liftBox.x - 80) < 1 && Math.abs(movedBox.y - liftBox.y - 18) < 1, `The ghost freely follows both pointer axes: ${JSON.stringify({ liftBox, movedBox })}`);
  await page.screenshot({ path: resolve(directory, "project-order-ghost-following.png"), fullPage: true });
  await page.mouse.move(handleBox.x + handleBox.width / 2, secondBox.y + secondBox.height * 0.75, { steps: 6 });
  await orderSheet.locator(".project-order-row.is-dragging").waitFor();
  assert.deepEqual(await orderRowTitles.allTextContents(), ["claude-desktop-bridge", "other-project"]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Dragging project order row stays within 375px viewport");
  await page.screenshot({ path: resolve(directory, "project-order-dragging.png"), fullPage: true });
  const dropBox = await orderSheet.locator(".project-order-row.is-placeholder").boundingBox();
  await page.mouse.up();
  await ghost.waitFor({ state: "hidden" });
  const placedBox = await orderSheet.locator(".project-order-row").last().boundingBox();
  assert.ok(Math.abs(dropBox.height - placedBox.height) < 1, "Dropping restores the row without changing its height");
  assert.equal(await orderSheet.locator(".is-placeholder").count(), 0, "Drop removes the placeholder after settling");
  await orderSheet.getByRole("button", { name: "完成", exact: true }).click();
  await eventually(() => headers.allTextContents(), ["claude-desktop-bridge", "other-project"], "Handle drag persists reordered projects");

  await openOrderSheet();
  await orderSheet.waitFor();
  await orderSheet.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  const targetRowText = orderSheet.locator(".project-order-row").nth(1).locator("strong");
  const firstRow = orderSheet.locator(".project-order-row").nth(0);
  const textBox = await targetRowText.boundingBox();
  const firstBox = await firstRow.boundingBox();
  await page.mouse.move(textBox.x + 24, textBox.y + textBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(260);
  await orderSheet.locator(".project-order-row.is-dragging").waitFor();
  await page.mouse.move(textBox.x + 24, firstBox.y + firstBox.height * 0.25, { steps: 6 });
  assert.deepEqual(await orderRowTitles.allTextContents(), ["other-project", "claude-desktop-bridge"]);
  await page.mouse.up();
  await orderSheet.getByRole("button", { name: "完成", exact: true }).click();
  await eventually(() => headers.allTextContents(), ["other-project", "claude-desktop-bridge"], "Row long-press drag restores saved project order");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), orderKey), savedOrder);

  steps.push("saved main-project ordering survives search and reload, handle and long-press drag reorder projects cleanly, unrelated projects remain separate, and the 375px layout has no horizontal overflow");

  for (const [count, width] of [[9, 375], [30, 375], [30, 900]]) {
    addScrollProjects(host, count);
    await host.send({ kind: "snapshot", snapshot: host.snapshot });
    await eventually(() => headers.count(), count, "Long project catalog arrives through the encrypted snapshot");
    await page.setViewportSize({ width, height: 568 });
    await openOrderSheet();
    await orderSheet.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    assert.equal(await orderRowTitles.count(), count);
    const body = orderSheet.locator(".m-sheet-body");
    const headerBox = await orderSheet.locator(".m-sheet-header").boundingBox();
    const footerBox = await orderSheet.locator(".m-sheet-footer").boundingBox();
    const bodyBox = await body.boundingBox();
    await page.mouse.move(bodyBox.x + 80, bodyBox.y + bodyBox.height / 2);
    await page.mouse.wheel(0, 10000);
    await eventually(() => body.evaluate(el => el.scrollTop > 0 && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1), true, "Wheel reaches the bottom of the sheet body");
    const geometry = await orderSheet.evaluate(el => {
      const body = el.querySelector(".m-sheet-body");
      const list = el.querySelector(".project-order-list");
      return { bodyHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight, scrollTop: body.scrollTop,
        listHeight: list.clientHeight, listScrollHeight: list.scrollHeight,
        lastBottom: list.lastElementChild.getBoundingClientRect().bottom, bodyBottom: body.getBoundingClientRect().bottom };
    });
    await writeFile(resolve(directory, `project-order-${count}-${width}-geometry.json`), JSON.stringify(geometry, null, 2));
    assert.ok(geometry.lastBottom <= geometry.bodyBottom, `All ${count} projects remain reachable: ${JSON.stringify(geometry)}`);
    assert.deepEqual(await orderSheet.locator(".m-sheet-header").boundingBox(), headerBox, "Scrolling keeps the title fixed");
    assert.deepEqual(await orderSheet.locator(".m-sheet-footer").boundingBox(), footerBox, "Scrolling keeps the actions fixed");
    await page.screenshot({ path: resolve(directory, `project-order-${count}-${width}-scrolled.png`), fullPage: true });
    if (count === 30 && width === 375) {
      await body.evaluate(el => { el.scrollTop = 0; });
      const beforeClick = await orderRowTitles.allTextContents();
      const edgeIndex = await orderSheet.evaluate(el => {
        const bottom = el.querySelector(".m-sheet-body").getBoundingClientRect().bottom;
        return [...el.querySelectorAll(".project-order-row")].findIndex(row => {
          const rect = row.getBoundingClientRect();
          return rect.top + rect.height / 2 > bottom - 40 && rect.top + rect.height / 2 < bottom;
        });
      });
      assert.ok(edgeIndex >= 0, "The long catalog has a handle inside the edge zone");
      const edgeHandle = await orderSheet.locator(".project-order-handle").nth(edgeIndex).boundingBox();
      await page.mouse.move(edgeHandle.x + edgeHandle.width / 2, edgeHandle.y + edgeHandle.height / 2);
      await page.mouse.down();
      await page.evaluate(() => new Promise(resolve => {
        let remaining = 10;
        const frame = () => { if (--remaining === 0) resolve(); else requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
      }));
      assert.equal(await body.evaluate(el => el.scrollTop), 0, "A stationary edge handle press does not scroll");
      await page.mouse.up();
      assert.deepEqual(await orderRowTitles.allTextContents(), beforeClick, "A stationary handle click does not reorder");
      const orderSelect = orderSheet.locator(".select-menu-trigger");
      await orderSelect.waitFor();
      assert.equal(await customSelectValue(orderSelect), String(edgeIndex), "Handle click still opens position selection");
      await orderSheet.getByRole("button", { name: "完成", exact: true }).click();
      await openOrderSheet();
      await orderSheet.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
      const centerHandle = await orderSheet.locator(".project-order-handle").nth(1).boundingBox();
      await page.mouse.move(centerHandle.x + centerHandle.width / 2, centerHandle.y + centerHandle.height / 2);
      await page.mouse.down();
      await page.mouse.move(bodyBox.x + 80, bodyBox.y + bodyBox.height / 2);
      const beforeWheelIndex = await orderSheet.locator(".project-order-row").evaluateAll(rows => rows.findIndex(row => row.classList.contains("is-placeholder")));
      await page.mouse.wheel(0, 224);
      await eventually(() => orderSheet.locator(".project-order-row").evaluateAll((rows, index) => rows.findIndex(row => row.classList.contains("is-placeholder")) >= index + 3, beforeWheelIndex), true, "Wheel scrolling updates the drop slot without another pointermove");
      await page.keyboard.press("Escape");
      await ghost.waitFor({ state: "hidden" });
      await page.mouse.up();
      assert.equal(await orderSheet.locator(".is-placeholder").count(), 0, "Escape leaves no ghost or placeholder");
      assert.deepEqual(await orderRowTitles.allTextContents(), beforeClick, "Escape restores the pre-drag order");
      const touch = await page.context().newCDPSession(page);
      await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      await page.evaluate(() => {
        window.projectOrderTouchMoves = [];
        document.addEventListener("touchmove", event => window.projectOrderTouchMoves.push(event.defaultPrevented), { passive: true });
      });
      await body.evaluate(el => { el.scrollTop = 0; });
      assert.equal(await orderSheet.locator(".project-order-handle").first().evaluate(el => getComputedStyle(el).touchAction.includes("none")), false, "Idle handles allow native touch scrolling");
      const swipeX = bodyBox.x + 80;
      const swipeY = bodyBox.y + bodyBox.height - 24;
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: swipeX, y: swipeY }] });
      for (let step = 1; step <= 8; step += 1) {
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: swipeX, y: swipeY - step * 20 }] });
      }
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await eventually(() => body.evaluate(el => el.scrollTop > 80), true, "A real touch swipe scrolls the long list");
      assert.equal(await orderSheet.locator(".is-dragging").count(), 0, "Swiping cancels the pending long-press");
      assert.deepEqual(await page.evaluate(() => [...new Set(window.projectOrderTouchMoves)]), [false], "Idle touch moves are never prevented");
      // Stop inertial scrolling before a separate long-press gesture.
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: swipeX, y: bodyBox.y + 30 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await body.evaluate(el => { el.scrollTop = 0; });
      const draggedName = await orderRowTitles.first().innerText();
      const textBox = await orderSheet.locator(".project-order-row strong").first().boundingBox();
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: textBox.x + 20, y: textBox.y + textBox.height / 2 }] });
      await orderSheet.locator(".project-order-row.is-dragging").waitFor();
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: swipeX, y: bodyBox.y + bodyBox.height - 5 }] });
      await eventually(() => orderRowTitles.last().textContent(), draggedName, "Holding at the bottom edge scrolls and drags to the last position");
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: swipeX, y: bodyBox.y + 5 }] });
      await eventually(() => body.evaluate(el => el.scrollTop), 0, "Holding at the top edge scrolls back to the start");
      await eventually(() => orderRowTitles.first().textContent(), draggedName, "Top-edge scrolling updates the insertion position without another move");
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      assert.equal(await orderSheet.locator(".is-dragging").count(), 0, "Touch release ends the drag");
      await page.evaluate(() => { window.projectOrderTouchMoves = []; });
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: swipeX, y: swipeY }] });
      for (let step = 1; step <= 8; step += 1) {
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: swipeX, y: swipeY - step * 20 }] });
      }
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await eventually(() => body.evaluate(el => el.scrollTop > 80), true, "Native touch scrolling resumes after the drag");
      assert.deepEqual(await page.evaluate(() => [...new Set(window.projectOrderTouchMoves)]), [false], "Drag touch blocking is removed on release");
      await touch.detach();
    }
    await orderSheet.getByRole("button", { name: "完成", exact: true }).click();
  }
  steps.push("9 projects on a short phone viewport and 30 projects in a centered sheet scroll to the final row with fixed header and footer");
  steps.push("a lifted ghost follows x/y with an equal-height placeholder and settles on drop; stationary handle clicks select a position without reordering; wheel scrolling updates the drop slot; Escape and touch release clean up and restore native scrolling");
}

export async function verifySectionManage(page, host, steps, directory) {
  await openMobileDrawer(page);
  const drawer = page.locator(".mobile-home-catalog");
  const groups = drawer.locator(".project-groups > .project-group:not(.archived-group)");
  const headers = groups.locator(".project-group-open strong");
  const search = drawer.getByPlaceholder("搜索项目或会话", { exact: true });
  const folderNames = host.snapshot.projects.filter(project => project.kind !== "desktop-group").map(project => project.name).sort();
  const { projectId: originalProjectId, projectName: originalProjectName } = host.snapshot.sessions.find(item => item.sessionId === "browser-e2e-misc-sub");
  assert.ok(folderNames.length > 0, "Section management starts with folder projects");
  assert.deepEqual((await headers.allTextContents()).sort(), folderNames);

  async function createSectionFromDirectory(name) {
    await drawer.getByRole("button", { name: "+ 分组", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建 Section" });
    await dialog.getByLabel("Section 名称").fill(name);
    await dialog.getByRole("button", { name: "创建 Section", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  }

  await createSectionFromDirectory("待办分组");
  await createSectionFromDirectory("临时空组");
  await eventually(
    async () => {
      const names = await headers.allTextContents();
      return names.includes("待办分组") && names.includes("临时空组");
    },
    true,
    "Newly created empty sections appear in catalog",
  );

  // Folder groups do not render custom section management actions; custom sections do.
  assert.equal(await drawer.getByRole("button", { name: "管理分组：待办分组", exact: true }).count(), 1);
  for (const name of folderNames) {
    assert.equal(await drawer.getByRole("button", { name: `管理分组：${name}`, exact: true }).count(), 0);
  }

  // Empty manual groups collapse by default, except the just-created revealedEmptySectionKey; across reload all 0-session manual groups start collapsed.
  assert.equal(await groups.filter({ hasText: "待办分组" }).locator(".project-group-open").getAttribute("aria-expanded"), "false");
  assert.equal(await groups.filter({ hasText: "临时空组" }).locator(".project-group-open").getAttribute("aria-expanded"), "true");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileDrawer(page);
  await drawer.locator(`[data-session-id="${sessionId}"]`).waitFor();
  assert.equal(await groups.filter({ hasText: "待办分组" }).locator(".project-group-open").getAttribute("aria-expanded"), "false");
  assert.equal(await groups.filter({ hasText: "临时空组" }).locator(".project-group-open").getAttribute("aria-expanded"), "false");

  await search.fill("临时空组");
  await eventually(() => headers.allTextContents(), ["临时空组"], "Search still surfaces matching empty custom sections");
  assert.equal(await groups.filter({ hasText: "临时空组" }).locator(".project-group-open").getAttribute("aria-expanded"), "true");
  await search.fill("");
  await eventually(
    async () => (await headers.allTextContents()).includes("临时空组"),
    true,
    "Clearing search restores catalog groups",
  );
  assert.equal(await groups.filter({ hasText: "临时空组" }).locator(".project-group-open").getAttribute("aria-expanded"), "false");

  await createSectionFromDirectory("新建即现");
  await eventually(
    async () => {
      const names = await headers.allTextContents();
      return names.includes("新建即现") && names.includes("待办分组") && names.includes("临时空组");
    },
    true,
    "Creating a new section reveals the newly created empty section",
  );
  assert.equal(await groups.filter({ hasText: "新建即现" }).locator(".project-group-open").getAttribute("aria-expanded"), "true");
  await drawer.getByRole("button", { name: "管理分组：新建即现", exact: true }).click();
  await page.getByRole("button", { name: "删除分组", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "删除分组", exact: true }).click();
  await eventually(async () => (await headers.allTextContents()).includes("新建即现"), false, "Temporary section cleaned up");
  steps.push("empty custom sections default to collapsed across reloads, remain searchable, and auto-expand the newly created section");

  // Empty sections confirm too; the dialog does not mention moving sessions.
  await drawer.getByRole("button", { name: "管理分组：临时空组", exact: true }).click();
  await page.getByRole("button", { name: "删除分组", exact: true }).click();
  const emptyConfirm = page.getByRole("alertdialog");
  assert.doesNotMatch(await emptyConfirm.innerText(), /组内/u);
  await emptyConfirm.getByRole("button", { name: "删除分组", exact: true }).click();
  await eventually(
    async () => (await headers.allTextContents()).includes("临时空组"),
    false,
    "Deleted empty section disappears immediately",
  );

  // Rename custom section ("待办分组" -> "重点推进").
  await drawer.getByRole("button", { name: "管理分组：待办分组", exact: true }).click();
  await page.getByRole("button", { name: "重命名分组", exact: true }).click();
  const renameDialog = page.getByRole("dialog", { name: "重命名分组" });
  await renameDialog.getByLabel("分组名称").fill("重点推进");
  await renameDialog.getByRole("button", { name: "保存", exact: true }).click();
  await renameDialog.waitFor({ state: "detached" });
  await eventually(
    async () => {
      const names = await headers.allTextContents();
      return names.includes("重点推进") && !names.includes("待办分组");
    },
    true,
    "Renamed custom section updates in catalog",
  );
  steps.push("empty sections delete after confirmation and custom sections rename via native section.rename");

  // Move a session into "重点推进", then verify non-empty delete requires confirmation and returns session to folder.
  await drawer.locator('[data-session-id="browser-e2e-misc-sub"]').getByRole("button", { name: "会话操作", exact: true }).click();
  await page.getByRole("button", { name: /移动到分组/u }).click();
  await page.locator(".m-sheet").getByRole("button", { name: /重点推进/u }).click();
  await eventually(
    () => host.snapshot.sessions.find(item => item.sessionId === "browser-e2e-misc-sub")?.projectName,
    "重点推进",
    "Session moved into renamed section",
  );

  await drawer.getByRole("button", { name: "管理分组：重点推进", exact: true }).click();
  await page.getByRole("button", { name: "删除分组", exact: true }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await confirmDialog.waitFor();
  assert.match(await confirmDialog.innerText(), /组内 1 个会话不会删除，将移回各自的项目目录/u);
  await page.screenshot({ path: resolve(directory, "section-delete-confirm.png"), fullPage: true });
  await confirmDialog.getByRole("button", { name: "删除分组", exact: true }).click();
  await confirmDialog.waitFor({ state: "detached" });

  await eventually(
    async () => (await headers.allTextContents()).includes("重点推进"),
    false,
    "Confirmed non-empty section deletion removes custom section",
  );
  await eventually(
    () => drawer.locator('[data-session-id="browser-e2e-misc-sub"]').count(),
    1,
    "Session inside deleted section remains intact and returns to its folder group",
  );
  const restoredSession = host.snapshot.sessions.find(item => item.sessionId === "browser-e2e-misc-sub");
  assert.equal(restoredSession.projectId, originalProjectId);
  assert.equal(restoredSession.projectName, originalProjectName);
  assert.equal(host.requests.some(request => request.method === "section.rename"), true);
  assert.equal(host.requests.filter(request => request.method === "section.delete").length, 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Section manage UI fits 375px viewport");
  steps.push("deleting a non-empty section requires confirmation, calls native delete_section, and safely returns sessions to their folder project");
}
