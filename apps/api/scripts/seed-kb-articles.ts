// Feature 22 (ai-customer-service), T-2200 (F-2202, Q-2202).
//
// Q-2202's decision (requirements.md v1.1, 用户 2026-09-06 定稿): knowledge
// base content comes from extracting REAL rules already stated in
// `docs/PRD-Agent-Market.md`, hand-structured into FAQ/rule entries — not
// invented. Every `content` string below is a paraphrase of a specific
// PRD section (cited in each entry's own comment); none introduces a
// number or rule the PRD doesn't already state. This keeps F-2207's
// "回答必须能引用知识库中的具体条目" honest — the knowledge base itself
// must first be honest about where its facts came from.
//
// Idempotent via `title` as the natural key (see 0043_create_kb_articles.sql's
// UNIQUE constraint and kb-repository.ts's `upsertKbArticleByTitle`):
// re-running this script after editing an entry's `content` below updates
// the existing row in place rather than duplicating it, matching this
// repo's "knowledge base needs periodic content updates" requirement
// (T-2200's own task description).
//
// Run as `pnpm --filter @agent-market/api seed-kb-articles` (see
// package.json). Deliberately a standalone script, never invoked from a
// migration file — same "real network calls to Ollama don't belong in a
// transactional-DDL failure domain" reasoning as backfill-embeddings.ts.
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/db/pool.js";
import { computeEmbeddingVersion } from "../src/modules/embeddings/embed-on-save.js";
import { OllamaEmbeddingProvider } from "../src/modules/embeddings/ollama-provider.js";
import { upsertKbArticleByTitle } from "../src/modules/customer-service/kb-repository.js";

interface KbArticleSeed {
  title: string;
  content: string;
}

// Each entry paraphrases one real rule from docs/PRD-Agent-Market.md — see
// the inline PRD section reference in each entry.
export const KB_ARTICLE_SEEDS: KbArticleSeed[] = [
  {
    title: "任务创建与预算锁定流程",
    // PRD §8.2 创建并发布任务
    content:
      "需求方填写任务标题、描述、分类、技能标签、要求等级、预算和截止时间后，后端先创建 DRAFT 状态的任务并生成不可变任务 ID。" +
      "前端检查网络、YD 余额和授权额度，授权不足时先调用 YD Token 的 approve。之后钱包调用托管合约创建任务并锁定 100% 预算，" +
      "前端把交易哈希提交给后端，后端通过独立 RPC 复核交易后，任务才进入 OPEN 状态，可以生成推荐和接单。" +
      "链下资料写入成功但链上交易失败时，草稿必须可以继续编辑和重试，不会因此生成第二个任务 ID。",
  },
  {
    title: "交易复核规则",
    // PRD §8.3 交易复核
    content:
      "后端对每笔链上交易至少复核：交易状态是否成功、chainId 是否与环境配置一致、交易目标地址是否为受信托托管合约、" +
      "事件签名是否为预期事件、事件中的任务 ID/需求方/代币地址/预算/截止时间是否与草稿一致、交易哈希是否已绑定其他任务、" +
      "以及区块是否达到确认数且区块哈希仍可查询。如果 RPC 暂时不可用，任务会保持待确认状态，不会被误判为失败，重试逻辑是幂等的。",
  },
  {
    title: "Agent 推荐与撮合流程",
    // PRD §8.4 推荐 Agent
    content:
      "任务进入 OPEN 后，后端把规范化的任务特征发送给 Go Dispatch Engine。撮合服务先对候选 Agent 做资格过滤，" +
      "再计算一期综合评分并生成解释，选出两个最高分候选，另外从新人池里选一个确定性的探索候选，最多生成三个有效候选。" +
      "算法版本、输入特征摘要、候选分数、槽位类型和解释都会被保存。如果没有合适的候选，页面会提示“暂无合适 Agent”，" +
      "允许需求方修改任务重新匹配，系统不会返回占位 Agent 充数。",
  },
  {
    title: "Agent 接单与质押规则",
    // PRD §6.1 金额规则、§8.5 Agent 接单
    content:
      "每个任务最多生成三个有效候选，候选会收到包含任务、钱包、有效期、nonce、链 ID 和合约地址的接单授权，" +
      "该授权不可转让、不可跨任务、不可跨链、也不可跨合约重放。第一个成功提交有效授权并完成质押的候选成为任务的 Agent，" +
      "质押率是 600 basis points（即质押金额 = 预算 × 600 / 10000，也就是预算的 6%）。任务接单成功后，其余候选的授权会因任务状态变化自动失效，" +
      "并发情况下只可能有一笔接单交易成功，其余会因状态不合法而回滚。",
  },
  {
    title: "成果提交流程",
    // PRD §8.6 提交成果
    content:
      "Agent 需要在任务的 deliveryDeadline 之前提交成果：先上传成果文件或提交成果 URL，后端保存文件元数据并生成规范化的成果摘要，" +
      "前端会显示即将上链的成果哈希，Agent 的钱包再调用合约的 submitResult 方法把哈希和提交时间登记到链上，" +
      "合约会据此生成验收截止时间（reviewDeadline）。提交成功后后端同步链上事件并通知需求方。" +
      "一期不保证外部 URL 永久可用，正式演示应使用平台控制的对象存储或固定测试文件。",
  },
  {
    title: "验收窗口与正常验收流程",
    // PRD §6.2 截止时间规则、§8.7 验收、超时与争议（正常验收）
    content:
      "Agent 提交成果成功后，合约会生成 reviewDeadline = 提交时间 + reviewWindow（验收窗口），" +
      "在 reviewDeadline 到期之前，需求方都可以选择验收（approveResult）或者在此期间发起争议。" +
      "正常验收时，合约会把预算支付给 Agent、把质押退还给 Agent，任务进入 RELEASED 终态。",
  },
  {
    title: "验收逾期与交付逾期的结算规则",
    // PRD §6.2 截止时间规则、§6.4 履约与结算规则、§8.7
    content:
      "如果到 deliveryDeadline 时 Agent 仍未提交成果，需求方可以调用 claimDeliveryTimeout 触发交付逾期结算：" +
      "预算和质押都会支付给需求方，任务进入 REFUNDED。如果到 reviewDeadline 时需求方既未验收也未发起争议，" +
      "任何地址都可以调用 finalizeReviewTimeout 触发验收逾期结算：预算支付给 Agent、质押退还给 Agent，任务同样进入 RELEASED（视为默认验收通过）。" +
      "无论哪种终态，每个任务只能结算一次，结算之后合约余额必须可核算。",
  },
  {
    title: "争议与仲裁流程",
    // PRD §6.4 履约与结算规则、§8.7 争议
    content:
      "需求方只能在验收期（reviewDeadline 之前）内提交争议，需要给出争议原因和证据摘要——证据正文保存在链下，只有摘要哈希会写到链上。" +
      "一旦进入 DISPUTED 状态，所有普通的超时自动结算（交付逾期退款、验收逾期放款）都会暂停。" +
      "仲裁员会裁决支持 Agent 还是支持需求方（一期仲裁结果只有这两种），合约按裁决结果一次性完成结算并进入对应的终态（RELEASED 或 REFUNDED）。",
  },
  {
    title: "任务取消规则",
    content:
      "在任务处于 OPEN（预算已锁定但尚未被任何 Agent 接单）状态时，需求方可以取消任务，此时预算会退还给需求方，" +
      "任务进入 CANCELLED 终态。一旦有 Agent 完成接单质押（任务进入 ACCEPTED 及之后的状态），任务就不再允许通过取消这条路径退出，" +
      "只能按正常的提交、验收/超时或争议流程走向终态。",
  },
  {
    title: "评分与完成率规则",
    // PRD §6.5 评分规则
    content:
      "只有真正走到结算终态的任务才会计入 Agent 的完成率：任务进入 RELEASED 计为完成；" +
      "如果 REFUNDED 是因为 Agent 交付逾期造成的，会计为一次失败；仲裁支持 Agent 的争议计为完成，仲裁支持需求方的争议计为失败。" +
      "质量评分由需求方在任务结算之后提交，评分范围是 1 到 5 分，同一个任务只能提交一次评分。" +
      "还没有历史评分记录的新 Agent 会使用平台定义的中性先验值，不会被展示成虚假的满分五星。",
  },
  {
    title: "调用凭据与隐私保护规则",
    // PRD §8.1 Agent 登记
    content:
      "Agent 登记时填写的调用地址、收款地址等信息中，真正的调用凭据（如 API Key）会通过安全配置写入，" +
      "业务数据库只保存一个凭据引用（credentialRef），并不直接保存凭据明文。平台的验收要求是：公开接口和日志中都不能返回明文的 API Key、JWT 或私钥。" +
      "客服系统同样必须遵守这条规则，不能把其他用户的凭据引用或密钥值透露给任何人，也不能替用户执行放款、退款等实际资金操作——" +
      "这些操作只能由用户本人通过钱包签名在链上发起。",
  },
];

/**
 * Core seed logic: embeds each real entry via a real `OllamaEmbeddingProvider`
 * and upserts it into `kb_articles`. Exported (not just called from
 * `main`) so an integration test can exercise the real logic directly
 * against a real pool/Provider, matching this repo's established
 * "test through the real function, not a subprocess" convention.
 *
 * N4 real finding (round 2, T-2200, P2): embedding every article first
 * (real, slow Ollama network calls) and committing every upsert together
 * in ONE database transaction — never one UPSERT per article as separate
 * commits. Per-article commits meant a real mid-run failure (Ollama
 * outage, budget exhaustion, a DB error) on article N left articles
 * 1..N-1 already updated to new content while N..last kept their OLD
 * content, silently mixing two versions of the knowledge base under the
 * SAME `embedding_version` (a content-only edit doesn't change the
 * model/digest, so T-2200's earlier stale-version filter can't detect
 * this) — `searchKbArticles` would keep citing outdated rules
 * indefinitely until someone noticed and re-ran the script. All-or-
 * nothing here means a failed run leaves the knowledge base exactly as
 * it was before the run started, never a silent partial mix.
 */
export async function seedKbArticles(
  pool: Pool,
  provider: OllamaEmbeddingProvider,
  seeds: KbArticleSeed[] = KB_ARTICLE_SEEDS,
): Promise<{ seeded: number }> {
  const identity = await provider.resolveVersionIdentity();
  const embeddingVersion = computeEmbeddingVersion(identity);

  const embedded = [];
  for (const seed of seeds) {
    const result = await provider.embed(`${seed.title}\n${seed.content}`);
    embedded.push({ seed, result });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const { seed, result } of embedded) {
      await upsertKbArticleByTitle(client, {
        title: seed.title,
        content: seed.content,
        embedding: result.vector,
        provider: result.provider,
        model: result.model,
        dimension: result.dimension,
        embeddingVersion,
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { seeded: seeds.length };
}

async function main(): Promise<void> {
  const pool = getPool();
  const provider = new OllamaEmbeddingProvider(pool);
  const result = await seedKbArticles(pool, provider);
  console.log(`知识库初始内容写入完成：${result.seeded} 条（幂等，按 title 更新已存在的条目）。`);
}

// Same import-time-side-effect guard as backfill-embeddings.ts's own
// entrypoint check — lets seed-kb-articles.integration.test.ts import
// `seedKbArticles`/`KB_ARTICLE_SEEDS` without also triggering `main()`.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
