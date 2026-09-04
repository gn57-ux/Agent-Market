import {
  decodeDeliveryTimeoutClaimedLog,
  decodeDisputeOpenedLog,
  decodeDisputeResolvedLog,
  decodeResultApprovedLog,
  decodeResultSubmittedLog,
  decodeReviewTimeoutFinalizedLog,
  decodeTaskAcceptedLog,
  decodeTaskCancelledLog,
  decodeTaskFundedLog,
  type RawEventLog,
} from "@agent-market/domain";

/**
 * F-1807's own literal requirement ("持续扫描 TaskEscrow 合约的全部事件类型"):
 * every real event type the deployed `TaskEscrow` contract currently emits.
 * Nine, not the eight T-1805's own one-line tasks.md description mentions —
 * that count predates `TaskCancelled` (Feature 17's own later addition to
 * the same contract, `contracts/src/TaskEscrow.sol`'s `cancelTask`).
 * Deliberately indexing all nine rather than artificially excluding the
 * ninth: F-1807's whole point is "不再要求每个业务模块各自实现扫描+解析逻辑"
 * — omitting one real event type would leave exactly the gap that
 * sentence exists to close.
 *
 * Dispatch is "try each decoder in turn, first non-null match wins" rather
 * than a topic0-keyed lookup table — every `decode*Log` already returns
 * `null` (never throws) on a non-matching log by design (each module's own
 * doc comment: "not a match" is a routine, expected outcome, not
 * exceptional), so this reuses that existing contract instead of
 * duplicating each event's topic0 hash a second time just to route to it.
 * Nine linear checks per log is negligible cost for an indexer (not a
 * hot request-path verifier), and keeps this module knowing nothing about
 * ABI/topic internals — that knowledge stays owned by each event's own
 * module (CLAUDE.md 原则 6).
 */
export interface DecodedAnyEvent {
  eventType: string;
  payload: unknown;
}

const DECODERS: ReadonlyArray<{
  eventType: string;
  decode: (log: RawEventLog) => unknown | null;
}> = [
  { eventType: "TaskFunded", decode: decodeTaskFundedLog },
  { eventType: "TaskAccepted", decode: decodeTaskAcceptedLog },
  { eventType: "ResultSubmitted", decode: decodeResultSubmittedLog },
  { eventType: "ResultApproved", decode: decodeResultApprovedLog },
  { eventType: "DeliveryTimeoutClaimed", decode: decodeDeliveryTimeoutClaimedLog },
  { eventType: "ReviewTimeoutFinalized", decode: decodeReviewTimeoutFinalizedLog },
  { eventType: "DisputeOpened", decode: decodeDisputeOpenedLog },
  { eventType: "DisputeResolved", decode: decodeDisputeResolvedLog },
  { eventType: "TaskCancelled", decode: decodeTaskCancelledLog },
];

/**
 * Decodes one raw log as whichever `TaskEscrow` event type it matches, or
 * `null` if it matches none (e.g. an ERC-20 `Transfer` log the same
 * transaction also emitted — `getLogs` filtered by contract address alone
 * still only ever returns logs the escrow contract itself emitted, so in
 * practice every log reaching this function is one of the nine; the `null`
 * path exists for robustness, not because it's expected to fire).
 */
export function decodeAnyEvent(log: RawEventLog): DecodedAnyEvent | null {
  for (const { eventType, decode } of DECODERS) {
    const payload = decode(log);
    if (payload !== null) {
      return { eventType, payload };
    }
  }
  return null;
}
