import assert from "node:assert/strict";
import { sessionId, originalTitle, renamedTitle, userText, recoveredText, replyText } from "../config.mjs";
import { eventually, openMobileDrawer } from "../helpers.mjs";

async function openRename(page, entry) {
  if (entry === "list") {
    await openMobileDrawer(page);
    await page.locator(`.mobile-home-catalog [data-session-id="${sessionId}"]`).getByRole("button", { name: "会话操作", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "会话操作", exact: true }).click();
  }
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重命名会话", exact: true });
  await dialog.waitFor();
  return dialog;
}

export async function verifyRename(page, host, entry, steps) {
  await openMobileDrawer(page);
  const row = page.locator(`.mobile-home-catalog [data-session-id="${sessionId}"]`);
  const beforeTime = await row.locator("small").innerText();
  const beforeStateDot = await row.locator(".session-state-dot").getAttribute("class");
  const beforeOrder = await page.locator(".mobile-home-catalog [data-session-id]").evaluateAll((rows) => rows.map((item) => item.dataset.sessionId));
  const beforeSession = structuredClone(host.session);
  if (entry === "chat") {
    await row.locator(".session-row-hit").click();
    await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
    await page.getByRole("status", { name: "消息排队状态" }).waitFor();
  }
  let dialog = await openRename(page, entry);
  const input = dialog.getByRole("textbox", { name: "会话名称", exact: true });
  const save = dialog.getByRole("button", { name: "保存", exact: true });
  assert.equal(await input.inputValue(), originalTitle, "Rename must prefill the current title");
  assert.equal(await save.isDisabled(), true, "Unchanged title must disable Save");
  await input.fill("   ");
  assert.equal(await save.isDisabled(), true, "Whitespace title must disable Save");
  await input.fill(`  ${originalTitle}  `);
  assert.equal(await save.isDisabled(), true, "Trimmed unchanged title must disable Save");
  await input.fill("取消的名称");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(host.requests.filter((request) => request.method === "session.rename").length, 0, "Cancel must not send an RPC");
  assert.equal(host.session.title, originalTitle);
  steps.push("prefill, blank/unchanged disabled, cancellation without RPC");

  dialog = await openRename(page, entry);
  assert.equal(await dialog.getByRole("textbox", { name: "会话名称", exact: true }).inputValue(), originalTitle);
  await dialog.getByRole("textbox", { name: "会话名称", exact: true }).fill(`  ${renamedTitle}  `);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.getByRole("alert").getByText("隔离宿主首次重命名失败，请重试", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("textbox", { name: "会话名称", exact: true }).inputValue(), `  ${renamedTitle}  `, "Failed RPC must preserve the input");
  await eventually(() => dialog.getByRole("button", { name: "保存", exact: true }).isEnabled(), true, "Failed RPC must allow retry");
  assert.equal(host.session.title, originalTitle, "Failed rename must not change the title");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(host.requests.filter((request) => request.method === "session.rename").map((request) => request.params.title), [renamedTitle, renamedTitle]);
  steps.push("failed RPC retains input; retry succeeds with a trimmed title");

  if (entry === "list") {
    await openMobileDrawer(page);
    await eventually(() => row.locator("strong").innerText(), renamedTitle, "List title must update");
    await row.locator(".session-row-hit").click();
  }
  await page.getByRole("heading", { name: renamedTitle, exact: true }).waitFor();
  assert.match(await page.getByRole("status", { name: "消息排队状态" }).innerText(), / · 1 条/u);
  assert.equal(await page.locator(".session-activity.queued").count(), 0);
  await openMobileDrawer(page);
  await eventually(() => row.locator("strong").innerText(), renamedTitle, "Renamed chat must update its list row");
  assert.equal(await row.locator("small").innerText(), beforeTime, "Rename must not change displayed activity time");
  assert.equal(await row.locator(".session-state-dot").getAttribute("class"), beforeStateDot, "Rename must preserve queue state");
  assert.equal(await row.getByLabel(`${beforeSession.pendingCount} 条排队消息`, { exact: true }).innerText(), String(beforeSession.pendingCount), "Rename must preserve the independent pending count");
  assert.deepEqual(await page.locator(".mobile-home-catalog [data-session-id]").evaluateAll((rows) => rows.map((item) => item.dataset.sessionId)), beforeOrder, "Rename must not reorder sessions");
  assert.deepEqual(host.session, { ...beforeSession, title: renamedTitle }, "Host rename changes only the title");
  assert.equal(host.requests.filter((request) => request.method.startsWith("turn.")).length, 0, "Rename must not alter queued turns");
  steps.push("list/header title updates; activity, order, and existing queue unchanged");

  if (entry === "list") {
    const search = page.getByPlaceholder("搜索项目或会话", { exact: true });
    await search.fill("不存在的会话关键词");
    await page.locator(".session-catalog-loading strong", { hasText: "没有匹配的会话" }).waitFor();
    await search.fill("");

    await host.send({
      kind: "snapshot",
      snapshot: {
        ...host.snapshot,
        projects: [],
        sessions: [],
        runtime: { ...host.snapshot.runtime, state: "ready" },
        runtimes: [{ ...host.snapshot.runtimes[0], state: "ready", capabilities: [...host.snapshot.runtimes[0].capabilities, "session.create"], sessionCount: 0 }],
      },
    });
    await page.locator(".session-catalog-loading strong", { hasText: "暂无会话" }).waitFor();
    await page.locator(".session-catalog-loading span", { hasText: "当前电脑上尚未创建会话，可随时开始新的对话。" }).waitFor();
    await page.locator(".session-catalog-loading").getByRole("button", { name: "新建会话", exact: true }).click();
    const newChatCanvas = page.locator(".new-chat-canvas");
    await newChatCanvas.waitFor();
    await newChatCanvas.getByRole("group", { name: "新建会话配置", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await newChatCanvas.getByRole("button", { name: "返回会话列表", exact: true }).click();
    await newChatCanvas.waitFor({ state: "hidden" });

    await host.send({
      kind: "snapshot",
      snapshot: {
        ...host.snapshot,
        projects: [],
        sessions: [],
        runtime: { ...host.snapshot.runtime, state: "unavailable" },
        runtimes: [{ ...host.snapshot.runtimes[0], state: "unavailable", sessionCount: 0 }],
      },
    });
    await page.locator(".session-catalog-loading strong", { hasText: "未检测到 Claude Desktop" }).waitFor();
    await page.locator(".session-catalog-loading span", { hasText: "请在电脑端打开 Claude Desktop。启动后 Bridge 将自动建立连接。" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator(".session-catalog-loading").getByRole("button", { name: "检查连接", exact: true }).click();
    await page.getByRole("heading", { name: "连接与同步", exact: true }).waitFor();
    steps.push("empty catalog distinguishes unmatched search, online empty Desktop with create action, and missing Claude Desktop with connection inspection");
  }
}

export async function verifyDelivery(page, host, steps, relayPeers) {
  await openMobileDrawer(page);
  const row = page.locator(`.mobile-home-catalog [data-session-id="${sessionId}"]`);
  const dialog = await openRename(page, "list");
  await dialog.getByRole("textbox", { name: "会话名称", exact: true }).fill(renamedTitle);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await openMobileDrawer(page);
  await eventually(() => row.locator("strong").innerText(), renamedTitle, "Display name must update before sending");
  await row.locator(".session-row-hit").click();
  await page.getByRole("heading", { name: renamedTitle, exact: true }).waitFor();
  await page.getByRole("textbox", { name: /^给 .+ 发指令$/u }).fill(userText);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const userMessage = page.locator("article.conversation-item.user").filter({ hasText: userText });
  await eventually(() => host.requests.filter((request) => request.method === "turn.start").length, 1, "One click must send one turn.start");
  await userMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  assert.equal(await userMessage.count(), 1, "Queued user message must appear exactly once");
  assert.equal(await page.getByRole("status", { name: "消息排队状态" }).count(), 0);
  assert.equal(await page.locator(".session-activity.queued").count(), 0);
  steps.push("one send produces one RPC and one queued user message");

  // The event is deliberately not pushed. It must arrive through events.resume
  // after the real mobile WebSocket closes and the hook reconnects itself.
  const snapshotCount = host.requests.filter((request) => request.method === "snapshot.get").length;
  const missed = await host.emit("assistant.completed", { text: recoveredText }, {
    turnId: "browser-e2e-recovery", itemId: "browser-e2e-recovered", replayOnly: true,
  });
  const mobilePeers = [...relayPeers].filter(([, hello]) => hello.roomId === host.pairing.roomId && hello.role === "mobile");
  assert.equal(mobilePeers.length, 1, "Exactly one mobile relay connection should be owned by this context");
  mobilePeers[0][0].close(1012, "browser-e2e reconnect");
  await eventually(() => host.requests.filter((request) => request.method === "snapshot.get").length > snapshotCount, true, "Reconnect must fetch a new snapshot");
  await eventually(() => host.resumeBatches.some((batch) => batch.includes(missed.eventId)), true, "Reconnect must resume the missed event");
  await page.getByText(recoveredText, { exact: true }).waitFor();
  await page.getByRole("heading", { name: renamedTitle, exact: true }).waitFor();
  await userMessage.getByRole("status").getByText("已排队", { exact: true }).waitFor();
  assert.equal(await page.getByRole("status", { name: "消息排队状态" }).count(), 0);
  assert.equal(await page.locator(".session-activity.queued").count(), 0);
  assert.equal(await userMessage.count(), 1, "Reconnect must not duplicate the queued user message");
  assert.equal(host.requests.filter((request) => request.method === "turn.start").length, 1, "Reconnect must not resend an acknowledged turn");
  steps.push("real socket reconnect restores snapshot/event, display name, and queue without duplicate send");

  await host.accept();
  await userMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  assert.equal(await userMessage.count(), 1, "Acceptance must reconcile the user message without regressing a confirmed queue state");
  await host.requestApproval();
  await userMessage.getByRole("status").filter({ hasText: /处理中/u }).waitFor();
  const approval = page.getByRole("dialog", { name: "Claude 等待授权", exact: true });
  await approval.waitFor();
  await approval.getByText("隔离审批请求", { exact: true }).waitFor();
  await approval.getByText("fixture-command --no-execution", { exact: true }).waitFor();
  await approval.getByRole("button", { name: "允许一次", exact: true }).click();
  await eventually(() => host.requests.filter((request) => request.method === "permission.resolve").length, 1, "Approval must send one permission.resolve");
  await page.getByRole("button", { name: "允许一次", exact: true }).waitFor({ state: "hidden" });
  assert.equal(host.snapshot.permissions.length, 0);
  steps.push("accepted user message remains unique; approval resolves through the host RPC");

  await host.complete();
  await page.getByText(replyText, { exact: true }).waitFor();
  await userMessage.getByRole("status").getByText("已完成", { exact: true }).waitFor();
  await page.getByRole("status", { name: "消息排队状态" }).waitFor({ state: "hidden" });
  assert.equal(await userMessage.count(), 1, "Completion must keep a single user message");
  const turns = host.requests.filter((request) => request.method === "turn.start");
  assert.equal(turns.length, 1, "The full lifecycle must keep one turn request");
  assert.equal(new Set(turns.map((request) => request.requestId)).size, 1);
  assert.equal(new Set(turns.map((request) => request.idempotencyKey)).size, 1);
  steps.push("completed response clears the queue; request and user message stay unique");
}
