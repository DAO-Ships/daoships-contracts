/**
 * Deploy Navigator Contracts
 *
 * Deploys:
 * - OnboarderNavigator (native token onboarding with multiplier or fixed-price mode)
 * - ERC20TributeNavigator (ERC20 token tribute for shares/loot)
 *
 * Usage:
 *   npx hardhat run scripts/deploy/004_deploy_navigators.ts --network cyprus1
 *
 * Configuration:
 *   Set these in .env or .env.e2e:
 *
 *   OnboarderNavigator:
 *   - ONBOARDER_SHARE_MULTIPLIER (default: 10000 = 1x, basis points. Set 0 for fixed-price mode.)
 *   - ONBOARDER_LOOT_MULTIPLIER (default: 0. Set 0 for fixed-price mode.)
 *   - ONBOARDER_PRICE_PER_UNIT (default: 0. Set 0 for multiplier mode.)
 *   - ONBOARDER_SHARES_PER_UNIT (default: 0, fixed-price mode only)
 *   - ONBOARDER_LOOT_PER_UNIT (default: 0, fixed-price mode only)
 *   - ONBOARDER_MIN_TRIBUTE (default: 0.01 QUAI)
 *   - ONBOARDER_EXPIRY (default: 0 = no expiry)
 *   - ONBOARDER_MINT_CAP (default: 0 = unlimited)
 *   - ONBOARDER_ALLOWLIST_ROOT (default: bytes32(0) = open)
 *
 *   ERC20TributeNavigator (skipped if TRIBUTE_TOKEN not set):
 *   - TRIBUTE_TOKEN (required, ERC20 token address)
 *   - TRIBUTE_PRICE_PER_SHARE (default: 1000000000000000000 = 1 token)
 *   - TRIBUTE_PRICE_PER_LOOT (default: 0 = no loot)
 *   - TRIBUTE_EXPIRY (default: 0 = no expiry)
 *   - TRIBUTE_MINT_CAP (default: 0 = unlimited)
 *   - TRIBUTE_ALLOWLIST_ROOT (default: bytes32(0) = open)
 */

import hre from "hardhat";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import { HttpNetworkConfig } from "hardhat/types";

// Import compiled contract artifacts
const OnboarderNavigatorJson = require("../../artifacts/contracts/navigators/OnboarderNavigator.sol/OnboarderNavigator.json");
const ERC20TributeNavigatorJson = require("../../artifacts/contracts/navigators/ERC20TributeNavigator.sol/ERC20TributeNavigator.json");

async function main() {
  console.log("\n🧭 Deploying Navigator Contracts\n");
  console.log("=".repeat(80));

  console.log("\nNetwork:", hre.network.name);

  const networkConfig = hre.network.config as HttpNetworkConfig;
  console.log("RPC URL:", networkConfig.url);

  // Set up provider and wallet using quais (required for Quai Network)
  const provider = new quais.JsonRpcProvider(
    networkConfig.url,
    undefined,
    { usePathing: true }
  );

  const accounts = networkConfig.accounts as string[];

  if (!accounts || accounts.length === 0 || !accounts[0]) {
    throw new Error(
      "CYPRUS1_PK not set in .env file. Please set CYPRUS1_PK=your_private_key in the root .env file."
    );
  }

  // Ensure private key is properly formatted
  let privateKey = accounts[0].trim();
  if (!privateKey.startsWith("0x")) {
    privateKey = "0x" + privateKey;
  }

  if (privateKey.length !== 66) {
    throw new Error(
      `Invalid private key length: ${privateKey.length} (expected 66 characters including 0x prefix). ` +
        `Please check your CYPRUS1_PK in the .env file.`
    );
  }

  const wallet = new quais.Wallet(privateKey, provider);

  console.log("\n📊 Deployment Info:");
  console.log(`   Deployer: ${wallet.address}`);

  const balance = await provider.getBalance(wallet.address);
  console.log(`   Balance: ${quais.formatQuai(balance)} QUAI`);

  // Navigators are tied to a specific DAOShip clone, not the singleton.
  // Use DAOSHIP_ADDRESS (a deployed DAO clone) or fall back to DAOSHIP_SINGLETON for testing.
  const daoShipAddress = process.env.DAOSHIP_ADDRESS || process.env.DAOSHIP_SINGLETON;
  if (!daoShipAddress) {
    console.error("\n❌ DAOSHIP_ADDRESS not found in .env");
    console.error("   Set DAOSHIP_ADDRESS to the deployed DAO clone address (not the singleton).");
    console.error("   Run create-dao first, then set DAOSHIP_ADDRESS to the DAOShip clone address.");
    process.exit(1);
  }

  if (daoShipAddress === process.env.DAOSHIP_SINGLETON) {
    console.log(`\n   ⚠️  WARNING: Using DAOShip singleton address — navigators should point at a clone.`);
    console.log(`   Set DAOSHIP_ADDRESS in .env to the actual DAO clone address.`);
  }

  console.log(`\n   Using DAOShip: ${daoShipAddress}`);

  // Read navigator configuration from environment
  const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const navigatorConfig = {
    onboarder: {
      shareMultiplier: process.env.ONBOARDER_SHARE_MULTIPLIER || "10000",
      lootMultiplier: process.env.ONBOARDER_LOOT_MULTIPLIER || "0",
      pricePerUnit: process.env.ONBOARDER_PRICE_PER_UNIT || "0",
      sharesPerUnit: process.env.ONBOARDER_SHARES_PER_UNIT || "0",
      lootPerUnit: process.env.ONBOARDER_LOOT_PER_UNIT || "0",
      minTribute: process.env.ONBOARDER_MIN_TRIBUTE || "0.01",
      expiry: process.env.ONBOARDER_EXPIRY || "0",
      mintCap: process.env.ONBOARDER_MINT_CAP || "0",
      perAddressCap: process.env.ONBOARDER_PER_ADDRESS_CAP || "0",
      allowlistRoot: process.env.ONBOARDER_ALLOWLIST_ROOT || ZERO_BYTES32,
      name: process.env.ONBOARDER_NAME || "OnboarderNavigator",
      description: process.env.ONBOARDER_DESCRIPTION || "",
    },
    erc20Tribute: {
      tributeToken: process.env.TRIBUTE_TOKEN || "",
      pricePerShare: process.env.TRIBUTE_PRICE_PER_SHARE || "1000000000000000000",
      pricePerLoot: process.env.TRIBUTE_PRICE_PER_LOOT || "0",
      expiry: process.env.TRIBUTE_EXPIRY || "0",
      mintCap: process.env.TRIBUTE_MINT_CAP || "0",
      perAddressCap: process.env.TRIBUTE_PER_ADDRESS_CAP || "0",
      allowlistRoot: process.env.TRIBUTE_ALLOWLIST_ROOT || ZERO_BYTES32,
      name: process.env.TRIBUTE_NAME || "ERC20TributeNavigator",
      description: process.env.TRIBUTE_DESCRIPTION || "",
    },
  };

  console.log("\n📝 Navigator Configuration:");
  console.log("\n   OnboarderNavigator:");
  console.log(`     - Share Multiplier: ${navigatorConfig.onboarder.shareMultiplier} (basis points, 10000 = 1x)`);
  console.log(`     - Loot Multiplier: ${navigatorConfig.onboarder.lootMultiplier}`);
  console.log(`     - Price per Unit: ${navigatorConfig.onboarder.pricePerUnit} (0 = multiplier mode)`);
  console.log(`     - Shares per Unit: ${navigatorConfig.onboarder.sharesPerUnit} (fixed-price mode)`);
  console.log(`     - Loot per Unit: ${navigatorConfig.onboarder.lootPerUnit} (fixed-price mode)`);
  console.log(`     - Min Tribute: ${navigatorConfig.onboarder.minTribute} QUAI`);
  console.log(`     - Expiry: ${navigatorConfig.onboarder.expiry === "0" ? "No expiry" : navigatorConfig.onboarder.expiry}`);
  console.log(`     - Mint Cap: ${navigatorConfig.onboarder.mintCap === "0" ? "Unlimited" : navigatorConfig.onboarder.mintCap}`);
  console.log(`     - Allowlist Root: ${navigatorConfig.onboarder.allowlistRoot === ZERO_BYTES32 ? "Open (no allowlist)" : navigatorConfig.onboarder.allowlistRoot}`);

  if (navigatorConfig.erc20Tribute.tributeToken) {
    console.log("\n   ERC20TributeNavigator:");
    console.log(`     - Tribute Token: ${navigatorConfig.erc20Tribute.tributeToken}`);
    console.log(`     - Price per Share: ${navigatorConfig.erc20Tribute.pricePerShare}`);
    console.log(`     - Price per Loot: ${navigatorConfig.erc20Tribute.pricePerLoot === "0" ? "No loot" : navigatorConfig.erc20Tribute.pricePerLoot}`);
    console.log(`     - Expiry: ${navigatorConfig.erc20Tribute.expiry === "0" ? "No expiry" : navigatorConfig.erc20Tribute.expiry}`);
    console.log(`     - Mint Cap: ${navigatorConfig.erc20Tribute.mintCap === "0" ? "Unlimited" : navigatorConfig.erc20Tribute.mintCap}`);
    console.log(`     - Allowlist Root: ${navigatorConfig.erc20Tribute.allowlistRoot === ZERO_BYTES32 ? "Open (no allowlist)" : navigatorConfig.erc20Tribute.allowlistRoot}`);
  } else {
    console.log("\n   ERC20TributeNavigator: SKIPPED (TRIBUTE_TOKEN not set in env)");
  }

  console.log("\n" + "=".repeat(80));

  const deployedContracts: { [key: string]: string } = {};

  // 1. Deploy OnboarderNavigator
  console.log("\n1️⃣  Deploying OnboarderNavigator...");
  console.log("   Generating IPFS metadata hash...");
  const onboarderIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    OnboarderNavigatorJson.bytecode
  );
  console.log(`   IPFS Hash: ${onboarderIpfsHash}`);
  const OnboarderNavigator = new quais.ContractFactory(
    OnboarderNavigatorJson.abi,
    OnboarderNavigatorJson.bytecode,
    wallet,
    onboarderIpfsHash
  );
  const onboarder = await OnboarderNavigator.deploy(
    daoShipAddress,
    navigatorConfig.onboarder.shareMultiplier,
    navigatorConfig.onboarder.lootMultiplier,
    navigatorConfig.onboarder.pricePerUnit,
    navigatorConfig.onboarder.sharesPerUnit,
    navigatorConfig.onboarder.lootPerUnit,
    quais.parseQuai(navigatorConfig.onboarder.minTribute),
    navigatorConfig.onboarder.expiry,
    navigatorConfig.onboarder.mintCap,
    navigatorConfig.onboarder.perAddressCap || 0,
    navigatorConfig.onboarder.allowlistRoot,
    navigatorConfig.onboarder.name || "OnboarderNavigator",
    navigatorConfig.onboarder.description || ""
  );
  await onboarder.waitForDeployment();
  const onboarderAddress = await onboarder.getAddress();
  console.log(`   Transaction hash: ${onboarder.deploymentTransaction()?.hash}`);
  console.log(`   ✅ OnboarderNavigator: ${onboarderAddress}`);
  deployedContracts.OnboarderNavigator = onboarderAddress;

  // 2. Deploy ERC20TributeNavigator (optional, requires TRIBUTE_TOKEN)
  if (navigatorConfig.erc20Tribute.tributeToken) {
    console.log("\n2️⃣  Deploying ERC20TributeNavigator...");
    console.log("   Generating IPFS metadata hash...");
    const erc20TributeIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
      ERC20TributeNavigatorJson.bytecode
    );
    console.log(`   IPFS Hash: ${erc20TributeIpfsHash}`);
    const ERC20TributeNavigator = new quais.ContractFactory(
      ERC20TributeNavigatorJson.abi,
      ERC20TributeNavigatorJson.bytecode,
      wallet,
      erc20TributeIpfsHash
    );
    const erc20Tribute = await ERC20TributeNavigator.deploy(
      daoShipAddress,
      navigatorConfig.erc20Tribute.tributeToken,
      navigatorConfig.erc20Tribute.pricePerShare,
      navigatorConfig.erc20Tribute.pricePerLoot,
      navigatorConfig.erc20Tribute.expiry,
      navigatorConfig.erc20Tribute.mintCap,
      navigatorConfig.erc20Tribute.perAddressCap || 0,
      navigatorConfig.erc20Tribute.allowlistRoot,
      navigatorConfig.erc20Tribute.name || "ERC20TributeNavigator",
      navigatorConfig.erc20Tribute.description || ""
    );
    await erc20Tribute.waitForDeployment();
    const erc20TributeAddress = await erc20Tribute.getAddress();
    console.log(`   Transaction hash: ${erc20Tribute.deploymentTransaction()?.hash}`);
    console.log(`   ✅ ERC20TributeNavigator: ${erc20TributeAddress}`);
    deployedContracts.ERC20TributeNavigator = erc20TributeAddress;
  } else {
    console.log("\n2️⃣  Skipping ERC20TributeNavigator (TRIBUTE_TOKEN not set)");
  }

  console.log("\n" + "=".repeat(80));

  // Save deployment info
  const timestamp = Date.now();
  const network = await provider.getNetwork();
  const deploymentInfo = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    timestamp,
    deployer: wallet.address,
    contracts: deployedContracts,
    configuration: navigatorConfig,
  };

  const deploymentsDir = path.join(__dirname, "../../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filename = `deployment-navigators-${timestamp}.json`;
  const filepath = path.join(deploymentsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(deploymentInfo, null, 2));

  console.log(`\n💾 Deployment saved: deployments/${filename}`);

  // Update the complete deployment file if it exists
  const completeDeployments = fs
    .readdirSync(deploymentsDir)
    .filter((f) => f.startsWith("deployment-complete-"))
    .sort()
    .reverse();

  if (completeDeployments.length > 0) {
    const completeFile = path.join(deploymentsDir, completeDeployments[0]);
    const completeData = JSON.parse(fs.readFileSync(completeFile, "utf-8"));

    // Merge navigator contracts into complete deployment
    completeData.contracts = {
      ...completeData.contracts,
      ...deployedContracts,
    };

    fs.writeFileSync(completeFile, JSON.stringify(completeData, null, 2));
    console.log(`✅ Updated complete deployment: ${completeDeployments[0]}`);
  }

  console.log("\n📋 Deployed Navigators:");
  for (const [name, address] of Object.entries(deployedContracts)) {
    console.log(`   ${name.padEnd(30)} ${address}`);
  }

  console.log("\n🎉 Navigator deployment complete!");
  console.log("\n📝 Next Steps:");
  console.log("   1. Run: npm run update-env");
  console.log("      (Updates .env and .env.e2e with navigator addresses)");
  console.log("\n   2. When creating a DAO, include navigators in initialization:");
  console.log("      - Set navigators during setUp() with permission level 2 (MANAGER)");
  console.log("      - Navigators can then mint shares/loot for onboarding");
  console.log("\n   3. Test navigators:");
  console.log("      - npm run test:unit (unit tests)");
  console.log("      - npm run test:e2e:local (E2E tests with navigators)");

  console.log("\n⚠️  Important Notes:");
  console.log("   - Each navigator is tied to a specific DAOShip clone (not the singleton)");
  console.log("   - Each DAO should deploy its own navigator instances");
  console.log("   - Configure navigator parameters per-DAO requirements");
  console.log("   - Navigators can be set during DAO initialization (setUp) or added later via governance proposals (setNavigators)");

  console.log("\n" + "=".repeat(80) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  });
