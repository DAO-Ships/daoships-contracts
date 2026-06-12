/**
 * Deploy SubscriptionNavigator
 *
 * Recurring membership dues. Members pull-pay periodic fees in any of a governance-set
 * menu of accepted tokens (native QUAI or ERC20) straight to the vault treasury. Past
 * the grace window, anyone may collectFee(member) to strip the member's shares (burned,
 * or converted to non-voting loot by default) for a small loot keeper reward. Standard
 * MANAGER navigator — register via setNavigators([nav],[2]); NOT a vault module.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/010_deploy_subscription_navigator.ts --network cyprus1
 *
 * Configuration (.env or .env.e2e):
 *   - DAOSHIP_ADDRESS                 (required) deployed DAO clone (not the singleton)
 *   - SUBSCRIPTION_TOKENS             comma-separated token addresses; "native"/"0x0…0" = QUAI.
 *                                     Default: "native"
 *   - SUBSCRIPTION_FEES               comma-separated fee-per-period (wei), parallel to TOKENS.
 *                                     Default: "1000000000000000000" (1 whole token)
 *   - SUBSCRIPTION_PERIOD             period length, seconds. Default: 2592000 (30 days)
 *   - SUBSCRIPTION_GRACE              grace window, seconds. Default: 604800 (7 days)
 *   - SUBSCRIPTION_START              activation unix time (0 = now). Default: 0
 *   - SUBSCRIPTION_COLLECTOR_BPS      keeper reward, bps of shares removed (<=1000). Default: 100 (1%)
 *   - SUBSCRIPTION_BURN               "true" = burn delinquent shares, else convert to loot. Default: false
 *   - SUBSCRIPTION_INITIAL_MEMBERS    comma-separated members enrolled at deploy. Default: none
 *   - SUBSCRIPTION_NAME / SUBSCRIPTION_DESCRIPTION
 */

import hre from "hardhat";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import { HttpNetworkConfig } from "hardhat/types";

const SubscriptionNavigatorJson = require("../../artifacts/contracts/navigators/SubscriptionNavigator.sol/SubscriptionNavigator.json");

const NATIVE = "0x0000000000000000000000000000000000000000";

function parseTokens(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => (t.toLowerCase() === "native" ? NATIVE : t));
}

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

async function main() {
  console.log("\n🧭 Deploying SubscriptionNavigator\n" + "=".repeat(80));

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

  const tokens = parseTokens(process.env.SUBSCRIPTION_TOKENS || "native");
  const fees = parseList(process.env.SUBSCRIPTION_FEES || "1000000000000000000");
  if (tokens.length !== fees.length) {
    throw new Error(`SUBSCRIPTION_TOKENS (${tokens.length}) and SUBSCRIPTION_FEES (${fees.length}) must be parallel`);
  }

  const cfg = {
    tokens,
    feesPerPeriod: fees,
    periodDuration: process.env.SUBSCRIPTION_PERIOD || "2592000", // 30 days
    graceDuration: process.env.SUBSCRIPTION_GRACE || "604800", // 7 days
    startTime: process.env.SUBSCRIPTION_START || "0",
    collectorRewardBps: process.env.SUBSCRIPTION_COLLECTOR_BPS || "100", // 1%
    burnOnCollect: (process.env.SUBSCRIPTION_BURN || "false").toLowerCase() === "true",
    initialMembers: parseList(process.env.SUBSCRIPTION_INITIAL_MEMBERS || ""),
    name: process.env.SUBSCRIPTION_NAME || "SubscriptionNavigator",
    description: process.env.SUBSCRIPTION_DESCRIPTION || "",
  };

  console.log(`\n   Deployer: ${wallet.address}`);
  console.log(`   DAOShip:  ${daoShipAddress}`);
  console.log(`   Config:`, cfg);

  const ipfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(SubscriptionNavigatorJson.bytecode);
  const factory = new quais.ContractFactory(
    SubscriptionNavigatorJson.abi,
    SubscriptionNavigatorJson.bytecode,
    wallet,
    ipfsHash
  );
  const nav = await factory.deploy(
    daoShipAddress,
    cfg.tokens,
    cfg.feesPerPeriod,
    cfg.periodDuration,
    cfg.graceDuration,
    cfg.startTime,
    cfg.collectorRewardBps,
    cfg.burnOnCollect,
    cfg.initialMembers,
    cfg.name,
    cfg.description
  );
  await nav.waitForDeployment();
  const navAddress = await nav.getAddress();
  console.log(`\n   ✅ SubscriptionNavigator: ${navAddress}`);

  const timestamp = Date.now();
  const deploymentsDir = path.join(__dirname, "../../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(deploymentsDir, `deployment-subscription-navigator-${timestamp}.json`),
    JSON.stringify(
      {
        network: hre.network.name,
        timestamp,
        deployer: wallet.address,
        daoShip: daoShipAddress,
        contracts: { SubscriptionNavigator: navAddress },
        configuration: cfg,
      },
      null,
      2
    )
  );

  console.log("\n📝 NEXT STEP — grant MANAGER (2) via a governance proposal:");
  console.log(`      setNavigators(["${navAddress}"], [2])   // MANAGER: burnShares / convertSharesToLoot / mintLoot`);
  console.log("   Members then pay dues with payFee(periods, token); keepers collect lapsed members with collectFee(member).");
  console.log("=".repeat(80) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  });
