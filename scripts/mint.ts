import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

// ── Deployed addresses ──────────────────────────────────────────────────────
const WDOT_ADDRESS  = "0x3aB375b76E7EE81b6bF0828496bD4EA9ea03Ad95";
const USDC_ADDRESS  = "0x6eadc1da36FeB2A4307027E520977Fdc2A50702b";

// ── How much to mint ────────────────────────────────────────────────────────
const WDOT_AMOUNT = ethers.parseUnits("1000", 18);   // 1,000 WDOT  (18 dec)
const USDC_AMOUNT = ethers.parseUnits("5000", 6);    // 5,000 USDC  (6 dec)

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  console.log("Minting to:", deployer.address);

  const wdot = await ethers.getContractAt("MockWDOT", WDOT_ADDRESS);
  const usdc = await ethers.getContractAt("MockUSDC", USDC_ADDRESS);

  console.log("Minting 1,000 WDOT…");
  const tx1 = await wdot.mint(deployer.address, WDOT_AMOUNT);
  await tx1.wait();
  console.log("  ✓ WDOT minted — tx:", tx1.hash);

  console.log("Minting 5,000 USDC…");
  const tx2 = await usdc.mint(deployer.address, USDC_AMOUNT);
  await tx2.wait();
  console.log("  ✓ USDC minted — tx:", tx2.hash);

  console.log("\nDone! Your wallet now has 1,000 WDOT and 5,000 USDC for testing.");
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
