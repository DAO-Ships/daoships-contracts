import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployDAOShipFixture, encodeProposalData } from "../../fixtures";

const DAY = 24 * 60 * 60;
const PERIOD = 30 * DAY;
const GRACE = 7 * DAY;
const NATIVE = ethers.ZeroAddress;
const E = (n: string | number) => ethers.parseEther(String(n));

/**
 * E2E: SubscriptionNavigator against a real DAOShip + vault, driven through the actual
 * proposal lifecycle. Demonstrates the full recurring-dues flow:
 *   - a governance proposal REGISTERING the navigator with MANAGER (2) via setNavigators
 *     (the standard permissioned path — NOT a vault module),
 *   - members pull-paying dues in both an ERC20 and native QUAI, forwarded to the vault,
 *   - a governance proposal ENROLLING a member (arrives as msg.sender == avatar),
 *   - a member lapsing past grace and a permissionless keeper COLLECTING them — shares
 *     converted to loot (or burned), with the keeper reward minted — exercising the live
 *     MANAGER permission against the real DAOShip burn/convert/mint primitives.
 */
describe("SubscriptionNavigator E2E", function () {
  async function runProposal(daoShip: any, deployer: any, alice: any, targets: string[], datas: string[], desc: string) {
    const proposalData = encodeProposalData(targets, targets.map(() => 0n), datas);
    await daoShip.connect(deployer).submitProposal(proposalData, 0, desc);
    const proposalId = await daoShip.proposalCount();
    await daoShip.connect(deployer).submitVote(proposalId, true);
    await daoShip.connect(alice).submitVote(proposalId, true);
    await time.increase(10 * DAY + 1); // votingPeriod (7d) + gracePeriod (3d)
    return daoShip.processProposal(proposalId, proposalData);
  }

  async function setup(burnOnCollect = false) {
    const fx = await loadFixture(deployDAOShipFixture);
    const { daoShip, deployer, alice, carol } = fx;

    // A fee token, funded to the payers.
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const feeToken = await MockERC20.deploy("USDX", "USDX");
    await feeToken.waitForDeployment();

    const Subscription = await ethers.getContractFactory("SubscriptionNavigator");
    const nav = await Subscription.deploy(
      await daoShip.getAddress(),
      [await feeToken.getAddress(), NATIVE],
      [E(10), E(500)],
      PERIOD,
      GRACE,
      0,
      100, // 1% keeper reward
      burnOnCollect,
      [],
      "Dues",
      "monthly membership"
    );
    await nav.waitForDeployment();

    // Register with MANAGER (2) via a governance proposal. setNavigators is
    // governanceOnly (msg.sender == the DAO itself), so it must route through
    // executeAsGovernance, which performs the self-call during proposal execution.
    const daoShipAddr = await daoShip.getAddress();
    const setNav = daoShip.interface.encodeFunctionData("setNavigators", [[await nav.getAddress()], [2]]);
    const execAsGov = daoShip.interface.encodeFunctionData("executeAsGovernance", [daoShipAddr, 0, setNav]);
    await runProposal(daoShip, deployer, alice, [daoShipAddr], [execAsGov], "Register subscription navigator (MANAGER)");
    expect(await daoShip.navigators(await nav.getAddress())).to.equal(2);

    // Fund + approve payers.
    for (const who of [alice, carol]) {
      await feeToken.mint(who.address, E(1000));
      await feeToken.connect(who).approve(await nav.getAddress(), ethers.MaxUint256);
    }

    return { ...fx, nav, feeToken };
  }

  it("registers via proposal; members pay ERC20 + native; governance enrolls; keeper collects (convert)", async function () {
    const { daoShip, shares, loot, avatar, deployer, alice, bob, carol, nav, feeToken } = await setup();
    const vault = await avatar.getAddress();

    // alice pays dues in ERC20 → forwarded to the vault, she's current.
    const ercBefore = await feeToken.balanceOf(vault);
    await nav.connect(alice).payFee(1, await feeToken.getAddress());
    expect(await feeToken.balanceOf(vault)).to.equal(ercBefore + E(10));
    expect(await nav.isCurrent(alice.address)).to.equal(true);

    // alice tops up a period in native QUAI too (debt model: extends her clock).
    const nativeBefore = await ethers.provider.getBalance(vault);
    await nav.connect(alice).payFee(1, NATIVE, { value: E(500) });
    expect(await ethers.provider.getBalance(vault)).to.equal(nativeBefore + E(500));

    // Governance enrolls bob (who holds no shares yet) — complimentary period.
    const enrollCall = nav.interface.encodeFunctionData("enroll", [bob.address]);
    await runProposal(daoShip, deployer, alice, [await nav.getAddress()], [enrollCall], "Enroll bob");
    expect(await nav.isEnrolled(bob.address)).to.equal(true);
    expect(await nav.isCurrent(bob.address)).to.equal(true);

    // Time passes well past alice's 2 paid periods + grace → delinquent.
    await time.increase(2 * PERIOD + GRACE + 1);
    expect(await nav.isDelinquent(alice.address)).to.equal(true);

    // Permissionless keeper (carol) collects alice: shares → loot, reward minted.
    const aliceShares = await shares.balanceOf(alice.address); // 50
    const aliceLootBefore = await loot.balanceOf(alice.address); // 25 from genesis
    const carolLootBefore = await loot.balanceOf(carol.address);
    await nav.connect(carol).collectFee(alice.address);

    expect(await shares.balanceOf(alice.address)).to.equal(0);
    expect(await loot.balanceOf(alice.address)).to.equal(aliceLootBefore + aliceShares); // economic value preserved
    expect(await loot.balanceOf(carol.address)).to.equal(carolLootBefore + aliceShares / 100n); // 1%
    expect(await nav.isEnrolled(alice.address)).to.equal(false); // un-enrolled
  });

  it("burn mode: keeper collection burns delinquent shares and shrinks supply", async function () {
    const { shares, loot, deployer, alice, carol, nav, feeToken } = await setup(true);

    // deployer (100 shares) self-enrolls by paying, then lapses.
    await feeToken.mint(deployer.address, E(100));
    await feeToken.connect(deployer).approve(await nav.getAddress(), ethers.MaxUint256);
    await nav.connect(deployer).payFee(1, await feeToken.getAddress());

    const supplyBefore = await shares.totalSupply();
    await time.increase(PERIOD + GRACE + 1);
    expect(await nav.isDelinquent(deployer.address)).to.equal(true);

    const carolLootBefore = await loot.balanceOf(carol.address);
    await nav.connect(carol).collectFee(deployer.address);

    expect(await shares.balanceOf(deployer.address)).to.equal(0);
    expect(await loot.balanceOf(deployer.address)).to.equal(0); // burned, not converted
    expect(await shares.totalSupply()).to.equal(supplyBefore - E(100));
    expect(await loot.balanceOf(carol.address)).to.equal(carolLootBefore + E(1)); // 1% of 100
  });
});
