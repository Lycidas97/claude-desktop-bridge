import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BridgeActionProposal, BridgeProposalPage, ProposalRevisionRef, ProposalState } from "../../packages/protocol/src/assistant-proposal.js";
import { AgendaEditError } from "./agenda-store.js";
import type { CalDavWrite } from "./caldav.js";
import type { ProfileIntent } from "./assistant-memory.js";

type Intent = { backend: "local"; baseRevision?: number } |
  { backend: "caldav"; collection: string; write: CalDavWrite } | ProfileIntent;
export type ProposalPayload = Pick<BridgeActionProposal, "action" | "sourceId" | "sourceLabel" | "before" | "profile"> & { intent: Intent; nativeRevision?: number };
export type StoredProposal = BridgeActionProposal & { intent: Intent; nativeRevision?: number };
type ExecutionState = Exclude<ProposalState, "pending">;
type ResultState = Exclude<ExecutionState, "executing">;
type ProposalRow = { ordinal: number; id: string; revision: number; session_id: string; payload: string; hash: string; state: ProposalState | null };

const projection = `SELECT p.rowid AS ordinal, p.id, p.revision, p.session_id, p.payload, p.hash, e.state
  FROM action_proposals p LEFT JOIN proposal_executions e ON p.id = e.id AND p.revision = e.revision`;
const latest = "NOT EXISTS (SELECT 1 FROM action_proposals newer WHERE newer.id = p.id AND newer.revision > p.revision)";

function stored(row: ProposalRow): StoredProposal {
  const { id, revision, hash, session_id, payload, state } = row;
  return { ...JSON.parse(payload) as ProposalPayload, proposalId: id, revision, payloadHash: hash, sessionId: session_id, state: state ?? "pending" };
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
    if (!row || (sessionId !== undefined && row.session_id !== sessionId)) throw new AgendaEditError("NOT_FOUND", "找不到此提案。");
    if (row.revision !== ref.revision || row.hash !== ref.payloadHash || row.state !== null) {
      throw new AgendaEditError("CONFLICT", "提案已更新或处理，请核对当前版本。");
    }
    return stored(row);
  }

  claim(proposal: StoredProposal, actor: string, state: "executing" | "dismissed"): void {
    const now = Date.now();
    this.db.prepare("INSERT INTO proposal_executions VALUES (?, ?, ?, ?, ?, ?)")
      .run(proposal.proposalId, proposal.revision, state, actor, now, state === "dismissed" ? now : null);
  }

  finish(proposal: StoredProposal, state: ResultState): BridgeActionProposal {
    this.db.prepare("UPDATE proposal_executions SET state = ?, finished_at = ? WHERE id = ? AND revision = ?")
      .run(state, Date.now(), proposal.proposalId, proposal.revision);
    return publicProposal({ ...proposal, state });
  }

  interrupted(): StoredProposal[] {
    return (this.db.prepare(`${projection} WHERE e.state IN ('executing', 'uncertain')`).all() as ProposalRow[]).map(stored);
  }

  pendingCount(): number {
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM action_proposals p
      WHERE ${latest} AND NOT EXISTS (SELECT 1 FROM proposal_executions e WHERE e.id = p.id)`).get();
    return Number(count!.count);
  }

  page({ cursor, limit, history }: { cursor?: string | undefined; limit: number; history?: boolean }, sessionId?: string): BridgeProposalPage {
    const owner = sessionId !== undefined ? "AND p.session_id = ?" : "";
    const rows = this.db.prepare(`${projection} WHERE ${latest} AND e.state IS ${history ? "NOT " : ""}NULL AND p.rowid < ? ${owner}
      ORDER BY p.rowid DESC LIMIT ?`).all(Number(cursor ?? Number.MAX_SAFE_INTEGER), ...(sessionId === undefined ? [] : [sessionId]), limit + 1) as ProposalRow[];
    return {
      proposals: rows.slice(0, limit).map(row => publicProposal(stored(row))),
      ...(rows.length > limit ? { nextCursor: String(rows[limit - 1]!.ordinal) } : {}),
    };
  }

  resolve(sessionId: string, refs: ProposalRevisionRef[], latestForReview = false): BridgeActionProposal[] {
    const query = this.db.prepare(`${projection} WHERE p.id = ? AND p.session_id = ? AND ${latest} AND EXISTS (
      SELECT 1 FROM action_proposals proof WHERE proof.id = p.id AND proof.revision = ? AND proof.hash = ?)`);
    return refs.flatMap(({ proposalId, revision, payloadHash }) => {
      const row = query.get(proposalId, sessionId, revision, payloadHash) as ProposalRow | undefined;
      if (!row) return [];
      const proposal = stored(row);
      return latestForReview || (proposal.nativeRevision ?? proposal.revision) === revision ? [publicProposal(proposal)] : [];
    });
  }
}
