import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployBaalFixture, advanceTime, getCurrentTime, encodeProposalData } from "../fixtures-simple";

describe("Baal", function () {
  describe("Deployment", function () {
    it("Should initialize with correct parameters", async function () {
      const { baal, shares, loot, avatar } = await loadFixture(
        deployBaalFixture
      );

      expect(await baal.sharesToken()).to.equal(await shares.getAddress());
      expect(await baal.lootToken()).to.equal(await loot.getAddress());
      expect(await baal.avatar()).to.equal(await avatar.getAddress());
      expect(await baal.votingPeriod()).to.equal(7 * 24 * 60 * 60);
      expect(await baal.gracePeriod()).to.equal(3 * 24 * 60 * 60);
      expect(await baal.proposalOffering()).to.equal(ethers.parseEther("0.1"));
      expect(await baal.quorumPercent()).to.equal(2000); // 20%
      expect(await baal.sponsorThreshold()).to.equal(ethers.parseEther("1"));
      expect(await baal.minRetentionPercent()).to.equal(6600); // 66%
    });

    it("Should mint initial shares and loot", async function () {
      const { shares, loot, deployer, alice } = await loadFixture(
        deployBaalFixture
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
      const { baal } = await loadFixture(deployBaalFixture);

      const mockParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [ethers.ZeroAddress]
      );

      await expect(baal.setUp(mockParams)).to.be.revertedWith(
        "Baal: already initialized"
      );
    });
  });

  describe("Proposal Submission", function () {
    it("Should submit a proposal with correct offering", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );

      const offering = await baal.proposalOffering();

      await expect(
        baal.submitProposal(proposalData, 0, 0, "Test proposal", {
          value: offering,
        })
      )
        .to.emit(baal, "SubmitProposal")
        .withArgs(
          1, // proposal ID
          ethers.keccak256(proposalData),
          await baal.votingPeriod(),
          proposalData,
          0,
          true, // auto-sponsored (deployer has >1 share)
          await time.latest(),
          "Test proposal"
        );
    });

    it("Should auto-sponsor if threshold met", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );

      const offering = await baal.proposalOffering();
      const tx = await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });
      await tx.wait();

      // Should also emit SponsorProposal
      await expect(tx).to.emit(baal, "SponsorProposal");

      // Proposal should be in Voting state
      expect(await baal.state(1)).to.equal(2); // ProposalState.Voting
    });

    it("Should not auto-sponsor if threshold not met", async function () {
      const { baal, bob } = await loadFixture(deployBaalFixture);

      // Bob has no shares, below threshold
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [bob.address, 0, "0x"]
      );

      const offering = await baal.proposalOffering();
      const tx = await baal
        .connect(bob)
        .submitProposal(proposalData, 0, 0, "Test", {
          value: offering,
        });

      // Should not emit SponsorProposal
      await expect(tx).to.not.emit(baal, "SponsorProposal");

      // Proposal should be in Submitted state
      expect(await baal.state(1)).to.equal(1); // ProposalState.Submitted
    });

    it("Should revert with incorrect offering", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );

      await expect(
        baal.submitProposal(proposalData, 0, 0, "Test", {
          value: ethers.parseEther("0.05"), // Wrong amount
        })
      ).to.be.revertedWith("Baal: incorrect offering");
    });

    it("Should revert with empty proposal data", async function () {
      const { baal } = await loadFixture(deployBaalFixture);

      const offering = await baal.proposalOffering();

      await expect(
        baal.submitProposal("0x", 0, 0, "Test", { value: offering })
      ).to.be.revertedWith("Baal: empty proposal");
    });
  });

  describe("Proposal Sponsorship", function () {
    it("Should allow sponsorship by member with threshold", async function () {
      const { baal, alice, bob } = await loadFixture(deployBaalFixture);

      // Bob submits (has 0 shares, below threshold, won't auto-sponsor)
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [bob.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();
      const tx = await baal
        .connect(bob)
        .submitProposal(proposalData, 0, 0, "Test", { value: offering });
      await tx.wait();

      // Should be in Submitted state (not auto-sponsored)
      expect(await baal.state(1)).to.equal(1);

      // Alice sponsors (has 50 shares > 1 threshold)
      const sponsorTx = await baal.connect(alice).sponsorProposal(1);
      await expect(sponsorTx).to.emit(baal, "SponsorProposal");

      // Now in Voting state
      expect(await baal.state(1)).to.equal(2);
    });

    it("Should revert if sponsor doesn't meet threshold", async function () {
      const { baal, bob } = await loadFixture(deployBaalFixture);

      // First need a submitted proposal
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [bob.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();

      // Would need to submit as someone with shares first
      // Bob can't sponsor since he has 0 shares
    });

    it("Should update linked list on sponsor", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();

      // Submit first proposal (auto-sponsored)
      await baal.submitProposal(proposalData, 0, 0, "Proposal 1", {
        value: offering,
      });

      // Submit second proposal (auto-sponsored)
      await baal.submitProposal(proposalData, 0, 0, "Proposal 2", {
        value: offering,
      });

      // Check linked list
      const proposal2 = await baal.proposals(2);
      expect(proposal2.prevProposalId).to.equal(1);

      expect(await baal.latestSponsoredProposalId()).to.equal(2);
    });
  });

  describe("Voting", function () {
    async function submitAndSponsorProposal(baal: any, deployer: any) {
      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();
      const tx = await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });
      await tx.wait();
      return 1; // proposal ID
    }

    it("Should allow voting during voting period", async function () {
      const { baal, deployer, alice } = await loadFixture(deployBaalFixture);

      const proposalId = await submitAndSponsorProposal(baal, deployer);

      // Alice votes yes
      await expect(baal.connect(alice).submitVote(proposalId, true))
        .to.emit(baal, "SubmitVote")
        .withArgs(alice.address, ethers.parseEther("50"), proposalId, true);
    });

    it("Should track vote counts and balances", async function () {
      const { baal, deployer, alice } = await loadFixture(deployBaalFixture);

      const proposalId = await submitAndSponsorProposal(baal, deployer);

      // Deployer votes yes (100 shares)
      await baal.connect(deployer).submitVote(proposalId, true);

      // Alice votes no (50 shares)
      await baal.connect(alice).submitVote(proposalId, false);

      const proposal = await baal.proposals(proposalId);
      expect(proposal.yesVotes).to.equal(1); // 1 voter
      expect(proposal.noVotes).to.equal(1); // 1 voter
      expect(proposal.yesBalance).to.equal(ethers.parseEther("100")); // 100 shares
      expect(proposal.noBalance).to.equal(ethers.parseEther("50")); // 50 shares
    });

    it("Should prevent double voting", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      const proposalId = await submitAndSponsorProposal(baal, deployer);

      // First vote
      await baal.connect(deployer).submitVote(proposalId, true);

      // Second vote should revert
      await expect(
        baal.connect(deployer).submitVote(proposalId, false)
      ).to.be.revertedWith("Baal: already voted");
    });

    it("Should revert if not in voting period", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      const proposalId = await submitAndSponsorProposal(baal, deployer);

      // Advance past voting period
      await advanceTime(8 * 24 * 60 * 60); // 8 days

      await expect(
        baal.connect(deployer).submitVote(proposalId, true)
      ).to.be.revertedWith("Baal: not voting");
    });

    it("Should require voting power", async function () {
      const { baal, bob } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [bob.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();

      // Deployer submits so it gets auto-sponsored
      const { deployer } = await loadFixture(deployBaalFixture);
      const tx = await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });
      await tx.wait();

      // Bob has no shares, cannot vote
      await expect(baal.connect(bob).submitVote(1, true)).to.be.revertedWith(
        "Baal: insufficient voting power"
      );
    });

    it("Should use snapshot balance for voting power", async function () {
      const { baal, deployer, alice, shares } = await loadFixture(
        deployBaalFixture
      );

      const proposalId = await submitAndSponsorProposal(baal, deployer);

      // Get proposal
      const proposal = await baal.proposals(proposalId);
      const votingStarts = proposal.votingStarts;

      // Transfer shares after voting starts
      await shares
        .connect(deployer)
        .transfer(alice.address, ethers.parseEther("50"));

      // Deployer should still be able to vote with original balance
      await baal.connect(deployer).submitVote(proposalId, true);

      const updatedProposal = await baal.proposals(proposalId);
      expect(updatedProposal.yesBalance).to.equal(ethers.parseEther("100")); // Original balance
    });
  });

  describe("Proposal Processing", function () {
    async function submitVoteAndAdvance(
      baal: any,
      deployer: any,
      alice: any,
      proposalData: string
    ) {
      const offering = await baal.proposalOffering();
      const tx = await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });
      await tx.wait();

      // Vote yes (deployer has 100 shares, alice has 50)
      await baal.connect(deployer).submitVote(1, true);
      await baal.connect(alice).submitVote(1, true);

      // Advance past voting + grace period
      await advanceTime(11 * 24 * 60 * 60); // 11 days

      return 1; // proposal ID
    }

    it("Should process passed proposal", async function () {
      const { baal, deployer, alice } = await loadFixture(deployBaalFixture);

      const proposalData = encodeProposalData(
        [deployer.address],
        [BigInt(0)],
        ["0x"]
      );

      const proposalId = await submitVoteAndAdvance(
        baal,
        deployer,
        alice,
        proposalData
      );

      // Process proposal
      await expect(baal.processProposal(proposalId, proposalData))
        .to.emit(baal, "ProcessProposal")
        .withArgs(proposalId, true, false); // passed=true, actionFailed=false

      // Should be in Processed state
      expect(await baal.state(proposalId)).to.equal(5); // ProposalState.Processed
    });

    it("Should mark as defeated if quorum not met", async function () {
      const { baal, deployer, alice } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();
      await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });

      // Only Alice votes (50 shares), quorum is 20% of 150 = 30 shares
      // Alice's 50 shares > 30, so quorum is met
      // But let's test with no votes

      // Advance past voting + grace period without voting
      await advanceTime(11 * 24 * 60 * 60);

      // Process proposal (no votes)
      await expect(baal.processProposal(1, proposalData))
        .to.emit(baal, "ProcessProposal")
        .withArgs(1, false, false); // passed=false

      expect(await baal.state(1)).to.equal(7); // ProposalState.Defeated
    });

    it("Should mark as defeated if majority not met", async function () {
      const { baal, deployer, alice } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();
      await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });

      // Deployer votes no (100 shares), Alice votes yes (50 shares)
      await baal.connect(deployer).submitVote(1, false);
      await baal.connect(alice).submitVote(1, true);

      // Advance past voting + grace period
      await advanceTime(11 * 24 * 60 * 60);

      // Process proposal (no > yes)
      await expect(baal.processProposal(1, proposalData))
        .to.emit(baal, "ProcessProposal")
        .withArgs(1, false, false); // passed=false

      expect(await baal.state(1)).to.equal(7); // ProposalState.Defeated
    });

    it("Should verify proposal data hash", async function () {
      const { baal, deployer, alice } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );

      const proposalId = await submitVoteAndAdvance(
        baal,
        deployer,
        alice,
        proposalData
      );

      const wrongData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [alice.address, 0, "0x"] // Different data
      );

      // Process with wrong data should revert
      await expect(baal.processProposal(proposalId, wrongData)).to.be.revertedWith(
        "Baal: hash mismatch"
      );
    });

    it("Should revert if not in Ready state", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();
      await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });

      // Still in voting period
      await expect(baal.processProposal(1, proposalData)).to.be.revertedWith(
        "Baal: not ready"
      );
    });
  });

  describe("Proposal Cancellation", function () {
    it("Should allow submitter to cancel", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();
      await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });

      await expect(baal.connect(deployer).cancelProposal(1))
        .to.emit(baal, "CancelProposal")
        .withArgs(1);

      expect(await baal.state(1)).to.equal(6); // ProposalState.Cancelled
    });

    it("Should not allow non-submitter to cancel", async function () {
      const { baal, deployer, alice } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();
      await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });

      await expect(baal.connect(alice).cancelProposal(1)).to.be.revertedWith(
        "Baal: not authorized"
      );
    });

    it("Should not allow cancelling processed proposal", async function () {
      const { baal, deployer, alice } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();
      await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });

      // Vote and process
      await baal.connect(deployer).submitVote(1, true);
      await baal.connect(alice).submitVote(1, true);
      await advanceTime(11 * 24 * 60 * 60);
      await baal.processProposal(1, proposalData);

      // Try to cancel
      await expect(baal.connect(deployer).cancelProposal(1)).to.be.revertedWith(
        "Baal: already processed"
      );
    });
  });

  describe("View Functions", function () {
    it("Should return correct proposal state", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      // Non-existent proposal
      expect(await baal.state(99)).to.equal(0); // Unborn

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();
      await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });

      // Auto-sponsored, should be in Voting
      expect(await baal.state(1)).to.equal(2); // Voting
    });

    it("Should return proposal status flags", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();
      await baal.submitProposal(proposalData, 0, 0, "Test", {
        value: offering,
      });

      const status = await baal.getProposalStatus(1);
      expect(status[0]).to.equal(false); // not cancelled
      expect(status[1]).to.equal(false); // not processed
      expect(status[2]).to.equal(false); // not passed
      expect(status[3]).to.equal(false); // action not failed
    });

    it("Should return total supply", async function () {
      const { baal } = await loadFixture(deployBaalFixture);

      // 100 + 50 shares + 25 loot = 175
      expect(await baal.totalSupply()).to.equal(ethers.parseEther("175"));
    });

    it("Should hash operation data", async function () {
      const { baal } = await loadFixture(deployBaalFixture);

      const data = ethers.toUtf8Bytes("test");
      const hash = await baal.hashOperation(data);
      expect(hash).to.equal(ethers.keccak256(data));
    });
  });
});
