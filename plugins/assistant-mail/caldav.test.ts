import { describe, expect, it, vi } from "vitest";
import { type CalDavError, readCalDav } from "./caldav.js";

const url = "https://calendar.example.test/dav/work/";
const path = new URL(url).pathname;
const vevent = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:one\nSUMMARY:First & second\nEND:VEVENT\nEND:VCALENDAR";
const vtodo = "BEGIN:VCALENDAR\nBEGIN:VTODO\nUID:two\nEND:VTODO\nEND:VCALENDAR";
const calendarTimeZone = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//CalDAV//EN",
  "BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:STANDARD",
  "DTSTART:20261101T020000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500",
  "END:STANDARD", "END:VTIMEZONE", "END:VCALENDAR", "",
].join("\n");
const timezoneProperty = `<c:calendar-timezone><![CDATA[${calendarTimeZone}]]></c:calendar-timezone>`;
const href = (name: string) => url + name;
const propstat = (props: string, code = "200 OK") =>
  `<propstat><prop>${props}</prop><status>HTTP/1.1 ${code}</status></propstat>`;
const row = (address: string, body: string) => `<response><href>${address}</href>${body}</response>`;
const status = (line: string) => `<status>HTTP/1.1 ${line}</status>`;
const etag = (tag: string) => `<getetag>&quot;${tag}&quot;</getetag>`;
const token = (value: string) => `<sync-token>${value}</sync-token>`;
const ctag = (value: string) => `<cs:getctag>${value}</cs:getctag>`;
const member = (name: string, tag: string) => row(path + name, propstat(etag(tag)));
const item = (name: string, tag: string, data: string) =>
  row(path + name, propstat(`${etag(tag)}<c:calendar-data><![CDATA[${data}]]></c:calendar-data>`));
const collection = row(path, propstat("<resourcetype><collection/><c:calendar/></resourcetype>"));

function multi(body: string) {
  return new Response(`<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ` +
    `xmlns:cs="http://calendarserver.org/ns/">${body}</multistatus>`, { status: 207 });
}

function fixture(...replies: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const reply of replies) fetch.mockResolvedValueOnce(reply);
  const options = {
    url, user: "demo-user", credential: "test-secret", fetch,
    knownEtags: new Map<string, string>(), signal: new AbortController().signal,
  };
  return { fetch, options };
}

function metadata(properties: string) {
  return multi(row(path, propstat(properties)));
}

function expectDavError(code: CalDavError["code"]) {
  return expect.objectContaining({ name: "CalDavError", code, message: `CalDAV ${code} error` });
}

describe("readCalDav", () => {
  it("reconciles a full listing and fetches only changed ETags from the collection", async () => {
    const { fetch, options } = fixture(
      metadata(`${ctag("tag-1")}${token("urn:sync:1")}${timezoneProperty}`),
      multi(collection + member("same.ics", "same") + member("%6Fevent.ics", "event-1") +
        member("todo%20name.ics", "todo-1") + row(path + "attachments/", propstat("<resourcetype><collection/></resourcetype>"))),
      multi(item("oevent.ics", "event-1", vevent) + item("todo%20name.ics", "todo-1", vtodo)),
    );
    options.knownEtags.set(href("same.ics"), '"same"').set(href("gone.ics"), '"gone"');

    await expect(readCalDav(options)).resolves.toEqual({
      ctag: "tag-1", syncToken: "urn:sync:1", calendarTimeZone, removed: [href("gone.ics")],
      changed: [
        { href: href("oevent.ics"), etag: '"event-1"', data: vevent },
        { href: href("todo%20name.ics"), etag: '"todo-1"', data: vtodo },
      ],
    });
    expect(fetch.mock.calls.map(([address, request]) => [address, request?.method, new Headers(request?.headers).get("Depth")]))
      .toEqual([[url, "PROPFIND", "0"], [url, "PROPFIND", "1"], [url, "REPORT", null]]);
    for (const [, request] of fetch.mock.calls) {
      expect(request).toMatchObject({ redirect: "manual", signal: options.signal });
      expect(new Headers(request?.headers).get("Authorization"))
        .toBe(`Basic ${Buffer.from("demo-user:test-secret").toString("base64")}`);
    }
    expect(fetch.mock.calls[2]?.[1]?.body).toContain(`<d:href>${path}oevent.ics</d:href><d:href>${path}todo%20name.ics</d:href>`);
    expect(fetch.mock.calls[2]?.[1]?.body).not.toContain("same.ics");
  });

  it("requests and returns the raw collection timezone even when the cursors match", async () => {
    const { fetch, options } = fixture(multi(row(path,
      propstat(`${ctag("same")}${token("urn:sync:1")}`) + propstat(timezoneProperty))));

    const result = await readCalDav({ ...options, ctag: "same", syncToken: "urn:sync:1" });
    expect.soft(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({
      method: "PROPFIND",
      headers: expect.objectContaining({ Depth: "0" }),
      body: '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" ' +
        'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><cs:getctag/><d:sync-token/>' +
        '<c:calendar-timezone/><c:supported-calendar-component-set/><d:current-user-privilege-set/></d:prop></d:propfind>',
    }));
    expect(result).toEqual({ ctag: "same", syncToken: "urn:sync:1", calendarTimeZone, removed: [], changed: [] });
  });

  it("keeps readable collections synced when write capability metadata is forbidden", async () => {
    const { fetch, options } = fixture(multi(row(path, propstat(token("urn:sync:1")) +
      propstat("<current-user-privilege-set/><c:supported-calendar-component-set/>", "403 Forbidden"))));
    await expect(readCalDav({ ...options, syncToken: "urn:sync:1" })).resolves.toEqual({
      syncToken: "urn:sync:1", proposalCreateKinds: [], removed: [], changed: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses ctag alone when sync-token and calendar-timezone are unsupported", async () => {
    const { fetch, options } = fixture(multi(row(path,
      propstat(ctag("same")) + propstat("<sync-token/><c:calendar-timezone/>", "404 Not Found"))));
    await expect(readCalDav({ ...options, ctag: "same" })).resolves.toEqual({ ctag: "same", removed: [], changed: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the REPORT token and handles resource-level 404 and 410 deletions", async () => {
    const { fetch, options } = fixture(
      metadata(`${ctag("same")}${token("urn:sync:2")}`),
      multi(row(href("update.ics"), propstat(etag("next")) + propstat("<resourcetype/>", "404 Not Found")) +
        row(path + "gone.ics", status("404 Not Found")) + row(path + "retired.ics", status("410 Gone")) +
        token("urn:sync:3")),
      multi(item("update.ics", "next", vevent)),
    );
    options.knownEtags.set(href("gone.ics"), '"old"').set(href("retired.ics"), '"old"');

    await expect(readCalDav({ ...options, ctag: "same", syncToken: "urn:sync:1?a&b" })).resolves.toEqual({
      ctag: "same", syncToken: "urn:sync:3", removed: [href("gone.ics"), href("retired.ics")],
      changed: [{ href: href("update.ics"), etag: '"next"', data: vevent }],
    });
    const report = fetch.mock.calls[1]?.[1];
    expect(report?.method).toBe("REPORT");
    expect(new Headers(report?.headers).get("Depth")).toBe("0");
    expect(report?.body).toContain(`<d:sync-token>urn:sync:1?a&amp;b</d:sync-token><d:sync-level>1</d:sync-level>`);
  });

  it("reconciles from the earlier metadata token when the previous token expires", async () => {
    const { fetch, options } = fixture(
      metadata(token("urn:sync:10")),
      new Response('<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>', { status: 403 }),
      multi(collection + member("changed.ics", "listed") + member("same.ics", "same")),
      multi(item("changed.ics", "fetched", vtodo)),
    );
    options.knownEtags.set(href("gone.ics"), '"gone"').set(href("same.ics"), '"same"');

    await expect(readCalDav({ ...options, syncToken: "urn:sync:old" })).resolves.toEqual({
      syncToken: "urn:sync:10", removed: [href("gone.ics")],
      changed: [{ href: href("changed.ics"), etag: '"fetched"', data: vtodo }],
    });
    expect(fetch.mock.calls.map(([, request]) => request?.method)).toEqual(["PROPFIND", "REPORT", "PROPFIND", "REPORT"]);
  });

  it("collects all truncated REPORT pages before fetching the final member set", async () => {
    const { fetch, options } = fixture(
      metadata(token("urn:sync:3")),
      multi(member("vanishes.ics", "new") + row(path, status("507 Insufficient Storage")) + token("urn:sync:2")),
      multi(row(path + "vanishes.ics", status("404 Not Found")) + member("survives.ics", "next") + token("urn:sync:3")),
      multi(item("survives.ics", "next", vtodo)),
    );
    options.knownEtags.set(href("vanishes.ics"), '"old"');

    await expect(readCalDav({ ...options, syncToken: "urn:sync:1" })).resolves.toEqual({
      syncToken: "urn:sync:3", removed: [href("vanishes.ics")],
      changed: [{ href: href("survives.ics"), etag: '"next"', data: vtodo }],
    });
    expect(fetch.mock.calls[2]?.[1]?.body).toContain("<d:sync-token>urn:sync:2</d:sync-token>");
    expect(fetch.mock.calls[3]?.[1]?.body).toContain("survives.ics");
    expect(fetch.mock.calls[3]?.[1]?.body).not.toContain("vanishes.ics");
  });

  it.each([
    ["an omitted member", () => ""],
    ["a failed member status", () => row(path + "failed.ics", status("404 Not Found"))],
    ["an unavailable calendar-data property", () => row(path + "failed.ics",
      propstat(etag("failed")) + propstat("<c:calendar-data/>", "404 Not Found"))],
    ["a foreign calendar-data namespace", () => row(path + "failed.ics",
      propstat(`${etag("failed")}<calendar-data>${vtodo}</calendar-data>`))],
  ])("rejects the entire multiget batch with %s", async (_name, failure) => {
    const { options } = fixture(
      metadata(token("urn:sync:2")),
      multi(member("found.ics", "ok") + member("failed.ics", "failed") + row(path + "gone.ics", status("404 Not Found")) +
        token("urn:sync:2")),
      multi(item("found.ics", "ok", vevent) + failure()),
    );
    options.knownEtags.set(href("gone.ics"), '"old"').set(href("failed.ics"), '"old"');

    await expect(readCalDav({ ...options, syncToken: "urn:sync:1" })).rejects.toEqual(expectDavError("response"));
    expect([...options.knownEtags]).toEqual([[href("gone.ics"), '"old"'], [href("failed.ics"), '"old"']]);
  });

  it("does not treat a missing ETag propstat as a deletion", async () => {
    const { fetch, options } = fixture(
      metadata(token("urn:sync:2")),
      multi(row(path + "kept.ics", propstat("<getetag/>", "404 Not Found")) + token("urn:sync:2")),
    );
    options.knownEtags.set(href("kept.ics"), '"old"');
    await expect(readCalDav({ ...options, syncToken: "urn:sync:1" })).rejects.toEqual(expectDavError("response"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["", row(path, propstat("<getetag/><resourcetype/>", "404 Not Found"))])(
    "fails a listing without a successful collection row instead of inferring deletions",
    async (collectionRow) => {
      const { options } = fixture(metadata(ctag("current")), multi(collectionRow + member("valid.ics", "valid")));
      options.knownEtags.set(href("existing.ics"), '"old"');
      await expect(readCalDav(options)).rejects.toEqual(expectDavError("response"));
    },
  );

  it("reconciles an empty collection when neither cursor property is available", async () => {
    const { options } = fixture(
      multi(row(path, propstat("<cs:getctag/><sync-token/>", "404 Not Found"))),
      multi(collection),
    );
    options.knownEtags.set(href("existing.ics"), '"old"');
    await expect(readCalDav(options)).resolves.toEqual({ removed: [href("existing.ics")], changed: [] });
  });

  it.each([
    "https://other.example.test/dav/work/item.ics",
    "https://someone@calendar.example.test/dav/work/item.ics",
    "http://calendar.example.test/dav/work/item.ics",
    "/dav/worker/item.ics",
    "/dav/work/%2e%2e/item.ics",
    "/dav/work/%2e%2e%2fitem.ics",
    "/dav/work/item.ics?query",
    "/dav/work/item.ics#fragment",
  ])("rejects out-of-scope or credential-bearing href %s before multiget", async (address) => {
    const { fetch, options } = fixture(metadata(ctag("current")), multi(collection + row(address, propstat(etag("x")))));
    await expect(readCalDav(options)).rejects.toEqual(expectDavError("response"));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([requestUrl]) => requestUrl === url)).toBe(true);
  });

  it.each([href("other/"), "https://other.example.test/"])("rejects a redirect to %s", async (location) => {
    const { fetch, options } = fixture(new Response("server-details", { status: 301, headers: { Location: location } }));
    await expect(readCalDav(options)).rejects.toEqual(expectDavError("response"));
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ redirect: "manual" }));
  });

  it.each([401, 403])("classifies HTTP %s without exposing credentials or server diagnostics", async (code) => {
    const { options } = fixture(new Response("server-details test-secret", { status: code }));
    await expect(readCalDav(options)).rejects.toEqual(expectDavError("credentials"));
  });

  it("does not mistake a forbidden REPORT for an invalid token", async () => {
    const { fetch, options } = fixture(
      metadata(token("urn:sync:2")),
      new Response('<error xmlns="DAV:"><need-privileges/></error>', { status: 403 }),
    );
    await expect(readCalDav({ ...options, syncToken: "urn:sync:1" })).rejects.toEqual(expectDavError("credentials"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    '<multistatus xmlns="DAV:"><response><href>server-details',
    '<!DOCTYPE multistatus SYSTEM "https://other.example.test/"><multistatus xmlns="DAV:"/>',
    '<multistatus xmlns="urn:not-dav"/>',
  ])("rejects malformed or unexpected XML without using it in the error", async (body) => {
    const { options } = fixture(new Response(body, { status: 207 }));
    await expect(readCalDav(options)).rejects.toEqual(expectDavError("response"));
  });

  it("classifies rejected fetch and cancellation without retaining underlying error text", async () => {
    const { fetch, options } = fixture();
    fetch.mockRejectedValueOnce(new Error("server-details test-secret"));
    await expect(readCalDav(options)).rejects.toEqual(expectDavError("connection"));
    const signal = AbortSignal.abort(new Error("server-details test-secret"));
    await expect(readCalDav({ ...options, signal })).rejects.toEqual(expectDavError("connection"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
