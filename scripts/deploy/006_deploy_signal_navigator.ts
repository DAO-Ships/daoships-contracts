/**
 * Deploy SignalNavigator
 *
 * Non-executing, share-weighted governance polls ("temperature checks"). Reads voting
 * power from the DAO; holds NO permission and mutates nothing on DAOShip — so it does
 * NOT need to be registered via a governance proposal. Deploy and use.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/006_deploy_signal_navigator.ts --network cyprus1
 *
 * Configuration (.env or .env.e2e):
 *   - DAOSHIP_ADDRESS              (required) deployed DAO clone (not the singleton)
 *   - SIGNAL_MIN_SHARES_TO_CREATE  (default: 0)        min voting power (QUAI units) to open a poll
 *   - SIGNAL_MIN_DURATION          (default: 3600)     min voting-window length in seconds (must be > 0)
 *   - SIGNAL_MAX_DURATION          (default: 2592000)  max voting-window length in seconds (30 days)
 *   - SIGNAL_MAX_START_DELAY       (default: 2592000)  max scheduling lead time in seconds (0 = immediate-only)
 *   - SIGNAL_NAME / SIGNAL_DESCRIPTION
 */

import hre from "hardhat";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import { HttpNetworkConfig } from "hardhat/types";

const SignalNavigatorJson = require("../../artifacts/contracts/navigators/SignalNavigator.sol/SignalNavigator.json");

async function main() {
  console.log("\n🧭 Deploying SignalNavigator\n" + "=".repeat(80));

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

  const minDuration = process.env.SIGNAL_MIN_DURATION || "3600";
  const maxDuration = process.env.SIGNAL_MAX_DURATION || "2592000";
  if (BigInt(minDuration) === 0n) throw new Error("SIGNAL_MIN_DURATION must be > 0");
  if (BigInt(maxDuration) < BigInt(minDuration)) throw new Error("SIGNAL_MAX_DURATION must be >= SIGNAL_MIN_DURATION");

  const cfg = {
    minSharesToCreatePoll: process.env.SIGNAL_MIN_SHARES_TO_CREATE
      ? quais.parseQuai(process.env.SIGNAL_MIN_SHARES_TO_CREATE).toString()
      : "0",
    minDuration,
    maxDuration,
    maxStartDelay: process.env.SIGNAL_MAX_START_DELAY || "2592000",
    name: process.env.SIGNAL_NAME || "SignalNavigator",
    description: process.env.SIGNAL_DESCRIPTION || "",
  };

  console.log(`\n   Deployer: ${wallet.address}`);
  console.log(`   DAOShip:  ${daoShipAddress}`);
  console.log(`   Config:`, cfg);

  const ipfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(SignalNavigatorJson.bytecode);
  const factory = new quais.ContractFactory(SignalNavigatorJson.abi, SignalNavigatorJson.bytecode, wallet, ipfsHash);
  const nav = await factory.deploy(
    daoShipAddress,
    cfg.minSharesToCreatePoll,
    cfg.minDuration,
    cfg.maxDuration,
    cfg.maxStartDelay,
    cfg.name,
    cfg.description
  );
  await nav.waitForDeployment();
  const navAddress = await nav.getAddress();
  console.log(`\n   ✅ SignalNavigator: ${navAddress}`);

  const timestamp = Date.now();
  const deploymentsDir = path.join(__dirname, "../../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(deploymentsDir, `deployment-signal-navigator-${timestamp}.json`),
    JSON.stringify(
      { network: hre.network.name, timestamp, deployer: wallet.address, daoShip: daoShipAddress, contracts: { SignalNavigator: navAddress }, configuration: cfg },
      null,
      2
    )
  );

  console.log("\n📝 No permission needed — SignalNavigator reads voting power and never mutates the DAO.");
  console.log("   Members can call createPoll/vote immediately.");
  console.log("=".repeat(80) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  });
