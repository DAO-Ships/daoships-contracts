/**
 * Deploy NFTGatedNavigator
 *
 * Onboards holders of a specific ERC-721 collection. One claim per tokenId (claim ticket).
 *
 * Usage:
 *   npx hardhat run scripts/deploy/005_deploy_nft_gated_navigator.ts --network cyprus1
 *
 * Configuration (.env or .env.e2e):
 *   - DAOSHIP_ADDRESS         (required) deployed DAO clone (not the singleton)
 *   - NFTGATE_TOKEN           (required) ERC-721 collection address that gates membership
 *   - NFTGATE_SHARES_PER_HOLDER (default: 1e18) shares minted per claim
 *   - NFTGATE_LOOT_PER_HOLDER   (default: 0)    loot minted per claim
 *   - NFTGATE_REQUIRE_TRIBUTE   (default: false) "true" to require native tribute
 *   - NFTGATE_TRIBUTE_AMOUNT    (default: 0)    exact native tribute in QUAI (e.g. "1.5")
 *   - NFTGATE_EXPIRY            (default: 0)    expiry timestamp (0 = none)
 *   - NFTGATE_MINT_CAP          (default: 1000e18) MANDATORY dilution cap, must be > 0
 *   - NFTGATE_PER_ADDRESS_CAP   (default: 0)    per-address cap (0 = unlimited)
 *   - NFTGATE_ALLOWLIST_ROOT    (default: 0x0)  optional Merkle root layered on the NFT gate
 *   - NFTGATE_NAME / NFTGATE_DESCRIPTION
 */

import hre from "hardhat";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import { HttpNetworkConfig } from "hardhat/types";

const NFTGatedNavigatorJson = require("../../artifacts/contracts/navigators/NFTGatedNavigator.sol/NFTGatedNavigator.json");

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

async function main() {
  console.log("\n🧭 Deploying NFTGatedNavigator\n" + "=".repeat(80));

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

  const gateToken = process.env.NFTGATE_TOKEN;
  if (!gateToken) throw new Error("NFTGATE_TOKEN not set (ERC-721 collection address)");

  const requireTribute = (process.env.NFTGATE_REQUIRE_TRIBUTE || "false").toLowerCase() === "true";
  const tributeAmount = requireTribute ? quais.parseQuai(process.env.NFTGATE_TRIBUTE_AMOUNT || "0") : 0n;
  const mintCap = process.env.NFTGATE_MINT_CAP || quais.parseQuai("1000").toString();
  if (BigInt(mintCap) === 0n) throw new Error("NFTGATE_MINT_CAP must be > 0 (mandatory dilution backstop)");

  const cfg = {
    sharesPerHolder: process.env.NFTGATE_SHARES_PER_HOLDER || quais.parseQuai("1").toString(),
    lootPerHolder: process.env.NFTGATE_LOOT_PER_HOLDER || "0",
    requireTribute,
    tributeAmount: tributeAmount.toString(),
    expiry: process.env.NFTGATE_EXPIRY || "0",
    mintCap,
    perAddressCap: process.env.NFTGATE_PER_ADDRESS_CAP || "0",
    allowlistRoot: process.env.NFTGATE_ALLOWLIST_ROOT || ZERO_BYTES32,
    name: process.env.NFTGATE_NAME || "NFTGatedNavigator",
    description: process.env.NFTGATE_DESCRIPTION || "",
  };

  console.log(`\n   Deployer:   ${wallet.address}`);
  console.log(`   DAOShip:    ${daoShipAddress}`);
  console.log(`   Gate token: ${gateToken}`);
  console.log(`   Config:`, cfg);

  const ipfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(NFTGatedNavigatorJson.bytecode);
  const factory = new quais.ContractFactory(NFTGatedNavigatorJson.abi, NFTGatedNavigatorJson.bytecode, wallet, ipfsHash);
  const nav = await factory.deploy(
    daoShipAddress,
    gateToken,
    cfg.sharesPerHolder,
    cfg.lootPerHolder,
    cfg.requireTribute,
    cfg.tributeAmount,
    cfg.expiry,
    cfg.mintCap,
    cfg.perAddressCap,
    cfg.allowlistRoot,
    cfg.name,
    cfg.description
  );
  await nav.waitForDeployment();
  const navAddress = await nav.getAddress();
  console.log(`\n   ✅ NFTGatedNavigator: ${navAddress}`);

  const timestamp = Date.now();
  const deploymentsDir = path.join(__dirname, "../../deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(deploymentsDir, `deployment-nft-gated-navigator-${timestamp}.json`),
    JSON.stringify(
      { network: hre.network.name, timestamp, deployer: wallet.address, daoShip: daoShipAddress, gateToken, contracts: { NFTGatedNavigator: navAddress }, configuration: cfg },
      null,
      2
    )
  );

  console.log("\n📝 Next: register as a MANAGER (permission 2) via a setNavigators governance proposal.");
  console.log("=".repeat(80) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  });
