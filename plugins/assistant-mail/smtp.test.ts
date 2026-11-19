import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import { expect, it } from "vitest";
import { submitSmtp } from "./smtp.js";

const message = {
  from: "bridge@example.com", to: ["first@example.net", "second@example.net"], cc: ["copy@example.org"],
  replyTo: "inbox@example.com", subject: "周一议程", bodyText: "你好，\n.第一项\n第二项\n",
  inReplyTo: "<original@example.net>", references: ["<thread@example.net>", "<original@example.net>"],
};
const messageId = "<attempt@example.com>";

it.each([
  ["220 capture ESMTP", "250 accepted", false, "applied", undefined],
  ["220 capture ESMTP", "250 accepted", true, "delivery_partial", undefined],
  ["220 capture ESMTP", "550 rejected", false, "failed", 550],
  ["220 capture ESMTP", "354 not a final reply", false, "delivery_uncertain", 354],
  ["220 capture ESMTP", null, false, "delivery_uncertain", undefined],
  ["554 service unavailable", null, false, "failed", 554],
] as const)("records SMTP greeting %s and final reply %s (partial: %s)", async (greeting, response, partial, state, responseCode) => {
  const recipients: string[] = [];
  const messages: string[] = [];
  const server = createServer(socket => {
    let buffered = "";
    let data: string[] | undefined;
    socket.setEncoding("utf8");
    socket.write(`${greeting}\r\n`);
    socket.on("data", chunk => {
      buffered += chunk;
      let offset: number;
      while ((offset = buffered.indexOf("\r\n")) >= 0) {
        const line = buffered.slice(0, offset);
        buffered = buffered.slice(offset + 2);
        if (data) {
          if (line !== ".") { data.push(line.replace(/^\.\./u, ".")); continue; }
          messages.push(data.join("\r\n"));
          data = undefined;
          if (response) socket.write(`${response}\r\n`);
          else socket.destroy();
        } else if (line.startsWith("EHLO ")) socket.write("250-capture\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH PLAIN ")) socket.write("235 authenticated\r\n");
        else if (line === `MAIL FROM:<${message.from}>`) socket.write("250 sender accepted\r\n");
        else if (line.startsWith("RCPT TO:<")) {
          const address = line.slice(9, -1);
          recipients.push(address);
          socket.write(partial && address === message.cc[0] ? "550 recipient rejected\r\n" : "250 recipient accepted\r\n");
        } else if (line === "DATA") {
          data = [];
          socket.write("354 send data\r\n");
        } else socket.write("500 unexpected command\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const result = await submitSmtp({ host: "127.0.0.1", port: (server.address() as AddressInfo).port,
      security: "starttls", user: "fixture", from: message.from }, "fixture-password", message, messageId, options => {
      expect(options).toMatchObject({ requireTLS: true, secure: false, auth: { user: "fixture" } });
      // Exercise SMTP and the exact MIME/envelope over an isolated cleartext capture, not TLS trust.
      return createTransport({ ...options, requireTLS: false });
    });
    expect(result).toMatchObject(state === "delivery_partial" ? { state, accepted: message.to, rejected: message.cc }
      : { state, ...(responseCode !== undefined ? { responseCode } : {}) });
    if (responseCode === 554) {
      expect(recipients).toEqual([]);
      expect(messages).toEqual([]);
      return;
    }
    expect(recipients).toEqual([...message.to, ...message.cc]);
    expect(messages).toHaveLength(1);
    const captured = await simpleParser(messages[0]!);
    expect(captured).toMatchObject({ subject: message.subject, messageId, inReplyTo: message.inReplyTo, references: message.references });
    expect(captured.from?.value.map(({ address }) => address)).toEqual([message.from]);
    expect(captured.to).toMatchObject({ value: message.to.map(address => ({ address })) });
    expect(captured.cc).toMatchObject({ value: message.cc.map(address => ({ address })) });
    expect(captured.replyTo?.value.map(({ address }) => address)).toEqual([message.replyTo]);
    expect(captured.text?.replaceAll("\r\n", "\n")).toBe(message.bodyText);
    expect(captured.bcc).toBeUndefined();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
