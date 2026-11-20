import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eventually, openMobileDrawer } from "../helpers.mjs";

export async function verifyAssistantReplies(page, host, steps, directory, serverRoutes) {
  const { sessionId } = host.session;
  const configuration = host.nativeApproval.configuration;
  host.nativeApproval.configuration = async request => {
    const result = await configuration(request);
    if (request.method === "session.configuration" && request.params.includeBackgroundTasks === true) {
      // Only the scenario's events, not the separate native task poll, drive the session state.
      return { configuration: result.configuration };
    }
    return result;
  };
  host.nativeApproval.assistantMail.service.setBinding({ assistantId: randomUUID(), nativeSessionId: sessionId, sectionId: null, previousSessionIds: [] });
  host.snapshot.assistantMail = host.nativeApproval.mailSnapshot();
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  const initialUser = { id: "assistant-question", sessionId, role: "user", text: "继续追问", createdAt: Date.now(), origin: "claude-desktop" };
  for (let index = 0; index < 30; index++) {
    host.history.push({ ...initialUser, id: `older-${index}`, text: `助理历史记录 ${index + 1}`, createdAt: initialUser.createdAt - (30 - index) * 1_000 });
  }
  host.history.push(initialUser);
  await openMobileDrawer(page);
  await page.locator(".drawer-assistant-capsule").click();
  const assistant = page.locator(".assistant-conversation");
  const stream = assistant.locator(".conversation-stream");
  await stream.getByText(initialUser.text, { exact: true }).waitFor();

  const reply = { id: "assistant-answer", sessionId, role: "assistant", text: "这是已写入电脑历史的助理回复", createdAt: Date.now(), origin: "claude-desktop" };
  host.history.push(reply);
  await host.emit("assistant.completed", { text: reply.text }, { itemId: reply.id });
  await stream.getByText(reply.text, { exact: true }).waitFor();

  const routeCount = serverRoutes.length;
  const otherSession = host.snapshot.sessions.find(candidate => candidate.sessionId !== sessionId);
  for (let index = 0; index < 2_000; index++) {
    await host.emit("assistant.delta", { text: "片段" }, { itemId: "neighbour-stream", sessionId: otherSession.sessionId, replayOnly: true });
  }
  const followup = { ...initialUser, id: "assistant-followup", text: "再追问一次", createdAt: Date.now() };
  host.history.push(followup);
  const last = await host.emit("user.message.accepted", { text: followup.text }, { itemId: followup.id, replayOnly: true });
  // Close the page's routes before their native sockets, including any relay probe.
  await Promise.all(serverRoutes.map(route => route.close({ code: 1000, reason: "assistant reply catch-up" })));
  await eventually(() => host.resumeBatches.some(batch => batch.includes(last.eventId)), true, "The mobile client replays the background events");
  assert.ok(serverRoutes.length > routeCount, "Replay uses a new relay connection");
  await stream.getByText(followup.text, { exact: true }).waitFor();
  await stream.getByText(reply.text, { exact: true }).waitFor();
  const latestReads = () => host.requests.filter(request => request.method === "session.history" && !request.params.cursor).length;
  assert.equal(latestReads(), 1, "Reconnect reads the latest page once");
  assert.equal(host.requests.filter(request => request.method === "session.open").length, 1, "Recovery does not reopen the session");
  await page.screenshot({ path: resolve(directory, "assistant-reply-recovered.png") });
  const pendingStatus = assistant.getByRole("status").getByText("正在同步最新对话…");
  const retry = assistant.getByRole("button", { name: "重试同步", exact: true });
  const bottomMessage = stream.getByText(followup.text, { exact: true });
  await stream.evaluate(root => {
    root.scrollTop = root.scrollHeight;
    root.dispatchEvent(new Event("scroll"));
  });
  const bottomBefore = (await bottomMessage.boundingBox()).y;
  const unpushed = { ...reply, id: "assistant-unpushed", text: "这条主动回复只写进了电脑历史", createdAt: Date.now() };
  host.history.push(unpushed);
  const gate = Promise.withResolvers();
  host.historyGate = gate.promise;
  host.failHistoryOnce = true;
  host.session.lastCompletedTurnId = "assistant-native-result";
  await host.emit("runtime.updated", { replaceSession: true, session: host.session });
  await pendingStatus.waitFor();
  const overlayAlpha = await pendingStatus.evaluate(notice => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    context.fillStyle = getComputedStyle(notice).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  await page.screenshot({ path: resolve(directory, "assistant-reply-sync-loading.png"), animations: "disabled" });
  assert.equal(overlayAlpha, 255, "The loading notice must not show transcript text through its background");
  const bottomLoading = (await bottomMessage.boundingBox()).y;
  assert.equal(await stream.getByText(reply.text, { exact: true }).count(), 1, "Sync keeps the previous reply visible");
  gate.resolve();
  const alert = assistant.getByRole("alert").filter({ hasText: "最新对话同步失败" });
  await alert.getByText(/隔离历史请求失败/u).waitFor();
  const bottomFailed = (await bottomMessage.boundingBox()).y;
  const noticeInViewport = (await Promise.all([alert.boundingBox(), retry.boundingBox()]))
    .every(box => box && box.y >= 0 && box.y + box.height <= page.viewportSize().height);
  await page.screenshot({ path: resolve(directory, "assistant-reply-sync-error.png"), animations: "disabled" });
  await retry.click();
  await stream.getByText(unpushed.text, { exact: true }).waitFor();
  assert.equal(latestReads(), 3, "A new completion and an explicit retry each read the latest page once");
  assert.equal(await retry.count(), 0);

  const readingKey = await stream.evaluate(root => {
    root.scrollTop = 300;
    root.dispatchEvent(new Event("scroll"));
    const top = root.getBoundingClientRect().top;
    return [...root.querySelectorAll("[data-stream-key]")].find(node => node.getBoundingClientRect().top >= top).dataset.streamKey;
  });
  const reading = stream.locator(`[data-stream-key="${readingKey}"]`);
  const readingBefore = (await reading.boundingBox()).y;
  const hiddenReply = { ...reply, id: "assistant-middle-reply", text: "补回阅读位置之前的回复", createdAt: host.history[0].createdAt + 500 };
  host.history.splice(1, 0, hiddenReply);
  const nextGate = Promise.withResolvers();
  host.historyGate = nextGate.promise;
  host.session.lastCompletedTurnId = "assistant-next-result";
  await host.emit("runtime.updated", { replaceSession: true, session: host.session });
  await pendingStatus.waitFor();
  const readingLoading = (await reading.boundingBox()).y;
  nextGate.resolve();
  await pendingStatus.waitFor({ state: "hidden" });
  await stream.getByText(hiddenReply.text, { exact: true }).waitFor({ state: "attached" });
  const readingAfter = (await reading.boundingBox()).y;

  assert.deepEqual({
    bottomSyncStable: Math.abs(bottomLoading - bottomBefore) <= 4,
    bottomFailureStable: Math.abs(bottomFailed - bottomBefore) <= 4,
    readingStable: Math.abs(readingLoading - readingBefore) <= 4 && Math.abs(readingAfter - readingBefore) <= 4,
    noticeInViewport,
  }, { bottomSyncStable: true, bottomFailureStable: true, readingStable: true, noticeInViewport: true });
  steps.push("Latest-history sync and retry stay visible without shifting the timeline, including a reply inserted above the reading anchor");

  delete host.session.lastCompletedTurnId;
  await host.send({ kind: "snapshot", snapshot: host.snapshot });
  await page.locator(".assistant-page").getByRole("button", { name: "返回", exact: true }).click();
  const navigationReply = { ...reply, id: "assistant-navigation-reply", text: "切回助理时补读的回复", createdAt: Date.now() };
  host.history.push(navigationReply);
  await page.locator(".drawer-assistant-capsule").click();
  await stream.getByText(navigationReply.text, { exact: true }).waitFor();

  const foregroundReply = { ...reply, id: "assistant-foreground-reply", text: "回到前台时补读的回复", createdAt: Date.now() };
  host.history.push(foregroundReply);
  const snapshotReads = host.requests.filter(request => request.method === "snapshot.get").length;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await eventually(() => host.requests.filter(request => request.method === "snapshot.get").length, snapshotReads + 1,
    "The already-connected WebView runs its foreground sync");
  await stream.getByText(foregroundReply.text, { exact: true }).waitFor();
  assert.equal(host.requests.filter(request => request.method === "session.open").length, 1);
  steps.push("An older host with no completion marker recovers replies on tab return and foreground wake without reopening the session");

  const manuallyRead = { ...reply, id: "assistant-manual-reply", text: "手动同步恢复的回复", createdAt: Date.now() };
  host.history.push(manuallyRead);
  host.failHistoryOnce = true;
  Object.assign(host.session, { turnState: "queued", pendingCount: 1 });
  await host.emit("runtime.updated", { replaceSession: true, session: host.session });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await alert.waitFor();
  await assistant.getByRole("button", { name: "同步状态", exact: true }).click();
  await stream.getByText(manuallyRead.text, { exact: true }).waitFor();
  await alert.waitFor({ state: "hidden" });
  steps.push("A successful manual session sync clears the automatic read error");

  host.failHistoryOnce = true;
  host.session.lastCompletedTurnId = "assistant-dismiss-result";
  await host.emit("runtime.updated", { replaceSession: true, session: host.session });
  await alert.waitFor();
  await stream.evaluate(root => { root.scrollTop = 0; });
  const close = assistant.getByRole("button", { name: "关闭同步提示", exact: true });
  const beforeClose = latestReads();
  await close.click();
  await alert.waitFor({ state: "hidden" });
  assert.equal(latestReads(), beforeClose, "Closing a notice does not trigger another history read");
  assert.equal(await stream.getByText("助理历史记录 1", { exact: true }).evaluate(node => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  }), true, "The first transcript row is uncovered when closing the notice");
  steps.push("Loading notices are solid; closing a failed notice uncovers the start of the transcript without repeating the read");

  host.failOpenOnce = true;
  let manualOpenFailed = false;
  host.onDesktopPayload = payload => {
    if (payload.kind === "response" && payload.error?.code === "E2E_OPEN_FAILED") manualOpenFailed = true;
  };
  await assistant.getByRole("button", { name: "同步状态", exact: true }).click();
  await eventually(() => manualOpenFailed, true, "The desktop returns a failed manual open");
  await stream.getByText(manuallyRead.text, { exact: true }).waitFor();
  const afterOpenFailure = { ...reply, id: "assistant-after-open-failure", text: "手动同步失败后自动补读的回复", createdAt: Date.now() };
  host.history.push(afterOpenFailure);
  host.session.lastCompletedTurnId = "assistant-after-open-failure-result";
  await host.emit("runtime.updated", { replaceSession: true, session: host.session });
  await stream.getByText(afterOpenFailure.text, { exact: true }).waitFor();
  steps.push("A later completion recovers missing history after a failed manual open with cached messages");

  const beforeOverlappingReads = latestReads();
  const beforeLeaving = Promise.withResolvers();
  host.historyGate = beforeLeaving.promise;
  const firstReply = { ...reply, id: "assistant-before-leaving", text: "切走前的助理回复", createdAt: Date.now() };
  host.history.push(firstReply);
  host.session.lastCompletedTurnId = "assistant-before-leaving-result";
  await host.emit("runtime.updated", { replaceSession: true, session: host.session });
  await eventually(latestReads, beforeOverlappingReads + 1, "The first catch-up starts before leaving");

  const afterReturning = Promise.withResolvers();
  host.historyGate = afterReturning.promise;
  await page.locator(".assistant-page").getByRole("button", { name: "返回", exact: true }).click();
  await page.locator(".drawer-assistant-capsule").click();
  await eventually(latestReads, beforeOverlappingReads + 2, "Reopening the view starts a second catch-up");
  beforeLeaving.resolve();
  await stream.getByText(firstReply.text, { exact: true }).waitFor();
  const secondReply = { ...reply, id: "assistant-before-return", text: "切回后补读的助理回复", createdAt: Date.now() };
  host.history.push(secondReply);
  afterReturning.resolve();
  await stream.getByText(secondReply.text, { exact: true }).waitFor();
  steps.push("Returning during a pending catch-up keeps both replies when the reads finish in order");
}
