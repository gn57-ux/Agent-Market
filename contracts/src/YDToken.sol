// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title YDToken
/// @notice Standard test ERC-20 token for the Agent Market testnet/local environment.
/// @dev Owner-mintable so that YDFaucet (or test scripts) can distribute test tokens.
///      Not intended to represent a real asset or to be deployed to mainnet.
contract YDToken is ERC20, Ownable {
    /// @param initialSupplyReceiver Address to receive the initial supply minted at deployment.
    /// @param initialSupply Amount (in wei, 18 decimals) minted to `initialSupplyReceiver` at deployment.
    constructor(
        address initialSupplyReceiver,
        uint256 initialSupply
    ) ERC20("Yidian Token", "YD") Ownable(msg.sender) {
        if (initialSupply > 0) {
            _mint(initialSupplyReceiver, initialSupply);
        }
    }

    /// @notice Mints `amount` tokens to `to`. Restricted to the owner (e.g. deployer or YDFaucet
    /// once granted ownership) so test-network distribution stays controlled.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
