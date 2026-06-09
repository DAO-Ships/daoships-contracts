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

const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;
const coder = ethers.AbiCoder.defaultAbiCoder();
const E = (n: string | number) => ethers.parseEther(String(n));

/** JS mirror of VestingNavigator._vestedAmount (integer math, matches Solidity). */
function vestedAt(total: bigint, start: number, cliffEnd: number, vestingEnd: number, t: number): bigint {
  if (t < cliffEnd) return 0n;
  if (t >= vestingEnd) return total;
  return (total * BigInt(t - start)) / BigInt(vestingEnd - start);
}

interface DeployOpts {
  grantManager?: boolean;
}

/**
 * Self-contained deployment: a DAOShip clone plus a VestingNavigator registered
 * with MANAGER (2) permission so `claim` can call mintShares/mintLoot.
 * alice/bob hold initial shares; dave/eve are fresh beneficiaries.
 */
async function deployVesting(opts: DeployOpts = {}) {
  const { grantManager = true } = opts;
  const [deployer, alice, bob, dave, eve] = await ethers.getSigners();

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

  const VestingNavigator = await ethers.getContractFactory("VestingNavigator");
  const nav = await VestingNavigator.deploy(await daoShip.getAddress(), "Vesting", "contributor vesting");
  await nav.waitForDeployment();

  const navigators = grantManager ? [await nav.getAddress()] : [];
  const permissions = grantManager ? [2] : []; // MANAGER

  const governanceConfig = coder.encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
    [7 * DAY, 3 * DAY, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
  );

  const memberAddrs = [alice.address, bob.address];
  const shareAmounts = [ethers.parseEther("100"), ethers.parseEther("50")];
  const lootAmounts = [0n, 0n];

  const initParams = coder.encode(
    ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
    [
      await loot.getAddress(),
      await shares.getAddress(),
      await avatar.getAddress(),
      await multisend.getAddress(),
      governanceConfig,
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

  return { daoShip, shares, loot, avatar, nav, deployer, alice, bob, dave, eve };
}

/** Impersonate the avatar (a contract) so we can call avatar-authorized functions */
async function asAvatar(avatarAddr: string) {
  await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x21e19e0c9bab2400000"]);
  return ethers.getImpersonatedSigner(avatarAddr);
}

describe("VestingNavigator", function () {
  describe("Deployment & configuration", function () {
    it("sets immutables and emits NavigatorDeployed", async function () {
      const { daoShip, deployer } = await deployVesting();
      const VestingNavigator = await ethers.getContractFactory("VestingNavigator");
      const nav = await VestingNavigator.deploy(await daoShip.getAddress(), "My Vesting", "desc");
      await expect(nav.deploymentTransaction())
        .to.emit(nav, "NavigatorDeployed")
        .withArgs(await daoShip.getAddress(), deployer.address, "VestingNavigator", "My Vesting", "desc");

      expect(await nav.navigatorType()).to.equal("VestingNavigator");
      expect(await nav.daoShip()).to.equal(await daoShip.getAddress());
      expect(await nav.scheduleCount()).to.equal(0);
      expect(await nav.paused()).to.equal(false);
    });

    it("reverts InvalidConfig on zero DAOShip", async function () {
      const VN = await ethers.getContractFactory("VestingNavigator");
      await expect(VN.deploy(ethers.ZeroAddress, "", "")).to.be.revertedWithCustomError(VN, "InvalidConfig");
    });
  });

  describe("createSchedule", function () {
    it("avatar creates a schedule, stored + enumerated + emitted", async function () {
      const { nav, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();

      const tx = await nav.connect(av).createSchedule(dave.address, E(400), start, YEAR, 4 * YEAR, false);
      await expect(tx)
        .to.emit(nav, "ScheduleCreated")
        .withArgs(0, dave.address, E(400), start, start + YEAR, start + 4 * YEAR, false);

      expect(await nav.scheduleCount()).to.equal(1);
      const s = await nav.schedules(0);
      expect(s.beneficiary).to.equal(dave.address);
      expect(s.totalAmount).to.equal(E(400));
      expect(s.claimed).to.equal(0);
      expect(s.startTime).to.equal(start);
      expect(s.cliffEnd).to.equal(start + YEAR);
      expect(s.vestingEnd).to.equal(start + 4 * YEAR);
      expect(s.isLoot).to.equal(false);
      expect(s.revoked).to.equal(false);
      expect(await nav.getSchedules(dave.address)).to.deep.equal([0n]);
    });

    it("startTime=0 means now", async function () {
      const { nav, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const tx = await nav.connect(av).createSchedule(dave.address, E(100), 0, 0, YEAR, false);
      const rc = await tx.wait();
      const ts = (await ethers.provider.getBlock(rc!.blockNumber))!.timestamp;
      const s = await nav.schedules(0);
      expect(s.startTime).to.equal(ts);
      expect(s.vestingEnd).to.equal(ts + YEAR);
    });

    it("reverts NotAuthorized for non-avatar (scenario 9)", async function () {
      const { nav, alice, dave } = await deployVesting();
      await expect(nav.connect(alice).createSchedule(dave.address, E(100), 0, 0, YEAR, false))
        .to.be.revertedWithCustomError(nav, "NotAuthorized");
    });

    it("reverts on bad params: zero beneficiary, zero amount, zero duration, cliff>vesting", async function () {
      const { nav, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      await expect(nav.connect(av).createSchedule(ethers.ZeroAddress, E(1), 0, 0, YEAR, false)).to.be.revertedWithCustomError(nav, "InvalidBeneficiary");
      await expect(nav.connect(av).createSchedule(dave.address, 0, 0, 0, YEAR, false)).to.be.revertedWithCustomError(nav, "ZeroAmount");
      await expect(nav.connect(av).createSchedule(dave.address, E(1), 0, 0, 0, false)).to.be.revertedWithCustomError(nav, "InvalidConfig");
      await expect(nav.connect(av).createSchedule(dave.address, E(1), 0, YEAR + 1, YEAR, false)).to.be.revertedWithCustomError(nav, "CliffExceedsVesting");
    });

    it("reverts IsPaused when paused", async function () {
      const { nav, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).pause();
      await expect(nav.connect(av).createSchedule(dave.address, E(1), 0, 0, YEAR, false)).to.be.revertedWithCustomError(nav, "IsPaused");
    });
  });

  describe("claim — cliff + linear (scenarios 1-3)", function () {
    it("4-year schedule, 1-year cliff: 25% at cliff, 50% at year 2, 100% at year 4", async function () {
      const { nav, shares, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      await nav.connect(av).createSchedule(dave.address, E(400), start, YEAR, 4 * YEAR, false);

      // before cliff → nothing claimable
      expect(await nav.claimable(0)).to.equal(0);

      // exactly at cliff (1 year) → 25% = 100
      await time.setNextBlockTimestamp(start + YEAR);
      await nav.connect(dave).claim(0);
      expect(await shares.balanceOf(dave.address)).to.equal(E(100));

      // year 2 → 50% cumulative, incremental mint of 100
      await time.setNextBlockTimestamp(start + 2 * YEAR);
      await nav.connect(dave).claim(0);
      expect(await shares.balanceOf(dave.address)).to.equal(E(200));

      // year 4 (end) → 100%, incremental 200
      await time.setNextBlockTimestamp(start + 4 * YEAR);
      await nav.connect(dave).claim(0);
      expect(await shares.balanceOf(dave.address)).to.equal(E(400));
      expect((await nav.schedules(0)).claimed).to.equal(E(400));
    });

    it("reverts NothingToClaim before the cliff (scenario 2)", async function () {
      const { nav, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      await nav.connect(av).createSchedule(dave.address, E(400), start, YEAR, 4 * YEAR, false);
      await time.setNextBlockTimestamp(start + YEAR - 10);
      await expect(nav.connect(dave).claim(0)).to.be.revertedWithCustomError(nav, "NothingToClaim");
    });

    it("partial claims are incremental and emit the incremental amount (scenario 3)", async function () {
      const { nav, shares, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      await nav.connect(av).createSchedule(dave.address, E(400), start, 0, 4 * YEAR, false); // no cliff

      await time.setNextBlockTimestamp(start + YEAR);
      await expect(nav.connect(dave).claim(0)).to.emit(nav, "TokensClaimed").withArgs(0, dave.address, E(100), false);
      expect(await shares.balanceOf(dave.address)).to.equal(E(100));

      await time.setNextBlockTimestamp(start + 3 * YEAR);
      await expect(nav.connect(dave).claim(0)).to.emit(nav, "TokensClaimed").withArgs(0, dave.address, E(200), false);
      expect(await shares.balanceOf(dave.address)).to.equal(E(300));
    });

    it("avatar can claim on the beneficiary's behalf; tokens go to beneficiary", async function () {
      const { nav, shares, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      await nav.connect(av).createSchedule(dave.address, E(400), start, 0, 4 * YEAR, false);
      await time.setNextBlockTimestamp(start + 2 * YEAR);
      await nav.connect(av).claim(0);
      expect(await shares.balanceOf(dave.address)).to.equal(E(200));
    });

    it("reverts NotAuthorized when a stranger claims", async function () {
      const { nav, avatar, dave, eve } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      await nav.connect(av).createSchedule(dave.address, E(400), start, 0, 4 * YEAR, false);
      await time.setNextBlockTimestamp(start + YEAR);
      await expect(nav.connect(eve).claim(0)).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });

    it("vests loot when isLoot=true", async function () {
      const { nav, loot, shares, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      await nav.connect(av).createSchedule(dave.address, E(400), start, 0, 4 * YEAR, true);
      await time.setNextBlockTimestamp(start + 2 * YEAR);
      await nav.connect(dave).claim(0);
      expect(await loot.balanceOf(dave.address)).to.equal(E(200));
      expect(await shares.balanceOf(dave.address)).to.equal(0);
    });
  });

  describe("revoke (scenarios 4-7)", function () {
    it("revoke at 50% vested caps future claims (scenario 4)", async function () {
      const { nav, shares, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      await nav.connect(av).createSchedule(dave.address, E(400), start, YEAR, 4 * YEAR, false);

      await time.setNextBlockTimestamp(start + 2 * YEAR); // revoke exactly at 50%
      await nav.connect(av).revoke(0);
      expect((await nav.schedules(0)).revoked).to.equal(true);
      expect(await nav.vested(0)).to.equal(E(200)); // frozen at 50%

      // far in the future, vested stays frozen
      await time.increase(2 * YEAR);
      expect(await nav.vested(0)).to.equal(E(200));
      await nav.connect(dave).claim(0);
      expect(await shares.balanceOf(dave.address)).to.equal(E(200));
      await expect(nav.connect(dave).claim(0)).to.be.revertedWithCustomError(nav, "NothingToClaim");
    });

    it("revoke before cliff → 0 claimable forever (scenario 5)", async function () {
      const { nav, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      await nav.connect(av).createSchedule(dave.address, E(400), start, YEAR, 4 * YEAR, false);

      await time.setNextBlockTimestamp(start + Math.floor(YEAR / 2)); // before cliff
      await nav.connect(av).revoke(0);
      await time.increase(4 * YEAR);
      expect(await nav.vested(0)).to.equal(0);
      await expect(nav.connect(dave).claim(0)).to.be.revertedWithCustomError(nav, "NothingToClaim");
    });

    it("revoke then claim the unclaimed-but-vested portion (scenario 6)", async function () {
      const { nav, shares, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      await nav.connect(av).createSchedule(dave.address, E(400), start, 0, 4 * YEAR, false);

      await time.setNextBlockTimestamp(start + YEAR); // 25% vested, none claimed
      await nav.connect(av).revoke(0);
      await nav.connect(dave).claim(0); // can still claim the 25%
      expect(await shares.balanceOf(dave.address)).to.equal(E(100));
    });

    it("reverts AlreadyRevoked on double revoke (scenario 7)", async function () {
      const { nav, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).createSchedule(dave.address, E(400), 0, YEAR, 4 * YEAR, false);
      await nav.connect(av).revoke(0);
      await expect(nav.connect(av).revoke(0)).to.be.revertedWithCustomError(nav, "AlreadyRevoked");
    });

    it("reverts NotAuthorized when non-avatar revokes", async function () {
      const { nav, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).createSchedule(dave.address, E(400), 0, YEAR, 4 * YEAR, false);
      await expect(nav.connect(dave).revoke(0)).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });

    it("revoke after full vest still allows the full claim (non-destructive)", async function () {
      const { nav, shares, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      await nav.connect(av).createSchedule(dave.address, E(400), start, 0, YEAR, false);
      await time.setNextBlockTimestamp(start + YEAR + 100); // fully vested
      await nav.connect(av).revoke(0);
      expect(await nav.vested(0)).to.equal(E(400));
      await nav.connect(dave).claim(0);
      expect(await shares.balanceOf(dave.address)).to.equal(E(400));
    });
  });

  describe("Multiple schedules (scenario 8)", function () {
    it("tracks independent schedules per and across beneficiaries", async function () {
      const { nav, shares, loot, avatar, dave, eve } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      // dave: two schedules (shares + loot); eve: one
      await nav.connect(av).createSchedule(dave.address, E(400), start, 0, 4 * YEAR, false); // id 0 shares
      await nav.connect(av).createSchedule(dave.address, E(800), start, 0, 4 * YEAR, true);  // id 1 loot
      await nav.connect(av).createSchedule(eve.address, E(40), start, 0, 4 * YEAR, false);   // id 2 shares

      expect(await nav.getSchedules(dave.address)).to.deep.equal([0n, 1n]);
      expect(await nav.getSchedules(eve.address)).to.deep.equal([2n]);

      // Claim each at a controlled, exact timestamp; assert against the JS mirror.
      const cliffEnd = start; // no cliff
      const vEnd = start + 4 * YEAR;

      const t0 = start + YEAR;
      await time.setNextBlockTimestamp(t0);
      await nav.connect(dave).claim(0);
      expect(await shares.balanceOf(dave.address)).to.equal(vestedAt(E(400), start, cliffEnd, vEnd, t0));

      const t1 = start + YEAR + 1;
      await time.setNextBlockTimestamp(t1);
      await nav.connect(dave).claim(1);
      expect(await loot.balanceOf(dave.address)).to.equal(vestedAt(E(800), start, cliffEnd, vEnd, t1));

      const t2 = start + YEAR + 2;
      await time.setNextBlockTimestamp(t2);
      await nav.connect(eve).claim(2);
      expect(await shares.balanceOf(eve.address)).to.equal(vestedAt(E(40), start, cliffEnd, vEnd, t2));
    });
  });

  describe("Permissions & pause", function () {
    it("avatar pauses/unpauses; GOVERNOR-or-avatar gated; stranger rejected", async function () {
      const { nav, avatar, alice } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      await expect(nav.connect(av).pause()).to.emit(nav, "Paused").withArgs(await avatar.getAddress());
      await expect(nav.connect(av).unpause()).to.emit(nav, "Unpaused").withArgs(await avatar.getAddress());
      await expect(nav.connect(alice).pause()).to.be.revertedWithCustomError(nav, "NotAuthorized");
      await expect(nav.connect(alice).unpause()).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });

    it("reverts when the navigator lacks MANAGER permission (claim cannot mint)", async function () {
      const { nav, avatar, dave } = await deployVesting({ grantManager: false });
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      await nav.connect(av).createSchedule(dave.address, E(400), start, 0, 4 * YEAR, false);
      await time.setNextBlockTimestamp(start + YEAR);
      await expect(nav.connect(dave).claim(0)).to.be.reverted; // DAOShip NotManager
    });
  });

  describe("View robustness", function () {
    it("views revert ScheduleDoesNotExist for unknown id; getSchedules empty for none", async function () {
      const { nav, dave } = await deployVesting();
      await expect(nav.vested(0)).to.be.revertedWithCustomError(nav, "ScheduleDoesNotExist");
      await expect(nav.claimable(3)).to.be.revertedWithCustomError(nav, "ScheduleDoesNotExist");
      await expect(nav.connect(dave).claim(0)).to.be.revertedWithCustomError(nav, "ScheduleDoesNotExist");
      expect(await nav.getSchedules(dave.address)).to.deep.equal([]);
    });
  });

  describe("Invariant: claimed never exceeds vested or total (scenario 10)", function () {
    it("monotone partial claims across varied checkpoints stay within bounds", async function () {
      const { nav, shares, avatar, dave } = await deployVesting();
      const av = await asAvatar(await avatar.getAddress());
      const start = await time.latest();
      const total = E(1000);
      const dur = 4 * YEAR;
      const cliffEnd = start + YEAR;
      const vEnd = start + dur;
      await nav.connect(av).createSchedule(dave.address, total, start, YEAR, dur, false);

      const offsets = [Math.floor(YEAR / 3), YEAR, YEAR + 12345, 2 * YEAR, 3 * YEAR + 99, dur, dur + 5 * DAY];
      for (const off of offsets) {
        const t = start + off;
        await time.setNextBlockTimestamp(t);
        const expectedVested = vestedAt(total, start, cliffEnd, vEnd, t);
        const claimedBefore = (await nav.schedules(0)).claimed;
        expect(expectedVested).to.be.lte(total);
        expect(claimedBefore).to.be.lte(expectedVested);
        if (expectedVested > claimedBefore) {
          await nav.connect(dave).claim(0);
          expect((await nav.schedules(0)).claimed).to.equal(expectedVested);
          expect(await shares.balanceOf(dave.address)).to.equal(expectedVested);
        } else {
          await expect(nav.connect(dave).claim(0)).to.be.revertedWithCustomError(nav, "NothingToClaim");
        }
      }
      expect((await nav.schedules(0)).claimed).to.equal(total);
    });
  });
});
