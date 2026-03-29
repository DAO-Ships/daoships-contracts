import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * Deploy DAOShipLauncher and DAOShipAndVaultLauncher factories
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

  const daoShipSingleton = singletonData.contracts.DAOShipSingleton.address;
  const sharesSingleton = singletonData.contracts.SharesERC20Singleton.address;
  const lootSingleton = singletonData.contracts.LootERC20Singleton.address;

  console.log("\n📦 Using singletons:");
  console.log(`   DAOShip: ${daoShipSingleton}`);
  console.log(`   Shares:  ${sharesSingleton}`);
  console.log(`   Loot:    ${lootSingleton}`);

  // Deploy DAOShipLauncher
  console.log("\n1. Deploying DAOShipLauncher...");
  const DAOShipLauncher = await ethers.getContractFactory("DAOShipLauncher");
  const daoShipLauncher = await DAOShipLauncher.deploy(
    daoShipSingleton,
    sharesSingleton,
    lootSingleton
  );
  await daoShipLauncher.waitForDeployment();
  const daoShipLauncherAddress = await daoShipLauncher.getAddress();
  console.log("✅ DAOShipLauncher deployed:", daoShipLauncherAddress);

  // Get QuaiVaultFactory address from env
  const quaiVaultFactory = process.env.QUAI_VAULT_FACTORY;
  if (!quaiVaultFactory) {
    console.warn(
      "\n⚠️  QUAI_VAULT_FACTORY not set in .env, skipping DAOShipAndVaultLauncher"
    );
    console.warn("   Set QUAI_VAULT_FACTORY to deploy integrated launcher");
  } else {
    // Deploy DAOShipAndVaultLauncher
    console.log("\n2. Deploying DAOShipAndVaultLauncher...");
    console.log(`   Using DAOShipLauncher: ${daoShipLauncherAddress}`);
    console.log(`   Using QuaiVaultFactory: ${quaiVaultFactory}`);

    const DAOShipAndVaultLauncher = await ethers.getContractFactory(
      "DAOShipAndVaultLauncher"
    );
    const daoShipAndVaultLauncher = await DAOShipAndVaultLauncher.deploy(
      daoShipLauncherAddress,
      quaiVaultFactory
    );
    await daoShipAndVaultLauncher.waitForDeployment();
    const daoShipAndVaultLauncherAddress =
      await daoShipAndVaultLauncher.getAddress();
    console.log(
      "✅ DAOShipAndVaultLauncher deployed:",
      daoShipAndVaultLauncherAddress
    );

    // Save deployment info
    const deploymentInfo = {
      network: (await ethers.provider.getNetwork()).name,
      chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      timestamp: Date.now(),
      deployer: deployer.address,
      contracts: {
        DAOShipLauncher: {
          address: daoShipLauncherAddress,
          blockNumber: daoShipLauncher.deploymentTransaction()?.blockNumber || 0,
        },
        DAOShipAndVaultLauncher: {
          address: daoShipAndVaultLauncherAddress,
          blockNumber:
            daoShipAndVaultLauncher.deploymentTransaction()?.blockNumber || 0,
        },
      },
      references: {
        DAOShipSingleton: daoShipSingleton,
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
    console.log(`   DAOShipLauncher:         ${daoShipLauncherAddress}`);
    console.log(
      `   DAOShipAndVaultLauncher: ${daoShipAndVaultLauncherAddress}`
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
