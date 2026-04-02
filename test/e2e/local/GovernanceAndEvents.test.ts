import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployDAOShipFixture, deployNavigatorFixture, encodeProposalData } from "../../fixtures";

/**
 * E2E Tests for Governance Management and Navigator Events
 *
 * Tests governance configuration functions and their events:
 * - SetGuildTokens, NavigatorSet, GovernanceConfigSet
 * - LockAdmin, LockManager, LockGovernor
 * - BurnShares, BurnLoot permissions
 * - MintLoot event (navigator loot onboarding)
 */
describe("Governance & Events E2E", function () {

  // Helper: submit proposal via executeAsDAOShip, vote, advance, process
  async function executeGovernanceProposal(
    daoShip: any, deployer: any, alice: any,
    innerCalldata: string, description: string
  ) {
    const executeAsBaalData = daoShip.interface.encodeFunctionData("executeAsGovernance", [
      await daoShip.getAddress(), 0, innerCalldata
    ]);

    const proposalData = encodeProposalData(
      [await daoShip.getAddress()], [0n], [executeAsBaalData]
    );

    // deployer is a self-sponsor (shares >= sponsorThreshold), no offering required
    await daoShip.connect(deployer).submitProposal(proposalData, 0, description);

    const proposalId = await daoShip.proposalCount();
    await daoShip.connect(deployer).submitVote(proposalId, true);
    if (alice) await daoShip.connect(alice).submitVote(proposalId, true);

    await time.increase(10 * 24 * 60 * 60 + 1);

    const tx = await daoShip.processProposal(proposalId, proposalData);
    return tx;
  }

  describe("Guild Token Management", function () {
    it("Should set guild tokens via proposal and emit SetGuildTokens event", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const MockERC20 = await ethers.getContractFactory("SharesERC20");
      const mockToken = await MockERC20.deploy();

      const innerCalldata = daoShip.interface.encodeFunctionData("setGuildTokens", [
        [await mockToken.getAddress(), ethers.ZeroAddress], [true, true]
      ]);

      const tx = await executeGovernanceProposal(daoShip, deployer, alice, innerCalldata, "Enable Guild Tokens");
      const receipt = await tx.wait();

      const event = receipt!.logs.find((log: any) => {
        try { return daoShip.interface.parseLog(log)?.name === "SetGuildTokens"; } catch { return false; }
      });
      expect(event).to.not.be.undefined;

      const parsed = daoShip.interface.parseLog(event!);
      expect(parsed!.args[0]).to.deep.equal([await mockToken.getAddress(), ethers.ZeroAddress]);
      expect(parsed!.args[1]).to.deep.equal([true, true]);
    });
  });

  describe("Navigator Management", function () {
    it("Should set navigators via proposal and emit NavigatorSet event", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const OnboarderNavigator = await ethers.getContractFactory("OnboarderNavigator");
      const newNavigator = await OnboarderNavigator.deploy(
        await daoShip.getAddress(),
        20000,  // shareMultiplier: 2x
        0,      // lootMultiplier
        0,      // pricePerUnit: 0 = multiplier mode
        0,      // sharesPerUnit
        0,      // lootPerUnit
        ethers.parseEther("0.01"), // minTribute
        0,      // expiry
        0,      // mintCap
        0,      // perAddressCap (unlimited)
        ethers.ZeroHash, // allowlistRoot: open
        "Test Onboarder", "Test navigator"
      );

      const innerCalldata = daoShip.interface.encodeFunctionData("setNavigators", [
        [await newNavigator.getAddress()], [2]
      ]);

      const tx = await executeGovernanceProposal(daoShip, deployer, alice, innerCalldata, "Add Navigator");
      const receipt = await tx.wait();

      const event = receipt!.logs.find((log: any) => {
        try { return daoShip.interface.parseLog(log)?.name === "NavigatorSet"; } catch { return false; }
      });
      expect(event).to.not.be.undefined;

      const parsed = daoShip.interface.parseLog(event!);
      expect(parsed!.args[0]).to.equal(await newNavigator.getAddress());
      expect(parsed!.args[1]).to.equal(2);

      expect(await daoShip.navigators(await newNavigator.getAddress())).to.equal(2);
    });
  });

  describe("Governance Configuration", function () {
    it("Should update governance config via proposal and emit GovernanceConfigSet event", async function () {
      const { daoShip, deployer, alice } = await loadFixture(deployDAOShipFixture);

      const newConfig = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
        [7200, 1800, ethers.parseEther("0.05"), 3000, ethers.parseEther("5"), 7500, 0]
      );

      const innerCalldata = daoShip.interface.encodeFunctionData("setGovernanceConfig", [newConfig]);

      const tx = await executeGovernanceProposal(daoShip, deployer, alice, innerCalldata, "Update Config");
      const receipt = await tx.wait();

      const event = receipt!.logs.find((log: any) => {
        try { return daoShip.interface.parseLog(log)?.name === "GovernanceConfigSet"; } catch { return false; }
      });
      expect(event).to.not.be.undefined;

      const parsed = daoShip.interface.parseLog(event!);
      expect(parsed!.args[0]).to.equal(7200);
      expect(parsed!.args[1]).to.equal(1800);
      expect(parsed!.args[3]).to.equal(3000);

      expect(await daoShip.votingPeriod()).to.equal(7200);
      expect(await daoShip.gracePeriod()).to.equal(1800);
    });
  });

  describe("Lock Functions", function () {
    it("Should lock admin functions and emit LockAdmin event", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const innerCalldata = daoShip.interface.encodeFunctionData("lockAdmin", []);
      const tx = await executeGovernanceProposal(daoShip, deployer, null, innerCalldata, "Lock Admin");
      const receipt = await tx.wait();

      const event = receipt!.logs.find((log: any) => {
        try { return daoShip.interface.parseLog(log)?.name === "LockAdmin"; } catch { return false; }
      });
      expect(event).to.not.be.undefined;
      expect(await daoShip.adminLock()).to.be.true;
    });

    it("Should lock manager functions and emit LockManager event", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const innerCalldata = daoShip.interface.encodeFunctionData("lockManager", []);
      const tx = await executeGovernanceProposal(daoShip, deployer, null, innerCalldata, "Lock Manager");
      const receipt = await tx.wait();

      const event = receipt!.logs.find((log: any) => {
        try { return daoShip.interface.parseLog(log)?.name === "LockManager"; } catch { return false; }
      });
      expect(event).to.not.be.undefined;
      expect(await daoShip.managerLock()).to.be.true;
    });

    it("Should lock governor functions and emit LockGovernor event", async function () {
      const { daoShip, deployer } = await loadFixture(deployDAOShipFixture);

      const innerCalldata = daoShip.interface.encodeFunctionData("lockGovernor", []);
      const tx = await executeGovernanceProposal(daoShip, deployer, null, innerCalldata, "Lock Governor");
      const receipt = await tx.wait();

      const event = receipt!.logs.find((log: any) => {
        try { return daoShip.interface.parseLog(log)?.name === "LockGovernor"; } catch { return false; }
      });
      expect(event).to.not.be.undefined;
      expect(await daoShip.governorLock()).to.be.true;
    });
  });

  describe("Token Operation Permissions", function () {
    it("Should enforce MANAGER permission for burnShares", async function () {
      const { daoShip, alice } = await loadFixture(deployNavigatorFixture);

      await expect(
        daoShip.connect(alice).burnShares([alice.address], [ethers.parseEther("10")])
      ).to.be.revertedWithCustomError(daoShip, "NotManager");
    });

    it("Should enforce MANAGER permission for burnLoot", async function () {
      const { daoShip, alice } = await loadFixture(deployNavigatorFixture);

      await expect(
        daoShip.connect(alice).burnLoot([alice.address], [ethers.parseEther("5")])
      ).to.be.revertedWithCustomError(daoShip, "NotManager");
    });
  });

  describe("Navigator Events", function () {
    it("Should emit MintLoot event when loot-only navigator onboards member", async function () {
      const { daoShip, loot, bob } = await loadFixture(deployNavigatorFixture);

      // Deploy loot-only onboarder (multiplier mode: no shares, 1x loot)
      const LootOnboarder = await ethers.getContractFactory("OnboarderNavigator");
      const lootOnboarder = await LootOnboarder.deploy(
        await daoShip.getAddress(),
        0,      // shareMultiplier: no shares
        10000,  // lootMultiplier: 1x
        0,      // pricePerUnit: 0 = multiplier mode
        0,      // sharesPerUnit
        0,      // lootPerUnit
        ethers.parseEther("0.01"), // minTribute
        0,      // expiry
        0,      // mintCap
        0,      // perAddressCap (unlimited)
        ethers.ZeroHash, // allowlistRoot: open
        "Loot Onboarder", // name
        "Test loot-only navigator" // description
      );

      // Add as navigator via governance
      const innerCalldata = daoShip.interface.encodeFunctionData("setNavigators", [
        [await lootOnboarder.getAddress()], [2]
      ]);

      const [deployer] = await ethers.getSigners();
      await executeGovernanceProposal(daoShip, deployer, null, innerCalldata, "Add Loot Navigator");

      expect(await daoShip.navigators(await lootOnboarder.getAddress())).to.equal(2);

      // Bob onboards
      const bobLootBefore = await loot.balanceOf(bob.address);
      const tribute = ethers.parseEther("0.5");

      const tx = await lootOnboarder.connect(bob)["onboard()"]({ value: tribute });
      await expect(tx).to.emit(daoShip, "MintLoot").withArgs([bob.address], [tribute]);

      expect(await loot.balanceOf(bob.address)).to.equal(bobLootBefore + tribute);
    });

  });
});
