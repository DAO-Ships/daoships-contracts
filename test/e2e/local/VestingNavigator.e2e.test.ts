import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployDAOShipFixture, encodeProposalData } from "../../fixtures";

const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;
const E = (n: string | number) => ethers.parseEther(String(n));

/**
 * E2E: VestingNavigator against a real DAOShip, driven through the actual proposal
 * lifecycle. Demonstrates:
 *   - registering the navigator as MANAGER via governance,
 *   - a passed proposal creating a vesting schedule (arrives as msg.sender == avatar),
 *   - claim() minting real shares incrementally, conferring live voting power
 *     (auto-self-delegation), and
 *   - revoke() (via proposal) freezing accrual.
 */
describe("VestingNavigator E2E", function () {
  async function runProposal(daoShip: any, deployer: any, alice: any, targets: string[], datas: string[], desc: string) {
    const proposalData = encodeProposalData(targets, targets.map(() => 0n), datas);
    await daoShip.connect(deployer).submitProposal(proposalData, 0, desc);
    const proposalId = await daoShip.proposalCount();
    await daoShip.connect(deployer).submitVote(proposalId, true);
    await daoShip.connect(alice).submitVote(proposalId, true);
    await time.increase(10 * DAY + 1); // votingPeriod (7d) + gracePeriod (3d)
    return daoShip.processProposal(proposalId, proposalData);
  }

  async function setup() {
    const fx = await loadFixture(deployDAOShipFixture);
    const { daoShip, deployer, alice } = fx;

    const VestingNavigator = await ethers.getContractFactory("VestingNavigator");
    const vesting = await VestingNavigator.deploy(await daoShip.getAddress(), "Vesting", "contributor vesting");
    await vesting.waitForDeployment();

    // Register as MANAGER (2) via governance.
    const setNav = daoShip.interface.encodeFunctionData("setNavigators", [[await vesting.getAddress()], [2]]);
    const wrap = daoShip.interface.encodeFunctionData("executeAsGovernance", [await daoShip.getAddress(), 0, setNav]);
    await runProposal(daoShip, deployer, alice, [await daoShip.getAddress()], [wrap], "Register vesting as MANAGER");
    expect(await daoShip.navigators(await vesting.getAddress())).to.equal(2);

    return { ...fx, vesting };
  }

  it("creates a schedule via proposal; claim mints vested shares with live voting power", async function () {
    const { daoShip, deployer, alice, bob, shares, vesting, avatar } = await setup();

    // Schedule for bob: 400 shares, 1y cliff, 4y linear. Created by the avatar via proposal.
    const start = await time.latest();
    const createCall = vesting.interface.encodeFunctionData("createSchedule", [bob.address, E(400), start, YEAR, 4 * YEAR, false]);
    const tx = await runProposal(daoShip, deployer, alice, [await vesting.getAddress()], [createCall], "Create vesting schedule");
    const rc = await tx.wait();

    const created = rc!.logs.map((l: any) => { try { return vesting.interface.parseLog(l); } catch { return null; } }).find((p: any) => p?.name === "ScheduleCreated");
    expect(created).to.not.be.undefined;
    expect(created!.args.beneficiary).to.equal(bob.address);

    const bobBefore = await shares.balanceOf(bob.address);

    // Before cliff: nothing claimable.
    expect(await vesting.claimable(0)).to.equal(0);

    // At the 1-year cliff (exact), bob claims 25% = 100 shares.
    await time.setNextBlockTimestamp(start + YEAR);
    await vesting.connect(bob).claim(0);
    expect(await shares.balanceOf(bob.address)).to.equal(bobBefore + E(100));

    // Vested shares confer live voting power (auto self-delegated on first mint).
    await time.increase(1); // let the checkpoint settle into the past
    const now = await time.latest();
    expect(await daoShip.getPriorVotes(bob.address, now - 1)).to.equal(bobBefore + E(100));
  });

  it("revoke via proposal freezes accrual at the revocation time", async function () {
    const { daoShip, deployer, alice, bob, shares, vesting } = await setup();

    const start = await time.latest();
    const createCall = vesting.interface.encodeFunctionData("createSchedule", [bob.address, E(400), start, 0, 4 * YEAR, false]);
    await runProposal(daoShip, deployer, alice, [await vesting.getAddress()], [createCall], "Create schedule");

    // Move to ~50% then revoke via proposal. Processing happens ~10d after submit,
    // so compute the revoke time from when it actually lands rather than asserting an exact %.
    await time.increaseTo(start + 2 * YEAR);
    const revokeCall = vesting.interface.encodeFunctionData("revoke", [0]);
    await runProposal(daoShip, deployer, alice, [await vesting.getAddress()], [revokeCall], "Revoke schedule");

    const frozen = await vesting.vested(0);
    expect(frozen).to.be.greaterThan(E(200)); // ~50%+ (proposal lands ~10d past 2y)
    expect(frozen).to.be.lessThan(E(220));

    // Far future: accrual stays frozen at the revoke point.
    await time.increase(4 * YEAR);
    expect(await vesting.vested(0)).to.equal(frozen);

    await vesting.connect(bob).claim(0);
    expect(await shares.balanceOf(bob.address)).to.equal(frozen);
    await expect(vesting.connect(bob).claim(0)).to.be.revertedWithCustomError(vesting, "NothingToClaim");
  });
});
