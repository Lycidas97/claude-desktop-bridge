import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { ImapFlow } from "imapflow";
import { expect, it } from "vitest";
import { fileSentCopy } from "./sent-copy.js";

const path = "Correo/Enviados";
const id = "<attempt@example.test>";
const source = Buffer.from(`Message-ID: ${id}\r\nSubject: Archive fixture\r\n\r\n.One line\r\n`);

it.each([
  ["new copy", [path], "empty", "OK", "filed"],
  ["provider copy visible", [path], "existing", "OK", "already_present"],
  ["name-only guess", [], "empty", "OK", "folder_unavailable"],
  ["ambiguous special use", [path, "Other"], "empty", "OK", "folder_unavailable"],
  ["Inbox mislabeled", ["INBOX"], "empty", "OK", "folder_unavailable"],
  ["search rejected", [path], "NO", "OK", "unconfirmed"],
  ["append rejected", [path], "empty", "NO", "unconfirmed"],
  ["append disconnected", [path], "empty", "close", "unconfirmed"],
] as const)("handles IMAP %s", async (_label, sent, search, append, expected) => {
  const commands: string[] = [];
  const messages: Buffer[] = [];
  const server = createServer(socket => {
    let buffered = Buffer.alloc(0);
    let literal: { tag: string; length: number } | undefined;
    socket.write("* PREAUTH synthetic account\r\n");
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (literal) {
          if (buffered.length < literal.length + 2) return;
          messages.push(buffered.subarray(0, literal.length));
          buffered = buffered.subarray(literal.length + 2);
          if (append === "close") socket.destroy();
          else socket.write(`${literal.tag} ${append} append result\r\n`);
          literal = undefined;
        }
        const end = buffered.indexOf("\r\n");
        if (end < 0) return;
        const line = buffered.subarray(0, end).toString("utf8");
        buffered = buffered.subarray(end + 2);
        const [tag, command] = line.split(" ");
        commands.push(line.slice(tag!.length + 1));
        const ok = `${tag} OK done\r\n`;
        switch (command) {
          case "CAPABILITY": socket.write(`* CAPABILITY IMAP4rev1 SPECIAL-USE\r\n${ok}`); break;
          case "LIST":
            socket.write(["INBOX", "Sent", path, "Other"].map(folder =>
              `* LIST (${sent.some(name => name === folder) ? "\\sEnT" : ""}) "/" "${folder}"\r\n`).join("") + ok);
            break;
          case "EXAMINE": socket.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n${tag} OK [READ-ONLY] examined\r\n`); break;
          case "UID": socket.write(search === "NO" ? `${tag} NO search refused\r\n` : `* SEARCH${search === "existing" ? " 1" : ""}\r\n${ok}`); break;
          case "APPEND":
            literal = { tag: tag!, length: Number(/\{(\d+)\}$/u.exec(line)![1]) };
            socket.write("+ ready for literal\r\n");
            break;
          default: socket.write(`${tag} BAD unexpected command\r\n`);
        }
      }
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new ImapFlow({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, secure: false, doSTARTTLS: false,
    auth: { user: "fixture", pass: "synthetic" }, logger: false, disableAutoIdle: true });
  try {
    await expect(fileSentCopy(client, id, source)).resolves.toBe(expected);
    expect(commands.some(command => command.startsWith("SELECT "))).toBe(false);
    if (expected === "folder_unavailable") expect(commands.some(command => /^(EXAMINE|UID|APPEND) /u.test(command))).toBe(false);
    else {
      expect(commands.filter(command => command.startsWith("EXAMINE "))).toEqual([expect.stringContaining(path)]);
      expect(commands.filter(command => /^UID SEARCH HEADER MESSAGE-ID /iu.test(command))).toEqual([expect.stringContaining(id)]);
    }
    const shouldAppend = expected !== "folder_unavailable" && search === "empty";
    expect(commands.filter(command => command.startsWith("APPEND "))).toEqual(shouldAppend ? [expect.stringContaining(path)] : []);
    expect(messages).toEqual(shouldAppend ? [source] : []);
  } finally {
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
