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
  host.history.push(initialUser);
  await openMobileDrawer(page);
  await page.locator(".drawer-assistant-capsule").click();
  const stream = page.locator(".assistant-conversation .conversation-stream");
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
  const unpushed = { ...reply, id: "assistant-unpushed", text: "这条主动回复只写进了电脑历史", createdAt: Date.now() };
  host.history.push(unpushed);
  const gate = Promise.withResolvers();
  host.historyGate = gate.promise;
  host.failHistoryOnce = true;
  host.session.lastCompletedTurnId = "assistant-native-result";
  await host.emit("runtime.updated", { replaceSession: true, session: host.session });
  await stream.getByRole("status").getByText("正在同步最新对话…").waitFor();
  assert.equal(await stream.getByText(reply.text, { exact: true }).count(), 1, "Sync keeps the previous reply visible");
  gate.resolve();
  await stream.getByRole("alert").getByText("最新对话同步失败：隔离历史请求失败").waitFor();
  await page.screenshot({ path: resolve(directory, "assistant-reply-sync-error.png") });
  await stream.getByRole("button", { name: "重试同步", exact: true }).click();
  await stream.getByText(unpushed.text, { exact: true }).waitFor();
  assert.equal(latestReads(), 3, "A new completion and an explicit retry each read the latest page once");
  assert.equal(await stream.getByRole("button", { name: "重试同步", exact: true }).count(), 0);
  steps.push("The mobile assistant restores an evicted reply after reconnect; a native completion marker triggers an online read, which keeps old messages and exposes a failed read with a manual retry");
}
