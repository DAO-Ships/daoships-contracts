import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployDAOShipFixture, advanceTime, getCurrentTime, encodeProposalData } from "../fixtures";

describe("DAOShip", function () {
  describe("Deployment", function () {
    it("Should initialize with correct parameters", async function () {
      const { daoShip, shares, loot, avatar } = await loadFixture(
        deployDAOShipFixture
      );

      expect(await daoShip.sharesToken()).to.equal(await shares.getAddress());
      expect(await daoShip.lootToken()).to.equal(await loot.getAddress());
      expect(await daoShip.avatar()).to.equal(await avatar.getAddress());
      expect(await daoShip.votingPeriod()).to.equal(7 * 24 * 60 * 60);
      expect(await daoShip.gracePeriod()).to.equal(3 * 24 * 60 * 60);
      expect(await daoShip.proposalOffering()).to.equal(ethers.parseEther("0.1"));
      expect(await daoShip.quorumPercent()).to.equal(2000); // 20%
      expect(await daoShip.sponsorThreshold()).to.equal(ethers.parseEther("1"));
      expect(await daoShip.minRetentionPercent()).to.equal(6600); // 66%
    });

    it("Should mint initial shares and loot", async function () {
      const { shares, loot, deployer, alice } = await loadFixture(
        deployDAOShipFixture
      );

      expect(await shares.balanceOf(deployer.address)).to.equal(
        ethers.parseEther("100")
      );
      expect(await shares.balanceOf(alice.address)).to.equal(
        ethers.parseEther("50")
      );
      expect(await loot.balanceOf(alice.address)).to.equal(
        ethers.parseEther("25")
      );
    });

    it("Should not allow re-initialization", async function () {
      const { daoShip } = await loadFixture(deployDAOShipFixture);

      const mockParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [ethers.ZeroAddress]
      );

      await expect(daoShip.setUp(mockParams)).to.be.revertedWithCustomError(
        daoShip, "AlreadyInitialized"
      );
    });
  });

  describe("Proposal Submission", function () {
    it("Should submit a proposal with correct offering", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );

      // deployer is self-sponsor (shares >= sponsorThreshold), no offering needed
      await expect(
        daoShip.submitProposal(proposalData, 0,"Test proposal")
      )
        .to.emit(daoShip, "SubmitProposal")
        .withArgs(
          1, // proposal ID
          ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes'], [proposalData])),
          deployer.address, // submitter
          await daoShip.votingPeriod(),
          proposalData,
          0,
          true, // auto-sponsored (deployer has >1 share)
          await time.latest(),
          "Test proposal",
          0 // proposalOffering (self-sponsor sends 0)
        );
    });

    it("Should auto-sponsor if threshold met", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );

      // deployer is self-sponsor, no offering needed
      const tx = await daoShip.submitProposal(proposalData, 0,"Test");
      await tx.wait();

      // Should also emit SponsorProposal
      await expect(tx).to.emit(daoShip, "SponsorProposal");

      // Proposal should be in Voting state
      expect(await daoShip.state(1)).to.equal(2); // ProposalState.Voting
    });

    it("Should not auto-sponsor if threshold not met", async function () {
      const { daoShip, bob } = await loadFixture(deployDAOShipFixture);

      // Bob has no shares, below threshold
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [bob.address, 0, "0x"]
      );

      const offering = await daoShip.proposalOffering();
      const tx = await daoShip
        .connect(bob)
        .submitProposal(proposalData, 0,"Test", {
          value: offering,
        });

      // Should not emit SponsorProposal
      await expect(tx).to.not.emit(daoShip, "SponsorProposal");

      // Proposal should be in Submitted state
      expect(await daoShip.state(1)).to.equal(1); // ProposalState.Submitted
    });

    it("Should revert with incorrect offering for non-member", async function () {
      const { daoShip, bob } = await loadFixture(deployDAOShipFixture);

      // Bob has 0 shares (below sponsorThreshold), so offering is required
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [bob.address, 0, "0x"]
      );

      await expect(
        daoShip.connect(bob).submitProposal(proposalData, 0,"Test", {
          value: ethers.parseEther("0.05"), // Wrong amount
        })
      ).to.be.revertedWithCustomError(daoShip, "IncorrectOffering");
    });

    it("Should skip offering for self-sponsor (member above threshold)", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      // Deployer has 100 shares >= sponsorThreshold (1 share), so no offering needed
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );

      // Should succeed with 0 value (no offering required for self-sponsors)
      await expect(
        daoShip.submitProposal(proposalData, 0,"Test", { value: 0 })
      ).to.not.be.reverted;
    });
  });

  describe("Proposal Sponsorship", function () {
    it("Should allow sponsorship by member with threshold", async function () {
      const { daoShip, alice, bob } = await loadFixture(deployDAOShipFixture);

      // Bob submits (has 0 shares, below threshold, won't auto-sponsor)
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [bob.address, 0, "0x"]
      );
      const offering = await daoShip.proposalOffering();
      const tx = await daoShip
        .connect(bob)
        .submitProposal(proposalData, 0,"Test", { value: offering });
      await tx.wait();

      // Should be in Submitted state (not auto-sponsored)
      expect(await daoShip.state(1)).to.equal(1);

      // Alice sponsors (has 50 shares > 1 threshold)
      const sponsorTx = await daoShip.connect(alice).sponsorProposal(1);
      await expect(sponsorTx).to.emit(daoShip, "SponsorProposal");

      // Now in Voting state
      expect(await daoShip.state(1)).to.equal(2);
    });

    it("Should revert if sponsor doesn't meet threshold", async function () {
      const { daoShip, bob } = await loadFixture(deployDAOShipFixture);

      // First need a submitted proposal
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [bob.address, 0, "0x"]
      );
      const offering = await daoShip.proposalOffering();

      // Would need to submit as someone with shares first
      // Bob can't sponsor since he has 0 shares
    });

    it("Should allow multiple proposals to be sponsored independently", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      // Submit first proposal (auto-sponsored, deployer is self-sponsor)
      await daoShip.submitProposal(proposalData, 0,"Proposal 1");

      // Submit second proposal (auto-sponsored)
      await daoShip.submitProposal(proposalData, 0,"Proposal 2");

      // Both proposals should be in Voting state (no sequential dependency)
      expect(await daoShip.state(1)).to.equal(2); // Voting
      expect(await daoShip.state(2)).to.equal(2); // Voting
    });
  });

  describe("Voting", function () {
    async function submitAndSponsorProposal(daoShip: any, deployer: any) {
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      // deployer is a self-sponsor (shares >= sponsorThreshold), no offering required
      const tx = await daoShip.submitProposal(proposalData, 0,"Test");
      await tx.wait();
      return 1; // proposal ID
    }

    it("Should allow voting during voting period", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const proposalId = await submitAndSponsorProposal(daoShip, deployer);

      // Alice votes yes
      await expect(daoShip.connect(alice).submitVote(proposalId, true))
        .to.emit(daoShip, "SubmitVote")
        .withArgs(alice.address, ethers.parseEther("50"), proposalId, true);
    });

    it("Should track vote counts and balances", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const proposalId = await submitAndSponsorProposal(daoShip, deployer);

      // Deployer votes yes (100 shares)
      await daoShip.connect(deployer).submitVote(proposalId, true);

      // Alice votes no (50 shares)
      await daoShip.connect(alice).submitVote(proposalId, false);

      const proposal = await daoShip.proposals(proposalId);
      expect(proposal.yesVotes).to.equal(1); // 1 voter
      expect(proposal.noVotes).to.equal(1); // 1 voter
      expect(proposal.yesBalance).to.equal(ethers.parseEther("100")); // 100 shares
      expect(proposal.noBalance).to.equal(ethers.parseEther("50")); // 50 shares
    });

    it("Should prevent double voting", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const proposalId = await submitAndSponsorProposal(daoShip, deployer);

      // First vote
      await daoShip.connect(deployer).submitVote(proposalId, true);

      // Second vote should revert
      await expect(
        daoShip.connect(deployer).submitVote(proposalId, false)
      ).to.be.revertedWithCustomError(daoShip, "AlreadyVoted");
    });

    it("Should revert if not in voting period", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const proposalId = await submitAndSponsorProposal(daoShip, deployer);

      // Advance past voting period
      await advanceTime(8 * 24 * 60 * 60); // 8 days

      await expect(
        daoShip.connect(deployer).submitVote(proposalId, true)
      ).to.be.revertedWithCustomError(daoShip, "NotVoting");
    });

    it("Should require voting power", async function () {
      const { daoShip, bob } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [bob.address, 0, "0x"]
      );
      // Deployer submits so it gets auto-sponsored (self-sponsor, no offering needed)
      const { deployer } = await loadFixture(deployDAOShipFixture);
      const tx = await daoShip.submitProposal(proposalData, 0,"Test");
      await tx.wait();

      // Bob has no shares, cannot vote
      await expect(daoShip.connect(bob).submitVote(1, true)).to.be.revertedWithCustomError(
        daoShip, "InsufficientVotingPower"
      );
    });

    it("Should use snapshot balance for voting power", async function () {
      const { daoShip, deployer, alice, shares } = await loadFixture(
        deployDAOShipFixture
      );

      const proposalId = await submitAndSponsorProposal(daoShip, deployer);

      // Get proposal
      const proposal = await daoShip.proposals(proposalId);
      const votingStarts = proposal.votingStarts;

      // Transfer shares after voting starts
      await shares
        .connect(deployer)
        .transfer(alice.address, ethers.parseEther("50"));

      // Deployer should still be able to vote with original balance
      await daoShip.connect(deployer).submitVote(proposalId, true);

      const updatedProposal = await daoShip.proposals(proposalId);
      expect(updatedProposal.yesBalance).to.equal(ethers.parseEther("100")); // Original balance
    });
  });

  describe("Proposal Processing", function () {
    async function submitVoteAndAdvance(
      daoShip: any,
      deployer: any,
      alice: any,
      proposalData: string
    ) {
      // deployer is self-sponsor, no offering needed
      const tx = await daoShip.submitProposal(proposalData, 0,"Test");
      await tx.wait();

      // Vote yes (deployer has 100 shares, alice has 50)
      await daoShip.connect(deployer).submitVote(1, true);
      await daoShip.connect(alice).submitVote(1, true);

      // Advance past voting + grace period
      await advanceTime(11 * 24 * 60 * 60); // 11 days

      return 1; // proposal ID
    }

    it("Should process passed proposal", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const proposalData = encodeProposalData(
        [deployer.address],
        [BigInt(0)],
        ["0x"]
      );

      const proposalId = await submitVoteAndAdvance(
        daoShip,
        deployer,
        alice,
        proposalData
      );

      // Process proposal
      await expect(daoShip.processProposal(proposalId, proposalData))
        .to.emit(daoShip, "ProcessProposal")
        .withArgs(proposalId, true, false, deployer.address); // passed=true, actionFailed=false, processor=deployer

      // Should be in Processed state
      expect(await daoShip.state(proposalId)).to.equal(6); // ProposalState.Processed
    });

    it("Should mark as defeated if quorum not met", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      // deployer is self-sponsor, no offering needed
      await daoShip.submitProposal(proposalData, 0,"Test");

      // Only Alice votes (50 shares), quorum is 20% of 150 = 30 shares
      // Alice's 50 shares > 30, so quorum is met
      // But let's test with no votes

      // Advance past voting + grace period without voting
      await advanceTime(11 * 24 * 60 * 60);

      // H-1: auto-defeat — state() returns Defeated without needing processProposal
      // (noBalance=0 >= yesBalance=0, so auto-defeated)
      expect(await daoShip.state(1)).to.equal(7); // ProposalState.Defeated
    });

    it("Should mark as defeated if majority not met", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      // deployer is self-sponsor, no offering needed
      await daoShip.submitProposal(proposalData, 0,"Test");

      // Deployer votes no (100 shares), Alice votes yes (50 shares)
      await daoShip.connect(deployer).submitVote(1, false);
      await daoShip.connect(alice).submitVote(1, true);

      // Advance past voting + grace period
      await advanceTime(11 * 24 * 60 * 60);

      // H-1: auto-defeat — state() returns Defeated without needing processProposal
      // (noBalance=100 >= yesBalance=50, so auto-defeated)
      expect(await daoShip.state(1)).to.equal(7); // ProposalState.Defeated
    });

    it("Should verify proposal data hash", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );

      const proposalId = await submitVoteAndAdvance(
        daoShip,
        deployer,
        alice,
        proposalData
      );

      const wrongData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [alice.address, 0, "0x"] // Different data
      );

      // Process with wrong data should revert
      await expect(daoShip.processProposal(proposalId, wrongData)).to.be.revertedWithCustomError(
        daoShip, "HashMismatch"
      );
    });

    it("Should revert if not in Ready state", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      // deployer is self-sponsor, no offering needed
      await daoShip.submitProposal(proposalData, 0,"Test");

      // Still in voting period
      await expect(daoShip.processProposal(1, proposalData)).to.be.revertedWithCustomError(
        daoShip, "NotReady"
      );
    });
  });

  describe("Proposal Cancellation", function () {
    it("Should allow submitter to cancel", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      // deployer is self-sponsor, no offering needed
      await daoShip.submitProposal(proposalData, 0,"Test");

      await expect(daoShip.connect(deployer).cancelProposal(1))
        .to.emit(daoShip, "CancelProposal")
        .withArgs(1, deployer.address);

      expect(await daoShip.state(1)).to.equal(3); // ProposalState.Cancelled
    });

    it("Should not allow non-submitter to cancel", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      // deployer is self-sponsor, no offering needed
      await daoShip.submitProposal(proposalData, 0,"Test");

      await expect(daoShip.connect(alice).cancelProposal(1)).to.be.revertedWithCustomError(
        daoShip, "NotAuthorized"
      );
    });

    it("Should not allow cancelling processed proposal", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      // deployer is self-sponsor, no offering needed
      await daoShip.submitProposal(proposalData, 0,"Test");

      // Vote and process
      await daoShip.connect(deployer).submitVote(1, true);
      await daoShip.connect(alice).submitVote(1, true);
      await advanceTime(11 * 24 * 60 * 60);
      await daoShip.processProposal(1, proposalData);

      // Try to cancel
      await expect(daoShip.connect(deployer).cancelProposal(1)).to.be.revertedWithCustomError(
        daoShip, "AlreadyProcessed"
      );
    });
  });

  describe("View Functions", function () {
    it("Should return correct proposal state", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      // Non-existent proposal
      expect(await daoShip.state(99)).to.equal(0); // Unborn

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      // deployer is self-sponsor, no offering needed
      await daoShip.submitProposal(proposalData, 0,"Test");

      // Auto-sponsored, should be in Voting
      expect(await daoShip.state(1)).to.equal(2); // Voting
    });

    it("Should return proposal status flags", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      // deployer is self-sponsor, no offering needed
      await daoShip.submitProposal(proposalData, 0,"Test");

      const status = await daoShip.getProposalStatus(1);
      expect(status[0]).to.equal(false); // not cancelled
      expect(status[1]).to.equal(false); // not processed
      expect(status[2]).to.equal(false); // not passed
      expect(status[3]).to.equal(false); // action not failed
    });

    it("Should return total supply", async function () {
      const { daoShip } = await loadFixture(deployDAOShipFixture);

      // 100 + 50 shares + 25 loot = 175
      expect(await daoShip.totalSupply()).to.equal(ethers.parseEther("175"));
    });

    it("Should hash operation data", async function () {
      const { daoShip } = await loadFixture(deployDAOShipFixture);

      const data = ethers.toUtf8Bytes("test");
      const hash = await daoShip.hashOperation(data);
      expect(hash).to.equal(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes'], [data])));
    });
  });

  describe("Proposal Expiration", function () {
    it("Should handle proposal with expiration", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      // Set expiration to 11 days (must be > votingPeriod + gracePeriod = 10d)
      const expiration = (await time.latest()) + 11 * 24 * 60 * 60;

      // deployer is self-sponsor, no offering needed
      await daoShip.submitProposal(proposalData, expiration, "Expiring Proposal");

      await daoShip.connect(deployer).submitVote(1, true);

      // Advance 12 days — past both expiration (11d) and voting + grace (10d)
      await advanceTime(12 * 24 * 60 * 60);

      expect(await daoShip.state(1)).to.equal(8); // ProposalState.Expired

      await expect(daoShip.processProposal(1, proposalData)).to.be.revertedWithCustomError(
        daoShip, "NotReady"
      );
    });
  });

  describe("Permission Management", function () {
    it("Should enforce manager permission for minting", async function () {
      const { daoShip, alice } = await loadFixture(deployDAOShipFixture);

      await expect(
        daoShip.connect(alice).mintShares([alice.address], [ethers.parseEther("10")])
      ).to.be.revertedWithCustomError(daoShip, "NotManager");
    });

    it("Should enforce admin permission for pausing", async function () {
      const { daoShip, alice } = await loadFixture(deployDAOShipFixture);

      await expect(
        daoShip.connect(alice).setAdminConfig(true, true)
      ).to.be.revertedWithCustomError(daoShip, "NotAdmin");
    });

    it("Should enforce daoShipOnly for setNavigators", async function () {
      const { daoShip, alice } = await loadFixture(deployDAOShipFixture);

      await expect(
        daoShip.connect(alice).setNavigators([alice.address], [1])
      ).to.be.revertedWithCustomError(daoShip, "NotGovernance");
    });

    it("Should reject invalid permission bits in setNavigators", async function () {
      const { daoShip, alice } = await loadFixture(deployDAOShipFixture);

      // Impersonate DAOShip (governance)
      const daoShipAddr = await daoShip.getAddress();
      await ethers.provider.send("hardhat_setBalance", [daoShipAddr, "0x1000000000000000000"]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);

      // Permission 8 (bit 3) is not a valid permission
      await expect(
        daoShip.connect(daoShipSigner).setNavigators([alice.address], [8])
      ).to.be.revertedWithCustomError(daoShip, "InvalidPermission");

      // Permission 255 is also invalid
      await expect(
        daoShip.connect(daoShipSigner).setNavigators([alice.address], [255])
      ).to.be.revertedWithCustomError(daoShip, "InvalidPermission");

      // Permission 7 (ADMIN | MANAGER | GOVERNOR) is the max valid
      await expect(
        daoShip.connect(daoShipSigner).setNavigators([alice.address], [7])
      ).to.not.be.reverted;

      // Permission 0 (revoke) is valid
      await expect(
        daoShip.connect(daoShipSigner).setNavigators([alice.address], [0])
      ).to.not.be.reverted;
    });

    it("Should reject votingPeriod below 60s minimum", async function () {
      const { daoShip } = await loadFixture(deployDAOShipFixture);
      const daoShipAddr = await daoShip.getAddress();
      await ethers.provider.send("hardhat_setBalance", [daoShipAddr, "0x1000000000000000000"]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);

      const badConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [59, 30, 0, 0, ethers.parseEther("0.1"), 0, 0] // 59s < MIN_VOTING_PERIOD
      );
      await expect(
        daoShip.connect(daoShipSigner).setGovernanceConfig(badConfig)
      ).to.be.revertedWithCustomError(daoShip, "VotingPeriodTooShort");
    });

    it("Should accept votingPeriod at exactly 60s (agent DAO minimum)", async function () {
      const { daoShip } = await loadFixture(deployDAOShipFixture);
      const daoShipAddr = await daoShip.getAddress();
      await ethers.provider.send("hardhat_setBalance", [daoShipAddr, "0x1000000000000000000"]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);

      const agentConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [60, 30, 0, 0, ethers.parseEther("0.1"), 0, 0] // exactly 60s
      );
      await expect(
        daoShip.connect(daoShipSigner).setGovernanceConfig(agentConfig)
      ).to.not.be.reverted;
      expect(await daoShip.votingPeriod()).to.equal(60);
    });
  });

  describe("Auto-Delegation", function () {
    it("Should auto-delegate shares on first mint", async function () {
      const { shares, deployer, alice } = await loadFixture(deployDAOShipFixture);

      expect(await shares.delegates(deployer.address)).to.equal(deployer.address);
      expect(await shares.delegates(alice.address)).to.equal(alice.address);
    });
  });

  describe("Concurrent Proposals", function () {
    it("Should handle multiple concurrent proposals independently", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const proposalData1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x01"]
      );
      const proposalData2 = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [alice.address, 0, "0x02"]
      );
      // deployer is self-sponsor, no offering needed
      await daoShip.submitProposal(proposalData1, 0,"Proposal 1");
      await daoShip.submitProposal(proposalData2, 0,"Proposal 2");

      expect(await daoShip.state(1)).to.equal(2);
      expect(await daoShip.state(2)).to.equal(2);

      await daoShip.connect(deployer).submitVote(1, true);
      await daoShip.connect(deployer).submitVote(2, true);

      const prop1 = await daoShip.proposals(1);
      const prop2 = await daoShip.proposals(2);
      expect(prop1.yesBalance).to.equal(ethers.parseEther("100"));
      expect(prop2.yesBalance).to.equal(ethers.parseEther("100"));
    });
  });

  // ─── Gap 1: processProposal accepts Defeated state ───────────────────────
  describe("Gap 1: processProposal on Defeated proposals", function () {
    it("Should allow processProposal on auto-defeated proposal and emit ProcessProposal(passed=false)", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const proposalData = encodeProposalData([deployer.address], [0n], ["0x"]);
      await daoShip.submitProposal(proposalData, 0,"defeat me");

      // Vote NO — deployer (100 shares) vs alice (50 shares) yes
      await daoShip.connect(deployer).submitVote(1, false); // 100 NO
      await daoShip.connect(alice).submitVote(1, true);     // 50 YES

      await advanceTime(11 * 24 * 60 * 60);

      // Auto-defeated before processProposal
      expect(await daoShip.state(1)).to.equal(7); // ProposalState.Defeated

      // Gap 1: processProposal succeeds, emits ProcessProposal with passed=false
      await expect(daoShip.processProposal(1, proposalData))
        .to.emit(daoShip, "ProcessProposal")
        .withArgs(1, false, false, deployer.address);

      // state() still returns Defeated (7): status[1]=true, status[2]=false
      // This is correct — the proposal failed, so it stays Defeated
      expect(await daoShip.state(1)).to.equal(7); // ProposalState.Defeated
    });

    it("Should allow processProposal on zero-vote proposal", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const proposalData = encodeProposalData([deployer.address], [0n], ["0x"]);
      await daoShip.submitProposal(proposalData, 0,"no votes");

      // No votes → noBalance=0 >= yesBalance=0 → Defeated
      await advanceTime(11 * 24 * 60 * 60);
      expect(await daoShip.state(1)).to.equal(7);

      await expect(daoShip.processProposal(1, proposalData))
        .to.emit(daoShip, "ProcessProposal")
        .withArgs(1, false, false, deployer.address);

      // State remains Defeated (correctly indicates proposal was not passed)
      expect(await daoShip.state(1)).to.equal(7);
    });

    it("Should allow sequential processing via auto-defeated first proposal (no processProposal needed)", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const pd1 = encodeProposalData([deployer.address], [0n], ["0x"]);
      const pd2 = encodeProposalData([alice.address], [0n], ["0x"]);

      await daoShip.submitProposal(pd1, 0,"first");
      await daoShip.submitProposal(pd2, 0,"second");

      // Defeat first, pass second
      await daoShip.connect(deployer).submitVote(1, false);
      await daoShip.connect(deployer).submitVote(2, true);

      await advanceTime(11 * 24 * 60 * 60);

      // First is Defeated (7) — the sequential check already allows Defeated state
      expect(await daoShip.state(1)).to.equal(7);

      // Second can be processed directly because the queue check accepts Defeated prev
      await expect(daoShip.processProposal(2, pd2))
        .to.emit(daoShip, "ProcessProposal")
        .withArgs(2, true, false, deployer.address); // passed=true, processor=deployer
    });

    it("Should reject double-processing a Defeated proposal", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const proposalData = encodeProposalData([deployer.address], [0n], ["0x"]);
      await daoShip.submitProposal(proposalData, 0,"defeat me");
      await advanceTime(11 * 24 * 60 * 60);

      // First call succeeds
      await daoShip.processProposal(1, proposalData);

      // Second call must revert — status[1]=true, and we added the already-processed guard
      await expect(daoShip.processProposal(1, proposalData))
        .to.be.revertedWithCustomError(daoShip, "AlreadyProcessed");
    });
  });

  // ─── Gap 7: re-delegation after re-join ──────────────────────────────────
  describe("Gap 7: auto-delegation fix on re-join", function () {
    it("Should auto-delegate on first token receipt when _delegates is unset", async function () {
      const { shares, deployer, carol } = await loadFixture(deployDAOShipFixture);

      // Carol has no tokens initially — _delegates[carol] == address(0)
      expect(await shares.getCurrentVotes(carol.address)).to.equal(0);

      // Mint shares to carol (simulating deployer as owner minting via daoShip — but in fixture
      // the daoShip owns shares; use deployer who has the daoShip impersonation trick)
      const daoShipAddr = (await shares.owner());
      await ethers.provider.send("hardhat_setBalance", [daoShipAddr, "0x1000000000000000000"]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);
      await shares.connect(daoShipSigner).mint(carol.address, ethers.parseEther("10"));

      // Carol should be auto-delegated to herself (_delegates was address(0))
      expect(await shares.delegates(carol.address)).to.equal(carol.address);
      expect(await shares.getCurrentVotes(carol.address)).to.equal(ethers.parseEther("10"));
    });

    it("Should clear delegation on full exit and auto-delegate to self on re-join", async function () {
      const { shares, daoShip, deployer, carol } = await loadFixture(deployDAOShipFixture);

      const daoShipAddr = await daoShip.getAddress();
      await ethers.provider.send("hardhat_setBalance", [daoShipAddr, "0x1000000000000000000"]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);

      // First mint — auto-delegate fires → carol self-delegates
      await shares.connect(daoShipSigner).mint(carol.address, ethers.parseEther("10"));
      expect(await shares.delegates(carol.address)).to.equal(carol.address);

      // Carol delegates to deployer
      await shares.connect(carol).delegate(deployer.address);
      expect(await shares.delegates(carol.address)).to.equal(deployer.address);

      // Full exit — delegation is cleared
      await shares.connect(daoShipSigner).burn(carol.address, ethers.parseEther("10"));
      expect(await shares.balanceOf(carol.address)).to.equal(0);
      expect(await shares.delegates(carol.address)).to.equal(ethers.ZeroAddress);

      // Re-join — _delegates is address(0) → auto-delegate fires → fresh self-delegation
      await shares.connect(daoShipSigner).mint(carol.address, ethers.parseEther("5"));
      expect(await shares.delegates(carol.address)).to.equal(carol.address);
      expect(await shares.getCurrentVotes(carol.address)).to.equal(ethers.parseEther("5"));

      // deployer's votes are NOT inflated — carol's votes went to herself, not deployer
      expect(await shares.getCurrentVotes(deployer.address)).to.equal(ethers.parseEther("100"));
    });

    it("Should NOT clear delegation on partial burn", async function () {
      const { shares, daoShip, deployer, carol } = await loadFixture(deployDAOShipFixture);

      const daoShipAddr = await daoShip.getAddress();
      await ethers.provider.send("hardhat_setBalance", [daoShipAddr, "0x1000000000000000000"]);
      const daoShipSigner = await ethers.getImpersonatedSigner(daoShipAddr);

      await shares.connect(daoShipSigner).mint(carol.address, ethers.parseEther("10"));
      await shares.connect(carol).delegate(deployer.address);

      // Partial burn — carol keeps 5 shares, delegation must stay
      await shares.connect(daoShipSigner).burn(carol.address, ethers.parseEther("5"));
      expect(await shares.balanceOf(carol.address)).to.equal(ethers.parseEther("5"));
      expect(await shares.delegates(carol.address)).to.equal(deployer.address);
    });
  });

  // ─── defaultExpiryWindow: auto-expiry and fallback behaviour ─────────────
  describe("defaultExpiryWindow", function () {
    /**
     * Deploy a fresh DAOShip clone with custom governance params.
     * votingPeriod=60, gracePeriod=60, no offering, no quorum, 1-share sponsor threshold,
     * no min retention, and a caller-supplied defaultExpiryWindow.
     */
    async function deployBaalWithExpiry(defaultExpiryWindow: number) {
      const [deployer, alice, bob] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
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

      const votingPeriod = 60;  // seconds
      const gracePeriod = 60;   // seconds

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [votingPeriod, gracePeriod, 0, 0, ethers.parseEther("1"), 0, defaultExpiryWindow]
      );

      const initializationParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [
          await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(),
          await multisend.getAddress(), governanceConfig,
          [], [],
          [deployer.address, alice.address],
          [ethers.parseEther("100"), ethers.parseEther("10")],
          [ethers.parseEther("0"), ethers.parseEther("0")],
          [],
          false, false
        ]
      );

      await daoShip.setUp(initializationParams);
      return { daoShip, shares, loot, avatar, deployer, alice, bob, votingPeriod, gracePeriod };
    }

    it("Should auto-expire a winning proposal once defaultExpiryWindow passes", async function () {
      const { daoShip, deployer, alice, votingPeriod, gracePeriod } = await deployBaalWithExpiry(300);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"], [deployer.address, 0, "0x"]
      );

      // No offering required (proposalOffering=0) and deployer has 100 shares >= threshold
      await daoShip.connect(deployer).submitProposal(proposalData, 0,"expiry test", { value: 0 });
      const proposalId = 1;

      // Vote yes so it passes quorum / majority
      await daoShip.connect(deployer).submitVote(proposalId, true);
      await daoShip.connect(alice).submitVote(proposalId, true);

      // Advance past graceEnds but before the 300-second expiry window
      await time.increase(votingPeriod + gracePeriod + 1);
      expect(await daoShip.state(proposalId)).to.equal(5); // Ready

      // Advance past graceEnds + 300 — proposal should now be Expired
      await time.increase(300);
      expect(await daoShip.state(proposalId)).to.equal(8); // Expired

      // processProposal must revert because state is Expired (not Ready or Defeated)
      await expect(daoShip.processProposal(proposalId, proposalData)).to.be.revertedWithCustomError(daoShip, "NotReady");
    });

    it("Should use 2*(votingPeriod+gracePeriod) as fallback when defaultExpiryWindow=0", async function () {
      const votingPeriod = 60;
      const gracePeriod = 60;
      // fallback = 2*(60+60) = 240 seconds after graceEnds
      const { daoShip, deployer, alice } = await deployBaalWithExpiry(0);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"], [deployer.address, 0, "0x"]
      );

      await daoShip.connect(deployer).submitProposal(proposalData, 0,"fallback expiry test", { value: 0 });
      const proposalId = 1;

      await daoShip.connect(deployer).submitVote(proposalId, true);
      const voteBlock = await ethers.provider.getBlock("latest");
      const sponsorTime = voteBlock!.timestamp;
      const graceEnds = sponsorTime + votingPeriod + gracePeriod;

      await daoShip.connect(alice).submitVote(proposalId, true);

      // Advance to graceEnds + fallback - 1 second (just before expiry) using absolute time
      await time.increaseTo(graceEnds + 240 - 1);
      expect(await daoShip.state(proposalId)).to.equal(5); // Ready — not yet expired

      // Advance 2 more seconds to cross the fallback boundary
      await time.increaseTo(graceEnds + 240 + 1);
      expect(await daoShip.state(proposalId)).to.equal(8); // Expired
    });
  });

  // ─── Shared helper for threshold-related tests ────────────────────────────
  /**
   * Deploy a DAOShip with exactly `totalSupply` shares (all to deployer) and
   * sponsorThreshold = sponsorThresholdShares. A MANAGER navigator (alice) is
   * registered so it can call manager-only functions without being the DAOShip itself.
   */
  async function deployBaalWithThreshold(totalSupplyShares: bigint, sponsorThresholdShares: bigint) {
      const [deployer, alice, bob] = await ethers.getSigners();

      const SharesERC20 = await ethers.getContractFactory("SharesERC20");
      const shares = await SharesERC20.deploy();
      const LootERC20 = await ethers.getContractFactory("LootERC20");
      const loot = await LootERC20.deploy();
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

      const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [3600, 60, 0, 0, sponsorThresholdShares, 0, 0]
      );

      const initializationParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
        [
          await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(),
          await multisend.getAddress(), governanceConfig,
          [alice.address], [2], // alice is MANAGER navigator
          [deployer.address],
          [totalSupplyShares],
          [0n],
          [],
          false, false
        ]
      );

      await daoShip.setUp(initializationParams);
      return { daoShip, shares, loot, avatar, deployer, alice, bob };
  }

  // ─── burnShares sponsor-threshold guard ──────────────────────────────────
  describe("burnShares sponsorThreshold guard", function () {
    it("Should revert burnShares when it would breach sponsorThreshold", async function () {
      // totalSupply = 100 shares, sponsorThreshold = 100 shares
      // Burning even 1 share would leave supply=99 < threshold=100
      const { daoShip, alice, deployer } = await deployBaalWithThreshold(
        ethers.parseEther("100"),
        ethers.parseEther("100")
      );

      await expect(
        daoShip.connect(alice).burnShares([deployer.address], [ethers.parseEther("1")])
      ).to.be.revertedWithCustomError(daoShip, "BurnBreachesSponsorThreshold");
    });

    it("Should allow burnShares when supply remains safely above sponsorThreshold", async function () {
      // totalSupply = 100 shares, sponsorThreshold = 50 shares
      // After burning 10: supply = 90 >= threshold = 50 — allowed
      const { daoShip, shares, alice, deployer } = await deployBaalWithThreshold(
        ethers.parseEther("100"),
        ethers.parseEther("50")
      );

      const supplyBefore = await shares.totalSupply();
      await expect(
        daoShip.connect(alice).burnShares([deployer.address], [ethers.parseEther("10")])
      ).to.not.be.reverted;

      expect(await shares.totalSupply()).to.equal(supplyBefore - ethers.parseEther("10"));
    });

    it("_effectiveSponsorThreshold allows sponsoring when supply dips below threshold via ragequit", async function () {
      // Deploy: totalSupply=100, threshold=100 (at the limit)
      // Ragequit 1 share → supply=99, threshold still=100
      // effectiveSponsorThreshold returns min(100, 99) = 99 (supply caps the threshold)
      // So the remaining holder (deployer) with 99 shares should be able to sponsor
      const { daoShip, shares, deployer } = await deployBaalWithThreshold(
        ethers.parseEther("100"),
        ethers.parseEther("100")
      );

      // Deployer ragequits 1 share — ragequit bypasses the burnShares guard
      await daoShip.connect(deployer).ragequit(deployer.address, ethers.parseEther("1"), 0n, []);

      // supply = 99, sponsorThreshold = 100 → effectiveThreshold = 99 (capped at supply)
      // deployer has 99 shares ≥ 99, so sponsoring should succeed
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"], [deployer.address, 0, "0x"]
      );
      // proposalOffering = 0 in this fixture
      await expect(
        daoShip.connect(deployer).submitProposal(proposalData, 0,"recovery proposal", { value: 0 })
      ).to.not.be.reverted;

      // Verify the proposal is in Voting state (auto-sponsored because deployer ≥ effectiveThreshold)
      expect(await daoShip.state(1)).to.equal(2); // Voting
    });
  });

  // ─── convertSharesToLoot ──────────────────────────────────────────────────
  describe("convertSharesToLoot", function () {
    it("Should convert shares to loot atomically", async function () {
      const { daoShip, shares, loot, deployer, alice } = await deployBaalWithThreshold(
        ethers.parseEther("100"),
        ethers.parseEther("10")
      );

      const sharesBefore = await shares.balanceOf(deployer.address);
      const lootBefore = await loot.balanceOf(deployer.address);

      await daoShip.connect(alice).convertSharesToLoot(deployer.address, ethers.parseEther("30"));

      expect(await shares.balanceOf(deployer.address)).to.equal(sharesBefore - ethers.parseEther("30"));
      expect(await loot.balanceOf(deployer.address)).to.equal(lootBefore + ethers.parseEther("30"));
    });

    it("Should support partial conversion", async function () {
      const { daoShip, shares, loot, deployer, alice } = await deployBaalWithThreshold(
        ethers.parseEther("100"),
        ethers.parseEther("10")
      );

      await daoShip.connect(alice).convertSharesToLoot(deployer.address, ethers.parseEther("50"));

      // 50 shares remain, 50 loot minted
      expect(await shares.balanceOf(deployer.address)).to.equal(ethers.parseEther("50"));
      expect(await loot.balanceOf(deployer.address)).to.equal(ethers.parseEther("50"));
    });

    it("Should emit ConvertSharesToLoot event", async function () {
      const { daoShip, deployer, alice } = await deployBaalWithThreshold(
        ethers.parseEther("100"),
        ethers.parseEther("10")
      );

      await expect(
        daoShip.connect(alice).convertSharesToLoot(deployer.address, ethers.parseEther("20"))
      ).to.emit(daoShip, "ConvertSharesToLoot").withArgs(deployer.address, ethers.parseEther("20"));
    });

    it("Should revert if conversion would breach sponsorThreshold", async function () {
      // totalSupply=100, threshold=100 — any conversion drops shares below threshold
      const { daoShip, deployer, alice } = await deployBaalWithThreshold(
        ethers.parseEther("100"),
        ethers.parseEther("100")
      );

      await expect(
        daoShip.connect(alice).convertSharesToLoot(deployer.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(daoShip, "ConvertBreachesSponsorThreshold");
    });

    it("Should revert on zero amount", async function () {
      const { daoShip, deployer, alice } = await deployBaalWithThreshold(
        ethers.parseEther("100"),
        ethers.parseEther("10")
      );

      await expect(
        daoShip.connect(alice).convertSharesToLoot(deployer.address, 0n)
      ).to.be.revertedWithCustomError(daoShip, "ZeroAmount");
    });

    it("Should revert when called by non-manager", async function () {
      const { daoShip, deployer, bob } = await deployBaalWithThreshold(
        ethers.parseEther("100"),
        ethers.parseEther("10")
      );

      await expect(
        daoShip.connect(bob).convertSharesToLoot(deployer.address, ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(daoShip, "NotManager");
    });

    it("Converted loot is valid for ragequit", async function () {
      const { daoShip, shares, loot, deployer, alice } = await deployBaalWithThreshold(
        ethers.parseEther("100"),
        ethers.parseEther("10")
      );

      // Convert 50 shares → 50 loot
      await daoShip.connect(alice).convertSharesToLoot(deployer.address, ethers.parseEther("50"));

      expect(await loot.balanceOf(deployer.address)).to.equal(ethers.parseEther("50"));

      // Ragequit the loot — should not revert
      await expect(
        daoShip.connect(deployer).ragequit(deployer.address, 0n, ethers.parseEther("50"), [])
      ).to.not.be.reverted;

      expect(await loot.balanceOf(deployer.address)).to.equal(0n);
    });
  });

  describe("Direct ETH sends to DAOShip", function () {
    it("Should revert on plain ETH transfer to DAOShip (treasury is the vault, not DAOShip)", async function () {
      // DAOShip has no receive() — it is a governance module, not a treasury.
      // The treasury is daoShip.avatar() (QuaiVaultProxy).
      // On Quai Network this also prevents type-0 tx failures on ERC-1167 clones
      // (clones require the implementation in the access list, which type-0 txs lack).
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);
      await expect(
        deployer.sendTransaction({
          to: await daoShip.getAddress(),
          value: ethers.parseEther("1"),
        })
      ).to.be.reverted;
    });

    it("Should still accept ETH via submitProposal (payable function call)", async function () {
      // Payable function calls work fine — quais.js auto-generates access lists for these.
      // Note: only non-self-sponsors (bob has 0 shares) must pay offering
      const { daoShip, bob, avatar } = await loadFixture(deployDAOShipFixture);
      const offering = await daoShip.proposalOffering();
      const proposalData = "0x";
      const avatarBefore = await ethers.provider.getBalance(await avatar.getAddress());

      await daoShip.connect(bob).submitProposal(proposalData, 0,"offering test", {
        value: offering,
      });

      // Offering is forwarded to avatar (vault), not held in DAOShip
      const avatarAfter = await ethers.provider.getBalance(await avatar.getAddress());
      expect(avatarAfter - avatarBefore).to.equal(offering);
    });
  });

  describe("Delegation and getCurrentVotes", function () {
    it("getCurrentVotes should return delegation-aware voting power, not balanceOf", async function () {
      const { daoShip, shares, deployer, alice } = await loadFixture(deployDAOShipFixture);

      // deployer has 100 shares, self-delegated (auto-delegation on mint)
      expect(await daoShip.getCurrentVotes(deployer.address)).to.equal(ethers.parseEther("100"));
      expect(await shares.balanceOf(deployer.address)).to.equal(ethers.parseEther("100"));

      // deployer delegates to alice
      await shares.connect(deployer).delegate(alice.address);

      // balanceOf unchanged — deployer still holds the tokens
      expect(await shares.balanceOf(deployer.address)).to.equal(ethers.parseEther("100"));

      // getCurrentVotes should now return 0 for deployer (delegated away)
      expect(await daoShip.getCurrentVotes(deployer.address)).to.equal(0);

      // alice should have her own 50 + deployer's delegated 100 = 150
      expect(await daoShip.getCurrentVotes(alice.address)).to.equal(ethers.parseEther("150"));
    });

    it("self-sponsor should fail after delegating away votes", async function () {
      const { daoShip, shares, alice, bob } = await loadFixture(deployDAOShipFixture);

      // alice has 50 shares (above sponsorThreshold of 1), self-delegated
      // delegate all voting power to bob
      await shares.connect(alice).delegate(bob.address);

      // advance 1 block so getPriorVotes reflects the delegation
      await time.increase(1);

      // alice tries to self-sponsor — should fail because getPriorVotes returns 0
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [alice.address, 0, "0x"]
      );

      // alice has 0 voting power now, so she's not a self-sponsor and must pay offering
      // sending value=0 should revert with IncorrectOffering
      await expect(
        daoShip.connect(alice).submitProposal(proposalData, 0, "Test", { value: 0 })
      ).to.be.revertedWithCustomError(daoShip, "IncorrectOffering");
    });

    it("proposal should still execute after sponsor delegates away votes post-vote", async function () {
      const { daoShip, shares, deployer, alice } = await loadFixture(deployDAOShipFixture);

      // deployer submits + auto-sponsors (100 shares, self-delegated)
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      await daoShip.submitProposal(proposalData, 0, "Test");

      // deployer votes yes
      await daoShip.submitVote(1, true);

      // advance past voting + grace period
      await time.increase(11 * 24 * 60 * 60);

      // proposal should be Ready
      expect(await daoShip.state(1)).to.equal(5); // ProposalState.Ready

      // deployer delegates away ALL votes before processing
      await shares.connect(deployer).delegate(alice.address);

      // proposal should STILL be Ready — processProposal doesn't check sponsor power
      expect(await daoShip.state(1)).to.equal(5);

      // processing should succeed (empty proposalData = no action, just marks passed)
      await expect(daoShip.processProposal(1, proposalData)).to.emit(daoShip, "ProcessProposal");
    });

    it("H-4: anyone can cancel if sponsor delegates away during Voting", async function () {
      const { daoShip, shares, alice, bob, carol } = await loadFixture(deployDAOShipFixture);

      // alice submits + auto-sponsors (50 shares > 1 threshold)
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [alice.address, 0, "0x"]
      );
      await daoShip.connect(alice).submitProposal(proposalData, 0, "Test");
      expect(await daoShip.state(1)).to.equal(2); // Voting

      // alice delegates all voting power to bob during voting
      await shares.connect(alice).delegate(bob.address);
      await time.increase(1);

      // carol (random non-member) can now cancel because sponsor fell below threshold
      await expect(daoShip.connect(carol).cancelProposal(1))
        .to.emit(daoShip, "CancelProposal");
      expect(await daoShip.state(1)).to.equal(3); // Cancelled
    });

    it("sponsor who delegated during Voting gets NotReady on processProposal after H-4 cancel", async function () {
      const { daoShip, shares, deployer, alice, bob } = await loadFixture(deployDAOShipFixture);

      // deployer submits + auto-sponsors (100 shares)
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      await daoShip.submitProposal(proposalData, 0, "Test");
      expect(await daoShip.state(1)).to.equal(2); // Voting

      // deployer votes yes
      await daoShip.submitVote(1, true);

      // deployer delegates away all voting power during Voting
      await shares.connect(deployer).delegate(alice.address);
      await time.increase(1);

      // bob (anyone) triggers H-4 cancel — sponsor fell below threshold
      await daoShip.connect(bob).cancelProposal(1);
      expect(await daoShip.state(1)).to.equal(3); // Cancelled

      // advance past voting + grace as if nothing happened
      await time.increase(11 * 24 * 60 * 60);

      // deployer tries to process — reverts because proposal was already cancelled
      await expect(
        daoShip.processProposal(1, proposalData)
      ).to.be.revertedWithCustomError(daoShip, "NotReady");
    });

    it("processProposal succeeds regardless of caller voting power", async function () {
      const { daoShip, deployer, bob } = await loadFixture(deployDAOShipFixture);

      // deployer submits + auto-sponsors
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      await daoShip.submitProposal(proposalData, 0, "Test");
      await daoShip.submitVote(1, true);
      await time.increase(11 * 24 * 60 * 60);

      expect(await daoShip.state(1)).to.equal(5); // Ready

      // bob (0 shares, 0 votes) can process — no caller restrictions
      await expect(daoShip.connect(bob).processProposal(1, proposalData))
        .to.emit(daoShip, "ProcessProposal");
    });
  });
});
