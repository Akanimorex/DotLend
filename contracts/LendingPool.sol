// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/ILendingPool.sol";
import "./interfaces/IPriceOracle.sol";

/// @title LendingPool
/// @notice Core contract of the Stablecoin Micro-Lending Protocol on Polkadot Hub EVM.
///
///         Users deposit WDOT as collateral and borrow MockUSDC (or real USDC on mainnet)
///         against it. The protocol enforces:
///           - 150% minimum collateralization ratio to open / increase a borrow
///           - 120% liquidation threshold — positions below this ratio are liquidatable
///           - 10% fixed APR (simple interest), accrued lazily on every state-changing call
///           - 5%  liquidation bonus paid to the liquidator in seized WDOT
///
///         Health Factor (HF) convention (standard DeFi / Aave-style):
///           HF = (collateralValueUSD × 100 × 1e18) / (debtValueUSD × LIQUIDATION_THRESHOLD)
///           HF ≥ 1e18  →  position is healthy
///           HF <  1e18  →  position is liquidatable
///
/// @dev Uses OpenZeppelin ReentrancyGuard and Ownable.
///      All token transfers go through SafeERC20.
///      Solidity 0.8 native overflow protection — no SafeMath needed.
contract LendingPool is ILendingPool, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Immutables ============

    /// @notice Wrapped DOT token used as collateral (18 decimals)
    IERC20 public immutable wdot;

    /// @notice Stablecoin users borrow against their WDOT collateral (6 decimals)
    IERC20 public immutable stablecoin;

    /// @notice Price oracle returning DOT/USD with 8 decimal places
    IPriceOracle public immutable oracle;

    // ============ Protocol Constants ============

    /// @notice Minimum collateral ratio required to borrow (150%)
    uint256 public constant MIN_COLLATERAL_RATIO = 150;

    /// @notice Ratio at which a position becomes liquidatable (120%)
    uint256 public constant LIQUIDATION_THRESHOLD = 120;

    /// @notice Bonus collateral awarded to liquidators expressed as a percentage (5%)
    uint256 public constant LIQUIDATION_BONUS = 5;

    /// @notice Annual interest rate (10% APR, simple interest)
    uint256 public constant INTEREST_RATE = 10;

    /// @notice Denominator for percentage-based constants
    uint256 public constant RATE_PRECISION = 100;

    /// @notice Oracle price decimals (8, Chainlink-compatible)
    uint256 public constant ORACLE_PRICE_DECIMALS = 1e8;

    /// @notice Multiplier to normalise USDC (6 dec) amounts to 18-decimal USD values
    uint256 public constant USDC_DECIMAL_FACTOR = 1e12;

    // ============ Position Storage ============

    /// @dev Tracks each user's collateral, settled debt, and interest-accrual anchor
    struct Position {
        /// @dev WDOT deposited (18 decimals)
        uint256 collateralAmount;
        /// @dev Principal + all previously settled interest (6 decimals, USDC)
        uint256 debtAmount;
        /// @dev Timestamp of the last interest settlement; 0 when no debt
        uint256 borrowTimestamp;
    }

    /// @notice Returns the raw on-chain position for a user (debt does NOT include pending interest)
    mapping(address => Position) public positions;

    // ============ Constructor ============

    /// @param _wdot         Address of the WDOT ERC-20 token
    /// @param _stablecoin   Address of the stablecoin ERC-20 (MockUSDC or real USDC)
    /// @param _oracle       Address of an IPriceOracle-compatible price feed
    /// @param initialOwner  Protocol admin
    constructor(
        address _wdot,
        address _stablecoin,
        address _oracle,
        address initialOwner
    ) Ownable(initialOwner) {
        require(_wdot != address(0), "LendingPool: zero wdot address");
        require(_stablecoin != address(0), "LendingPool: zero stablecoin address");
        require(_oracle != address(0), "LendingPool: zero oracle address");

        wdot = IERC20(_wdot);
        stablecoin = IERC20(_stablecoin);
        oracle = IPriceOracle(_oracle);
    }

    // ============ External State-Changing Functions ============

    /// @notice Deposit WDOT as collateral.
    ///         Caller must have approved this contract to spend `amount` of WDOT.
    /// @param amount Amount of WDOT to deposit (18 decimals)
    function depositCollateral(uint256 amount) external override nonReentrant {
        require(amount > 0, "LendingPool: amount must be > 0");

        positions[msg.sender].collateralAmount += amount;
        wdot.safeTransferFrom(msg.sender, address(this), amount);

        emit CollateralDeposited(msg.sender, amount);
    }

    /// @notice Borrow stablecoin against deposited WDOT collateral.
    ///         Collateral ratio after borrow must be ≥ 150%.
    ///         Caller must have collateral deposited.
    /// @param amount Amount of stablecoin to borrow (6 decimals)
    function borrowStablecoin(uint256 amount) external override nonReentrant {
        require(amount > 0, "LendingPool: amount must be > 0");

        Position storage pos = positions[msg.sender];
        require(pos.collateralAmount > 0, "LendingPool: no collateral deposited");

        // Crystallise pending interest before modifying the position
        _settleInterest(msg.sender);

        uint256 newTotalDebt = pos.debtAmount + amount;

        // Verify the resulting collateral ratio is at least 150%
        uint256 collateralValueUSD = _collateralValueUSD(pos.collateralAmount);
        uint256 newDebtValueUSD    = _debtValueUSD(newTotalDebt);

        require(
            collateralValueUSD * RATE_PRECISION >= newDebtValueUSD * MIN_COLLATERAL_RATIO,
            "LendingPool: insufficient collateral (150% required)"
        );

        pos.debtAmount = newTotalDebt;

        // Only set borrowTimestamp on the first borrow
        if (pos.borrowTimestamp == 0) {
            pos.borrowTimestamp = block.timestamp;
        }

        stablecoin.safeTransfer(msg.sender, amount);

        emit Borrowed(msg.sender, amount);
    }

    /// @notice Repay some or all of the outstanding debt (principal + accrued interest).
    ///         Any overpayment is automatically capped at the exact total owed.
    ///         Caller must have approved this contract to spend `amount` of stablecoin.
    /// @param amount Amount of stablecoin to repay (6 decimals)
    function repayLoan(uint256 amount) external override nonReentrant {
        require(amount > 0, "LendingPool: amount must be > 0");

        Position storage pos = positions[msg.sender];
        require(pos.debtAmount > 0, "LendingPool: no active debt");

        // Crystallise interest so pos.debtAmount reflects the full amount owed
        _settleInterest(msg.sender);

        uint256 totalDebt  = pos.debtAmount;
        uint256 actualRepay = amount > totalDebt ? totalDebt : amount;

        stablecoin.safeTransferFrom(msg.sender, address(this), actualRepay);

        pos.debtAmount -= actualRepay;

        if (pos.debtAmount == 0) {
            pos.borrowTimestamp = 0;
        }

        emit Repaid(msg.sender, actualRepay);
    }

    /// @notice Withdraw WDOT collateral.
    ///         If the user has outstanding debt, the remaining collateral must still satisfy
    ///         the 150% minimum collateral ratio after the withdrawal.
    /// @param amount Amount of WDOT to withdraw (18 decimals)
    function withdrawCollateral(uint256 amount) external override nonReentrant {
        require(amount > 0, "LendingPool: amount must be > 0");

        Position storage pos = positions[msg.sender];
        require(pos.collateralAmount >= amount, "LendingPool: insufficient collateral balance");

        uint256 newCollateral = pos.collateralAmount - amount;

        if (pos.debtAmount > 0) {
            // Use the full pending debt (including un-settled interest) for safety
            uint256 totalDebt          = _pendingTotalDebt(msg.sender);
            uint256 newCollateralValue = _collateralValueUSD(newCollateral);
            uint256 debtValue          = _debtValueUSD(totalDebt);

            require(
                newCollateralValue * RATE_PRECISION >= debtValue * MIN_COLLATERAL_RATIO,
                "LendingPool: withdrawal would undercollateralize position"
            );
        }

        pos.collateralAmount = newCollateral;
        wdot.safeTransfer(msg.sender, amount);

        emit CollateralWithdrawn(msg.sender, amount);
    }

    /// @notice Liquidate an undercollateralized position (HF < 1e18).
    ///         The caller (liquidator) repays the borrower's full debt and receives
    ///         the equivalent WDOT value plus a 5% bonus. Any leftover collateral is
    ///         returned to the borrower.
    ///         Caller must have approved this contract to spend the borrower's total debt.
    /// @param borrower Address of the under-collateralised borrower
    function liquidate(address borrower) external override nonReentrant {
        require(borrower != address(0), "LendingPool: zero borrower address");

        Position storage pos = positions[borrower];
        require(pos.debtAmount > 0, "LendingPool: no debt to liquidate");

        // Crystallise interest before the health check
        _settleInterest(borrower);

        uint256 totalDebt = pos.debtAmount;
        uint256 hf        = _computeHealthFactor(pos.collateralAmount, totalDebt);
        require(hf < 1e18, "LendingPool: position is healthy");

        // Collateral value to seize = debt value × (1 + bonus%)
        uint256 debtValueUSD         = _debtValueUSD(totalDebt);                          // 18 dec
        uint256 seizeValueUSD        = (debtValueUSD * (RATE_PRECISION + LIQUIDATION_BONUS)) / RATE_PRECISION;
        uint256 dotPrice             = oracle.getPrice();                                  // 8 dec
        // seize (18 dec) = seizeValueUSD (18 dec) × ORACLE_PRICE_DECIMALS / dotPrice (8 dec)
        uint256 collateralToSeize    = (seizeValueUSD * ORACLE_PRICE_DECIMALS) / dotPrice;

        // Never seize more than what the borrower actually has
        if (collateralToSeize > pos.collateralAmount) {
            collateralToSeize = pos.collateralAmount;
        }

        uint256 remainingCollateral = pos.collateralAmount - collateralToSeize;

        // Clear the borrower's position before external calls (CEI pattern)
        delete positions[borrower];

        // Pull repayment from the liquidator
        stablecoin.safeTransferFrom(msg.sender, address(this), totalDebt);

        // Pay out seized collateral to the liquidator
        wdot.safeTransfer(msg.sender, collateralToSeize);

        // Return any residual collateral to the borrower
        if (remainingCollateral > 0) {
            wdot.safeTransfer(borrower, remainingCollateral);
        }

        emit Liquidated(borrower, msg.sender, totalDebt, collateralToSeize);
    }

    // ============ External View Functions ============

    /// @inheritdoc ILendingPool
    function getHealthFactor(address user) external view override returns (uint256) {
        Position storage pos = positions[user];
        if (pos.debtAmount == 0) return type(uint256).max;

        uint256 totalDebt = _pendingTotalDebt(user);
        return _computeHealthFactor(pos.collateralAmount, totalDebt);
    }

    /// @inheritdoc ILendingPool
    function getUserPosition(address user)
        external
        view
        override
        returns (
            uint256 collateral,
            uint256 debt,
            uint256 healthFactor
        )
    {
        Position storage pos = positions[user];
        collateral   = pos.collateralAmount;
        debt         = _pendingTotalDebt(user);
        healthFactor = debt == 0
            ? type(uint256).max
            : _computeHealthFactor(collateral, debt);
    }

    // ============ Internal Helpers ============

    /// @dev Accrues pending simple interest into pos.debtAmount and resets borrowTimestamp.
    ///      Must be called before every state change that touches debt.
    function _settleInterest(address user) internal {
        Position storage pos = positions[user];
        if (pos.debtAmount == 0 || pos.borrowTimestamp == 0) return;

        uint256 timeElapsed = block.timestamp - pos.borrowTimestamp;
        if (timeElapsed == 0) return;

        // Simple interest: I = P × r × t / (365d × 100)
        uint256 interest = (pos.debtAmount * INTEREST_RATE * timeElapsed) /
            (365 days * RATE_PRECISION);

        pos.debtAmount      += interest;
        pos.borrowTimestamp  = block.timestamp;
    }

    /// @dev Read-only view of total debt including interest not yet settled to storage.
    function _pendingTotalDebt(address user) internal view returns (uint256) {
        Position storage pos = positions[user];
        if (pos.debtAmount == 0 || pos.borrowTimestamp == 0) return 0;

        uint256 timeElapsed = block.timestamp - pos.borrowTimestamp;
        uint256 interest    = (pos.debtAmount * INTEREST_RATE * timeElapsed) /
            (365 days * RATE_PRECISION);

        return pos.debtAmount + interest;
    }

    /// @dev Returns the USD value of `collateralAmount` WDOT normalised to 18 decimals.
    ///      collateralAmount (18 dec) × dotPrice (8 dec) / 1e8 = USD value (18 dec)
    function _collateralValueUSD(uint256 collateralAmount) internal view returns (uint256) {
        return (collateralAmount * oracle.getPrice()) / ORACLE_PRICE_DECIMALS;
    }

    /// @dev Returns the USD value of `debtAmount` stablecoin normalised to 18 decimals.
    ///      Assumes stablecoin is pegged at $1; converts 6-decimal USDC → 18-decimal USD.
    function _debtValueUSD(uint256 debtAmount) internal pure returns (uint256) {
        return debtAmount * USDC_DECIMAL_FACTOR;
    }

    /// @dev Computes the health factor for a given (collateral, debt) pair.
    ///      HF = (collateralValueUSD × 100 × 1e18) / (debtValueUSD × LIQUIDATION_THRESHOLD)
    ///      Returns type(uint256).max when debt is zero.
    function _computeHealthFactor(uint256 collateralAmount, uint256 debtAmount)
        internal
        view
        returns (uint256)
    {
        if (debtAmount == 0) return type(uint256).max;

        uint256 collateralValueUSD = _collateralValueUSD(collateralAmount);
        uint256 debtValueUSD       = _debtValueUSD(debtAmount);

        return (collateralValueUSD * RATE_PRECISION * 1e18) /
               (debtValueUSD * LIQUIDATION_THRESHOLD);
    }
}
