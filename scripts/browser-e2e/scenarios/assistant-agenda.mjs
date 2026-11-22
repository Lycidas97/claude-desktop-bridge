import assert from "node:assert/strict";
import { resolve } from "node:path";
import { eventually } from "../helpers.mjs";
import { openDesktopAssistant } from "./assistant-mail.mjs";

export async function verifyAssistantAgenda(page, host, steps, directory, viewports, baseUrl) {
  async function capture(name) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name} fits the viewport`);
    viewports.push({ page: name, ...page.viewportSize() });
    await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
  }
  const settingsButton = page.locator(".assistant-view-tabs").getByRole("button", { name: "助理设置", exact: true });
  const refreshMail = page.getByRole("button", { name: /刷新邮件列表/u });
  await page.locator(".mobile-home-catalog").getByRole("button", { name: /^助理(?:，.*)?$/u }).click();
  const mobileSettingsX = (await settingsButton.boundingBox()).x;
  const agendaFixture = host.nativeApproval.assistantMail.agenda;
  const today = await page.evaluate(() => new Date().toLocaleDateString("sv-SE"));
  const tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10);
  for (let index = 1; index <= 51; index++) {
    agendaFixture.saveTodo({ value: { title: `分页待办 ${index}`, status: "pending", dueAt: new Date(Date.parse(today) - (52 - index) * 86_400_000).toISOString().slice(0, 10) } });
  }
  agendaFixture.saveEvent({ value: { title: "今天的评审", startAt: today, endAt: tomorrow, allDay: true, timeZone: "America/Los_Angeles" } });
  agendaFixture.saveEvent({ value: { title: "明天的全天日程", startAt: tomorrow,
    endAt: new Date(Date.parse(tomorrow) + 86_400_000).toISOString().slice(0, 10), allDay: true, timeZone: "UTC" } });
  agendaFixture.saveTodo({ value: { title: "当天待办", status: "pending", dueAt: today } });
  await page.locator(".assistant-view-tabs").getByRole("button", { name: "议程", exact: true }).click();
  const agendaView = page.getByRole("region", { name: "议程", exact: true });
  const sameDay = agendaView.getByRole("list", { name: "当日议程", exact: true });
  await sameDay.getByText("当天待办", { exact: true }).waitFor();
  await sameDay.getByText("今天的评审", { exact: true }).waitFor();
  assert.equal((await settingsButton.boundingBox()).x, mobileSettingsX, "Mobile assistant settings stays in place on Agenda");
  assert.equal(await refreshMail.count(), 0, "Agenda does not offer a mail refresh");
  assert.equal(await agendaView.getByRole("button", { name: /^新建(?:待办|日程)$/u }).count(), 0, "Day view has no create buttons");
  assert.equal(await sameDay.getByRole("listitem").count(), 2, "Tasks due before this date cannot consume the day page");
  const overdue = page.getByRole("list", { name: "已逾期待办", exact: true });
  await overdue.getByText("分页待办 1", { exact: true }).waitFor();
  assert.equal(await overdue.getByRole("listitem").count(), 3, "A limited overdue preview is visible without expanding other tasks");
  steps.push("the default agenda shows both same-day records and a small preview of overdue tasks");
  await page.getByRole("checkbox", { name: "完成 当天待办", exact: true }).click();
  await eventually(() => agendaFixture.listTodos({ limit: 100 }).records.find(record => record.title === "当天待办")?.status, "completed", "Mobile agenda mutations reach the authenticated controller");
  await eventually(() => page.getByRole("checkbox", { name: "完成 当天待办", exact: true }).isChecked(), true, "Live agenda change refreshes the mobile checkbox");
  await capture("mobile-agenda");
  await page.locator(".agenda-other-todos summary").click();
  const otherTodos = page.getByRole("list", { name: "其他待办", exact: true });
  const moreTodos = page.getByRole("button", { name: "更多其他待办", exact: true });
  await eventually(() => otherTodos.getByRole("listitem").count(), 47, "Other tasks show the remaining first page without duplicating the overdue preview");
  host.mailOffline = true;
  host.socket.close();
  await page.getByText("电脑离线，连接后可同步议程。", { exact: true }).waitFor();
  const beforeOfflineChange = host.events.length;
  agendaFixture.saveTodo({ value: { title: "未安排日期的待办", status: "pending" } });
  const lastOfflineChange = host.events.slice(beforeOfflineChange).find(event => event.type === "plugin.assistant-agenda.changed").eventId;
  host.mailOffline = false;
  host.socket.connect();
  await eventually(() => host.resumeBatches.some(batch => batch.includes(lastOfflineChange)), true, "Reconnect replays the last offline agenda change");
  await sameDay.getByText("今天的评审", { exact: true }).waitFor();
  await moreTodos.click();
  await eventually(() => otherTodos.getByRole("listitem").count(), 49, "Other tasks retain cursor pagination after reconnect");
  await otherTodos.getByText("未安排日期的待办", { exact: true }).waitFor();
  const secondPage = agendaFixture.listTodos({ limit: 100 }).records.find(record => record.title === "分页待办 51");
  agendaFixture.saveTodo({ existing: { id: secondPage.id, revision: secondPage.revision }, value: { title: "第二页已同步", status: "pending", dueAt: secondPage.dueAt } });
  await page.getByText("第二页已同步", { exact: true }).waitFor();
  steps.push("agenda reconnect and live changes reload the requested page depth");

  const originalTodo = agendaFixture.listTodos({ limit: 100 }).records.find(record => record.title === "当天待办");
  agendaFixture.saveEvent({ value: { title: "待编辑日程", startAt: `${today}T17:00:00Z`, endAt: `${today}T18:00:00Z`, allDay: false, timeZone: "America/Los_Angeles" } });
  const originalEvent = agendaFixture.listEvents({ from: `${today}T00:00:00Z`, to: `${tomorrow}T00:00:00Z` })
    .records.find(record => record.title === "待编辑日程");
  const desktopRequests = [];
  await openDesktopAssistant(page, host, baseUrl, desktopRequests);
  const desktopSettingsX = (await settingsButton.boundingBox()).x;
  await page.locator(".assistant-view-tabs").getByRole("button", { name: "议程", exact: true }).click();
  await sameDay.getByText("当天待办", { exact: true }).waitFor();
  await sameDay.getByText("今天的评审", { exact: true }).waitFor();
  assert.equal((await settingsButton.boundingBox()).x, desktopSettingsX, "Desktop assistant settings stays in place on Agenda");
  assert.equal(await page.getByRole("checkbox", { name: "完成 当天待办", exact: true }).isChecked(), true);
  await page.getByRole("button", { name: "编辑 当天待办", exact: true }).click();
  assert.equal(await page.getByLabel("截止日期", { exact: true }).inputValue(), today);
  await page.getByLabel("标题", { exact: true }).fill("桌面编辑的待办");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("桌面编辑的待办", { exact: true }).waitFor();
  assert.deepEqual(desktopRequests.find(request => request.method === "plugin.assistant-agenda.todo.save")?.params?.existing,
    { id: originalTodo.id, revision: originalTodo.revision }, "Desktop edits the original todo revision");
  await capture("desktop-agenda");
  await agendaView.getByRole("button", { name: "日历", exact: true }).click();
  await agendaView.getByText("今天的评审", { exact: true }).waitFor();
  assert.equal(await agendaView.getByRole("button", { name: /^新建(?:待办|日程)$/u }).count(), 0, "Month view has no create buttons");
  assert.equal(await agendaView.getByRole("checkbox").count(), 0, "The month query shows only calendar events");
  await agendaView.getByRole("button", { name: "上个月", exact: true }).click();
  await agendaView.getByText("本月暂无日程", { exact: true }).waitFor();
  await agendaView.getByRole("button", { name: "按日", exact: true }).click();
  await sameDay.getByText("桌面编辑的待办", { exact: true }).waitFor();
  await sameDay.getByText("今天的评审", { exact: true }).waitFor();
  await agendaView.getByRole("button", { name: "前一天", exact: true }).click();
  await sameDay.getByText("第二页已同步", { exact: true }).waitFor();
  assert.equal(await sameDay.getByText("今天的评审", { exact: true }).count(), 0);
  await agendaView.getByRole("button", { name: "回到今天", exact: true }).click();
  await sameDay.getByText("今天的评审", { exact: true }).waitFor();
  await agendaView.getByRole("button", { name: "后一天", exact: true }).click();
  await sameDay.getByText("明天的全天日程", { exact: true }).waitFor();
  assert.equal(await sameDay.getByText("今天的评审", { exact: true }).count(), 0);
  await page.locator(".assistant-view-tabs").getByRole("button", { name: "收件", exact: true }).click();
  await page.locator(".assistant-view-tabs").getByRole("button", { name: "议程", exact: true }).click();
  await sameDay.getByText("今天的评审", { exact: true }).waitFor();
  steps.push("browsing a different month leaves the selected day intact; the today shortcut and reopening both return to today");
  await page.clock.setFixedTime(new Date(`${tomorrow}T19:00:00Z`));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await eventually(() => agendaView.locator(".agenda-month time").getAttribute("datetime"), tomorrow, "The today view follows the new date when the tab becomes visible again");
  await sameDay.getByText("明天的全天日程", { exact: true }).waitFor();
  await page.clock.setFixedTime(new Date());
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await sameDay.getByText("今天的评审", { exact: true }).waitFor();
  await agendaView.getByRole("button", { name: "编辑 待编辑日程", exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("单日全天日程");
  await page.getByLabel("全天", { exact: true }).check();
  const endDate = page.getByLabel("结束日期", { exact: true });
  await endDate.fill(today);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const editEvent = agendaView.getByRole("button", { name: "编辑 单日全天日程", exact: true });
  await editEvent.click();
  assert.equal(await page.getByLabel("开始日期", { exact: true }).inputValue(), today);
  assert.equal(await endDate.inputValue(), today, "Reopening a one-day event shows the same date at both ends");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  steps.push("day and month views have no create buttons; phone completion and Desktop todo/event edits share durable agenda storage");

  host.nativeApproval.assistantMail.seedCalendar([
    "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTIMEZONE", "TZID:Eastern Standard Time", "BEGIN:STANDARD",
    "DTSTART:19700101T000000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0500", "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT", "UID:custom-zone", "SUMMARY:外部时区日程", "DTSTART;TZID=Eastern Standard Time:20270630T090000",
    "DURATION:PT1H", "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n"), [
    "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:over-budget", "DTSTART:20140101T090000Z",
    "DURATION:PT30M", "RRULE:FREQ=HOURLY;BYMINUTE=0", "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n"));
  await agendaView.getByRole("button", { name: "日历", exact: true }).click();
  await agendaView.getByRole("button", { name: "下个月", exact: true }).click();
  await editEvent.click();
  await page.getByLabel("标题", { exact: true }).fill("东京跨月日程");
  await page.getByLabel("全天", { exact: true }).uncheck();
  await page.locator(".agenda-form").getByRole("combobox").selectOption("Asia/Tokyo");
  await page.getByLabel("开始时间", { exact: true }).fill("2027-07-01T00:15");
  await page.getByLabel("结束时间", { exact: true }).fill("2027-07-01T01:15");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("东京跨月日程", { exact: true }).waitFor();
  assert.deepEqual(desktopRequests.filter(request => request.method === "plugin.assistant-agenda.event.save").map(request => request.params?.existing), [
    { id: originalEvent.id, revision: originalEvent.revision },
    { id: originalEvent.id, revision: originalEvent.revision + 1 },
  ], "Both calendar edits save the same event with its current revision");
  assert.equal(await page.locator(".agenda-month strong").innerText(), "2027年6月");
  const importedEvent = page.getByRole("listitem").filter({ hasText: "外部时区日程" });
  await importedEvent.waitFor();
  assert.match(await importedEvent.innerText(), /America\/Los_Angeles/u);
  await page.getByRole("status").filter({ hasText: "部分重复日程超出展开上限，未显示。" }).waitFor();
  await capture("desktop-agenda-partial");
  steps.push("the Los Angeles month shows the saved Tokyo event and the custom TZID import alongside a partial-calendar warning");

  const requestsBeforeLegacyAgenda = desktopRequests.length;
  await page.evaluate(host => window.assistantDesktopSnapshot({ host }), { ...host.snapshot.host,
    capabilities: host.snapshot.host.capabilities.filter(value => !["plugin.assistant-agenda.day.v1", "plugin.magpie-quota.v1"].includes(value)) });
  await agendaView.getByRole("button", { name: "按日", exact: true }).click();
  await agendaView.getByRole("button", { name: "更多待办", exact: true }).click();
  await sameDay.getByText("桌面编辑的待办", { exact: true }).waitFor();
  assert.deepEqual(desktopRequests.slice(requestsBeforeLegacyAgenda).filter(request => request.method === "plugin.assistant-agenda.todo.list")
    .map(request => Object.keys(request.params ?? {}).filter(key => key !== "client")), [[], ["cursor"]]);
  assert.deepEqual(desktopRequests.slice(requestsBeforeLegacyAgenda).filter(request => request.method === "plugin.assistant-agenda.event.list")
    .map(request => Object.keys(request.params ?? {}).filter(key => key !== "client").sort()), [["from", "to"]]);
  steps.push("an older host gets only the original event window, unfiltered todo request and cursor");

  await page.evaluate(host => window.assistantDesktopSnapshot({ host }), host.snapshot.host);
  await verifyUnchangedCalDavRefresh(page, host.nativeApproval.assistantMail, agendaView, settingsButton, tomorrow, desktopRequests, steps);
}

async function verifyUnchangedCalDavRefresh(page, fixture, agendaView, settingsButton, date, requests, steps) {
  const path = "/refresh-fixture/";
  const url = `https://caldav.example.test${path}`;
  const calendarDate = date.replaceAll("-", "");
  const rollingTitle = "进入滚动窗口的待办";
  fixture.setCalendarTime(Date.parse("1998-12-31T11:30:00Z"));
  const items = ["VEVENT", "VTODO"].flatMap(kind => Array.from({ length: 101 }, (_, index) => {
    const uid = `${kind}-${index}`;
    return { href: `${path}${uid}.ics`, etag: '"1"', data: ["BEGIN:VCALENDAR", "VERSION:2.0", `BEGIN:${kind}`, `UID:${uid}`, `SUMMARY:${uid}`,
      kind === "VEVENT" ? `DTSTART;VALUE=DATE:${calendarDate}` : `DUE;VALUE=DATE:${calendarDate}`,
      `END:${kind}`, "END:VCALENDAR", ""].join("\r\n") };
  }));
  items.push({ href: `${path}rolling.ics`, etag: '"1"', data: ["BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VTODO", "UID:rolling", `SUMMARY:${rollingTitle}`, "DTSTART:20000101T120000Z", "DUE:20000101T120000Z",
    "RRULE:FREQ=YEARLY", "END:VTODO", "END:VCALENDAR", ""].join("\r\n") });
  let unauthorized = false;
  let ctag = 1;
  const davRequests = [];
  const row = (href, props) => `<response><href>${href}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
  fixture.setCalendarFetch(async (address, options) => {
    assert.equal(address, url);
    const depth = new Headers(options.headers).get("Depth");
    davRequests.push([options.method, depth]);
    if (unauthorized) return new Response(null, { status: 401 });
    const rows = depth === "0" ? row(path, `<cs:getctag>${ctag}</cs:getctag>`)
      : (depth === "1" ? row(path, "<resourcetype><collection/></resourcetype>") : "") + items
        .filter(item => depth === "1" || options.body.includes(`<d:href>${item.href}</d:href>`))
        .map(item => row(item.href, `<getetag>${item.etag}</getetag>` +
          (depth === "1" ? "" : `<c:calendar-data><![CDATA[${item.data}]]></c:calendar-data>`))).join("");
    return new Response(`<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${rows}</multistatus>`, { status: 207 });
  });
  await fixture.agenda.addSource({ url, label: "同步夹具", user: "fixture", credential: "fixture" });
  const before = fixture.agenda.snapshot().sources.find(source => source.label === "同步夹具");
  assert.equal(before.status, "ready");
  assert.deepEqual(davRequests, [["PROPFIND", "0"], ["PROPFIND", "1"], ["REPORT", null]]);
  const query = { from: `${date}T00:00:00Z`, to: new Date(Date.parse(date) + 86_400_000).toISOString(), allDayOn: date, limit: 100 };
  const eventsBefore = fixture.agenda.listEvents(query);
  const todosBefore = fixture.agenda.listTodos({ limit: 100 });
  const refresh = () => page.evaluate(async id => {
    const result = await window.bridgeDesktop.request({ method: "plugin.assistant-agenda.source.refresh", params: { id } });
    return result.result.assistantAgenda.sources.find(source => source.id === id);
  }, before.id);
  unauthorized = true;
  assert.equal((await refresh()).errorCode, "credentials");
  unauthorized = false;
  const moreEvents = agendaView.getByRole("button", { name: "更多日程", exact: true });
  const moreTodos = agendaView.getByRole("button", { name: "更多待办", exact: true });
  const sameDay = agendaView.getByRole("list", { name: "当日议程", exact: true });
  async function openTwoPagesTomorrow() {
    await sameDay.getByText("今天的评审", { exact: true }).waitFor();
    await agendaView.getByRole("button", { name: "后一天", exact: true }).click();
    await moreEvents.click();
    await moreTodos.click();
    await eventually(() => sameDay.getByRole("listitem").count(), 200, "Two pages of both CalDAV lists are open");
  }
  await openTwoPagesTomorrow();
  const first = requests.length;
  const davStart = davRequests.length;
  fixture.setCalendarTime(Date.parse("1998-12-31T11:45:00Z"));
  const after = await refresh();
  assert.deepEqual(davRequests.slice(davStart), [["PROPFIND", "0"]], "The CalDAV collection tag stayed the same");
  assert.equal(after.status, "ready");
  assert.equal(after.errorCode, undefined);
  assert.ok(after.refreshedAt > before.refreshedAt);
  assert.deepEqual(fixture.agenda.listEvents(query), eventsBefore);
  assert.deepEqual(fixture.agenda.listTodos({ limit: 100 }), todosBefore);
  async function agendaReadsSince(start) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await eventually(async () => (await moreEvents.isEnabled()) && (await moreTodos.isEnabled()), true, "Agenda pagination has settled");
    const reads = requests.slice(start);
    return { events: reads.filter(({ method }) => method === "plugin.assistant-agenda.event.list").length,
      todos: reads.filter(({ method }) => method === "plugin.assistant-agenda.todo.list").length };
  }
  assert.deepEqual(await agendaReadsSince(first), { events: 0, todos: 0 }, "An unchanged CalDAV refresh issues no agenda list RPCs");
  assert.equal(await sameDay.getByRole("listitem").count(), 200, "Both lists keep their loaded pages");
  await settingsButton.click();
  await page.getByRole("article", { name: "同步夹具" }).getByText("已就绪", { exact: true }).waitFor();
  await page.locator(".assistant-view-tabs").getByRole("button", { name: "议程", exact: true }).click();
  await openTwoPagesTomorrow();

  const { title, resourceHref } = eventsBefore.records.find(record => record.sourceId === before.id);
  const event = items.find(item => item.href === new URL(resourceHref).pathname);
  event.etag = '"2"';
  event.data = event.data.replace(`SUMMARY:${title}\r\n`, "SUMMARY:CalDAV record edited\r\n");
  ctag++;
  const beforeEdit = requests.length;
  fixture.setCalendarTime(Date.parse("1998-12-31T11:59:00Z"));
  const edited = await refresh();
  await sameDay.getByText("CalDAV record edited", { exact: true }).waitFor();
  assert.deepEqual(await agendaReadsSince(beforeEdit), { events: 2, todos: 2 }, "A CalDAV edit rereads both lists at their loaded depth");
  steps.push("CalDAV recovery with unchanged records makes zero list RPCs; a real edit reloads both open pages");

  const beforeOpening = requests.length;
  await page.locator(".agenda-other-todos summary").click();
  const otherTodos = page.getByRole("list", { name: "其他待办", exact: true });
  const moreOtherTodos = page.getByRole("button", { name: "更多其他待办", exact: true });
  await agendaReadsSince(beforeOpening);
  await eventually(() => moreOtherTodos.isEnabled(), true, "The unfiltered todo pages are settled");
  const depth = requests.slice(beforeOpening).filter(request => request.method === "plugin.assistant-agenda.todo.list" && !request.params?.dueOn).length;
  assert.ok(depth > 0);
  const rollingTodo = otherTodos.getByText(rollingTitle, { exact: true });
  assert.ok(!fixture.agenda.listTodos({}).records.some(record => record.title === rollingTitle));
  assert.equal(await rollingTodo.count(), 0);
  const beforeRollingUpdate = requests.length;
  fixture.setCalendarTime(Date.parse("1998-12-31T12:14:00Z"));
  unauthorized = true;
  const failed = await refresh();
  assert.equal(failed.status, "error");
  assert.equal(failed.errorCode, "credentials");
  assert.equal(failed.refreshedAt, edited.refreshedAt);
  assert.equal(fixture.agenda.listTodos({}).records.find(record => record.title === rollingTitle)?.dueAt, "2000-01-01T12:00:00.000Z");
  await eventually(() => rollingTodo.isVisible(), true, "The open other todo list shows the same new CalDAV occurrence as a direct query");
  assert.deepEqual(await agendaReadsSince(beforeRollingUpdate), { events: 0, todos: depth }, "Only the open unfiltered todo list responds to the failed refresh");
  assert.ok(requests.slice(beforeRollingUpdate).every(request => request.method !== "plugin.assistant-agenda.todo.list" || !request.params?.dueOn));
  await page.locator(".agenda-other-todos summary").click();
  await otherTodos.waitFor({ state: "hidden" });
  steps.push("a failed CalDAV refresh updates only the open unfiltered list when a recurring todo rolls into view");

  const publishLegacyAgenda = () => {
    const assistantAgenda = fixture.agenda.snapshot();
    delete assistantAgenda.recordsToken;
    delete assistantAgenda.unfilteredTodosToken;
    return page.evaluate(assistantAgenda => window.assistantDesktopSnapshot({ assistantAgenda }), assistantAgenda);
  };
  const beforeLegacy = requests.length;
  await publishLegacyAgenda();
  await agendaReadsSince(beforeLegacy);
  fixture.agenda.saveTodo({ value: { title: "旧版宿主同步的待办", status: "pending", dueAt: `${date}T12:00:00Z` } });
  const beforeLegacyUpdate = requests.length;
  await publishLegacyAgenda();
  assert.deepEqual(await agendaReadsSince(beforeLegacyUpdate), { events: 2, todos: 2 }, "A legacy snapshot invalidates loaded pages using changeToken alone");
  steps.push("a legacy agenda snapshot without a records token still reloads the open pages on a content change");

  await settingsButton.click();
  const source = page.getByRole("article", { name: "同步夹具" });
  await source.getByText("同步失败", { exact: true }).waitFor();
  await source.getByText("请检查或更换凭据。", { exact: true }).waitFor();
}
