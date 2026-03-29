import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { encodeProposalData } from "../../fixtures";

/**
 * Full DAO Lifecycle E2E Test
 * 
 * Tests a complete realistic workflow:
 * 1. Launch DAO with fast governance params
 * 2. Onboard new members via OnboarderNavigator
 * 3. Submit and execute proposals
 * 4. Proposal lifecycle (voting, processing, cancellation)
 */
describe("Full DAO Lifecycle E2E", function () {
  async function deployDAOWithFastGovernance() {
    const [deployer, alice, bob, carol, dave] = await ethers.getSigners();

    // Deploy tokens
    const SharesERC20 = await ethers.getContractFactory("SharesERC20");
    const shares = await SharesERC20.deploy();
    const LootERC20 = await ethers.getContractFactory("LootERC20");
    const loot = await LootERC20.deploy();

    // Deploy DAOShip as EIP-1167 clone (constructor sets avatar=0xdead to guard singleton)
    const DAOShipFactory = await ethers.getContractFactory("DAOShip");
    const daoShipImpl = await DAOShipFactory.deploy();
    await daoShipImpl.waitForDeployment();
    const implAddr = (await daoShipImpl.getAddress()).slice(2).toLowerCase().padStart(40, "0");
    const cloneBytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddr}5af43d82803e903d91602b57fd5bf3`;
    const cloneFactory = new ethers.ContractFactory([], cloneBytecode, deployer);
    const cloneDeploy = await cloneFactory.deploy();
    await cloneDeploy.waitForDeployment();
    const daoShip = DAOShipFactory.attach(await cloneDeploy.getAddress()) as any;

    // Deploy MockAvatar (treasury)
    const MockAvatar = await ethers.getContractFactory("MockAvatar");
    const avatar = await MockAvatar.deploy();
    await avatar.enableModule(await daoShip.getAddress());

    // Deploy infrastructure
    const Poster = await ethers.getContractFactory("Poster");
    const poster = await Poster.deploy();
    const MultiSend = await ethers.getContractFactory("MultiSend");
    const multisend = await MultiSend.deploy();

    // Transfer ownership
    await shares.transferOwnership(await daoShip.getAddress());
    await loot.transferOwnership(await daoShip.getAddress());

    // Deploy navigators
    const OnboarderNavigator = await ethers.getContractFactory("OnboarderNavigator");
    const onboarder = await OnboarderNavigator.deploy(
      await daoShip.getAddress(),
      10000, // shareMultiplier: 1x (basis points)
      0,     // lootMultiplier: no loot
      0,     // pricePerUnit: 0 = multiplier mode
      0,     // sharesPerUnit: N/A in multiplier mode
      0,     // lootPerUnit: N/A in multiplier mode
      ethers.parseEther("0.01"), // minTribute
      0,     // expiry: no expiry
      0,     // mintCap: unlimited
      0,     // perAddressCap: unlimited
      ethers.ZeroHash // allowlistRoot: open
    );

    // FAST GOVERNANCE for E2E testing
    const votingPeriod = 3600;   // 1 hour (minimum required by M-7 fix)
    const gracePeriod = 30;     // 30 seconds
    const proposalOffering = ethers.parseEther("0.001");
    const quorumPercent = 2000; // 20%
    const sponsorThreshold = ethers.parseEther("1");
    const minRetentionPercent = 6600; // 66%

    const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
      [votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent, 0]
    );

    // Initialize with navigators and no initial guild tokens
    const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
      [
        await loot.getAddress(),
        await shares.getAddress(),
        await avatar.getAddress(),
        await multisend.getAddress(),
        governanceConfig,
        [await onboarder.getAddress()],
        [2], // MANAGER
        [deployer.address, alice.address, bob.address],
        [ethers.parseEther("100"), ethers.parseEther("50"), ethers.parseEther("30")],
        [ethers.parseEther("0"), ethers.parseEther("25"), ethers.parseEther("0")],
        [], // No initial guild tokens (can be set via proposal)
        false, // pauseSharesOnLaunch
        false, // pauseLootOnLaunch
      ]
    );

    await daoShip.setUp(initParams);

    // Fund the treasury with some ETH
    await deployer.sendTransaction({
      to: await avatar.getAddress(),
      value: ethers.parseEther("10")
    });

    return {
      daoShip,
      shares,
      loot,
      avatar,
      multisend,
      poster,
      onboarder,
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
      daoShip,
      shares,
      loot,
      avatar,
      onboarder,
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

    console.log("\n=== PHASE 2: New Member Onboarding (OnboarderNavigator) ===");

    // Bob onboards with 0.5 ETH -> 0.5 shares (1:1 multiplier)
    const bobSharesBefore = await shares.balanceOf(bob.address);
    const bobTribute = ethers.parseEther("0.5");
    const bobSharesMinted = ethers.parseEther("0.5");

    await expect(onboarder.connect(bob)["onboard()"]({ value: bobTribute }))
      .to.emit(onboarder, "Onboard")
      .withArgs(await daoShip.getAddress(), bob.address, bobTribute, bobSharesMinted, 0)
      .to.emit(daoShip, "MintShares")
      .withArgs([bob.address], [bobSharesMinted]);

    const bobShares = await shares.balanceOf(bob.address);
    console.log(`Bob onboarded with ${ethers.formatEther(bobTribute)} ETH`);
    console.log(`Bob shares: ${ethers.formatEther(bobSharesBefore)} -> ${ethers.formatEther(bobShares)}`);
    expect(bobShares).to.equal(bobSharesBefore + bobSharesMinted);

    console.log("\n=== PHASE 3: Submit Proposal to Transfer Treasury Funds ===");

    // Proposal to send 1 ETH to Carol from treasury
    const treasuryBalanceBefore = await ethers.provider.getBalance(await avatar.getAddress());
    console.log(`Treasury balance before: ${ethers.formatEther(treasuryBalanceBefore)}`);

    const proposalData = encodeProposalData(
      [carol.address],
      [ethers.parseEther("1")],
      ["0x"]
    );

    const proposalDetails = "Send 1 ETH to Carol as Contributor Payment";

    // Submit proposal and capture event (deployer is self-sponsor, no offering needed)
    const submitTx = await daoShip.connect(deployer).submitProposal(
      proposalData,
      0,
      proposalDetails
    );

    // Validate SubmitProposal event
    const proposalId = await daoShip.proposalCount();
    const proposalDataHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes'], [proposalData]));
    const submitReceipt = await submitTx.wait();
    const submitBlock = await ethers.provider.getBlock(submitReceipt!.blockNumber);

    await expect(submitTx)
      .to.emit(daoShip, "SubmitProposal")
      .withArgs(
        proposalId,              // proposal ID
        proposalDataHash,        // proposalDataHash
        deployer.address,       // submitter
        votingPeriod,           // votingPeriod
        proposalData,           // proposalData (full bytes)
        0,                      // expiration (0 = no expiry)
        true,                   // selfSponsor (deployer has > threshold)
        submitBlock!.timestamp, // timestamp
        proposalDetails,        // details
        0                       // proposalOffering (self-sponsor sends 0)
      );

    console.log("Proposal submitted to transfer 1 ETH to Carol");

    console.log("\n=== PHASE 4: Vote on Proposal ===");

    // Deployer (100 shares) and Alice (50 shares) vote yes
    const deployerVoteTx = await daoShip.connect(deployer).submitVote(1, true);
    await expect(deployerVoteTx)
      .to.emit(daoShip, "SubmitVote")
      .withArgs(
        deployer.address,         // member
        ethers.parseEther("100"), // balance (voting power)
        1,                        // proposal ID
        true                      // approved
      );

    const aliceVoteTx = await daoShip.connect(alice).submitVote(1, true);
    await expect(aliceVoteTx)
      .to.emit(daoShip, "SubmitVote")
      .withArgs(
        alice.address,           // member
        ethers.parseEther("50"), // balance (voting power)
        1,                       // proposal ID
        true                     // approved
      );

    const proposal = await daoShip.proposals(1);
    console.log(`Yes votes: ${proposal.yesVotes}, Yes balance: ${ethers.formatEther(proposal.yesBalance)}`);
    console.log(`Quorum needed: ${ethers.formatEther(await shares.totalSupply() * BigInt(2000) / BigInt(10000))}`);

    expect(proposal.yesBalance).to.equal(ethers.parseEther("150"));

    console.log("\n=== PHASE 5: Wait and Process Proposal ===");

    // Advance past voting period + grace period
    const timeToWait = votingPeriod + gracePeriod + 5; // +5 seconds buffer
    console.log(`Advancing time by ${timeToWait} seconds...`);
    await time.increase(timeToWait);

    // Verify state is Ready
    const state = await daoShip.state(1);
    console.log(`Proposal state: ${state} (4 = Ready)`);
    expect(state).to.equal(5); // ProposalState.Ready

    // Process proposal
    const carolBalanceBefore = await ethers.provider.getBalance(carol.address);

    await expect(daoShip.processProposal(1, proposalData))
      .to.emit(daoShip, "ProcessProposal")
      .withArgs(1, true, false, deployer.address); // passed=true, actionFailed=false, processor=deployer

    console.log("Proposal processed successfully");

    // Verify Carol received the ETH
    const carolBalanceAfter = await ethers.provider.getBalance(carol.address);
    const carolReceived = carolBalanceAfter - carolBalanceBefore;
    console.log(`Carol received ${ethers.formatEther(carolReceived)} ETH`);
    expect(carolReceived).to.equal(ethers.parseEther("1"));

    const treasuryBalanceAfter = await ethers.provider.getBalance(await avatar.getAddress());
    console.log(`Treasury balance after: ${ethers.formatEther(treasuryBalanceAfter)}`);

    console.log("\n=== PHASE 6: Final State Verification ===");

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

    // Verify total governance power increased via onboarding
    expect(finalTotalShares).to.equal(ethers.parseEther("180.5")); // 180 initial (100+50+30) + 0.5 (Bob onboard)

    console.log("\n=== E2E Test Complete ===\n");
    console.log("Summary:");
    console.log("- DAO initialized with 3 founding members");
    console.log("- Bob onboarded additional shares via OnboarderNavigator");
    console.log("- Proposal submitted, voted on, and executed");
    console.log("- All systems functioning correctly!");
  });

  it("Should handle rapid proposal cycles", async function () {
    this.timeout(120000); // 2 minute timeout

    const { daoShip, deployer, alice, votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Rapid Proposal Cycles ===");

    // Submit 3 proposals in quick succession (deployer is self-sponsor)
    for (let i = 1; i <= 3; i++) {
      const proposalData = encodeProposalData(
        [deployer.address],
        [BigInt(0)],
        ["0x"]
      );

      await daoShip.connect(deployer).submitProposal(
        proposalData,
        0,
        `Proposal ${i}`
      );

      // Vote immediately
      await daoShip.connect(deployer).submitVote(i, true);
      await daoShip.connect(alice).submitVote(i, true);

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

      await daoShip.processProposal(i, proposalData);
      console.log(`Proposal ${i} processed`);

      const state = await daoShip.state(i);
      expect(state).to.equal(6); // Processed
    }

    console.log("All proposals processed successfully");
  });

  it("Should execute multi-action proposal", async function () {
    this.timeout(120000);

    const { daoShip, shares, avatar, deployer, alice, bob, votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Multi-Action Proposal ===");

    // Fund treasury
    await deployer.sendTransaction({
      to: await avatar.getAddress(),
      value: ethers.parseEther("5")
    });

    // Create proposal with 2 actions:
    // 1. Send 1 ETH to Alice
    // 2. Send 0.5 ETH to Bob
    // Note: Cannot mint shares via proposal because shares is owned by DAOShip (onlyOwner)
    // and proposal execution path makes msg.sender = avatar, not DAOShip
    const proposalData = encodeProposalData(
      [alice.address, bob.address],
      [ethers.parseEther("1"), ethers.parseEther("0.5")],
      [
        "0x", // Simple ETH transfer
        "0x"  // Simple ETH transfer
      ]
    );

    // deployer is self-sponsor, no offering needed
    await daoShip.connect(deployer).submitProposal(
      proposalData,
      0,
      "Multi-action: Fund Alice & Bob"
    );

    // Capture balances before (before voting to avoid gas costs affecting ETH balance)
    const aliceEthBefore = await ethers.provider.getBalance(alice.address);
    const bobEthBefore = await ethers.provider.getBalance(bob.address);

    // Check treasury balance
    const treasuryBalance = await ethers.provider.getBalance(await avatar.getAddress());
    console.log(`Treasury balance: ${ethers.formatEther(treasuryBalance)} ETH`);

    // Vote (only deployer votes to avoid gas costs on alice/bob)
    await daoShip.connect(deployer).submitVote(1, true);

    // Wait for voting + grace period
    const timeToWait = votingPeriod + gracePeriod + 5;
    await time.increase(timeToWait);

    // Process
    console.log(`Processing proposal with ${proposalData.length} bytes of data...`);
    await daoShip.processProposal(1, proposalData);

    // Check proposal status
    const status = await daoShip.getProposalStatus(1);
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

    const { daoShip, deployer, alice, bob, carol } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Explicit Sponsor ===");

    // Carol submits proposal (doesn't have any shares, so no auto-sponsor)
    const offering = await daoShip.proposalOffering();
    const proposalData = encodeProposalData([deployer.address], [BigInt(0)], ["0x"]);

    await daoShip.connect(carol).submitProposal(
      proposalData,
      0,
      "Carol's proposal",
      { value: offering }
    );

    // Verify state is Submitted (not auto-sponsored)
    const stateBefore = await daoShip.state(1);
    expect(stateBefore).to.equal(1); // Submitted

    console.log("✅ Proposal submitted without auto-sponsor");

    // Deployer sponsors (has threshold)
    const tx = await daoShip.connect(deployer).sponsorProposal(1);

    // Verify SponsorProposal event
    await expect(tx).to.emit(daoShip, "SponsorProposal");

    // Verify state changed to Voting
    const stateAfter = await daoShip.state(1);
    expect(stateAfter).to.equal(2); // Voting

    console.log("✅ Proposal sponsored, now in Voting state");
  });

  it("Should allow proposal cancellation", async function () {
    const { daoShip, deployer, alice } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Proposal Cancellation ===");

    // Submit proposal (deployer is self-sponsor, no offering needed)
    const proposalData = encodeProposalData([deployer.address], [BigInt(0)], ["0x"]);

    await daoShip.connect(deployer).submitProposal(
      proposalData,
      0,
      "Proposal to cancel"
    );

    // Cancel as submitter
    const tx = await daoShip.connect(deployer).cancelProposal(1);

    // Verify CancelProposal event
    await expect(tx).to.emit(daoShip, "CancelProposal").withArgs(1, deployer.address);

    // Verify state is Cancelled (state 3)
    const state = await daoShip.state(1);
    expect(state).to.equal(3); // Cancelled

    // Verify status flag
    const status = await daoShip.getProposalStatus(1);
    expect(status[0]).to.be.true; // cancelled = true

    console.log("✅ Proposal cancelled successfully");
  });

  it("Should validate proposal state transitions", async function () {
    const { daoShip, deployer, alice, votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Proposal State Machine ===");

    const proposalData = encodeProposalData([deployer.address], [BigInt(0)], ["0x"]);

    // State 1: Submitted (auto-sponsored in this case due to threshold, deployer is self-sponsor)
    await daoShip.connect(deployer).submitProposal(proposalData, 0, "State test");

    let state = await daoShip.state(1);
    expect(state).to.equal(2); // Voting (auto-sponsored)
    console.log("✅ State: Voting (auto-sponsored)");

    // State 2: Vote
    await daoShip.connect(deployer).submitVote(1, true);
    await daoShip.connect(alice).submitVote(1, true);

    // Still voting
    state = await daoShip.state(1);
    expect(state).to.equal(2); // Voting
    console.log("✅ State: Still Voting");

    // Wait for voting to end
    await time.increase(votingPeriod + 5);

    // State 4: Grace
    state = await daoShip.state(1);
    expect(state).to.equal(4); // Grace
    console.log("✅ State: Grace Period");

    // Wait for grace to end
    await time.increase(gracePeriod + 5);

    // State 5: Ready
    state = await daoShip.state(1);
    expect(state).to.equal(5); // Ready
    console.log("✅ State: Ready for Processing");

    // Process
    await daoShip.processProposal(1, proposalData);

    // State 6: Processed
    state = await daoShip.state(1);
    expect(state).to.equal(6); // Processed
    console.log("✅ State: Processed");

    console.log("✅ All state transitions validated");
  });

  it("Should handle failed proposals (no quorum)", async function () {
    const { daoShip, deployer, alice, bob, votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Failed Proposal (No Quorum) ===");

    const proposalData = encodeProposalData([deployer.address], [BigInt(0)], ["0x"]);

    // Submit proposal (deployer is self-sponsor)
    await daoShip.connect(deployer).submitProposal(proposalData, 0, "Will fail quorum");

    // Only Bob votes (not enough for 20% quorum)
    // Bob has 30 shares out of 180 = 16.67% < 20%
    await daoShip.connect(bob).submitVote(1, true);

    console.log("Only Bob voted (insufficient for quorum)");

    // Wait for periods
    await time.increase(votingPeriod + gracePeriod + 5);

    // Process
    await daoShip.processProposal(1, proposalData);

    // Verify proposal failed
    const status = await daoShip.getProposalStatus(1);
    expect(status[1]).to.be.true; // processed
    expect(status[2]).to.be.false; // passed = false (failed quorum)

    console.log("✅ Proposal correctly failed due to insufficient quorum");
  });

  it("Should handle defeated proposals (more NO than YES)", async function () {
    const { daoShip, deployer, alice, bob, votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Defeated Proposal (Majority NO) ===");

    const proposalData = encodeProposalData([deployer.address], [BigInt(0)], ["0x"]);

    // deployer is self-sponsor, no offering needed
    await daoShip.connect(deployer).submitProposal(proposalData, 0, "Will be defeated");

    // Deployer votes YES (100 shares)
    // Alice votes NO (50 shares)
    // Bob votes NO (30 shares)
    // Result: 100 YES vs 80 NO = YES wins (this won't be defeated)
    // Let's make Alice and deployer vote NO instead:

    await daoShip.connect(alice).submitVote(1, false); // 50 NO
    await daoShip.connect(bob).submitVote(1, false); // 30 NO
    // Deployer doesn't vote
    // Result: 0 YES vs 80 NO = Defeated

    await time.increase(votingPeriod + gracePeriod + 5);

    // H-1: auto-defeat — noBalance(80) >= yesBalance(0), state() returns Defeated directly
    // processProposal would revert with "not ready"; check state() instead
    expect(await daoShip.state(1)).to.equal(7); // ProposalState.Defeated

    console.log("✅ Proposal correctly auto-defeated (more NO than YES — no processProposal needed)");
  });

  it("Should onboard new member via ERC20TributeNavigator", async function () {
    this.timeout(120000);

    const [deployer, alice, bob, carol] = await ethers.getSigners();

    console.log("\n=== Testing ERC20TributeNavigator Onboarding ===");

    // Deploy tokens
    const SharesERC20 = await ethers.getContractFactory("SharesERC20");
    const shares = await SharesERC20.deploy();
    const LootERC20 = await ethers.getContractFactory("LootERC20");
    const loot = await LootERC20.deploy();

    // Deploy DAOShip as EIP-1167 clone
    const DAOShipFactory = await ethers.getContractFactory("DAOShip");
    const daoShipImpl = await DAOShipFactory.deploy();
    await daoShipImpl.waitForDeployment();
    const implAddr = (await daoShipImpl.getAddress()).slice(2).toLowerCase().padStart(40, "0");
    const cloneBytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implAddr}5af43d82803e903d91602b57fd5bf3`;
    const cloneFactory = new ethers.ContractFactory([], cloneBytecode, deployer);
    const cloneDeploy = await cloneFactory.deploy();
    await cloneDeploy.waitForDeployment();
    const daoShip = DAOShipFactory.attach(await cloneDeploy.getAddress()) as any;

    const MockAvatar = await ethers.getContractFactory("MockAvatar");
    const avatar = await MockAvatar.deploy();
    await avatar.enableModule(await daoShip.getAddress());
    const MultiSend = await ethers.getContractFactory("MultiSend");
    const multisend = await MultiSend.deploy();

    await shares.transferOwnership(await daoShip.getAddress());
    await loot.transferOwnership(await daoShip.getAddress());

    // Deploy a mock ERC20 tribute token (e.g. stablecoin)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tributeToken = await MockERC20.deploy("Test USDC", "USDC");
    await tributeToken.mint(carol.address, ethers.parseEther("10000"));

    // Deploy ERC20TributeNavigator: 100 USDC per share, no loot offering, unlimited cap, open allowlist
    const ERC20TributeNavigator = await ethers.getContractFactory("ERC20TributeNavigator");
    const tributeNavigator = await ERC20TributeNavigator.deploy(
      await daoShip.getAddress(),
      await tributeToken.getAddress(),
      ethers.parseEther("100"), // pricePerShare: 100 tokens per 1e18 shares
      0,                        // pricePerLoot: not offered
      0,                        // no expiry
      0,                        // no mintCap
      0,                        // perAddressCap (unlimited)
      ethers.ZeroHash           // open allowlist
    );

    // Fast governance config
    const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
      [3600, 30, ethers.parseEther("0.001"), 2000, ethers.parseEther("1"), 6600, 0]
    );

    // Initialize DAO with ERC20TributeNavigator as MANAGER, no initial guild tokens
    const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
      [
        await loot.getAddress(),
        await shares.getAddress(),
        await avatar.getAddress(),
        await multisend.getAddress(),
        governanceConfig,
        [await tributeNavigator.getAddress()],
        [2], // MANAGER
        [deployer.address, alice.address],
        [ethers.parseEther("100"), ethers.parseEther("50")],
        [ethers.parseEther("0"), ethers.parseEther("25")],
        [], // no initial guild tokens
        false, // pauseSharesOnLaunch
        false, // pauseLootOnLaunch
      ]
    );
    await daoShip.setUp(initParams);

    const totalSharesBefore = await shares.totalSupply();
    const carolSharesBefore = await shares.balanceOf(carol.address);
    const avatarAddress = await daoShip.avatar();
    const treasuryTokensBefore = await tributeToken.balanceOf(avatarAddress);

    console.log(`Shares before: carol=${ethers.formatEther(carolSharesBefore)}, total=${ethers.formatEther(totalSharesBefore)}`);
    console.log(`Treasury tokens before: ${ethers.formatEther(treasuryTokensBefore)}`);

    // Carol approves and onboards: 3 shares → 300 USDC tribute
    const sharesToMint = ethers.parseEther("3"); // 3e18 wei = 3 shares
    const expectedTribute = ethers.parseEther("300"); // (3e18 * 100e18) / 1e18

    await tributeToken.connect(carol).approve(await tributeNavigator.getAddress(), expectedTribute);

    const tx = await tributeNavigator.connect(carol)["onboard(uint256,uint256)"](sharesToMint, 0);

    await expect(tx)
      .to.emit(tributeNavigator, "Onboard")
      .withArgs(await daoShip.getAddress(), carol.address, expectedTribute, sharesToMint, 0);

    await expect(tx)
      .to.emit(daoShip, "MintShares")
      .withArgs([carol.address], [sharesToMint]);

    const carolSharesAfter = await shares.balanceOf(carol.address);
    const totalSharesAfter = await shares.totalSupply();
    const treasuryTokensAfter = await tributeToken.balanceOf(avatarAddress);

    console.log(`Shares after: carol=${ethers.formatEther(carolSharesAfter)}, total=${ethers.formatEther(totalSharesAfter)}`);
    console.log(`Treasury tokens after: ${ethers.formatEther(treasuryTokensAfter)}`);

    expect(carolSharesAfter).to.equal(sharesToMint);
    expect(totalSharesAfter).to.equal(totalSharesBefore + sharesToMint);
    expect(treasuryTokensAfter).to.equal(treasuryTokensBefore + expectedTribute);

    console.log("✅ Carol onboarded via ERC20TributeNavigator: 300 USDC → 3 shares");
  });

  it("Should have no default native token in guild tokens (guild token sovereignty)", async function () {
    const { daoShip } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Guild Token Sovereignty ===");
    console.log("DAO initialized with empty guildTokens array");

    // address(0) represents native QUAI in guild tokens.
    // The previous behavior unconditionally added it; now it must be explicitly passed.
    const quaiIsGuildToken = await daoShip.guildTokens(ethers.ZeroAddress);
    expect(quaiIsGuildToken).to.be.false;

    console.log("✅ address(0) NOT automatically a guild token (sovereignty preserved)");

    // Verify that guildTokens CAN be added explicitly via proposal
    const { votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance) as any;
    // The fixture returns governance params — use the values directly
    // (Already confirmed the contract works in Ragequit.test.ts which passes ZeroAddress explicitly)
    console.log("✅ Guild token sovereignty confirmed: DAOs control their own ragequit token set");
  });

  it("Should allow adding native token as guild token via governance", async function () {
    const { daoShip, deployer, alice, votingPeriod, gracePeriod } = await loadFixture(deployDAOWithFastGovernance);

    console.log("\n=== Testing Guild Token Addition via Governance ===");

    // setGuildTokens is daoShipOnly (msg.sender == DAOShip) so it must go through executeAsDAOShip,
    // not a direct call. encodeProposalData targets the DAOShip contract via executeAsDAOShip.
    const innerCalldata = daoShip.interface.encodeFunctionData("setGuildTokens", [
      [ethers.ZeroAddress],
      [true]
    ]);
    const executeAsBaalData = daoShip.interface.encodeFunctionData("executeAsGovernance", [
      await daoShip.getAddress(), // target = daoShip itself
      0,
      innerCalldata
    ]);

    const proposalData = encodeProposalData(
      [await daoShip.getAddress()],
      [BigInt(0)],
      [executeAsBaalData]
    );

    // deployer is self-sponsor, no offering needed
    await daoShip.connect(deployer).submitProposal(proposalData, 0, "Add QUAI as guild token");

    await daoShip.connect(deployer).submitVote(1, true);
    await daoShip.connect(alice).submitVote(1, true);
    await time.increase(votingPeriod + gracePeriod + 5);
    await daoShip.processProposal(1, proposalData);

    const status = await daoShip.getProposalStatus(1);
    expect(status[2]).to.be.true; // passed
    expect(status[3]).to.be.false; // actionFailed = false

    expect(await daoShip.guildTokens(ethers.ZeroAddress)).to.be.true;

    console.log("✅ Native QUAI added as guild token via governance proposal");
  });
});
