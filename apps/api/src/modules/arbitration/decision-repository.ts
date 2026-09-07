import type { Queryable } from "../../db/pool.js";

/**
 * Feature 21 (arbitration-committee), T-2105 (F-2107/F-2114). The one
 * module that knows `arbitration_decisions`'s columns (CLAUDE.md 原则 6).
 * A row here always corresponds to a REAL Safe multisig execution that
 * has already happened on chain (`contracts/test/helpers/safe.ts`'s
 * `execRealSafeTransaction` — the real signature-collection/execution
 * logic — lives entirely in the `contracts` package, since that is where
 * this project's signer infrastructure already lives; see
 * `upgrade-log-repository.ts`'s own doc comment for the same split of
 * responsibilities). `signerAddresses` must be at least the real 2
 * addresses that actually signed — never fewer, matching
 * `0040_create_arbitration_committee_tables.sql`'s own
 * `arbitration_decisions_at_least_two_distinct_valid_signers` CHECK.
 */
export interface InsertArbitrationDecisionInput {
  disputeId: string;
  safeTxHash: string;
  onchainTxHash: string;
  supportedParty: "AGENT" | "REQUESTER";
  signerAddresses: string[];
}

export interface ArbitrationDecisionRow {
  id: string;
  disputeId: string;
  safeTxHash: string;
  onchainTxHash: string;
  supportedParty: "AGENT" | "REQUESTER";
  signerAddresses: string[];
  decidedAt: Date;
}

export async function insertArbitrationDecision(
  client: Queryable,
  input: InsertArbitrationDecisionInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO arbitration_decisions (dispute_id, safe_tx_hash, onchain_tx_hash, supported_party, signer_addresses)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      input.disputeId,
      input.safeTxHash,
      input.onchainTxHash,
      input.supportedParty,
      input.signerAddresses,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("insertArbitrationDecision: INSERT ... RETURNING id returned no row");
  }
  return row.id;
}

/**
 * F-2114：决定记录必须可查询——AC-2105 要求"决定记录里的 Safe 交易哈希可以
 * 在真实链上核实对应到真实发生的 resolveDispute 调用"，前提是这条记录本
 * 身能先被查到。
 */
export async function getArbitrationDecisionByDisputeId(
  client: Queryable,
  disputeId: string,
): Promise<ArbitrationDecisionRow | null> {
  const { rows } = await client.query<{
    id: string;
    dispute_id: string;
    safe_tx_hash: string;
    onchain_tx_hash: string;
    supported_party: "AGENT" | "REQUESTER";
    signer_addresses: string[];
    decided_at: Date;
  }>(
    `SELECT id, dispute_id, safe_tx_hash, onchain_tx_hash, supported_party, signer_addresses, decided_at
       FROM arbitration_decisions
      WHERE dispute_id = $1`,
    [disputeId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    disputeId: row.dispute_id,
    safeTxHash: row.safe_tx_hash,
    onchainTxHash: row.onchain_tx_hash,
    supportedParty: row.supported_party,
    signerAddresses: row.signer_addresses,
    decidedAt: row.decided_at,
  };
}
