import type { Queryable } from "../../db/pool.js";

/**
 * Feature 21 (arbitration-committee), T-2104 (F-2113/F-2114). The one
 * module that knows `arbitration_upgrade_log`'s columns (CLAUDE.md 原则
 * 6). Deliberately a single table for BOTH directions of role rotation —
 * a forward upgrade (single EOA → Safe) and T-2109's later reverse
 * rotation (Safe → single EOA) are the same kind of event ("who moved
 * `ARBITRATOR_ROLE` from address A to address B, and with what real
 * on-chain transaction"), not two different concerns that need separate
 * tables.
 *
 * The actual on-chain `grantRole`/`revokeRole` calls happen in
 * `contracts/scripts/rotate-arbitrator-role.ts` (a Hardhat script, since
 * that is where this project's existing deployer/signer infrastructure
 * already lives — see `deploy-local.ts`'s own precedent) — this module
 * only ever records the REAL result of a rotation that has already
 * happened on chain, it never initiates one itself.
 */
export interface InsertArbitrationUpgradeLogInput {
  actorAddress: string;
  fromArbitratorAddress: string;
  toArbitratorAddress: string;
  txHash: string;
}

export interface ArbitrationUpgradeLogRow {
  id: string;
  actorAddress: string;
  fromArbitratorAddress: string;
  toArbitratorAddress: string;
  txHash: string;
  occurredAt: Date;
}

export async function insertArbitrationUpgradeLog(
  client: Queryable,
  input: InsertArbitrationUpgradeLogInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO arbitration_upgrade_log (actor_address, from_arbitrator_address, to_arbitrator_address, tx_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.actorAddress, input.fromArbitratorAddress, input.toArbitratorAddress, input.txHash],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("insertArbitrationUpgradeLog: INSERT ... RETURNING id returned no row");
  }
  return row.id;
}

/**
 * F-2114：升级记录必须可查询——按发生时间倒序返回完整的角色轮换历史（正向
 * 升级与 T-2109 的反向回滚共用同一份时间线，不拆分两个列表）。
 */
export async function listArbitrationUpgradeLog(
  client: Queryable,
): Promise<ArbitrationUpgradeLogRow[]> {
  const { rows } = await client.query<{
    id: string;
    actor_address: string;
    from_arbitrator_address: string;
    to_arbitrator_address: string;
    tx_hash: string;
    occurred_at: Date;
  }>(
    `SELECT id, actor_address, from_arbitrator_address, to_arbitrator_address, tx_hash, occurred_at
       FROM arbitration_upgrade_log
      ORDER BY occurred_at DESC`,
  );
  return rows.map((row) => ({
    id: row.id,
    actorAddress: row.actor_address,
    fromArbitratorAddress: row.from_arbitrator_address,
    toArbitratorAddress: row.to_arbitrator_address,
    txHash: row.tx_hash,
    occurredAt: row.occurred_at,
  }));
}
