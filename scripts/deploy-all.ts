import hre from "hardhat";
import * as quais from "quais";
import * as fs from "fs";
import * as path from "path";
import { HttpNetworkConfig } from "hardhat/types";

// Import compiled contract artifacts
const PosterJson = require("../artifacts/contracts/tools/Poster.sol/Poster.json");
const SharesERC20Json = require("../artifacts/contracts/tokens/SharesERC20.sol/SharesERC20.json");
const LootERC20Json = require("../artifacts/contracts/tokens/LootERC20.sol/LootERC20.json");
const BaalJson = require("../artifacts/contracts/core/Baal.sol/Baal.json");
const BaalSummonerJson = require("../artifacts/contracts/core/BaalSummoner.sol/BaalSummoner.json");
const BaalAndVaultSummonerJson = require("../artifacts/contracts/core/BaalAndVaultSummoner.sol/BaalAndVaultSummoner.json");

/**
 * Deploy all contracts in sequence
 * 1. Poster
 * 2. Singletons (Baal, SharesERC20, LootERC20)
 * 3. Factories (BaalSummoner, BaalAndVaultSummoner)
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

  console.log("\n📦 Baal Singleton...");
  const baalIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    BaalJson.bytecode
  );
  console.log("Metadata IPFS hash:", baalIpfsHash);
  ipfsHashes.BaalSingleton = baalIpfsHash;

  const Baal = new quais.ContractFactory(
    BaalJson.abi,
    BaalJson.bytecode,
    wallet,
    baalIpfsHash
  );

  const baalSingleton = await Baal.deploy();
  await baalSingleton.waitForDeployment();
  deployedContracts.BaalSingleton = await baalSingleton.getAddress();
  console.log("Transaction hash:", baalSingleton.deploymentTransaction()?.hash);
  console.log("✅ Baal:", deployedContracts.BaalSingleton);

  // 3. Deploy Factories
  console.log("\n" + "=".repeat(60));
  console.log("STEP 3: Deploying Factories");
  console.log("=".repeat(60));

  console.log("\n🏭 BaalSummoner...");
  const summonerIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
    BaalSummonerJson.bytecode
  );
  console.log("Metadata IPFS hash:", summonerIpfsHash);
  ipfsHashes.BaalSummoner = summonerIpfsHash;

  const BaalSummoner = new quais.ContractFactory(
    BaalSummonerJson.abi,
    BaalSummonerJson.bytecode,
    wallet,
    summonerIpfsHash
  );

  const baalSummoner = await BaalSummoner.deploy(
    deployedContracts.BaalSingleton,
    deployedContracts.SharesERC20Singleton,
    deployedContracts.LootERC20Singleton
  );
  await baalSummoner.waitForDeployment();
  deployedContracts.BaalSummoner = await baalSummoner.getAddress();
  console.log("Transaction hash:", baalSummoner.deploymentTransaction()?.hash);
  console.log("✅ BaalSummoner:", deployedContracts.BaalSummoner);

  // Deploy BaalAndVaultSummoner if QuaiVaultFactory is set
  const quaiVaultFactory = process.env.QUAI_VAULT_FACTORY;
  if (quaiVaultFactory) {
    console.log("\n🏭 BaalAndVaultSummoner...");
    console.log(`   Using BaalSummoner: ${deployedContracts.BaalSummoner}`);
    console.log(`   Using QuaiVaultFactory: ${quaiVaultFactory}`);

    const vaultSummonerIpfsHash = await hre.deployMetadata.pushMetadataToIPFSWithBytecode(
      BaalAndVaultSummonerJson.bytecode
    );
    console.log("Metadata IPFS hash:", vaultSummonerIpfsHash);
    ipfsHashes.BaalAndVaultSummoner = vaultSummonerIpfsHash;

    const BaalAndVaultSummoner = new quais.ContractFactory(
      BaalAndVaultSummonerJson.abi,
      BaalAndVaultSummonerJson.bytecode,
      wallet,
      vaultSummonerIpfsHash
    );

    const baalAndVaultSummoner = await BaalAndVaultSummoner.deploy(
      deployedContracts.BaalSummoner,
      quaiVaultFactory
    );
    await baalAndVaultSummoner.waitForDeployment();
    deployedContracts.BaalAndVaultSummoner =
      await baalAndVaultSummoner.getAddress();
    console.log(
      "Transaction hash:",
      baalAndVaultSummoner.deploymentTransaction()?.hash
    );
    console.log(
      "✅ BaalAndVaultSummoner:",
      deployedContracts.BaalAndVaultSummoner
    );
  } else {
    console.warn(
      "\n⚠️  Skipping BaalAndVaultSummoner (QUAI_VAULT_FACTORY not set)"
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
      MultiSend: process.env.MULTISEND_LIBRARY || "NOT_SET",
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
  console.log("\n   2. (Optional) Deploy shamans: npm run deploy:shamans");
  console.log("      (OnboarderShaman, EthOnboarderShaman, CheckInShamanV2)");
  console.log("      Then run: npm run update-env again");
  console.log("\n   3. Verify contracts on block explorer (if available)");
  console.log("   4. Update indexer configuration with contract addresses");
  console.log("   5. Test deployment with: npm run test:integration");
  console.log("   6. Summon a test DAO with: npm run summon-dao");

  return deployedContracts;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  });
