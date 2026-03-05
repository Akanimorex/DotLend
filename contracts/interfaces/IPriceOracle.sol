// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPriceOracle
/// @notice Interface for a DOT/USD price oracle, compatible with Chainlink-style feeds
interface IPriceOracle {
    /// @notice Returns the latest DOT price in USD
    /// @return price Price with 8 decimal places (e.g. 600000000 = $6.00)
    function getPrice() external view returns (uint256 price);
}
