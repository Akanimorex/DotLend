import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  LendingPool,
  MockUSDC,
  MockWDOT,
  MockPriceOracle,
} from "../typechain-types";

// ─── Helpers ────────────────────────────────────────────────────────────────

const parseUSDC = (n: string) => ethers.parseUnits(n, 6);
const parseWDOT = (n: string) => ethers.parseUnits(n, 18);

/** DOT price: $6.00 expressed with 8 decimals (Chainlink convention) */
const DOT_PRICE_6 = ethers.parseUnits("6", 8);

// ─── Test suite ─────────────────────────────────────────────────────────────

describe("LendingPool", function () {
  let pool:   LendingPool;
  let usdc:   MockUSDC;
  let wdot:   MockWDOT;
  let oracle: MockPriceOracle;

  let owner:     SignerWithAddress;
  let alice:     SignerWithAddress;
  let bob:       SignerWithAddress;
  let liquidator: SignerWithAddress;

  // ─── Deploy fresh contracts before every test ────────────────────────────

  beforeEach(async function () {
    [owner, alice, bob, liquidator] = await ethers.getSigners();

    usdc   = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
    wdot   = await (await ethers.getContractFactory("MockWDOT")).deploy(owner.address);
    oracle = await (await ethers.getContractFactory("MockPriceOracle")).deploy(
      owner.address,
      DOT_PRICE_6
    );
    pool = await (
      await ethers.getContractFactory("LendingPool")
    ).deploy(
      await wdot.getAddress(),
      await usdc.getAddress(),
      await oracle.getAddress(),
      owner.address
    );

    // Seed pool with 10,000 USDC liquidity
    await usdc.mint(await pool.getAddress(), parseUSDC("10000"));

    // Give test users 1,000 WDOT each
    await wdot.mint(alice.address, parseWDOT("1000"));
    await wdot.mint(bob.address,   parseWDOT("1000"));

    // Give liquidator 10,000 USDC for repayments
    await usdc.mint(liquidator.address, parseUSDC("10000"));

    // Approvals
    const poolAddr = await pool.getAddress();
    await wdot.connect(alice).approve(poolAddr, ethers.MaxUint256);
    await wdot.connect(bob).approve(poolAddr,   ethers.MaxUint256);
    await usdc.connect(alice).approve(poolAddr, ethers.MaxUint256);
    await usdc.connect(bob).approve(poolAddr,   ethers.MaxUint256);
    await usdc.connect(liquidator).approve(poolAddr, ethers.MaxUint256);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Deployment
  // ════════════════════════════════════════════════════════════════════════════

  describe("Deployment", function () {
    it("stores correct token addresses", async function () {
      expect(await pool.wdot()).to.equal(await wdot.getAddress());
      expect(await pool.stablecoin()).to.equal(await usdc.getAddress());
      expect(await pool.oracle()).to.equal(await oracle.getAddress());
    });

    it("sets correct protocol constants", async function () {
      expect(await pool.MIN_COLLATERAL_RATIO()).to.equal(150n);
      expect(await pool.LIQUIDATION_THRESHOLD()).to.equal(120n);
      expect(await pool.LIQUIDATION_BONUS()).to.equal(5n);
      expect(await pool.INTEREST_RATE()).to.equal(10n);
    });

    it("reverts constructor with zero addresses", async function () {
      const Factory = await ethers.getContractFactory("LendingPool");
      await expect(
        Factory.deploy(ethers.ZeroAddress, await usdc.getAddress(), await oracle.getAddress(), owner.address)
      ).to.be.revertedWith("LendingPool: zero wdot address");

      await expect(
        Factory.deploy(await wdot.getAddress(), ethers.ZeroAddress, await oracle.getAddress(), owner.address)
      ).to.be.revertedWith("LendingPool: zero stablecoin address");

      await expect(
        Factory.deploy(await wdot.getAddress(), await usdc.getAddress(), ethers.ZeroAddress, owner.address)
      ).to.be.revertedWith("LendingPool: zero oracle address");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. depositCollateral
  // ════════════════════════════════════════════════════════════════════════════

  describe("depositCollateral", function () {
    it("transfers WDOT into pool and updates position", async function () {
      const amount = parseWDOT("50");
      await pool.connect(alice).depositCollateral(amount);

      const [collateral] = await pool.getUserPosition(alice.address);
      expect(collateral).to.equal(amount);
      expect(await wdot.balanceOf(await pool.getAddress())).to.equal(amount);
    });

    it("accumulates multiple deposits", async function () {
      await pool.connect(alice).depositCollateral(parseWDOT("30"));
      await pool.connect(alice).depositCollateral(parseWDOT("20"));

      const [collateral] = await pool.getUserPosition(alice.address);
      expect(collateral).to.equal(parseWDOT("50"));
    });

    it("emits CollateralDeposited", async function () {
      const amount = parseWDOT("10");
      await expect(pool.connect(alice).depositCollateral(amount))
        .to.emit(pool, "CollateralDeposited")
        .withArgs(alice.address, amount);
    });

    it("reverts on zero amount", async function () {
      await expect(pool.connect(alice).depositCollateral(0)).to.be.revertedWith(
        "LendingPool: amount must be > 0"
      );
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. borrowStablecoin
  // ════════════════════════════════════════════════════════════════════════════

  describe("borrowStablecoin", function () {
    beforeEach(async function () {
      // Alice deposits 25 WDOT → worth $150 @ $6/DOT
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
    });

    it("allows borrow within 150% collateral ratio", async function () {
      // Max borrow = $150 / 1.5 = $100
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));

      const [, debt] = await pool.getUserPosition(alice.address);
      expect(debt).to.equal(parseUSDC("100"));
      expect(await usdc.balanceOf(alice.address)).to.equal(parseUSDC("100"));
    });

    it("emits Borrowed", async function () {
      await expect(pool.connect(alice).borrowStablecoin(parseUSDC("50")))
        .to.emit(pool, "Borrowed")
        .withArgs(alice.address, parseUSDC("50"));
    });

    it("reverts when over-borrowing (would breach 150% ratio)", async function () {
      // $100 is the max; attempt $101
      await expect(
        pool.connect(alice).borrowStablecoin(parseUSDC("101"))
      ).to.be.revertedWith("LendingPool: insufficient collateral (150% required)");
    });

    it("reverts without collateral", async function () {
      await expect(
        pool.connect(bob).borrowStablecoin(parseUSDC("10"))
      ).to.be.revertedWith("LendingPool: no collateral deposited");
    });

    it("reverts on zero amount", async function () {
      await expect(pool.connect(alice).borrowStablecoin(0)).to.be.revertedWith(
        "LendingPool: amount must be > 0"
      );
    });

    it("cumulative borrows are checked against collateral", async function () {
      await pool.connect(alice).borrowStablecoin(parseUSDC("50"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("50")); // total = $100 (exactly at limit)

      await expect(
        pool.connect(alice).borrowStablecoin(parseUSDC("1"))
      ).to.be.revertedWith("LendingPool: insufficient collateral (150% required)");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. repayLoan
  // ════════════════════════════════════════════════════════════════════════════

  describe("repayLoan", function () {
    beforeEach(async function () {
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));

      // Give alice extra USDC (minted to pool; pool already seeded — mint direct to alice)
      await usdc.mint(alice.address, parseUSDC("50")); // covers interest
    });

    it("reduces debt on partial repay", async function () {
      await pool.connect(alice).repayLoan(parseUSDC("40"));

      const [, debt] = await pool.getUserPosition(alice.address);
      expect(debt).to.equal(parseUSDC("60"));
    });

    it("clears debt fully and resets borrowTimestamp on full repay", async function () {
      await pool.connect(alice).repayLoan(parseUSDC("100"));

      const pos = await pool.positions(alice.address);
      expect(pos.debtAmount).to.equal(0n);
      expect(pos.borrowTimestamp).to.equal(0n);
    });

    it("caps repayment at total debt (overpay)", async function () {
      const before = await usdc.balanceOf(alice.address);
      await pool.connect(alice).repayLoan(parseUSDC("200")); // more than owed
      const after = await usdc.balanceOf(alice.address);

      // Only exactly 100 USDC should have been pulled (no interest since same block)
      expect(before - after).to.be.lte(parseUSDC("100") + 1n); // +1 for rounding
    });

    it("emits Repaid", async function () {
      await expect(pool.connect(alice).repayLoan(parseUSDC("100")))
        .to.emit(pool, "Repaid")
        .withArgs(alice.address, parseUSDC("100"));
    });

    it("reverts with no active debt", async function () {
      await expect(pool.connect(bob).repayLoan(parseUSDC("1"))).to.be.revertedWith(
        "LendingPool: no active debt"
      );
    });

    it("reverts on zero amount", async function () {
      await expect(pool.connect(alice).repayLoan(0)).to.be.revertedWith(
        "LendingPool: amount must be > 0"
      );
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. withdrawCollateral
  // ════════════════════════════════════════════════════════════════════════════

  describe("withdrawCollateral", function () {
    beforeEach(async function () {
      // Alice deposits 50 WDOT (worth $300) and borrows $100 USDC (300% ratio — lots of room)
      await pool.connect(alice).depositCollateral(parseWDOT("50"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));
    });

    it("allows partial withdrawal while keeping ratio ≥ 150%", async function () {
      // After withdrawing 25 WDOT: 25 WDOT = $150, debt = $100 → ratio = 150% exactly
      await pool.connect(alice).withdrawCollateral(parseWDOT("25"));

      const [collateral] = await pool.getUserPosition(alice.address);
      expect(collateral).to.equal(parseWDOT("25"));
    });

    it("emits CollateralWithdrawn", async function () {
      await expect(pool.connect(alice).withdrawCollateral(parseWDOT("10")))
        .to.emit(pool, "CollateralWithdrawn")
        .withArgs(alice.address, parseWDOT("10"));
    });

    it("reverts when withdrawal would breach 150% ratio", async function () {
      // 25 WDOT is the minimum needed; withdrawing 26 puts us below 150%
      await expect(
        pool.connect(alice).withdrawCollateral(parseWDOT("26"))
      ).to.be.revertedWith("LendingPool: withdrawal would undercollateralize position");
    });

    it("allows full withdrawal after full repayment", async function () {
      await usdc.mint(alice.address, parseUSDC("50")); // cover any interest
      await pool.connect(alice).repayLoan(parseUSDC("200")); // overpay → repays exactly the debt
      await pool.connect(alice).withdrawCollateral(parseWDOT("50"));

      const [collateral] = await pool.getUserPosition(alice.address);
      expect(collateral).to.equal(0n);
    });

    it("reverts on insufficient collateral balance", async function () {
      await expect(
        pool.connect(alice).withdrawCollateral(parseWDOT("51"))
      ).to.be.revertedWith("LendingPool: insufficient collateral balance");
    });

    it("reverts on zero amount", async function () {
      await expect(pool.connect(alice).withdrawCollateral(0)).to.be.revertedWith(
        "LendingPool: amount must be > 0"
      );
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. liquidate
  // ════════════════════════════════════════════════════════════════════════════

  describe("liquidate", function () {
    beforeEach(async function () {
      // Alice: 25 WDOT ($150) collateral, borrows $100 USDC — ratio = 150%
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));
    });

    it("liquidates an undercollateralized position and pays bonus to liquidator", async function () {
      // Add 3 more WDOT so Alice has 28 total: seizure stays within the available collateral
      await wdot.mint(alice.address, parseWDOT("3"));
      await wdot.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(alice).depositCollateral(parseWDOT("3")); // 28 WDOT total

      // Drop DOT to $4:  28 × $4 = $112 vs $100 debt → ratio 112% < 120% → liquidatable
      // HF = (112 × 100 × 1e18) / (100 × 120) = 0.9333e18 < 1e18 ✓
      await oracle.setPrice(ethers.parseUnits("4", 8));

      // Query exact debt (principal + any interest accrued during setup blocks)
      // and derive expected seizure from it so the test is always numerically exact
      const [, actualDebt] = await pool.getUserPosition(alice.address);
      const seizeValueUSD = (actualDebt * BigInt(1e12) * 105n) / 100n;
      const dotPrice      = ethers.parseUnits("4", 8);
      const expectedSeize = (seizeValueUSD * BigInt(1e8)) / dotPrice;

      const liquidatorWdotBefore = await wdot.balanceOf(liquidator.address);
      const liquidatorUsdcBefore = await usdc.balanceOf(liquidator.address);

      await pool.connect(liquidator).liquidate(alice.address);

      const liquidatorWdotAfter = await wdot.balanceOf(liquidator.address);
      const liquidatorUsdcAfter = await usdc.balanceOf(liquidator.address);

      // Liquidator spent exactly the actual debt
      expect(liquidatorUsdcBefore - liquidatorUsdcAfter).to.equal(actualDebt);

      // Liquidator received exactly the computed collateral seizure
      expect(liquidatorWdotAfter - liquidatorWdotBefore).to.equal(expectedSeize);

      // Alice's position is cleared; residual (28 − expectedSeize) returned to her
      // Alice's wallet: started with 1000, was minted 3 more, deposited 28 total
      // → wallet = (1000 + 3) − 28 + residual = 1003 − expectedSeize
      const [, debt] = await pool.getUserPosition(alice.address);
      expect(debt).to.equal(0n);
      expect(await wdot.balanceOf(alice.address)).to.equal(
        parseWDOT("1003") - expectedSeize
      );
    });

    it("returns residual collateral to borrower after liquidation", async function () {
      // Deposit more collateral so there is a remainder after seizure
      await wdot.mint(alice.address, parseWDOT("100"));
      await wdot.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(alice).depositCollateral(parseWDOT("100")); // now 125 WDOT total

      // Drop price so position becomes liquidatable
      await oracle.setPrice(ethers.parseUnits("1", 8)); // $1/DOT → $125 vs $100 debt → 125% < 150% (wait that's only for new borrows)
      // HF = (125 * 100 * 1e18) / (100 * 120) = 1.04e18  still > 1e18 (healthy) at $1/DOT
      // Need price where HF < 1: collateral * 100 < debt * 120
      // 125 * price * 100 < 100e6 * 1e12 * 120
      // 12500 * price < 12000e18 → price < 12000e18/12500 = 960e15 → price (8 dec) < 0.96e8 = 96000000
      await oracle.setPrice(ethers.parseUnits("0.9", 8)); // $0.90/DOT

      const aliceWdotBefore = await wdot.balanceOf(alice.address);

      await pool.connect(liquidator).liquidate(alice.address);

      // At $0.90/DOT, debt = $100, seize = $105 / $0.90 = 116.67 WDOT
      // 125 − 116.67 = 8.33 WDOT returned to Alice
      const aliceWdotAfter = await wdot.balanceOf(alice.address);
      expect(aliceWdotAfter).to.be.gt(aliceWdotBefore); // Alice got something back
    });

    it("emits Liquidated event", async function () {
      // Deposit 3 extra WDOT so Alice has 28 WDOT — seizure of 26.25 is within bounds
      await wdot.mint(alice.address, parseWDOT("3"));
      await wdot.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(alice).depositCollateral(parseWDOT("3"));

      await oracle.setPrice(ethers.parseUnits("4", 8));

      // Query actual debt and derive exact expected seizure so withArgs is numerically exact
      const [, actualDebt] = await pool.getUserPosition(alice.address);
      const seizeValueUSD  = (actualDebt * BigInt(1e12) * 105n) / 100n;
      const dotPrice       = ethers.parseUnits("4", 8);
      const expectedSeize  = (seizeValueUSD * BigInt(1e8)) / dotPrice;

      await expect(pool.connect(liquidator).liquidate(alice.address))
        .to.emit(pool, "Liquidated")
        .withArgs(
          alice.address,
          liquidator.address,
          actualDebt,
          expectedSeize
        );
    });

    it("reverts when trying to liquidate a healthy position", async function () {
      // Price is still $6; HF = (150*100*1e18)/(100*120) = 1.25e18 > 1e18
      await expect(
        pool.connect(liquidator).liquidate(alice.address)
      ).to.be.revertedWith("LendingPool: position is healthy");
    });

    it("reverts on double liquidation (position already cleared)", async function () {
      await oracle.setPrice(ethers.parseUnits("4", 8));
      await pool.connect(liquidator).liquidate(alice.address);

      // Position is gone; second liquidation attempt should fail
      await expect(
        pool.connect(liquidator).liquidate(alice.address)
      ).to.be.revertedWith("LendingPool: no debt to liquidate");
    });

    it("reverts with zero borrower address", async function () {
      await expect(
        pool.connect(liquidator).liquidate(ethers.ZeroAddress)
      ).to.be.revertedWith("LendingPool: zero borrower address");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 7. Health factor
  // ════════════════════════════════════════════════════════════════════════════

  describe("getHealthFactor", function () {
    it("returns max uint256 before any borrow", async function () {
      await pool.connect(alice).depositCollateral(parseWDOT("10"));
      expect(await pool.getHealthFactor(alice.address)).to.equal(ethers.MaxUint256);
    });

    it("returns correct HF after borrow at exactly 150% ratio", async function () {
      // 25 WDOT = $150, borrow $100
      // HF = (150e18 * 100 * 1e18) / (100e18 * 120) = 1.25e18
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));

      const hf = await pool.getHealthFactor(alice.address);
      expect(hf).to.equal(ethers.parseUnits("1.25", 18));
    });

    it("reflects price drop in health factor", async function () {
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));

      // Drop DOT to $4: collateral = $100
      // HF = (100e18 * 100 * 1e18) / (100e18 * 120) = 0.833...e18 < 1e18
      await oracle.setPrice(ethers.parseUnits("4", 8));

      const hf = await pool.getHealthFactor(alice.address);
      expect(hf).to.be.lt(ethers.parseUnits("1", 18));
    });

    it("drops below 1e18 at liquidation threshold (120% ratio)", async function () {
      // To be exactly at liquidation boundary: collateral value / debt value = 1.20
      // 20 WDOT @ $6 = $120; borrow $100 → ratio = 120%
      // HF = (120 * 100 * 1e18) / (100 * 120) = 1.0e18 (exactly at threshold, still healthy)
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));

      // Drop price to $4.80 → collateral = 25 * 4.8 = $120
      await oracle.setPrice(ethers.parseUnits("4.8", 8));

      const hf = await pool.getHealthFactor(alice.address);
      expect(hf).to.equal(ethers.parseUnits("1", 18));
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 8. Interest accrual
  // ════════════════════════════════════════════════════════════════════════════

  describe("Interest accrual", function () {
    it("accrues ~10% interest after 1 year", async function () {
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));

      // Advance 1 year (365 days)
      await time.increase(365 * 24 * 60 * 60);

      const [, debt] = await pool.getUserPosition(alice.address);

      // 10% APR on $100 = $10 interest → total ≈ $110
      // Use a small tolerance for timestamp precision (±1 block = a few seconds)
      const expectedDebt = parseUSDC("110");
      const tolerance    = parseUSDC("0.01"); // 1 cent tolerance

      expect(debt).to.be.gte(expectedDebt - tolerance);
      expect(debt).to.be.lte(expectedDebt + tolerance);
    });

    it("settles interest on borrow and resets timestamp", async function () {
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("50")); // borrow $50 first

      await time.increase(365 * 24 * 60 * 60); // 1 year passes

      // Alice borrows $1 more; this triggers _settleInterest internally
      // Give her 100 USDC for any future repayment
      await usdc.mint(alice.address, parseUSDC("100"));

      // Before second borrow we need headroom — deposit more collateral
      await wdot.mint(alice.address, parseWDOT("500"));
      await wdot.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(alice).depositCollateral(parseWDOT("500"));

      await pool.connect(alice).borrowStablecoin(parseUSDC("1"));

      const pos = await pool.positions(alice.address);
      // After settlement: debtAmount = ~$55 (50 + 5 interest) + $1 new borrow = ~$56
      expect(pos.debtAmount).to.be.gte(parseUSDC("55.9"));
      expect(pos.debtAmount).to.be.lte(parseUSDC("56.1"));
    });

    it("accrues correctly over multiple periods", async function () {
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));

      // Advance 6 months
      await time.increase(182 * 24 * 60 * 60);
      let [, debt1] = await pool.getUserPosition(alice.address);
      // ~5% interest after half a year
      expect(debt1).to.be.gte(parseUSDC("104.9"));
      expect(debt1).to.be.lte(parseUSDC("105.1"));

      // Advance another 6 months (total 1 year)
      await time.increase(183 * 24 * 60 * 60);
      let [, debt2] = await pool.getUserPosition(alice.address);
      // ~10% total interest
      expect(debt2).to.be.gte(parseUSDC("109.9"));
      expect(debt2).to.be.lte(parseUSDC("110.1"));
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 9. getUserPosition
  // ════════════════════════════════════════════════════════════════════════════

  describe("getUserPosition", function () {
    it("returns zero values for a fresh account", async function () {
      const [collateral, debt, hf] = await pool.getUserPosition(bob.address);
      expect(collateral).to.equal(0n);
      expect(debt).to.equal(0n);
      expect(hf).to.equal(ethers.MaxUint256);
    });

    it("returns live position with pending interest included", async function () {
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));
      await time.increase(365 * 24 * 60 * 60);

      const [collateral, debt, hf] = await pool.getUserPosition(alice.address);
      expect(collateral).to.equal(parseWDOT("25"));
      expect(debt).to.be.gt(parseUSDC("100")); // > 100 due to interest
      expect(hf).to.be.lt(ethers.parseUnits("1.25", 18)); // HF degraded
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 10. Edge cases
  // ════════════════════════════════════════════════════════════════════════════

  describe("Edge cases", function () {
    it("two independent users maintain separate positions", async function () {
      // Alice: 25 WDOT, borrows 100 USDC
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));

      // Bob: 50 WDOT, borrows 50 USDC
      await pool.connect(bob).depositCollateral(parseWDOT("50"));
      await pool.connect(bob).borrowStablecoin(parseUSDC("50"));

      const [aliceColl, aliceDebt] = await pool.getUserPosition(alice.address);
      const [bobColl, bobDebt]     = await pool.getUserPosition(bob.address);

      expect(aliceColl).to.equal(parseWDOT("25"));
      expect(aliceDebt).to.equal(parseUSDC("100"));
      expect(bobColl).to.equal(parseWDOT("50"));
      expect(bobDebt).to.equal(parseUSDC("50"));
    });

    it("cannot borrow 0 even with sufficient collateral", async function () {
      await pool.connect(alice).depositCollateral(parseWDOT("100"));
      await expect(pool.connect(alice).borrowStablecoin(0)).to.be.revertedWith(
        "LendingPool: amount must be > 0"
      );
    });

    it("deposit, full repay, then re-borrow works correctly", async function () {
      await pool.connect(alice).depositCollateral(parseWDOT("25"));
      await pool.connect(alice).borrowStablecoin(parseUSDC("100"));

      await usdc.mint(alice.address, parseUSDC("10")); // interest buffer
      await pool.connect(alice).repayLoan(parseUSDC("200")); // clear debt

      // Should be able to borrow again
      await pool.connect(alice).borrowStablecoin(parseUSDC("80"));
      const [, debt] = await pool.getUserPosition(alice.address);
      expect(debt).to.equal(parseUSDC("80"));
    });
  });
});
