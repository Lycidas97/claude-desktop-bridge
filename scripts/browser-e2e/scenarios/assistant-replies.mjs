import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eventually, openMobileDrawer } from "../helpers.mjs";

export async function verifyAssistantReplies(page, host, steps, directory, relayPeers) {
  const { sessionId } = host.session;
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

  const mobilePeers = [...relayPeers].filter(([, hello]) => hello.roomId === host.pairing.roomId && hello.role === "mobile");
  assert.equal(mobilePeers.length, 1);
  const otherSession = host.snapshot.sessions.find(candidate => candidate.sessionId !== sessionId);
  for (let index = 0; index < 2_000; index++) {
    await host.emit("assistant.delta", { text: "片段" }, { itemId: "neighbour-stream", sessionId: otherSession.sessionId, replayOnly: true });
  }
  const followup = { ...initialUser, id: "assistant-followup", text: "再追问一次", createdAt: Date.now() };
  host.history.push(followup);
  const last = await host.emit("user.message.accepted", { text: followup.text }, { itemId: followup.id, replayOnly: true });
  mobilePeers[0][0].close(1012, "assistant reply catch-up");
  await eventually(() => host.resumeBatches.some(batch => batch.includes(last.eventId)), true, "The mobile client replays the background events");
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
  const bottomLoading = (await bottomMessage.boundingBox()).y;
  assert.equal(await stream.getByText(reply.text, { exact: true }).count(), 1, "Sync keeps the previous reply visible");
  gate.resolve();
  const alert = assistant.getByRole("alert").filter({ hasText: "最新对话同步失败" });
  await alert.getByText(/隔离历史请求失败/u).waitFor();
  const bottomFailed = (await bottomMessage.boundingBox()).y;
  const noticeInViewport = (await Promise.all([alert.boundingBox(), retry.boundingBox()]))
    .every(box => box && box.y >= 0 && box.y + box.height <= page.viewportSize().height);
  await page.screenshot({ path: resolve(directory, "assistant-reply-sync-error.png") });
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
  const nextGate = Promise.withResolvers();
  host.historyGate = nextGate.promise;
  host.session.lastCompletedTurnId = "assistant-next-result";
  await host.emit("runtime.updated", { replaceSession: true, session: host.session });
  await pendingStatus.waitFor();
  const readingLoading = (await reading.boundingBox()).y;
  nextGate.resolve();
  await pendingStatus.waitFor({ state: "hidden" });
  const readingAfter = (await reading.boundingBox()).y;

  assert.deepEqual({
    bottomSyncStable: Math.abs(bottomLoading - bottomBefore) <= 4,
    bottomFailureStable: Math.abs(bottomFailed - bottomBefore) <= 4,
    readingStable: Math.abs(readingLoading - readingBefore) <= 4 && Math.abs(readingAfter - readingBefore) <= 4,
    noticeInViewport,
  }, { bottomSyncStable: true, bottomFailureStable: true, readingStable: true, noticeInViewport: true });
  steps.push("Latest-history sync and retry stay visible without shifting the timeline, both at the bottom and while reading older messages");
}
