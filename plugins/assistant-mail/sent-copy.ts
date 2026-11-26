import type { ImapFlow } from "imapflow";

export type SentCopyResult = "filed" | "already_present" | "folder_unavailable" | "unconfirmed";

/** Only called after SMTP acceptance; the receiving client and its Inbox stay untouched. */
export async function fileSentCopy(client: ImapFlow, messageId: string, source: Buffer): Promise<SentCopyResult> {
  client.on("error", () => client.close());
  try {
    await client.connect();
    const sent = (await client.list()).filter(({ path, flags }) => {
      // ImapFlow's specialUse also guesses from names and picks a single winner for each use.
      const serverFlags = Array.from(flags, flag => flag.toLowerCase());
      return path.toUpperCase() !== "INBOX" && serverFlags.includes("\\sent") &&
        !serverFlags.includes("\\noselect") && !serverFlags.includes("\\nonexistent");
    });
    if (sent.length !== 1) return "folder_unavailable";
    const { path } = sent[0]!;
    await client.mailboxOpen(path, { readOnly: true });
    const existing = await client.search({ header: { "message-id": messageId } }, { uid: true });
    if (!existing) return "unconfirmed";
    if (existing.length) return "already_present";
    return await client.append(path, source, ["\\Seen"]) ? "filed" : "unconfirmed";
  } catch (error) {
    // IMAP rejection or connection loss is independent of the already recorded SMTP result.
    if (!(error instanceof Error) || error instanceof TypeError) throw error;
    return "unconfirmed";
  } finally {
    client.close();
  }
}
