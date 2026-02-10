import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * Deploy Poster contract (EIP-3722 metadata)
 * This is a singleton - only needs one deployment per network
 */
async function main() {
  console.log("Deploying Poster...");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // Deploy Poster
  const Poster = await ethers.getContractFactory("Poster");
  const poster = await Poster.deploy();
  await poster.waitForDeployment();

  const posterAddress = await poster.getAddress();
  console.log("✅ Poster deployed to:", posterAddress);

  // Save deployment info
  const deploymentInfo = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    timestamp: Date.now(),
    deployer: deployer.address,
    contracts: {
      Poster: {
        address: posterAddress,
        blockNumber: poster.deploymentTransaction()?.blockNumber || 0,
      },
    },
  };

  // Create deployments directory if it doesn't exist
  const deploymentsDir = path.join(__dirname, "../../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  // Save deployment info
  const filename = `deployment-${deploymentInfo.network}-${Date.now()}.json`;
  fs.writeFileSync(
    path.join(deploymentsDir, filename),
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log(`\n📝 Deployment info saved to: deployments/${filename}`);

  return { poster, posterAddress };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

export { main as deployPoster };
