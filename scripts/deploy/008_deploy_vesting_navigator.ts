/**
 * Deploy VestingNavigator
 *
 * Mints shares or loot on a cliff + linear vesting schedule. Tokens are minted incrementally
 * as they vest (nothing up front). Holds MANAGER (2) permission, so it MUST be registered via
 * a governance proposal that calls setNavigators([thisNav],[2]). Schedules are then created by
 * governance (avatar) via createSchedule; beneficiaries call claim() as tokens vest.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/008_deploy_vesting_navigator.ts --network cyprus1
 *
 * Configuration (.env or .env.e2e):
 *   - DAOSHIP_ADDRESS        (required) deployed DAO clone (not the singleton)
 *   - VESTING_NAME / VESTING_DESCRIPTION
 *
 * No numeric config: per-schedule terms (amount, cliff, vesting, isLoot) are set at
 * createSchedule time by governance, not baked into the navigator.
 */

import hre from "hardhat";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import { HttpNetworkConfig } from "hardhat/types";

const VestingNavigatorJson = require("../../artifacts/contracts/navigators/VestingNavigator.sol/VestingNavigator.json");

async function main() {
  console.log("\n🧭 Deploying VestingNavigator\n" + "=".repeat(80));

  const networkConfig = hre.network.config as HttpNetworkConfig;
  const provider = new quais.JsonRpcProvider(networkConfig.url, undefined, { usePathing: true });
  const accounts = networkConfig.accounts as string[];
  if (!accounts || !accounts[0]) throw new Error("CYPRUS1_PK not set in .env");

  let privateKey = accounts[0].trim();
  if (!privateKey.startsWith("0x")) privateKey = "0x" + privateKey;
  if (privateKey.length !== 66) throw new Error(`Invalid private key length: ${privateKey.length}`);
  const wallet = new quais.Wallet(privateKey, provider);

  const daoShipAddress = process.env.DAOSHIP_ADDRESS;
  if (!daoShipAddress) throw new Error("DAOSHIP_ADDRESS not set (deployed DAO clone, not the singleton)");

  const cfg = {
    name: process.env.VESTING_NAME || "VestingNavigator",
    description: process.env.VESTING_DESCRIPTION || "",
  };

  console.log(`\n   Deployer: ${wallet.address}`);
  console.log(`   DAOShip:  ${daoShipAddress}`);
  console.log(`   Config:`, cfg);

  const ipfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(VestingNavigatorJson.bytecode);
  const factory = new quais.ContractFactory(VestingNavigatorJson.abi, VestingNavigatorJson.bytecode, wallet, ipfsHash);
  const nav = await factory.deploy(daoShipAddress, cfg.name, cfg.description);
  await nav.waitForDeployment();
  const navAddress = await nav.getAddress();
  console.log(`\n   ✅ VestingNavigator: ${navAddress}`);

  const timestamp = Date.now();
  const deploymentsDir = path.join(__dirname, "../../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(deploymentsDir, `deployment-vesting-navigator-${timestamp}.json`),
    JSON.stringify(
      { network: hre.network.name, timestamp, deployer: wallet.address, daoShip: daoShipAddress, contracts: { VestingNavigator: navAddress }, configuration: cfg },
      null,
      2
    )
  );

  console.log("\n📝 NEXT STEP — register as a MANAGER navigator via a governance proposal:");
  console.log(`      setNavigators(["${navAddress}"], [2])   // 2 = MANAGER`);
  console.log("   Then create schedules via governance: createSchedule(beneficiary, amount, start, cliff, vesting, isLoot).");
  console.log("=".repeat(80) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  });
