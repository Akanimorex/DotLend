// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockUSDC
/// @notice A mintable ERC-20 mock stablecoin for testnet use, mirroring USDC's 6-decimal standard
contract MockUSDC is ERC20, Ownable {
    mapping(address => uint256) public lastMint;
    uint256 public constant FAUCET_AMOUNT = 1000 * 1e6; // 1,000 USDC
    uint256 public constant COOLDOWN = 1 days;

    constructor(address initialOwner)
        ERC20("Mock USD Coin", "mUSDC")
        Ownable(initialOwner)
    {}

    /// @notice Returns 6 decimals to match the real USDC standard
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint tokens — callable only by the owner (protocol deployer / LendingPool funder)
    /// @param to      Recipient address
    /// @param amount  Amount to mint (6 decimals)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Public faucet for testnet users
    function faucet() external {
        require(block.timestamp >= lastMint[msg.sender] + COOLDOWN, "MockUSDC: Faucet cooldown active");
        lastMint[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
