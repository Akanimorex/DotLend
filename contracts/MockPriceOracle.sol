// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IPriceOracle.sol";

/// @title MockPriceOracle
/// @notice A settable DOT/USD price oracle for testnet.
///         Implements IPriceOracle so it can be swapped for a Chainlink or other real feed
///         without any changes to the LendingPool.
contract MockPriceOracle is IPriceOracle, Ownable {
    /// @notice Current DOT/USD price with 8 decimal places (Chainlink convention)
    uint256 private _price;

    event PriceUpdated(uint256 oldPrice, uint256 newPrice);

    /// @param initialOwner  Address that can update the price
    /// @param initialPrice  Starting DOT/USD price (8 decimals, e.g. 600000000 = $6.00)
    constructor(address initialOwner, uint256 initialPrice)
        Ownable(initialOwner)
    {
        require(initialPrice > 0, "Price must be > 0");
        _price = initialPrice;
    }

    /// @inheritdoc IPriceOracle
    function getPrice() external view override returns (uint256) {
        return _price;
    }

    /// @notice Update the DOT/USD price — owner only, for test scenario manipulation
    /// @param newPrice New price with 8 decimal places
    function setPrice(uint256 newPrice) external onlyOwner {
        require(newPrice > 0, "Price must be > 0");
        emit PriceUpdated(_price, newPrice);
        _price = newPrice;
    }
}
