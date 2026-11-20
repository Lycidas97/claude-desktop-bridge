import assert from "node:assert/strict";
import { resolve } from "node:path";
import { openMobileDrawer, openMobileSession } from "../helpers.mjs";

export async function verifyMobileSafeArea(page, steps, directory, viewports) {
  const emulation = await page.context().newCDPSession(page);
  async function assertFixedMobileScale(screen) {
    const { width, height } = page.viewportSize();
    for (const scaleFactor of [1.8, 0.65]) {
      await emulation.send("Input.synthesizePinchGesture", {
        x: Math.floor(width / 2), y: Math.floor(height / 2), scaleFactor, gestureSourceType: "touch",
      });
      assert.equal(await page.evaluate(() => visualViewport.scale), 1, `${screen} keeps 1:1 page scale after a ${scaleFactor}× touch pinch`);
    }
    steps.push(`${screen}: spreading and pinching both leave the page at 1:1`);
  }
  await assertFixedMobileScale("会话列表");
  await page.setViewportSize({ width: 375, height: 640 });
  viewports.push({ page: "会话", ...page.viewportSize() });
  await openMobileSession(page);
  const composer = page.locator(".mobile-composer");
  await composer.waitFor();
  await assertFixedMobileScale("会话");
  const composerPaddings = [];
  for (const bottom of [0, 48]) {
    await emulation.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, right: 0, bottom, left: 0 } });
    const metrics = await composer.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return {
        padding: parseFloat(getComputedStyle(element).paddingBottom),
        bottom: bounds.bottom,
        viewport: innerHeight,
        pageScroll: window.scrollY,
        documentHeight: document.documentElement.scrollHeight,
      };
    });
    assert.ok(metrics.padding >= bottom, `会话 composer bottom padding must cover ${bottom}px safe area (got ${metrics.padding}px)`);
    assert.ok(metrics.bottom <= metrics.viewport, "会话 composer stays inside viewport");
    assert.equal(metrics.pageScroll, 0, "会话 does not scroll the document");
    assert.equal(metrics.documentHeight, metrics.viewport, "会话 does not grow the document");
    composerPaddings.push(metrics.padding);
  }
  assert.ok(composerPaddings[1] > composerPaddings[0], "会话 composer padding grows with nonzero safe area");
  await page.screenshot({ path: resolve(directory, "会话-safe-area.png"), fullPage: true });
  steps.push(`会话: env(safe-area-inset-bottom) 0 → 48px changes composer padding ${composerPaddings[0]} → ${composerPaddings[1]}px`);

  for (const [tab, selector, height] of [
    ["电脑", ".host-browser", 150],
    ["设置", ".mobile-settings-content", 460],
  ]) {
    await page.setViewportSize({ width: 375, height });
    viewports.push({ page: tab, ...page.viewportSize() });
    await openMobileDrawer(page);
    await page.locator(".mobile-drawer-dock-nav").getByRole("button", { name: tab, exact: true }).click();
    const content = page.locator(selector);
    await content.waitFor();
    if (tab === "设置") await assertFixedMobileScale(tab);
    const header = page.locator(".m-header:visible");
    const headerBefore = await header.boundingBox();
    const paddings = [];
    for (const bottom of [0, 48]) {
      // Chromium overrides env() itself; production CSS is neither replaced nor patched.
      await emulation.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, right: 0, bottom, left: 0 } });
      const layout = await content.evaluate(element => {
        element.scrollTop = element.scrollHeight;
        const bounds = element.getBoundingClientRect();
        const last = element.lastElementChild.getBoundingClientRect();
        return {
          padding: parseFloat(getComputedStyle(element).paddingBottom),
          gap: bounds.bottom - last.bottom,
          lastTop: last.top,
          top: bounds.top,
          bottom: bounds.bottom,
          scrollTop: element.scrollTop,
          maxScroll: element.scrollHeight - element.clientHeight,
          viewport: innerHeight,
          pageScroll: window.scrollY,
          documentHeight: document.documentElement.scrollHeight,
        };
      });
      assert.ok(layout.maxScroll > 0, `${tab} fixture must overflow the content area`);
      assert.equal(layout.scrollTop, layout.maxScroll, `${tab} reaches the content scroll end`);
      assert.ok(layout.padding >= bottom, `${tab} bottom padding must cover the ${bottom}px safe area (got ${layout.padding}px)`);
      assert.ok(layout.gap >= Math.max(paddings[0] ?? 0, bottom) - 1, `${tab} last content must stop above the bottom safe area`);
      assert.ok(layout.bottom <= layout.viewport, `${tab} content stays inside the viewport`);
      assert.equal(layout.pageScroll, 0, `${tab} does not scroll the document`);
      assert.equal(layout.documentHeight, layout.viewport, `${tab} does not grow the document`);
      if (tab === "设置") assert.ok(layout.lastTop >= layout.top, "The entire diagnostics group is visible at scroll end");
      assert.deepEqual(await header.boundingBox(), headerBefore, `${tab} header stays fixed while its content scrolls`);
      paddings.push(layout.padding);
    }
    assert.ok(paddings[1] > paddings[0], `${tab} padding grows with a nonzero safe area`);
    await page.screenshot({ path: resolve(directory, `${tab}-safe-area.png`), fullPage: true });
    steps.push(`${tab}: env(safe-area-inset-bottom) 0 → 48px changes padding ${paddings[0]} → ${paddings[1]}px; last content clears safe area, header/document stay fixed`);
  }
  const settings = page.locator(".mobile-settings-content");
  const { x, y, width, height } = await settings.boundingBox();
  const gesture = { x: x + width / 2, y: y + height / 2, gestureSourceType: "touch", preventFling: true };
  const scrollEnd = await settings.evaluate(element => element.scrollTop);
  await emulation.send("Input.synthesizeScrollGesture", { ...gesture, yDistance: 120 });
  assert.ok(await settings.evaluate(element => element.scrollTop) < scrollEnd, "Settings still scrolls away from the end with a touch gesture");
  await emulation.send("Input.synthesizeScrollGesture", { ...gesture, yDistance: -240 });
  assert.equal(await settings.evaluate(element => element.scrollTop), scrollEnd, "An upward swipe past the end leaves settings at the content boundary");
  // Headless Chromium does not render the phone's elastic bounce. Check the
  // resolved browser policy as well as the bounds reached by touch scrolling.
  assert.equal(await settings.evaluate(element => getComputedStyle(element).overscrollBehaviorY), "none", "Settings disables vertical rubber-banding and scroll chaining at the boundary");
  steps.push("Touch scrolling moves within settings and stops at the content end with vertical overscroll disabled");
  await page.getByRole("button", { name: "连接诊断与日志", exact: true }).click();
  await page.getByRole("dialog", { name: "连接诊断与日志导出", exact: true }).waitFor();
  steps.push("The final settings diagnostics button opens its dialog after scrolling to the bottom");
  await emulation.detach();
}
