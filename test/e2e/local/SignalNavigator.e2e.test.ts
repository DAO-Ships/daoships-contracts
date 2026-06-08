import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployDAOShipFixture } from "../../fixtures";

/**
 * E2E (local Hardhat) — SignalNavigator against a real DAOShip.
 *
 * Unlike the unit suite (which drives voting power via setUp mints + transfers), this
 * exercises the integration surface that only a real DAO exposes:
 *   - delegation flowing through DAOShip.getPriorVotes (delegate() re-checkpoints power),
 *   - loot being excluded from voting weight (only shares vote),
 *   - the full poll lifecycle (immediate + scheduled + cancel) alongside a live DAO,
 *   - the indexer events (PollCreated / Voted / PollCancelled).
 *
 * Fixture distribution: deployer = 100 shares; alice = 50 shares + 25 loot; bob/carol = 0.
 */
describe("SignalNavigator E2E (local)", function () {
  const HOUR = 60 * 60;
  const DAY = 24 * HOUR;
  enum Status { Pending, Active, Ended, Cancelled }

  async function deployWithSignal() {
    const base = await loadFixture(deployDAOShipFixture);
    const SignalNavigator = await ethers.getContractFactory("SignalNavigator");
    const signal = await SignalNavigator.deploy(
      await base.daoShip.getAddress(),
      ethers.parseEther("1"), // minSharesToCreatePoll
      HOUR,                   // minDuration
      30 * DAY,               // maxDuration
      30 * DAY,               // maxStartDelay
      "Signal",
      "local e2e"
    );
    await signal.waitForDeployment();
    // No permission grant: SignalNavigator reads voting power and never mutates the DAO.
    expect(await base.daoShip.navigators(await signal.getAddress())).to.equal(0);
    return { ...base, signal };
  }

  it("runs an immediate poll: share-weighted tally, loot excluded, events emitted", async function () {
    const { signal, daoShip, deployer, alice } = await deployWithSignal();

    await expect(signal.connect(deployer).createPoll("ipfs://temp-check", 3, 0, DAY))
      .to.emit(signal, "PollCreated");

    // deployer (100 shares) → option 0
    await expect(signal.connect(deployer).vote(0, 0))
      .to.emit(signal, "Voted")
      .withArgs(0, deployer.address, 0, ethers.parseEther("100"));

    // alice holds 50 shares + 25 loot — her weight must be 50 (loot does NOT vote)
    await expect(signal.connect(alice).vote(0, 1))
      .to.emit(signal, "Voted")
      .withArgs(0, alice.address, 1, ethers.parseEther("50"));

    const results = await signal.getResults(0);
    expect(results[0]).to.equal(ethers.parseEther("100"));
    expect(results[1]).to.equal(ethers.parseEther("50"));
    expect(results[2]).to.equal(0);
    expect(await signal.pollStatus(0)).to.equal(Status.Active);

    // sanity: voting power read through the DAO matches what the poll counted
    expect(await daoShip.getCurrentVotes(alice.address)).to.equal(ethers.parseEther("50"));
  });

  it("reflects delegation: re-snapshotting after delegate() moves the weight", async function () {
    const { signal, shares, deployer, alice } = await deployWithSignal();

    // alice delegates her 50 shares to deployer → deployer 150, alice 0 (live re-checkpoint)
    await shares.connect(alice).delegate(deployer.address);
    await time.increase(2); // let the delegation checkpoint settle strictly before the next snapshot

    await signal.connect(deployer).createPoll("post-delegation", 2, 0, DAY);

    // deployer now votes with the combined 150
    await expect(signal.connect(deployer).vote(0, 0))
      .to.emit(signal, "Voted")
      .withArgs(0, deployer.address, 0, ethers.parseEther("150"));

    // alice delegated everything away → no voting power at the snapshot
    await expect(signal.connect(alice).vote(0, 1)).to.be.revertedWithCustomError(signal, "NoVotingPower");
  });

  it("gates poll creation on real DAO voting power", async function () {
    const { signal, bob } = await deployWithSignal();
    // bob holds 0 shares; minSharesToCreatePoll = 1
    await expect(signal.connect(bob).createPoll("q", 2, 0, DAY)).to.be.revertedWithCustomError(
      signal,
      "InsufficientShares"
    );
  });

  it("schedules a poll and lets the avatar cancel it before it opens", async function () {
    const { signal, daoShip, avatar, deployer } = await deployWithSignal();

    const start = (await time.latest()) + 7 * DAY;
    await signal.connect(deployer).createPoll("scheduled", 2, start, DAY);
    expect(await signal.pollStatus(0)).to.equal(Status.Pending);

    // avatar (the DAO treasury/Safe) moderates: cancel before voting opens
    await ethers.provider.send("hardhat_setBalance", [await avatar.getAddress(), "0x21e19e0c9bab2400000"]);
    const avatarSigner = await ethers.getImpersonatedSigner(await avatar.getAddress());
    await expect(signal.connect(avatarSigner).cancelPoll(0))
      .to.emit(signal, "PollCancelled")
      .withArgs(0, await avatar.getAddress());
    expect(await signal.pollStatus(0)).to.equal(Status.Cancelled);
    expect(await daoShip.avatar()).to.equal(await avatar.getAddress());
  });

  it("scheduled poll opens and tallies at start", async function () {
    const { signal, deployer } = await deployWithSignal();
    const start = (await time.latest()) + 2 * DAY;
    await signal.connect(deployer).createPoll("opens-later", 2, start, HOUR);

    await time.increaseTo(start);
    expect(await signal.pollStatus(0)).to.equal(Status.Active);
    await signal.connect(deployer).vote(0, 1);
    expect((await signal.getResults(0))[1]).to.equal(ethers.parseEther("100"));
  });
});
