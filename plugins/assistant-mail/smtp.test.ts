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
  ["acceptance", "220 capture ESMTP", "250 accepted", false, "applied", undefined, undefined],
  ["partial acceptance", "220 capture ESMTP", "250 accepted", true, "delivery_partial", undefined, undefined],
  ["message refusal", "220 capture ESMTP", "550 rejected", false, "failed", 550, "rejected"],
  ["nonfinal reply after DATA", "220 capture ESMTP", "354 not a final reply", false, "delivery_uncertain", 354, "unconfirmed"],
  ["disconnect after DATA", "220 capture ESMTP", null, false, "delivery_uncertain", undefined, "unconfirmed"],
  ["greeting refusal", "554 service unavailable", null, false, "failed", 554, "connection"],
  ["disconnect before greeting", null, null, false, "failed", undefined, "connection"],
  ["non-SMTP greeting", "* OK IMAP ready", null, false, "failed", undefined, "connection"],
  ["authentication refusal", "220 capture ESMTP", null, false, "failed", 535, "auth", "auth"],
  ["STARTTLS refusal", "220 capture ESMTP", null, false, "failed", 454, "tls", "starttls"],
  ["STARTTLS handshake timeout", "220 capture ESMTP", null, false, "failed", undefined, "tls", "starttls-timeout"],
  ["disconnect at MAIL FROM", "220 capture ESMTP", null, false, "failed", undefined, "connection", "MAIL FROM"],
  ["disconnect before DATA permission", "220 capture ESMTP", null, false, "failed", undefined, "connection", "DATA"],
  ["implicit TLS against a cleartext port", "220 capture ESMTP", null, false, "failed", undefined, "tls", "tls"],
] as const)("records SMTP %s", async (_label, greeting, response, partial, state, responseCode, reason, setup?) => {
  const recipients: string[] = [];
  const messages: string[] = [];
  let stoppedAt: "MAIL FROM" | "DATA" | "STARTTLS" | undefined;
  const server = createServer(socket => {
    let buffered = "";
    let data: string[] | undefined;
    socket.setEncoding("utf8");
    if (greeting === null) { socket.end(); return; }
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
        } else if ((setup === "MAIL FROM" && line === `MAIL FROM:<${message.from}>`) || (setup === "DATA" && line === "DATA")) {
          stoppedAt = setup;
          socket.destroy();
          return;
        } else if (line.startsWith("EHLO ")) {
          socket.write(setup?.startsWith("starttls") ? "250-capture\r\n250 STARTTLS\r\n" : "250-capture\r\n250 AUTH PLAIN\r\n");
        } else if (line === "STARTTLS") {
          if (setup === "starttls-timeout") {
            stoppedAt = "STARTTLS";
            socket.removeAllListeners("data");
            socket.write("220 ready for TLS\r\n");
            return;
          }
          socket.write("454 TLS unavailable\r\n");
        } else if (line.startsWith("AUTH PLAIN ")) socket.write(setup === "auth" ? "535 refused\r\n" : "235 authenticated\r\n");
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
      security: setup === "tls" ? "tls" : "starttls", user: "fixture", from: message.from }, "fixture-password", message, messageId, options => {
      expect(options).toMatchObject({ requireTLS: setup !== "tls", secure: setup === "tls", auth: { user: "fixture" } });
      // Keep TLS enabled for handshake tests; the other cases exercise SMTP on a cleartext capture.
      if (setup === "starttls-timeout") return createTransport({ ...options, greetingTimeout: 1_000 });
      return createTransport(setup === "tls" || setup === "starttls" ? options : { ...options, requireTLS: false });
    });
    expect(result).toEqual(state === "delivery_partial" ? { state, accepted: message.to, rejected: message.cc }
      : state === "applied" ? { state, accepted: [...message.to, ...message.cc], rejected: [] }
      : { state, failure: { reason, ...(responseCode !== undefined ? { responseCode } : {}) } });
    if (setup || greeting !== "220 capture ESMTP") {
      if (setup === "MAIL FROM" || setup === "DATA" || setup === "starttls-timeout") {
        expect(stoppedAt).toBe(setup === "starttls-timeout" ? "STARTTLS" : setup);
      }
      expect(recipients).toEqual(setup === "DATA" ? [...message.to, ...message.cc] : []);
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
