// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockWDOT
/// @notice Wrapped DOT mock for local and testnet development.
///         On mainnet/Polkadot Hub, replace with the real WDOT ERC-20 address via WDOT_ADDRESS in .env
contract MockWDOT is ERC20, Ownable {
    constructor(address initialOwner)
        ERC20("Wrapped DOT", "WDOT")
        Ownable(initialOwner)
    {}

    /// @notice 18 decimals matching DOT's native precision on Polkadot Hub EVM
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// @notice Mint WDOT — for testing and initial liquidity bootstrapping only
    /// @param to      Recipient address
    /// @param amount  Amount to mint (18 decimals)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
