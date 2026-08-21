// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MaliciousReentrantToken
/// @notice TEST-ONLY mock ERC20 whose `transfer` attempts a reentrant call into a configurable
/// target/calldata pair before completing the transfer itself, used solely to demonstrate that
/// `TaskEscrow`'s `nonReentrant` modifier blocks reentrancy through its outbound `safeTransfer`
/// calls (see contracts/test/TaskEscrow.cancellation.t.ts, AC-109). The reentrant call's
/// success/failure is intentionally ignored (not `require`d) so the outer transfer still
/// completes normally, letting the test assert both that the reentrant call failed AND that the
/// legitimate transfer went through unharmed. Not a real project deliverable — never deploy this
/// outside of tests.
contract MaliciousReentrantToken is ERC20 {
    address public attackTarget;
    bytes public attackCalldata;
    bool public attackArmed;
    bool public attackSucceeded;

    constructor() ERC20("Malicious Reentrant Mock", "EVIL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arms the next `transfer` call to attempt `attackTarget.call(attackCalldata_)`
    /// before moving any tokens.
    function armReentrancy(address target, bytes calldata attackCalldata_) external {
        attackTarget = target;
        attackCalldata = attackCalldata_;
        attackArmed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (attackArmed) {
            attackArmed = false;
            // Result deliberately ignored: this proves the reentrant call itself failed (it
            // must revert with ReentrancyGuardReentrantCall) while the outer legitimate transfer
            // below still completes, rather than making the whole test transaction revert.
            (bool reentrySucceeded, ) = attackTarget.call(attackCalldata);
            attackSucceeded = reentrySucceeded;
        }
        return super.transfer(to, amount);
    }
}
