/**
 * Deploy Shaman Contracts
 *
 * Deploys:
 * - OnboarderShaman (QUAI → shares/loot with multiplier)
 * - EthOnboarderShaman (simple QUAI → shares)
 * - CheckInShamanV2 (periodic check-in rewards)
 *
 * Usage:
 *   npx hardhat run scripts/deploy/004_deploy_shamans.ts --network cyprus1
 *
 * Configuration:
 *   Set these in .env or .env.e2e:
 *   - ONBOARDER_SHARES_PER_QUAI (default: 20000)
 *   - ONBOARDER_LOOT_PER_QUAI (default: 0)
 *   - ONBOARDER_MIN_TRIBUTE (default: 0.01 QUAI)
 *   - ONBOARDER_EXPIRY (default: 0 = no expiry)
 *   - QUAI_ONBOARDER_PRICE_PER_UNIT (default: 0.1 QUAI)
 *   - QUAI_ONBOARDER_SHARES_PER_UNIT (default: 1)
 *   - QUAI_ONBOARDER_SHARES_LOOT (default: 0)
 *   - QUAI_ONBOARDER_LOOT_LOOT (default: 0)
 *   - CHECKIN_INTERVAL (default: 86400 seconds = 24 hours)
 *   - CHECKIN_REWARD_SHARES (default: 10)
 *   - CHECKIN_REWARD_LOOT (default: 0)
 *   - CHECKIN_MAX_MISSED (default: 3)
 *
 * Note: These shamans are "template" contracts that can be cloned per-DAO.
 *       Each DAO can deploy its own instance with custom parameters.
 */

import hre from "hardhat";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import { HttpNetworkConfig } from "hardhat/types";

// Import compiled contract artifacts
const OnboarderShamanJson = require("../../artifacts/contracts/shamans/OnboarderShaman.sol/OnboarderShaman.json");
const EthOnboarderShamanJson = require("../../artifacts/contracts/shamans/EthOnboarderShaman.sol/EthOnboarderShaman.json");
const CheckInShamanV2Json = require("../../artifacts/contracts/shamans/CheckInShamanV2.sol/CheckInShamanV2.json");

async function main() {
  console.log("\n🧙 Deploying Shaman Contracts\n");
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

  // Check if Baal singleton is deployed
  const baalAddress = process.env.BAAL_SINGLETON;
  if (!baalAddress) {
    console.error("\n❌ BAAL_SINGLETON not found in .env");
    console.error("   Run deployment scripts 001-003 first, then update-env");
    process.exit(1);
  }

  console.log(`\n   Using Baal Singleton: ${baalAddress}`);

  // Read shaman configuration from environment
  const shamanConfig = {
    onboarder: {
      sharesPerQuai: process.env.ONBOARDER_SHARES_PER_QUAI || "20000",
      lootPerQuai: process.env.ONBOARDER_LOOT_PER_QUAI || "0",
      minTribute: process.env.ONBOARDER_MIN_TRIBUTE || "0.01",
      expiry: process.env.ONBOARDER_EXPIRY || "0",
    },
    quaiOnboarder: {
      pricePerUnit: process.env.QUAI_ONBOARDER_PRICE_PER_UNIT || "0.1",
      sharesPerUnit: process.env.QUAI_ONBOARDER_SHARES_PER_UNIT || "1",
      sharesLoot: process.env.QUAI_ONBOARDER_SHARES_LOOT || "0",
      lootLoot: process.env.QUAI_ONBOARDER_LOOT_LOOT || "0",
    },
    checkIn: {
      interval: process.env.CHECKIN_INTERVAL || "86400",
      rewardShares: process.env.CHECKIN_REWARD_SHARES || "10",
      rewardLoot: process.env.CHECKIN_REWARD_LOOT || "0",
      maxMissed: process.env.CHECKIN_MAX_MISSED || "3",
    },
  };

  console.log("\n📝 Shaman Configuration:");
  console.log("\n   OnboarderShaman:");
  console.log(`     - Shares per QUAI: ${shamanConfig.onboarder.sharesPerQuai}`);
  console.log(`     - Loot per QUAI: ${shamanConfig.onboarder.lootPerQuai}`);
  console.log(`     - Min Tribute: ${shamanConfig.onboarder.minTribute} QUAI`);
  console.log(`     - Expiry: ${shamanConfig.onboarder.expiry === "0" ? "No expiry" : shamanConfig.onboarder.expiry}`);
  console.log("\n   EthOnboarderShaman (accepts QUAI on Quai Network):");
  console.log(`     - Price per Unit: ${shamanConfig.quaiOnboarder.pricePerUnit} QUAI`);
  console.log(`     - Shares per Unit: ${shamanConfig.quaiOnboarder.sharesPerUnit}`);
  console.log(`     - Shares as Loot: ${shamanConfig.quaiOnboarder.sharesLoot}`);
  console.log(`     - Loot as Loot: ${shamanConfig.quaiOnboarder.lootLoot}`);
  console.log("\n   CheckInShamanV2:");
  console.log(`     - Interval: ${shamanConfig.checkIn.interval} seconds (${Number(shamanConfig.checkIn.interval) / 86400} days)`);
  console.log(`     - Reward Shares: ${shamanConfig.checkIn.rewardShares}`);
  console.log(`     - Reward Loot: ${shamanConfig.checkIn.rewardLoot}`);
  console.log(`     - Max Missed: ${shamanConfig.checkIn.maxMissed}`);

  console.log("\n" + "=".repeat(80));

  const deployedContracts: { [key: string]: string } = {};

  // 1. Deploy OnboarderShaman
  console.log("\n1️⃣  Deploying OnboarderShaman...");
  console.log("   Generating IPFS metadata hash...");
  const onboarderIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    OnboarderShamanJson.bytecode
  );
  console.log(`   IPFS Hash: ${onboarderIpfsHash}`);
  const OnboarderShaman = new quais.ContractFactory(
    OnboarderShamanJson.abi,
    OnboarderShamanJson.bytecode,
    wallet,
    onboarderIpfsHash
  );
  const onboarder = await OnboarderShaman.deploy(
    baalAddress,
    shamanConfig.onboarder.sharesPerQuai,
    shamanConfig.onboarder.lootPerQuai,
    quais.parseQuai(shamanConfig.onboarder.minTribute),
    shamanConfig.onboarder.expiry
  );
  await onboarder.waitForDeployment();
  const onboarderAddress = await onboarder.getAddress();
  console.log(`   Transaction hash: ${onboarder.deploymentTransaction()?.hash}`);
  console.log(`   ✅ OnboarderShaman: ${onboarderAddress}`);
  deployedContracts.OnboarderShaman = onboarderAddress;

  // 2. Deploy EthOnboarderShaman (accepts QUAI on Quai Network)
  console.log("\n2️⃣  Deploying EthOnboarderShaman (accepts QUAI)...");
  console.log("   Generating IPFS metadata hash...");
  const ethOnboarderIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    EthOnboarderShamanJson.bytecode
  );
  console.log(`   IPFS Hash: ${ethOnboarderIpfsHash}`);
  const EthOnboarderShaman = new quais.ContractFactory(
    EthOnboarderShamanJson.abi,
    EthOnboarderShamanJson.bytecode,
    wallet,
    ethOnboarderIpfsHash
  );
  const quaiOnboarder = await EthOnboarderShaman.deploy(
    baalAddress,
    quais.parseQuai(shamanConfig.quaiOnboarder.pricePerUnit),
    quais.parseQuai(shamanConfig.quaiOnboarder.sharesPerUnit),
    shamanConfig.quaiOnboarder.sharesLoot,
    shamanConfig.quaiOnboarder.lootLoot
  );
  await quaiOnboarder.waitForDeployment();
  const quaiOnboarderAddress = await quaiOnboarder.getAddress();
  console.log(`   Transaction hash: ${quaiOnboarder.deploymentTransaction()?.hash}`);
  console.log(`   ✅ EthOnboarderShaman: ${quaiOnboarderAddress}`);
  deployedContracts.EthOnboarderShaman = quaiOnboarderAddress;

  // 3. Deploy CheckInShamanV2
  console.log("\n3️⃣  Deploying CheckInShamanV2...");
  console.log("   Generating IPFS metadata hash...");
  const checkInIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    CheckInShamanV2Json.bytecode
  );
  console.log(`   IPFS Hash: ${checkInIpfsHash}`);
  const CheckInShamanV2 = new quais.ContractFactory(
    CheckInShamanV2Json.abi,
    CheckInShamanV2Json.bytecode,
    wallet,
    checkInIpfsHash
  );
  const checkInShaman = await CheckInShamanV2.deploy(
    baalAddress,
    shamanConfig.checkIn.interval,
    quais.parseQuai(shamanConfig.checkIn.rewardShares),
    shamanConfig.checkIn.rewardLoot,
    shamanConfig.checkIn.maxMissed
  );
  await checkInShaman.waitForDeployment();
  const checkInAddress = await checkInShaman.getAddress();
  console.log(`   Transaction hash: ${checkInShaman.deploymentTransaction()?.hash}`);
  console.log(`   ✅ CheckInShamanV2: ${checkInAddress}`);
  deployedContracts.CheckInShamanV2 = checkInAddress;

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
    configuration: shamanConfig,
  };

  const deploymentsDir = path.join(__dirname, "../../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filename = `deployment-shamans-${timestamp}.json`;
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

    // Merge shaman contracts into complete deployment
    completeData.contracts = {
      ...completeData.contracts,
      ...deployedContracts,
    };

    fs.writeFileSync(completeFile, JSON.stringify(completeData, null, 2));
    console.log(`✅ Updated complete deployment: ${completeDeployments[0]}`);
  }

  console.log("\n📋 Deployed Shamans:");
  for (const [name, address] of Object.entries(deployedContracts)) {
    console.log(`   ${name.padEnd(30)} ${address}`);
  }

  console.log("\n🎉 Shaman deployment complete!");
  console.log("\n📝 Next Steps:");
  console.log("   1. Run: npm run update-env");
  console.log("      (Updates .env and .env.e2e with shaman addresses)");
  console.log("\n   2. When summoning a DAO, include shamans in initialization:");
  console.log("      - Set shamans during setUp() with permission level 2 (MANAGER)");
  console.log("      - Shamans can then mint shares/loot for onboarding");
  console.log("\n   3. Test shamans:");
  console.log("      - npm run test:unit (unit tests)");
  console.log("      - npm run test:e2e:local (E2E tests with shamans)");

  console.log("\n⚠️  Important Notes:");
  console.log("   - These shamans are tied to the Baal singleton");
  console.log("   - Each DAO should deploy its own shaman instances");
  console.log("   - Configure shaman parameters per-DAO requirements");
  console.log("   - Shamans must be set during DAO initialization (setUp)");
  console.log("   - Cannot set shamans via proposals (baalOnly constraint)");

  console.log("\n" + "=".repeat(80) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  });
