import assert from "node:assert/strict";
import { resolve } from "node:path";
import { desktopFixtureRequest, openMobileDrawer } from "./helpers.mjs";

export async function expandInboxMail(card) {
  const row = card.locator(".assistant-mail-row");
  if (!(await row.evaluate(element => element.open))) await row.locator(":scope > summary").click();
  return card;
}

export async function fileMailInCategory(page, card, category) {
  await expandInboxMail(card);
  await card.getByRole("button", { name: "收入分类", exact: true }).click();
  await page.getByRole("dialog", { name: "收入分类", exact: true }).getByRole("button", { name: category, exact: true }).click();
}

export async function openDesktopAssistant(page, host, baseUrl, requests) {
  await page.exposeFunction("assistantDesktopRequest", async input => {
    const request = desktopFixtureRequest(input);
    requests.push(input);
    if (input.method === "assistant.proposal.resolve") await host.proposalResolveGate;
    const result = await host.nativeApproval.controllerRequest(request, "desktop");
    return { kind: "response", requestId: request.requestId, ok: true, result };
  });
  await page.addInitScript(initialSnapshot => {
    let snapshot = initialSnapshot;
    let onSnapshot;
    window.assistantDesktopSnapshot = (patch) => {
      snapshot = { ...snapshot, ...patch };
      onSnapshot?.(structuredClone(snapshot));
    };
    window.bridgeDesktop = {
      getSnapshot: async () => structuredClone(snapshot), onSnapshot: listener => {
        onSnapshot = listener;
        return () => { onSnapshot = undefined; };
      }, onEvent: () => () => {},
      request: async input => {
        const response = await window.assistantDesktopRequest(input);
        const { assistantMail, assistantAgenda, session } = response.result;
        if (assistantMail) window.assistantDesktopSnapshot({ assistantMail });
        if (assistantAgenda) window.assistantDesktopSnapshot({ assistantAgenda });
        if (input.method === "session.configure" && session) window.assistantDesktopSnapshot({
          sessions: snapshot.sessions.map(candidate => candidate.sessionId === session.sessionId ? session : candidate),
        });
        return response;
      },
    };
  }, { ...host.snapshot, connection: "connected", launchAtLogin: false, diagnosticsEnabled: false, managedDesktopEnabled: false,
    host: { ...host.snapshot.host, capabilities: host.snapshot.host.capabilities.filter(value => value !== "plugin.magpie-quota.v1") },
    claudeDesktop: { state: "running", detail: "隔离 Native 宿主", canLaunch: false, canQuit: true } });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^助理(?:，有事项待关注)?$/u }).click();
  await page.locator(".assistant-conversation textarea").waitFor();
}

export async function openMobileAssistant(page) {
  await openMobileDrawer(page);
  await page.locator(".mobile-home-catalog").getByRole("button", { name: /^助理(?:，\d+\+? 条未读)?$/u }).click();
}

export function assistantViewCapture(page, directory, viewports) {
  return async name => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name} fits the viewport`);
    viewports.push({ page: name, ...page.viewportSize() });
    await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
  };
}
