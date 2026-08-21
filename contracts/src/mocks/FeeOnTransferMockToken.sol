// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title FeeOnTransferMockToken
/// @notice TEST-ONLY mock ERC20 that burns a basis-point fee on every `transferFrom`, used
/// solely to exercise TaskEscrow's rejection of deflationary/fee-on-transfer tokens
/// (see contracts/test/TaskEscrow.funding.t.ts, contracts/test/TaskEscrow.acceptance.t.ts). The
/// fee is mutable (no access control — test-only) so a single test can fund a task at 0% fee and
/// then switch the fee on before exercising a later transfer path. Not a real project
/// deliverable — never deploy this outside of tests.
contract FeeOnTransferMockToken is ERC20 {
    uint256 public feeBasisPoints;

    constructor(uint256 feeBasisPoints_) ERC20("Fee On Transfer Mock", "FOT") {
        feeBasisPoints = feeBasisPoints_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFeeBasisPoints(uint256 feeBasisPoints_) external {
        feeBasisPoints = feeBasisPoints_;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        uint256 fee = (amount * feeBasisPoints) / 10_000;
        _transfer(from, to, amount - fee);
        if (fee > 0) {
            _burn(from, fee);
        }
        return true;
    }
}
