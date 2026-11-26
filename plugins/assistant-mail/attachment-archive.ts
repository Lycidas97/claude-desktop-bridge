import { posix } from "node:path";
import { SaxesParser } from "saxes";
import { fromBufferPromise, type Entry, type ZipFile } from "yauzl";
import { ARTIFACT_MAX_BYTES } from "../../packages/protocol/src/types.js";
import { cleanMailText, MailAttachmentError } from "./mime.js";

const XML_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 4_096;
const unsupported = () => new MailAttachmentError("MAIL_ATTACHMENT_UNSUPPORTED", "无法读取该 ZIP 或 Office 文档。");
const tooLarge = () => new MailAttachmentError("MAIL_ATTACHMENT_TOO_LARGE", "归档条目超过大小或数量上限。");

/** Opens central directory entries only. Archive paths are never used as disk paths. */
export async function withAttachmentZip<T>(bytes: Buffer, use: (zip: ZipFile, entries: Map<string, Entry>) => Promise<T>): Promise<T> {
  const zip = await fromBufferPromise(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true }).catch(() => { throw unsupported(); });
  try {
    if (zip.entryCount > MAX_ENTRIES) throw tooLarge();
    const entries = new Map<string, Entry>();
    try {
      for await (const entry of zip.eachEntry()) {
        if (entries.has(entry.fileName)) throw unsupported();
        if (!entry.fileName.endsWith("/")) entries.set(entry.fileName, entry);
      }
    } catch (error) {
      if (error instanceof MailAttachmentError) throw error;
      throw unsupported();
    }
    return await use(zip, entries);
  } finally { zip.close(); }
}

async function entryBytes(zip: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) throw tooLarge();
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk);
    return Buffer.concat(chunks, entry.uncompressedSize);
  } catch { throw unsupported(); }
}

export async function archiveAttachmentMember(bytes: Buffer, name: string): Promise<Buffer> {
  return withAttachmentZip(bytes, async (zip, entries) => {
    const entry = entries.get(name);
    if (!entry) throw new MailAttachmentError("MAIL_ATTACHMENT_NOT_FOUND", "归档中没有该条目。");
    return entryBytes(zip, entry, ARTIFACT_MAX_BYTES);
  });
}

export type OfficeKind = "docx" | "pptx" | "xlsx";

export async function readOfficeSection(bytes: Buffer, kind: OfficeKind, section: number) {
  return withAttachmentZip(bytes, async (zip, entries) => {
    async function xml(path: string, read: (parser: SaxesParser) => void) {
      const entry = entries.get(path);
      if (!entry) throw unsupported();
      const parser = new SaxesParser();
      parser.on("doctype", () => { throw unsupported(); });
      parser.on("error", () => { throw unsupported(); });
      read(parser);
      parser.write((await entryBytes(zip, entry, XML_MAX_BYTES)).toString("utf8")).close();
    }

    let path = "word/document.xml";
    let label: string | undefined;
    let nextSection: number | undefined;
    if (kind !== "docx") {
      const base = kind === "xlsx" ? "xl" : "ppt";
      const stem = kind === "xlsx" ? "workbook" : "presentation";
      const parts: { id: string; label?: string }[] = [];
      await xml(`${base}/${stem}.xml`, parser => parser.on("opentag", tag => {
        if (tag.name.split(":").at(-1) !== (kind === "xlsx" ? "sheet" : "sldId")) return;
        const id = Object.entries(tag.attributes).find(([name]) => name.endsWith(":id"))?.[1];
        if (id) parts.push({ id, ...(tag.attributes.name !== undefined ? { label: cleanMailText(tag.attributes.name) } : {}) });
      }));
      const part = parts[section - 1];
      if (!part) throw new MailAttachmentError("MAIL_ATTACHMENT_NOT_FOUND", "没有该工作表或幻灯片。");
      label = part.label;
      if (parts.length > section) nextSection = section + 1;
      let target: string | undefined;
      await xml(`${base}/_rels/${stem}.xml.rels`, parser => parser.on("opentag", tag => {
        if (tag.name.split(":").at(-1) === "Relationship" && tag.attributes.Id === part.id && tag.attributes.TargetMode !== "External") {
          target = tag.attributes.Target;
        }
      }));
      if (!target) throw unsupported();
      path = posix.normalize(target.startsWith("/") ? target.slice(1) : `${base}/${target}`);
      if (!(kind === "xlsx" ? /^xl\/worksheets\/[^/]+\.xml$/u : /^ppt\/slides\/[^/]+\.xml$/u).test(path)) throw unsupported();
    } else if (section !== 1) {
      throw new MailAttachmentError("MAIL_ATTACHMENT_NOT_FOUND", "文档正文只有一个部分，请用 offset 续读。");
    }

    const shared: string[] = [];
    if (kind === "xlsx" && entries.has("xl/sharedStrings.xml")) {
      await xml("xl/sharedStrings.xml", parser => {
        let text = "";
        let inText = false;
        parser.on("opentag", tag => { if (tag.name.split(":").at(-1) === "t") inText = true; });
        parser.on("text", value => { if (inText) text += value; });
        parser.on("closetag", tag => {
          const name = tag.name.split(":").at(-1);
          if (name === "t") inText = false;
          if (name === "si") { shared.push(text); text = ""; }
        });
      });
    }
    let text = "";
    await xml(path, parser => {
      let collecting = false;
      let cell: { ref: string; type: string; value: string } | undefined;
      parser.on("opentag", tag => {
        const name = tag.name.split(":").at(-1);
        if (kind === "xlsx") {
          if (name === "c") cell = { ref: tag.attributes.r ?? "", type: tag.attributes.t ?? "", value: "" };
          if (name === "v" || name === "t") collecting = true;
        } else {
          if (name === "t") collecting = true;
          if (name === "tab") text += "\t";
          if (name === "br") text += "\n";
        }
      });
      parser.on("text", value => {
        if (collecting) {
          if (cell) cell.value += value;
          else if (kind !== "xlsx") text += value;
        }
      });
      parser.on("closetag", tag => {
        const name = tag.name.split(":").at(-1);
        if (name === "v" || name === "t") collecting = false;
        if (kind === "xlsx" && name === "c" && cell) {
          text += `${cell.ref}=${cell.type === "s" ? shared[Number(cell.value)] ?? "" : cell.value}\t`;
          cell = undefined;
          // A workbook can repeat the same shared string many times from small XML parts.
          if (text.length > XML_MAX_BYTES) throw tooLarge();
        }
        if (name === "row" || name === "p") text += "\n";
      });
    });
    return { text: cleanMailText(text), ...(label !== undefined ? { label } : {}), ...(nextSection !== undefined ? { nextSection } : {}) };
  });
}
