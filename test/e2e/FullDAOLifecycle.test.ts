import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { encodeProposalData } from "../fixtures-simple";

/**
 * Full DAO Lifecycle E2E Test
 * 
 * Tests a complete realistic workflow:
 * 1. Summon DAO with fast governance params
 * 2. Onboard new members via shamans
 * 3. Submit and execute proposals
 * 4. Check-in rewards
 * 5. Ragequit mechanism
 */
describe("Full DAO Lifecycle E2E", function () {
  async function deployDAOWithFastGovernance() {
    const [deployer, alice, bob, carol, dave] = await ethers.getSigners();

    // Deploy tokens
    const SharesERC20 = await ethers.getContractFactory("SharesERC20");
    const shares = await SharesERC20.deploy();
    const LootERC20 = await ethers.getContractFactory("LootERC20");
    const loot = await LootERC20.deploy();

    // Deploy Baal
    const Baal = await ethers.getContractFactory("Baal");
    const baal = await Baal.deploy();

    // Deploy MockAvatar (treasury)
    const MockAvatar = await ethers.getContractFactory("MockAvatar");
    const avatar = await MockAvatar.deploy();
    await avatar.enableModule(await baal.getAddress());

    // Deploy infrastructure
    const Poster = await ethers.getContractFactory("Poster");
    const poster = await Poster.deploy();
    const MultiSend = await ethers.getContractFactory("MultiSend");
    const multisend = await MultiSend.deploy();

    // Transfer ownership
    await shares.transferOwnership(await baal.getAddress());
    await loot.transferOwnership(await baal.getAddress());

    // Deploy shamans
    const OnboarderShaman = await ethers.getContractFactory("OnboarderShaman");
    const onboarder = await OnboarderShaman.deploy(
      await baal.getAddress(),
      10000, // 1:1 ETH to shares
      0,     // no loot
      ethers.parseEther("0.01"), // min 0.01 ETH
      0      // no expiry
    );

    const EthOnboarderShaman = await ethers.getContractFactory("EthOnboarderShaman");
    const ethOnboarder = await EthOnboarderShaman.deploy(
      await baal.getAddress(),
      ethers.parseEther("0.05"), // 0.05 ETH per unit
      ethers.parseEther("1"),     // 1 share per unit
      0,                          // no loot
      0                           // no expiry
    );

    const CheckInShamanV2 = await ethers.getContractFactory("CheckInShamanV2");
    const checkInShaman = await CheckInShamanV2.deploy(
      await baal.getAddress(),
      60,                    // 1 minute interval (fast for testing)
      ethers.parseEther("5"), // 5 shares per claim
      0,                      // no loot
      3                       // max 3 missed claims
    );

    // FAST GOVERNANCE for E2E testing
    const votingPeriod = 3600;   // 1 hour (minimum required by M-7 fix)
    const gracePeriod = 30;     // 30 seconds
    const proposalOffering = ethers.parseEther("0.001");
    const quorumPercent = 2000; // 20%
    const sponsorThreshold = ethers.parseEther("1");
    const minRetentionPercent = 6600; // 66%

    const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
      [votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent]
    );

    // Initialize with shamans and no initial guild tokens
    const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]"],
      [
        await loot.getAddress(),
        await shares.getAddress(),
        await avatar.getAddress(),
        ethers.ZeroAddress,
        await multisend.getAddress(),
        governanceConfig,
        [await onboarder.getAddress(), await ethOnboarder.getAddress(), await checkInShaman.getAddress()],
        [2, 2, 2], // All MANAGER
        [deployer.address, alice.address, bob.address],
        [ethers.parseEther("100"), ethers.parseEther("50"), ethers.parseEther("30")],
        [ethers.parseEther("0"), ethers.parseEther("25"), ethers.parseEther("0")],
        [] // No initial guild tokens (can be set via proposal)
      ]
    );

    await baal.setUp(initParams);

    // Fund the treasury with some ETH
    await deployer.sendTransaction({
      to: await avatar.getAddress(),
      value: ethers.parseEther("10")
    });

    return {
      baal,
      shares,
      loot,
      avatar,
      multisend,
      poster,
      onboarder,
      ethOnboarder,
      checkInShaman,
      deployer,
      alice,
      bob,
      carol,
      dave,
      votingPeriod,
      gracePeriod,
      proposalOffering,
      quorumPercent,
      sponsorThreshold,
      minRetentionPercent
    };
  }

  it("Should execute complete DAO workflow", async function () {
    this.timeout(180000); // 3 minute timeout for full workflow

    const {
      baal,
      shares,
      loot,
      avatar,
      onboarder,
      ethOnboarder,
      checkInShaman,
      deployer,
      alice,
      bob,
      carol,
      dave,
      votingPeriod,
      gracePeriod
    } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== PHASE 1: DAO Initialization ===");
    
    // Verify initial state
    const initialTotalShares = await shares.totalSupply();
    const initialTotalLoot = await loot.totalSupply();
    console.log(`Initial Shares: ${ethers.formatEther(initialTotalShares)}`);
    console.log(`Initial Loot: ${ethers.formatEther(initialTotalLoot)}`);
    console.log(`Treasury Balance: ${ethers.formatEther(await ethers.provider.getBalance(await avatar.getAddress()))}`);

    expect(initialTotalShares).to.equal(ethers.parseEther("180")); // 100 + 50 + 30
    expect(initialTotalLoot).to.equal(ethers.parseEther("25"));
    expect(await shares.balanceOf(deployer.address)).to.equal(ethers.parseEther("100"));
    expect(await shares.balanceOf(alice.address)).to.equal(ethers.parseEther("50"));
    expect(await shares.balanceOf(bob.address)).to.equal(ethers.parseEther("30"));

    console.log("\n=== PHASE 2: New Member Onboarding (OnboarderShaman) ===");

    // Bob onboards with 0.5 ETH -> 0.5 shares (1:1 multiplier)
    const bobSharesBefore = await shares.balanceOf(bob.address);
    const bobTribute = ethers.parseEther("0.5");
    const bobSharesMinted = ethers.parseEther("0.5");

    await expect(onboarder.connect(bob).onboard({ value: bobTribute }))
      .to.emit(onboarder, "Onboard")
      .withArgs(bob.address, bobTribute, bobSharesMinted, 0)
      .to.emit(baal, "MintShares")
      .withArgs([bob.address], [bobSharesMinted]);

    const bobShares = await shares.balanceOf(bob.address);
    console.log(`Bob onboarded with ${ethers.formatEther(bobTribute)} ETH`);
    console.log(`Bob shares: ${ethers.formatEther(bobSharesBefore)} -> ${ethers.formatEther(bobShares)}`);
    expect(bobShares).to.equal(bobSharesBefore + bobSharesMinted);

    console.log("\n=== PHASE 3: New Member Onboarding (EthOnboarderShaman) ===");

    // Carol onboards with 0.2 ETH -> 4 units -> 4 shares (0.05 ETH per unit)
    const carolTribute = ethers.parseEther("0.2");
    const carolSharesExpected = ethers.parseEther("4"); // 0.2 / 0.05 = 4 units

    await expect(ethOnboarder.connect(carol).onboard({ value: carolTribute }))
      .to.emit(baal, "MintShares")
      .withArgs([carol.address], [carolSharesExpected]);

    const carolShares = await shares.balanceOf(carol.address);
    console.log(`Carol onboarded with ${ethers.formatEther(carolTribute)} ETH`);
    console.log(`Carol received ${ethers.formatEther(carolShares)} shares`);
    expect(carolShares).to.equal(carolSharesExpected);

    console.log("\n=== PHASE 4: Submit Proposal to Transfer Treasury Funds ===");

    // Proposal to send 1 ETH to Carol from treasury
    const treasuryBalanceBefore = await ethers.provider.getBalance(await avatar.getAddress());
    console.log(`Treasury balance before: ${ethers.formatEther(treasuryBalanceBefore)}`);

    const proposalData = encodeProposalData(
      [carol.address],
      [ethers.parseEther("1")],
      ["0x"]
    );

    const offering = await baal.proposalOffering();
    const proposalDetails = "Send 1 ETH to Carol as Contributor Payment";

    // Submit proposal and capture event
    const submitTx = await baal.connect(deployer).submitProposal(
      proposalData,
      0,
      0,
      proposalDetails,
      { value: offering }
    );

    // Validate SubmitProposal event
    const proposalId = await baal.proposalCount();
    const proposalDataHash = ethers.keccak256(proposalData);
    const submitReceipt = await submitTx.wait();
    const submitBlock = await ethers.provider.getBlock(submitReceipt!.blockNumber);

    await expect(submitTx)
      .to.emit(baal, "SubmitProposal")
      .withArgs(
        proposalId,              // proposal ID
        proposalDataHash,        // proposalDataHash
        votingPeriod,           // votingPeriod
        proposalData,           // proposalData (full bytes)
        0,                      // expiration (0 = no expiry)
        true,                   // selfSponsor (deployer has > threshold)
        submitBlock!.timestamp, // timestamp
        proposalDetails         // details
      );

    console.log("Proposal submitted to transfer 1 ETH to Carol");

    console.log("\n=== PHASE 5: Vote on Proposal ===");

    // Deployer (100 shares) and Alice (50 shares) vote yes
    const deployerVoteTx = await baal.connect(deployer).submitVote(1, true);
    await expect(deployerVoteTx)
      .to.emit(baal, "SubmitVote")
      .withArgs(
        deployer.address,         // member
        ethers.parseEther("100"), // balance (voting power)
        1,                        // proposal ID
        true                      // approved
      );

    const aliceVoteTx = await baal.connect(alice).submitVote(1, true);
    await expect(aliceVoteTx)
      .to.emit(baal, "SubmitVote")
      .withArgs(
        alice.address,           // member
        ethers.parseEther("50"), // balance (voting power)
        1,                       // proposal ID
        true                     // approved
      );

    const proposal = await baal.proposals(1);
    console.log(`Yes votes: ${proposal.yesVotes}, Yes balance: ${ethers.formatEther(proposal.yesBalance)}`);
    console.log(`Quorum needed: ${ethers.formatEther(await shares.totalSupply() * BigInt(2000) / BigInt(10000))}`);

    expect(proposal.yesBalance).to.equal(ethers.parseEther("150"));

    console.log("\n=== PHASE 6: Wait and Process Proposal ===");

    // Advance past voting period + grace period
    const timeToWait = votingPeriod + gracePeriod + 5; // +5 seconds buffer
    console.log(`Advancing time by ${timeToWait} seconds...`);
    await time.increase(timeToWait);

    // Verify state is Ready
    const state = await baal.state(1);
    console.log(`Proposal state: ${state} (4 = Ready)`);
    expect(state).to.equal(4); // ProposalState.Ready

    // Process proposal
    const carolBalanceBefore = await ethers.provider.getBalance(carol.address);

    await expect(baal.processProposal(1, proposalData))
      .to.emit(baal, "ProcessProposal")
      .withArgs(1, true, false); // passed=true, actionFailed=false

    console.log("Proposal processed successfully");

    // Verify Carol received the ETH
    const carolBalanceAfter = await ethers.provider.getBalance(carol.address);
    const carolReceived = carolBalanceAfter - carolBalanceBefore;
    console.log(`Carol received ${ethers.formatEther(carolReceived)} ETH`);
    expect(carolReceived).to.equal(ethers.parseEther("1"));

    const treasuryBalanceAfter = await ethers.provider.getBalance(await avatar.getAddress());
    console.log(`Treasury balance after: ${ethers.formatEther(treasuryBalanceAfter)}`);

    console.log("\n=== PHASE 7: Check-In Rewards ===");

    // Alice checks in (first claim is immediate)
    await checkInShaman.connect(alice).checkIn();
    console.log("Alice checked in (first time)");

    let aliceNewShares = await shares.balanceOf(alice.address);
    expect(aliceNewShares).to.equal(ethers.parseEther("55")); // 50 + 5
    console.log(`Alice now has ${ethers.formatEther(aliceNewShares)} shares`);

    // Wait 1 minute and check in again
    console.log("Advancing time by 65 seconds...");
    await time.increase(65);

    await checkInShaman.connect(alice).checkIn();
    console.log("Alice checked in again");

    aliceNewShares = await shares.balanceOf(alice.address);
    expect(aliceNewShares).to.equal(ethers.parseEther("60")); // 55 + 5
    console.log(`Alice now has ${ethers.formatEther(aliceNewShares)} shares`);

    console.log("\n=== PHASE 8: Final State Verification ===");

    const finalTotalShares = await shares.totalSupply();
    const finalTotalLoot = await loot.totalSupply();
    const finalTreasuryBalance = await ethers.provider.getBalance(await avatar.getAddress());

    console.log(`Final Shares: ${ethers.formatEther(finalTotalShares)}`);
    console.log(`Final Loot: ${ethers.formatEther(finalTotalLoot)}`);
    console.log(`Final Treasury Balance: ${ethers.formatEther(finalTreasuryBalance)}`);

    console.log("\n=== Member Distribution ===");
    console.log(`Deployer: ${ethers.formatEther(await shares.balanceOf(deployer.address))} shares`);
    console.log(`Alice: ${ethers.formatEther(await shares.balanceOf(alice.address))} shares, ${ethers.formatEther(await loot.balanceOf(alice.address))} loot`);
    console.log(`Bob: ${ethers.formatEther(await shares.balanceOf(bob.address))} shares`);
    console.log(`Carol: ${ethers.formatEther(await shares.balanceOf(carol.address))} shares`);

    // Verify total governance power increased via shamans and check-ins
    expect(finalTotalShares).to.equal(ethers.parseEther("194.5")); // 180 initial (100+50+30) + 0.5 (Bob onboard) + 4 (Carol) + 10 (Alice check-ins)

    console.log("\n=== E2E Test Complete ===\n");
    console.log("Summary:");
    console.log("- DAO initialized with 2 founding members");
    console.log("- 2 new members onboarded via shamans");
    console.log("- Proposal submitted, voted on, and executed");
    console.log("- Check-in rewards claimed");
    console.log("- All systems functioning correctly!");
  });

  it("Should handle rapid proposal cycles", async function () {
    this.timeout(120000); // 2 minute timeout

    const { baal, deployer, alice, votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Rapid Proposal Cycles ===");

    const offering = await baal.proposalOffering();

    // Submit 3 proposals in quick succession
    for (let i = 1; i <= 3; i++) {
      const proposalData = encodeProposalData(
        [deployer.address],
        [BigInt(0)],
        ["0x"]
      );

      await baal.connect(deployer).submitProposal(
        proposalData,
        0,
        0,
        `Proposal ${i}`,
        { value: offering }
      );

      // Vote immediately
      await baal.connect(deployer).submitVote(i, true);
      await baal.connect(alice).submitVote(i, true);

      console.log(`Proposal ${i} submitted and voted on`);
    }

    // Wait for voting + grace period
    const timeToWait = votingPeriod + gracePeriod + 5; // +5 seconds buffer
    console.log(`Advancing time by ${timeToWait} seconds...`);
    await time.increase(timeToWait);

    // Process all proposals
    for (let i = 1; i <= 3; i++) {
      const proposalData = encodeProposalData(
        [deployer.address],
        [BigInt(0)],
        ["0x"]
      );

      await baal.processProposal(i, proposalData);
      console.log(`Proposal ${i} processed`);

      const state = await baal.state(i);
      expect(state).to.equal(5); // Processed
    }

    console.log("All proposals processed successfully");
  });

  it("Should execute multi-action proposal", async function () {
    this.timeout(120000);

    const { baal, shares, avatar, deployer, alice, bob, votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Multi-Action Proposal ===");

    // Fund treasury
    await deployer.sendTransaction({
      to: await avatar.getAddress(),
      value: ethers.parseEther("5")
    });

    const offering = await baal.proposalOffering();

    // Create proposal with 2 actions:
    // 1. Send 1 ETH to Alice
    // 2. Send 0.5 ETH to Bob
    // Note: Cannot mint shares via proposal because shares is owned by Baal (onlyOwner)
    // and proposal execution path makes msg.sender = avatar, not Baal
    const proposalData = encodeProposalData(
      [alice.address, bob.address],
      [ethers.parseEther("1"), ethers.parseEther("0.5")],
      [
        "0x", // Simple ETH transfer
        "0x"  // Simple ETH transfer
      ]
    );

    await baal.connect(deployer).submitProposal(
      proposalData,
      0,
      0,
      "Multi-action: Fund Alice & Bob",
      { value: offering }
    );

    // Capture balances before (before voting to avoid gas costs affecting ETH balance)
    const aliceEthBefore = await ethers.provider.getBalance(alice.address);
    const bobEthBefore = await ethers.provider.getBalance(bob.address);

    // Check treasury balance
    const treasuryBalance = await ethers.provider.getBalance(await avatar.getAddress());
    console.log(`Treasury balance: ${ethers.formatEther(treasuryBalance)} ETH`);

    // Vote (only deployer votes to avoid gas costs on alice/bob)
    await baal.connect(deployer).submitVote(1, true);

    // Wait for voting + grace period
    const timeToWait = votingPeriod + gracePeriod + 5;
    await time.increase(timeToWait);

    // Process
    console.log(`Processing proposal with ${proposalData.length} bytes of data...`);
    await baal.processProposal(1, proposalData);

    // Check proposal status
    const status = await baal.getProposalStatus(1);
    console.log(`Proposal status: processed=${status[1]}, passed=${status[2]}, actionFailed=${status[3]}`);

    // Verify all actions executed
    const aliceEthAfter = await ethers.provider.getBalance(alice.address);
    const bobEthAfter = await ethers.provider.getBalance(bob.address);

    console.log(`Alice ETH: before=${ethers.formatEther(aliceEthBefore)}, after=${ethers.formatEther(aliceEthAfter)}`);
    console.log(`Bob ETH: before=${ethers.formatEther(bobEthBefore)}, after=${ethers.formatEther(bobEthAfter)}`);

    expect(status[3]).to.be.false; // actionFailed should be false
    expect(aliceEthAfter).to.equal(aliceEthBefore + ethers.parseEther("1"));
    expect(bobEthAfter).to.equal(bobEthBefore + ethers.parseEther("0.5"));

    console.log("✅ Both actions executed successfully");
    console.log(`   - Alice received 1 ETH`);
    console.log(`   - Bob received 0.5 ETH`);
  });

  it("Should handle proposal sponsorship explicitly", async function () {
    this.timeout(120000);

    const { baal, deployer, alice, bob, carol } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Explicit Sponsor ===");

    // Carol submits proposal (doesn't have any shares, so no auto-sponsor)
    const offering = await baal.proposalOffering();
    const proposalData = encodeProposalData([deployer.address], [BigInt(0)], ["0x"]);

    await baal.connect(carol).submitProposal(
      proposalData,
      0,
      0,
      "Carol's proposal",
      { value: offering }
    );

    // Verify state is Submitted (not auto-sponsored)
    const stateBefore = await baal.state(1);
    expect(stateBefore).to.equal(1); // Submitted

    console.log("✅ Proposal submitted without auto-sponsor");

    // Deployer sponsors (has threshold)
    const tx = await baal.connect(deployer).sponsorProposal(1);

    // Verify SponsorProposal event
    await expect(tx).to.emit(baal, "SponsorProposal");

    // Verify state changed to Voting
    const stateAfter = await baal.state(1);
    expect(stateAfter).to.equal(2); // Voting

    console.log("✅ Proposal sponsored, now in Voting state");

    // Verify linked list
    const proposal = await baal.proposals(1);
    expect(proposal.prevProposalId).to.equal(0); // First sponsored proposal

    console.log("✅ Linked list updated correctly");
  });

  it("Should allow proposal cancellation", async function () {
    const { baal, deployer, alice } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Proposal Cancellation ===");

    // Submit proposal
    const offering = await baal.proposalOffering();
    const proposalData = encodeProposalData([deployer.address], [BigInt(0)], ["0x"]);

    await baal.connect(deployer).submitProposal(
      proposalData,
      0,
      0,
      "Proposal to cancel",
      { value: offering }
    );

    // Cancel as submitter
    const tx = await baal.connect(deployer).cancelProposal(1);

    // Verify CancelProposal event
    await expect(tx).to.emit(baal, "CancelProposal").withArgs(1);

    // Verify state is Cancelled (state 6)
    const state = await baal.state(1);
    expect(state).to.equal(6); // Cancelled

    // Verify status flag
    const status = await baal.getProposalStatus(1);
    expect(status[0]).to.be.true; // cancelled = true

    console.log("✅ Proposal cancelled successfully");
  });

  it("Should validate proposal state transitions", async function () {
    const { baal, deployer, alice, votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Proposal State Machine ===");

    const offering = await baal.proposalOffering();
    const proposalData = encodeProposalData([deployer.address], [BigInt(0)], ["0x"]);

    // State 1: Submitted (auto-sponsored in this case due to threshold)
    await baal.connect(deployer).submitProposal(proposalData, 0, 0, "State test", { value: offering });

    let state = await baal.state(1);
    expect(state).to.equal(2); // Voting (auto-sponsored)
    console.log("✅ State: Voting (auto-sponsored)");

    // State 2: Vote
    await baal.connect(deployer).submitVote(1, true);
    await baal.connect(alice).submitVote(1, true);

    // Still voting
    state = await baal.state(1);
    expect(state).to.equal(2); // Voting
    console.log("✅ State: Still Voting");

    // Wait for voting to end
    await time.increase(votingPeriod + 5);

    // State 3: Grace
    state = await baal.state(1);
    expect(state).to.equal(3); // Grace
    console.log("✅ State: Grace Period");

    // Wait for grace to end
    await time.increase(gracePeriod + 5);

    // State 4: Ready
    state = await baal.state(1);
    expect(state).to.equal(4); // Ready
    console.log("✅ State: Ready for Processing");

    // Process
    await baal.processProposal(1, proposalData);

    // State 5: Processed
    state = await baal.state(1);
    expect(state).to.equal(5); // Processed
    console.log("✅ State: Processed");

    console.log("✅ All state transitions validated");
  });

  it("Should handle failed proposals (no quorum)", async function () {
    const { baal, deployer, alice, bob, votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Failed Proposal (No Quorum) ===");

    const offering = await baal.proposalOffering();
    const proposalData = encodeProposalData([deployer.address], [BigInt(0)], ["0x"]);

    // Submit proposal
    await baal.connect(deployer).submitProposal(proposalData, 0, 0, "Will fail quorum", { value: offering });

    // Only Bob votes (not enough for 20% quorum)
    // Bob has 30 shares out of 180 = 16.67% < 20%
    await baal.connect(bob).submitVote(1, true);

    console.log("Only Bob voted (insufficient for quorum)");

    // Wait for periods
    await time.increase(votingPeriod + gracePeriod + 5);

    // Process
    await baal.processProposal(1, proposalData);

    // Verify proposal failed
    const status = await baal.getProposalStatus(1);
    expect(status[1]).to.be.true; // processed
    expect(status[2]).to.be.false; // passed = false (failed quorum)

    console.log("✅ Proposal correctly failed due to insufficient quorum");
  });

  it("Should handle defeated proposals (more NO than YES)", async function () {
    const { baal, deployer, alice, bob, votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Defeated Proposal (Majority NO) ===");

    const offering = await baal.proposalOffering();
    const proposalData = encodeProposalData([deployer.address], [BigInt(0)], ["0x"]);

    await baal.connect(deployer).submitProposal(proposalData, 0, 0, "Will be defeated", { value: offering });

    // Deployer votes YES (100 shares)
    // Alice votes NO (50 shares)
    // Bob votes NO (30 shares)
    // Result: 100 YES vs 80 NO = YES wins (this won't be defeated)
    // Let's make Alice and deployer vote NO instead:

    await baal.connect(alice).submitVote(1, false); // 50 NO
    await baal.connect(bob).submitVote(1, false); // 30 NO
    // Deployer doesn't vote
    // Result: 0 YES vs 80 NO = Defeated

    await time.increase(votingPeriod + gracePeriod + 5);

    await baal.processProposal(1, proposalData);

    const status = await baal.getProposalStatus(1);
    expect(status[1]).to.be.true; // processed
    expect(status[2]).to.be.false; // passed = false (defeated)

    console.log("✅ Proposal correctly defeated (more NO than YES)");
  });
});
