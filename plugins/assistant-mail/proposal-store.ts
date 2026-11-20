import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BridgeActionProposal, BridgeProposalPage, ProposalRevisionRef, ProposalState } from "../../packages/protocol/src/assistant-proposal.js";
import { AssistantError } from "./assistant-error.js";
import type { CalDavWrite } from "./caldav.js";
import { ASSISTANT_PROFILE_TEMPLATE_HASH, type ProfileIntent } from "./assistant-memory.js";
import type { SmtpResult } from "./smtp.js";

type Intent = { backend: "local"; baseRevision?: number } |
  { backend: "caldav"; collection: string; write: CalDavWrite } |
  { backend: "smtp"; channelVersion: string } | ProfileIntent;
export type ProposalPayload = Pick<BridgeActionProposal, "action" | "sourceId" | "sourceLabel" | "before" | "profile"> & { intent: Intent; nativeRevision?: number };
export type StoredProposal = BridgeActionProposal & { intent: Intent; nativeRevision?: number };
type ExecutionState = Exclude<ProposalState, "pending">;
type ResultState = Exclude<ExecutionState, "executing">;
type ProposalRow = { ordinal: number; id: string; revision: number; session_id: string; payload: string; hash: string; state: ProposalState | null; rejected: string | null };

const projection = `SELECT p.rowid AS ordinal, p.id, p.revision, p.session_id, p.payload, p.hash, e.state,
  CASE WHEN e.state = 'delivery_partial' THEN json_extract(s.result, '$.rejected') END AS rejected
  FROM action_proposals p LEFT JOIN proposal_executions e ON p.id = e.id AND p.revision = e.revision
  LEFT JOIN send_attempts s ON p.id = s.id AND p.revision = s.revision`;
const latest = "NOT EXISTS (SELECT 1 FROM action_proposals newer WHERE newer.id = p.id AND newer.revision > p.revision)";
const isMail = "json_extract(p.payload, '$.intent.backend') = 'smtp'";
const isMemory = "json_extract(p.payload, '$.intent.backend') = 'profile'";

function visibleProposals(includeMail?: boolean, includeMemory?: boolean): string {
  return `${includeMail ? "" : `AND NOT (${isMail})`} ${includeMemory ? "" : `AND NOT (${isMemory})`}`;
}

function stored(row: ProposalRow): StoredProposal {
  const { id, revision, hash, session_id, payload, state, rejected } = row;
  return { ...JSON.parse(payload) as ProposalPayload, proposalId: id, revision, payloadHash: hash, sessionId: session_id, state: state ?? "pending",
    ...(rejected ? { rejectedRecipients: JSON.parse(rejected) as string[] } : {}) };
}

export function publicProposal({ intent: _intent, nativeRevision: _nativeRevision, ...proposal }: StoredProposal): BridgeActionProposal { return proposal; }

export class ProposalStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_proposals (
        id TEXT NOT NULL, revision INTEGER NOT NULL, session_id TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS proposal_executions (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, actor TEXT NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER,
        FOREIGN KEY (id, revision) REFERENCES action_proposals (id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS send_attempts (
        id TEXT PRIMARY KEY REFERENCES proposal_executions (id), revision INTEGER NOT NULL, message_id TEXT NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER, result TEXT,
        FOREIGN KEY (id, revision) REFERENCES action_proposals (id, revision)
      ) STRICT;
    `);
  }

  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  insert(sessionId: string, id: string, revision: number, payload: ProposalPayload): StoredProposal {
    const json = JSON.stringify(payload);
    const payloadHash = createHash("sha256").update(json).digest("hex");
    this.db.prepare("INSERT INTO action_proposals VALUES (?, ?, ?, ?, ?, ?)").run(id, revision, sessionId, json, payloadHash, Date.now());
    return { ...payload, proposalId: id, revision, payloadHash, sessionId, state: "pending" };
  }

  requirePending(ref: ProposalRevisionRef, sessionId?: string): StoredProposal {
    const row = this.db.prepare(`${projection} WHERE p.id = ? ORDER BY p.revision DESC LIMIT 1`).get(ref.proposalId) as ProposalRow | undefined;
    if (!row || (sessionId !== undefined && row.session_id !== sessionId)) throw new AssistantError("NOT_FOUND", "找不到此提案。");
    if (row.revision !== ref.revision || row.hash !== ref.payloadHash || row.state !== null) {
      throw new AssistantError("CONFLICT", "提案已更新或处理，请核对当前版本。");
    }
    return stored(row);
  }

  claim(proposal: StoredProposal, actor: string, state: "executing" | "dismissed", messageId?: string): void {
    const now = Date.now();
    this.db.prepare("INSERT INTO proposal_executions VALUES (?, ?, ?, ?, ?, ?)")
      .run(proposal.proposalId, proposal.revision, state, actor, now, state === "dismissed" ? now : null);
    if (messageId) this.db.prepare("INSERT INTO send_attempts (id, revision, message_id, started_at) VALUES (?, ?, ?, ?)")
      .run(proposal.proposalId, proposal.revision, messageId, now);
  }

  finishSmtp(proposal: StoredProposal, result: SmtpResult): BridgeActionProposal {
    return this.transaction(() => {
      this.db.prepare("UPDATE send_attempts SET result = ?, finished_at = ? WHERE id = ? AND revision = ?")
        .run(JSON.stringify(result), Date.now(), proposal.proposalId, proposal.revision);
      return { ...this.finish(proposal, result.state), ...(result.state === "delivery_partial" ? { rejectedRecipients: result.rejected } : {}) };
    });
  }

  finish(proposal: StoredProposal, state: ResultState): BridgeActionProposal {
    this.db.prepare("UPDATE proposal_executions SET state = ?, finished_at = ? WHERE id = ? AND revision = ?")
      .run(state, Date.now(), proposal.proposalId, proposal.revision);
    return publicProposal({ ...proposal, state });
  }

  isApprovedProfile(hash: string): boolean {
    // Only completed approvals extend the chain. An in-flight result may already be on disk before startup reconciliation.
    return this.db.prepare(`WITH RECURSIVE revisions(base_hash, result_hash, state) AS (
      SELECT json_extract(p.payload, '$.intent.baseProfileSha256'), json_extract(p.payload, '$.intent.resultProfileSha256'), e.state
      FROM action_proposals p JOIN proposal_executions e ON p.id = e.id AND p.revision = e.revision
      WHERE ${isMemory} AND e.state IN ('applied', 'executing')
    ), approved(hash) AS (
      VALUES (?) UNION SELECT r.result_hash FROM revisions r JOIN approved a ON r.base_hash = a.hash WHERE r.state = 'applied'
    ) SELECT 1 FROM approved WHERE hash = ? UNION ALL
      SELECT 1 FROM revisions r JOIN approved a ON r.base_hash = a.hash WHERE r.state = 'executing' AND r.result_hash = ? LIMIT 1`)
      .get(ASSISTANT_PROFILE_TEMPLATE_HASH, hash, hash) !== undefined;
  }

  interrupted(): StoredProposal[] {
    return (this.db.prepare(`${projection} WHERE e.state IN ('executing', 'uncertain')`).all() as ProposalRow[]).map(stored);
  }

  pendingCounts(): { pendingCount: number; pendingMailCount: number; pendingMemoryCount: number } {
    const count = this.db.prepare(`SELECT COUNT(*) AS total, COUNT(CASE WHEN ${isMail} THEN 1 END) AS mail,
      COUNT(CASE WHEN ${isMemory} THEN 1 END) AS memory FROM action_proposals p
      WHERE ${latest} AND NOT EXISTS (SELECT 1 FROM proposal_executions e WHERE e.id = p.id)`).get()!;
    return { pendingCount: Number(count.total) - Number(count.mail) - Number(count.memory),
      pendingMailCount: Number(count.mail), pendingMemoryCount: Number(count.memory) };
  }

  page({ cursor, limit, history, includeMail, includeMemory }: { cursor?: string | undefined; limit: number; history?: boolean;
    includeMail?: boolean | undefined; includeMemory?: boolean | undefined }, sessionId?: string): BridgeProposalPage {
    const owner = sessionId !== undefined ? "AND p.session_id = ?" : "";
    const rows = this.db.prepare(`${projection} WHERE ${latest} AND e.state IS ${history ? "NOT " : ""}NULL AND p.rowid < ? ${owner}
      ${visibleProposals(includeMail, includeMemory)}
      ORDER BY p.rowid DESC LIMIT ?`).all(Number(cursor ?? Number.MAX_SAFE_INTEGER), ...(sessionId === undefined ? [] : [sessionId]), limit + 1) as ProposalRow[];
    return {
      proposals: rows.slice(0, limit).map(row => publicProposal(stored(row))),
      ...(rows.length > limit ? { nextCursor: String(rows[limit - 1]!.ordinal) } : {}),
    };
  }

  resolve(sessionId: string, refs: ProposalRevisionRef[], latestForReview = false, includeMail = false, includeMemory = false): BridgeActionProposal[] {
    const query = this.db.prepare(`${projection} WHERE p.id = ? AND p.session_id = ? AND ${latest}
      ${visibleProposals(includeMail, includeMemory)} AND EXISTS (
      SELECT 1 FROM action_proposals proof WHERE proof.id = p.id AND proof.revision = ? AND proof.hash = ?)`);
    return refs.flatMap(({ proposalId, revision, payloadHash }) => {
      const row = query.get(proposalId, sessionId, revision, payloadHash) as ProposalRow | undefined;
      if (!row) return [];
      const proposal = stored(row);
      return latestForReview || (proposal.nativeRevision ?? proposal.revision) === revision ? [publicProposal(proposal)] : [];
    });
  }
}
