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
  const connectionsBeforeRetry = serverRoutes.length;
  await retry.click();
  await eventually(() => serverRoutes.length > connectionsBeforeRetry, true, "Quick switch reconnect starts a new relay WebSocket");
  assert.equal(await switcher.isVisible(), true, "Reconnect does not navigate away from the quick switcher");
  assert.equal(await page.getByText(previousHost.session.title, { exact: true }).isVisible(), true, "Reconnect leaves the same host selected");
  steps.push("same-name pairings stay separate; only the current offline host can reconnect from the quick switcher without navigation");
}
