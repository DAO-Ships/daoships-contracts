import hre from "hardhat";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import { HttpNetworkConfig } from "hardhat/types";

// Import compiled contract artifacts
const PosterJson = require("../artifacts/contracts/tools/Poster.sol/Poster.json");
const SharesERC20Json = require("../artifacts/contracts/tokens/SharesERC20.sol/SharesERC20.json");
const LootERC20Json = require("../artifacts/contracts/tokens/LootERC20.sol/LootERC20.json");
const DAOShipJson = require("../artifacts/contracts/core/DAOShip.sol/DAOShip.json");
const DAOShipLauncherJson = require("../artifacts/contracts/core/DAOShipLauncher.sol/DAOShipLauncher.json");
const DAOShipAndVaultLauncherJson = require("../artifacts/contracts/core/DAOShipAndVaultLauncher.sol/DAOShipAndVaultLauncher.json");

/**
 * Deploy all contracts in sequence
 * 1. Poster
 * 2. Singletons (DAOShip, SharesERC20, LootERC20)
 * 3. Factories (DAOShipLauncher, DAOShipAndVaultLauncher)
 */
async function main() {
  console.log("=".repeat(60));
  console.log("🚀 Starting Full Deployment");
  console.log("=".repeat(60));
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

  console.log("Deploying with account:", wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log("Account balance:", quais.formatQuai(balance), "QUAI\n");

  const deployedContracts: any = {};
  const ipfsHashes: any = {};

  // 1. Deploy Poster
  console.log("=".repeat(60));
  console.log("STEP 1: Deploying Poster");
  console.log("=".repeat(60));

  const posterIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    PosterJson.bytecode
  );
  console.log("Metadata IPFS hash:", posterIpfsHash);
  ipfsHashes.Poster = posterIpfsHash;

  const Poster = new quais.ContractFactory(
    PosterJson.abi,
    PosterJson.bytecode,
    wallet,
    posterIpfsHash
  );

  const poster = await Poster.deploy();
  await poster.waitForDeployment();
  deployedContracts.Poster = await poster.getAddress();
  console.log("Transaction hash:", poster.deploymentTransaction()?.hash);
  console.log("✅ Poster:", deployedContracts.Poster);

  // 2. Deploy Singletons
  console.log("\n" + "=".repeat(60));
  console.log("STEP 2: Deploying Singletons");
  console.log("=".repeat(60));

  console.log("\n📦 SharesERC20 Singleton...");
  const sharesIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    SharesERC20Json.bytecode
  );
  console.log("Metadata IPFS hash:", sharesIpfsHash);
  ipfsHashes.SharesERC20Singleton = sharesIpfsHash;

  const SharesERC20 = new quais.ContractFactory(
    SharesERC20Json.abi,
    SharesERC20Json.bytecode,
    wallet,
    sharesIpfsHash
  );

  const sharesSingleton = await SharesERC20.deploy();
  await sharesSingleton.waitForDeployment();
  deployedContracts.SharesERC20Singleton = await sharesSingleton.getAddress();
  console.log(
    "Transaction hash:",
    sharesSingleton.deploymentTransaction()?.hash
  );
  console.log("✅ SharesERC20:", deployedContracts.SharesERC20Singleton);

  console.log("\n📦 LootERC20 Singleton...");
  const lootIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    LootERC20Json.bytecode
  );
  console.log("Metadata IPFS hash:", lootIpfsHash);
  ipfsHashes.LootERC20Singleton = lootIpfsHash;

  const LootERC20 = new quais.ContractFactory(
    LootERC20Json.abi,
    LootERC20Json.bytecode,
    wallet,
    lootIpfsHash
  );

  const lootSingleton = await LootERC20.deploy();
  await lootSingleton.waitForDeployment();
  deployedContracts.LootERC20Singleton = await lootSingleton.getAddress();
  console.log("Transaction hash:", lootSingleton.deploymentTransaction()?.hash);
  console.log("✅ LootERC20:", deployedContracts.LootERC20Singleton);

  console.log("\n📦 DAOShip Singleton...");
  const daoShipIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    DAOShipJson.bytecode
  );
  console.log("Metadata IPFS hash:", daoShipIpfsHash);
  ipfsHashes.DAOShipSingleton = daoShipIpfsHash;

  const DAOShip = new quais.ContractFactory(
    DAOShipJson.abi,
    DAOShipJson.bytecode,
    wallet,
    daoShipIpfsHash
  );

  const daoShipSingleton = await DAOShip.deploy();
  await daoShipSingleton.waitForDeployment();
  deployedContracts.DAOShipSingleton = await daoShipSingleton.getAddress();
  console.log("Transaction hash:", daoShipSingleton.deploymentTransaction()?.hash);
  console.log("✅ DAOShip:", deployedContracts.DAOShipSingleton);

  // 3. Deploy Factories
  console.log("\n" + "=".repeat(60));
  console.log("STEP 3: Deploying Factories");
  console.log("=".repeat(60));

  console.log("\n🏭 DAOShipLauncher...");
  const launcherIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    DAOShipLauncherJson.bytecode
  );
  console.log("Metadata IPFS hash:", launcherIpfsHash);
  ipfsHashes.DAOShipLauncher = launcherIpfsHash;

  const DAOShipLauncher = new quais.ContractFactory(
    DAOShipLauncherJson.abi,
    DAOShipLauncherJson.bytecode,
    wallet,
    launcherIpfsHash
  );

  const daoShipLauncher = await DAOShipLauncher.deploy(
    deployedContracts.DAOShipSingleton,
    deployedContracts.SharesERC20Singleton,
    deployedContracts.LootERC20Singleton
  );
  await daoShipLauncher.waitForDeployment();
  deployedContracts.DAOShipLauncher = await daoShipLauncher.getAddress();
  console.log("Transaction hash:", daoShipLauncher.deploymentTransaction()?.hash);
  console.log("✅ DAOShipLauncher:", deployedContracts.DAOShipLauncher);

  // Deploy DAOShipAndVaultLauncher if QuaiVaultFactory is set
  const quaiVaultFactory = process.env.QUAI_VAULT_FACTORY;
  const multisendCallOnly = process.env.MULTISEND_CALL_ONLY;
  if (quaiVaultFactory) {
    if (!multisendCallOnly) {
      throw new Error("MULTISEND_CALL_ONLY address required for DAOShipAndVaultLauncher deployment");
    }
    console.log("\n🏭 DAOShipAndVaultLauncher...");
    console.log(`   Using DAOShipLauncher: ${deployedContracts.DAOShipLauncher}`);
    console.log(`   Using QuaiVaultFactory: ${quaiVaultFactory}`);
    console.log(`   Using MultiSendCallOnly: ${multisendCallOnly}`);

    const vaultLauncherIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
      DAOShipAndVaultLauncherJson.deployedBytecode
    );
    console.log("Metadata IPFS hash:", vaultLauncherIpfsHash);
    ipfsHashes.DAOShipAndVaultLauncher = vaultLauncherIpfsHash;

    const DAOShipAndVaultLauncher = new quais.ContractFactory(
      DAOShipAndVaultLauncherJson.abi,
      DAOShipAndVaultLauncherJson.bytecode,
      wallet,
      vaultLauncherIpfsHash
    );

    const daoShipAndVaultLauncher = await DAOShipAndVaultLauncher.deploy(
      deployedContracts.DAOShipLauncher,
      quaiVaultFactory,
      multisendCallOnly
    );
    await daoShipAndVaultLauncher.waitForDeployment();
    deployedContracts.DAOShipAndVaultLauncher =
      await daoShipAndVaultLauncher.getAddress();
    console.log(
      "Transaction hash:",
      daoShipAndVaultLauncher.deploymentTransaction()?.hash
    );
    console.log(
      "✅ DAOShipAndVaultLauncher:",
      deployedContracts.DAOShipAndVaultLauncher
    );
  } else {
    console.warn(
      "\n⚠️  Skipping DAOShipAndVaultLauncher (QUAI_VAULT_FACTORY not set)"
    );
  }

  // 4. Save consolidated deployment info
  console.log("\n" + "=".repeat(60));
  console.log("STEP 4: Saving Deployment Info");
  console.log("=".repeat(60));

  const deploymentInfo = {
    network: hre.network.name,
    chainId: (await provider.getNetwork()).chainId.toString(),
    timestamp: Date.now(),
    deployer: wallet.address,
    contracts: deployedContracts,
    ipfsHashes: ipfsHashes,
    references: {
      QuaiVaultFactory: quaiVaultFactory || "NOT_SET",
      MultiSendCallOnly: multisendCallOnly || "NOT_SET",
    },
  };

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filename = `deployment-complete-${hre.network.name}-${Date.now()}.json`;
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

  console.log("\n📦 IPFS Metadata Hashes:");
  for (const [name, hash] of Object.entries(ipfsHashes)) {
    console.log(`   ${name.padEnd(30)} ${hash}`);
  }

  console.log("\n🎉 All contracts deployed successfully!");
  console.log("\n📝 Next Steps:");
  console.log("   1. Run: npm run update-env");
  console.log("      (Updates .env and .env.e2e with deployed addresses)");
  console.log("\n   2. (Optional) Deploy navigators: npm run deploy:navigators");
  console.log("      (OnboarderNavigator, ERC20TributeNavigator)");
  console.log("      Then run: npm run update-env again");
  console.log("\n   3. Verify contracts on block explorer (if available)");
  console.log("   4. Update indexer configuration with contract addresses");
  console.log("   5. Test deployment with: npm run test:integration");
  console.log("   6. Create a test DAO with: npm run create-dao");

  return deployedContracts;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  });
