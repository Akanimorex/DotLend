import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

const LENDING_POOL_ADDRESS = "0xA7b4191aDE779bD96BCeF291cd4d809A7cd69b5B";
const USDC_ADDRESS         = "0xb924Dc33Ceaacbde696ED5EC3A70a6b6576c013c";
const SEED_AMOUNT          = ethers.parseUnits("100000", 6); // 100,000 USDC

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  console.log("Seeding LendingPool from:", deployer.address);

  const usdc = await ethers.getContractAt("MockUSDC", USDC_ADDRESS);
  const tx   = await usdc.mint(LENDING_POOL_ADDRESS, SEED_AMOUNT);
  await tx.wait();

  console.log("✓ Seeded LendingPool with 100,000 MockUSDC — tx:", tx.hash);
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
