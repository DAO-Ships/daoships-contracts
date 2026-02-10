import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * Deploy BaalSummoner and BaalAndVaultSummoner factories
 * Requires singleton addresses from previous deployment
 */
async function main() {
  console.log("Deploying Factories...");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // Load singleton addresses from previous deployment
  const deploymentsDir = path.join(__dirname, "../../deployments");
  const files = fs.readdirSync(deploymentsDir);
  const singletonFile = files
    .filter((f) => f.startsWith("singletons-"))
    .sort()
    .reverse()[0];

  if (!singletonFile) {
    throw new Error(
      "No singleton deployment found. Run 002_deploy_singletons.ts first."
    );
  }

  const singletonData = JSON.parse(
    fs.readFileSync(path.join(deploymentsDir, singletonFile), "utf-8")
  );

  const baalSingleton = singletonData.contracts.BaalSingleton.address;
  const sharesSingleton = singletonData.contracts.SharesERC20Singleton.address;
  const lootSingleton = singletonData.contracts.LootERC20Singleton.address;

  console.log("\n📦 Using singletons:");
  console.log(`   Baal:   ${baalSingleton}`);
  console.log(`   Shares: ${sharesSingleton}`);
  console.log(`   Loot:   ${lootSingleton}`);

  // Deploy BaalSummoner
  console.log("\n1. Deploying BaalSummoner...");
  const BaalSummoner = await ethers.getContractFactory("BaalSummoner");
  const baalSummoner = await BaalSummoner.deploy(
    baalSingleton,
    sharesSingleton,
    lootSingleton
  );
  await baalSummoner.waitForDeployment();
  const baalSummonerAddress = await baalSummoner.getAddress();
  console.log("✅ BaalSummoner deployed:", baalSummonerAddress);

  // Get QuaiVaultFactory address from env
  const quaiVaultFactory = process.env.QUAI_VAULT_FACTORY;
  if (!quaiVaultFactory) {
    console.warn(
      "\n⚠️  QUAI_VAULT_FACTORY not set in .env, skipping BaalAndVaultSummoner"
    );
    console.warn("   Set QUAI_VAULT_FACTORY to deploy integrated summoner");
  } else {
    // Deploy BaalAndVaultSummoner
    console.log("\n2. Deploying BaalAndVaultSummoner...");
    console.log(`   Using QuaiVaultFactory: ${quaiVaultFactory}`);

    const BaalAndVaultSummoner = await ethers.getContractFactory(
      "BaalAndVaultSummoner"
    );
    const baalAndVaultSummoner = await BaalAndVaultSummoner.deploy(
      baalSingleton,
      sharesSingleton,
      lootSingleton,
      quaiVaultFactory
    );
    await baalAndVaultSummoner.waitForDeployment();
    const baalAndVaultSummonerAddress =
      await baalAndVaultSummoner.getAddress();
    console.log(
      "✅ BaalAndVaultSummoner deployed:",
      baalAndVaultSummonerAddress
    );

    // Save deployment info
    const deploymentInfo = {
      network: (await ethers.provider.getNetwork()).name,
      chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      timestamp: Date.now(),
      deployer: deployer.address,
      contracts: {
        BaalSummoner: {
          address: baalSummonerAddress,
          blockNumber: baalSummoner.deploymentTransaction()?.blockNumber || 0,
        },
        BaalAndVaultSummoner: {
          address: baalAndVaultSummonerAddress,
          blockNumber:
            baalAndVaultSummoner.deploymentTransaction()?.blockNumber || 0,
        },
      },
      references: {
        BaalSingleton: baalSingleton,
        SharesERC20Singleton: sharesSingleton,
        LootERC20Singleton: lootSingleton,
        QuaiVaultFactory: quaiVaultFactory,
      },
    };

    // Save deployment info
    const filename = `factories-${deploymentInfo.network}-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(deploymentsDir, filename),
      JSON.stringify(deploymentInfo, null, 2)
    );

    console.log(`\n📝 Deployment info saved to: deployments/${filename}`);

    console.log("\n✨ All factories deployed successfully!");
    console.log("\n📋 Summary:");
    console.log(`   BaalSummoner:         ${baalSummonerAddress}`);
    console.log(
      `   BaalAndVaultSummoner: ${baalAndVaultSummonerAddress}`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

export { main as deployFactories };
