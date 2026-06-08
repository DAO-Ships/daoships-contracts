/**
 * Deploy TimelockNavigator
 *
 * Wraps DAOShip.setGovernanceConfig behind a mandatory delay. A passed proposal queues
 * a parameter change here; after `delay` seconds anyone may execute it (a second ragequit
 * window). Holds GOVERNOR (4) permission, so — unlike SignalNavigator — it MUST be
 * registered via a governance proposal that calls setNavigators([thisNav],[4]).
 *
 * IMPORTANT (advisory, not enforced): the timelock cannot be made mandatory on-chain. A
 * proposal can still bypass it by calling setGovernanceConfig directly via
 * executeAsGovernance. Enforce "route config changes through the timelock" in the app, and
 * have the indexer elevate a warning on any proposal that bypasses it on a timelock-enabled DAO.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/007_deploy_timelock_navigator.ts --network cyprus1
 *
 * Configuration (.env or .env.e2e):
 *   - DAOSHIP_ADDRESS          (required) deployed DAO clone (not the singleton)
 *   - TIMELOCK_DELAY           (default: 172800)  delay in seconds (1h..30d). 48h default.
 *   - TIMELOCK_EXPIRY_WINDOW   (default: 604800)  executable window after delay (1h..3650d). 7d default.
 *   - TIMELOCK_NAME / TIMELOCK_DESCRIPTION
 */

import hre from "hardhat";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import { HttpNetworkConfig } from "hardhat/types";

const TimelockNavigatorJson = require("../../artifacts/contracts/navigators/TimelockNavigator.sol/TimelockNavigator.json");

const HOUR = 3600;
const DAY = 86400;

async function main() {
  console.log("\n🧭 Deploying TimelockNavigator\n" + "=".repeat(80));

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

  const delay = process.env.TIMELOCK_DELAY || String(2 * DAY);
  const expiryWindow = process.env.TIMELOCK_EXPIRY_WINDOW || String(7 * DAY);
  if (BigInt(delay) < BigInt(HOUR)) throw new Error("TIMELOCK_DELAY must be >= 3600 (1 hour)");
  if (BigInt(delay) > BigInt(30 * DAY)) throw new Error("TIMELOCK_DELAY must be <= 2592000 (30 days)");
  if (BigInt(expiryWindow) < BigInt(HOUR)) throw new Error("TIMELOCK_EXPIRY_WINDOW must be >= 3600 (1 hour)");
  if (BigInt(expiryWindow) > BigInt(3650 * DAY)) throw new Error("TIMELOCK_EXPIRY_WINDOW must be <= 315360000 (3650 days)");

  const cfg = {
    delay,
    expiryWindow,
    name: process.env.TIMELOCK_NAME || "TimelockNavigator",
    description: process.env.TIMELOCK_DESCRIPTION || "",
  };

  console.log(`\n   Deployer: ${wallet.address}`);
  console.log(`   DAOShip:  ${daoShipAddress}`);
  console.log(`   Config:`, cfg);

  const ipfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(TimelockNavigatorJson.bytecode);
  const factory = new quais.ContractFactory(TimelockNavigatorJson.abi, TimelockNavigatorJson.bytecode, wallet, ipfsHash);
  const nav = await factory.deploy(daoShipAddress, cfg.delay, cfg.expiryWindow, cfg.name, cfg.description);
  await nav.waitForDeployment();
  const navAddress = await nav.getAddress();
  console.log(`\n   ✅ TimelockNavigator: ${navAddress}`);

  const timestamp = Date.now();
  const deploymentsDir = path.join(__dirname, "../../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(deploymentsDir, `deployment-timelock-navigator-${timestamp}.json`),
    JSON.stringify(
      { network: hre.network.name, timestamp, deployer: wallet.address, daoShip: daoShipAddress, contracts: { TimelockNavigator: navAddress }, configuration: cfg },
      null,
      2
    )
  );

  console.log("\n📝 NEXT STEP — register as a GOVERNOR navigator via a governance proposal:");
  console.log(`      setNavigators(["${navAddress}"], [4])   // 4 = GOVERNOR`);
  console.log("   Then route governance-config changes through queueChange (advisory — see script header).");
  console.log("=".repeat(80) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  });
