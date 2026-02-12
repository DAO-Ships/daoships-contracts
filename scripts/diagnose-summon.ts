import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("🔍 DIAGNOSING SUMMON-DAO FAILURE\n");

  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;

  console.log("Network:", await provider.getNetwork());
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(deployer.address)), "QUAI\n");

  // Step 1: Check deployed contract bytecode
  console.log("============================================================");
  console.log("STEP 1: Verify Deployed Contract");
  console.log("============================================================\n");

  const baalAndVaultSummonerAddress = process.env.BAAL_AND_VAULT_SUMMONER!;
  const baalSummonerAddress = process.env.BAAL_SUMMONER!;

  console.log("BaalAndVaultSummoner:", baalAndVaultSummonerAddress);
  console.log("BaalSummoner:", baalSummonerAddress);

  const deployedCode = await provider.getCode(baalAndVaultSummonerAddress);
  console.log("Deployed bytecode length:", deployedCode.length, "chars\n");

  // Step 2: Get contract instance and check configuration
  console.log("============================================================");
  console.log("STEP 2: Check Contract Configuration");
  console.log("============================================================\n");

  const BaalAndVaultSummoner = await ethers.getContractFactory("BaalAndVaultSummoner");
  const summoner = BaalAndVaultSummoner.attach(baalAndVaultSummonerAddress) as any;

  try {
    const configBaalSummoner = await summoner.baalSummoner();
    const configVaultFactory = await summoner.quaiVaultFactory();

    console.log("✅ Contract readable");
    console.log("   baalSummoner:", configBaalSummoner);
    console.log("   quaiVaultFactory:", configVaultFactory);

    if (configBaalSummoner.toLowerCase() !== baalSummonerAddress.toLowerCase()) {
      console.log("⚠️  WARNING: baalSummoner mismatch!");
      console.log("   Expected:", baalSummonerAddress);
      console.log("   Got:", configBaalSummoner);
    }
  } catch (error: any) {
    console.log("❌ Failed to read contract configuration");
    console.log("   Error:", error.message);
  }

  // Step 3: Prepare minimal test parameters
  console.log("\n============================================================");
  console.log("STEP 3: Prepare Test Parameters");
  console.log("============================================================\n");

  const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
    [
      60,  // 1 minute voting (for testing)
      30,  // 30 seconds grace
      ethers.parseEther("0.01"),
      2000,  // 20% quorum
      ethers.parseEther("1"),
      6600   // 66% retention
    ]
  );

  console.log("Governance config encoded:", governanceConfig.length, "chars");

  // Test with 11 parameters first
  console.log("\n--- Testing with 11 parameters (OLD) ---");
  const initParams11 = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "address", "address", "address", "address", "address", "bytes",
      "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]"
    ],
    [
      ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
      process.env.MULTISEND_LIBRARY!,
      governanceConfig,
      [], [], [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")]
    ]
  );
  console.log("11-parameter encoding length:", initParams11.length, "chars");

  // Test with 12 parameters
  console.log("\n--- Testing with 12 parameters (NEW) ---");
  const initParams12 = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "address", "address", "address", "address", "address", "bytes",
      "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]",
      "address[]"  // 12th parameter
    ],
    [
      ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
      process.env.MULTISEND_LIBRARY!,
      governanceConfig,
      [], [], [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")],
      []  // empty guild tokens
    ]
  );
  console.log("12-parameter encoding length:", initParams12.length, "chars");

  // Step 4: Test function calls
  console.log("\n============================================================");
  console.log("STEP 4: Test Function Calls");
  console.log("============================================================\n");

  // Try calling with 11 parameters
  console.log("--- Attempt 1: Call with 11 parameters ---");
  try {
    const tx11 = await summoner.summonBaalAndVault.populateTransaction(
      initParams11,
      [],  // no initialization actions
      [deployer.address],  // vault owners
      1,   // threshold
      1,   // vault salt
      2,   // shares salt
      3,   // loot salt
      4    // baal salt
    );

    try {
      const gas11 = await provider.estimateGas(tx11);
      console.log("✅ SUCCESS with 11 parameters!");
      console.log("   Estimated gas:", gas11.toString());
    } catch (error: any) {
      console.log("❌ FAILED with 11 parameters");
      console.log("   Error:", error.message);
      if (error.data) {
        console.log("   Error data:", error.data);
      }
    }
  } catch (error: any) {
    console.log("❌ Failed to populate transaction with 11 parameters");
    console.log("   Error:", error.message);
  }

  // Try calling with 12 parameters
  console.log("\n--- Attempt 2: Call with 12 parameters ---");
  try {
    const tx12 = await summoner.summonBaalAndVault.populateTransaction(
      initParams12,
      [],  // no initialization actions
      [deployer.address],  // vault owners
      1,   // threshold
      1,   // vault salt
      2,   // shares salt
      3,   // loot salt
      4    // baal salt
    );

    try {
      const gas12 = await provider.estimateGas(tx12);
      console.log("✅ SUCCESS with 12 parameters!");
      console.log("   Estimated gas:", gas12.toString());
    } catch (error: any) {
      console.log("❌ FAILED with 12 parameters");
      console.log("   Error:", error.message);
      if (error.data) {
        console.log("   Error data:", error.data);
      }
      if (error.info) {
        console.log("   Error info:", JSON.stringify(error.info, null, 2));
      }
    }
  } catch (error: any) {
    console.log("❌ Failed to populate transaction with 12 parameters");
    console.log("   Error:", error.message);
  }

  // Step 5: Test _replaceAvatar directly if possible
  console.log("\n============================================================");
  console.log("STEP 5: Check BaalSummoner");
  console.log("============================================================\n");

  const BaalSummoner = await ethers.getContractFactory("BaalSummoner");
  const baalSummoner = BaalSummoner.attach(baalSummonerAddress) as any;

  try {
    const baalTemplate = await baalSummoner.template();
    const sharesTemplate = await baalSummoner.sharesTemplate();
    const lootTemplate = await baalSummoner.lootTemplate();

    console.log("✅ BaalSummoner readable");
    console.log("   template (Baal):", baalTemplate);
    console.log("   sharesTemplate:", sharesTemplate);
    console.log("   lootTemplate:", lootTemplate);

    // Try calling summonBaal directly with 12 parameters
    console.log("\n--- Testing BaalSummoner.summonBaal directly ---");
    try {
      const txDirect = await baalSummoner.summonBaal.populateTransaction(
        initParams12,
        [],  // no initialization actions
        2,   // shares salt
        3,   // loot salt
        4    // baal salt
      );

      const gasDirect = await provider.estimateGas(txDirect);
      console.log("✅ BaalSummoner.summonBaal works with 12 parameters!");
      console.log("   Estimated gas:", gasDirect.toString());
    } catch (error: any) {
      console.log("❌ BaalSummoner.summonBaal failed");
      console.log("   Error:", error.message);
    }
  } catch (error: any) {
    console.log("❌ Failed to read BaalSummoner configuration");
    console.log("   Error:", error.message);
  }

  // Step 6: Check Baal singleton
  console.log("\n============================================================");
  console.log("STEP 6: Check Baal Singleton");
  console.log("============================================================\n");

  const baalSingletonAddress = process.env.BAAL_SINGLETON!;
  console.log("BaalSingleton:", baalSingletonAddress);

  const Baal = await ethers.getContractFactory("Baal");
  const baalSingleton = Baal.attach(baalSingletonAddress) as any;

  // Check if setUp has been called (avatar should be zero)
  try {
    const avatar = await baalSingleton.avatar();
    console.log("Avatar:", avatar);

    if (avatar === ethers.ZeroAddress) {
      console.log("✅ Baal singleton not initialized (correct)");
    } else {
      console.log("⚠️  Baal singleton already initialized!");
    }
  } catch (error: any) {
    console.log("❌ Failed to read Baal singleton");
    console.log("   Error:", error.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n💥 Fatal error:", error);
    process.exit(1);
  });
