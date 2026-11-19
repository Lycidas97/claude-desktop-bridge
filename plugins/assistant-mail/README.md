# Assistant mail

Receipt and business tools for assistant-mail ([Issue 163](https://github.com/Lycidas97/claude-desktop-bridge/issues/163), [Issue 165](https://github.com/Lycidas97/claude-desktop-bridge/issues/165)). One `AssistantMailService` belongs to `createServiceRuntime()`. Each enabled account has its own read-only Inbox receiver. The runtime injects the same service into `DesktopController.assistantMail` and owns all receivers across window closes.

## Business interface

`AssistantMailService` provides account setup, credential replacement, per-account enable/disable and removal, `status()`, bounded `page()` and `read()` APIs, and binding storage.

- `enable` configures one TLS account per host, port and username. The same identity retains its SHA-256 account key, Keychain item and committed watermarks across credential updates. Bridge reads a legacy `account.json` when `accounts.json` is absent. New account settings write only `accounts.json` so the previous version can still start. Disable or remove affects only the selected account. Removal also deletes its Keychain item and keeps historic records readable.
- The `mail` event is emitted only after a new event and its watermark commit. `changed` signals connection, binding, analysis or processing-status changes. Consumers reload durable pages after reconnect; notifications are not storage.
- Pages are newest-first, bounded to 100 records (default 50), with a `nextCursor` for older records. Pages use the stored MIME projection, including up to 32 attachment rows per mail. Original details use up to 256 indexed rows. After upgrading, the service indexes older originals in sequence in the background and refreshes mail cards when the index is ready. Opening an older original can index that message immediately. New arrivals do not shift earlier pages. Event IDs and metadata contain no filesystem paths or credentials.
- `read()` remains an internal host API returning original RFC822 bytes as a Buffer. `readEvent()` decodes MIME on the host and returns `{ event, bodyText }`: text/plain is preferred, HTML-only mail becomes plain text, control bytes are removed, and the bounded attachment metadata projection is returned without file content. HTML-only multipart bodies are explicitly converted when the MIME parser supplies no plain text; inline attached `.eml` messages are excluded too. Decoded HTML above 16,777,216 characters fails instead of being silently truncated. No HTML or raw Buffer crosses the tool channel and no remote images or links are fetched.
- `updateAnalysis(mailRefId, { summary, suggestions, questions })` replaces the complete stored analysis; the tool requires all three fields, with explicit empty arrays to clear suggestions or questions. It and `setProcessingStatus(mailRefId, "pending" | "processing" | "processed")` update the same event and emit `changed`. Neither writes IMAP flags, alters reception watermarks, creates new input events, or records user preferences or authorization. Existing mail event rows gain a nullable `analysis_json` column.
- Desktop and mobile account settings use `plugin.assistant-mail.account.v1`. The host projects account keys, addresses and fixed receiver states. Credential submissions use online, ephemeral RPCs. The [automatic-delivery gate](../../docs/SECURITY.md#外部邮件自动投递门禁) remains closed.

## Storage and receiver invariants

Storage is `<platform userData>/private/assistant/`, with `assistant.sqlite`, `raw-mail/*.eml` and a non-secret `accounts.json` account list. POSIX private directories use `0700`, raw/config/SQLite/WAL/SHM use `0600`. The DB is created with restricted permissions before SQLite opens it. Windows does not support account configuration in this phase; live ACL verification is deferred with its credential backend.

`assistant_binding` retains the legacy five-column layout. A separate `assistant_managed_binding` row stores the managed policy and token. SQLite commits both rows together, and any write to the binding by a previous version revokes the managed token. Each scan enumerates and sorts new UIDs before fetching one message body at a time, so an unordered FETCH response cannot advance past an uncommitted earlier UID. A complete raw file is readable before one transaction inserts its event and advances its watermark. Duplicate `(accountKey, INBOX, uidValidity, uid)` identities never replace committed raw bytes. Interrupted writes may leave unreferenced raw files; this phase adds no automatic deletion policy. Future cleanup must use OS Trash.

First enable and a changed UIDVALIDITY start at the server's current `uidNext - 1`, excluding existing mailbox history. Same-generation reconnect/restart resumes the committed UID and includes mail received while disconnected. Disabling stops reception but preserves configuration and the committed watermark; enabling the same account resumes from it. Existing events from previous generations/accounts remain readable.

IMAPFlow opens Inbox with `EXAMINE` (`readOnly: true`), fetches source with PEEK semantics, and explicitly enters IDLE. When IDLE is unavailable and the connection is usable, Bridge repeats `EXAMINE` and scans new UIDs on that connection at the mailbox's polling interval. Open **助理设置 → 邮箱账号** to select 30 seconds, 1 minute (the default for existing and new accounts), 2 minutes, or Off. Bridge stores each interval in `accounts.json`. With polling off, an IDLE-less mailbox reports that continuous receipt is unsupported. A disconnected client is replaced after a fixed five-second delay. EXISTS wakes an IDLE receiver, including notifications received during a fetch. System resume wakes every enabled receiver. A binding or an enabled account keeps the background service from app suspension. No Seen updates, move/delete, SMTP, inspector or model calls exist. Attachment bytes remain part of the saved original RFC822 message.

## Credentials

macOS passwords are generic-password items in the system Keychain under service `Claude Desktop Bridge assistant-mail`, with the generated account key as the item account. `security -i` receives a single `add-generic-password -U -X <hex>` command through stdin; neither plaintext nor hex enters process argv. The complete command must fit the system tool's 4096-byte input buffer. Read output is captured locally. Reads use `find-generic-password -g` and capture its stderr password record locally: quoted printable text remains text, and the explicit `0x` form is decoded as UTF-8 bytes. This avoids `-w`'s ambiguous bare-hex output for non-ASCII/control bytes. Keychain and IMAP diagnostics are not forwarded to snapshots or logs; status exposes fixed error codes. Other platforms explicitly reject configuration. Pairing-key storage and Electron safeStorage are not reused as a mailbox credential store.

## MCP tools and local authority

`createServiceRuntime()` starts a separate loopback HTTP listener with the same mail service already injected into the Controller. It accepts only authenticated `POST /tools` calls with `{ name, arguments }`. It exposes `mail.list_events`, `mail.read_event`, `mail.update_analysis`, and `mail.set_processing_status`. The authenticated managed session also gets `mail.read_attachment`, which extracts bounded plain text from supported text or PDF files. Unknown fields and tools are rejected. Responses contain a host-generated `source` marking email as untrusted external data, analysis as model suggestions, and `authorizesActions: false`. Text claiming to be user instructions remains data.

The listener writes `{ port, token }` to `<Bridge-userData>/private/assistant/mail-tools.json` with POSIX mode `0600` in the existing `0700` directory. This random mail token is independent of the full background-service token. Browser Origin requests are rejected. No management WebSocket, snapshot broadcast, native injection, inspector evaluation, approval consumption or SMTP function is reachable through this listener. The request body budget is 3 MiB, covering all schema-valid analysis strings including JSON escaping. The service closes the listener and its active connections before the mail store, so an incomplete request cannot hold shutdown open. A stopped listener fails calls; the adapter reloads the descriptor for each new call without retrying failed operations.

`mcp.ts` is a stdio protocol adapter using the MCP SDK. Its dependency graph contains no mail store, receiver, credentials, MIME parser, Controller or inspector. Every adapter references the existing host service; opening or closing adapters does not create or stop IMAP connections. The root build also bundles the independent Node entry into `plugins/assistant-mail/dist/mcp.cjs`.

## Assistant workspace configuration

**初始化托管助理** shows the fixed workspace and asks the user to confirm it. Bridge writes the workspace configuration, then asks Claude Desktop to trust it and create a native session. Bridge commits the binding after native `dontAsk` readback. The packaged MCP and `PreToolUse` guard use the app's own Electron executable and `app.asar/dist`. The guard permits workspace reads and `outputs/` writes under `stage1-fenced-workspace`, with the credential-bearing `.mcp.json` excluded. The MCP adapter reloads the local listener port for each call and authenticates as the current binding using its dedicated token. Rebinding revokes the previous token. [#222](https://github.com/Lycidas97/claude-desktop-bridge/issues/222) covers the installed runtime gate.

For an existing manual binding, use Node >=22.13 and build the adapter from this checkout:

```bash
npm run ci:run -- --prefix plugins/assistant-mail run build
```

Only in the chosen assistant workspace, merge this entry into that project's `.mcp.json`, replacing all absolute paths:

```json
{
  "mcpServers": {
    "assistant-mail": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/checkout/plugins/assistant-mail/dist/mcp.cjs",
        "/absolute/path/to/Bridge-userData/private/assistant/mail-tools.json"
      ]
    }
  }
}
```

Enable that project MCP server through Desktop's project trust/approval flow. Do not put it in a global MCP configuration or copy the token into the workspace. The workspace contains rules and MCP connection configuration; it does not contain or mount the database, originals or mailbox credentials. Desktop 5.11492.5 / Claude Code 2.1.325 project stdio loading was exercised in the [owned stage-0 fixture](../../docs/testing.md#无害工具项目规则与记忆对照). An owned Issue-165 native session also called all four production tools against a synthetic host store: list, cleaned HTML-body read, analysis write and `processed` status on the same reference succeeded. Desktop presents the tool identifiers with underscores (for example `mcp__assistant-mail__mail_read_event`) while the MCP wire names remain `mail.read_event`. This proves native project loading and the tool round-trip; it does not prove real mailbox, Keychain, installed Bridge lifecycle, complete tool isolation or card UI behavior.

Project configuration limits where this integration is enabled; it is not an OS sandbox against other processes running as the same user. It does not revoke inherited tools, prove a complete whitelist, or pass the automatic-delivery gate. The manual configuration uses the descriptor token and has no managed-session attribution. Cards read the durable event projection, with `changed` notifications triggering refreshes.

## Assistant agenda

Open **助理 → 议程** to add, complete or edit local tasks and create or edit local calendar events. The desktop and phone read the same saved records. All-day event dates in the editor include the end date. The stored end date follows the exclusive iCalendar convention.

In **助理设置 → 日历来源**, enter the full HTTPS **collection URL** for a CalDAV calendar or task list, the account name and a credential. Add each collection separately. Bridge imports `VEVENT` and `VTODO` as read-only records. A paused collection keeps its last saved copy. Removing the source drops its local mirror. Credentials are encrypted with the host OS credential backend through Electron. The insecure Linux `basic_text` backend cannot configure CalDAV.

The background service refreshes enabled sources on startup, every 15 minutes, after system resume, and on manual refresh. It uses ctag and sync tokens where available, reconciles ETags after token expiration, and commits changed resources and the new cursor together. The same `assistant.sqlite` holds source state, task and event records, and the original recurrence rules. A failed refresh preserves the last saved records and cursor.

The existing MCP server provides `todo.list`, `calendar.list_events` and `calendar.find_free_slots`. The calendar tools accept a date range of up to 366 days. A free slot is a gap in saved busy events. If a recurring resource exceeds the expansion budget, lists return the remaining records with `incomplete: true`. Incomplete calendar coverage returns `AGENDA_INCOMPLETE` from `calendar.find_free_slots`. Task lists include recurring instances, with open-ended task series expanded through the next 366 days. Imported text is external data and grants no authorization. Local user edits run through the authenticated Bridge client.

## Checks

The plugin is outside npm workspaces. Root `package.json` installs IMAPFlow and explicitly invokes its typecheck; `scripts/test.mjs` explicitly runs its Vitest suite. Consequently `verify` and `ci:local` include it. The plugin manifest also declares its direct runtime dependency for standalone tooling.

Before review:

```bash
npm run typecheck
```

```bash
npm run ci:run -- exec -- vitest related --run --config plugins/assistant-mail/vitest.config.ts desktop.ts store.ts credentials.ts
```

```bash
npm run ci:run -- exec -w @bridge/desktop -- vitest related --run src/app/service-runtime.ts src/controller/controller.ts
```

After independent review converges, run `npm run ci:local` once. Unit tests use private temporary storage, injected credentials and synthetic Inbox clients. They cover transaction rollback, byte preservation, deduplication, paging, POSIX permissions, UID generation, IDLE wakeups, reconnect/restart and service ownership. They do not establish real-provider acceptance, real Keychain consent, live Windows ACLs, locked-screen receipt, or a physical phone experience. Those checks require the corresponding environment and credentials and must be recorded separately.
