import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * Deploy all contracts in sequence
 * 1. Poster
 * 2. Singletons (Baal, SharesERC20, LootERC20)
 * 3. Factories (BaalSummoner, BaalAndVaultSummoner)
 * 4. Shamans (OnboarderShaman, EthOnboarderShaman, CheckInShamanV2)
 */
async function main() {
  console.log("=".repeat(60));
  console.log("🚀 Starting Full Deployment");
  console.log("=".repeat(60));

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  const network = await ethers.provider.getNetwork();

  console.log("\n📊 Deployment Info:");
  console.log(`   Network:  ${network.name} (Chain ID: ${network.chainId})`);
  console.log(`   Deployer: ${deployer.address}`);
  console.log(`   Balance:  ${ethers.formatEther(balance)} ETH`);

  const deployedContracts: any = {};

  // 1. Deploy Poster
  console.log("\n" + "=".repeat(60));
  console.log("STEP 1: Deploying Poster");
  console.log("=".repeat(60));

  const Poster = await ethers.getContractFactory("Poster");
  const poster = await Poster.deploy();
  await poster.waitForDeployment();
  deployedContracts.Poster = await poster.getAddress();
  console.log("✅ Poster:", deployedContracts.Poster);

  // 2. Deploy Singletons
  console.log("\n" + "=".repeat(60));
  console.log("STEP 2: Deploying Singletons");
  console.log("=".repeat(60));

  console.log("\n📦 SharesERC20 Singleton...");
  const SharesERC20 = await ethers.getContractFactory("SharesERC20");
  const sharesSingleton = await SharesERC20.deploy();
  await sharesSingleton.waitForDeployment();
  deployedContracts.SharesERC20Singleton = await sharesSingleton.getAddress();
  console.log("✅ SharesERC20:", deployedContracts.SharesERC20Singleton);

  console.log("\n📦 LootERC20 Singleton...");
  const LootERC20 = await ethers.getContractFactory("LootERC20");
  const lootSingleton = await LootERC20.deploy();
  await lootSingleton.waitForDeployment();
  deployedContracts.LootERC20Singleton = await lootSingleton.getAddress();
  console.log("✅ LootERC20:", deployedContracts.LootERC20Singleton);

  console.log("\n📦 Baal Singleton...");
  const Baal = await ethers.getContractFactory("Baal");
  const baalSingleton = await Baal.deploy();
  await baalSingleton.waitForDeployment();
  deployedContracts.BaalSingleton = await baalSingleton.getAddress();
  console.log("✅ Baal:", deployedContracts.BaalSingleton);

  // 3. Deploy Factories
  console.log("\n" + "=".repeat(60));
  console.log("STEP 3: Deploying Factories");
  console.log("=".repeat(60));

  console.log("\n🏭 BaalSummoner...");
  const BaalSummoner = await ethers.getContractFactory("BaalSummoner");
  const baalSummoner = await BaalSummoner.deploy(
    deployedContracts.BaalSingleton,
    deployedContracts.SharesERC20Singleton,
    deployedContracts.LootERC20Singleton
  );
  await baalSummoner.waitForDeployment();
  deployedContracts.BaalSummoner = await baalSummoner.getAddress();
  console.log("✅ BaalSummoner:", deployedContracts.BaalSummoner);

  // Deploy BaalAndVaultSummoner if QuaiVaultFactory is set
  const quaiVaultFactory = process.env.QUAI_VAULT_FACTORY;
  if (quaiVaultFactory) {
    console.log("\n🏭 BaalAndVaultSummoner...");
    console.log(`   QuaiVaultFactory: ${quaiVaultFactory}`);

    const BaalAndVaultSummoner = await ethers.getContractFactory(
      "BaalAndVaultSummoner"
    );
    const baalAndVaultSummoner = await BaalAndVaultSummoner.deploy(
      deployedContracts.BaalSingleton,
      deployedContracts.SharesERC20Singleton,
      deployedContracts.LootERC20Singleton,
      quaiVaultFactory
    );
    await baalAndVaultSummoner.waitForDeployment();
    deployedContracts.BaalAndVaultSummoner =
      await baalAndVaultSummoner.getAddress();
    console.log(
      "✅ BaalAndVaultSummoner:",
      deployedContracts.BaalAndVaultSummoner
    );
  } else {
    console.warn("\n⚠️  Skipping BaalAndVaultSummoner (QUAI_VAULT_FACTORY not set)");
  }

  // 4. Save consolidated deployment info
  console.log("\n" + "=".repeat(60));
  console.log("STEP 4: Saving Deployment Info");
  console.log("=".repeat(60));

  const deploymentInfo = {
    network: network.name,
    chainId: network.chainId.toString(),
    timestamp: Date.now(),
    deployer: deployer.address,
    contracts: deployedContracts,
    references: {
      QuaiVaultFactory: quaiVaultFactory || "NOT_SET",
      MultiSend: process.env.MULTISEND_LIBRARY || "NOT_SET",
    },
  };

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filename = `deployment-complete-${network.name}-${Date.now()}.json`;
  fs.writeFileSync(
    path.join(deploymentsDir, filename),
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log(`\n✅ Deployment info saved to: deployments/${filename}`);

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("✨ DEPLOYMENT COMPLETE!");
  console.log("=".repeat(60));

  console.log("\n📋 Deployed Contracts:");
  for (const [name, address] of Object.entries(deployedContracts)) {
    console.log(`   ${name.padEnd(30)} ${address}`);
  }

  console.log("\n🎉 All contracts deployed successfully!");
  console.log("\n📝 Next Steps:");
  console.log("   1. Verify contracts on block explorer (if available)");
  console.log("   2. Update indexer configuration with contract addresses");
  console.log("   3. Test deployment with: npm run test:integration");
  console.log("   4. Summon a test DAO with: npm run summon-dao");

  return deployedContracts;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  });
