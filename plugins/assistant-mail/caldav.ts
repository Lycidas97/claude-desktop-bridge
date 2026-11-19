import { SaxesParser } from "saxes";

const dav = "DAV:";
const caldav = "urn:ietf:params:xml:ns:caldav";
const calendarserver = "http://calendarserver.org/ns/";

type ErrorCode = "credentials" | "connection" | "response";

export class CalDavError extends Error {
  constructor(readonly code: ErrorCode) {
    super(`CalDAV ${code} error`);
    this.name = "CalDavError";
  }
}

type XmlElement = { uri: string; local: string; text: string; children: XmlElement[]; componentName?: string };
type DavRow = { href: string; status: number | undefined; props: XmlElement[]; writeMetadataForbidden: boolean };

function invalidResponse(): never {
  throw new CalDavError("response");
}

function parseXml(xml: string): XmlElement | undefined {
  const document: XmlElement[] = [];
  const stack: XmlElement[] = [];
  let invalid = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", () => { invalid = true; });
  parser.on("doctype", () => { invalid = true; });
  parser.on("opentag", ({ uri, local, attributes }) => {
    const componentName = uri === caldav && local === "comp" ? attributes.name?.value : undefined;
    const element: XmlElement = { uri, local, text: "", children: [], ...(componentName ? { componentName } : {}) };
    (stack.at(-1)?.children ?? document).push(element);
    stack.push(element);
  });
  parser.on("closetag", () => { stack.pop(); });
  const append = (text: string) => {
    const element = stack.at(-1);
    if (element) element.text += text;
  };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.write(xml).close();
  return invalid ? undefined : document[0];
}

function property(elements: XmlElement[], local: string, uri = dav): XmlElement | undefined {
  const matches = elements.filter((element) => element.uri === uri && element.local === local);
  if (matches.length > 1) invalidResponse();
  return matches[0];
}

function text(element: XmlElement | undefined): string | undefined {
  if (element?.children.length) invalidResponse();
  return element?.text;
}

function statusCode(element: XmlElement | undefined): number {
  const status = /^HTTP\/\d+(?:\.\d+)?[ \t]+([1-5]\d\d)(?:[ \t]+.*)?$/u.exec(text(element)?.trim() ?? "");
  return status ? Number(status[1]) : invalidResponse();
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function canonicalPath(pathname: string): string {
  return pathname.replace(/%[\da-f]{2}/giu, (encoded) => {
    const char = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
    return /^[\w.~\-]$/u.test(char) ? char : encoded.toUpperCase();
  });
}

async function readXml(response: Response): Promise<XmlElement | undefined> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new CalDavError("connection");
  }
  return parseXml(body);
}

export type CalDavWrite = { href: string } & (
  | { method: "PUT"; body: string; etag?: string }
  | { method: "DELETE"; etag: string }
);

type MemberRequest = CalDavWrite | { method: "GET"; href: string };

export async function requestCalDavMember(options: { url: string; user: string; credential: string; request: MemberRequest }, fetchDav = fetch) {
  const { request } = options;
  const collection = new URL(options.url);
  const target = new URL(request.href);
  const prefix = canonicalPath(collection.pathname);
  const path = canonicalPath(target.pathname);
  if (collection.protocol !== "https:" || target.origin !== collection.origin || target.username || target.password ||
    /[?#]/u.test(target.href) || !prefix.endsWith("/") || !path.startsWith(prefix) || path === prefix || /%(?:2F|5C)/u.test(path.slice(prefix.length))) {
    throw new CalDavError("response");
  }
  const headers: Record<string, string> = { Authorization: `Basic ${Buffer.from(`${options.user}:${options.credential}`).toString("base64")}` };
  if (request.method !== "GET") {
    if (request.etag !== undefined) headers["If-Match"] = request.etag;
    else headers["If-None-Match"] = "*";
  }
  if (request.method === "PUT") headers["Content-Type"] = "text/calendar; charset=utf-8";
  try {
    const response = await fetchDav(target, {
      method: request.method, headers, signal: AbortSignal.timeout(15_000), redirect: "manual",
      ...(request.method === "PUT" ? { body: request.body } : {}),
    });
    if (request.method === "GET" && response.ok) return { status: response.status, body: await response.text() };
    await response.body?.cancel();
    return { status: response.status };
  } catch (cause) {
    if (cause instanceof TypeError || cause instanceof DOMException) throw new CalDavError("connection");
    throw cause;
  }
}

export async function readCalDav(options: {
  url: string;
  user: string;
  credential: string;
  ctag?: string;
  syncToken?: string;
  knownEtags: ReadonlyMap<string, string>;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<{
  ctag?: string;
  syncToken?: string;
  calendarTimeZone?: string;
  proposalCreateKinds?: ("todo" | "calendar")[];
  removed: string[];
  changed: Array<{ href: string; etag: string; data: string }>;
}> {
  const { knownEtags, signal } = options;
  const fetchDav = options.fetch ?? fetch;
  const collection = new URL(options.url);
  const memberBase = new URL(collection);
  if (!memberBase.pathname.endsWith("/")) memberBase.pathname += "/";
  const memberPrefix = canonicalPath(memberBase.pathname);
  const collectionHref = collection.origin + memberPrefix;
  const headers = {
    Authorization: `Basic ${Buffer.from(`${options.user}:${options.credential}`).toString("base64")}`,
    "Content-Type": "application/xml; charset=utf-8",
  };

  // All authenticated requests target the configured collection. Hrefs are only used inside multiget XML.
  async function request(method: "PROPFIND" | "REPORT", body: string, depth?: "0" | "1", sync = false) {
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await fetchDav(collection.href, {
        method, body, signal, redirect: "manual",
        headers: depth === undefined ? headers : { ...headers, Depth: depth },
      });
    } catch {
      throw new CalDavError("connection");
    }
    if (!response.redirected && response.status === 207) {
      const root = await readXml(response);
      return root?.uri === dav && root.local === "multistatus" ? root : invalidResponse();
    }
    if (!response.redirected && sync && (response.status === 403 || response.status === 409)) {
      const root = await readXml(response);
      if (root?.uri === dav && root.local === "error" && property(root.children, "valid-sync-token")) {
        return undefined;
      }
    } else if (response.body) {
      await response.body.cancel().catch(() => { throw new CalDavError("connection"); });
    }
    throw new CalDavError(response.status === 401 || response.status === 403 ? "credentials" : "response");
  }

  function rows(root: XmlElement, readingCollectionMetadata = false): Map<string, DavRow> {
    const result = new Map<string, DavRow>();
    for (const row of root.children) {
      if (row.uri !== dav || row.local !== "response") continue;
      const rawHref = text(property(row.children, "href"))?.trim();
      const url = rawHref && URL.parse(rawHref, memberBase);
      if (!url || url.origin !== collection.origin || url.username || url.password || /[?#]/u.test(url.href)) {
        invalidResponse();
      }
      const path = canonicalPath(url.pathname);
      const isCollection = path === memberPrefix || path === memberPrefix.slice(0, -1);
      if (!isCollection && (!path.startsWith(memberPrefix) || /%(?:2F|5C)/u.test(path.slice(memberPrefix.length)))) {
        invalidResponse();
      }
      const href = isCollection ? collectionHref : url.origin + path;
      if (result.has(href)) invalidResponse();

      const statusElement = property(row.children, "status");
      const propstats = row.children.filter(({ uri, local }) => uri === dav && local === "propstat");
      if (Boolean(statusElement) === Boolean(propstats.length)) invalidResponse();
      const status = statusElement ? statusCode(statusElement) : undefined;
      const props: XmlElement[] = [];
      let writeMetadataForbidden = false;
      for (const propstat of propstats) {
        const code = statusCode(property(propstat.children, "status"));
        const prop = property(propstat.children, "prop") ?? invalidResponse();
        if (code >= 200 && code < 300) props.push(...prop.children);
        else if (code === 403 && readingCollectionMetadata && isCollection && prop.children.length && prop.children.every(({ local, uri }) =>
          (local === "current-user-privilege-set" && uri === dav) || (local === "supported-calendar-component-set" && uri === caldav))) {
          writeMetadataForbidden = true;
        } else if (code !== 404) invalidResponse();
      }
      result.set(href, { href, status, props, writeMetadataForbidden });
    }
    return result;
  }

  const metadata = rows(await request("PROPFIND",
    `<d:propfind xmlns:d="${dav}" xmlns:cs="${calendarserver}" xmlns:c="${caldav}">` +
    `<d:prop><cs:getctag/><d:sync-token/><c:calendar-timezone/><c:supported-calendar-component-set/>` +
    `<d:current-user-privilege-set/></d:prop></d:propfind>`,
    "0") ?? invalidResponse(), true);
  const own = metadata.get(collectionHref);
  if (metadata.size !== 1 || !own || own.status !== undefined) invalidResponse();
  const ctag = text(property(own.props, "getctag", calendarserver))?.trim() || undefined;
  const observedToken = text(property(own.props, "sync-token"))?.trim() || undefined;
  const calendarTimeZone = text(property(own.props, "calendar-timezone", caldav));
  const components = property(own.props, "supported-calendar-component-set", caldav);
  const privileges = property(own.props, "current-user-privilege-set");
  const canCreate = !own.writeMetadataForbidden && (!privileges || privileges.children.some(privilege => privilege.uri === dav && privilege.local === "privilege"
    && privilege.children.some(child => child.uri === dav && ["all", "write", "bind"].includes(child.local))));
  const proposalCreateKinds = !canCreate ? [] : (["todo", "calendar"] as const).filter(kind =>
    !components || components.children.some(child => child.componentName === (kind === "todo" ? "VTODO" : "VEVENT")));
  const collectionMetadata = {
    ...(ctag === undefined ? {} : { ctag }),
    ...(calendarTimeZone?.trim() ? { calendarTimeZone } : {}),
    ...(components || privileges || own.writeMetadataForbidden ? { proposalCreateKinds } : {}),
  };
  if ((observedToken && observedToken === options.syncToken)
    || (!options.syncToken && !observedToken && ctag && ctag === options.ctag)) {
    return {
      ...collectionMetadata,
      ...(observedToken === undefined ? {} : { syncToken: observedToken }),
      removed: [], changed: [],
    };
  }

  const members = new Map<string, string | null>();
  function collectMember({ href, status, props }: DavRow, incremental: boolean) {
    if (incremental && (status === 404 || status === 410)) {
      members.set(href, null);
      return;
    }
    if (status !== undefined) invalidResponse();
    const resourceType = property(props, "resourcetype");
    if (resourceType && property(resourceType.children, "collection")) return;
    const etag = text(property(props, "getetag"))?.trim() || invalidResponse();
    members.set(href, etag);
  }

  let nextToken: string | undefined;
  if (options.syncToken) {
    const seenTokens = new Set([options.syncToken]);
    let token = options.syncToken;
    for (;;) {
      const page = await request("REPORT",
        `<d:sync-collection xmlns:d="${dav}"><d:sync-token>${escapeXml(token)}</d:sync-token>` +
        `<d:sync-level>1</d:sync-level><d:prop><d:getetag/><d:resourcetype/></d:prop></d:sync-collection>`, "0", true);
      if (!page) break;
      const pageToken = text(property(page.children, "sync-token"))?.trim() || invalidResponse();
      const pageRows = rows(page);
      const collectionRow = pageRows.get(collectionHref);
      if (collectionRow && collectionRow.status !== 507) invalidResponse();
      pageRows.delete(collectionHref);
      for (const row of pageRows.values()) collectMember(row, true);
      if (!collectionRow) {
        nextToken = pageToken;
        break;
      }
      // RFC 6578 uses a collection-level 507 and a continuing token for a truncated report.
      if (seenTokens.has(pageToken)) invalidResponse();
      seenTokens.add(pageToken);
      token = pageToken;
    }
  }

  if (!nextToken) {
    members.clear();
    const listing = rows(await request("PROPFIND",
      `<d:propfind xmlns:d="${dav}"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>`,
      "1") ?? invalidResponse());
    const rootRow = listing.get(collectionHref);
    if (!rootRow || rootRow.status !== undefined || !rootRow.props.length) invalidResponse();
    listing.delete(collectionHref);
    for (const row of listing.values()) collectMember(row, false);
    for (const href of knownEtags.keys()) if (!members.has(href)) members.set(href, null);
    // The metadata token predates the listing, so changes during reconciliation will be replayed.
    nextToken = observedToken;
  }

  const removed: string[] = [];
  const requested = new Set<string>();
  for (const [href, etag] of members) {
    if (etag === null) {
      removed.push(href);
    } else if (knownEtags.get(href) !== etag) {
      requested.add(href);
    }
  }
  const changed: Array<{ href: string; etag: string; data: string }> = [];
  if (requested.size) {
    const payload = [...requested].map((href) => `<d:href>${escapeXml(new URL(href).pathname)}</d:href>`).join("");
    const reply = rows(await request("REPORT",
      `<c:calendar-multiget xmlns:c="${caldav}" xmlns:d="${dav}"><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      `${payload}</c:calendar-multiget>`) ?? invalidResponse());
    for (const { href, status, props } of reply.values()) {
      if (status !== undefined || !requested.delete(href)) invalidResponse();
      const etag = text(property(props, "getetag"))?.trim() || invalidResponse();
      const data = text(property(props, "calendar-data", caldav));
      if (!data?.trim()) invalidResponse();
      changed.push({ href, etag, data });
    }
    if (requested.size) invalidResponse();
  }
  return {
    ...collectionMetadata,
    ...(nextToken === undefined ? {} : { syncToken: nextToken }),
    removed, changed,
  };
}
