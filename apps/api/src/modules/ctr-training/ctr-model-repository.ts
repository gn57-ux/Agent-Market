import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import type { FusionWeights } from "./fusion-weights.js";

/**
 * F-1907/F-1922: the one function that knows `ctr_models`'s columns
 * (CLAUDE.md 原则 6). `offlineMetrics` records what was MEASURED
 * (concordance/pair counts/etc.); `fusionWeights` records what the model
 * actually IS (its parameters) — two distinct concerns, never merged into
 * one JSONB blob (see migration 0034's own doc comment).
 */
export interface InsertCtrModelInput {
  modelVersion: string;
  dataSnapshotVersion: string;
  featureVersion: string;
  offlineMetrics: Record<string, unknown>;
  fusionWeights: FusionWeights;
}

export async function insertCtrModel(
  client: Queryable,
  input: InsertCtrModelInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ctr_models
       (model_version, data_snapshot_version, feature_version, offline_metrics, fusion_weights, is_active)
     VALUES ($1, $2, $3, $4, $5, false)
     RETURNING id`,
    [
      input.modelVersion,
      input.dataSnapshotVersion,
      input.featureVersion,
      JSON.stringify(input.offlineMetrics),
      JSON.stringify(input.fusionWeights),
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("insertCtrModel: INSERT ... RETURNING id returned no row");
  }
  return row.id;
}

export interface CtrModelRow {
  id: string;
  modelVersion: string;
  dataSnapshotVersion: string;
  featureVersion: string;
  offlineMetrics: Record<string, unknown>;
  fusionWeights: FusionWeights;
  isActive: boolean;
  trainedAt: Date;
}

function mapRow(row: {
  id: string;
  model_version: string;
  data_snapshot_version: string;
  feature_version: string;
  offline_metrics: Record<string, unknown>;
  fusion_weights: FusionWeights;
  is_active: boolean;
  trained_at: Date;
}): CtrModelRow {
  return {
    id: row.id,
    modelVersion: row.model_version,
    dataSnapshotVersion: row.data_snapshot_version,
    featureVersion: row.feature_version,
    offlineMetrics: row.offline_metrics,
    fusionWeights: row.fusion_weights,
    isActive: row.is_active,
    trainedAt: row.trained_at,
  };
}

/** `ctr_models_single_active_idx` (migration 0033) guarantees at most one
 * row — `null` is the real, expected "no version ever promoted yet" state
 * design.md itself documents ("早期阶段可能还没有正式登记的版本"). */
export async function getActiveModel(client: Queryable): Promise<CtrModelRow | null> {
  const { rows } = await client.query<{
    id: string;
    model_version: string;
    data_snapshot_version: string;
    feature_version: string;
    offline_metrics: Record<string, unknown>;
    fusion_weights: FusionWeights;
    is_active: boolean;
    trained_at: Date;
  }>(`SELECT * FROM ctr_models WHERE is_active = true LIMIT 1`);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function getModelByVersion(
  client: Queryable,
  modelVersion: string,
): Promise<CtrModelRow | null> {
  const { rows } = await client.query<{
    id: string;
    model_version: string;
    data_snapshot_version: string;
    feature_version: string;
    offline_metrics: Record<string, unknown>;
    fusion_weights: FusionWeights;
    is_active: boolean;
    trained_at: Date;
  }>(`SELECT * FROM ctr_models WHERE model_version = $1`, [modelVersion]);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * 晋升/回滚都是同一个"指针切换"操作（design.md 决策 6: "回滚是指针切换，
 * 不需要重新训练"）——把 `is_active` 从当前生产版本原子地移到 `modelId`
 * 指向的既有行，两步在同一事务内完成，避免中间态出现"没有任何版本是
 * active"或"两个版本同时 active"（后者会直接违反
 * `ctr_models_single_active_idx` 的部分唯一索引约束）。
 */
export async function setActiveModel(pool: Pool, modelId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE ctr_models SET is_active = false WHERE is_active = true`);
    const { rowCount } = await client.query(
      `UPDATE ctr_models SET is_active = true WHERE id = $1`,
      [modelId],
    );
    if (rowCount !== 1) {
      throw new Error(`setActiveModel: no ctr_models row with id ${modelId}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
