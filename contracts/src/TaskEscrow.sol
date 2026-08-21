// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TaskEscrow
/// @notice Sole owner of the Agent Market task-funding state machine: budget locking, agent
/// staking, delivery/review timeouts, and dispute settlement. Callers (backend, frontend) only
/// prepare parameters and read state projections here; they must not reimplement any of the
/// fund-flow rules living in this contract (see specs/02-contract-core-escrow/design.md).
/// @dev T-102 scope: only `createTask` and `getTask` are implemented. The `Task` struct,
/// `TaskStatus` enum, and event list already match the full final shape from design.md so that
/// later Tasks (T-103..T-107) can add `acceptTask`/`submitResult`/etc. on top without changing
/// this shell.
contract TaskEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

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
        if (budget == 0) revert ZeroBudget();
        if (deliveryDeadline <= block.timestamp) revert InvalidDeliveryDeadline();
        if (_taskExists[taskId]) revert TaskAlreadyExists(taskId);

        IERC20 erc20 = IERC20(token);
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
}
