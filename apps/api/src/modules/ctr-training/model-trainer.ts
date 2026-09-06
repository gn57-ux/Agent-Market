import type { TrainingExampleRow } from "./dataset-builder.js";
import { computeFusedScore, DEFAULT_FUSION_WEIGHTS, type FusionWeights } from "./fusion-weights.js";
import { computeReward } from "./reward.js";

const SIGNAL_KEYS = [
  "completionRate",
  "qualityFeedback",
  "communication",
  "disputeSignal",
  "historicalScale",
] as const;

/**
 * Design comparison (CLAUDE.md 原则 3 — this is the core algorithmic
 * decision of a new module, "策略训练/更新"):
 *
 * | 维度 | 方案 A（选用）：确定性网格搜索 5 维单纯形 | 方案 B：梯度下降/最小二乘拟合线性权重 |
 * |---|---|---|
 * | 可复现性 | 无随机性——同一数据+同一网格步长必然产出完全相同的结果，比"固定随机种子下可复现"更强的保证，直接满足且超出 AC-1904 | 需要固定初始化点、学习率、迭代次数、收敛判据才能做到位级复现，任一超参数变化结果就会漂移 |
 * | 工程投入 | 无需新增数值优化依赖，纯枚举+比较，与 design.md 决策 6 "工程投入最小"的既定选择一致 | 需要引入优化库或手写梯度计算，对"仅调 5 个非负且和为 1 的系数"这种低维约束问题是不成比例的复杂度 |
 * | 可解释性 | 每个候选点本身就是一组合法权重，找到的最优解可以直接展示"哪组权重、在多少真实样本对上排序更准确" | 拟合出的系数需要额外投影回"非负且和为 1"的单纯形约束（线性回归天然不保证），且拟合目标（如最小化 MSE）与真正关心的"排序是否正确"（pairwise concordance）不是同一个目标，需要额外论证等价性 |
 * | 样本量小时的行为 | 网格搜索在任意样本量下都能给出确定性结果，是否可信由外部的 `sufficientData` 门槛判断，不影响算法本身的稳定性 | 样本量过小时梯度法容易过拟合到噪声，且收敛性本身在小样本下没有保证 |
 *
 * 选择方案 A：`gridStepUnits`（默认 20，即步长 0.05）的枚举步长选择恰好能
 * 精确表示 Go `ScoreV2`/Python `fusion.py` 的默认权重（0.30/0.30/0.15/
 * 0.20/0.05 = 6/20+6/20+3/20+4/20+1/20），所以生产权重本身总是网格搜索会
 * 实际枚举到的一个候选点，不需要额外把它硬插入候选集合。
 */
export function enumerateWeightGrid(totalUnits = 20): FusionWeights[] {
  const results: FusionWeights[] = [];
  const partial: number[] = [];

  function recurse(remainingKeys: number, remainingUnits: number): void {
    if (remainingKeys === 1) {
      const units = [...partial, remainingUnits];
      const weights = {} as FusionWeights;
      for (let i = 0; i < SIGNAL_KEYS.length; i += 1) {
        const key = SIGNAL_KEYS[i];
        if (!key) continue;
        weights[key] = (units[i] ?? 0) / totalUnits;
      }
      results.push(weights);
      return;
    }
    for (let units = 0; units <= remainingUnits; units += 1) {
      partial.push(units);
      recurse(remainingKeys - 1, remainingUnits - units);
      partial.pop();
    }
  }

  recurse(SIGNAL_KEYS.length, totalUnits);
  return results;
}

export interface UsableExample {
  taskId: string;
  reward: number;
  signals: TrainingExampleRow["candidateFeatures"]["reputationSignals"];
}

/**
 * N4 real finding (P1, round 2): the original version kept EVERY exposed
 * candidate (accepted or not), and `computeReward` returns `0` for a
 * non-accepted (censored) one — but `evaluateWeights`' pairwise comparison
 * then treated "accepted (reward>0) vs censored (reward=0)" as a real,
 * orderable ground-truth pair. Since a candidate's OWN acceptance is
 * exactly what the OLD ranker already decided, optimizing concordance over
 * those pairs mostly rewards a candidate weight vector for reproducing the
 * old ranker's picks — precisely the feedback loop `computeReward`'s own
 * doc comment says a neutral censored label must avoid, not a genuine
 * signal about real outcome quality. Fixed: only ACCEPTED candidates (the
 * only ones with a real, un-censored outcome) are usable at all — a
 * censored row never enters a pair comparison in either role.
 */
function toUsableExamples(examples: TrainingExampleRow[]): UsableExample[] {
  return examples
    .filter(
      (example) => example.wasAccepted && example.candidateFeatures.reputationSignals !== null,
    )
    .map((example) => ({
      taskId: example.taskId,
      reward: computeReward(example),
      signals: example.candidateFeatures.reputationSignals,
    }));
}

/**
 * Pairwise concordance — the fraction of candidate pairs where the one with
 * the strictly higher real-world reward also received the strictly higher
 * fused score under `weights` (analogous to AUC for a ranking task,
 * design.md's own "如 AUC/NDCG" framing, chosen over NDCG because reward
 * here isn't a graded relevance scale with a natural @k cutoff). Since
 * `toUsableExamples` now keeps only ACCEPTED candidates (N4 fix above),
 * and a task has at most one accepted candidate, a meaningful comparison
 * is necessarily ACROSS tasks — "did this task's accepted candidate turn
 * out better than that OTHER task's accepted candidate, and did the fused
 * score under `weights` predict that?" — not within one task. Pairs with
 * EQUAL reward are skipped (no ground-truth ordering exists between them).
 */
export function evaluateWeights(
  examples: UsableExample[],
  weights: FusionWeights,
): { concordantPairs: number; totalPairs: number; concordance: number } {
  let concordantPairs = 0;
  let totalPairs = 0;

  for (let i = 0; i < examples.length; i += 1) {
    for (let j = i + 1; j < examples.length; j += 1) {
      const a = examples[i];
      const b = examples[j];
      if (!a || !b || a.reward === b.reward) continue;

      const [higher, lower] = a.reward > b.reward ? [a, b] : [b, a];
      const higherScore = computeFusedScore(higher.signals, weights);
      const lowerScore = computeFusedScore(lower.signals, weights);

      totalPairs += 1;
      if (higherScore > lowerScore) concordantPairs += 1;
    }
  }

  return {
    concordantPairs,
    totalPairs,
    concordance: totalPairs === 0 ? 0 : concordantPairs / totalPairs,
  };
}

/**
 * N4 real finding (P1, round 2): the original version searched for the
 * best-scoring weight vector AND reported that same score as the
 * "offline evaluation metric" on the IDENTICAL data — with thousands of
 * grid points compared against a small sample, this is classic multiple-
 * testing overfitting: an apparent improvement can be pure noise that
 * looks good only on the exact examples the search already saw. Fixed: a
 * deterministic, reproducible (no RNG — AC-1904) task-level split. Every
 * THIRD task (by sorted task id) goes to `validation`; the rest to
 * `train`. The grid search (`trainModel`) only ever touches `train`; the
 * reported `candidateConcordance`/`improvedOverProduction` are measured
 * ONLY on `validation` — data the search never optimized against.
 */
export function splitByTask(examples: UsableExample[]): {
  train: UsableExample[];
  validation: UsableExample[];
} {
  const taskIds = [...new Set(examples.map((e) => e.taskId))].sort();
  const validationTaskIds = new Set(taskIds.filter((_, index) => index % 3 === 0));

  const train: UsableExample[] = [];
  const validation: UsableExample[] = [];
  for (const example of examples) {
    (validationTaskIds.has(example.taskId) ? validation : train).push(example);
  }
  return { train, validation };
}

export interface EvaluationResult {
  pairCount: number;
  candidateConcordance: number;
  productionConcordance: number;
  sufficientData: boolean;
  /** Only trustworthy when `sufficientData` is true — design.md: "新版本
   * 晋升前必须先离线优于当前生产版本...否则不晋升". */
  improvedOverProduction: boolean;
}

const DEFAULT_MIN_PAIR_COUNT = 30;

/**
 * The one function that decides "is `candidateWeights` actually better than
 * `productionWeights`, on data neither has been fit to" — shared by
 * `trainModel` (measuring its own freshly-searched candidate on this run's
 * held-out split) AND `runPromote` (N4 real finding, P1, round 2:
 * re-measuring an ALREADY-registered candidate against WHATEVER is
 * currently active at promotion time, which may be a different, newer
 * production version than was active when this candidate was trained —
 * the stored `offlineMetrics.improvedOverProduction` from train time can
 * be stale by the time a human actually runs `--promote`).
 */
export function evaluateAgainstProduction(
  validationExamples: UsableExample[],
  candidateWeights: FusionWeights,
  productionWeights: FusionWeights,
  minPairCount = DEFAULT_MIN_PAIR_COUNT,
): EvaluationResult {
  const candidate = evaluateWeights(validationExamples, candidateWeights);
  const production = evaluateWeights(validationExamples, productionWeights);
  const pairCount = production.totalPairs;
  const sufficientData = pairCount >= minPairCount;

  return {
    pairCount,
    candidateConcordance: candidate.concordance,
    productionConcordance: production.concordance,
    sufficientData,
    improvedOverProduction: sufficientData && candidate.concordance > production.concordance,
  };
}

export interface TrainModelOptions {
  /** The currently active production weights — Go's fixed defaults when no
   * `ctr_models` row has ever been promoted yet (design.md's own "早期阶段
   * 可能还没有正式登记的版本" allowance). */
  productionWeights?: FusionWeights;
  gridStepUnits?: number;
  /** Below this many informative (non-tied-reward) pairs IN THE HELD-OUT
   * VALIDATION SPLIT, a concordance comparison is statistically
   * meaningless — an engineering safeguard against promoting on noise,
   * distinct from Q-1902's business thresholds (traffic %, latency/
   * stability), which this Task does not decide. */
  minPairCount?: number;
}

export interface TrainModelResult {
  candidateWeights: FusionWeights;
  candidateConcordance: number;
  productionWeights: FusionWeights;
  productionConcordance: number;
  pairCount: number;
  usableExampleCount: number;
  sufficientData: boolean;
  improvedOverProduction: boolean;
}

export function trainModel(
  examples: TrainingExampleRow[],
  options: TrainModelOptions = {},
): TrainModelResult {
  const productionWeights = options.productionWeights ?? DEFAULT_FUSION_WEIGHTS;
  const minPairCount = options.minPairCount ?? DEFAULT_MIN_PAIR_COUNT;

  const usable = toUsableExamples(examples);
  const { train, validation } = splitByTask(usable);

  // Grid search touches ONLY `train` — `validation` stays fully unseen
  // until the evaluation below (N4 fix, see `splitByTask`'s doc comment).
  let bestWeights = productionWeights;
  let bestTrainConcordance = evaluateWeights(train, productionWeights).concordance;
  for (const weights of enumerateWeightGrid(options.gridStepUnits ?? 20)) {
    const { concordance } = evaluateWeights(train, weights);
    if (concordance > bestTrainConcordance) {
      bestTrainConcordance = concordance;
      bestWeights = weights;
    }
  }

  const validationResult = evaluateAgainstProduction(
    validation,
    bestWeights,
    productionWeights,
    minPairCount,
  );

  return {
    candidateWeights: bestWeights,
    candidateConcordance: validationResult.candidateConcordance,
    productionWeights,
    productionConcordance: validationResult.productionConcordance,
    pairCount: validationResult.pairCount,
    usableExampleCount: usable.length,
    sufficientData: validationResult.sufficientData,
    improvedOverProduction: validationResult.improvedOverProduction,
  };
}

/**
 * `runPromote`'s own re-validation step (N4 fix, stale-baseline finding):
 * reloads a candidate's ORIGINAL training examples (same `dataSnapshotVersion`
 * it was trained on — the comparison must stay apples-to-apples with what
 * the candidate's own weights were fit against) and re-measures it against
 * WHATEVER is currently active right now, using the SAME deterministic
 * held-out validation split `trainModel` itself would have produced (same
 * `examples` + same `splitByTask` = same split, always).
 */
export function evaluateStoredCandidateAgainstCurrentProduction(
  examples: TrainingExampleRow[],
  candidateWeights: FusionWeights,
  currentProductionWeights: FusionWeights,
  minPairCount = DEFAULT_MIN_PAIR_COUNT,
): EvaluationResult {
  const usable = toUsableExamples(examples);
  const { validation } = splitByTask(usable);
  return evaluateAgainstProduction(
    validation,
    candidateWeights,
    currentProductionWeights,
    minPairCount,
  );
}
