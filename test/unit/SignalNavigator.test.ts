import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/** EIP-1167 minimal-proxy clone bytecode for an implementation address */
function cloneBytecode(addr: string) {
  const impl = addr.slice(2).toLowerCase().padStart(40, "0");
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`;
}

async function deployCloneOf(impl: any, factory: any, signer: any) {
  const f = new ethers.ContractFactory([], cloneBytecode(await impl.getAddress()), signer);
  const raw = await f.deploy();
  await raw.waitForDeployment();
  return factory.attach(await raw.getAddress());
}

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

enum Status { Pending, Active, Ended, Cancelled }

interface DeployOpts {
  minSharesToCreatePoll?: bigint;
  minDuration?: number;
  maxDuration?: number;
  maxStartDelay?: number;
  // initial share distribution; defaults give alice/bob/carol weighted voting power
  members?: ("alice" | "bob" | "carol")[];
  shareAmounts?: bigint[];
}

/**
 * Self-contained deployment: a DAOShip clone plus a SignalNavigator. The navigator
 * needs NO permission, so it is not registered on the DAO. Initial shares are minted
 * to members at setUp (auto-self-delegated), giving them snapshot voting power.
 *
 * dave & eve are intentionally left share-less — used as "fresh" accounts for the
 * snapshot-integrity and scheduled lead-window tests (they acquire shares mid-test
 * via transfer to exercise the snapshot boundary).
 */
async function deploySignal(opts: DeployOpts = {}) {
  const [deployer, alice, bob, carol, dave, eve] = await ethers.getSigners();

  const {
    minSharesToCreatePoll = 0n,
    minDuration = HOUR,
    maxDuration = 30 * DAY,
    maxStartDelay = 30 * DAY,
    members = ["alice", "bob", "carol"],
    shareAmounts = [ethers.parseEther("100"), ethers.parseEther("50"), ethers.parseEther("30")],
  } = opts;

  const signerOf: Record<string, any> = { alice, bob, carol };

  const SharesERC20 = await ethers.getContractFactory("SharesERC20");
  const sharesImpl = await SharesERC20.deploy();
  await sharesImpl.waitForDeployment();
  const LootERC20 = await ethers.getContractFactory("LootERC20");
  const lootImpl = await LootERC20.deploy();
  await lootImpl.waitForDeployment();
  const DAOShip = await ethers.getContractFactory("DAOShip");
  const daoImpl = await DAOShip.deploy();
  await daoImpl.waitForDeployment();

  const shares = await deployCloneOf(sharesImpl, SharesERC20, deployer);
  const loot = await deployCloneOf(lootImpl, LootERC20, deployer);
  const daoShip = await deployCloneOf(daoImpl, DAOShip, deployer);

  const MockAvatar = await ethers.getContractFactory("MockAvatar");
  const avatar = await MockAvatar.deploy();
  await avatar.waitForDeployment();
  await avatar.enableModule(await daoShip.getAddress());

  const MultiSendCallOnly = await ethers.getContractFactory("MultiSendCallOnly");
  const multisend = await MultiSendCallOnly.deploy();
  await multisend.waitForDeployment();

  await shares.initialize(await daoShip.getAddress(), "Shares", "SH");
  await loot.initialize(await daoShip.getAddress(), "Loot", "LT");

  const SignalNavigator = await ethers.getContractFactory("SignalNavigator");
  const nav = await SignalNavigator.deploy(
    await daoShip.getAddress(),
    minSharesToCreatePoll,
    minDuration,
    maxDuration,
    maxStartDelay,
    "Signal",
    "temperature checks"
  );
  await nav.waitForDeployment();

  const governanceConfig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
    [7 * DAY, 3 * DAY, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
  );

  const memberAddrs = members.map((m) => signerOf[m].address);
  const lootAmounts = members.map(() => 0n);

  const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
    [
      await loot.getAddress(),
      await shares.getAddress(),
      await avatar.getAddress(),
      await multisend.getAddress(),
      governanceConfig,
      [],          // no navigators — Signal needs no permission
      [],
      memberAddrs,
      shareAmounts,
      lootAmounts,
      [],
      false,
      false,
    ]
  );
  await daoShip.setUp(initParams);

  return { daoShip, shares, loot, avatar, nav, deployer, alice, bob, carol, dave, eve };
}

/** Impersonate the avatar (a contract) so we can call avatar-authorized functions */
async function asAvatar(avatarAddr: string) {
  await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x21e19e0c9bab2400000"]);
  return ethers.getImpersonatedSigner(avatarAddr);
}

describe("SignalNavigator", function () {
  describe("Deployment & configuration", function () {
    it("sets immutable parameters", async function () {
      const { nav, daoShip } = await deploySignal({ minSharesToCreatePoll: ethers.parseEther("5") });
      expect(await nav.navigatorType()).to.equal("SignalNavigator");
      expect(await nav.daoShip()).to.equal(await daoShip.getAddress());
      expect(await nav.minSharesToCreatePoll()).to.equal(ethers.parseEther("5"));
      expect(await nav.minDuration()).to.equal(HOUR);
      expect(await nav.maxDuration()).to.equal(30 * DAY);
      expect(await nav.maxStartDelay()).to.equal(30 * DAY);
      expect(await nav.MIN_OPTIONS()).to.equal(2);
      expect(await nav.MAX_OPTIONS()).to.equal(10);
      expect(await nav.pollCount()).to.equal(0);
    });

    it("emits NavigatorDeployed in constructor", async function () {
      const { daoShip, deployer } = await deploySignal();
      const SignalNavigator = await ethers.getContractFactory("SignalNavigator");
      const nav = await SignalNavigator.deploy(
        await daoShip.getAddress(), 0, HOUR, 30 * DAY, 7 * DAY, "My Signal", "desc"
      );
      await expect(nav.deploymentTransaction())
        .to.emit(nav, "NavigatorDeployed")
        .withArgs(await daoShip.getAddress(), deployer.address, "SignalNavigator", "My Signal", "desc");
    });

    it("reverts when daoShip is the zero address", async function () {
      const SignalNavigator = await ethers.getContractFactory("SignalNavigator");
      await expect(
        SignalNavigator.deploy(ethers.ZeroAddress, 0, HOUR, 30 * DAY, 0, "x", "y")
      ).to.be.revertedWithCustomError(SignalNavigator, "InvalidConfig");
    });

    it("reverts when minDuration is 0", async function () {
      const { daoShip } = await deploySignal();
      const SignalNavigator = await ethers.getContractFactory("SignalNavigator");
      await expect(
        SignalNavigator.deploy(await daoShip.getAddress(), 0, 0, 30 * DAY, 0, "x", "y")
      ).to.be.revertedWithCustomError(SignalNavigator, "InvalidConfig");
    });

    it("reverts when maxDuration < minDuration", async function () {
      const { daoShip } = await deploySignal();
      const SignalNavigator = await ethers.getContractFactory("SignalNavigator");
      await expect(
        SignalNavigator.deploy(await daoShip.getAddress(), 0, 2 * DAY, DAY, 0, "x", "y")
      ).to.be.revertedWithCustomError(SignalNavigator, "InvalidConfig");
    });

    it("reverts when maxDuration or maxStartDelay exceeds MAX_WINDOW", async function () {
      const { daoShip } = await deploySignal();
      const SignalNavigator = await ethers.getContractFactory("SignalNavigator");
      const overWindow = 3650 * DAY + 1; // MAX_WINDOW (3650 days) + 1s
      await expect(
        SignalNavigator.deploy(await daoShip.getAddress(), 0, HOUR, overWindow, 0, "x", "y")
      ).to.be.revertedWithCustomError(SignalNavigator, "InvalidConfig");
      await expect(
        SignalNavigator.deploy(await daoShip.getAddress(), 0, HOUR, 30 * DAY, overWindow, "x", "y")
      ).to.be.revertedWithCustomError(SignalNavigator, "InvalidConfig");
    });
  });

  describe("Poll creation", function () {
    it("creates an immediate poll (startTime=0) that is Active", async function () {
      const { nav, alice } = await deploySignal();
      const tx = await nav.connect(alice).createPoll("ipfs://q", 3, 0, DAY);
      const rc = await tx.wait();
      const blockTs = (await ethers.provider.getBlock(rc!.blockNumber))!.timestamp;

      await expect(tx)
        .to.emit(nav, "PollCreated")
        .withArgs(0, alice.address, "ipfs://q", 3, blockTs - 1, blockTs, blockTs + DAY);

      expect(await nav.pollCount()).to.equal(1);
      expect(await nav.pollStatus(0)).to.equal(Status.Active);

      const p = await nav.polls(0);
      expect(p.creator).to.equal(alice.address);
      expect(p.question).to.equal("ipfs://q");
      expect(p.optionCount).to.equal(3);
      expect(p.snapshotTimestamp).to.equal(blockTs - 1);
      expect(p.votingStarts).to.equal(blockTs);
      expect(p.votingEnds).to.equal(blockTs + DAY);
      expect(p.cancelled).to.equal(false);
    });

    it("creates a scheduled poll that is Pending until its start time", async function () {
      const { nav, alice } = await deploySignal();
      const start = (await time.latest()) + 7 * DAY;
      await nav.connect(alice).createPoll("q", 2, start, DAY);

      expect(await nav.pollStatus(0)).to.equal(Status.Pending);
      const p = await nav.polls(0);
      expect(p.votingStarts).to.equal(start);
      expect(p.snapshotTimestamp).to.equal(start - 1);
      expect(p.votingEnds).to.equal(start + DAY);

      await time.increaseTo(start);
      expect(await nav.pollStatus(0)).to.equal(Status.Active);
    });

    it("reverts InvalidOptionCount below MIN_OPTIONS or above MAX_OPTIONS", async function () {
      const { nav, alice } = await deploySignal();
      await expect(nav.connect(alice).createPoll("q", 1, 0, DAY)).to.be.revertedWithCustomError(nav, "InvalidOptionCount");
      await expect(nav.connect(alice).createPoll("q", 11, 0, DAY)).to.be.revertedWithCustomError(nav, "InvalidOptionCount");
    });

    it("reverts InvalidDuration outside [minDuration, maxDuration]", async function () {
      const { nav, alice } = await deploySignal();
      await expect(nav.connect(alice).createPoll("q", 2, 0, HOUR - 1)).to.be.revertedWithCustomError(nav, "InvalidDuration");
      await expect(nav.connect(alice).createPoll("q", 2, 0, 30 * DAY + 1)).to.be.revertedWithCustomError(nav, "InvalidDuration");
    });

    it("reverts InvalidStartTime for a past start or one beyond maxStartDelay", async function () {
      const { nav, alice } = await deploySignal({ maxStartDelay: 7 * DAY });
      const now = await time.latest();
      await expect(nav.connect(alice).createPoll("q", 2, now - 10, DAY)).to.be.revertedWithCustomError(nav, "InvalidStartTime");
      await expect(nav.connect(alice).createPoll("q", 2, now + 8 * DAY, DAY)).to.be.revertedWithCustomError(nav, "InvalidStartTime");
    });

    it("forbids scheduling entirely when maxStartDelay=0 (immediate-only)", async function () {
      const { nav, alice } = await deploySignal({ maxStartDelay: 0 });
      const now = await time.latest();
      // any explicit future start exceeds delay 0
      await expect(nav.connect(alice).createPoll("q", 2, now + 100, DAY)).to.be.revertedWithCustomError(nav, "InvalidStartTime");
      // startTime=0 still works
      await nav.connect(alice).createPoll("q", 2, 0, DAY);
      expect(await nav.pollStatus(0)).to.equal(Status.Active);
    });

    it("enforces minSharesToCreatePoll against creation-time voting power", async function () {
      const { nav, alice, carol } = await deploySignal({ minSharesToCreatePoll: ethers.parseEther("60") });
      await time.increase(1); // ensure creator's mint checkpoint precedes block.timestamp-1
      // alice holds 100 → ok; carol holds 30 → InsufficientShares
      await nav.connect(alice).createPoll("q", 2, 0, DAY);
      await expect(nav.connect(carol).createPoll("q", 2, 0, DAY)).to.be.revertedWithCustomError(nav, "InsufficientShares");
    });
  });

  describe("Voting", function () {
    it("tallies share-weighted votes across options", async function () {
      const { nav, alice, bob, carol } = await deploySignal();
      await nav.connect(alice).createPoll("q", 3, 0, DAY);

      await expect(nav.connect(alice).vote(0, 0))
        .to.emit(nav, "Voted")
        .withArgs(0, alice.address, 0, ethers.parseEther("100"));
      await nav.connect(bob).vote(0, 1);
      await nav.connect(carol).vote(0, 0);

      const results = await nav.getResults(0);
      expect(results[0]).to.equal(ethers.parseEther("130")); // alice + carol
      expect(results[1]).to.equal(ethers.parseEther("50"));  // bob
      expect(results[2]).to.equal(0);
      expect(await nav.getOptionVotes(0, 0)).to.equal(ethers.parseEther("130"));
      expect(await nav.hasVoted(0, alice.address)).to.equal(true);
      expect(await nav.hasVoted(0, bob.address)).to.equal(true);
    });

    it("reverts PollDoesNotExist for an unknown id", async function () {
      const { nav, alice } = await deploySignal();
      await expect(nav.connect(alice).vote(0, 0)).to.be.revertedWithCustomError(nav, "PollDoesNotExist");
    });

    it("reverts AlreadyVoted on a second vote", async function () {
      const { nav, alice } = await deploySignal();
      await nav.connect(alice).createPoll("q", 2, 0, DAY);
      await nav.connect(alice).vote(0, 0);
      await expect(nav.connect(alice).vote(0, 1)).to.be.revertedWithCustomError(nav, "AlreadyVoted");
    });

    it("reverts InvalidOption for an out-of-range option", async function () {
      const { nav, alice } = await deploySignal();
      await nav.connect(alice).createPoll("q", 3, 0, DAY);
      await expect(nav.connect(alice).vote(0, 3)).to.be.revertedWithCustomError(nav, "InvalidOption");
    });

    it("reverts NoVotingPower for an address with no shares at the snapshot", async function () {
      const { nav, alice, dave } = await deploySignal();
      await nav.connect(alice).createPoll("q", 2, 0, DAY);
      await expect(nav.connect(dave).vote(0, 0)).to.be.revertedWithCustomError(nav, "NoVotingPower");
    });

    it("reverts PollNotStarted before a scheduled poll opens", async function () {
      const { nav, alice } = await deploySignal();
      const start = (await time.latest()) + 2 * DAY;
      await nav.connect(alice).createPoll("q", 2, start, DAY);
      await expect(nav.connect(alice).vote(0, 0)).to.be.revertedWithCustomError(nav, "PollNotStarted");
    });

    it("reverts PollHasEnded after the voting window closes", async function () {
      const { nav, alice } = await deploySignal();
      await nav.connect(alice).createPoll("q", 2, 0, DAY);
      await time.increase(DAY + 1);
      await expect(nav.connect(alice).vote(0, 0)).to.be.revertedWithCustomError(nav, "PollHasEnded");
      expect(await nav.pollStatus(0)).to.equal(Status.Ended);
    });
  });

  describe("Snapshot integrity (snapshot at poll start)", function () {
    it("shares acquired after the snapshot carry no weight; pre-snapshot weight is unaffected by later transfer", async function () {
      const { nav, shares, alice, dave } = await deploySignal();
      // Immediate poll: snapshot = creation - 1. alice's 100 shares are checkpointed at setUp.
      await nav.connect(alice).createPoll("q", 2, 0, DAY);

      // alice moves 100 shares to dave AFTER the snapshot
      await shares.connect(alice).transfer(dave.address, ethers.parseEther("100"));

      // dave received them after the snapshot → no voting power in this poll
      await expect(nav.connect(dave).vote(0, 0)).to.be.revertedWithCustomError(nav, "NoVotingPower");

      // alice still votes with her snapshot weight (100), despite now holding 0
      await expect(nav.connect(alice).vote(0, 1))
        .to.emit(nav, "Voted")
        .withArgs(0, alice.address, 1, ethers.parseEther("100"));
      expect(await shares.balanceOf(alice.address)).to.equal(0);
    });

    it("scheduled poll lead window: shares received before start DO count", async function () {
      const { nav, shares, alice, dave } = await deploySignal();
      const start = (await time.latest()) + 10 * DAY;
      await nav.connect(alice).createPoll("q", 2, start, DAY); // snapshot = start - 1

      // dave acquires shares AFTER creation but BEFORE the snapshot
      await time.increaseTo(start - 100);
      await shares.connect(alice).transfer(dave.address, ethers.parseEther("40"));

      // open voting and confirm dave's freshly-acquired weight counts
      await time.increaseTo(start);
      await expect(nav.connect(dave).vote(0, 0))
        .to.emit(nav, "Voted")
        .withArgs(0, dave.address, 0, ethers.parseEther("40"));
    });
  });

  describe("Cancellation", function () {
    it("creator can cancel before voting opens", async function () {
      const { nav, alice } = await deploySignal();
      const start = (await time.latest()) + 2 * DAY;
      await nav.connect(alice).createPoll("q", 2, start, DAY);
      await expect(nav.connect(alice).cancelPoll(0)).to.emit(nav, "PollCancelled").withArgs(0, alice.address);
      expect(await nav.pollStatus(0)).to.equal(Status.Cancelled);
    });

    it("avatar can cancel before voting opens", async function () {
      const { nav, avatar, alice } = await deploySignal();
      const start = (await time.latest()) + 2 * DAY;
      await nav.connect(alice).createPoll("q", 2, start, DAY);
      const avatarSigner = await asAvatar(await avatar.getAddress());
      await nav.connect(avatarSigner).cancelPoll(0);
      expect(await nav.pollStatus(0)).to.equal(Status.Cancelled);
    });

    it("creator CANNOT cancel once voting has opened; avatar still can", async function () {
      const { nav, avatar, alice } = await deploySignal();
      await nav.connect(alice).createPoll("q", 2, 0, DAY); // active immediately
      await expect(nav.connect(alice).cancelPoll(0)).to.be.revertedWithCustomError(nav, "NotAuthorized");

      const avatarSigner = await asAvatar(await avatar.getAddress());
      await nav.connect(avatarSigner).cancelPoll(0);
      expect(await nav.pollStatus(0)).to.equal(Status.Cancelled);
    });

    it("a non-creator non-avatar cannot cancel", async function () {
      const { nav, alice, bob } = await deploySignal();
      const start = (await time.latest()) + 2 * DAY;
      await nav.connect(alice).createPoll("q", 2, start, DAY);
      await expect(nav.connect(bob).cancelPoll(0)).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });

    it("voting on a cancelled poll reverts PollIsCancelled", async function () {
      const { nav, avatar, alice } = await deploySignal();
      await nav.connect(alice).createPoll("q", 2, 0, DAY); // active immediately
      const avatarSigner = await asAvatar(await avatar.getAddress());
      await nav.connect(avatarSigner).cancelPoll(0);
      await expect(nav.connect(alice).vote(0, 0)).to.be.revertedWithCustomError(nav, "PollIsCancelled");
    });

    it("double cancel reverts PollIsCancelled", async function () {
      const { nav, alice } = await deploySignal();
      const start = (await time.latest()) + 2 * DAY;
      await nav.connect(alice).createPoll("q", 2, start, DAY);
      await nav.connect(alice).cancelPoll(0);
      await expect(nav.connect(alice).cancelPoll(0)).to.be.revertedWithCustomError(nav, "PollIsCancelled");
    });

    it("cancelling an ended poll reverts PollHasEnded", async function () {
      const { nav, alice } = await deploySignal();
      await nav.connect(alice).createPoll("q", 2, 0, DAY);
      await time.increase(DAY + 1);
      await expect(nav.connect(alice).cancelPoll(0)).to.be.revertedWithCustomError(nav, "PollHasEnded");
    });
  });

  describe("Window boundaries (half-open [start, end), matching core)", function () {
    it("accepts a vote at exactly votingStarts (start inclusive, scheduled poll)", async function () {
      const { nav, alice } = await deploySignal();
      const start = (await time.latest()) + 2 * DAY;
      await nav.connect(alice).createPoll("q", 2, start, DAY);
      await time.setNextBlockTimestamp(start);
      await expect(nav.connect(alice).vote(0, 0)).to.emit(nav, "Voted");
    });

    it("accepts a vote at votingEnds-1, rejects at exactly votingEnds (end exclusive)", async function () {
      const { nav, alice, bob } = await deploySignal();
      await nav.connect(alice).createPoll("q", 2, 0, DAY);
      const end = Number((await nav.polls(0)).votingEnds);

      // votingEnds - 1 → last votable instant
      await time.setNextBlockTimestamp(end - 1);
      await expect(nav.connect(alice).vote(0, 0)).to.emit(nav, "Voted");

      // exactly votingEnds → closed (exclusive end, matches DAOShip.castVote)
      await time.setNextBlockTimestamp(end);
      await expect(nav.connect(bob).vote(0, 1)).to.be.revertedWithCustomError(nav, "PollHasEnded");
    });

    it("pollStatus matches vote() at the exact end boundary", async function () {
      const { nav, alice } = await deploySignal();
      await nav.connect(alice).createPoll("q", 2, 0, DAY);
      const end = Number((await nav.polls(0)).votingEnds);

      await time.setNextBlockTimestamp(end - 1);
      await ethers.provider.send("evm_mine", []);
      expect(await nav.pollStatus(0)).to.equal(Status.Active); // Active at votingEnds-1

      await time.setNextBlockTimestamp(end);
      await ethers.provider.send("evm_mine", []);
      expect(await nav.pollStatus(0)).to.equal(Status.Ended); // Ended at exactly votingEnds (exclusive)
    });
  });

  describe("Multiple coexisting polls", function () {
    it("tracks tallies and per-voter status independently across polls", async function () {
      const { nav, alice, bob } = await deploySignal();
      await nav.connect(alice).createPoll("poll-0", 3, 0, DAY);
      await nav.connect(alice).createPoll("poll-1", 2, 0, DAY);
      expect(await nav.pollCount()).to.equal(2);

      await nav.connect(alice).vote(0, 0); // alice → option 0 of poll 0
      await nav.connect(alice).vote(1, 1); // alice → option 1 of poll 1
      await nav.connect(bob).vote(1, 0);   // bob   → option 0 of poll 1 only

      const r0 = await nav.getResults(0);
      const r1 = await nav.getResults(1);
      expect(r0.length).to.equal(3);
      expect(r1.length).to.equal(2);
      expect(r0[0]).to.equal(ethers.parseEther("100")); // alice in poll 0
      expect(r1[1]).to.equal(ethers.parseEther("100")); // alice in poll 1
      expect(r1[0]).to.equal(ethers.parseEther("50"));  // bob in poll 1

      expect(await nav.hasVoted(0, bob.address)).to.equal(false); // bob never voted in poll 0
      expect(await nav.hasVoted(1, bob.address)).to.equal(true);
    });
  });

  describe("View robustness", function () {
    it("all typed views revert PollDoesNotExist for an unknown id", async function () {
      const { nav, alice } = await deploySignal();
      await expect(nav.pollStatus(0)).to.be.revertedWithCustomError(nav, "PollDoesNotExist");
      await expect(nav.getResults(7)).to.be.revertedWithCustomError(nav, "PollDoesNotExist");
      await expect(nav.getOptionVotes(7, 0)).to.be.revertedWithCustomError(nav, "PollDoesNotExist");
      await expect(nav.hasVoted(7, alice.address)).to.be.revertedWithCustomError(nav, "PollDoesNotExist");
    });

    it("getOptionVotes reverts InvalidOption for an out-of-range option", async function () {
      const { nav, alice } = await deploySignal();
      await nav.connect(alice).createPoll("q", 3, 0, DAY);
      await expect(nav.getOptionVotes(0, 3)).to.be.revertedWithCustomError(nav, "InvalidOption");
    });

    it("getResults on a cancelled poll preserves the tally rather than reverting", async function () {
      const { nav, avatar, alice } = await deploySignal();
      await nav.connect(alice).createPoll("q", 2, 0, DAY);
      await nav.connect(alice).vote(0, 0);
      const avatarSigner = await asAvatar(await avatar.getAddress());
      await nav.connect(avatarSigner).cancelPoll(0);

      const r = await nav.getResults(0);
      expect(r.length).to.equal(2);
      expect(r[0]).to.equal(ethers.parseEther("100")); // tally is retained post-cancel
      expect(await nav.pollStatus(0)).to.equal(Status.Cancelled);
    });
  });

  describe("Open creation (minSharesToCreatePoll == 0)", function () {
    it("a share-less account can create a poll but cannot vote in it", async function () {
      const { nav, dave } = await deploySignal(); // default threshold 0
      // dave holds no shares yet can open a poll (creation is ungated at threshold 0)
      await nav.connect(dave).createPoll("q", 2, 0, DAY);
      expect(await nav.pollCount()).to.equal(1);
      // ...but has no voting power at the snapshot, so cannot vote
      await expect(nav.connect(dave).vote(0, 0)).to.be.revertedWithCustomError(nav, "NoVotingPower");
    });
  });
});
