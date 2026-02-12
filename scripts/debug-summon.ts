import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("🔍 Debugging summon-dao revert...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const baalAndVaultSummoner = await ethers.getContractAt(
    "BaalAndVaultSummoner",
    process.env.BAAL_AND_VAULT_SUMMONER!
  );

  const baalSummoner = await ethers.getContractAt(
    "BaalSummoner",
    process.env.BAAL_SUMMONER!
  );

  // Prepare minimal test parameters
  const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
    [
      604800,  // 7 days voting
      259200,  // 3 days grace
      ethers.parseEther("0.1"), // offering
      2000,    // 20% quorum
      ethers.parseEther("1"),   // 1 share sponsor threshold
      6600     // 66% retention
    ]
  );

  const initMembers = [deployer.address];
  const initShareAmounts = [ethers.parseEther("100")];
  const initLootAmounts = [ethers.parseEther("0")];

  // Create initialization params with 12 parameters
  const initializationParams = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "address",   // lootToken
      "address",   // sharesToken
      "address",   // avatar
      "address",   // forwarder
      "address",   // multisendLibrary
      "bytes",     // governanceConfig
      "address[]", // shamans
      "uint256[]", // shamanPermissions
      "address[]", // initMembers
      "uint256[]", // initShareAmounts
      "uint256[]", // initLootAmounts
      "address[]", // guildTokens (12th parameter)
    ],
    [
      ethers.ZeroAddress,  // loot (will be cloned)
      ethers.ZeroAddress,  // shares (will be cloned)
      ethers.ZeroAddress,  // avatar (will be replaced by vault)
      ethers.ZeroAddress,  // forwarder (none)
      process.env.MULTISEND_LIBRARY!,
      governanceConfig,
      [],  // no shamans
      [],  // no shaman permissions
      initMembers,
      initShareAmounts,
      initLootAmounts,
      [],  // guild tokens (can be set via proposals later)
    ]
  );

  console.log("✅ Initialization params encoded (12 parameters)");
  console.log("   Length:", initializationParams.length, "bytes\n");

  // Try to call summonBaalAndVault with callStatic to get revert reason
  try {
    console.log("🔮 Attempting static call to summonBaalAndVault...\n");

    const result = await baalAndVaultSummoner.summonBaalAndVault.staticCall(
      initializationParams,
      [],  // no initialization actions
      [deployer.address],  // vault owners
      1,   // threshold
      1,   // vault salt
      2,   // shares salt
      3,   // loot salt
      4    // baal salt
    );

    console.log("✅ Static call succeeded!");
    console.log("   Baal:", result[0]);
    console.log("   Vault:", result[1]);
  } catch (error: any) {
    console.log("❌ Static call failed with error:");
    console.log(error.message);

    // Try to decode the error
    if (error.data) {
      console.log("\n📝 Error data:", error.data);

      // Try to decode as a string revert reason
      try {
        const reason = ethers.toUtf8String("0x" + error.data.slice(138));
        console.log("   Decoded reason:", reason);
      } catch {
        console.log("   Could not decode as string");
      }
    }

    // Also check error info
    if (error.info) {
      console.log("\n📋 Error info:");
      console.log(JSON.stringify(error.info, null, 2));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
