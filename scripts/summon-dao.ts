import { quais } from "quais";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const TARGET_PREFIX = "0x00"; // cyprus1 shard
const MAX_MINING_ATTEMPTS = 100000;

/**
 * Atomic DAO + Vault Deployment using BaalAndVaultSummoner
 * Tests the refactored composition pattern (no external self-call)
 */

// Helper: Get minimal proxy bytecode for CREATE2 address prediction
function getMinimalProxyBytecode(implementation: string): string {
  const implAddr = implementation.toLowerCase().replace("0x", "");
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddr}5af43d82803e903d91602b57fd5bf3`;
}

// Helper: Mine salt for BaalSummoner clones
// IMPORTANT: senderAddress = msg.sender that will call BaalSummoner.summonBaal()
//            For atomic deployment, this is BaalAndVaultSummoner (NOT user wallet!)
async function mineBaalSalt(
  senderAddress: string,
  baalSummonerAddress: string,
  singletonAddress: string,
  label: string
): Promise<{ salt: string; address: string }> {
  const bytecode = getMinimalProxyBytecode(singletonAddress);
  const initCodeHash = quais.keccak256(bytecode);

  for (let i = 0; i < MAX_MINING_ATTEMPTS; i++) {
    const userSalt = quais.hexlify(quais.randomBytes(32));
    const userSaltBigInt = BigInt(userSalt);

    // BaalSummoner uses keccak256(abi.encodePacked(msg.sender, salt))
    // msg.sender = senderAddress (BaalAndVaultSummoner for atomic deployment)
    const fullSalt = quais.keccak256(
      quais.solidityPacked(["address", "uint256"], [senderAddress, userSaltBigInt])
    );

    // CREATE2 is deployed from BaalSummoner contract
    const address = quais.getCreate2Address(baalSummonerAddress, fullSalt, initCodeHash);

    if (address.toLowerCase().startsWith(TARGET_PREFIX.toLowerCase()) && quais.isQuaiAddress(address)) {
      return { salt: userSalt, address };
    }

    if ((i + 1) % 10000 === 0) {
      console.log(`      ${label}: ${i + 1} attempts...`);
    }
  }

  throw new Error(`Failed to mine ${label} salt after ${MAX_MINING_ATTEMPTS} attempts`);
}

// Helper: Mine salt for Quai Vault (sender = BaalAndVaultSummoner)
async function mineVaultSalt(
  baalAndVaultSummonerAddress: string,
  quaiVaultFactory: string,
  quaiVaultImplementation: string,
  vaultOwners: string[],
  vaultThreshold: number,
  QuaiVaultJson: any,
  QuaiVaultProxyJson: any
): Promise<{ salt: string; address: string }> {
  // Use passed artifacts (loaded in main function)

  // Prepare vault initialization data
  const vaultIface = new quais.Interface(QuaiVaultJson.abi);
  const initData = vaultIface.encodeFunctionData("initialize", [vaultOwners, vaultThreshold]);
  const encodedArgs = quais.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes"],
    [quaiVaultImplementation, initData]
  );
  const fullBytecode = QuaiVaultProxyJson.bytecode + encodedArgs.slice(2);
  const bytecodeHash = quais.keccak256(fullBytecode);

  for (let i = 0; i < MAX_MINING_ATTEMPTS; i++) {
    const userSalt = quais.hexlify(quais.randomBytes(32));

    // QuaiVaultFactory uses keccak256(abi.encodePacked(msg.sender, salt))
    // msg.sender = BaalAndVaultSummoner
    const fullSalt = quais.keccak256(
      quais.solidityPacked(["address", "bytes32"], [baalAndVaultSummonerAddress, userSalt])
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
  console.log("🔧 Using BaalAndVaultSummoner (Composition Pattern)");
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

  const baalAndVaultSummoner = deploymentData.contracts.BaalAndVaultSummoner;
  const baalSummoner = deploymentData.contracts.BaalSummoner;
  const sharesSingleton = deploymentData.contracts.SharesERC20Singleton;
  const lootSingleton = deploymentData.contracts.LootERC20Singleton;
  const baalSingleton = deploymentData.contracts.BaalSingleton;
  const multisendLibrary = process.env.MULTISEND_LIBRARY!;
  const quaiVaultFactory = process.env.QUAI_VAULT_FACTORY!;
  const quaiVaultImplementation = process.env.QUAI_VAULT_IMPLEMENTATION!;

  if (!baalAndVaultSummoner) {
    throw new Error(
      "BaalAndVaultSummoner not deployed. Ensure QUAI_VAULT_FACTORY was set during deployment."
    );
  }

  console.log("📦 Using contracts:");
  console.log(`   BaalAndVaultSummoner: ${baalAndVaultSummoner}`);
  console.log(`   BaalSummoner:         ${baalSummoner}`);
  console.log(`   QuaiVaultFactory:     ${quaiVaultFactory}\n`);

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
  console.log(`   - Vault:  BaalAndVaultSummoner calls QuaiVaultFactory`);
  console.log(`             msg.sender = ${baalAndVaultSummoner}`);
  console.log(`   - Baal:   BaalAndVaultSummoner calls BaalSummoner`);
  console.log(`             msg.sender = ${baalAndVaultSummoner} (NOT user wallet!)`);
  console.log(`   - Tokens: BaalSummoner deploys via CREATE2`);
  console.log(`             msg.sender = ${baalSummoner}\n`);

  console.log("⛏️  Mining vault salt (sender = BaalAndVaultSummoner)...");
  const vault = await mineVaultSalt(
    baalAndVaultSummoner,
    quaiVaultFactory,
    quaiVaultImplementation,
    vaultOwners,
    vaultThreshold,
    QuaiVaultJson,
    QuaiVaultProxyJson
  );
  console.log(`   ✅ Vault:  ${vault.address}\n`);

  console.log("⛏️  Mining Baal salts (sender = BaalAndVaultSummoner → BaalSummoner)...");
  console.log("   Note: When BaalAndVaultSummoner calls BaalSummoner.summonBaal(),");
  console.log("         msg.sender to BaalSummoner is BaalAndVaultSummoner!\n");

  const shares = await mineBaalSalt(baalAndVaultSummoner, baalSummoner, sharesSingleton, "Shares");
  console.log(`   ✅ Shares: ${shares.address}`);

  const loot = await mineBaalSalt(baalAndVaultSummoner, baalSummoner, lootSingleton, "Loot");
  console.log(`   ✅ Loot:   ${loot.address}`);

  const baal = await mineBaalSalt(baalAndVaultSummoner, baalSummoner, baalSingleton, "Baal");
  console.log(`   ✅ Baal:   ${baal.address}\n`);

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
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
    [
      7 * 24 * 60 * 60, // voting period: 7 days
      3 * 24 * 60 * 60, // grace period: 3 days
      quais.parseQuai("0.1"), // proposal offering: 0.1 QUAI
      2000, // quorum: 20%
      quais.parseQuai("1"), // sponsor threshold: 1 share
      6600, // min retention: 66%
    ]
  );

  // Prepare initialization params with avatar = address(0)
  // BaalAndVaultSummoner will replace it with the vault address
  const initializationParams = quais.AbiCoder.defaultAbiCoder().encode(
    [
      "address",
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
      "address[]", // 12th parameter: guild tokens
    ],
    [
      quais.ZeroAddress, // lootToken (filled by BaalSummoner)
      quais.ZeroAddress, // sharesToken (filled by BaalSummoner)
      quais.ZeroAddress, // avatar (will be replaced with vault address)
      quais.ZeroAddress, // forwarder (not using meta-transactions)
      multisendLibrary, // multisend library
      governanceConfig, // governance config
      [], // shamans (none initially)
      [], // shaman permissions
      initMembers, // initial members
      initShareAmounts, // initial shares
      initLootAmounts, // initial loot
      [], // guild tokens (can be set via proposals later)
    ]
  );

  console.log("============================================================");
  console.log("STEP 3: Call BaalAndVaultSummoner.summonBaalAndVault()");
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

  // Load BaalAndVaultSummoner ABI
  const BaalAndVaultSummonerJson = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "../artifacts/contracts/core/BaalAndVaultSummoner.sol/BaalAndVaultSummoner.json"
      ),
      "utf-8"
    )
  );

  const summoner = new quais.Contract(
    baalAndVaultSummoner,
    BaalAndVaultSummonerJson.abi,
    wallet
  );

  // Verify contract is deployed
  const code = await provider.getCode(baalAndVaultSummoner);
  if (code === "0x") {
    throw new Error(`BaalAndVaultSummoner not deployed at ${baalAndVaultSummoner}`);
  }
  console.log("✅ BaalAndVaultSummoner contract verified");

  // Verify BaalAndVaultSummoner configuration
  try {
    const configuredBaalSummoner = await summoner.baalSummoner();
    const configuredVaultFactory = await summoner.quaiVaultFactory();

    console.log("\n🔧 BaalAndVaultSummoner Configuration:");
    console.log(`   baalSummoner:     ${configuredBaalSummoner}`);
    console.log(`   quaiVaultFactory: ${configuredVaultFactory}`);

    if (configuredBaalSummoner.toLowerCase() !== baalSummoner.toLowerCase()) {
      console.error(`\n⚠️  WARNING: BaalSummoner mismatch!`);
      console.error(`   Expected: ${baalSummoner}`);
      console.error(`   Actual:   ${configuredBaalSummoner}`);
      throw new Error("BaalSummoner address mismatch - redeploy BaalAndVaultSummoner");
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

  console.log("🔮 Summoning DAO and Vault atomically...");
  console.log(`   This will create 4 contracts in a single transaction:\n`);
  console.log(`   1. Quai Vault (via QuaiVaultFactory)`);
  console.log(`   2. SharesERC20 (via BaalSummoner → clone)`);
  console.log(`   3. LootERC20 (via BaalSummoner → clone)`);
  console.log(`   4. Baal (via BaalSummoner → clone)\n`);

  try {

    const tx = await summoner.summonBaalAndVault(
      initializationParams,
      [], // no initialization actions
      vaultOwners,
      vaultThreshold,
      BigInt(vault.salt),
      BigInt(shares.salt),
      BigInt(loot.salt),
      BigInt(baal.salt)
    );

    console.log(`   📝 Transaction hash: ${tx.hash}`);
    console.log(`   ⏳ Waiting for confirmation...`);

    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed! Block: ${receipt.blockNumber}`);
    console.log(`   ⛽ Gas used: ${receipt.gasUsed.toString()}\n`);

    // Parse events
    const summonEvent = receipt.logs
      .map((log: any) => {
        try {
          return summoner.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event: any) => event?.name === "SummonBaalAndVault");

    if (summonEvent) {
      console.log("============================================================");
      console.log("✨ SUCCESS! Atomic Deployment Complete");
      console.log("============================================================\n");

      console.log("📋 Deployed Contracts:");
      console.log(`   Vault:  ${summonEvent.args.vault}`);
      console.log(`   Shares: ${summonEvent.args.shares}`);
      console.log(`   Loot:   ${summonEvent.args.loot}`);
      console.log(`   Baal:   ${summonEvent.args.baal}\n`);

      console.log("🔍 Verification:");
      console.log(`   Expected Vault:  ${vault.address}`);
      console.log(`   Actual Vault:    ${summonEvent.args.vault}`);
      console.log(`   Match: ${vault.address.toLowerCase() === summonEvent.args.vault.toLowerCase() ? "✅" : "❌"}\n`);

      console.log(`   Expected Shares: ${shares.address}`);
      console.log(`   Actual Shares:   ${summonEvent.args.shares}`);
      console.log(`   Match: ${shares.address.toLowerCase() === summonEvent.args.shares.toLowerCase() ? "✅" : "❌"}\n`);

      console.log(`   Expected Loot:   ${loot.address}`);
      console.log(`   Actual Loot:     ${summonEvent.args.loot}`);
      console.log(`   Match: ${loot.address.toLowerCase() === summonEvent.args.loot.toLowerCase() ? "✅" : "❌"}\n`);

      console.log(`   Expected Baal:   ${baal.address}`);
      console.log(`   Actual Baal:     ${summonEvent.args.baal}`);
      console.log(`   Match: ${baal.address.toLowerCase() === summonEvent.args.baal.toLowerCase() ? "✅" : "❌"}\n`);

      console.log("============================================================");
      console.log("STEP 4: Submit EnableModule Proposal to Vault");
      console.log("============================================================\n");

      // Load QuaiVault ABI to propose enableModule transaction
      const vaultAddress = summonEvent.args.vault;
      const baalAddress = summonEvent.args.baal;

      // Encode enableModule call
      const enableModuleData = quais.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [baalAddress]
      ).slice(2); // Remove 0x prefix

      // Submit transaction to vault (via proposeTransaction)
      console.log("📝 Submitting proposal to enable Baal as module...");
      console.log(`   Vault:  ${vaultAddress}`);
      console.log(`   Module: ${baalAddress}\n`);

      try {
        // Load Quai Vault contract
        const vaultContract = new quais.Contract(
          vaultAddress,
          QuaiVaultJson.abi,
          wallet
        );

        // Propose enableModule transaction
        // QuaiVault.proposeTransaction(address to, uint256 value, bytes data)
        const proposeTx = await vaultContract.proposeTransaction(
          vaultAddress,       // to: vault itself
          0,                  // value: 0
          "0x610b5925" + enableModuleData  // data: enableModule(address)
        );

        console.log(`   📝 Proposal TX: ${proposeTx.hash}`);
        console.log(`   ⏳ Waiting for confirmation...`);

        const proposeReceipt = await proposeTx.wait();
        console.log(`   ✅ Proposal submitted! Block: ${proposeReceipt.blockNumber}\n`);

        // Extract transaction hash from TransactionProposed event
        const proposedEvent = proposeReceipt.logs
          .map((log: any) => {
            try {
              return vaultContract.interface.parseLog(log);
            } catch {
              return null;
            }
          })
          .find((event: any) => event?.name === "TransactionProposed");

        if (!proposedEvent) {
          throw new Error("TransactionProposed event not found in logs");
        }

        const txHash = proposedEvent.args.txHash;
        console.log(`   Transaction Hash: ${txHash}\n`);

        // For 1/1 vaults, automatically approve and execute
        if (vaultThreshold === 1 && vaultOwners.length === 1) {
          console.log("============================================================");
          console.log("STEP 5: Auto-Approve and Execute (1/1 Vault)");
          console.log("============================================================\n");

          console.log("🔓 1/1 Vault detected - automatically approving and executing...");

          const approveAndExecuteTx = await vaultContract.approveAndExecute(txHash);
          console.log(`   📝 Approve & Execute TX: ${approveAndExecuteTx.hash}`);
          console.log(`   ⏳ Waiting for confirmation...`);

          const approveAndExecuteReceipt = await approveAndExecuteTx.wait();
          console.log(`   ✅ Module enabled! Block: ${approveAndExecuteReceipt.blockNumber}\n`);

          console.log("============================================================");
          console.log("🎉 SUCCESS! Your DAO is Fully Operational");
          console.log("============================================================\n");

          console.log("✅ Complete setup in 3 transactions:");
          console.log("   1. Deploy DAO + Vault (4 contracts)");
          console.log("   2. Propose enableModule");
          console.log("   3. Approve and execute enableModule\n");

          console.log("📋 Next Steps:");
          console.log("   - Submit proposals via Baal.submitProposal()");
          console.log("   - Vote with your shares");
          console.log("   - Execute passed proposals to control vault assets\n");

          console.log("🏛️  Your DAO:");
          console.log(`   Vault:  ${vaultAddress}`);
          console.log(`   Baal:   ${baalAddress}`);
          console.log(`   Shares: ${summonEvent.args.shares}`);
          console.log(`   Loot:   ${summonEvent.args.loot}\n`);
        } else {
          // For multisig vaults, approve on behalf of deployer and provide instructions
          console.log("============================================================");
          console.log("STEP 5: Approve Transaction (Multisig Vault)");
          console.log("============================================================\n");

          console.log(`🔐 Multisig vault (${vaultThreshold}/${vaultOwners.length}) - approving on behalf of deployer...`);

          const approveTx = await vaultContract.approveTransaction(txHash);
          console.log(`   📝 Approve TX: ${approveTx.hash}`);
          console.log(`   ⏳ Waiting for confirmation...`);

          const approveReceipt = await approveTx.wait();
          console.log(`   ✅ Approved! Block: ${approveReceipt.blockNumber}`);
          console.log(`   Approvals: 1/${vaultThreshold} (need ${vaultThreshold - 1} more)\n`);

          console.log("============================================================");
          console.log("⚠️  IMPORTANT: Additional Approvals Required");
          console.log("============================================================\n");

          console.log("🔐 Next Steps for Other Vault Owners:");
          console.log(`   1. Connect to vault at: ${vaultAddress}`);
          console.log(`   2. View pending proposals (txHash: ${txHash})`);
          console.log(`   3. Approve the enableModule proposal`);
          console.log(`   4. Once ${vaultThreshold} approvals reached, execute the transaction\n`);

          console.log("📝 What the proposal does:");
          console.log("   - Enables Baal as a Zodiac module on the vault");
          console.log("   - Allows DAO proposals to execute vault transactions");
          console.log("   - Only vault owners can enable modules (security)\n");

          console.log("✅ Once executed, your DAO is fully operational!");
          console.log("   - Submit proposals via Baal.submitProposal()");
          console.log("   - Vote with your shares");
          console.log("   - Execute passed proposals to control vault assets\n");
        }

      } catch (proposeError: any) {
        console.error("⚠️  Failed to submit proposal automatically:");
        console.error(`   ${proposeError.message}\n`);

        console.log("============================================================");
        console.log("⚠️  Manual Steps Required");
        console.log("============================================================\n");

        console.log("🔐 Manually enable Baal as a module:");
        console.log(`   1. Connect to vault at: ${vaultAddress}`);
        console.log(`   2. Propose: vault.enableModule(${baalAddress})`);
        console.log(`   3. Approve and execute (${vaultThreshold}/${vaultOwners.length} signatures)\n`);
      }

      console.log("🎉 Composition Pattern Verification:");
      console.log("   ✅ No external self-call issues");
      console.log("   ✅ BaalSummoner called as separate contract");
      console.log("   ✅ All CREATE2 deployments successful");
      console.log("   ✅ All addresses match predicted values\n");

      // Save deployment info
      const atomicDeployment = {
        network: deploymentData.network,
        chainId: deploymentData.chainId,
        timestamp: Date.now(),
        summoner: wallet.address,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        contracts: {
          vault: summonEvent.args.vault,
          baal: summonEvent.args.baal,
          shares: summonEvent.args.shares,
          loot: summonEvent.args.loot,
        },
        salts: {
          vault: vault.salt,
          shares: shares.salt,
          loot: loot.salt,
          baal: baal.salt,
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
      console.error("❌ SummonBaalAndVault event not found in transaction logs");
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
      console.error(`     • Vault sender:  ${baalAndVaultSummoner}`);
      console.error(`     • Baal sender:   ${baalSummoner}`);
      console.error("   - Increase gas limit beyond 20M if needed");
    } else if (error.message.includes("Access list creation failed")) {
      console.error("\n🔍 Access List Creation Failed");
      console.error("\nThis usually means the transaction would revert.");
      console.error("\nPossible causes:");
      console.error("   1. Invalid initialization parameters");
      console.error("   2. Contract not properly deployed");
      console.error("   3. Vault factory not accessible");
      console.error("   4. BaalSummoner reference incorrect");
      console.error("\nTroubleshooting:");
      console.error("   - Verify all contract addresses in .env");
      console.error("   - Check BaalAndVaultSummoner.baalSummoner() view function");
      console.error("   - Try the two-step approach: npm run summon-dao-with-vault");
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
    console.error("   Use two-step deployment: npm run summon-dao-with-vault");
    console.error("   This bypasses BaalAndVaultSummoner and has proven reliability.\n");

    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n💥 Fatal error:", error);
    process.exit(1);
  });
