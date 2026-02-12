import fs from "fs";
import path from "path";

/**
 * Update .env file with deployed contract addresses
 * Reads the latest deployment file and updates .env
 */
async function main() {
  const deploymentsDir = path.join(__dirname, "../deployments");

  // Check if deployments directory exists
  if (!fs.existsSync(deploymentsDir)) {
    console.error("❌ No deployments directory found. Run deployment first.");
    process.exit(1);
  }

  // Find latest deployment file
  const files = fs.readdirSync(deploymentsDir);
  const deploymentFiles = files
    .filter((f) => f.startsWith("deployment-complete-"))
    .sort()
    .reverse();

  if (deploymentFiles.length === 0) {
    console.error("❌ No deployment files found. Run deployment first.");
    process.exit(1);
  }

  const latestDeployment = deploymentFiles[0];
  console.log(`📄 Using deployment file: ${latestDeployment}`);

  // Read deployment data
  const deploymentData = JSON.parse(
    fs.readFileSync(path.join(deploymentsDir, latestDeployment), "utf-8")
  );

  console.log(`\n📊 Deployment Info:`);
  console.log(`   Network: ${deploymentData.network}`);
  console.log(`   Chain ID: ${deploymentData.chainId}`);
  console.log(`   Deployer: ${deploymentData.deployer}`);

  // Read current .env file
  const envPath = path.join(__dirname, "../.env");
  const envExamplePath = path.join(__dirname, "../.env.example");

  let envContent = "";
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
    console.log("\n✅ Found existing .env file");
  } else if (fs.existsSync(envExamplePath)) {
    envContent = fs.readFileSync(envExamplePath, "utf-8");
    console.log("\n📝 Creating .env from .env.example");
  } else {
    console.error("❌ No .env or .env.example found");
    process.exit(1);
  }

  // Update or add deployment addresses
  const updates: { [key: string]: string } = {
    BAAL_SINGLETON: deploymentData.contracts.BaalSingleton || "",
    SHARES_SINGLETON: deploymentData.contracts.SharesERC20Singleton || "",
    LOOT_SINGLETON: deploymentData.contracts.LootERC20Singleton || "",
    BAAL_SUMMONER: deploymentData.contracts.BaalSummoner || "",
    BAAL_AND_VAULT_SUMMONER: deploymentData.contracts.BaalAndVaultSummoner || "",
    POSTER: deploymentData.contracts.Poster || "",
    ONBOARDER_SHAMAN: deploymentData.contracts.OnboarderShaman || "",
    ETH_ONBOARDER_SHAMAN: deploymentData.contracts.EthOnboarderShaman || "",
    CHECKIN_SHAMAN: deploymentData.contracts.CheckInShamanV2 || "",
  };

  console.log("\n🔄 Updating addresses:");

  let updatedContent = envContent;
  for (const [key, value] of Object.entries(updates)) {
    if (!value) continue;

    console.log(`   ${key}=${value}`);

    // Check if key exists in env
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(updatedContent)) {
      // Update existing
      updatedContent = updatedContent.replace(regex, `${key}=${value}`);
    } else {
      // Add new
      updatedContent += `\n${key}=${value}`;
    }
  }

  // Ensure deployment addresses section exists
  if (!updatedContent.includes("# Deployed Contract Addresses")) {
    updatedContent += `\n\n# Deployed Contract Addresses (${deploymentData.network})`;
  }

  // Write updated .env
  fs.writeFileSync(envPath, updatedContent);
  console.log("\n✅ .env file updated successfully!");

  // Also update .env.e2e if it exists
  const envE2EPath = path.join(__dirname, "../.env.e2e");
  if (fs.existsSync(envE2EPath)) {
    console.log("\n🔄 Updating .env.e2e...");
    let envE2EContent = fs.readFileSync(envE2EPath, "utf-8");

    for (const [key, value] of Object.entries(updates)) {
      if (!value) continue;

      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envE2EContent)) {
        envE2EContent = envE2EContent.replace(regex, `${key}=${value}`);
      } else {
        envE2EContent += `\n${key}=${value}`;
      }
    }

    fs.writeFileSync(envE2EPath, envE2EContent);
    console.log("✅ .env.e2e file updated successfully!");
  } else {
    console.log("\n💡 .env.e2e not found (skip E2E config update)");
  }

  // Also create a deployment-addresses.json for easy reference
  const addressesJson = {
    network: deploymentData.network,
    chainId: deploymentData.chainId,
    timestamp: deploymentData.timestamp,
    deployer: deploymentData.deployer,
    contracts: deploymentData.contracts,
  };

  fs.writeFileSync(
    path.join(__dirname, "../deployment-addresses.json"),
    JSON.stringify(addressesJson, null, 2)
  );

  console.log("✅ deployment-addresses.json created");

  console.log("\n📋 Deployed Contracts:");
  for (const [name, address] of Object.entries(deploymentData.contracts)) {
    console.log(`   ${name.padEnd(30)} ${address}`);
  }

  console.log("\n🎉 Ready to use! Addresses saved to:");
  console.log("   - .env");
  if (fs.existsSync(path.join(__dirname, "../.env.e2e"))) {
    console.log("   - .env.e2e");
  }
  console.log("   - deployment-addresses.json");
  console.log(`   - deployments/${latestDeployment}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error updating .env:");
    console.error(error);
    process.exit(1);
  });
