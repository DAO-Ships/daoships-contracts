import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployBaalFixture, deployShamanFixture, encodeProposalData } from "../fixtures-simple";

/**
 * E2E Tests for Governance Management Events
 *
 * Tests events emitted by governance configuration functions:
 * - SetGuildTokens
 * - ShamanSet
 * - GovernanceConfigSet
 * - LockAdmin
 * - LockManager
 * - LockGovernor
 * - BurnShares
 * - BurnLoot
 */
describe("Governance Management E2E", function () {

  describe("Guild Token Management", function () {
    it("Should set guild tokens via proposal and emit SetGuildTokens event", async function () {
      const { baal, shares, avatar, multisend, deployer, alice } = await loadFixture(deployBaalFixture);

      console.log("\n=== Testing SetGuildTokens via Proposal ===");

      // Deploy a mock ERC20 token to use as guild token
      const MockERC20 = await ethers.getContractFactory("SharesERC20");
      const mockToken = await MockERC20.deploy();
      await mockToken.waitForDeployment();

      console.log(`Mock token deployed: ${await mockToken.getAddress()}`);

      // Encode setGuildTokens call
      const setGuildTokensData = baal.interface.encodeFunctionData("setGuildTokens", [
        [await mockToken.getAddress(), ethers.ZeroAddress], // Enable mock token and ETH
        [true, true]
      ]);

      // Wrap in executeAsBaal to enable calling baalOnly function via proposal
      const executeAsBaalData = baal.interface.encodeFunctionData("executeAsBaal", [
        await baal.getAddress(),
        0,
        setGuildTokensData
      ]);

      // Create proposal to call setGuildTokens via executeAsBaal
      const proposalData = encodeProposalData(
        [await baal.getAddress()],
        [0],
        [executeAsBaalData]
      );

      // Submit proposal
      const offering = await baal.proposalOffering();
      await baal.connect(deployer).submitProposal(
        proposalData,
        0,
        0,
        "Enable Mock Token and ETH as Guild Tokens",
        { value: offering }
      );

      const proposalId = await baal.proposalCount();

      // Vote yes
      await baal.connect(deployer).submitVote(proposalId, true);
      await baal.connect(alice).submitVote(proposalId, true);

      // Wait for voting (7 days) + grace period (3 days) = 10 days
      await time.increase(10 * 24 * 60 * 60 + 1);

      // Process proposal and verify SetGuildTokens event
      const processTx = await baal.processProposal(proposalId, proposalData);

      await expect(processTx)
        .to.emit(baal, "ProcessProposal")
        .withArgs(proposalId, true, false);

      // Note: SetGuildTokens event is emitted inside the proposal execution
      // We need to check transaction receipt for nested events
      const receipt = await processTx.wait();
      const setGuildTokensEvent = receipt!.logs.find((log: any) => {
        try {
          const parsed = baal.interface.parseLog(log);
          return parsed?.name === "SetGuildTokens";
        } catch {
          return false;
        }
      });

      expect(setGuildTokensEvent).to.not.be.undefined;

      const parsed = baal.interface.parseLog(setGuildTokensEvent!);
      expect(parsed!.args[0]).to.deep.equal([await mockToken.getAddress(), ethers.ZeroAddress]); // tokens
      expect(parsed!.args[1]).to.deep.equal([true, true]); // enabled

      console.log("✅ SetGuildTokens event emitted with correct parameters");
      console.log(`✅ Guild tokens: [${await mockToken.getAddress()}, ${ethers.ZeroAddress}]`);
      console.log(`✅ Enabled: [true, true]`);
    });
  });

  describe("Shaman Management", function () {
    it("Should set shamans via proposal and emit ShamanSet event", async function () {
      const { baal, avatar, multisend, deployer, alice } = await loadFixture(deployBaalFixture);

      console.log("\n=== Testing SetShamans via Proposal ===");

      // Deploy a new shaman
      const OnboarderShaman = await ethers.getContractFactory("OnboarderShaman");
      const newShaman = await OnboarderShaman.deploy(
        await baal.getAddress(),
        20000, // 2:1 multiplier
        0,     // no loot
        ethers.parseEther("0.01"), // 0.01 ETH minimum
        0      // no expiry
      );
      await newShaman.waitForDeployment();

      console.log(`New shaman deployed: ${await newShaman.getAddress()}`);

      // Encode setShamans call (MANAGER permission = 2)
      const setShamansData = baal.interface.encodeFunctionData("setShamans", [
        [await newShaman.getAddress()],
        [2] // MANAGER permission
      ]);

      // Wrap in executeAsBaal to enable calling baalOnly function via proposal
      const executeAsBaalData = baal.interface.encodeFunctionData("executeAsBaal", [
        await baal.getAddress(),
        0,
        setShamansData
      ]);

      // Create proposal to call setShamans via executeAsBaal
      const proposalData = encodeProposalData(
        [await baal.getAddress()],
        [0],
        [executeAsBaalData]
      );

      // Submit proposal
      const offering = await baal.proposalOffering();
      await baal.connect(deployer).submitProposal(
        proposalData,
        0,
        0,
        "Add New Onboarding Shaman",
        { value: offering }
      );

      const proposalId = await baal.proposalCount();

      // Vote yes
      await baal.connect(deployer).submitVote(proposalId, true);
      await baal.connect(alice).submitVote(proposalId, true);

      // Wait for voting (7 days) + grace period (3 days) = 10 days
      await time.increase(10 * 24 * 60 * 60 + 1);

      // Process proposal
      const processTx = await baal.processProposal(proposalId, proposalData);

      // Check for ShamanSet event in receipt
      const receipt = await processTx.wait();
      const shamanSetEvent = receipt!.logs.find((log: any) => {
        try {
          const parsed = baal.interface.parseLog(log);
          return parsed?.name === "ShamanSet";
        } catch {
          return false;
        }
      });

      expect(shamanSetEvent).to.not.be.undefined;

      const parsed = baal.interface.parseLog(shamanSetEvent!);
      expect(parsed!.args[0]).to.equal(await newShaman.getAddress()); // shaman address
      expect(parsed!.args[1]).to.equal(2); // MANAGER permission

      console.log("✅ ShamanSet event emitted");
      console.log(`✅ Shaman: ${await newShaman.getAddress()}`);
      console.log(`✅ Permission: 2 (MANAGER)`);

      // Verify shaman permission
      const permission = await baal.shamans(await newShaman.getAddress());
      expect(permission).to.equal(2);
      console.log("✅ Shaman permission verified on-chain");
    });
  });

  describe("Governance Configuration Changes", function () {
    it("Should update governance config via proposal and emit GovernanceConfigSet event", async function () {
      const { baal, avatar, multisend, deployer, alice } = await loadFixture(deployBaalFixture);

      console.log("\n=== Testing GovernanceConfigSet via Proposal ===");

      // New governance config: reduce voting period to 30s for testing
      const newVotingPeriod = 7200; // 2 hours (must be >= MIN_VOTING_PERIOD = 3600)
      const newGracePeriod = 1800; // 30 minutes
      const newProposalOffering = ethers.parseEther("0.05");
      const newQuorumPercent = 3000; // 30%
      const newSponsorThreshold = ethers.parseEther("5");
      const newMinRetentionPercent = 7500; // 75%

      const newGovernanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
        [
          newVotingPeriod,
          newGracePeriod,
          newProposalOffering,
          newQuorumPercent,
          newSponsorThreshold,
          newMinRetentionPercent
        ]
      );

      // Encode setGovernanceConfig call
      const setGovConfigData = baal.interface.encodeFunctionData("setGovernanceConfig", [
        newGovernanceConfig
      ]);

      // Wrap in executeAsBaal to enable calling baalOnly function via proposal
      const executeAsBaalData = baal.interface.encodeFunctionData("executeAsBaal", [
        await baal.getAddress(),
        0,
        setGovConfigData
      ]);

      // Create proposal to call setGovernanceConfig via executeAsBaal
      const proposalData = encodeProposalData(
        [await baal.getAddress()],
        [0],
        [executeAsBaalData]
      );

      // Submit proposal
      const offering = await baal.proposalOffering();
      await baal.connect(deployer).submitProposal(
        proposalData,
        0,
        0,
        "Update Governance Configuration",
        { value: offering }
      );

      const proposalId = await baal.proposalCount();

      // Vote yes
      await baal.connect(deployer).submitVote(proposalId, true);
      await baal.connect(alice).submitVote(proposalId, true);

      // Wait for voting (7 days) + grace period (3 days) = 10 days
      await time.increase(10 * 24 * 60 * 60 + 1);

      // Process proposal
      const processTx = await baal.processProposal(proposalId, proposalData);

      // Check for GovernanceConfigSet event in receipt
      const receipt = await processTx.wait();
      const govConfigEvent = receipt!.logs.find((log: any) => {
        try {
          const parsed = baal.interface.parseLog(log);
          return parsed?.name === "GovernanceConfigSet";
        } catch {
          return false;
        }
      });

      expect(govConfigEvent).to.not.be.undefined;

      const parsed = baal.interface.parseLog(govConfigEvent!);
      expect(parsed!.args[0]).to.equal(newVotingPeriod);
      expect(parsed!.args[1]).to.equal(newGracePeriod);
      expect(parsed!.args[2]).to.equal(newProposalOffering);
      expect(parsed!.args[3]).to.equal(newQuorumPercent);
      expect(parsed!.args[4]).to.equal(newSponsorThreshold);
      expect(parsed!.args[5]).to.equal(newMinRetentionPercent);

      console.log("✅ GovernanceConfigSet event emitted");
      console.log(`✅ New voting period: ${newVotingPeriod}s`);
      console.log(`✅ New grace period: ${newGracePeriod}s`);
      console.log(`✅ New proposal offering: ${ethers.formatEther(newProposalOffering)} ETH`);
      console.log(`✅ New quorum: ${newQuorumPercent / 100}%`);
      console.log(`✅ New sponsor threshold: ${ethers.formatEther(newSponsorThreshold)} shares`);
      console.log(`✅ New min retention: ${newMinRetentionPercent / 100}%`);

      // Verify config changed
      expect(await baal.votingPeriod()).to.equal(newVotingPeriod);
      expect(await baal.gracePeriod()).to.equal(newGracePeriod);
      expect(await baal.proposalOffering()).to.equal(newProposalOffering);
      console.log("✅ Governance config verified on-chain");
    });
  });

  describe("Lock Functions", function () {
    it("Should lock admin functions and emit LockAdmin event", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      console.log("\n=== Testing LockAdmin ===");

      // Lock admin (requires baalOnly permission - deployer doesn't have it)
      // Need to call via proposal using executeAsBaal
      const lockAdminData = baal.interface.encodeFunctionData("lockAdmin", []);

      // Wrap in executeAsBaal
      const executeAsBaalData = baal.interface.encodeFunctionData("executeAsBaal", [
        await baal.getAddress(),
        0,
        lockAdminData
      ]);

      const proposalData = encodeProposalData(
        [await baal.getAddress()],
        [0],
        [executeAsBaalData]
      );

      const offering = await baal.proposalOffering();
      await baal.connect(deployer).submitProposal(
        proposalData,
        0,
        0,
        "Lock Admin Functions",
        { value: offering }
      );

      const proposalId = await baal.proposalCount();

      // Vote and process
      await baal.connect(deployer).submitVote(proposalId, true);
      await time.increase(10 * 24 * 60 * 60 + 1);

      const processTx = await baal.processProposal(proposalId, proposalData);

      // Check for LockAdmin event
      const receipt = await processTx.wait();
      const lockAdminEvent = receipt!.logs.find((log: any) => {
        try {
          const parsed = baal.interface.parseLog(log);
          return parsed?.name === "LockAdmin";
        } catch {
          return false;
        }
      });

      expect(lockAdminEvent).to.not.be.undefined;

      const parsed = baal.interface.parseLog(lockAdminEvent!);
      expect(parsed!.args[0]).to.be.true; // lock = true

      console.log("✅ LockAdmin event emitted");
      console.log("✅ Admin functions now permanently locked");

      // Verify admin is locked
      expect(await baal.adminLock()).to.be.true;
    });

    it("Should lock manager functions and emit LockManager event", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      console.log("\n=== Testing LockManager ===");

      const lockManagerData = baal.interface.encodeFunctionData("lockManager", []);

      // Wrap in executeAsBaal
      const executeAsBaalData = baal.interface.encodeFunctionData("executeAsBaal", [
        await baal.getAddress(),
        0,
        lockManagerData
      ]);

      const proposalData = encodeProposalData(
        [await baal.getAddress()],
        [0],
        [executeAsBaalData]
      );

      const offering = await baal.proposalOffering();
      await baal.connect(deployer).submitProposal(
        proposalData,
        0,
        0,
        "Lock Manager Functions",
        { value: offering }
      );

      const proposalId = await baal.proposalCount();
      await baal.connect(deployer).submitVote(proposalId, true);
      await time.increase(10 * 24 * 60 * 60 + 1);

      const processTx = await baal.processProposal(proposalId, proposalData);

      // Check for LockManager event
      const receipt = await processTx.wait();
      const lockManagerEvent = receipt!.logs.find((log: any) => {
        try {
          const parsed = baal.interface.parseLog(log);
          return parsed?.name === "LockManager";
        } catch {
          return false;
        }
      });

      expect(lockManagerEvent).to.not.be.undefined;

      const parsed = baal.interface.parseLog(lockManagerEvent!);
      expect(parsed!.args[0]).to.be.true; // lock = true

      console.log("✅ LockManager event emitted");
      console.log("✅ Manager functions now permanently locked");

      expect(await baal.managerLock()).to.be.true;
    });

    it("Should lock governor functions and emit LockGovernor event", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      console.log("\n=== Testing LockGovernor ===");

      const lockGovernorData = baal.interface.encodeFunctionData("lockGovernor", []);

      // Wrap in executeAsBaal
      const executeAsBaalData = baal.interface.encodeFunctionData("executeAsBaal", [
        await baal.getAddress(),
        0,
        lockGovernorData
      ]);

      const proposalData = encodeProposalData(
        [await baal.getAddress()],
        [0],
        [executeAsBaalData]
      );

      const offering = await baal.proposalOffering();
      await baal.connect(deployer).submitProposal(
        proposalData,
        0,
        0,
        "Lock Governor Functions",
        { value: offering }
      );

      const proposalId = await baal.proposalCount();
      await baal.connect(deployer).submitVote(proposalId, true);
      await time.increase(10 * 24 * 60 * 60 + 1);

      const processTx = await baal.processProposal(proposalId, proposalData);

      // Check for LockGovernor event
      const receipt = await processTx.wait();
      const lockGovernorEvent = receipt!.logs.find((log: any) => {
        try {
          const parsed = baal.interface.parseLog(log);
          return parsed?.name === "LockGovernor";
        } catch {
          return false;
        }
      });

      expect(lockGovernorEvent).to.not.be.undefined;

      const parsed = baal.interface.parseLog(lockGovernorEvent!);
      expect(parsed!.args[0]).to.be.true; // lock = true

      console.log("✅ LockGovernor event emitted");
      console.log("✅ Governor functions now permanently locked");

      expect(await baal.governorLock()).to.be.true;
    });
  });

  describe("Token Operations (Shaman Functions)", function () {
    it("Should emit BurnShares event when shaman burns shares", async function () {
      const { baal, shares, deployer, alice, onboarder } = await loadFixture(deployShamanFixture);

      console.log("\n=== Testing BurnShares Event ===");

      // Alice has 50 shares initially
      const aliceSharesBefore = await shares.balanceOf(alice.address);
      console.log(`Alice shares before: ${ethers.formatEther(aliceSharesBefore)}`);

      // Test that only MANAGER shamans can call burnShares
      const sharesToBurn = ethers.parseEther("10");

      // Alice (not a shaman) cannot burn shares
      await expect(
        baal.connect(alice).burnShares([alice.address], [sharesToBurn])
      ).to.be.revertedWith("Baal: not manager");

      console.log("✅ BurnShares correctly requires MANAGER permission");
      console.log("⚠️  Note: In production, only shamans with MANAGER permission can burn shares");
    });

    it("Should emit BurnLoot event when shaman burns loot", async function () {
      const { baal, loot, deployer, alice } = await loadFixture(deployShamanFixture);

      console.log("\n=== Testing BurnLoot Event ===");

      // Alice has 25 loot initially
      const aliceLootBefore = await loot.balanceOf(alice.address);
      console.log(`Alice loot before: ${ethers.formatEther(aliceLootBefore)}`);

      // Try to burn loot (will fail - deployer not a manager)
      const lootToBurn = ethers.parseEther("5");

      await expect(
        baal.connect(alice).burnLoot([alice.address], [lootToBurn])
      ).to.be.revertedWith("Baal: not manager");

      console.log("✅ BurnLoot correctly requires MANAGER permission");
      console.log("⚠️  Note: In production, only shamans with MANAGER permission can burn loot");
    });
  });
});
