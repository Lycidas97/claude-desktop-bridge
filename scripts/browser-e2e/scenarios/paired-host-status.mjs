import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createMockHost } from "../mock-host.mjs";
import { eventually } from "../helpers.mjs";

export async function createPreviousPairedHost(runtime, errors) {
  const host = await createMockHost(runtime, false, false, errors);
  Object.assign(host.session, { title: "旧配对缓存会话", turnState: "running", ownership: "DESKTOP_NATIVE_RUNNING" });
  host.snapshot.runtime.activeTurns = 1;
  host.snapshot.host.lastSeenAt -= 2 * 60 * 60 * 1000;
  return host;
}

export async function verifyPairedHostStatus(page, previousHost, host, steps, directory, serverRoutes) {
  await page.getByRole("button", { name: `当前电脑：${host.pairing.desktopName}，切换电脑` }).filter({ has: page.locator(".is-online") }).click();
  const switcher = page.getByRole("region", { name: "快捷切换电脑" });
  const current = switcher.locator('.drawer-host-option[aria-current="true"]');
  const other = switcher.locator('.drawer-host-option:not([aria-current])');
  assert.deepEqual(await switcher.locator(".drawer-host-option-name").allTextContents(), [host.pairing.desktopName, host.pairing.desktopName]);
  assert.equal(await other.locator(".drawer-host-option-meta").innerText(), "2 小时前", "The quick switcher shows last activity for the cached host");
  assert.equal(await other.locator(".m-status-dot").getAttribute("class"), "m-status-dot");
  assert.equal(await current.locator(".is-online").count(), 1);
  const retry = switcher.getByRole("button", { name: "重新连接", exact: true });
  assert.equal(await retry.count(), 0, "No reconnect action for the online current host or the inactive host");
  await switcher.screenshot({ path: resolve(directory, "same-name-quick-switch.png") });

  await page.getByRole("button", { name: "电脑", exact: true }).click();
  const paired = page.getByRole("region", { name: "已配对的电脑" });
  const previous = paired.locator(".host-row-shell:not(.is-current)");
  assert.match(await previous.innerText(), /未连接 · 2 小时前/u);
  assert.equal(await previous.locator(".m-status-dot").getAttribute("class"), "m-status-dot");
  assert.match(await paired.locator(".host-row[aria-current=true]").innerText(), /当前电脑 · 在线/u);
  await paired.screenshot({ path: resolve(directory, "same-name-paired-computers.png") });

  await previous.locator(".host-row").click();
  await page.getByText(previousHost.session.title, { exact: true }).waitFor();
  assert.equal(await page.getByText(host.session.title, { exact: true }).count(), 0, "Switching hosts must not mix catalogs");
  await page.getByRole("button", { name: `当前电脑：${previousHost.pairing.desktopName}，切换电脑` }).click();
  assert.equal(await current.locator(".drawer-host-option-meta").innerText(), "离线");
  assert.equal(await current.locator(".is-online").count(), 0);
  await retry.waitFor();
  await switcher.screenshot({ path: resolve(directory, "offline-quick-switch.png") });
  await page.clock.install();
  const connectionsBeforeRetry = serverRoutes.length;
  await retry.click();
  await eventually(() => serverRoutes.length > connectionsBeforeRetry, true, "Quick switch reconnect starts a new relay WebSocket");
  assert.equal(await current.locator(".drawer-host-option-meta").innerText(), "正在重连", "The current host shows progress while waiting for an encrypted reply");
  const retrying = switcher.getByRole("button", { name: "正在重连", exact: true });
  assert.equal(await retrying.isDisabled(), true);
  await switcher.screenshot({ path: resolve(directory, "reconnecting-quick-switch.png") });
  assert.equal(await switcher.isVisible(), true, "Reconnect does not navigate away from the quick switcher");
  assert.equal(await page.getByText(previousHost.session.title, { exact: true }).isVisible(), true, "Reconnect leaves the same host selected");

  await eventually(() => page.evaluate(async () => {
    const { collectRendererDiagnosticsSnapshot } = await import("/src/lib/diagnostics.ts");
    return (await collectRendererDiagnosticsSnapshot()).bridgeState.connection;
  }), "connected", "Relay accepted the connection before the clock advances");
  // Run the heartbeat intervals in order; a single jump would make the Relay look stale.
  await page.clock.runFor(26_000);
  const failure = switcher.getByRole("alert").filter({ hasText: "中继未发现电脑" });
  await failure.waitFor();
  assert.equal(await retry.isEnabled(), true, "An offline failure leaves the retry action available");
  await switcher.screenshot({ path: resolve(directory, "reconnect-failed-quick-switch.png") });

  const send = previousHost.send;
  let heldReply;
  // Keep the fixture present on Relay while withholding its encrypted replies.
  previousHost.send = async (payload) => {
    if (payload.kind === "response" && previousHost.requests.some(request => request.method === "snapshot.get" && request.requestId === payload.requestId)) heldReply = payload;
  };
  await retry.click();
  previousHost.socket.connect();
  await eventually(() => Boolean(heldReply), true, "The new attempt reaches the silent desktop over Relay");
  assert.equal(await retrying.isDisabled(), true, "Relay presence alone does not complete the retry");
  assert.equal(await current.locator(".is-online").count(), 0);
  assert.equal(await failure.count(), 0, "A new attempt clears the previous failure");
  await send(heldReply);
  await current.locator(".is-online").waitFor();
  assert.equal(await retrying.count(), 0, "An authenticated reply completes the retry");
  steps.push("Same-name pairings stay separate; quick switch retry reports progress, an inline offline failure, and recovery only after an encrypted reply without navigating away");

  previousHost.socket.close();
  await retry.waitFor();
  const connectionsBeforeRevocation = serverRoutes.length;
  await retry.click();
  await eventually(() => serverRoutes.length > connectionsBeforeRevocation, true, "The retry opens a new route for Relay to reject");
  serverRoutes.at(-1).send(JSON.stringify({ type: "error", code: "DEVICE_REVOKED", message: "Test fixture revoked this device" }));
  await switcher.getByRole("alert").filter({ hasText: "撤销" }).waitFor();
  assert.equal(await retry.count(), 0, "The revoked pairing cannot be retried");
  await current.click();
  const pairingLink = page.getByRole("textbox", { name: "配对链接" });
  await pairingLink.waitFor({ timeout: 3_000 });
  await page.getByRole("button", { name: "返回电脑列表" }).click();
  await page.getByRole("button", { name: "重新配对", exact: true }).click({ timeout: 3_000 });
  await pairingLink.waitFor({ timeout: 3_000 });
  await page.screenshot({ path: resolve(directory, "repair-pairing-screen.png") });
  steps.push("Relay revocation keeps the inline reason and opens the pairing screen from both the affected host row and the disconnected catalog");
}
