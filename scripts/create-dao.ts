import { quais } from "quais";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const TARGET_PREFIX = "0x00"; // cyprus1 shard
const MAX_MINING_ATTEMPTS = 100000;

/**
 * Atomic DAO + Vault Deployment using DAOShipAndVaultLauncher
 * Tests the refactored composition pattern (no external self-call)
 */

// Helper: Get minimal proxy bytecode for CREATE2 address prediction
function getMinimalProxyBytecode(implementation: string): string {
  const implAddr = implementation.toLowerCase().replace("0x", "");
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddr}5af43d82803e903d91602b57fd5bf3`;
}

// Helper: Mine salt for DAOShipLauncher clones
// IMPORTANT: senderAddress = msg.sender that will call DAOShipLauncher.launchDAOShip()
//            For atomic deployment, this is DAOShipAndVaultLauncher (NOT user wallet!)
async function mineDAOShipSalt(
  senderAddress: string,
  daoShipLauncherAddress: string,
  singletonAddress: string,
  label: string
): Promise<{ salt: string; address: string }> {
  const bytecode = getMinimalProxyBytecode(singletonAddress);
  const initCodeHash = quais.keccak256(bytecode);

  for (let i = 0; i < MAX_MINING_ATTEMPTS; i++) {
    const userSalt = quais.hexlify(quais.randomBytes(32));
    const userSaltBigInt = BigInt(userSalt);

    // DAOShipLauncher uses keccak256(abi.encodePacked(msg.sender, salt))
    // msg.sender = senderAddress (DAOShipAndVaultLauncher for atomic deployment)
    const fullSalt = quais.keccak256(
      quais.solidityPacked(["address", "uint256"], [senderAddress, userSaltBigInt])
    );

    // CREATE2 is deployed from DAOShipLauncher contract
    const address = quais.getCreate2Address(daoShipLauncherAddress, fullSalt, initCodeHash);

    if (address.toLowerCase().startsWith(TARGET_PREFIX.toLowerCase()) && quais.isQuaiAddress(address)) {
      return { salt: userSalt, address };
    }

    if ((i + 1) % 10000 === 0) {
      console.log(`      ${label}: ${i + 1} attempts...`);
    }
  }

  throw new Error(`Failed to mine ${label} salt after ${MAX_MINING_ATTEMPTS} attempts`);
}

// Helper: Mine salt for Quai Vault (sender = DAOShipAndVaultLauncher)
async function mineVaultSalt(
  daoShipAndVaultLauncherAddress: string,
  quaiVaultFactory: string,
  quaiVaultImplementation: string,
  vaultOwners: string[],
  vaultThreshold: number,
  QuaiVaultJson: any,
  QuaiVaultProxyJson: any,
  minExecutionDelay: number = 0,
  initialModules: string[] = [],
  initialDelegatecallTargets: string[] = []
): Promise<{ salt: string; address: string }> {
  // Use passed artifacts (loaded in main function)

  // Prepare vault initialization data (5-param initialize)
  // Must match what QuaiVaultFactory.createWallet encodes internally
  const vaultIface = new quais.Interface(QuaiVaultJson.abi);
  const initData = vaultIface.encodeFunctionData("initialize", [
    vaultOwners, vaultThreshold, minExecutionDelay, initialModules, initialDelegatecallTargets
  ]);
  const encodedArgs = quais.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes"],
    [quaiVaultImplementation, initData]
  );
  const fullBytecode = QuaiVaultProxyJson.bytecode + encodedArgs.slice(2);
  const bytecodeHash = quais.keccak256(fullBytecode);

  for (let i = 0; i < MAX_MINING_ATTEMPTS; i++) {
    const userSalt = quais.hexlify(quais.randomBytes(32));

    // QuaiVaultFactory uses keccak256(abi.encodePacked(msg.sender, salt))
    // msg.sender = DAOShipAndVaultLauncher
    const fullSalt = quais.keccak256(
      quais.solidityPacked(["address", "bytes32"], [daoShipAndVaultLauncherAddress, userSalt])
    );

    const address = quais.getCreate2Address(quaiVaultFactory, fullSalt, bytecodeHash);

    if (address.toLowerCase().startsWith(TARGET_PREFIX) && quais.isQuaiAddress(address)) {
      return { salt: userSalt, address };
    }

    if ((i + 1) % 10000 === 0) {
      console.log(`      Vault: ${i + 1} attempts...`);
    }
  }

  throw new Error(`Failed to mine vault salt after ${MAX_MINING_ATTEMPTS} attempts`);
}

async function main() {
  console.log("============================================================");
  console.log("⚡ Atomic DAO + Vault Deployment");
  console.log("🔧 Using DAOShipAndVaultLauncher (Composition Pattern)");
  console.log("============================================================\n");

  const rpcUrl = process.env.RPC_URL || "https://rpc.orchard.quai.network";
  const provider = new quais.JsonRpcProvider(rpcUrl, undefined, { usePathing: true });
  const privateKey = process.env.CYPRUS1_PK;
  if (!privateKey) throw new Error("CYPRUS1_PK not set");

  const wallet = new quais.Wallet(privateKey, provider);

  // Load Quai Vault artifacts (used for salt mining and proposal submission)
  const QuaiVaultJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../quaiVaultArtifacts/QuaiVault.json"), "utf-8")
  );
  const QuaiVaultProxyJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../quaiVaultArtifacts/QuaiVaultProxy.json"), "utf-8")
  );

  // Load deployment addresses
  const deploymentPath = path.join(__dirname, "../deployment-addresses.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      "deployment-addresses.json not found. Run 'npm run deploy:all' and 'npm run update-env' first."
    );
  }

  const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

  const daoShipAndVaultLauncher = deploymentData.contracts.DAOShipAndVaultLauncher;
  const daoShipLauncher = deploymentData.contracts.DAOShipLauncher;
  const sharesSingleton = deploymentData.contracts.SharesERC20Singleton;
  const lootSingleton = deploymentData.contracts.LootERC20Singleton;
  const daoShipSingleton = deploymentData.contracts.DAOShipSingleton;
  const multisendCallOnly = process.env.MULTISEND_CALL_ONLY!;
  const quaiVaultFactory = process.env.QUAI_VAULT_FACTORY!;
  const quaiVaultImplementation = process.env.QUAI_VAULT_IMPLEMENTATION!;

  if (!multisendCallOnly) throw new Error("MULTISEND_CALL_ONLY address required");

  if (!daoShipAndVaultLauncher) {
    throw new Error(
      "DAOShipAndVaultLauncher not deployed. Ensure QUAI_VAULT_FACTORY was set during deployment."
    );
  }

  console.log("📦 Using contracts:");
  console.log(`   DAOShipAndVaultLauncher: ${daoShipAndVaultLauncher}`);
  console.log(`   DAOShipLauncher:         ${daoShipLauncher}`);
  console.log(`   QuaiVaultFactory:        ${quaiVaultFactory}\n`);

  console.log("👤 Wallet:", wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log("💰 Balance:", quais.formatQuai(balance), "QUAI\n");

  // Configuration
  const vaultOwnersEnv = process.env.VAULT_OWNERS;
  const vaultOwners = vaultOwnersEnv
    ? vaultOwnersEnv.split(",").map((a) => a.trim())
    : [wallet.address];
  const vaultThreshold = parseInt(process.env.VAULT_THRESHOLD || "1");

  const daoMembersEnv = process.env.DAO_MEMBERS;
  const initMembers = daoMembersEnv
    ? daoMembersEnv.split(",").map((a) => a.trim())
    : [wallet.address];
  const sharesEnv = process.env.DAO_SHARES;
  const initShareAmounts = sharesEnv
    ? sharesEnv.split(",").map((s) => quais.parseQuai(s.trim()))
    : [quais.parseQuai("175")];
  const lootEnv = process.env.DAO_LOOT;
  const initLootAmounts = lootEnv
    ? lootEnv.split(",").map((s) => quais.parseQuai(s.trim()))
    : [quais.parseQuai("0")];

  console.log("============================================================");
  console.log("STEP 1: Mine Salts (Cyprus1 Shard Addresses)");
  console.log("============================================================\n");

  console.log("⚠️  CRITICAL: Salt sender addresses for atomic deployment:");
  console.log(`   - Vault:    DAOShipAndVaultLauncher calls QuaiVaultFactory`);
  console.log(`               msg.sender = ${daoShipAndVaultLauncher}`);
  console.log(`   - DAOShip:  DAOShipAndVaultLauncher calls DAOShipLauncher`);
  console.log(`               msg.sender = ${daoShipAndVaultLauncher} (NOT user wallet!)`);
  console.log(`   - Tokens:   DAOShipLauncher deploys via CREATE2`);
  console.log(`               msg.sender = ${daoShipLauncher}\n`);

  const vaultMinExecutionDelay = parseInt(process.env.VAULT_MIN_EXECUTION_DELAY || "0");

  // Mine DAOShip/token salts FIRST so we know the predicted DAOShip address for vault initialModules
  console.log("⛏️  Mining DAOShip salts (sender = DAOShipAndVaultLauncher → DAOShipLauncher)...");
  console.log("   Note: When DAOShipAndVaultLauncher calls DAOShipLauncher.launchDAOShip(),");
  console.log("         msg.sender to DAOShipLauncher is DAOShipAndVaultLauncher!\n");

  const shares = await mineDAOShipSalt(daoShipAndVaultLauncher, daoShipLauncher, sharesSingleton, "Shares");
  console.log(`   ✅ Shares:  ${shares.address}`);

  const loot = await mineDAOShipSalt(daoShipAndVaultLauncher, daoShipLauncher, lootSingleton, "Loot");
  console.log(`   ✅ Loot:    ${loot.address}`);

  const daoShip = await mineDAOShipSalt(daoShipAndVaultLauncher, daoShipLauncher, daoShipSingleton, "DAOShip");
  console.log(`   ✅ DAOShip: ${daoShip.address}\n`);

  // Now mine vault salt with initialModules=[predictedDAOShipAddress] and initialDelegatecallTargets=[multisendCallOnly]
  // This enables DAOShip as a module and whitelists MultiSendCallOnly for delegatecall atomically
  console.log("⛏️  Mining vault salt (sender = DAOShipAndVaultLauncher)...");
  console.log(`   minExecutionDelay: ${vaultMinExecutionDelay}s`);
  console.log(`   initialModules: [${daoShip.address}]`);
  console.log(`   initialDelegatecallTargets: [${multisendCallOnly}]`);
  const vault = await mineVaultSalt(
    daoShipAndVaultLauncher,
    quaiVaultFactory,
    quaiVaultImplementation,
    vaultOwners,
    vaultThreshold,
    QuaiVaultJson,
    QuaiVaultProxyJson,
    vaultMinExecutionDelay,
    [daoShip.address],
    [multisendCallOnly]
  );
  console.log(`   ✅ Vault:   ${vault.address}\n`);

  console.log("============================================================");
  console.log("STEP 2: Prepare Initialization Parameters");
  console.log("============================================================\n");

  console.log("🏛️  Vault Configuration:");
  console.log(`   Owners:    ${vaultOwners.join(", ")}`);
  console.log(`   Threshold: ${vaultThreshold}\n`);

  console.log("👥 DAO Members:");
  initMembers.forEach((member, i) => {
    console.log(
      `   ${member} - ${quais.formatQuai(initShareAmounts[i])} shares, ${quais.formatQuai(
        initLootAmounts[i]
      )} loot`
    );
  });
  console.log();

  // Prepare governance config
  const governanceConfig = quais.AbiCoder.defaultAbiCoder().encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
    [
      7 * 24 * 60 * 60, // voting period: 7 days
      3 * 24 * 60 * 60, // grace period: 3 days
      quais.parseQuai("0.1"), // proposal offering: 0.1 QUAI
      2000, // quorum: 20%
      quais.parseQuai("1"), // sponsor threshold: 1 share
      6600, // min retention: 66%
      7 * 24 * 60 * 60, // defaultExpiryWindow: 7 days after graceEnds
    ]
  );

  // Prepare initialization params with avatar = address(0)
  // DAOShipAndVaultLauncher will replace it with the vault address
  const initializationParams = quais.AbiCoder.defaultAbiCoder().encode(
    [
      "address",
      "address",
      "address",
      "address",
      "bytes",
      "address[]",
      "uint256[]",
      "address[]",
      "uint256[]",
      "uint256[]",
      "address[]", // guild tokens
      "bool", // pauseSharesOnLaunch
      "bool", // pauseLootOnLaunch
    ],
    [
      quais.ZeroAddress, // lootToken (filled by DAOShipLauncher)
      quais.ZeroAddress, // sharesToken (filled by DAOShipLauncher)
      quais.ZeroAddress, // avatar (will be replaced with vault address)
      multisendCallOnly, // multisend library
      governanceConfig, // governance config
      [], // navigators (none initially)
      [], // navigator permissions
      initMembers, // initial members
      initShareAmounts, // initial shares
      initLootAmounts, // initial loot
      [], // guild tokens (can be set via proposals later)
      false, // pauseSharesOnLaunch
      false, // pauseLootOnLaunch
    ]
  );

  console.log("============================================================");
  console.log("STEP 3: Call DAOShipAndVaultLauncher.launchDAOShipAndVault()");
  console.log("============================================================\n");

  // Validate parameters
  console.log("🔍 Validating parameters...");
  console.log(`   Vault owners: ${vaultOwners.length} addresses`);
  console.log(`   Vault threshold: ${vaultThreshold}`);
  console.log(`   DAO members: ${initMembers.length} addresses`);
  console.log(`   Init params length: ${initializationParams.length} bytes`);

  if (vaultThreshold > vaultOwners.length) {
    throw new Error(`Invalid vault threshold: ${vaultThreshold} > ${vaultOwners.length} owners`);
  }

  if (initShareAmounts.length !== initMembers.length) {
    throw new Error(`Share amounts (${initShareAmounts.length}) must match members (${initMembers.length})`);
  }

  if (initLootAmounts.length !== initMembers.length) {
    throw new Error(`Loot amounts (${initLootAmounts.length}) must match members (${initMembers.length})`);
  }

  console.log("   ✅ All parameters valid\n");

  // Load DAOShipAndVaultLauncher ABI
  const DAOShipAndVaultLauncherJson = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "../artifacts/contracts/core/DAOShipAndVaultLauncher.sol/DAOShipAndVaultLauncher.json"
      ),
      "utf-8"
    )
  );

  const launcher = new quais.Contract(
    daoShipAndVaultLauncher,
    DAOShipAndVaultLauncherJson.abi,
    wallet
  );

  // Verify contract is deployed
  const code = await provider.getCode(daoShipAndVaultLauncher);
  if (code === "0x") {
    throw new Error(`DAOShipAndVaultLauncher not deployed at ${daoShipAndVaultLauncher}`);
  }
  console.log("✅ DAOShipAndVaultLauncher contract verified");

  // Verify DAOShipAndVaultLauncher configuration
  try {
    const configuredDAOShipLauncher = await launcher.daoShipLauncher();
    const configuredVaultFactory = await launcher.quaiVaultFactory();

    console.log("\n🔧 DAOShipAndVaultLauncher Configuration:");
    console.log(`   daoShipLauncher:  ${configuredDAOShipLauncher}`);
    console.log(`   quaiVaultFactory: ${configuredVaultFactory}`);

    if (configuredDAOShipLauncher.toLowerCase() !== daoShipLauncher.toLowerCase()) {
      console.error(`\n⚠️  WARNING: DAOShipLauncher mismatch!`);
      console.error(`   Expected: ${daoShipLauncher}`);
      console.error(`   Actual:   ${configuredDAOShipLauncher}`);
      throw new Error("DAOShipLauncher address mismatch - redeploy DAOShipAndVaultLauncher");
    }

    if (configuredVaultFactory.toLowerCase() !== quaiVaultFactory.toLowerCase()) {
      console.error(`\n⚠️  WARNING: QuaiVaultFactory mismatch!`);
      console.error(`   Expected: ${quaiVaultFactory}`);
      console.error(`   Actual:   ${configuredVaultFactory}`);
      throw new Error("QuaiVaultFactory address mismatch - check .env configuration");
    }

    console.log("   ✅ Configuration matches expected values\n");
  } catch (configError: any) {
    if (configError.message.includes("mismatch")) {
      throw configError;
    }
    console.error("⚠️  Could not verify configuration (view functions may not be available)");
    console.error(`   Error: ${configError.message}\n`);
  }

  console.log("🔮 Creating DAO and Vault atomically...");
  console.log(`   This will create 4 contracts in a single transaction:\n`);
  console.log(`   1. Quai Vault (via QuaiVaultFactory)`);
  console.log(`   2. SharesERC20 (via DAOShipLauncher → clone)`);
  console.log(`   3. LootERC20 (via DAOShipLauncher → clone)`);
  console.log(`   4. DAOShip (via DAOShipLauncher → clone)\n`);

  try {

    const tx = await launcher.launchDAOShipAndVault(
      initializationParams,
      process.env.SHARE_TOKEN_NAME || "DAO Shares",
      process.env.SHARE_TOKEN_SYMBOL || "SHARES",
      process.env.LOOT_TOKEN_NAME || "DAO Loot",
      process.env.LOOT_TOKEN_SYMBOL || "LOOT",
      vaultOwners,
      vaultThreshold,
      BigInt(vault.salt),
      BigInt(shares.salt),
      BigInt(loot.salt),
      BigInt(daoShip.salt)
    );

    console.log(`   📝 Transaction hash: ${tx.hash}`);
    console.log(`   ⏳ Waiting for confirmation...`);

    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed! Block: ${receipt.blockNumber}`);
    console.log(`   ⛽ Gas used: ${receipt.gasUsed.toString()}\n`);

    // Parse events
    const launchEvent = receipt.logs
      .map((log: any) => {
        try {
          return launcher.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event: any) => event?.name === "LaunchDAOShipAndVault");

    if (launchEvent) {
      console.log("============================================================");
      console.log("✨ SUCCESS! Atomic Deployment Complete");
      console.log("============================================================\n");

      console.log("📋 Deployed Contracts:");
      console.log(`   Vault:   ${launchEvent.args.vault}`);
      console.log(`   Shares:  ${launchEvent.args.shares}`);
      console.log(`   Loot:    ${launchEvent.args.loot}`);
      console.log(`   DAOShip: ${launchEvent.args.daoShip}\n`);

      console.log("🔍 Verification:");
      console.log(`   Expected Vault:   ${vault.address}`);
      console.log(`   Actual Vault:     ${launchEvent.args.vault}`);
      console.log(`   Match: ${vault.address.toLowerCase() === launchEvent.args.vault.toLowerCase() ? "✅" : "❌"}\n`);

      console.log(`   Expected Shares:  ${shares.address}`);
      console.log(`   Actual Shares:    ${launchEvent.args.shares}`);
      console.log(`   Match: ${shares.address.toLowerCase() === launchEvent.args.shares.toLowerCase() ? "✅" : "❌"}\n`);

      console.log(`   Expected Loot:    ${loot.address}`);
      console.log(`   Actual Loot:      ${launchEvent.args.loot}`);
      console.log(`   Match: ${loot.address.toLowerCase() === launchEvent.args.loot.toLowerCase() ? "✅" : "❌"}\n`);

      console.log(`   Expected DAOShip: ${daoShip.address}`);
      console.log(`   Actual DAOShip:   ${launchEvent.args.daoShip}`);
      console.log(`   Match: ${daoShip.address.toLowerCase() === launchEvent.args.daoShip.toLowerCase() ? "✅" : "❌"}\n`);

      console.log("============================================================");
      console.log("🎉 SUCCESS! Your DAO is Fully Operational");
      console.log("============================================================\n");

      console.log("✅ DAOShip was enabled as a vault module during vault creation.");
      console.log("   No additional enableModule proposal needed.\n");

      console.log("📋 Next Steps:");
      console.log("   - Submit proposals via DAOShip.submitProposal()");
      console.log("   - Vote with your shares");
      console.log("   - Execute passed proposals to control vault assets\n");

      console.log("🏛️  Your DAO:");
      console.log(`   Vault:   ${launchEvent.args.vault}`);
      console.log(`   DAOShip: ${launchEvent.args.daoShip}`);
      console.log(`   Shares:  ${launchEvent.args.shares}`);
      console.log(`   Loot:    ${launchEvent.args.loot}\n`);

      // Save deployment info
      const atomicDeployment = {
        network: deploymentData.network,
        chainId: deploymentData.chainId,
        timestamp: Date.now(),
        launcher: wallet.address,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        contracts: {
          vault: launchEvent.args.vault,
          daoShip: launchEvent.args.daoShip,
          shares: launchEvent.args.shares,
          loot: launchEvent.args.loot,
        },
        salts: {
          vault: vault.salt,
          shares: shares.salt,
          loot: loot.salt,
          daoShip: daoShip.salt,
        },
        vaultConfig: {
          owners: vaultOwners,
          threshold: vaultThreshold,
        },
      };

      const deploymentsDir = path.join(__dirname, "../deployments");
      if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir, { recursive: true });
      }

      fs.writeFileSync(
        path.join(deploymentsDir, `atomic-dao-vault-${Date.now()}.json`),
        JSON.stringify(atomicDeployment, null, 2)
      );

      console.log("📄 Deployment info saved to: deployments/atomic-dao-vault-*.json\n");
    } else {
      console.error("❌ LaunchDAOShipAndVault event not found in transaction logs");
    }
  } catch (error: any) {
    console.error("\n❌ Atomic deployment FAILED\n");
    console.error("Error:", error.message);

    if (error.data) {
      console.error("\nError data:", error.data);
    }

    if (error.code) {
      console.error("Error code:", error.code);
    }

    // Specific error handling
    if (error.message.includes("FailedDeployment")) {
      console.error("\n🔍 FailedDeployment Error - CREATE2 returned address(0)");
      console.error("\nPossible causes:");
      console.error("   1. Salt already used (contract exists at that address)");
      console.error("   2. Insufficient gas for nested CREATE2 operations");
      console.error("   3. Sender address mismatch in salt calculation");
      console.error("   4. Bytecode hash mismatch");
      console.error("\nTroubleshooting:");
      console.error("   - Try running with freshly mined salts");
      console.error("   - Verify sender addresses:");
      console.error(`     • Vault sender:   ${daoShipAndVaultLauncher}`);
      console.error(`     • DAOShip sender: ${daoShipLauncher}`);
      console.error("   - Increase gas limit beyond 20M if needed");
    } else if (error.message.includes("Access list creation failed")) {
      console.error("\n🔍 Access List Creation Failed");
      console.error("\nThis usually means the transaction would revert.");
      console.error("\nPossible causes:");
      console.error("   1. Invalid initialization parameters");
      console.error("   2. Contract not properly deployed");
      console.error("   3. Vault factory not accessible");
      console.error("   4. DAOShipLauncher reference incorrect");
      console.error("\nTroubleshooting:");
      console.error("   - Verify all contract addresses in .env");
      console.error("   - Check DAOShipAndVaultLauncher.daoShipLauncher() view function");
      console.error("   - Try the two-step approach: npm run create-dao-with-vault");
    } else if (error.message.includes("execution reverted")) {
      console.error("\n🔍 Transaction Reverted");
      console.error("\nTry getting more details:");
      console.error("   - Check contract is deployed at expected address");
      console.error("   - Verify initialization parameters are correct");
      console.error("   - Look for require() statement failures");
    } else if (error.message.includes("insufficient funds")) {
      console.error("\n🔍 Insufficient Funds");
      console.error(`\nYour balance: ${quais.formatQuai(await provider.getBalance(wallet.address))} QUAI`);
      console.error("Need QUAI for gas fees on Quai Network testnet");
    }

    console.error("\n💡 Alternative approach:");
    console.error("   Use two-step deployment: npm run create-dao-with-vault");
    console.error("   This bypasses DAOShipAndVaultLauncher and has proven reliability.\n");

    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n💥 Fatal error:", error);
    process.exit(1);
  });
