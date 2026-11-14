# Assistant mail

Stage 1 of assistant-mail ([Issue 163](https://github.com/Lycidas97/claude-desktop-bridge/issues/163)). A single read-only Inbox receiver belongs to `createServiceRuntime()`. The runtime initializes it before the native broker and injects the same object into `DesktopController.assistantMail`. Closing a window does not own or stop this resource; stopping the background service does.

## Business interface

`AssistantMailService` provides `initialize()`, `enable({ host, port = 993, user, password })`, `disable()`, `status()`, `page({ cursor?, limit?, processingStatus? })`, `read(mailRefId)`, `binding()`, `setBinding(binding)`, and `close()`.

- `enable` configures one account using TLS. Account identity is a host-generated SHA-256 of host, port and username. Password changes retain that identity. Credential preparation completes before stopping a healthy receiver; failed credential updates leave it running.
- The `mail` event is emitted only after a new event and its watermark commit. `changed` signals connection or binding changes. Consumers reload durable pages after reconnect; notifications are not storage.
- Pages are newest-first, bounded to 100 records (default 50), with a `nextCursor` for older records. New arrivals do not shift earlier pages. Event IDs and metadata contain no filesystem paths or credentials.
- `read()` is an internal host API returning the original RFC822 bytes as a Buffer, not a rendered body. MIME cleaning, narrow MCP transport, account configuration UI, client RPC/capability, cards, and native delivery belong to later Issues. No tools or remote interface are registered here.

## Storage and receiver invariants

Storage is `<platform userData>/private/assistant/`, with `assistant.sqlite`, `raw-mail/*.eml` and a non-secret `account.json`. POSIX private directories use `0700`, raw/config/SQLite/WAL/SHM use `0600`. The DB is created with restricted permissions before SQLite opens it. Windows does not support account configuration in this phase; live ACL verification is deferred with its credential backend.

Only `assistant_binding`, `imap_watermarks`, and `mail_events` business tables exist. Each scan enumerates and sorts new UIDs before fetching one message body at a time, so an unordered FETCH response cannot advance past an uncommitted earlier UID. A complete raw file is readable before one transaction inserts its event and advances its watermark. Duplicate `(accountKey, INBOX, uidValidity, uid)` identities never replace committed raw bytes. Interrupted writes may leave unreferenced raw files; this phase adds no automatic deletion policy. Future cleanup must use OS Trash.

First enable and a changed UIDVALIDITY start at the server's current `uidNext - 1`, excluding existing mailbox history. Same-generation reconnect/restart resumes the committed UID and includes mail received while disconnected. Disabling stops reception but preserves configuration and the committed watermark; enabling the same account resumes from it. Existing events from previous generations/accounts remain readable.

IMAPFlow opens Inbox with `EXAMINE` (`readOnly: true`), fetches source with PEEK semantics, and explicitly enters IDLE. Unsupported/refused IDLE is reported, with no polling substitute. A disconnected client is replaced after a fixed five-second delay. EXISTS wakes the single receiver, including notifications received during a fetch. No Seen updates, move/delete, attachment parsing, SMTP, inspector or model calls exist. Attachment bytes remain part of the saved original RFC822 message.

## Credentials

macOS passwords are generic-password items in the system Keychain under service `Claude Desktop Bridge assistant-mail`, with the generated account key as the item account. `security -i` receives a single `add-generic-password -U -X <hex>` command through stdin; neither plaintext nor hex enters process argv. The complete command must fit the system tool's 4096-byte input buffer. Read output is captured locally. Reads use `find-generic-password -g` and capture its stderr password record locally: quoted printable text remains text, and the explicit `0x` form is decoded as UTF-8 bytes. This avoids `-w`'s ambiguous bare-hex output for non-ASCII/control bytes. Keychain and IMAP diagnostics are not forwarded to snapshots or logs; status exposes fixed error codes. Other platforms explicitly reject configuration. Pairing-key storage and Electron safeStorage are not reused as a mailbox credential store.

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
