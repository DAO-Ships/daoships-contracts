import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployShamanFixture, encodeProposalData } from "../fixtures-simple";

/**
 * E2E Tests for Shaman-Specific Events
 *
 * Tests events that are emitted by shaman contracts:
 * - MintLoot (when shamans mint loot tokens)
 * - CheckIn (when members claim periodic check-in rewards)
 *
 * These tests achieve 100% event coverage for the DAO system.
 */
describe("Shaman Events E2E", function () {

  describe("MintLoot Event", function () {
    it("Should emit MintLoot event when shaman mints loot to member", async function () {
      const { baal, loot, onboarder, bob } = await loadFixture(deployShamanFixture);

      console.log("\n=== Testing MintLoot Event ===");

      // Deploy a loot-only onboarder shaman
      const LootOnboarder = await ethers.getContractFactory("OnboarderShaman");
      const lootOnboarder = await LootOnboarder.deploy(
        await baal.getAddress(),
        0,              // 0 shares multiplier (no shares)
        10000,          // 1:1 loot multiplier (1 ETH = 1 loot)
        ethers.parseEther("0.01"), // 0.01 ETH minimum
        0               // no expiry
      );
      await lootOnboarder.waitForDeployment();

      // Add loot-only shaman with MANAGER permission via proposal
      const setShamansData = baal.interface.encodeFunctionData("setShamans", [
        [await lootOnboarder.getAddress()],
        [2] // MANAGER permission
      ]);

      const executeAsBaalData = baal.interface.encodeFunctionData("executeAsBaal", [
        await baal.getAddress(),
        0,
        setShamansData
      ]);

      // Create proposal using helper
      const proposalData = encodeProposalData(
        [await baal.getAddress()],
        [0],
        [executeAsBaalData]
      );

      // Submit and process proposal
      const offering = await baal.proposalOffering();
      await baal.submitProposal(proposalData, 0, 0, "Add Loot Onboarder", { value: offering });

      const proposalId = await baal.proposalCount();
      await baal.submitVote(proposalId, true);
      await time.increase(10 * 24 * 60 * 60 + 1); // 10 days
      await baal.processProposal(proposalId, proposalData);

      console.log(`Loot-only shaman deployed: ${await lootOnboarder.getAddress()}`);
      console.log("Shaman added via governance proposal");

      // Verify shaman was added
      const shamanPermission = await baal.shamans(await lootOnboarder.getAddress());
      expect(shamanPermission).to.equal(2);
      console.log("✅ Shaman has MANAGER permission");

      // Bob onboards with 0.5 ETH to get loot (no shares)
      const bobTribute = ethers.parseEther("0.5");
      const bobLootBefore = await loot.balanceOf(bob.address);
      const expectedLoot = ethers.parseEther("0.5"); // 1:1 ratio

      console.log(`Bob loot before: ${ethers.formatEther(bobLootBefore)}`);
      console.log(`Bob contributing: ${ethers.formatEther(bobTribute)} ETH`);

      // Onboard and verify MintLoot event
      const onboardTx = await lootOnboarder.connect(bob).onboard({ value: bobTribute });

      await expect(onboardTx)
        .to.emit(baal, "MintLoot")
        .withArgs(
          [bob.address],    // to (array)
          [expectedLoot]    // amount (array)
        );

      console.log("✅ MintLoot event emitted");

      // Verify loot balance increased
      const bobLootAfter = await loot.balanceOf(bob.address);
      expect(bobLootAfter).to.equal(bobLootBefore + expectedLoot);

      console.log(`Bob loot after: ${ethers.formatEther(bobLootAfter)}`);
      console.log(`✅ Bob received ${ethers.formatEther(expectedLoot)} loot tokens`);
    });
  });

  describe("CheckIn Event", function () {
    it("Should emit CheckIn event with all parameters when member checks in", async function () {
      const { baal, shares, checkInShaman, alice } = await loadFixture(deployShamanFixture);

      console.log("\n=== Testing CheckIn Event ===");

      // Get Alice's initial state
      const aliceSharesBefore = await shares.balanceOf(alice.address);
      console.log(`Alice shares before: ${ethers.formatEther(aliceSharesBefore)}`);

      // First check-in (should be immediate - no waiting)
      const checkInTx = await checkInShaman.connect(alice).checkIn();
      const checkInReceipt = await checkInTx.wait();
      const checkInBlock = await ethers.provider.getBlock(checkInReceipt!.blockNumber);

      // Parse CheckIn event from transaction receipt
      const checkInEvent = checkInReceipt!.logs.find((log: any) => {
        try {
          const parsed = checkInShaman.interface.parseLog(log);
          return parsed?.name === "CheckIn";
        } catch {
          return false;
        }
      });

      expect(checkInEvent).to.not.be.undefined;
      console.log("✅ CheckIn event emitted");

      // Validate all event parameters
      // Event CheckIn(address indexed member, uint256 shares, uint256 loot, uint256 timestamp, uint256 missedCount)
      const parsed = checkInShaman.interface.parseLog(checkInEvent!);

      expect(parsed.args[0]).to.equal(alice.address); // member
      console.log(`✅ Member: ${parsed.args[0]}`);

      expect(parsed.args[1]).to.equal(ethers.parseEther("10")); // shares minted
      console.log(`✅ Shares minted: ${ethers.formatEther(parsed.args[1])}`);

      expect(parsed.args[2]).to.equal(0); // loot minted (shaman configured for shares only)
      console.log(`✅ Loot minted: ${ethers.formatEther(parsed.args[2])}`);

      expect(parsed.args[3]).to.equal(checkInBlock!.timestamp); // timestamp
      console.log(`✅ Timestamp: ${parsed.args[3]}`);

      expect(parsed.args[4]).to.equal(0); // missed claims (first check-in)
      console.log(`✅ Missed claims: ${parsed.args[4]}`);

      // Verify shares were actually minted
      const aliceSharesAfter = await shares.balanceOf(alice.address);
      expect(aliceSharesAfter).to.equal(aliceSharesBefore + ethers.parseEther("10"));
      console.log(`Alice shares after: ${ethers.formatEther(aliceSharesAfter)}`);

      console.log("\n=== Testing Second Check-In (After Interval) ===");

      // Wait for check-in interval (30 days configured in fixture)
      await time.increase(30 * 24 * 60 * 60 + 1); // 30 days + 1 second

      // Second check-in
      const checkIn2Tx = await checkInShaman.connect(alice).checkIn();
      const checkIn2Receipt = await checkIn2Tx.wait();
      const checkIn2Block = await ethers.provider.getBlock(checkIn2Receipt!.blockNumber);

      // Parse second CheckIn event
      const checkIn2Event = checkIn2Receipt!.logs.find((log: any) => {
        try {
          const parsed = checkInShaman.interface.parseLog(log);
          return parsed?.name === "CheckIn";
        } catch {
          return false;
        }
      });

      expect(checkIn2Event).to.not.be.undefined;
      const parsed2 = checkInShaman.interface.parseLog(checkIn2Event!);

      expect(parsed2.args[0]).to.equal(alice.address); // member
      expect(parsed2.args[1]).to.equal(ethers.parseEther("10")); // shares minted
      expect(parsed2.args[2]).to.equal(0); // loot minted
      expect(parsed2.args[3]).to.equal(checkIn2Block!.timestamp); // timestamp
      expect(parsed2.args[4]).to.equal(0); // missed claims (checked in on time)

      console.log("✅ Second CheckIn event emitted with correct parameters");
      console.log("✅ All CheckIn event parameters validated");

      // Verify total shares increased by 20 (2 check-ins × 10 shares)
      const aliceSharesFinal = await shares.balanceOf(alice.address);
      expect(aliceSharesFinal).to.equal(aliceSharesBefore + ethers.parseEther("20"));
      console.log(`Alice final shares: ${ethers.formatEther(aliceSharesFinal)} (gained 20 total)`);
    });

    it("Should track missed check-ins correctly", async function () {
      const { checkInShaman, alice } = await loadFixture(deployShamanFixture);

      console.log("\n=== Testing Missed Check-Ins ===");

      // First check-in
      await checkInShaman.connect(alice).checkIn();
      console.log("✅ First check-in completed");

      // Wait DOUBLE the check-in interval (60 days = 2 intervals missed)
      await time.increase(60 * 24 * 60 * 60 + 1); // 60 days

      // Check in late
      const lateTx = await checkInShaman.connect(alice).checkIn();
      const lateReceipt = await lateTx.wait();

      // Parse CheckIn event
      const lateEvent = lateReceipt!.logs.find((log: any) => {
        try {
          const parsed = checkInShaman.interface.parseLog(log);
          return parsed?.name === "CheckIn";
        } catch {
          return false;
        }
      });

      expect(lateEvent).to.not.be.undefined;
      const parsedLate = checkInShaman.interface.parseLog(lateEvent!);

      // Should show 1 missed claim (we skipped 1 interval)
      expect(parsedLate.args[4]).to.equal(1); // missedClaims (5th parameter, index 4)
      console.log(`✅ Missed claims tracked: ${parsedLate.args[4]}`);
      console.log("✅ CheckIn event correctly tracks late check-ins");
    });
  });
});
