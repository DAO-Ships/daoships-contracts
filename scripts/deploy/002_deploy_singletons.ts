import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * Deploy singleton implementations for DAOShip, SharesERC20, and LootERC20
 * These are template contracts that will be cloned via EIP-1167
 */
async function main() {
  console.log("Deploying Singleton Implementations...");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // Deploy SharesERC20 singleton
  console.log("\n1. Deploying SharesERC20 singleton...");
  const SharesERC20 = await ethers.getContractFactory("SharesERC20");
  const sharesSingleton = await SharesERC20.deploy();
  await sharesSingleton.waitForDeployment();
  const sharesAddress = await sharesSingleton.getAddress();
  console.log("✅ SharesERC20 singleton:", sharesAddress);

  // Deploy LootERC20 singleton
  console.log("\n2. Deploying LootERC20 singleton...");
  const LootERC20 = await ethers.getContractFactory("LootERC20");
  const lootSingleton = await LootERC20.deploy();
  await lootSingleton.waitForDeployment();
  const lootAddress = await lootSingleton.getAddress();
  console.log("✅ LootERC20 singleton:", lootAddress);

  // Deploy DAOShip singleton
  console.log("\n3. Deploying DAOShip singleton...");
  const DAOShip = await ethers.getContractFactory("DAOShip");
  const daoShipSingleton = await DAOShip.deploy();
  await daoShipSingleton.waitForDeployment();
  const daoShipAddress = await daoShipSingleton.getAddress();
  console.log("✅ DAOShip singleton:", daoShipAddress);

  // Save deployment info
  const deploymentInfo = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    timestamp: Date.now(),
    deployer: deployer.address,
    contracts: {
      SharesERC20Singleton: {
        address: sharesAddress,
        blockNumber: sharesSingleton.deploymentTransaction()?.blockNumber || 0,
      },
      LootERC20Singleton: {
        address: lootAddress,
        blockNumber: lootSingleton.deploymentTransaction()?.blockNumber || 0,
      },
      DAOShipSingleton: {
        address: daoShipAddress,
        blockNumber: daoShipSingleton.deploymentTransaction()?.blockNumber || 0,
      },
    },
  };

  // Create deployments directory if it doesn't exist
  const deploymentsDir = path.join(__dirname, "../../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  // Save deployment info
  const filename = `singletons-${deploymentInfo.network}-${Date.now()}.json`;
  fs.writeFileSync(
    path.join(deploymentsDir, filename),
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log(`\n📝 Deployment info saved to: deployments/${filename}`);

  console.log("\n✨ All singletons deployed successfully!");
  console.log("\n📋 Summary:");
  console.log(`   SharesERC20: ${sharesAddress}`);
  console.log(`   LootERC20:   ${lootAddress}`);
  console.log(`   DAOShip:     ${daoShipAddress}`);

  return {
    sharesSingleton,
    sharesAddress,
    lootSingleton,
    lootAddress,
    daoShipSingleton,
    daoShipAddress,
  };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

export { main as deploySingletons };
