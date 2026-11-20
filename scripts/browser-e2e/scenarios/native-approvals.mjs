import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sessionId, originalTitle } from "../config.mjs";
import { desktopFixtureRequest, eventually, openMobileDrawer, openMobileSession, selectCustomOption, customSelectValue } from "../helpers.mjs";

async function verifySessionHeader(page, host, steps, directory, baseUrl) {
  const session = host.snapshot.sessions.find(session => session.sessionId === sessionId);
  const profile = { ...host.nativeApproval.profile(), modelDisplayName: "Claude Opus 5.5 · custom-model-identifier-with-a-long-unbroken-name-1234567890", effort: "high" };
  host.nativeApproval.profile = () => profile;
  const modes = { default: "逐个确认", acceptEdits: "自动接受编辑", bypassPermissions: "完全授权", plan: "计划模式", auto: "自动模式", dontAsk: "仅允许已批准" };
  const accessibility = await page.context().newCDPSession(page);
  async function accessibleProfile() {
    const { root } = await accessibility.send("DOM.getDocument");
    const { nodeId } = await accessibility.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'button[aria-label="会话设置"]' });
    const { nodes } = await accessibility.send("Accessibility.getPartialAXTree", { nodeId });
    const button = nodes.find(node => node.role?.value === "button");
    return { name: button.name.value, description: button.description?.value };
  }
  for (const [mode, label] of Object.entries(modes)) {
    profile.nativePermissionMode = mode;
    Object.assign(session, profile);
    await host.send({ kind: "snapshot", snapshot: host.snapshot });
    await eventually(() => page.locator(".m-header .session-profile-summary").textContent(), `${profile.modelDisplayName} · 高 · ${label}`, "The header shows the current mode with the complete model and effort");
    await eventually(accessibleProfile, { name: "会话设置", description: `${profile.modelDisplayName} · 高 · ${label}` }, "Mobile settings announce the current snapshot profile");
  }
  const notice = page.getByRole("status", { name: "Desktop 会话授权变更", exact: true });
  for (const state of ["requested", "not-applied", "confirmed"]) {
    profile.nativePermissionModeChange = { requestId: "header-mode", mode: "bypassPermissions", state, observedMode: "dontAsk" };
    Object.assign(session, profile);
    await host.send({ kind: "snapshot", snapshot: host.snapshot });
    await eventually(() => notice.count(), state === "confirmed" ? 0 : 1, `Permission notice state ${state}`);
    assert.ok((await page.locator(".m-header .session-profile-summary").textContent()).includes("仅允许已批准"), "A requested mode never replaces the observed header mode");
  }
  async function checkProfileLayout(summary, surface, { metaText, stacked, modelEllipsized, canConfigure }) {
    const layout = await summary.evaluate(element => {
      const modelLine = element.querySelector(".is-model-line");
      const metaLine = element.querySelector(".is-meta-line");
      const bounds = element.getBoundingClientRect();
      const model = modelLine.getBoundingClientRect();
      const meta = metaLine.getBoundingClientRect();
      const chevron = element.parentElement.querySelector("svg")?.getBoundingClientRect();
      const modelStyle = getComputedStyle(modelLine);
      return {
        metaText: metaLine.textContent,
        metaVisible: meta.left >= bounds.left && meta.right <= bounds.right && metaLine.scrollWidth <= metaLine.clientWidth,
        layout: meta.top >= model.bottom && meta.left === model.left ? "stacked"
          : meta.left >= model.right && model.top < meta.bottom && meta.top < model.bottom ? "inline" : "misaligned",
        modelVisible: modelLine.scrollWidth <= modelLine.clientWidth,
        modelEllipsized: modelLine.scrollWidth > modelLine.clientWidth && modelStyle.textOverflow === "ellipsis" && modelStyle.whiteSpace === "nowrap",
        inViewport: bounds.left >= 0 && bounds.right <= innerWidth,
        chevronAtEnd: chevron ? chevron.left >= bounds.right && chevron.right <= innerWidth : null,
      };
    });
    assert.deepEqual(layout, { metaText, metaVisible: true, layout: stacked ? "stacked" : "inline", modelVisible: !modelEllipsized,
      modelEllipsized, inViewport: true, chevronAtEnd: canConfigure ? true : null }, `${surface} profile layout`);
  }
  const mobileSummary = page.locator(".m-header .session-profile-summary");
  const longModelName = profile.modelDisplayName;
  profile.modelDisplayName = "bridge/gpt-6.2-sol";
  Object.assign(session, profile);
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await eventually(() => mobileSummary.textContent(), "bridge/gpt-6.2-sol · 高 · 仅允许已批准", "The mobile header receives the model label");
  await checkProfileLayout(mobileSummary, "Mobile 375px", { metaText: "高 · 仅允许已批准", stacked: true, modelEllipsized: false, canConfigure: true });
  await page.screenshot({ path: resolve(directory, "mobile-header-375.png"), fullPage: true });
  profile.modelDisplayName = longModelName;
  Object.assign(session, profile);
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await eventually(() => mobileSummary.textContent(), `${longModelName} · 高 · 仅允许已批准`, "The mobile header receives the long model label");
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    for (const font of ["standard", "larger"]) {
      await page.evaluate(font => { document.documentElement.dataset.fontSize = font; }, font);
      for (const canConfigure of [false, true]) {
        session.allowedActions.canConfigure = canConfigure;
        await host.send({ kind: "snapshot", snapshot: host.snapshot });
        await eventually(() => page.getByRole("button", { name: "会话设置", exact: true }).count(), canConfigure ? 1 : 0, "Settings availability changes only the header action");
        await checkProfileLayout(mobileSummary, `Mobile ${width}px ${font} configure=${canConfigure}`, {
          metaText: "高 · 仅允许已批准", stacked: true, modelEllipsized: true, canConfigure,
        });
      }
    }
  }
  await page.screenshot({ path: resolve(directory, "mobile-header-larger-320.png"), fullPage: true });
  await page.exposeFunction("headerRequest", async input => {
    const request = desktopFixtureRequest(input);
    return { kind: "response", requestId: request.requestId, ok: true,
      result: await host.nativeApproval.controllerRequest(request) };
  });
  await page.addInitScript(snapshot => {
    window.__headerSnapshot = snapshot;
    window.bridgeDesktop = {
      getSnapshot: async () => structuredClone(window.__headerSnapshot),
      onSnapshot: receive => { window.__headerReceive = receive; return () => { delete window.__headerReceive; }; },
      onEvent: () => () => {}, request: input => window.headerRequest(input),
    };
    localStorage.setItem("bridge-font-size", "larger");
  }, { ...host.snapshot, connection: "connected", launchAtLogin: false, diagnosticsEnabled: false, managedDesktopEnabled: false,
    claudeDesktop: { state: "running", detail: "Synthetic Native", canLaunch: false, canQuit: true } });
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(`[data-session-id="${sessionId}"] .session-row-hit`).click();
  await page.locator(".desktop-conversation .session-profile-summary").waitFor();
  for (const [canConfigure, mode] of [[true, "plan"], [true, "auto"], [false, "dontAsk"]]) {
    await page.evaluate(({ canConfigure, mode, sessionId }) => {
      const session = window.__headerSnapshot.sessions.find(item => item.sessionId === sessionId);
      session.allowedActions.canConfigure = canConfigure;
      session.nativePermissionMode = mode;
      window.__headerReceive(structuredClone(window.__headerSnapshot));
    }, { canConfigure, mode, sessionId });
    await eventually(() => page.getByRole("button", { name: "会话设置", exact: true }).count(), canConfigure ? 1 : 0, "Desktop retains a read-only header when settings are unavailable");
    const summary = page.locator(".desktop-conversation .session-profile-summary");
    await eventually(() => summary.textContent(), `${profile.modelDisplayName} · 高 · ${modes[mode]}`, "Desktop receives updated mode without a configuration read");
    if (canConfigure) await eventually(accessibleProfile, { name: "会话设置", description: `${profile.modelDisplayName} · 高 · ${modes[mode]}` }, "Desktop settings announce the current snapshot profile");
    await checkProfileLayout(summary, `Desktop configure=${canConfigure}`, {
      metaText: `高 · ${modes[mode]}`, stacked: false, modelEllipsized: true, canConfigure,
    });
  }
  await accessibility.detach();
  await page.screenshot({ path: resolve(directory, "desktop-header-readonly-larger.png"), fullPage: true });
  steps.push("mobile gives the model its own line at 375/320px and keeps the full effort, permission mode, and chevron visible; desktop stays inline and both retain full accessible settings descriptions and read-only summaries");
}

export async function verifyNativeApprovals(page, host, steps, directory, baseUrl, relayRoutes) {
  await openMobileSession(page);
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const slashInput = page.getByRole("combobox", { name: "给 Claude 发指令" });
  await slashInput.fill("/r");
  await page.getByRole("option", { name: /^\/review\b/u }).waitFor();
  assert.equal(await page.getByRole("option").count(), 3);
  await page.getByRole("option", { name: /^\/rewind\b/u }).waitFor();
  const menuAlpha = await page.locator(".slash-command-menu").evaluate(menu => {
    const context = document.createElement("canvas").getContext("2d");
    context.fillStyle = getComputedStyle(menu).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  assert.equal(menuAlpha, 255, "The command menu has an opaque base in both themes");
  await page.screenshot({ path: resolve(directory, "native-slash-menu.png"), fullPage: true });
  await slashInput.press("ArrowDown");
  await slashInput.press("Enter");
  assert.equal(await slashInput.inputValue(), "/review ");
  assert.equal(host.requests.filter(request => request.method === "session.commands").length, 1);
  assert.equal(host.requests.filter(request => request.method === "turn.start").length, 0);
  await slashInput.fill("");
  steps.push("custom slash commands come from synthetic-directory metadata through session.commands; selection inserts without sending");
  await host.emit("session.observed", { role: "assistant", text: "", interactivePrompt: {
    kind: "wrap-up", blocked: true, ask: "批准这项原生操作？", actions: [{ label: "批准实施", message: "批准实施" }],
  } }, { itemId: "native-unavailable-confirmation" });
  const unavailable = page.locator(".interactive-prompt-card").filter({ hasText: "批准这项原生操作？" });
  await unavailable.getByText("需在电脑端确认", { exact: true }).waitFor();
  assert.equal(await unavailable.getByRole("button", { name: /批准实施/u }).isDisabled(), true);
  await host.emit("session.observed", { role: "assistant", text: "", interactivePrompt: {
    kind: "question", toolUseId: "unmatched-native-question", questions: [{ question: "未接通的历史问题", options: [{ label: "确认" }] }],
  } }, { itemId: "native-unmatched-question" });
  const unmatched = page.locator(".interactive-prompt-card").filter({ hasText: "未接通的历史问题" });
  await unmatched.getByText("提问已不在待回答列表", { exact: true }).waitFor();
  assert.equal(await unmatched.getByRole("button", { name: "确认", exact: true }).isDisabled(), true);
  assert.equal(host.requests.filter((request) => request.method === "turn.start").length, 0);
  await page.screenshot({ path: resolve(directory, "native-unavailable.png"), fullPage: true });
  steps.push("native transcript-only confirmation and unmatched question are non-actionable; no peer chat sent");

  for (const decision of ["allow-once", "deny"]) {
    const open = await host.nativeApproval.open("Bash", { command: "synthetic-native-tool --never-executed", description: "仅验证原生审批响应" });
    const dialog = page.getByRole("dialog", { name: "Claude 等待授权", exact: true });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "暂时关闭", exact: true }).click();
    const dock = await page.locator(".permission-dock-slot").boundingBox();
    const stream = await page.locator(".conversation-stream").boundingBox();
    const composer = await page.locator(".mobile-composer").boundingBox();
    assert.ok(stream.height > 0 && dock.y >= stream.y + stream.height - 1 && dock.y + dock.height <= composer.y + 1, "Authorization entry follows the scrollable output and precedes the composer");
    await page.locator(".permission-dock").click();
    await dialog.getByRole("button", { name: decision === "deny" ? "拒绝" : "允许一次", exact: true }).click();
    if (decision === "deny") {
      await dialog.getByRole("textbox", { name: "拒绝原因", exact: true }).fill("改用只读检查");
      await dialog.getByRole("button", { name: "拒绝", exact: true }).click();
    }
    const response = await open.response;
    assert.equal(response.decision, decision === "deny" ? "deny" : "once");
    assert.equal(response.requestId, open.request.requestId);
    await eventually(() => host.nativeApproval.list().length, 0, "Native permission must resolve");
    await eventually(() => host.nativeTrace.some(event => event.type === "resolved" && event.requestId === open.request.requestId), true, "Native resolution has reached the controller callback");
    const trace = host.nativeTrace.find((event) => event.type === "resolved" && event.requestId === open.request.requestId);
    assert.equal(trace.resolvedByDeviceId, host.pairing.deviceId);
    await dialog.waitFor({ state: "hidden" });
  }
  steps.push("allow and deny travel through encrypted permission.resolve and reach the same native requestID with phone attribution");

  const input = { questions: [
    { question: "选择执行范围", multiSelect: false, options: [{ label: "仅本机", description: "使用隔离测试目录" }, { label: "稍后处理" }] },
    { question: "选择检查项目", multiSelect: true, options: [{ label: "稍后处理" }, { label: "类型检查" }, { label: "回归测试" }] },
    { question: "选择归档位置", multiSelect: true, options: [{ label: "本机归档" }, { label: "团队云盘" }] },
  ] };
  const archiveAnswer = "已归档到共享目录, 本机归档";
  await openMobileDrawer(page);
  const question = await host.nativeApproval.open("AskUserQuestion", input);
  for (const event of await host.nativeApproval.message({ type: "assistant", uuid: "native-question-card", timestamp: Date.now(), message: { content: [
    { type: "tool_use", id: question.request.toolUseId, name: "AskUserQuestion", input },
  ] } })) await host.emit(event.type, event.data, { itemId: event.itemId });
  host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
  const sessionRow = page.locator(`.mobile-home-catalog [data-session-id="${sessionId}"]`);
  await sessionRow.getByText("待回答", { exact: true }).waitFor();
  await page.locator(".mobile-home-catalog").getByText("有提问待你回答", { exact: true }).waitFor();
  await sessionRow.locator(".session-row-hit").click();
  const questionCard = page.locator(".conversation-stream .pending-question");
  await questionCard.waitFor();
  assert.equal(await page.getByRole("dialog", { name: "Claude 等待授权", exact: true }).count(), 0, "Questions are answered inline without another approval sheet");
  await host.emit("assistant.delta", { text: "提问后到达的最新总结内容" }, { itemId: "question-later-summary" });
  await host.emit("assistant.completed", { text: "提问后到达的最新总结内容" }, { itemId: "question-later-summary" });
  const latestOutput = page.locator(".conversation-item").filter({ hasText: "提问后到达的最新总结内容" });
  await latestOutput.waitFor();
  assert.equal(await latestOutput.evaluate(output => Boolean(output.compareDocumentPosition(document.querySelector(".pending-question")) & Node.DOCUMENT_POSITION_FOLLOWING)), true, "The live question stays after subsequent assistant output");
  const snapshotCount = host.requests.filter((request) => request.method === "snapshot.get").length;
  const routeCount = relayRoutes.length;
  assert.ok(routeCount > 0, "Native approval scenario must own a phone connection");
  // The startup probe also opens /ws. Close the page side of every existing relay route
  // so the phone stops sending before Playwright closes its native socket.
  await Promise.all(relayRoutes.map(route => route.close({ code: 1000, reason: "native approval reconnect fixture" })));
  await eventually(() => host.requests.filter((request) => request.method === "snapshot.get").length > snapshotCount, true, "Reconnect must fetch pending native approval");
  assert.ok(relayRoutes.length > routeCount, "Reconnect must open a new relay connection");
  assert.equal(host.nativeApproval.list()[0].requestId, question.request.requestId);
  const submit = questionCard.getByRole("button", { name: "提交回答", exact: true });
  assert.equal(await questionCard.getByRole("textbox").count(), 0, "Preset questions start with Other collapsed");
  assert.equal(await questionCard.getByText("任一已授权设备的首次回答生效", { exact: true }).count(), 0);
  await questionCard.getByRole("radio", { name: "其他", exact: true }).check();
  const singleText = questionCard.getByRole("textbox", { name: "选择执行范围：其他回答", exact: true });
  await singleText.fill("隔离目录");
  await questionCard.getByRole("radio", { name: /仅本机/u }).check();
  assert.equal(await singleText.count(), 0, "Selecting a preset closes single-choice Other");
  await questionCard.getByRole("checkbox", { name: "类型检查", exact: true }).check();
  await questionCard.getByRole("checkbox", { name: "回归测试", exact: true }).check();
  await page.screenshot({ path: resolve(directory, "native-question.png"), fullPage: true });
  await questionCard.getByRole("group", { name: "选择归档位置", exact: true }).getByRole("checkbox", { name: "其他", exact: true }).check();
  await questionCard.getByRole("textbox", { name: "选择归档位置：其他回答", exact: true }).fill(archiveAnswer);
  const checks = questionCard.getByRole("group", { name: "选择检查项目", exact: true });
  const multiOther = checks.getByRole("checkbox", { name: "其他", exact: true });
  await multiOther.check();
  assert.equal(await submit.isDisabled(), true, "Selected Other needs text even with other checks selected");
  const otherAnswer = "浏览器检查, 稍后处理";
  const multiText = checks.getByRole("textbox", { name: "选择检查项目：其他回答", exact: true });
  await multiText.fill(otherAnswer);
  assert.equal(await submit.isEnabled(), true);
  await page.screenshot({ path: resolve(directory, "native-question-other.png"), fullPage: true });
  await multiOther.uncheck();
  assert.equal(await multiText.count(), 0, "Unchecking Other closes the input");
  await multiOther.check();
  await multiText.fill(otherAnswer);
  await submit.click();
  const questionReply = await question.response;
  assert.equal(questionReply.decision, "once");
  assert.equal(questionReply.requestId, question.request.requestId);
  assert.deepEqual(questionReply.response, {
    ...input,
    answers: { "选择执行范围": "仅本机", "选择检查项目": "类型检查, 回归测试", "选择归档位置": archiveAnswer },
    annotations: { "选择检查项目": { notes: otherAnswer } },
  });
  await questionCard.waitFor({ state: "hidden" });
  const notes = "只处理本机目录, 保留共享副本";
  for (const event of await host.nativeApproval.message({ type: "user", uuid: "native-question-result", timestamp: Date.now(),
    toolUseResult: { ...questionReply.response, annotations: { ...questionReply.response.annotations, "选择执行范围": { notes } } }, message: { content: [
      { type: "tool_result", tool_use_id: question.request.toolUseId, content: "User has answered your questions." },
    ] },
  })) await host.emit(event.type, event.data, { itemId: event.itemId });
  const answeredQuestion = page.locator(".interactive-prompt-card").filter({ hasText: "选择检查项目" });
  await answeredQuestion.getByText(archiveAnswer, { exact: true }).waitFor();
  await answeredQuestion.getByText(otherAnswer, { exact: true }).waitFor();
  await answeredQuestion.getByText(notes, { exact: true }).waitFor();
  await eventually(() => answeredQuestion.locator(".interactive-option-button.is-selected").count(), 3, "Every preset selection is visible and the free-text answer selects none");
  assert.equal(await answeredQuestion.locator(".is-primary").count(), 0, "An answered question has no default first-option highlight");
  assert.equal(await answeredQuestion.locator(".interactive-question-block").filter({ hasText: "选择检查项目" }).getByRole("button", { name: "稍后处理", exact: true }).getAttribute("class").then(value => value.includes("is-selected")), false);
  await page.screenshot({ path: resolve(directory, "native-question-answered.png"), fullPage: true });
  host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
  await openMobileDrawer(page);
  await sessionRow.getByText("待回答", { exact: true }).waitFor({ state: "hidden" });
  await sessionRow.locator(".session-row-hit").click();
  await eventually(() => answeredQuestion.locator(".interactive-option-button.is-selected").count(), 3, "Reopened native history retains every selection");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openMobileSession(page);
  await answeredQuestion.getByText(archiveAnswer, { exact: true }).waitFor();
  await answeredQuestion.getByText(otherAnswer, { exact: true }).waitFor();
  await answeredQuestion.getByText(notes, { exact: true }).waitFor();
  await eventually(() => answeredQuestion.locator(".interactive-option-button.is-selected").count(), 3, "Reloaded native history retains every selection without selecting a free-text fragment");
  const resolutions = host.requests.filter((request) => request.method === "permission.resolve");
  assert.equal(resolutions.length, 3);
  assert.equal(new Set(resolutions.map((request) => request.params.requestId)).size, 3);
  assert.equal(resolutions.filter((request) => request.params.requestId === question.request.requestId).length, 1);
  assert.equal(host.requests.filter((request) => request.method === "turn.start").length, 0);
  steps.push("live native questions survive reconnect; single-choice and multi-select answers reach the same native requestID exactly once without chat");
  await page.getByRole("button", { name: "会话设置", exact: true }).click();
  const effortConfiguration = page.getByRole("dialog", { name: originalTitle, exact: true });
  const highEffort = effortConfiguration.getByRole("button", { name: "高", exact: true });
  const defaultEffort = effortConfiguration.getByRole("button", { name: "默认", exact: true });
  assert.equal(await effortConfiguration.getByRole("button", { name: "低", exact: true }).getAttribute("aria-pressed"), "false", "A session with no effort must not show Low as selected");
  assert.equal(await defaultEffort.getAttribute("aria-pressed"), "true", "A session with no effort shows Default as selected");
  await highEffort.click();
  await effortConfiguration.getByRole("button", { name: "保存配置", exact: true }).click();
  await effortConfiguration.waitFor({ state: "hidden" });
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "setEffort").map(call => call.args), [[sessionId, "high"]]);
  await page.getByRole("button", { name: "会话设置", exact: true }).click();
  await eventually(() => highEffort.getAttribute("aria-pressed"), "true", "Reopening settings reads back the Native effort");
  await defaultEffort.click();
  await effortConfiguration.getByRole("button", { name: "保存配置", exact: true }).click();
  await effortConfiguration.waitFor({ state: "hidden" });
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "setEffort").map(call => call.args), [[sessionId, "high"], [sessionId, null]]);
  await page.getByRole("button", { name: "会话设置", exact: true }).click();
  await eventually(() => defaultEffort.getAttribute("aria-pressed"), "true", "Reopening settings reads back the cleared Native effort");
  await effortConfiguration.getByRole("button", { name: "关闭", exact: true }).click();
  steps.push("unset effort shows Default, saving High calls native setEffort, and choosing Default clears it; both survive reopening");
  for (const mode of ["bypassPermissions", "auto"]) {
    await page.getByRole("button", { name: "会话设置", exact: true }).click();
    const configuration = page.getByRole("dialog", { name: originalTitle, exact: true });
    await selectCustomOption(page, configuration.getByLabel("权限模式", { exact: true }), mode);
    await configuration.getByRole("button", { name: "保存配置", exact: true }).click();
    if (mode === "bypassPermissions") {
      await page.getByRole("alertdialog", { name: "启用完全授权", exact: true }).getByRole("button", { name: "启用完全授权", exact: true }).click();
    }
    await configuration.waitFor({ state: "hidden" });
    assert.equal(host.nativeApproval.permissionMode(), mode);
    assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "setPermissionMode").at(-1).args, [sessionId, mode]);
    assert.equal(await page.getByRole("status", { name: "Desktop 会话授权变更", exact: true }).count(), 0, "Confirmed permission changes leave no persistent banner");
    await eventually(async () => (await page.locator(".m-header .session-profile-summary").innerText()).includes(mode === "auto" ? "自动模式" : "完全授权"), true, "The updated Native snapshot reaches the header");
    await page.getByRole("button", { name: "会话设置", exact: true }).click();
    await eventually(() => customSelectValue(configuration.getByLabel("权限模式", { exact: true })), mode, "Configuration reflects the native Desktop mode");
    await page.screenshot({ path: resolve(directory, `native-mode-${mode}.png`), fullPage: true });
    await configuration.getByRole("button", { name: "关闭", exact: true }).click();
    assert.equal(host.snapshot.host.defaultPermissionMode, undefined);
  }
  assert.equal(host.requests.filter((request) => request.method === "permission.policy.configure" || request.method === "turn.start").length, 0);
  assert.equal(host.requests.filter((request) => request.method === "permission.resolve" && request.params.nativeMode !== undefined).length, 0);
  steps.push("native session permission modes relay through session.configure and setPermissionMode without applying a Bridge host policy");
  const planApproval = await host.nativeApproval.open("ExitPlanMode", { plan: "# 迁移计划\n\n1. 保留原生通道\n2. 核对文件进度" });
  const planDialog = page.getByRole("dialog", { name: "Claude 等待授权", exact: true });
  await planDialog.getByRole("heading", { name: "迁移计划" }).waitFor();
  await page.screenshot({ path: resolve(directory, "native-exit-plan.png"), fullPage: true });
  await planDialog.getByRole("button", { name: "是，自动接受编辑", exact: true }).click();
  const planResponse = await planApproval.response;
  assert.equal(planResponse.decision, "once");
  assert.equal(host.nativeApproval.permissionMode(), "acceptEdits");
  const nativeCalls = host.nativeApproval.calls;
  const modeIndex = nativeCalls.findLastIndex(call => call.method === "setPermissionMode");
  const responseIndex = nativeCalls.findLastIndex(call => call.method === "respondToToolPermission");
  assert.ok(modeIndex < responseIndex, "Native mode changes before approving the plan");
  await planDialog.waitFor({ state: "hidden" });
  steps.push("ExitPlanMode renders the plan and configures native acceptEdits before responding to the same request");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Native approval must fit the phone viewport");
  await verifySessionHeader(page, host, steps, directory, baseUrl);
}

export async function verifyNativePromptsPr(page, host, steps, directory, baseUrl) {
  async function rejectPendingPrWrite(surface, sheet, control) {
    await host.nativeApproval.setPromptsPrPolicy({ applyPrWrites: false });
    const audits = host.nativeApproval.dialogs().events.filter(event => event.type === "pr.autoFix.updated").length;
    let release;
    host.prWriteGate = new Promise(resolve => { release = resolve; });
    try {
      await control.click();
      const close = sheet.getByRole("button", { name: "关闭", exact: true });
      await eventually(() => close.isDisabled(), true, "A pending PR write disables sheet dismissal");
      await sheet.press("Escape");
      assert.equal(await sheet.isVisible(), true, "Escape cannot discard a pending PR write result");
      await surface.locator(".m-sheet-backdrop").click({ position: { x: 1, y: 1 } });
      assert.equal(await sheet.isVisible(), true, "Backdrop cannot discard a pending PR write result");
      await close.evaluate(button => button.click());
      assert.equal(await sheet.isVisible(), true, "Close control cannot discard a pending PR write result");
    } finally {
      release();
      host.prWriteGate = undefined;
    }
    await sheet.getByRole("alert").waitFor();
    await eventually(() => sheet.getByRole("button", { name: "关闭", exact: true }).isEnabled(), true, "A rejected PR write leaves its error visible and unlocks dismissal");
    assert.equal(host.nativeApproval.dialogs().events.filter(event => event.type === "pr.autoFix.updated").length, audits);
    await host.nativeApproval.setPromptsPrPolicy({ applyPrWrites: true });
  }

  await openMobileSession(page);
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const kinds = ["refusal-fallback", "auto-mode-server-fallback", "lanyard-consent", "violin-bow", "cwd-trust"];
  // Freeze the entrance at a frame where the dialog overlaps the pending dock.
  const freezeEntrance = await page.addStyleTag({ content: `
    .m-sheet-backdrop, .m-sheet { animation-delay: -80ms; animation-play-state: paused; }
  ` });
  const opened = [];
  for (const kind of kinds) {
    const update = await host.syncNativeDialogs(await host.nativeApproval.openPrompt(kind));
    opened.push(update.prompt);
  }
  await eventually(() => page.locator(".native-prompt").count(), 1, "The phone sheet renders the first pending Native application prompt");
  await page.locator(".permission-dock").getByText("5 项", { exact: true }).waitFor();
  assert.equal(host.snapshot.permissions.length, 0);
  const listed = await host.nativeApproval.controllerRequest({ kind: "request", requestId: randomUUID(), idempotencyKey: randomUUID(), method: "prompt.list", params: { sessionId } });
  assert.deepEqual(listed.prompts.map(prompt => prompt.kind).sort(), [...kinds].sort());
  const promptSheet = page.getByRole("dialog", { name: "Claude 等待确认", exact: true });
  const layout = await promptSheet.evaluate(sheet => {
    const selector = sheet.querySelector('[role="combobox"]').getBoundingClientRect();
    const description = sheet.querySelector(".native-prompt p").getBoundingClientRect();
    const actions = sheet.querySelector(".native-prompt .permission-actions").getBoundingClientRect();
    const dock = document.querySelector(".permission-dock").getBoundingClientRect();
    const panel = sheet.getBoundingClientRect();
    const pixel = document.createElement("canvas").getContext("2d");
    pixel.fillStyle = getComputedStyle(sheet).backgroundColor;
    pixel.fillRect(0, 0, 1, 1);
    return {
      backdropOpacity: Number(getComputedStyle(sheet.parentElement).opacity),
      panelOpacity: Number(getComputedStyle(sheet).opacity),
      fillOpacity: pixel.getImageData(0, 0, 1, 1).data[3] / 255,
      coversDock: panel.top <= dock.top && panel.bottom >= dock.bottom,
      descriptionBetweenControls: selector.bottom <= description.top && description.bottom <= actions.top,
    };
  });
  assert.equal(layout.coversDock, true, "The entering Native prompt sheet overlaps the pending dock");
  assert.deepEqual([layout.backdropOpacity, layout.panelOpacity, layout.fillOpacity], [1, 1, 1], "The sheet must hide the pending dock even during its entrance");
  assert.equal(layout.descriptionBetweenControls, true, "Native prompt details sit between the selector and response buttons");
  await freezeEntrance.evaluate(style => style.remove());
  await page.screenshot({ path: resolve(directory, "native-prompts.png"), fullPage: true, animations: "disabled" });
  steps.push("the Native prompt sheet is opaque during entrance and keeps the description between the selector and actions");
  const selected = ["edit_prompt", "interrupt", "consent_workspace", "cancel_native_operation", "trust"];
  const methods = ["respondToRefusalFallbackPrompt", "respondToAutoModeServerFallbackPrompt", "respondToLanyardConsent", "respondToViolinBowPrompt", "answerPendingCwdTrust"];
  for (const [index, prompt] of opened.entries()) {
    const choice = prompt.choices.find(choice => choice.value === selected[index]);
    assert.ok(choice, "The synthetic Native broker must publish its actual choice value");
    const card = page.getByRole("region", { name: prompt.title, exact: true });
    if (prompt.kind === "lanyard-consent") {
      const disclosure = await card.innerText();
      for (const value of ["此连接会替换原有频道连接。", "原频道：隔离旧频道", "原线程开始于 2026-11-12", "https://example.invalid/owned-old-channel"]) assert.ok(disclosure.includes(value), "Native replacement authorization must be visible before responding");
    }
    await card.getByRole("button", { name: choice.label, exact: true }).click();
    await card.waitFor({ state: "hidden" });
    await eventually(() => host.nativeApproval.dialogs().events.some(event => event.type === "prompt.resolved" && event.data.promptId === prompt.promptId && event.data.resolvedByDeviceId === host.pairing.deviceId), true, "Remote Native prompt resolution records its phone device");
    const audit = host.nativeApproval.dialogs().events.findLast(event => event.type === "prompt.resolved" && event.data.promptId === prompt.promptId && event.data.resolvedByDeviceId);
    assert.equal(audit.data.choice, selected[index]);
    assert.equal(audit.data.resolvedByName, "隔离手机");
    assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === methods[index]).at(-1).args, [sessionId, prompt.promptId, prompt.kind === "cwd-trust" ? true : selected[index]]);
  }
  assert.equal(host.requests.filter(request => request.method === "prompt.resolve").length, 5);
  assert.equal(host.requests.filter(request => request.method === "permission.resolve" || request.method === "turn.start").length, 0);
  steps.push("five Native prompts use independent encrypted prompt.resolve calls with their actual string choices, cwd boolean translation, and phone attribution");

  const responsesBeforeLocal = host.nativeApproval.calls.filter(call => methods.includes(call.method)).length;
  for (const kind of kinds) {
    const update = await host.syncNativeDialogs(await host.nativeApproval.openPrompt(kind));
    const card = page.getByRole("region", { name: update.prompt.title, exact: true });
    await card.waitFor();
    await host.syncNativeDialogs(await host.nativeApproval.answerPromptLocally(update.prompt.promptId));
    await card.waitFor({ state: "hidden" });
    assert.equal(host.nativeApproval.dialogs().events.some(event => event.type === "prompt.resolved" && event.data.promptId === update.prompt.promptId && event.data.automatic === true), true);
  }
  assert.equal(host.nativeApproval.calls.filter(call => methods.includes(call.method)).length, responsesBeforeLocal);
  const rawDialogs = host.nativeApproval.dialogs().nativeEvents.filter(event => /^(refusal_fallback_prompt|auto_mode_server_fallback_prompt|lanyard_consent|violin_bow_prompt)(?:_resolved)?$/u.test(event.type));
  assert.equal(rawDialogs.length, 16);
  assert.equal(rawDialogs.every(event => !Object.hasOwn(event, "session")), true, "Native opened/resolved dialog events intentionally carry no event.session");
  await host.nativeApproval.setPromptsPrPolicy({ choicesAvailable: false });
  const unavailable = await host.syncNativeDialogs(await host.nativeApproval.openPrompt("lanyard-consent"));
  const unavailableCard = page.getByRole("region", { name: unavailable.prompt.title, exact: true });
  await unavailableCard.getByText("请在电脑端处理", { exact: true }).waitFor();
  assert.equal(await unavailableCard.getByRole("button").count(), 0);
  const reachable = await host.syncNativeDialogs(await host.nativeApproval.openPrompt("cwd-trust"));
  await selectCustomOption(page, page.getByRole("combobox", { name: "待处理提示", exact: true }), reachable.prompt.promptId);
  const reachableCard = page.getByRole("region", { name: reachable.prompt.title, exact: true });
  await reachableCard.getByRole("button", { name: "信任目录", exact: true }).click();
  await reachableCard.waitFor({ state: "hidden" });
  await unavailableCard.waitFor();
  await host.syncNativeDialogs(await host.nativeApproval.answerPromptLocally(unavailable.prompt.promptId));
  await host.nativeApproval.setPromptsPrPolicy({ choicesAvailable: true });
  steps.push("a read-only first prompt remains visible while the selector reaches and answers a later Native prompt");
  steps.push("Native opened/resolved events without event.session refresh all five pending lists; Desktop-local answers clear phone cards without a remote response, and unavailable Native choices stay non-actionable");

  assert.equal(host.nativeApproval.calls.filter(call => ["getPrOverview", "getPrChecks"].includes(call.method)).length, 0, "Snapshot refresh never fetches GitHub PR checks");
  assert.equal(host.requests.filter(request => request.method === "pr.autoFix.read").length, 0, "Collapsed PR controls do not query PR state");
  const bar = page.locator(".session-pr-bar");
  assert.equal(await bar.count(), 0, "A capable host does not add a PR header to a session without PRs");
  await page.screenshot({ path: resolve(directory, "native-no-pr-conversation.png"), fullPage: true });
  const menuTrigger = page.getByRole("button", { name: "会话操作", exact: true });
  await menuTrigger.press("Enter");
  const menu = page.getByRole("dialog", { name: originalTitle, exact: true });
  const menuOwn = menu.getByRole("checkbox", { name: "仅我的 PR", exact: true });
  const next = menu.getByRole("button", { name: "跟踪下一个 PR", exact: true });
  await eventually(() => menuOwn.isEnabled(), true, "Opening session actions reads Native PR preferences");
  await menu.getByText("PR Auto-fix", { exact: true }).waitFor();
  assert.equal(await menu.evaluate(element => document.activeElement === element), true, "Mobile actions focus the sheet after keyboard opening");
  await page.keyboard.press("Tab");
  assert.equal(await menu.getByRole("button", { name: "关闭", exact: true }).evaluate(button => document.activeElement === button), true);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await menu.locator("button:not(:disabled), input:not(:disabled)").last().evaluate(control => document.activeElement === control), true, "Shift+Tab wraps within mobile actions");
  await page.keyboard.press("Tab");
  assert.equal(await menu.getByRole("button", { name: "关闭", exact: true }).evaluate(button => document.activeElement === button), true, "Tab wraps within mobile actions");
  assert.equal(await menu.getByRole("button", { name: "刷新 PR 状态", exact: true }).count(), 0, "Loaded preferences omit the redundant refresh action");
  const preferenceAlignment = await menu.evaluate(element => {
    const action = element.querySelector(".m-sheet-action-copy strong");
    const heading = element.querySelector(".session-pr-actions-heading strong");
    const label = element.querySelector(".session-pr-preferences label span");
    return { actionLeft: action.getBoundingClientRect().left, headingLeft: heading.getBoundingClientRect().left,
      labelLeft: label.getBoundingClientRect().left, actionFont: getComputedStyle(action).fontSize, labelFont: getComputedStyle(label).fontSize };
  });
  assert.ok(Math.abs(preferenceAlignment.headingLeft - preferenceAlignment.actionLeft) <= 1, "PR heading aligns with session action labels");
  assert.ok(Math.abs(preferenceAlignment.labelLeft - preferenceAlignment.actionLeft) <= 1, "PR preference labels align with session action labels");
  assert.equal(preferenceAlignment.labelFont, preferenceAlignment.actionFont, "PR preferences use the session action body size");
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "getPrChecks").length, 0);
  await rejectPendingPrWrite(page, menu, next);
  assert.equal(await menuOwn.isChecked(), false, "Rejected next-PR write retains the read Native preferences");
  await menuOwn.click();
  await eventually(() => menuOwn.isChecked(), true, "Only-own-PR preference reflects Native readback without a bound PR");
  await eventually(() => next.isEnabled(), true, "PR preference update completes before the next action");
  await next.click();
  await eventually(() => menu.getByRole("button", { name: "正在跟踪下一个 PR", exact: true }).isDisabled(), true, "Next-PR branch latch reflects Native readback without offering an unsupported cancel action");
  assert.deepEqual(host.nativeApproval.dialogs().prefs, { onlyOwnPrs: true, nextOwnPrArmed: true });
  assert.deepEqual(host.nativeApproval.calls.findLast(call => call.method === "armAutoFixOnNextPr").args, [sessionId, "feature/owned"]);
  await page.screenshot({ path: resolve(directory, "native-no-pr-preferences.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No-PR preferences fit the phone viewport");
  await eventually(() => menu.getByRole("button", { name: "关闭", exact: true }).isEnabled(), true, "Next-PR write finishes before keyboard dismissal");
  await menu.getByRole("button", { name: "关闭", exact: true }).press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await menuTrigger.evaluate(button => document.activeElement === button), true, "Mobile actions restore keyboard focus");

  const desktop = await page.context().newPage();
  const desktopErrors = [];
  desktop.on("pageerror", error => desktopErrors.push(error.message));
  await desktop.exposeFunction("prSnapshot", () => ({ ...host.snapshot, connection: "connected", launchAtLogin: false,
    diagnosticsEnabled: false, managedDesktopEnabled: false,
    claudeDesktop: { state: "running", detail: "隔离 Native 宿主", canLaunch: false, canQuit: true } }));
  await desktop.exposeFunction("prRequest", async input => {
    if (input.method === "pr.autoFix.set" && host.prWriteGate) await host.prWriteGate;
    const request = desktopFixtureRequest(input);
    const update = await host.nativeApproval.request(request);
    await host.syncNativeDialogs(update);
    return { kind: "response", requestId: request.requestId, ok: true, result: update.result };
  });
  await desktop.addInitScript(() => {
    window.bridgeDesktop = { getSnapshot: () => window.prSnapshot(), request: input => window.prRequest(input),
      onSnapshot: () => () => {}, onEvent: () => () => {} };
  });
  await desktop.setViewportSize({ width: 1200, height: 800 });
  await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await desktop.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
  await desktop.locator(".desktop-conversation .m-header").getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  assert.equal(await desktop.locator(".session-pr-bar").count(), 0, "Desktop also omits the no-PR header");
  const desktopMenuTrigger = desktop.locator(".desktop-conversation").getByRole("button", { name: "会话操作", exact: true });
  await desktopMenuTrigger.click();
  const desktopMenu = desktop.getByRole("dialog", { name: originalTitle, exact: true });
  const desktopOwn = desktopMenu.getByRole("checkbox", { name: "仅我的 PR", exact: true });
  await eventually(() => desktopOwn.isEnabled(), true, "Desktop actions read Native preferences");
  assert.equal(await desktopMenu.getByText("PR Auto-fix", { exact: true }).count(), 1, "Desktop labels the feature once in the session actions sheet");
  assert.equal(await desktopMenu.getByRole("button", { name: "刷新 PR 状态", exact: true }).count(), 0);
  assert.equal(await desktopOwn.isChecked(), true, "Desktop sees the preference saved by the phone");
  assert.equal(await desktopMenu.getByRole("button", { name: "正在跟踪下一个 PR", exact: true }).isDisabled(), true);
  await rejectPendingPrWrite(desktop, desktopMenu, desktopOwn);
  assert.equal(await desktopOwn.isChecked(), true, "Desktop retains Native state after the delayed rejection");
  await desktopOwn.click();
  await eventually(() => desktopOwn.isChecked(), false, "Desktop writes use Native readback");
  await eventually(() => desktopOwn.isEnabled(), true, "Desktop write finishes before restoring the preference");
  await desktopOwn.click();
  await eventually(() => desktopOwn.isChecked(), true, "Desktop restores the shared preference");
  await eventually(() => desktopOwn.isEnabled(), true, "Desktop preference readback finishes before closing the sheet");
  await desktop.screenshot({ path: resolve(directory, "desktop-no-pr-preferences.png"), fullPage: true });
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await desktopMenu.getByRole("button", { name: "关闭", exact: true }).press("Escape");
  await desktopMenu.waitFor({ state: "hidden" });
  assert.equal(await desktopMenuTrigger.evaluate(button => button === document.activeElement), true, "Desktop action sheet restores keyboard focus");
  assert.deepEqual(desktopErrors, []);
  await desktop.close();
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "getPrChecks").length, 0, "No-PR actions on either surface never request checks");
  steps.push("no-PR mobile and desktop conversations omit the header; session actions read and write shared Native preferences, including pre-arming the next PR");

  await host.syncNativeDialogs(await host.nativeApproval.seedPullRequest());
  await bar.locator(":scope > summary").getByText("PR · 1", { exact: true }).waitFor();
  await bar.locator(":scope > summary").click();
  const own = bar.getByRole("checkbox", { name: "仅我的 PR", exact: true });
  await eventually(() => own.isEnabled(), true, "Bound PR disclosure reads Native state only after expansion");
  const entry = bar.locator(".session-pr-entry");
  await eventually(() => own.isEnabled(), true, "Next-PR dispatch is acknowledged before opening checks");
  await entry.locator(":scope > summary").click();
  await entry.getByRole("link", { name: "native-ci-failure", exact: true }).waitFor();
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "getPrChecks").map(call => call.args), [[host.nativeApproval.harnessCwd, 42, "fixture/native", "github.com"]]);
  const bound = entry.getByRole("checkbox", { name: "fixture/native#42 Auto-fix", exact: true });
  await eventually(() => bound.isEnabled(), true, "Bound PR becomes actionable after its on-demand read");
  await bound.click();
  await eventually(() => bound.isChecked(), true, "Bound PR Auto-fix reflects Native readback");
  assert.deepEqual(host.nativeApproval.calls.findLast(call => call.method === "setBoundPrAutoFix").args, [sessionId, "fixture/native", 42, true, "github.com"]);
  for (const target of ["own-prs", "next-pr", "bound"]) {
    const audit = host.nativeApproval.dialogs().events.findLast(event => event.type === "pr.autoFix.updated" && event.data.target === target && event.data.resolvedByDeviceId);
    assert.equal(audit.data.resolvedByDeviceId, host.pairing.deviceId);
    assert.equal(audit.data.resolvedByName, "隔离手机");
  }
  await eventually(() => bar.getByRole("button", { name: "刷新 PR 状态", exact: true }).isEnabled(), true, "PR write finishes before manual refresh");
  const reads = host.requests.filter(request => request.method === "pr.autoFix.read").length;
  await bar.getByRole("button", { name: "刷新 PR 状态", exact: true }).click();
  await eventually(() => host.requests.filter(request => request.method === "pr.autoFix.read").length, reads + 1, "Explicit PR state refresh reaches the Native controller");
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "getPrChecks").length, 1, "Refreshing preferences does not poll PR checks");
  const refreshChecks = entry.getByRole("button", { name: "刷新检查", exact: true });
  await eventually(() => refreshChecks.isEnabled(), true, "PR state refresh finishes before refreshing checks");
  await refreshChecks.click();
  await eventually(() => host.nativeApproval.calls.filter(call => call.method === "getPrChecks").length, 2, "Only explicit check refresh fetches the checks again");
  await page.screenshot({ path: resolve(directory, "native-pr-autofix.png"), fullPage: true });
  steps.push("PR preferences, next-PR dispatch, and bound Auto-fix use Native readback and phone audit; failed checks load only on entry expansion or explicit check refresh with the public four/five-argument APIs");

  await host.nativeApproval.setPromptsPrPolicy({ applyPrWrites: false });
  const audits = host.nativeApproval.dialogs().events.filter(event => event.type === "pr.autoFix.updated").length;
  for (const checkbox of [bound, own]) {
    await eventually(() => checkbox.isEnabled(), true, "Native action is available before testing an unapplied write");
    await checkbox.click();
    await bar.getByRole("alert").filter({ hasText: "Desktop 未应用 Auto-fix 设置，请刷新状态。" }).waitFor();
    assert.equal(await checkbox.isChecked(), true, "An unapplied Native write never appears successful");
  }
  assert.deepEqual(host.nativeApproval.dialogs().prefs, { onlyOwnPrs: true, nextOwnPrArmed: true });
  assert.equal(host.nativeApproval.dialogs().prs[0].autoFix, true);
  assert.equal(host.nativeApproval.dialogs().events.filter(event => event.type === "pr.autoFix.updated").length, audits, "Failed Native writes do not record a successful device audit");
  assert.equal(host.requests.filter(request => request.method === "pr.autoFix.set").length, 6);
  await page.screenshot({ path: resolve(directory, "native-pr-not-applied.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Native prompts and PR controls fit the mobile viewport");
  steps.push("ignored bound and own-PR Native writes return an error, retain Native state, and create no successful audit event; an armed next-PR latch offers no unsupported cancel action");
}
