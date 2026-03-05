// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILendingPool
/// @notice Interface for the Stablecoin Micro-Lending Protocol core contract
interface ILendingPool {
    // ============ Events ============

    event CollateralDeposited(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Liquidated(
        address indexed borrower,
        address indexed liquidator,
        uint256 debtRepaid,
        uint256 collateralSeized
    );

    // ============ Core Functions ============

    /// @notice Deposit WDOT as collateral
    /// @param amount Amount of WDOT to deposit (18 decimals)
    function depositCollateral(uint256 amount) external;

    /// @notice Borrow MockUSDC against deposited collateral
    /// @param amount Amount of USDC to borrow (6 decimals)
    function borrowStablecoin(uint256 amount) external;

    /// @notice Repay borrowed USDC plus accrued interest
    /// @param amount Amount of USDC to repay (6 decimals); excess capped at total debt
    function repayLoan(uint256 amount) external;

    /// @notice Withdraw WDOT collateral while keeping position adequately collateralized
    /// @param amount Amount of WDOT to withdraw (18 decimals)
    function withdrawCollateral(uint256 amount) external;

    /// @notice Liquidate an undercollateralized position
    /// @param borrower Address of the borrower whose position is underwater
    function liquidate(address borrower) external;

    // ============ View Functions ============

    /// @notice Returns the health factor of a user's position
    /// @param user Address to query
    /// @return Health factor scaled by 1e18 (1e18 = 1.0); type(uint256).max if no debt
    function getHealthFactor(address user) external view returns (uint256);

    /// @notice Returns a complete snapshot of a user's lending position
    /// @param user Address to query
    /// @return collateral  WDOT deposited (18 decimals)
    /// @return debt        Total USDC owed including accrued interest (6 decimals)
    /// @return healthFactor Health factor scaled by 1e18
    function getUserPosition(address user)
        external
        view
        returns (
            uint256 collateral,
            uint256 debt,
            uint256 healthFactor
        );
}
