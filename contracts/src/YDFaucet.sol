// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {YDToken} from "./YDToken.sol";

/// @title YDFaucet
/// @notice Testnet/local-only faucet: distributes a configurable amount of YDToken per address,
/// gated by a configurable cooldown period. Not part of the mainnet-relevant contract surface.
/// @dev Must hold `onlyOwner` privileges on the target YDToken (e.g. via `transferOwnership`)
/// in order to mint on claim.
contract YDFaucet is Ownable {
    YDToken public immutable token;

    /// @notice Amount of YDToken minted per successful claim.
    uint256 public claimAmount;

    /// @notice Minimum time (in seconds) an address must wait between claims.
    uint256 public cooldownPeriod;

    /// @notice Timestamp of each address's most recent successful claim (0 = never claimed).
    mapping(address => uint256) public lastClaimedAt;

    event Claimed(address indexed claimer, uint256 amount, uint256 timestamp);
    event ClaimAmountUpdated(uint256 newClaimAmount);
    event CooldownPeriodUpdated(uint256 newCooldownPeriod);

    error CooldownNotElapsed(uint256 nextClaimAt);

    constructor(
        YDToken token_,
        uint256 claimAmount_,
        uint256 cooldownPeriod_
    ) Ownable(msg.sender) {
        token = token_;
        claimAmount = claimAmount_;
        cooldownPeriod = cooldownPeriod_;
    }

    /// @notice Claims `claimAmount` YDToken to the caller, subject to `cooldownPeriod` since the
    /// caller's last claim.
    function claim() external {
        uint256 nextClaimAt = lastClaimedAt[msg.sender] == 0
            ? 0
            : lastClaimedAt[msg.sender] + cooldownPeriod;
        if (block.timestamp < nextClaimAt) {
            revert CooldownNotElapsed(nextClaimAt);
        }

        lastClaimedAt[msg.sender] = block.timestamp;

        emit Claimed(msg.sender, claimAmount, block.timestamp);
        token.mint(msg.sender, claimAmount);
    }

    /// @notice Updates the per-claim amount. Owner-only.
    function setClaimAmount(uint256 newClaimAmount) external onlyOwner {
        claimAmount = newClaimAmount;
        emit ClaimAmountUpdated(newClaimAmount);
    }

    /// @notice Updates the cooldown period between claims. Owner-only.
    function setCooldownPeriod(uint256 newCooldownPeriod) external onlyOwner {
        cooldownPeriod = newCooldownPeriod;
        emit CooldownPeriodUpdated(newCooldownPeriod);
    }
}
