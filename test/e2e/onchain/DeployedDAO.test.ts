import { expect } from "chai";
import * as quais from "quais";
import { Shard } from "quais";
import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * End-to-End Tests for Deployed DAO
 *
 * Tests the actual deployed contracts on Cyprus1 testnet using quais.js
 * Reads addresses from deployment-addresses.json
 *
 * Run with: npm run test:e2e
 *
 * Reference: quaivault-indexer/tests/e2e/helpers/contracts.ts
 */

describe("E2E: Deployed DAO", function () {
  // Increase timeout for network operations
  this.timeout(120000);

  let provider: quais.JsonRpcProvider;
  let deployer: quais.Wallet;
  let deploymentAddresses: any;

  // Load ABIs
  const artifactsDir = path.join(__dirname, "../../../artifacts/contracts");
  let PosterABI: any;
  let DAOShipLauncherABI: any;
  let DAOShipAndVaultLauncherABI: any;

  before(async function () {
    // Load ABIs from artifacts
    PosterABI = JSON.parse(
      fs.readFileSync(path.join(artifactsDir, "tools/Poster.sol/Poster.json"), "utf-8")
    ).abi;

    DAOShipLauncherABI = JSON.parse(
      fs.readFileSync(path.join(artifactsDir, "core/DAOShipLauncher.sol/DAOShipLauncher.json"), "utf-8")
    ).abi;

    DAOShipAndVaultLauncherABI = JSON.parse(
      fs.readFileSync(
        path.join(artifactsDir, "core/DAOShipAndVaultLauncher.sol/DAOShipAndVaultLauncher.json"),
        "utf-8"
      )
    ).abi;

    // Setup quais.js provider - CRITICAL: use usePathing: true for Quai Network
    const rpcUrl = process.env.RPC_URL || "https://rpc.orchard.quai.network";
    console.log(`\n  Connecting to RPC: ${rpcUrl}`);

    provider = new quais.JsonRpcProvider(rpcUrl, undefined, { usePathing: true });

    // Create wallet from private key
    const privateKey = process.env.CYPRUS1_PK;
    if (!privateKey) {
      console.log("  ⚠️  No CYPRUS1_PK found in .env, skipping E2E tests");
      this.skip();
      return;
    }

    deployer = new quais.Wallet(privateKey.trim(), provider);
    console.log(`  Testing with account: ${deployer.address}`);

    // Warm up the provider - CRITICAL for Quai Network to avoid createAccessList failures
    console.log("  Warming up provider...");
    try {
      const blockNumber = await provider.getBlockNumber(Shard.Cyprus1);
      console.log(`  Provider ready, current block: ${blockNumber}`);
    } catch (error) {
      console.log(`  ⚠️  Provider warmup failed: ${(error as Error).message}`);
      console.log("  Check that RPC_URL is correct and the RPC endpoint is accessible");
      this.skip();
      return;
    }

    // Load deployment addresses
    const deploymentPath = path.join(__dirname, "../../../deployment-addresses.json");

    if (!fs.existsSync(deploymentPath)) {
      console.log("  ⚠️  No deployment-addresses.json found");
      console.log("  Run 'npm run deploy:all' first to deploy contracts");
      this.skip();
      return;
    }

    deploymentAddresses = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
    console.log(`  Network: ${deploymentAddresses.network}`);
    console.log(`  Chain ID: ${deploymentAddresses.chainId}\n`);
  });

  describe("Deployment Verification", function () {
    it("Should verify all contracts have bytecode", async function () {
      const contracts = deploymentAddresses.contracts;

      for (const [name, address] of Object.entries(contracts)) {
        // Warm up provider before each call
        await provider.getBlockNumber(Shard.Cyprus1);

        const code = await provider.getCode(address as string, "latest");
        expect(code).to.not.equal("0x", `${name} has no bytecode`);
        expect(code.length).to.be.greaterThan(2, `${name} bytecode too short`);

        console.log(`    ✓ ${name}: ${address}`);
      }
    });

    it("Should verify DAOShipLauncher singleton references", async function () {
      const address = deploymentAddresses.contracts.DAOShipLauncher;
      const daoShipLauncher = new quais.Contract(address, DAOShipLauncherABI, deployer);

      // Warm up provider
      await provider.getBlockNumber(Shard.Cyprus1);

      const daoShipTemplate = await daoShipLauncher.daoShipSingleton();
      const sharesTemplate = await daoShipLauncher.sharesSingleton();
      const lootTemplate = await daoShipLauncher.lootSingleton();

      expect(daoShipTemplate.toLowerCase()).to.equal(
        deploymentAddresses.contracts.DAOShipSingleton.toLowerCase()
      );
      expect(sharesTemplate.toLowerCase()).to.equal(
        deploymentAddresses.contracts.SharesERC20Singleton.toLowerCase()
      );
      expect(lootTemplate.toLowerCase()).to.equal(
        deploymentAddresses.contracts.LootERC20Singleton.toLowerCase()
      );

      console.log(`    ✓ DAOShipLauncher templates correctly configured`);
    });

    it("Should verify DAOShipAndVaultLauncher references", async function () {
      const address = deploymentAddresses.contracts.DAOShipAndVaultLauncher;
      const launcher = new quais.Contract(address, DAOShipAndVaultLauncherABI, deployer);

      // Warm up provider
      await provider.getBlockNumber(Shard.Cyprus1);

      const daoShipLauncherRef = await launcher.daoShipLauncher();
      const quaiVaultFactory = await launcher.quaiVaultFactory();

      expect(daoShipLauncherRef.toLowerCase()).to.equal(
        deploymentAddresses.contracts.DAOShipLauncher.toLowerCase()
      );
      expect(quaiVaultFactory).to.match(/^0x[0-9a-fA-F]{40}$/);

      console.log(`    ✓ DAOShipAndVaultLauncher:`);
      console.log(`      - DAOShipLauncher: ${daoShipLauncherRef}`);
      console.log(`      - QuaiVaultFactory: ${quaiVaultFactory}`);
    });
  });

  describe("Summoned DAO Verification", function () {
    let summonedDAOs: any[] = [];

    before(async function () {
      // Load summoned DAOs from deployments directory
      const deploymentsDir = path.join(__dirname, "../../../deployments");

      if (!fs.existsSync(deploymentsDir)) {
        console.log("    ℹ️  No deployments directory found");
        this.skip();
        return;
      }

      const files = fs.readdirSync(deploymentsDir);
      const atomicFiles = files.filter(
        (f) => f.startsWith("atomic-dao-vault-") && f.endsWith(".json")
      );

      for (const file of atomicFiles) {
        const filePath = path.join(deploymentsDir, file);
        const deployment = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        summonedDAOs.push(deployment);
      }

      if (summonedDAOs.length === 0) {
        console.log("    ℹ️  No summoned DAOs found");
        console.log("    Run 'npm run summon-dao' to create a test DAO");
        this.skip();
      } else {
        console.log(`    Found ${summonedDAOs.length} summoned DAO(s)\n`);
      }
    });

    it("Should verify summoned DAO contracts exist", async function () {
      for (const dao of summonedDAOs) {
        console.log(`    Verifying DAO summoned at ${new Date(dao.timestamp).toISOString()}`);

        // Warm up provider
        await provider.getBlockNumber(Shard.Cyprus1);

        // Check all contracts have bytecode
        const contracts = [
          { name: "DAOShip", address: dao.contracts.daoShip },
          { name: "Shares", address: dao.contracts.shares },
          { name: "Loot", address: dao.contracts.loot },
          { name: "Vault", address: dao.contracts.vault },
        ];

        for (const { name, address } of contracts) {
          const code = await provider.getCode(address, "latest");
          expect(code).to.not.equal("0x", `${name} has no bytecode`);
          console.log(`      ✓ ${name}: ${address}`);
        }
      }
    });
  });

  describe("Poster Functionality", function () {
    it("Should be able to post metadata", async function () {
      const posterAddress = deploymentAddresses.contracts.Poster;
      const poster = new quais.Contract(posterAddress, PosterABI, deployer);

      const testContent = `E2E Test Post - ${Date.now()}`;
      const testTag = "test-e2e";

      console.log(`    Posting: "${testContent.substring(0, 30)}..."`);

      // Warm up provider before transaction
      await provider.getBlockNumber(Shard.Cyprus1);

      // Use getFunction to disambiguate overloaded post function
      const tx = await poster.getFunction("post(string,string)")(testContent, testTag);
      const receipt = await tx.wait();

      expect(receipt.status).to.equal(1, "Transaction failed");

      console.log(`    ✓ Posted successfully`);
      console.log(`      TX: ${receipt.hash}`);
    });
  });

  describe("DAOShipLauncher Calculate Addresses", function () {
    it("Should calculate deterministic addresses", async function () {
      const launcherAddress = deploymentAddresses.contracts.DAOShipLauncher;
      const launcher = new quais.Contract(launcherAddress, DAOShipLauncherABI, deployer);

      const sender = deployer.address;
      const sharesSalt = quais.solidityPackedKeccak256(["string"], ["TEST_SHARES_E2E"]);
      const lootSalt = quais.solidityPackedKeccak256(["string"], ["TEST_LOOT_E2E"]);
      const baalSalt = quais.solidityPackedKeccak256(["string"], ["TEST_BAAL_E2E"]);

      // Warm up provider
      await provider.getBlockNumber(Shard.Cyprus1);

      const [daoShip, shares, loot] = await launcher.calculateAddresses(
        sender,
        sharesSalt,
        lootSalt,
        baalSalt
      );

      expect(daoShip).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(shares).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(loot).to.match(/^0x[0-9a-fA-F]{40}$/);

      // All should be different
      expect(daoShip).to.not.equal(shares);
      expect(daoShip).to.not.equal(loot);
      expect(shares).to.not.equal(loot);

      console.log(`    Calculated addresses for sender ${sender.substring(0, 10)}...`);
      console.log(`      - DAOShip: ${daoShip}`);
      console.log(`      - Shares: ${shares}`);
      console.log(`      - Loot: ${loot}`);
    });

    it("Should calculate same addresses for same inputs", async function () {
      const launcherAddress = deploymentAddresses.contracts.DAOShipLauncher;
      const launcher = new quais.Contract(launcherAddress, DAOShipLauncherABI, deployer);

      const sender = deployer.address;
      const sharesSalt = quais.solidityPackedKeccak256(["string"], ["DETERMINISTIC"]);
      const lootSalt = quais.solidityPackedKeccak256(["string"], ["DETERMINISTIC"]);
      const baalSalt = quais.solidityPackedKeccak256(["string"], ["DETERMINISTIC"]);

      // Warm up provider
      await provider.getBlockNumber(Shard.Cyprus1);

      const [baal1, shares1, loot1] = await launcher.calculateAddresses(
        sender,
        sharesSalt,
        lootSalt,
        baalSalt
      );

      const [baal2, shares2, loot2] = await launcher.calculateAddresses(
        sender,
        sharesSalt,
        lootSalt,
        baalSalt
      );

      expect(baal1).to.equal(baal2);
      expect(shares1).to.equal(shares2);
      expect(loot1).to.equal(loot2);

      console.log(`    ✓ Deterministic addresses verified`);
    });
  });

  describe("Network Status", function () {
    it("Should get current block number", async function () {
      // Warm up provider
      const blockNumber = await provider.getBlockNumber(Shard.Cyprus1);

      expect(blockNumber).to.be.greaterThan(0);

      console.log(`    Current block: ${blockNumber}`);
    });

    it("Should get deployer balance", async function () {
      // Warm up provider
      await provider.getBlockNumber(Shard.Cyprus1);

      const balance = await provider.getBalance(deployer.address, "latest");

      console.log(`    Deployer account:`);
      console.log(`      - Address: ${deployer.address}`);
      console.log(`      - Balance: ${quais.formatQuai(balance)} QUAI`);

      // Warn if balance is low
      if (balance < quais.parseQuai("0.1")) {
        console.log(`      ⚠️  Low balance! Consider funding for future operations`);
      }
    });
  });
});
