/**
 * Deploy BudgetNavigator
 *
 * Treasury-disbursement navigator. Governance approves a recurring spending budget
 * (per-budget manager, per-period allowance, lifetime ceiling) and the manager pays
 * out from the vault WITHOUT a proposal per payment. Holds NO DAOShip permission —
 * its only privilege is being an ENABLED MODULE on the vault.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/009_deploy_budget_navigator.ts --network cyprus1
 *
 * Configuration (.env or .env.e2e):
 *   - DAOSHIP_ADDRESS        (required) deployed DAO clone (not the singleton)
 *   - BUDGET_NAME / BUDGET_DESCRIPTION
 *
 * No numeric config: per-budget terms (manager, token, allowancePerPeriod, totalCeiling,
 * periodLength, start/end) are set at createBudget time by governance, not baked in.
 */

import hre from "hardhat";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import { HttpNetworkConfig } from "hardhat/types";

const BudgetNavigatorJson = require("../../artifacts/contracts/navigators/BudgetNavigator.sol/BudgetNavigator.json");

async function main() {
  console.log("\n🧭 Deploying BudgetNavigator\n" + "=".repeat(80));

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
    name: process.env.BUDGET_NAME || "BudgetNavigator",
    description: process.env.BUDGET_DESCRIPTION || "",
  };

  console.log(`\n   Deployer: ${wallet.address}`);
  console.log(`   DAOShip:  ${daoShipAddress}`);
  console.log(`   Config:`, cfg);

  const ipfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(BudgetNavigatorJson.bytecode);
  const factory = new quais.ContractFactory(BudgetNavigatorJson.abi, BudgetNavigatorJson.bytecode, wallet, ipfsHash);
  const nav = await factory.deploy(daoShipAddress, cfg.name, cfg.description);
  await nav.waitForDeployment();
  const navAddress = await nav.getAddress();
  console.log(`\n   ✅ BudgetNavigator: ${navAddress}`);

  const timestamp = Date.now();
  const deploymentsDir = path.join(__dirname, "../../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(deploymentsDir, `deployment-budget-navigator-${timestamp}.json`),
    JSON.stringify(
      { network: hre.network.name, timestamp, deployer: wallet.address, daoShip: daoShipAddress, contracts: { BudgetNavigator: navAddress }, configuration: cfg },
      null,
      2
    )
  );

  console.log("\n📝 NEXT STEP — enable as a VAULT MODULE via a governance proposal:");
  console.log(`      vault.enableModule("${navAddress}")   // NOT setNavigators — Budget holds no DAOShip permission`);
  console.log("   The proposal batch runs in the vault's context, so the self-call to enableModule is authorized.");
  console.log("   Then create budgets via governance: createBudget(manager, token, allowancePerPeriod, totalCeiling, periodLength, start, end).");
  console.log("=".repeat(80) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  });
