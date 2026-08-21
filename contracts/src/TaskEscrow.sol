// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title TaskEscrow
/// @notice Sole owner of the Agent Market task-funding state machine: budget locking, agent
/// staking, delivery/review timeouts, and dispute settlement. Callers (backend, frontend) only
/// prepare parameters and read state projections here; they must not reimplement any of the
/// fund-flow rules living in this contract (see specs/02-contract-core-escrow/design.md).
/// @dev T-102 scope: only `createTask` and `getTask` are implemented. The `Task` struct,
/// `TaskStatus` enum, and event list already match the full final shape from design.md so that
/// later Tasks (T-103..T-107) can add `acceptTask`/`submitResult`/etc. on top without changing
/// this shell.
contract TaskEscrow is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    /// @notice The sole supported task-funding token for stage one (PRD §3.3: no native ETH or
    /// multi-token support). Bound at deployment; `createTask` rejects any other `token`.
    IERC20 public immutable supportedToken;

    /// @notice Single authorized off-chain signer whose EIP-712 signature authorizes an
    /// `acceptTask` call (design.md 决策 2: EIP-712 授权, single-signer — a multi-signer/
    /// committee scheme is out of scope for this Feature). Fixed at deployment; stage one uses
    /// version-pinned deploys rather than an upgrade path (PRD §3.3/§14.4), so there is no
    /// setter — rotating the signer means deploying a new `TaskEscrow`.
    address public immutable authorizedSigner;

    /// @notice Review-window duration added to `submittedAt` to compute `reviewDeadline` in
    /// `submitResult` (F-105). Configurable per deployment (PRD §2.4 "验收窗口默认 72 小时，作为
    /// 合约可配置参数") rather than hardcoded, so different environments (e.g. tests using time
    /// acceleration) can deploy with a shorter window without changing this contract.
    uint64 public immutable reviewWindow;

    /// @notice Stake rate applied to `budget` on acceptance, expressed in basis points
    /// (PRD §6.1, 已确认决定: fixed at 600 = 6%).
    uint256 public constant STAKE_RATE_BPS = 600;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @dev EIP-712 typehash for `AcceptancePermit`. Field order matches the struct exactly.
    bytes32 private constant ACCEPTANCE_PERMIT_TYPEHASH = keccak256(
        "AcceptancePermit(bytes32 taskId,address agent,uint256 nonce,uint256 expiry,uint256 chainId,address verifyingContract)"
    );

    /// @notice Off-chain-issued authorization for `agent` to accept task `taskId`, bound to a
    /// specific chain/contract and expiring at `expiry`. `nonce` is scoped per-`agent` and is
    /// consumed on first successful use (see `_usedNonces`), preventing replay of the same
    /// authorization (AC-102).
    struct AcceptancePermit {
        bytes32 taskId;
        address agent;
        uint256 nonce;
        uint256 expiry;
        uint256 chainId;
        address verifyingContract;
    }

    /// @notice Nonces already consumed by `acceptTask`, scoped per agent so two different
    /// agents' nonce spaces never collide.
    mapping(address agent => mapping(uint256 nonce => bool used)) private _usedNonces;

    /// @dev `DRAFT` does not exist on-chain (PRD §7.2); on-chain state machine starts at `OPEN`.
    enum TaskStatus {
        OPEN,
        ACCEPTED,
        SUBMITTED,
        DISPUTED,
        RELEASED,
        REFUNDED,
        CANCELLED
    }

    struct Task {
        bytes32 taskId;
        address requester;
        address agent;
        address token;
        uint256 budget;
        uint256 stake;
        uint64 deliveryDeadline;
        uint64 submittedAt;
        uint64 reviewDeadline;
        bytes32 resultHash;
        bytes32 disputeEvidenceHash;
        TaskStatus status;
    }

    /// @notice All tasks ever created, keyed by `taskId`. Existence is tracked via
    /// `_taskExists` rather than inferred from zero-valued fields, so a `getTask` on an unknown
    /// id reverts instead of silently returning a zeroed struct.
    mapping(bytes32 => Task) private _tasks;
    mapping(bytes32 => bool) private _taskExists;

    event TaskFunded(
        bytes32 indexed taskId,
        address indexed requester,
        address token,
        uint256 budget,
        uint64 deliveryDeadline
    );
    event TaskAccepted(bytes32 indexed taskId, address indexed agent, uint256 stake);
    event ResultSubmitted(
        bytes32 indexed taskId,
        address indexed agent,
        bytes32 resultHash,
        uint64 submittedAt,
        uint64 reviewDeadline
    );
    event ResultApproved(bytes32 indexed taskId, address indexed agent, uint256 budget, uint256 stake);
    event DisputeOpened(bytes32 indexed taskId, address indexed requester, bytes32 disputeEvidenceHash);
    event DisputeResolved(bytes32 indexed taskId, bool supportAgent);
    event DeliveryTimeoutClaimed(
        bytes32 indexed taskId,
        address indexed requester,
        uint256 budget,
        uint256 stake
    );
    event ReviewTimeoutFinalized(
        bytes32 indexed taskId,
        address indexed agent,
        uint256 budget,
        uint256 stake
    );
    event TaskCancelled(bytes32 indexed taskId);

    error ZeroBudget();
    error InvalidDeliveryDeadline();
    error TaskAlreadyExists(bytes32 taskId);
    error TaskNotFound(bytes32 taskId);
    error FeeOnTransferTokenNotSupported();
    error UnsupportedToken(address token);
    error TaskNotOpen(bytes32 taskId, TaskStatus status);
    error PermitExpired(uint256 expiry, uint256 blockTimestamp);
    error PermitWrongChain(uint256 permitChainId, uint256 actualChainId);
    error PermitWrongContract(address permitContract, address actualContract);
    error PermitNonceAlreadyUsed(address agent, uint256 nonce);
    error PermitAgentMismatch(address permitAgent, address caller);
    error InvalidPermitSignature();
    error DeliveryDeadlinePassed(bytes32 taskId, uint64 deliveryDeadline, uint256 blockTimestamp);
    error StakeAmountZero(bytes32 taskId, uint256 budget);
    error ZeroAuthorizedSigner();
    error RequesterCannotAcceptOwnTask(bytes32 taskId, address requester);
    error StakeTransferAmountMismatch(bytes32 taskId, uint256 expectedStake, uint256 actualReceived);
    error NotTaskAgent(bytes32 taskId, address caller);
    error NotTaskRequester(bytes32 taskId, address caller);
    error TaskNotAccepted(bytes32 taskId, TaskStatus status);
    error TaskNotSubmitted(bytes32 taskId, TaskStatus status);
    error DeliveryDeadlineAlreadyPassed(bytes32 taskId, uint64 deliveryDeadline, uint256 blockTimestamp);
    error InvalidReviewWindow(uint64 reviewWindow);
    error DeliveryDeadlineNotYetPassed(bytes32 taskId, uint64 deliveryDeadline, uint256 blockTimestamp);
    error ReviewDeadlineNotYetPassed(bytes32 taskId, uint64 reviewDeadline, uint256 blockTimestamp);

    /// @notice Upper bound accepted for `reviewWindow_` at deployment: half of `type(uint64).max`
    /// seconds (~292 billion years), far beyond any realistic value, but small enough that
    /// `submittedAt + reviewWindow` (both uint64) can never overflow for any `block.timestamp`
    /// reachable before uint64 timestamps themselves stop making sense.
    uint64 private constant MAX_REVIEW_WINDOW = type(uint64).max / 2;

    /// @param supportedToken_ The single ERC-20 this escrow accepts for task budgets (PRD §3.3).
    /// @param authorizedSigner_ The single off-chain signer authorized to issue `AcceptancePermit`s.
    /// @param reviewWindow_ Duration (seconds) added to `submittedAt` to compute `reviewDeadline`
    /// in `submitResult` (PRD §2.4, default 72h = 259200s; tests may pass a shorter value).
    /// @dev `authorizedSigner_` can never be `address(0)`: `authorizedSigner` is immutable with no
    /// rotation path, and ECDSA.recover can never return the zero address for a valid signature,
    /// so a zero signer would make `acceptTask` permanently unusable for the life of this deploy.
    /// `reviewWindow_` must be nonzero (a real review period) and bounded by `MAX_REVIEW_WINDOW`,
    /// since an unvalidated huge value would make `submittedAt + reviewWindow` overflow uint64 on
    /// every `submitResult` call — permanently bricking the deploy with no way to fix it, `reviewWindow`
    /// being immutable.
    constructor(
        IERC20 supportedToken_,
        address authorizedSigner_,
        uint64 reviewWindow_
    ) EIP712("AgentMarketTaskEscrow", "1") {
        if (authorizedSigner_ == address(0)) revert ZeroAuthorizedSigner();
        if (reviewWindow_ == 0 || reviewWindow_ > MAX_REVIEW_WINDOW) {
            revert InvalidReviewWindow(reviewWindow_);
        }
        supportedToken = supportedToken_;
        authorizedSigner = authorizedSigner_;
        reviewWindow = reviewWindow_;
    }

    /// @notice Creates a new task and locks 100% of `budget` into escrow from `msg.sender`.
    /// @dev Requires `msg.sender` to have already `approve`d this contract for at least
    /// `budget` of `token` (standard ERC20 approve pattern) — this contract never calls
    /// `approve` itself.
    ///
    /// Ordering rationale (Checks-Effects-Interactions, adapted for the fee-on-transfer check):
    /// all *static* checks (budget, deadline, duplicate id) run first as pure Checks. The
    /// balance-delta check that guards against fee-on-transfer tokens can only be computed
    /// *after* `safeTransferFrom` has executed, so it is necessarily interleaved between the
    /// Interaction and the final Effect. This is safe because `_tasks[taskId]` has not been
    /// written yet at the point of the external call, so a reentrant call into this or any
    /// other method sees no partially-created task for this `taskId` (and `nonReentrant` blocks
    /// reentrancy into this contract entirely regardless). State is only written once the
    /// transferred amount is confirmed correct.
    function createTask(
        bytes32 taskId,
        address token,
        uint256 budget,
        uint64 deliveryDeadline
    ) external nonReentrant {
        if (token != address(supportedToken)) revert UnsupportedToken(token);
        if (budget == 0) revert ZeroBudget();
        if (deliveryDeadline <= block.timestamp) revert InvalidDeliveryDeadline();
        if (_taskExists[taskId]) revert TaskAlreadyExists(taskId);

        IERC20 erc20 = supportedToken;
        uint256 balanceBefore = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(msg.sender, address(this), budget);
        uint256 balanceAfter = erc20.balanceOf(address(this));
        if (balanceAfter - balanceBefore != budget) revert FeeOnTransferTokenNotSupported();

        _taskExists[taskId] = true;
        _tasks[taskId] = Task({
            taskId: taskId,
            requester: msg.sender,
            agent: address(0),
            token: token,
            budget: budget,
            stake: 0,
            deliveryDeadline: deliveryDeadline,
            submittedAt: 0,
            reviewDeadline: 0,
            resultHash: bytes32(0),
            disputeEvidenceHash: bytes32(0),
            status: TaskStatus.OPEN
        });

        emit TaskFunded(taskId, msg.sender, token, budget, deliveryDeadline);
    }

    /// @notice Reads the stored task for `taskId`.
    /// @dev Reverts on an unknown `taskId` rather than returning a zeroed struct, so callers
    /// notice a typo'd id instead of silently reading default values.
    function getTask(bytes32 taskId) external view returns (Task memory) {
        if (!_taskExists[taskId]) revert TaskNotFound(taskId);
        return _tasks[taskId];
    }

    /// @notice Accepts an `OPEN` task on behalf of `permit.agent` (must equal `msg.sender`),
    /// authorized off-chain by `authorizedSigner`'s EIP-712 signature over `permit`, and locks
    /// a 6% stake (`STAKE_RATE_BPS`) of the task's budget from the caller into escrow.
    /// @dev F-104 / AC-102 / AC-103 / AC-104.
    ///
    /// Concurrency (AC-103): the EVM executes transactions sequentially, so of two concurrent
    /// `acceptTask` submissions for the same `taskId` (e.g. two agents each holding a validly
    /// signed permit), whichever is mined first flips `status` to `ACCEPTED`; the second
    /// transaction's status check below then reads the already-updated state and reverts with
    /// `TaskNotOpen`. No additional locking is needed beyond this status check plus
    /// `nonReentrant` (which only guards against reentrancy *within* one transaction, not across
    /// two independent ones — ordering here comes from sequential EVM execution itself).
    ///
    /// Checks-Effects-Interactions: every check (domain binding, expiry, nonce, task status,
    /// caller match) runs before any state mutation or external call; the nonce is marked used
    /// and the task record is updated before the `safeTransferFrom` interaction, so a reentrant
    /// call during the token transfer would see the nonce already consumed and the task already
    /// `ACCEPTED`.
    function acceptTask(AcceptancePermit calldata permit, bytes calldata signature) external nonReentrant {
        if (permit.chainId != block.chainid) {
            revert PermitWrongChain(permit.chainId, block.chainid);
        }
        if (permit.verifyingContract != address(this)) {
            revert PermitWrongContract(permit.verifyingContract, address(this));
        }
        if (permit.expiry <= block.timestamp) {
            revert PermitExpired(permit.expiry, block.timestamp);
        }
        if (permit.agent != msg.sender) {
            revert PermitAgentMismatch(permit.agent, msg.sender);
        }
        if (_usedNonces[permit.agent][permit.nonce]) {
            revert PermitNonceAlreadyUsed(permit.agent, permit.nonce);
        }

        bytes32 structHash = keccak256(
            abi.encode(
                ACCEPTANCE_PERMIT_TYPEHASH,
                permit.taskId,
                permit.agent,
                permit.nonce,
                permit.expiry,
                permit.chainId,
                permit.verifyingContract
            )
        );
        address recovered = _hashTypedDataV4(structHash).recover(signature);
        if (recovered != authorizedSigner) revert InvalidPermitSignature();

        if (!_taskExists[permit.taskId]) revert TaskNotFound(permit.taskId);
        Task storage task = _tasks[permit.taskId];
        if (task.status != TaskStatus.OPEN) revert TaskNotOpen(permit.taskId, task.status);
        if (task.deliveryDeadline <= block.timestamp) {
            revert DeliveryDeadlinePassed(permit.taskId, task.deliveryDeadline, block.timestamp);
        }
        if (permit.agent == task.requester) {
            revert RequesterCannotAcceptOwnTask(permit.taskId, task.requester);
        }

        // 600 bps of `budget`, via `Math.mulDiv` (full-precision, does not overflow on the
        // intermediate `budget * 600` product even for `budget` near `type(uint256).max`,
        // unlike a direct `budget * STAKE_RATE_BPS / BPS_DENOMINATOR`). A stake that rounds down
        // to 0 (`budget < 17`) is rejected below rather than silently accepted: task.tasks.md's
        // AC-104 requires a real, non-zero stake to be locked before a task can be accepted, so
        // a task with too small a budget to produce one simply cannot be accepted.
        uint256 stake = Math.mulDiv(task.budget, STAKE_RATE_BPS, BPS_DENOMINATOR);
        if (stake == 0) revert StakeAmountZero(permit.taskId, task.budget);

        _usedNonces[permit.agent][permit.nonce] = true;
        task.agent = permit.agent;
        task.stake = stake;
        task.status = TaskStatus.ACCEPTED;

        emit TaskAccepted(permit.taskId, permit.agent, stake);

        // Same balance-delta guard as `createTask`'s fee-on-transfer protection: verify the
        // escrow's actual token balance increased by exactly `stake`, not just that
        // `safeTransferFrom` didn't revert. A revert here unwinds the nonce/task/event state
        // already written above, since Solidity reverts undo the entire transaction.
        uint256 balanceBefore = supportedToken.balanceOf(address(this));
        supportedToken.safeTransferFrom(msg.sender, address(this), stake);
        uint256 balanceAfter = supportedToken.balanceOf(address(this));
        if (balanceAfter - balanceBefore != stake) {
            revert StakeTransferAmountMismatch(permit.taskId, stake, balanceAfter - balanceBefore);
        }
    }

    /// @notice Records the agent's delivered result and starts the review window.
    /// @dev F-105 / AC-105 / AC-112. Pure state/record function — no token transfer. The
    /// `reviewDeadline` is computed once here and emitted directly in `ResultSubmitted` so
    /// downstream consumers (Feature 9) never need to recompute it off-chain (design.md, AC-112).
    /// A submission at or after `deliveryDeadline` is rejected: once the deadline has passed, the
    /// task must go through `claimDeliveryTimeout` (T-105) rather than letting a late submission
    /// silently pay out via the normal acceptance path.
    function submitResult(bytes32 taskId, bytes32 resultHash) external nonReentrant {
        if (!_taskExists[taskId]) revert TaskNotFound(taskId);
        Task storage task = _tasks[taskId];
        if (task.agent != msg.sender) revert NotTaskAgent(taskId, msg.sender);
        if (task.status != TaskStatus.ACCEPTED) revert TaskNotAccepted(taskId, task.status);
        if (block.timestamp >= task.deliveryDeadline) {
            revert DeliveryDeadlineAlreadyPassed(taskId, task.deliveryDeadline, block.timestamp);
        }

        uint64 submittedAt = uint64(block.timestamp);
        uint64 reviewDeadline = submittedAt + reviewWindow;

        task.resultHash = resultHash;
        task.submittedAt = submittedAt;
        task.reviewDeadline = reviewDeadline;
        task.status = TaskStatus.SUBMITTED;

        emit ResultSubmitted(taskId, msg.sender, resultHash, submittedAt, reviewDeadline);
    }

    /// @notice Requester-approved acceptance of a submitted result: pays `budget` and refunds
    /// `stake` to the agent in a single transfer, moving the task to its terminal `RELEASED`
    /// state.
    /// @dev F-106 / AC-106 (正常验收 branch only — timeout/dispute branches belong to later
    /// Tasks). Checks-Effects-Interactions: `status` is flipped and the event emitted before the
    /// external `safeTransfer`, so a reentrant call during the transfer sees `status ==
    /// RELEASED` and reverts via the `TaskNotSubmitted` check before it could double-pay.
    function approveResult(bytes32 taskId) external nonReentrant {
        if (!_taskExists[taskId]) revert TaskNotFound(taskId);
        Task storage task = _tasks[taskId];
        if (task.requester != msg.sender) revert NotTaskRequester(taskId, msg.sender);
        if (task.status != TaskStatus.SUBMITTED) revert TaskNotSubmitted(taskId, task.status);

        address agent = task.agent;
        uint256 budget = task.budget;
        uint256 stake = task.stake;

        task.status = TaskStatus.RELEASED;

        emit ResultApproved(taskId, agent, budget, stake);

        supportedToken.safeTransfer(agent, budget + stake);
    }

    /// @notice Requester-triggered refund when the agent fails to submit a result before
    /// `deliveryDeadline`: both the budget and the agent's forfeited stake are paid to the
    /// requester, moving the task to the terminal `REFUNDED` state.
    /// @dev F-107. This function's time window (`block.timestamp >= deliveryDeadline`) is the
    /// exact complement of `submitResult`'s own late-rejection check
    /// (`block.timestamp >= deliveryDeadline` there rejects, so `submitResult` only succeeds for
    /// `block.timestamp < deliveryDeadline`), so for an `ACCEPTED` task exactly one of
    /// `submitResult` or `claimDeliveryTimeout` is ever valid at any given `block.timestamp` — no
    /// gap, no overlap. Checks-Effects-Interactions: `status` is flipped and the event emitted
    /// before the external `safeTransfer`.
    function claimDeliveryTimeout(bytes32 taskId) external nonReentrant {
        if (!_taskExists[taskId]) revert TaskNotFound(taskId);
        Task storage task = _tasks[taskId];
        if (task.requester != msg.sender) revert NotTaskRequester(taskId, msg.sender);
        if (task.status != TaskStatus.ACCEPTED) revert TaskNotAccepted(taskId, task.status);
        if (block.timestamp < task.deliveryDeadline) {
            revert DeliveryDeadlineNotYetPassed(taskId, task.deliveryDeadline, block.timestamp);
        }

        address requester = task.requester;
        uint256 budget = task.budget;
        uint256 stake = task.stake;

        task.status = TaskStatus.REFUNDED;

        emit DeliveryTimeoutClaimed(taskId, requester, budget, stake);

        supportedToken.safeTransfer(requester, budget + stake);
    }

    /// @notice Permissionless finalize for a submitted result whose review window has expired
    /// without the requester approving (or disputing) it: pays `budget + stake` to the agent,
    /// same payout as `approveResult`'s success path, just triggered by anyone once
    /// `reviewDeadline` has passed instead of requester action. Moves the task to the terminal
    /// `RELEASED` state.
    /// @dev F-108. Callable by any address ("任意地址可调用") so a requester who never calls
    /// `approveResult` cannot indefinitely block the agent from being paid. The `status ==
    /// SUBMITTED` check naturally excludes a `DISPUTED` task once `openDispute` (T-106) exists,
    /// since a disputed task's status will no longer equal `SUBMITTED` — no extra "not disputed"
    /// condition is needed here. Checks-Effects-Interactions: `status` is flipped and the event
    /// emitted before the external `safeTransfer`.
    function finalizeReviewTimeout(bytes32 taskId) external nonReentrant {
        if (!_taskExists[taskId]) revert TaskNotFound(taskId);
        Task storage task = _tasks[taskId];
        if (task.status != TaskStatus.SUBMITTED) revert TaskNotSubmitted(taskId, task.status);
        if (block.timestamp < task.reviewDeadline) {
            revert ReviewDeadlineNotYetPassed(taskId, task.reviewDeadline, block.timestamp);
        }

        address agent = task.agent;
        uint256 budget = task.budget;
        uint256 stake = task.stake;

        task.status = TaskStatus.RELEASED;

        emit ReviewTimeoutFinalized(taskId, agent, budget, stake);

        supportedToken.safeTransfer(agent, budget + stake);
    }
}
