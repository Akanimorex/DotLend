import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer address :", deployer.address);
  console.log("Network          :", (await ethers.provider.getNetwork()).name);
  console.log();

  // ── Resolve or deploy WDOT ─────────────────────────────────────────────────
  let wdotAddress: string | undefined = process.env.WDOT_ADDRESS;

  if (!wdotAddress) {
    console.log("WDOT_ADDRESS not set → deploying MockWDOT…");
    const MockWDOT = await ethers.getContractFactory("MockWDOT");
    const mockWDOT = await MockWDOT.deploy(deployer.address);
    await mockWDOT.waitForDeployment();
    wdotAddress = await mockWDOT.getAddress();
    console.log("  MockWDOT deployed to:", wdotAddress);
  } else {
    console.log("  Using existing WDOT at:", wdotAddress);
  }

  // ── Resolve or deploy MockUSDC ─────────────────────────────────────────────
  let usdcAddress: string | undefined = process.env.USDC_ADDRESS;

  if (!usdcAddress) {
    console.log("USDC_ADDRESS not set → deploying MockUSDC…");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const mockUSDC = await MockUSDC.deploy(deployer.address);
    await mockUSDC.waitForDeployment();
    usdcAddress = await mockUSDC.getAddress();
    console.log("  MockUSDC deployed to:", usdcAddress);
  } else {
    console.log("  Using existing USDC at:", usdcAddress);
  }

  // ── Resolve or deploy MockPriceOracle ──────────────────────────────────────
  let oracleAddress: string | undefined = process.env.ORACLE_ADDRESS;

  if (!oracleAddress) {
    console.log("ORACLE_ADDRESS not set → deploying MockPriceOracle…");
    const initialDotPriceUSD = ethers.parseUnits("6", 8); // $6.00 with 8 decimals
    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    const oracle = await MockPriceOracle.deploy(deployer.address, initialDotPriceUSD);
    await oracle.waitForDeployment();
    oracleAddress = await oracle.getAddress();
    console.log("  MockPriceOracle deployed to:", oracleAddress, "(initial price: $6.00)");
  } else {
    console.log("  Using existing oracle at:", oracleAddress);
  }

  // ── Deploy LendingPool ─────────────────────────────────────────────────────
  console.log("\nDeploying LendingPool…");
  const LendingPool = await ethers.getContractFactory("LendingPool");
  const lendingPool = await LendingPool.deploy(
    wdotAddress,
    usdcAddress,
    oracleAddress,
    deployer.address
  );
  await lendingPool.waitForDeployment();
  const lendingPoolAddress = await lendingPool.getAddress();
  console.log("  LendingPool deployed to:", lendingPoolAddress);

  // ── Seed liquidity when using mocks ───────────────────────────────────────
  if (!process.env.USDC_ADDRESS) {
    const seedAmount = ethers.parseUnits("100000", 6); // 100,000 MockUSDC
    const mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress);
    const tx = await mockUSDC.mint(lendingPoolAddress, seedAmount);
    await tx.wait();
    console.log("  Seeded LendingPool with 100,000 MockUSDC");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════");
  console.log("  Deployment complete");
  console.log("════════════════════════════════════════");
  console.log("  WDOT         :", wdotAddress);
  console.log("  USDC         :", usdcAddress);
  console.log("  Oracle       :", oracleAddress);
  console.log("  LendingPool  :", lendingPoolAddress);
  console.log("════════════════════════════════════════\n");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
