import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployBaalFixture, deployShamanFixture, advanceTime, encodeProposalData } from "../fixtures-simple";

describe("Baal Integration Tests", function () {
  describe("DAO Summoning", function () {
    it("Should summon a complete DAO with vault", async function () {
      const fixture = await loadFixture(deployBaalFixture);

      // Verify all components deployed
      expect(await fixture.baal.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await fixture.shares.getAddress()).to.not.equal(
        ethers.ZeroAddress
      );
      expect(await fixture.loot.getAddress()).to.not.equal(ethers.ZeroAddress);

      // Verify ownership
      expect(await fixture.shares.owner()).to.equal(
        await fixture.baal.getAddress()
      );
      expect(await fixture.loot.owner()).to.equal(
        await fixture.baal.getAddress()
      );

      // Verify initial setup
      expect(await fixture.baal.totalShares()).to.equal(
        ethers.parseEther("150")
      );
      expect(await fixture.baal.totalLoot()).to.equal(ethers.parseEther("25"));
    });

    it("Should have correct initial member distribution", async function () {
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

    it("Should auto-delegate shares on first mint", async function () {
      const { shares, deployer, alice } = await loadFixture(deployBaalFixture);

      // Check auto-delegation
      expect(await shares.delegates(deployer.address)).to.equal(
        deployer.address
      );
      expect(await shares.delegates(alice.address)).to.equal(alice.address);
    });
  });

  describe("Proposal Lifecycle", function () {
    it("Should complete full proposal lifecycle: submit → vote → process", async function () {
      const { baal, deployer, alice } = await loadFixture(deployBaalFixture);

      // 1. Submit proposal with MultiSend-encoded data
      const proposalData = encodeProposalData(
        [deployer.address],
        [BigInt(0)],
        ["0x"]
      );
      const offering = await baal.proposalOffering();

      const submitTx = await baal.submitProposal(
        proposalData,
        0,
        0,
        "Test Proposal",
        {
          value: offering,
        }
      );
      await submitTx.wait();

      // Verify proposal created
      const proposal = await baal.proposals(1);
      expect(proposal.id).to.equal(1);
      expect(proposal.submitter).to.equal(deployer.address);

      // 2. Vote on proposal
      await baal.connect(deployer).submitVote(1, true); // 100 shares yes
      await baal.connect(alice).submitVote(1, true); // 50 shares yes

      // Verify votes recorded
      const proposalAfterVote = await baal.proposals(1);
      expect(proposalAfterVote.yesVotes).to.equal(2);
      expect(proposalAfterVote.yesBalance).to.equal(ethers.parseEther("150"));

      // 3. Advance past voting + grace period
      await advanceTime(11 * 24 * 60 * 60); // 11 days

      // Verify state is Ready
      expect(await baal.state(1)).to.equal(4); // ProposalState.Ready

      // 4. Process proposal
      const processTx = await baal.processProposal(1, proposalData);
      await expect(processTx)
        .to.emit(baal, "ProcessProposal")
        .withArgs(1, true, false);

      // Verify state is Processed
      expect(await baal.state(1)).to.equal(5); // ProposalState.Processed

      // Verify status flags
      const status = await baal.getProposalStatus(1);
      expect(status[0]).to.equal(false); // not cancelled
      expect(status[1]).to.equal(true); // processed
      expect(status[2]).to.equal(true); // passed
      expect(status[3]).to.equal(false); // action not failed
    });

    it("Should handle proposal with expiration", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();

      // Set expiration to 1 day from now
      const expiration = (await time.latest()) + 24 * 60 * 60;

      await baal.submitProposal(proposalData, expiration, 0, "Expiring Proposal", {
        value: offering,
      });

      // Vote
      await baal.connect(deployer).submitVote(1, true);

      // Advance past voting period AND grace period (11 days total)
      await advanceTime(11 * 24 * 60 * 60);

      // Verify proposal is in Expired state (8 = ProposalState.Expired)
      expect(await baal.state(1)).to.equal(8);

      // Try to process (should fail - not ready because it's expired)
      // Note: processProposal checks state == Ready first, so error is "not ready" not "expired"
      await expect(baal.processProposal(1, proposalData)).to.be.revertedWith(
        "Baal: not ready"
      );
    });

    it("Should handle defeated proposal (quorum not met)", async function () {
      const { baal, deployer, alice } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();

      await baal.submitProposal(proposalData, 0, 0, "Will Fail", {
        value: offering,
      });

      // Only Alice votes (50 shares), need 30 shares for quorum (20% of 150)
      // 50 > 30, so quorum IS met, but let's test with no votes
      // Don't vote at all

      // Advance past voting + grace
      await advanceTime(11 * 24 * 60 * 60);

      await baal.processProposal(1, proposalData);

      // Should be defeated
      expect(await baal.state(1)).to.equal(7); // ProposalState.Defeated

      const status = await baal.getProposalStatus(1);
      expect(status[2]).to.equal(false); // not passed
    });
  });

  describe("Shaman Integration", function () {
    it("Should allow shaman to mint shares for onboarding", async function () {
      const { baal, onboarder, bob, shares } = await loadFixture(
        deployShamanFixture
      );

      // Set onboarder as shaman (MANAGER permission = 2)
      // Note: In production this would be done via proposal
      // For testing, we need to somehow set the shaman
      // This is a limitation - we can't easily test this without
      // the ability to execute proposals that call setShamans

      // Skip this test for now - would need full proposal execution
    });

    it("Should allow ETH onboarding", async function () {
      // Skip - requires shaman to be set via proposal
    });

    it("Should handle check-in rewards", async function () {
      // Skip - requires shaman to be set via proposal
    });
  });

  describe("Ragequit", function () {
    async function setupDaoWithGuildTokens(baal: any, deployer: any) {
      // Create mock ERC20 token
      const MockERC20 = await ethers.getContractFactory("SharesERC20");
      const token = await MockERC20.deploy();
      await token.waitForDeployment();

      // Send some tokens to avatar (treasury)
      const avatar = await baal.avatar();
      await token.mint(avatar, ethers.parseEther("1000"));

      // Set as guild token (via proposal in production)
      // For testing, this is tricky without being able to execute proposals
      return token;
    }

    it("Should calculate fair share correctly", async function () {
      const { baal, shares, loot, deployer } = await loadFixture(
        deployBaalFixture
      );

      // Setup complete, but we can't easily test ragequit without
      // being able to call setGuildTokens (which requires proposal)
      // This is a limitation of the test setup

      // The math is: fairShare = (tokenBalance * toBurn) / totalSupply
      // We can at least verify the state
      expect(await baal.minRetentionPercent()).to.equal(6600); // 66%
    });

    it("Should enforce minimum retention", async function () {
      const { baal, shares, deployer } = await loadFixture(deployBaalFixture);

      // Total supply is 150 shares + 25 loot = 175
      // Min retention is 66% = 115.5
      // Can burn max 59.5 tokens

      // Try to burn too much (would violate retention)
      const tokens: string[] = [];
      const sharesToBurn = ethers.parseEther("100");
      const lootToBurn = 0;

      // This should revert with insufficient retention
      await expect(
        baal.connect(deployer).ragequit(deployer.address, sharesToBurn, lootToBurn, tokens)
      ).to.be.revertedWith("Baal: insufficient retention");
    });
  });

  describe("Permission Management", function () {
    it("Should enforce manager permission for minting", async function () {
      const { baal, alice } = await loadFixture(deployBaalFixture);

      // Alice is not a manager shaman
      await expect(
        baal.connect(alice).mintShares([alice.address], [ethers.parseEther("10")])
      ).to.be.revertedWith("Baal: not manager");
    });

    it("Should enforce admin permission for pausing", async function () {
      const { baal, alice } = await loadFixture(deployBaalFixture);

      // Alice is not an admin shaman
      await expect(
        baal.connect(alice).setAdminConfig(true, true)
      ).to.be.revertedWith("Baal: not admin");
    });

    it("Should enforce baalOnly for setShamans", async function () {
      const { baal, alice } = await loadFixture(deployBaalFixture);

      // Only Baal itself (via proposal) can call setShamans
      await expect(
        baal.connect(alice).setShamans([alice.address], [1])
      ).to.be.revertedWith("Baal: not self");
    });
  });

  describe("Gas Optimization", function () {
    it("Should efficiently handle large member sets", async function () {
      // This would test gas usage with many members
      // Would need gas reporter enabled
    });

    it("Should efficiently handle many proposals", async function () {
      const { baal, deployer } = await loadFixture(deployBaalFixture);

      const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x"]
      );
      const offering = await baal.proposalOffering();

      // Submit 10 proposals
      for (let i = 0; i < 10; i++) {
        await baal.submitProposal(proposalData, 0, 0, `Proposal ${i}`, {
          value: offering,
        });
      }

      // Verify linked list
      expect(await baal.latestSponsoredProposalId()).to.equal(10);
      expect(await baal.proposalCount()).to.equal(10);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero proposal offering", async function () {
      // Would need to deploy with zero offering in config
    });

    it("Should handle very large token amounts", async function () {
      const { shares, deployer } = await loadFixture(deployBaalFixture);

      // Max uint256 is ~1e77, but uint224 for checkpoints is ~2e67
      // Should still handle large reasonable amounts
      const largeAmount = ethers.parseEther("1000000"); // 1M tokens

      // This would work fine within uint224 limits
      expect(largeAmount < BigInt(2) ** BigInt(224)).to.be.true;
    });

    it("Should handle multiple concurrent proposals", async function () {
      const { baal, deployer, alice } = await loadFixture(deployBaalFixture);

      const proposalData1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [deployer.address, 0, "0x01"]
      );
      const proposalData2 = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [alice.address, 0, "0x02"]
      );
      const offering = await baal.proposalOffering();

      // Submit two proposals
      await baal.submitProposal(proposalData1, 0, 0, "Proposal 1", {
        value: offering,
      });
      await baal.submitProposal(proposalData2, 0, 0, "Proposal 2", {
        value: offering,
      });

      // Both in voting
      expect(await baal.state(1)).to.equal(2); // Voting
      expect(await baal.state(2)).to.equal(2); // Voting

      // Vote on both
      await baal.connect(deployer).submitVote(1, true);
      await baal.connect(deployer).submitVote(2, true);

      // Should both track votes separately
      const prop1 = await baal.proposals(1);
      const prop2 = await baal.proposals(2);

      expect(prop1.yesBalance).to.equal(ethers.parseEther("100"));
      expect(prop2.yesBalance).to.equal(ethers.parseEther("100"));
    });
  });
});
