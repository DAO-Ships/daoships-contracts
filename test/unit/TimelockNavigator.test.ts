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

const MINUTE = 60;
const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const MIN_DELAY = 10 * MINUTE; // contract MIN_DELAY (sanity floor)
const MAX_DELAY = 30 * DAY; // contract MAX_DELAY
const MIN_EXPIRY = HOUR; // contract MIN_EXPIRY (1 hour)
const MAX_EXPIRY = 3650 * DAY; // contract MAX_EXPIRY

const coder = ethers.AbiCoder.defaultAbiCoder();

/** Encode a DAOShip governance config (7 fields) */
function encodeConfig(o: {
  votingPeriod?: number;
  gracePeriod?: number;
  proposalOffering?: bigint;
  quorumPercent?: number;
  sponsorThreshold?: bigint;
  minRetentionPercent?: number;
  defaultExpiryWindow?: number;
} = {}) {
  const {
    votingPeriod = 7 * DAY,
    gracePeriod = 3 * DAY,
    proposalOffering = ethers.parseEther("0.1"),
    quorumPercent = 2000,
    sponsorThreshold = ethers.parseEther("1"),
    minRetentionPercent = 6600,
    defaultExpiryWindow = 0,
  } = o;
  return coder.encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
    [votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent, defaultExpiryWindow]
  );
}

interface DeployOpts {
  delay?: number;
  expiryWindow?: number;
  /** register the timelock with GOVERNOR permission on the DAO (default true) */
  grantGovernor?: boolean;
  /** also register `dave` (a non-avatar EOA) as a GOVERNOR navigator, to exercise
   *  the GOVERNOR-navigator branch of `_isGovernorOrAvatar` (default false) */
  extraGovernor?: boolean;
}

/**
 * Self-contained deployment: a DAOShip clone plus a TimelockNavigator registered
 * with GOVERNOR (4) permission, so `executeChange` can call the onlyGovernor
 * `setGovernanceConfig`. Members alice/bob/carol get shares (so totalSupply is
 * large enough for sponsorThreshold validation in the executed config).
 */
async function deployTimelock(opts: DeployOpts = {}) {
  const { delay = 2 * DAY, expiryWindow = 7 * DAY, grantGovernor = true, extraGovernor = false } = opts;
  const [deployer, alice, bob, carol, dave] = await ethers.getSigners();

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

  // daoShip clone address is known before setUp, so we can deploy the navigator
  // against it and register it in the same setUp call.
  const TimelockNavigator = await ethers.getContractFactory("TimelockNavigator");
  const nav = await TimelockNavigator.deploy(
    await daoShip.getAddress(),
    delay,
    expiryWindow,
    "Timelock",
    "governance config timelock"
  );
  await nav.waitForDeployment();

  const navigators: string[] = [];
  const permissions: number[] = []; // 4 = GOVERNOR
  if (grantGovernor) {
    navigators.push(await nav.getAddress());
    permissions.push(4);
  }
  if (extraGovernor) {
    // A non-avatar address holding GOVERNOR — exercises the navigator-permission
    // branch of `_isGovernorOrAvatar` (distinct from the avatar branch).
    navigators.push(dave.address);
    permissions.push(4);
  }

  const memberAddrs = [alice.address, bob.address, carol.address];
  const shareAmounts = [ethers.parseEther("100"), ethers.parseEther("50"), ethers.parseEther("30")];
  const lootAmounts = [0n, 0n, 0n];

  const initParams = coder.encode(
    ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
    [
      await loot.getAddress(),
      await shares.getAddress(),
      await avatar.getAddress(),
      await multisend.getAddress(),
      encodeConfig(),
      navigators,
      permissions,
      memberAddrs,
      shareAmounts,
      lootAmounts,
      [],
      false,
      false,
    ]
  );
  await daoShip.setUp(initParams);

  return { daoShip, shares, loot, avatar, nav, deployer, alice, bob, carol, dave };
}

/** Impersonate the avatar (a contract) so we can call avatar-authorized functions */
async function asAvatar(avatarAddr: string) {
  await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x21e19e0c9bab2400000"]);
  return ethers.getImpersonatedSigner(avatarAddr);
}

describe("TimelockNavigator", function () {
  describe("Deployment & configuration", function () {
    it("sets immutable parameters and emits NavigatorDeployed", async function () {
      const { daoShip, deployer } = await deployTimelock();
      const TimelockNavigator = await ethers.getContractFactory("TimelockNavigator");
      const nav = await TimelockNavigator.deploy(await daoShip.getAddress(), 2 * DAY, 7 * DAY, "TL", "desc");
      await expect(nav.deploymentTransaction())
        .to.emit(nav, "NavigatorDeployed")
        .withArgs(await daoShip.getAddress(), deployer.address, "TimelockNavigator", "TL", "desc");

      expect(await nav.navigatorType()).to.equal("TimelockNavigator");
      expect(await nav.daoShip()).to.equal(await daoShip.getAddress());
      expect(await nav.delay()).to.equal(2 * DAY);
      expect(await nav.expiryWindow()).to.equal(7 * DAY);
      expect(await nav.changeCount()).to.equal(0);
      expect(await nav.paused()).to.equal(false);
    });

    it("reverts on zero DAOShip", async function () {
      const TL = await ethers.getContractFactory("TimelockNavigator");
      await expect(TL.deploy(ethers.ZeroAddress, 2 * DAY, 7 * DAY, "", "")).to.be.revertedWithCustomError(TL, "InvalidConfig");
    });

    it("reverts DelayTooShort below MIN_DELAY", async function () {
      const { daoShip } = await deployTimelock();
      const TL = await ethers.getContractFactory("TimelockNavigator");
      await expect(TL.deploy(await daoShip.getAddress(), MIN_DELAY - 1, 7 * DAY, "", "")).to.be.revertedWithCustomError(TL, "DelayTooShort");
    });

    it("accepts a delay exactly at MIN_DELAY and exposes the sanity-floor / recommended constants", async function () {
      const { daoShip } = await deployTimelock();
      const TL = await ethers.getContractFactory("TimelockNavigator");
      const nav = await TL.deploy(await daoShip.getAddress(), MIN_DELAY, 7 * DAY, "", "");
      await nav.waitForDeployment();
      expect(await nav.delay()).to.equal(MIN_DELAY);
      // MIN_DELAY is only a "not instant" floor; RECOMMENDED_DELAY is the advisory production minimum.
      expect(await nav.MIN_DELAY()).to.equal(MIN_DELAY);
      expect(await nav.RECOMMENDED_DELAY()).to.equal(2 * DAY);
      expect(await nav.MIN_DELAY()).to.be.lessThan(await nav.RECOMMENDED_DELAY());
    });

    it("reverts DelayTooLong above MAX_DELAY", async function () {
      const { daoShip } = await deployTimelock();
      const TL = await ethers.getContractFactory("TimelockNavigator");
      await expect(TL.deploy(await daoShip.getAddress(), 30 * DAY + 1, 7 * DAY, "", "")).to.be.revertedWithCustomError(TL, "DelayTooLong");
    });

    it("reverts InvalidConfig for expiryWindow out of [MIN_EXPIRY, MAX_EXPIRY]", async function () {
      const { daoShip } = await deployTimelock();
      const TL = await ethers.getContractFactory("TimelockNavigator");
      await expect(TL.deploy(await daoShip.getAddress(), 2 * DAY, HOUR - 1, "", "")).to.be.revertedWithCustomError(TL, "InvalidConfig");
      await expect(TL.deploy(await daoShip.getAddress(), 2 * DAY, 3650 * DAY + 1, "", "")).to.be.revertedWithCustomError(TL, "InvalidConfig");
    });

    it("accepts a delay exactly at MAX_DELAY (upper bound) and exposes the MAX_DELAY constant", async function () {
      const { daoShip } = await deployTimelock();
      const TL = await ethers.getContractFactory("TimelockNavigator");
      expect(await (await TL.deploy(await daoShip.getAddress(), 2 * DAY, 7 * DAY, "", "")).MAX_DELAY()).to.equal(MAX_DELAY);
      // delay == MAX_DELAY is accepted (the revert is `_delay > MAX_DELAY`, strict).
      const nav = await TL.deploy(await daoShip.getAddress(), MAX_DELAY, 7 * DAY, "", "");
      await nav.waitForDeployment();
      expect(await nav.delay()).to.equal(MAX_DELAY);
    });

    it("accepts an expiryWindow exactly at MIN_EXPIRY and exactly at MAX_EXPIRY (both bounds inclusive)", async function () {
      const { daoShip } = await deployTimelock();
      const TL = await ethers.getContractFactory("TimelockNavigator");
      // Bounds are inclusive: revert is `< MIN_EXPIRY || > MAX_EXPIRY`.
      const navMin = await TL.deploy(await daoShip.getAddress(), 2 * DAY, MIN_EXPIRY, "", "");
      await navMin.waitForDeployment();
      expect(await navMin.expiryWindow()).to.equal(MIN_EXPIRY);
      expect(await navMin.MIN_EXPIRY()).to.equal(MIN_EXPIRY);

      const navMax = await TL.deploy(await daoShip.getAddress(), 2 * DAY, MAX_EXPIRY, "", "");
      await navMax.waitForDeployment();
      expect(await navMax.expiryWindow()).to.equal(MAX_EXPIRY);
      expect(await navMax.MAX_EXPIRY()).to.equal(MAX_EXPIRY);
    });
  });

  describe("queueChange", function () {
    it("avatar queues a change; stores hash + window and emits ChangeQueued with full bytes", async function () {
      const { nav, avatar } = await deployTimelock({ delay: 2 * DAY, expiryWindow: 7 * DAY });
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig({ votingPeriod: 5 * DAY });
      const hash = ethers.keccak256(cfg);

      const tx = await nav.connect(av).queueChange(cfg);
      const rc = await tx.wait();
      const ts = (await ethers.provider.getBlock(rc!.blockNumber))!.timestamp;

      await expect(tx)
        .to.emit(nav, "ChangeQueued")
        .withArgs(0, await avatar.getAddress(), hash, cfg, ts + 2 * DAY, ts + 2 * DAY + 7 * DAY);

      expect(await nav.changeCount()).to.equal(1);
      const c = await nav.queuedChanges(0);
      expect(c.configHash).to.equal(hash);
      expect(c.queuedAt).to.equal(ts);
      expect(c.executableAfter).to.equal(ts + 2 * DAY);
      expect(c.expiresAt).to.equal(ts + 2 * DAY + 7 * DAY);
      expect(c.queuedBy).to.equal(await avatar.getAddress());
      expect(c.executed).to.equal(false);
      expect(c.cancelled).to.equal(false);
    });

    it("reverts NotAuthorized when a non-avatar calls queueChange", async function () {
      const { nav, alice } = await deployTimelock();
      await expect(nav.connect(alice).queueChange(encodeConfig())).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });

    it("reverts IsPaused when paused", async function () {
      const { nav, avatar } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).pause();
      await expect(nav.connect(av).queueChange(encodeConfig())).to.be.revertedWithCustomError(nav, "IsPaused");
    });
  });

  describe("executeChange (happy path + guards)", function () {
    it("applies the queued config to DAOShip after the delay", async function () {
      const { nav, avatar, daoShip } = await deployTimelock({ delay: 2 * DAY });
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig({ votingPeriod: 5 * DAY, gracePeriod: 2 * DAY, quorumPercent: 1500, minRetentionPercent: 5000, defaultExpiryWindow: 100 });

      await nav.connect(av).queueChange(cfg);
      await time.increase(2 * DAY);

      await expect(nav.executeChange(0, cfg))
        .to.emit(nav, "ChangeExecuted")
        .withArgs(0, (await ethers.getSigners())[0].address, ethers.keccak256(cfg));

      // DAOShip config actually updated
      expect(await daoShip.votingPeriod()).to.equal(5 * DAY);
      expect(await daoShip.gracePeriod()).to.equal(2 * DAY);
      expect(await daoShip.quorumPercent()).to.equal(1500);
      expect(await daoShip.minRetentionPercent()).to.equal(5000);
      expect(await daoShip.defaultExpiryWindow()).to.equal(100);

      expect((await nav.queuedChanges(0)).executed).to.equal(true);
    });

    it("is permissionless — a random account can execute a matured change", async function () {
      const { nav, avatar, dave, daoShip } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig({ votingPeriod: 6 * DAY });
      await nav.connect(av).queueChange(cfg);
      await time.increase(2 * DAY);
      await nav.connect(dave).executeChange(0, cfg);
      expect(await daoShip.votingPeriod()).to.equal(6 * DAY);
    });

    it("reverts ChangeNotReady before the delay elapses", async function () {
      const { nav, avatar } = await deployTimelock({ delay: 2 * DAY });
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig();
      await nav.connect(av).queueChange(cfg);
      await time.increase(2 * DAY - 10);
      await expect(nav.executeChange(0, cfg)).to.be.revertedWithCustomError(nav, "ChangeNotReady");
    });

    it("reverts ChangeExpired after the expiry window", async function () {
      const { nav, avatar } = await deployTimelock({ delay: 2 * DAY, expiryWindow: 7 * DAY });
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig();
      await nav.connect(av).queueChange(cfg);
      await time.increase(2 * DAY + 7 * DAY + 1);
      await expect(nav.executeChange(0, cfg)).to.be.revertedWithCustomError(nav, "ChangeExpired");
    });

    it("reverts ConfigHashMismatch when supplied bytes differ from the queued bytes", async function () {
      const { nav, avatar } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).queueChange(encodeConfig({ votingPeriod: 5 * DAY }));
      await time.increase(2 * DAY);
      await expect(nav.executeChange(0, encodeConfig({ votingPeriod: 6 * DAY }))).to.be.revertedWithCustomError(nav, "ConfigHashMismatch");
    });

    it("reverts ChangeAlreadyExecuted on a second execute", async function () {
      const { nav, avatar } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig({ votingPeriod: 5 * DAY });
      await nav.connect(av).queueChange(cfg);
      await time.increase(2 * DAY);
      await nav.executeChange(0, cfg);
      await expect(nav.executeChange(0, cfg)).to.be.revertedWithCustomError(nav, "ChangeAlreadyExecuted");
    });

    it("reverts ChangeDoesNotExist for an unknown id", async function () {
      const { nav } = await deployTimelock();
      await expect(nav.executeChange(0, encodeConfig())).to.be.revertedWithCustomError(nav, "ChangeDoesNotExist");
    });

    it("reverts (does not lock out) when DAOShip rejects a malformed/invalid config; change stays executable", async function () {
      const { nav, avatar } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());
      // votingPeriod below MIN_VOTING_PERIOD (60) → DAOShip.setGovernanceConfig reverts
      const badCfg = encodeConfig({ votingPeriod: 10 });
      await nav.connect(av).queueChange(badCfg);
      await time.increase(2 * DAY);
      await expect(nav.executeChange(0, badCfg)).to.be.reverted; // DAOShip VotingPeriodTooShort bubbles up
      // executed flag was rolled back — not locked out
      expect((await nav.queuedChanges(0)).executed).to.equal(false);
    });

    it("executes an already-queued change even while paused (pause only gates NEW queuing, not execution)", async function () {
      // NatSpec: executeChange explicitly states "Paused state does NOT block execution"
      // and the `paused` flag doc says it "does NOT block executing already-queued changes".
      // So: queue → pause → advance past delay → executeChange must still succeed.
      const { nav, avatar, daoShip } = await deployTimelock({ delay: 2 * DAY, expiryWindow: 7 * DAY });
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig({ votingPeriod: 5 * DAY });
      await nav.connect(av).queueChange(cfg);

      await nav.connect(av).pause();
      expect(await nav.paused()).to.equal(true);

      await time.increase(2 * DAY);
      // Still within the expiry window, so it is executable despite the pause.
      expect(await nav.isExecutable(0)).to.equal(true);
      await expect(nav.executeChange(0, cfg))
        .to.emit(nav, "ChangeExecuted")
        .withArgs(0, (await ethers.getSigners())[0].address, ethers.keccak256(cfg));

      expect(await daoShip.votingPeriod()).to.equal(5 * DAY);
      expect((await nav.queuedChanges(0)).executed).to.equal(true);
      expect(await nav.paused()).to.equal(true); // pause unchanged by execution
    });

    it("reverts when the timelock lacks GOVERNOR permission", async function () {
      const { nav, avatar } = await deployTimelock({ grantGovernor: false });
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig({ votingPeriod: 5 * DAY });
      await nav.connect(av).queueChange(cfg);
      await time.increase(2 * DAY);
      await expect(nav.executeChange(0, cfg)).to.be.reverted; // DAOShip NotGovernor
    });
  });

  describe("Execution window boundaries", function () {
    it("rejects at executableAfter-1, accepts at exactly executableAfter", async function () {
      const { nav, avatar, daoShip } = await deployTimelock({ delay: 2 * DAY });
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig({ votingPeriod: 5 * DAY });
      await nav.connect(av).queueChange(cfg);
      const ready = Number((await nav.queuedChanges(0)).executableAfter);

      await time.setNextBlockTimestamp(ready - 1);
      await expect(nav.executeChange(0, cfg)).to.be.revertedWithCustomError(nav, "ChangeNotReady");

      await time.setNextBlockTimestamp(ready);
      await nav.executeChange(0, cfg);
      expect(await daoShip.votingPeriod()).to.equal(5 * DAY);
    });

    it("accepts at exactly expiresAt, rejects at expiresAt+1", async function () {
      const { nav, avatar, daoShip } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());

      // first change: executable at exactly expiresAt
      const cfgA = encodeConfig({ votingPeriod: 5 * DAY });
      await nav.connect(av).queueChange(cfgA);
      const expA = Number((await nav.queuedChanges(0)).expiresAt);
      await time.setNextBlockTimestamp(expA);
      await nav.executeChange(0, cfgA);
      expect(await daoShip.votingPeriod()).to.equal(5 * DAY);

      // second change: one second past expiry → rejected
      const cfgB = encodeConfig({ votingPeriod: 6 * DAY });
      await nav.connect(av).queueChange(cfgB);
      const expB = Number((await nav.queuedChanges(1)).expiresAt);
      await time.setNextBlockTimestamp(expB + 1);
      await expect(nav.executeChange(1, cfgB)).to.be.revertedWithCustomError(nav, "ChangeExpired");
    });
  });

  describe("cancelChange", function () {
    it("avatar cancels a pending change; execute then reverts ChangeAlreadyCancelled", async function () {
      const { nav, avatar } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig({ votingPeriod: 5 * DAY });
      await nav.connect(av).queueChange(cfg);

      await expect(nav.connect(av).cancelChange(0)).to.emit(nav, "ChangeCancelled").withArgs(0, await avatar.getAddress());
      await time.increase(2 * DAY);
      await expect(nav.executeChange(0, cfg)).to.be.revertedWithCustomError(nav, "ChangeAlreadyCancelled");
    });

    it("reverts NotAuthorized for a non-avatar caller", async function () {
      const { nav, avatar, alice } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).queueChange(encodeConfig());
      await expect(nav.connect(alice).cancelChange(0)).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });

    it("reverts ChangeAlreadyExecuted when cancelling an executed change", async function () {
      const { nav, avatar } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig({ votingPeriod: 5 * DAY });
      await nav.connect(av).queueChange(cfg);
      await time.increase(2 * DAY);
      await nav.executeChange(0, cfg);
      await expect(nav.connect(av).cancelChange(0)).to.be.revertedWithCustomError(nav, "ChangeAlreadyExecuted");
    });

    it("cancels an expired-but-unexecuted change (for bookkeeping) and emits ChangeCancelled", async function () {
      // NatSpec: "An expired-but-unexecuted change may still be cancelled for
      // bookkeeping (it could never execute anyway)." cancelChange has no expiry
      // guard, so even past delay + expiryWindow the cancel must succeed.
      const { nav, avatar } = await deployTimelock({ delay: 2 * DAY, expiryWindow: 7 * DAY });
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig({ votingPeriod: 5 * DAY });
      await nav.connect(av).queueChange(cfg);

      // advance PAST delay + expiry so the change is expired (un-executable)
      await time.increase(2 * DAY + 7 * DAY + 1);
      expect(await nav.isExecutable(0)).to.equal(false); // expired
      await expect(nav.executeChange(0, cfg)).to.be.revertedWithCustomError(nav, "ChangeExpired");

      // cancel still succeeds on the expired change
      await expect(nav.connect(av).cancelChange(0))
        .to.emit(nav, "ChangeCancelled").withArgs(0, await avatar.getAddress());
      expect((await nav.queuedChanges(0)).cancelled).to.equal(true);
      // now reverts ChangeAlreadyCancelled rather than ChangeExpired
      await expect(nav.executeChange(0, cfg)).to.be.revertedWithCustomError(nav, "ChangeAlreadyCancelled");
    });

    it("reverts ChangeAlreadyCancelled on a double cancel", async function () {
      const { nav, avatar } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).queueChange(encodeConfig());
      await nav.connect(av).cancelChange(0);
      await expect(nav.connect(av).cancelChange(0)).to.be.revertedWithCustomError(nav, "ChangeAlreadyCancelled");
    });
  });

  describe("pause / unpause / emergencyCancelAll", function () {
    it("avatar pauses and unpauses", async function () {
      const { nav, avatar } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());
      await expect(nav.connect(av).pause()).to.emit(nav, "Paused").withArgs(await avatar.getAddress());
      expect(await nav.paused()).to.equal(true);
      await expect(nav.connect(av).unpause()).to.emit(nav, "Unpaused").withArgs(await avatar.getAddress());
      expect(await nav.paused()).to.equal(false);
    });

    it("a GOVERNOR navigator (non-avatar) is also authorized to pause / unpause / emergencyCancelAll", async function () {
      // `dave` is registered as a GOVERNOR navigator but is NOT the avatar, so this
      // exercises the `(navigators[msg.sender] & GOVERNOR) != 0` branch of
      // `_isGovernorOrAvatar` — the branch the avatar-based tests never reach.
      const { nav, avatar, dave } = await deployTimelock({ extraGovernor: true });
      expect(dave.address).to.not.equal(await avatar.getAddress());

      await expect(nav.connect(dave).pause()).to.emit(nav, "Paused").withArgs(dave.address);
      expect(await nav.paused()).to.equal(true);
      await expect(nav.connect(dave).unpause()).to.emit(nav, "Unpaused").withArgs(dave.address);
      expect(await nav.paused()).to.equal(false);

      // queue a change, then have the GOVERNOR navigator emergency-cancel it
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).queueChange(encodeConfig({ votingPeriod: 6 * DAY }));
      await expect(nav.connect(dave).emergencyCancelAll())
        .to.emit(nav, "ChangeCancelled").withArgs(0, dave.address);
      expect((await nav.queuedChanges(0)).cancelled).to.equal(true);
      expect(await nav.paused()).to.equal(true); // emergencyCancelAll also pauses
    });

    it("reverts NotAuthorized for non-governor non-avatar pause/unpause", async function () {
      const { nav, alice } = await deployTimelock();
      await expect(nav.connect(alice).pause()).to.be.revertedWithCustomError(nav, "NotAuthorized");
      await expect(nav.connect(alice).unpause()).to.be.revertedWithCustomError(nav, "NotAuthorized");
      await expect(nav.connect(alice).emergencyCancelAll()).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });

    it("emergencyCancelAll cancels every pending change, leaves executed ones, and pauses", async function () {
      const { nav, avatar } = await deployTimelock();
      const av = await asAvatar(await avatar.getAddress());

      // change 0: will be executed before the emergency
      const cfg0 = encodeConfig({ votingPeriod: 5 * DAY });
      await nav.connect(av).queueChange(cfg0);
      // changes 1 and 2: pending
      await nav.connect(av).queueChange(encodeConfig({ votingPeriod: 6 * DAY }));
      await nav.connect(av).queueChange(encodeConfig({ votingPeriod: 7 * DAY }));

      await time.increase(2 * DAY);
      await nav.executeChange(0, cfg0); // change 0 executed

      const tx = await nav.connect(av).emergencyCancelAll();
      await expect(tx).to.emit(nav, "ChangeCancelled").withArgs(1, await avatar.getAddress());
      await expect(tx).to.emit(nav, "ChangeCancelled").withArgs(2, await avatar.getAddress());
      await expect(tx).to.emit(nav, "Paused").withArgs(await avatar.getAddress());

      expect((await nav.queuedChanges(0)).executed).to.equal(true);
      expect((await nav.queuedChanges(0)).cancelled).to.equal(false); // executed, not re-cancelled
      expect((await nav.queuedChanges(1)).cancelled).to.equal(true);
      expect((await nav.queuedChanges(2)).cancelled).to.equal(true);
      expect(await nav.paused()).to.equal(true);

      // new queues blocked until unpause
      await expect(nav.connect(av).queueChange(encodeConfig())).to.be.revertedWithCustomError(nav, "IsPaused");
    });
  });

  describe("isExecutable view", function () {
    it("tracks readiness across the lifecycle", async function () {
      const { nav, avatar } = await deployTimelock({ delay: 2 * DAY, expiryWindow: 7 * DAY });
      const av = await asAvatar(await avatar.getAddress());
      const cfg = encodeConfig({ votingPeriod: 5 * DAY });

      expect(await nav.isExecutable(0)).to.equal(false); // does not exist
      await nav.connect(av).queueChange(cfg);
      expect(await nav.isExecutable(0)).to.equal(false); // not ready

      await time.increase(2 * DAY);
      expect(await nav.isExecutable(0)).to.equal(true); // ready

      await nav.executeChange(0, cfg);
      expect(await nav.isExecutable(0)).to.equal(false); // executed
    });

    it("returns false for an expired change", async function () {
      const { nav, avatar } = await deployTimelock({ delay: 2 * DAY, expiryWindow: 7 * DAY });
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).queueChange(encodeConfig());
      await time.increase(2 * DAY + 7 * DAY + 1);
      expect(await nav.isExecutable(0)).to.equal(false);
    });
  });
});
