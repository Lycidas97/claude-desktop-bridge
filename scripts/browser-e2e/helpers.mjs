import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { sessionId } from "./config.mjs";

// Mirror DesktopController.dispatchLocal for browser fixtures that bypass Electron IPC.
export function desktopFixtureRequest(input) {
  return { kind: "request", requestId: randomUUID(), idempotencyKey: input.idempotencyKey ?? randomUUID(),
    method: input.method, params: input.params ?? {} };
}

// Bounded polling is only for observable browser/protocol state, never a fixed
// sleep intended to hide a race. Unexpected selector or transport errors surface.
export async function eventually(read, expected, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let actual;
  do {
    actual = await read();
    if (isDeepStrictEqual(actual, expected)) return;
    await delay(50);
  } while (Date.now() < deadline);
  assert.deepEqual(actual, expected, message);
}

export async function syncNativeSections(host) {
  const { capable, moveCapable, renameCapable, deleteCapable, trustCapable, runtimeCapabilities, projects, sessions } = await host.nativeApproval.sectionCatalog();
  host.snapshot.projects = projects;
  host.snapshot.sessions = sessions;
  host.snapshot.host.capabilities = host.snapshot.host.capabilities.filter(
    value => !["section.create.v1", "section.move.v1", "section.rename.v1", "section.delete.v1", "workspace.trust.v1", "directory.browse.v1", "directory.mkdir.v1"].includes(value),
  );
  host.snapshot.host.capabilities.push("directory.browse.v1", "directory.mkdir.v1");
  if (capable) host.snapshot.host.capabilities.push("section.create.v1");
  if (moveCapable) host.snapshot.host.capabilities.push("section.move.v1");
  if (renameCapable) host.snapshot.host.capabilities.push("section.rename.v1");
  if (deleteCapable) host.snapshot.host.capabilities.push("section.delete.v1");
  if (trustCapable) host.snapshot.host.capabilities.push("workspace.trust.v1");
  if (host.snapshot.runtimes?.[0]) host.snapshot.runtimes[0].capabilities = runtimeCapabilities;
}

export async function openMobileDrawer(page) {
  await page.locator('.mobile-home-catalog, .m-header button[aria-label="返回会话列表"], .m-header button[aria-label="返回"], button[aria-label="返回对话"]').filter({ visible: true }).first().waitFor();
  if (await page.locator(".mobile-home-catalog").filter({ visible: true }).count() > 0) return;
  const backToChat = page.getByRole("button", { name: "返回对话", exact: true }).filter({ visible: true });
  if (await backToChat.count() > 0) await backToChat.first().click();
  await page.locator(".m-header:visible").getByRole("button", { name: /^(?:返回会话列表|返回)$/u }).first().click();
  await page.locator(".mobile-home-catalog").filter({ visible: true }).waitFor();
}

export async function openMobileSession(page, targetSessionId = sessionId) {
  await openMobileDrawer(page);
  await page.locator(`.mobile-home-catalog [data-session-id="${targetSessionId}"] .session-row-hit`).click();
}

export async function selectCustomOption(page, triggerLocator, value) {
  await triggerLocator.click();
  const listbox = page.getByRole("listbox");
  await listbox.waitFor();
  const options = listbox.getByRole("option");
  const idx = await options.evaluateAll((els, target) => els.findIndex((el) => el.getAttribute("data-option-value") === target), String(value));
  assert.ok(idx >= 0, `Custom select option "${value}" must exist`);
  await options.nth(idx).click();
}

export async function customSelectValue(triggerLocator) {
  return triggerLocator.getAttribute("data-value");
}
