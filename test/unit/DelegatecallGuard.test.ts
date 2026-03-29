import { ethers } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeProposalData } from "../fixtures";

/**
 * Tests for DAOShip interaction with Quai Vault's per-target DelegateCall whitelist.
 * Verifies that:
 * - DelegateCall to a whitelisted target succeeds (proposal processes correctly)
 * - DelegateCall to a non-whitelisted target reverts with DelegateCallNotAllowed
 * - Adding a target via addDelegatecallTarget then DelegateCall succeeds
 * - Removing a target via removeDelegatecallTarget then DelegateCall fails
 * - Ragequit works regardless of whitelist settings (uses Call, not DelegateCall)
 * - ETH transfers to vault work regardless of whitelist settings
 */
describe("DelegatecallGuard Integration", function () {
  let deployer: any, alice: any;

  // Shared setup: deploy DAOShip with MockDelegatecallGuardAvatar using whitelist-based constructor
  async function deployWithGuard(whitelistMultisend: boolean) {
    [deployer, alice] = await ethers.getSigners();

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

    const MultiSendCallOnly = await ethers.getContractFactory("MultiSendCallOnly");
    const multisendCallOnly = await MultiSendCallOnly.deploy();

    const Poster = await ethers.getContractFactory("Poster");
    const poster = await Poster.deploy();

    // Deploy MockDelegatecallGuardAvatar with whitelist-based constructor
    const MockDelegatecallGuardAvatar = await ethers.getContractFactory("MockDelegatecallGuardAvatar");
    const daoShipAddr = await daoShip.getAddress();
    const multisendAddr = await multisendCallOnly.getAddress();

    const initialModules = [daoShipAddr];
    const initialDelegatecallTargets = whitelistMultisend ? [multisendAddr] : [];

    const avatar = await MockDelegatecallGuardAvatar.deploy(
      initialModules,
      initialDelegatecallTargets
    );

    await shares.transferOwnership(daoShipAddr);
    await loot.transferOwnership(daoShipAddr);

    // Using 3600s/1800s for testing
    const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
      [3600, 1800, 0, 2000, ethers.parseEther("1"), 6600, 0]
    );

    const initializationParams = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
      [
        await loot.getAddress(), await shares.getAddress(), await avatar.getAddress(),
        multisendAddr, governanceConfig,
        [], [], [deployer.address], [ethers.parseEther("100")], [ethers.parseEther("0")], [], false, false
      ]
    );

    await daoShip.setUp(initializationParams);

    return { daoShip, shares, loot, avatar, multisendCallOnly, poster };
  }

  async function submitAndProcessProposal(daoShip: any, multisendCallOnly: any, poster: any) {
    // Create a simple proposal that posts a message
    const proposalData = encodeProposalData(
      [await poster.getAddress()],
      [0n],
      [new ethers.Interface(["function post(string content, string tag)"]).encodeFunctionData("post", ["test", "TAG"])]
    );

    await daoShip.submitProposal(proposalData, 0, "test proposal");
    const proposalId = 1;

    // Deployer has 100 shares >= sponsorThreshold (1 share), so auto-sponsored
    await daoShip.submitVote(proposalId, true);

    // Advance past voting (3600s) + grace (1800s)
    await time.increase(5401);

    return { proposalId, proposalData };
  }

  describe("Whitelisted target (DelegateCall allowed)", function () {
    it("should execute proposals successfully via DelegateCall to whitelisted MultiSendCallOnly", async function () {
      const { daoShip, multisendCallOnly, poster } = await deployWithGuard(true);
      const { proposalId, proposalData } = await submitAndProcessProposal(daoShip, multisendCallOnly, poster);

      await expect(daoShip.processProposal(proposalId, proposalData))
        .to.emit(daoShip, "ProcessProposal")
        .withArgs(proposalId, true, false, deployer.address); // passed=true, actionFailed=false, processor=deployer
    });
  });

  describe("Non-whitelisted target (DelegateCall blocked)", function () {
    it("should fail proposal execution gracefully (actionFailed=true) when MultiSend not whitelisted", async function () {
      const { daoShip, multisendCallOnly, poster } = await deployWithGuard(false);
      const { proposalId, proposalData } = await submitAndProcessProposal(daoShip, multisendCallOnly, poster);

      // processProposal should NOT revert -- it wraps execTransactionFromModule in try/catch
      // But the action should fail because DelegateCall to MultiSendCallOnly is not whitelisted
      await expect(daoShip.processProposal(proposalId, proposalData))
        .to.emit(daoShip, "ProcessProposal")
        .withArgs(proposalId, true, true, deployer.address); // passed=true, actionFailed=true, processor=deployer
    });

    it("should still allow ragequit (uses Call, not DelegateCall)", async function () {
      const { daoShip, shares, avatar } = await deployWithGuard(false);

      // Fund the avatar with ETH for ragequit
      await deployer.sendTransaction({
        to: await avatar.getAddress(),
        value: ethers.parseEther("10"),
      });

      // Ragequit burns shares/loot even without guild tokens to withdraw
      const sharesToBurn = ethers.parseEther("10");
      const lootToBurn = 0n;

      await expect(
        daoShip.ragequit(deployer.address, sharesToBurn, lootToBurn, [])
      ).to.not.be.reverted;
    });

    it("should still allow ETH transfers to vault (navigator tribute)", async function () {
      const { avatar } = await deployWithGuard(false);

      // Direct ETH transfer to avatar (simulates navigator tribute)
      await expect(
        deployer.sendTransaction({
          to: await avatar.getAddress(),
          value: ethers.parseEther("1"),
        })
      ).to.not.be.reverted;
    });
  });

  describe("Adding a DelegateCall target via addDelegatecallTarget", function () {
    it("should allow proposals after whitelisting the target", async function () {
      const { daoShip, multisendCallOnly, poster, avatar } = await deployWithGuard(false);

      // Owner adds MultiSendCallOnly to the whitelist
      await avatar.addDelegatecallTarget(await multisendCallOnly.getAddress());

      const { proposalId, proposalData } = await submitAndProcessProposal(daoShip, multisendCallOnly, poster);

      await expect(daoShip.processProposal(proposalId, proposalData))
        .to.emit(daoShip, "ProcessProposal")
        .withArgs(proposalId, true, false, deployer.address); // passed=true, actionFailed=false, processor=deployer
    });
  });

  describe("Removing a DelegateCall target via removeDelegatecallTarget", function () {
    it("should fail proposals after removing the target from whitelist", async function () {
      const { daoShip, multisendCallOnly, poster, avatar } = await deployWithGuard(true);

      // Owner removes MultiSendCallOnly from the whitelist
      await avatar.removeDelegatecallTarget(await multisendCallOnly.getAddress());

      const { proposalId, proposalData } = await submitAndProcessProposal(daoShip, multisendCallOnly, poster);

      // Action should fail because DelegateCall to MultiSendCallOnly is no longer whitelisted
      await expect(daoShip.processProposal(proposalId, proposalData))
        .to.emit(daoShip, "ProcessProposal")
        .withArgs(proposalId, true, true, deployer.address); // passed=true, actionFailed=true, processor=deployer
    });
  });
});
