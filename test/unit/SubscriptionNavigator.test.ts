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
const PERIOD = 30 * DAY;
const GRACE = 7 * DAY;
const coder = ethers.AbiCoder.defaultAbiCoder();
const E = (n: string | number) => ethers.parseEther(String(n));
const NATIVE = ethers.ZeroAddress;

interface DeployOpts {
  grantManager?: boolean;
  tokens?: string[]; // sentinel "FEE" / "FEE2" / "FOT" / NATIVE — resolved after token deploy
  fees?: bigint[];
  period?: number;
  grace?: number;
  start?: number;
  collectorBps?: number;
  burnOnCollect?: boolean;
  initialMembers?: string[];
  sponsorThreshold?: bigint;
  shareAmounts?: bigint[]; // for [alice, bob]
}

/**
 * Self-contained deployment: a DAOShip clone plus a SubscriptionNavigator registered
 * with MANAGER (2) so collectFee can burn/convert shares and mint the keeper reward.
 * alice/bob hold initial shares. A MockERC20 `feeToken` and a fee-on-transfer token are
 * deployed and funded; alice/bob/carol approve the navigator. carol/dave/eve are extras.
 */
async function deploySub(opts: DeployOpts = {}) {
  const {
    grantManager = true,
    period = PERIOD,
    grace = GRACE,
    start = 0,
    collectorBps = 100,
    burnOnCollect = false,
    initialMembers = [],
    sponsorThreshold = E(1),
    shareAmounts = [E(100), E(50)],
  } = opts;

  const [deployer, alice, bob, carol, dave, eve] = await ethers.getSigners();

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

  // Fee tokens
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const feeToken = await MockERC20.deploy("Fee", "FEE");
  await feeToken.waitForDeployment();
  const feeToken2 = await MockERC20.deploy("Fee2", "FEE2");
  await feeToken2.waitForDeployment();
  const FOT = await ethers.getContractFactory("MockFeeOnTransferERC20");
  const fotToken = await FOT.deploy("FeeOnTransfer", "FOT", 100); // 1% transfer fee
  await fotToken.waitForDeployment();

  const resolve = (t: string) =>
    t === "FEE"
      ? feeToken.target as string
      : t === "FEE2"
      ? feeToken2.target as string
      : t === "FOT"
      ? fotToken.target as string
      : t; // NATIVE or raw address

  const tokens = (opts.tokens ?? ["FEE"]).map(resolve);
  const fees = opts.fees ?? [E(10)];

  const Subscription = await ethers.getContractFactory("SubscriptionNavigator");
  const nav = await Subscription.deploy(
    await daoShip.getAddress(),
    tokens,
    fees,
    period,
    grace,
    start,
    collectorBps,
    burnOnCollect,
    initialMembers,
    "Subscription",
    "monthly dues"
  );
  await nav.waitForDeployment();

  const navigators = grantManager ? [await nav.getAddress()] : [];
  const permissions = grantManager ? [2] : []; // MANAGER

  const governanceConfig = coder.encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
    [7 * DAY, 3 * DAY, E("0.1"), 2000, sponsorThreshold, 6600, 0]
  );

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
      [alice.address, bob.address],
      shareAmounts,
      [0n, 0n],
      [],
      false,
      false,
    ]
  );
  await daoShip.setUp(initParams);

  // Fund + approve fee tokens for the common payers
  for (const who of [alice, bob, carol]) {
    await feeToken.mint(who.address, E(1000));
    await feeToken.connect(who).approve(await nav.getAddress(), ethers.MaxUint256);
    await feeToken2.mint(who.address, E(1000));
    await feeToken2.connect(who).approve(await nav.getAddress(), ethers.MaxUint256);
    await fotToken.mint(who.address, E(1000));
    await fotToken.connect(who).approve(await nav.getAddress(), ethers.MaxUint256);
  }

  return { daoShip, shares, loot, avatar, nav, feeToken, feeToken2, fotToken, deployer, alice, bob, carol, dave, eve };
}

/** Impersonate the avatar (a contract) so we can call avatar-authorized functions */
async function asAvatar(avatarAddr: string) {
  await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x21e19e0c9bab2400000"]);
  return ethers.getImpersonatedSigner(avatarAddr);
}

describe("SubscriptionNavigator", function () {
  // ─── Deployment & configuration ──────────────────────────────────────────
  describe("Deployment & configuration", function () {
    it("sets immutables, menu, and emits NavigatorDeployed", async function () {
      const { daoShip, nav, deployer, feeToken } = await deploySub();
      expect(await nav.navigatorType()).to.equal("SubscriptionNavigator");
      expect(await nav.daoShip()).to.equal(await daoShip.getAddress());
      expect(await nav.deployer()).to.equal(deployer.address);
      expect(await nav.periodDuration()).to.equal(PERIOD);
      expect(await nav.graceDuration()).to.equal(GRACE);
      expect(await nav.collectorRewardBps()).to.equal(100);
      expect(await nav.burnOnCollect()).to.equal(false);
      expect(await nav.paused()).to.equal(false);
      expect(await nav.acceptedTokenCount()).to.equal(1);
      expect(await nav.feePerPeriod(await feeToken.getAddress())).to.equal(E(10));
      expect(await nav.getAcceptedTokens()).to.deep.equal([await feeToken.getAddress()]);
    });

    it("emits NavigatorDeployed with metadata", async function () {
      const { daoShip } = await deploySub();
      const [deployer] = await ethers.getSigners();
      const Subscription = await ethers.getContractFactory("SubscriptionNavigator");
      const nav = await Subscription.deploy(
        await daoShip.getAddress(), [NATIVE], [E(1)], PERIOD, GRACE, 0, 100, false, [], "My Subs", "desc"
      );
      await expect(nav.deploymentTransaction())
        .to.emit(nav, "NavigatorDeployed")
        .withArgs(await daoShip.getAddress(), deployer.address, "SubscriptionNavigator", "My Subs", "desc");
    });

    it("enrolls initial members with one complimentary period", async function () {
      const { nav, alice } = await deploySub({ initialMembers: [] });
      // separate deploy with an initial member
      const { nav: nav2, alice: a2 } = await deploySub({ initialMembers: [(await ethers.getSigners())[1].address] });
      const start = await nav2.startTime();
      expect(await nav2.isEnrolled(a2.address)).to.equal(true);
      expect(await nav2.paidThrough(a2.address)).to.equal(start + BigInt(PERIOD));
      expect(await nav2.isCurrent(a2.address)).to.equal(true);
      // baseline: no initial members
      expect(await nav.isEnrolled(alice.address)).to.equal(false);
    });

    it("back-dated startTime does not make genesis members instantly collectible", async function () {
      // Regression: the constructor must clamp the genesis anchor to the deploy block, like
      // _enrollAnchor / _payFee — otherwise a back-dated start births a delinquent roster.
      const past = (await time.latest()) - 10 * PERIOD;
      const member = (await ethers.getSigners())[1].address;
      const { nav } = await deploySub({ start: past, initialMembers: [member] });
      expect(await nav.isEnrolled(member)).to.equal(true);
      expect(await nav.isCurrent(member)).to.equal(true);
      expect(await nav.isDelinquent(member)).to.equal(false);
      // paid through a full period into the FUTURE (deploy-block-anchored), not the back-dated past
      expect((await nav.paidThrough(member)) > BigInt(await time.latest())).to.equal(true);
    });

    it("reverts on invalid config", async function () {
      const Subscription = await ethers.getContractFactory("SubscriptionNavigator");
      const { daoShip } = await deploySub();
      const dao = await daoShip.getAddress();
      // zero dao
      await expect(Subscription.deploy(ethers.ZeroAddress, [NATIVE], [E(1)], PERIOD, GRACE, 0, 100, false, [], "", "")).to.be.revertedWithCustomError(Subscription, "InvalidConfig");
      // empty token menu
      await expect(Subscription.deploy(dao, [], [], PERIOD, GRACE, 0, 100, false, [], "", "")).to.be.revertedWithCustomError(Subscription, "InvalidConfig");
      // length mismatch
      await expect(Subscription.deploy(dao, [NATIVE], [E(1), E(2)], PERIOD, GRACE, 0, 100, false, [], "", "")).to.be.revertedWithCustomError(Subscription, "InvalidConfig");
      // zero fee
      await expect(Subscription.deploy(dao, [NATIVE], [0], PERIOD, GRACE, 0, 100, false, [], "", "")).to.be.revertedWithCustomError(Subscription, "InvalidConfig");
      const MAXP = 3650 * DAY; // MAX_PERIOD
      // period too short (< MIN_PERIOD)
      await expect(Subscription.deploy(dao, [NATIVE], [E(1)], 60, GRACE, 0, 100, false, [], "", "")).to.be.revertedWithCustomError(Subscription, "InvalidConfig");
      // period too long (> MAX_PERIOD)
      await expect(Subscription.deploy(dao, [NATIVE], [E(1)], MAXP + 1, GRACE, 0, 100, false, [], "", "")).to.be.revertedWithCustomError(Subscription, "InvalidConfig");
      // grace too long (> MAX_PERIOD)
      await expect(Subscription.deploy(dao, [NATIVE], [E(1)], PERIOD, MAXP + 1, 0, 100, false, [], "", "")).to.be.revertedWithCustomError(Subscription, "InvalidConfig");
      // collector bps too high
      await expect(Subscription.deploy(dao, [NATIVE], [E(1)], PERIOD, GRACE, 0, 1001, false, [], "", "")).to.be.revertedWithCustomError(Subscription, "InvalidConfig");
      // duplicate token
      await expect(Subscription.deploy(dao, [NATIVE, NATIVE], [E(1), E(2)], PERIOD, GRACE, 0, 100, false, [], "", "")).to.be.revertedWithCustomError(Subscription, "DuplicateToken");
    });

    it("accepts MIN_PERIOD, MAX_PERIOD, and grace == MAX_PERIOD boundaries", async function () {
      const Subscription = await ethers.getContractFactory("SubscriptionNavigator");
      const { daoShip } = await deploySub();
      const dao = await daoShip.getAddress();
      const MIN = 60 * 60, MAXP = 3650 * DAY;
      for (const [p, g] of [[MIN, 0], [MAXP, MAXP]] as [number, number][]) {
        const nav = await Subscription.deploy(dao, [NATIVE], [E(1)], p, g, 0, 1000, false, [], "", "");
        await nav.waitForDeployment();
        expect(await nav.periodDuration()).to.equal(p);
        expect(await nav.graceDuration()).to.equal(g);
      }
    });
  });

  // ─── Scenario 1: happy path ──────────────────────────────────────────────
  it("S1: pay fee advances paidThrough and transfers to vault", async function () {
    const { nav, feeToken, avatar, alice } = await deploySub();
    const vault = await avatar.getAddress();
    const before = await feeToken.balanceOf(vault);
    const tx = await nav.connect(alice).payFee(1, await feeToken.getAddress());
    const now = BigInt(await time.latest());
    const expected = now + BigInt(PERIOD);
    expect(await nav.paidThrough(alice.address)).to.equal(expected);
    expect(await feeToken.balanceOf(vault)).to.equal(before + E(10));
    expect(await nav.isCurrent(alice.address)).to.equal(true);
    await expect(tx)
      .to.emit(nav, "FeePaid")
      .withArgs(alice.address, alice.address, await feeToken.getAddress(), E(10), 1, expected);
  });

  // ─── Scenario 2: pre-pay multiple periods ────────────────────────────────
  it("S2: pre-pay 3 periods", async function () {
    const { nav, feeToken, avatar, alice } = await deploySub();
    await nav.connect(alice).payFee(3, await feeToken.getAddress());
    const now = BigInt(await time.latest());
    expect(await nav.paidThrough(alice.address)).to.equal(now + BigInt(3 * PERIOD));
    expect(await feeToken.balanceOf(await avatar.getAddress())).to.equal(E(30));
  });

  // ─── Scenario 3: pay for another member ──────────────────────────────────
  it("S3: payFeeFor advances the member, debits the payer", async function () {
    const { nav, feeToken, bob, dave } = await deploySub();
    const payerBefore = await feeToken.balanceOf(bob.address);
    await nav.connect(bob).payFeeFor(dave.address, 2, await feeToken.getAddress());
    const now = BigInt(await time.latest());
    expect(await nav.paidThrough(dave.address)).to.equal(now + BigInt(2 * PERIOD));
    expect(await feeToken.balanceOf(bob.address)).to.equal(payerBefore - E(20));
    expect(await nav.isEnrolled(dave.address)).to.equal(true);
  });

  // ─── Scenario 4: grace period transitions ────────────────────────────────
  it("S4: current → grace → delinquent transitions", async function () {
    const { nav, feeToken, alice } = await deploySub();
    await nav.connect(alice).payFee(1, await feeToken.getAddress());
    expect(await nav.isCurrent(alice.address)).to.equal(true);
    expect(await nav.inGracePeriod(alice.address)).to.equal(false);
    expect(await nav.isDelinquent(alice.address)).to.equal(false);

    // Just past the deadline → in grace
    await time.increase(PERIOD + 1);
    expect(await nav.isCurrent(alice.address)).to.equal(false);
    expect(await nav.inGracePeriod(alice.address)).to.equal(true);
    expect(await nav.isDelinquent(alice.address)).to.equal(false);

    // Past grace → delinquent
    await time.increase(GRACE);
    expect(await nav.inGracePeriod(alice.address)).to.equal(false);
    expect(await nav.isDelinquent(alice.address)).to.equal(true);
  });

  // ─── Scenario 5: collect (convert mode = default) ────────────────────────
  it("S5: collect converts shares to loot and rewards collector (convert mode)", async function () {
    const { nav, feeToken, shares, loot, alice, dave } = await deploySub();
    await nav.connect(alice).payFee(1, await feeToken.getAddress());
    await time.increase(PERIOD + GRACE + 1);
    expect(await nav.isDelinquent(alice.address)).to.equal(true);

    const tx = await nav.connect(dave).collectFee(alice.address);
    expect(await shares.balanceOf(alice.address)).to.equal(0);
    expect(await loot.balanceOf(alice.address)).to.equal(E(100)); // economic value preserved
    expect(await loot.balanceOf(dave.address)).to.equal(E(1)); // 1% of 100
    expect(await nav.paidThrough(alice.address)).to.equal(0); // un-enrolled
    await expect(tx).to.emit(nav, "FeeCollected").withArgs(alice.address, dave.address, E(100), E(1), false);
  });

  it("S5b: collect burns shares (burn mode)", async function () {
    const { nav, feeToken, shares, loot, alice, dave } = await deploySub({ burnOnCollect: true });
    await nav.connect(alice).payFee(1, await feeToken.getAddress());
    await time.increase(PERIOD + GRACE + 1);
    const totalBefore = await shares.totalSupply();
    const tx = await nav.connect(dave).collectFee(alice.address);
    expect(await shares.balanceOf(alice.address)).to.equal(0);
    expect(await loot.balanceOf(alice.address)).to.equal(0); // destroyed, not preserved
    expect(await loot.balanceOf(dave.address)).to.equal(E(1)); // keeper reward still minted
    expect(await shares.totalSupply()).to.equal(totalBefore - E(100));
    await expect(tx).to.emit(nav, "FeeCollected").withArgs(alice.address, dave.address, E(100), E(1), true);
  });

  // ─── Scenario 6: collect non-delinquent reverts ──────────────────────────
  it("S6: collect on a current member reverts NotDelinquent", async function () {
    const { nav, feeToken, alice, dave } = await deploySub();
    await nav.connect(alice).payFee(1, await feeToken.getAddress());
    await expect(nav.connect(dave).collectFee(alice.address)).to.be.revertedWithCustomError(nav, "NotDelinquent");
    // also: never-enrolled member is never delinquent
    await expect(nav.connect(dave).collectFee((await ethers.getSigners())[5].address)).to.be.revertedWithCustomError(nav, "NotDelinquent");
  });

  // ─── Scenario 7: zero shares reverts ─────────────────────────────────────
  it("S7: collect with zero shares reverts NoSharesToBurn", async function () {
    const { nav, avatar, dave } = await deploySub();
    const av = await asAvatar(await avatar.getAddress());
    await nav.connect(av).enroll(dave.address); // dave has no shares
    await time.increase(2 * PERIOD + GRACE + 1);
    expect(await nav.isDelinquent(dave.address)).to.equal(true);
    await expect(nav.connect((await ethers.getSigners())[2]).collectFee(dave.address)).to.be.revertedWithCustomError(nav, "NoSharesToBurn");
  });

  // ─── Scenario 8: collector reward math ───────────────────────────────────
  it("S8: 1000 shares at 100bps → 10 loot reward", async function () {
    const { nav, feeToken, loot, alice, dave } = await deploySub({ shareAmounts: [E(1000), E(50)] });
    await nav.connect(alice).payFee(1, await feeToken.getAddress());
    await time.increase(PERIOD + GRACE + 1);
    await nav.connect(dave).collectFee(alice.address);
    expect(await loot.balanceOf(dave.address)).to.equal(E(10));
  });

  // ─── Scenario 9: zero collector reward ───────────────────────────────────
  it("S9: zero collector bps mints no reward", async function () {
    const { nav, feeToken, loot, alice, dave } = await deploySub({ collectorBps: 0 });
    await nav.connect(alice).payFee(1, await feeToken.getAddress());
    await time.increase(PERIOD + GRACE + 1);
    const tx = await nav.connect(dave).collectFee(alice.address);
    expect(await loot.balanceOf(dave.address)).to.equal(0);
    await expect(tx).to.emit(nav, "FeeCollected").withArgs(alice.address, dave.address, E(100), 0, false);
  });

  // ─── Scenario 10: late catch-up (debt model) ─────────────────────────────
  it("S10: debt model — must cover arrears to become current", async function () {
    const { nav, feeToken, alice } = await deploySub();
    await nav.connect(alice).payFee(1, await feeToken.getAddress());
    const pt1 = await nav.paidThrough(alice.address);

    // Advance ~2 periods past the paid-through point.
    await time.increase(2 * PERIOD);
    expect(await nav.isCurrent(alice.address)).to.equal(false);

    // Paying 1 advances by exactly one period from where it stood (debt, not reset-to-now).
    await nav.connect(alice).payFee(1, await feeToken.getAddress());
    expect(await nav.paidThrough(alice.address)).to.equal(pt1 + BigInt(PERIOD));
    expect(await nav.isCurrent(alice.address)).to.equal(false); // still behind

    // Paying 2 more (3 total over the arrears) clears it and gets ahead.
    await nav.connect(alice).payFee(2, await feeToken.getAddress());
    expect(await nav.paidThrough(alice.address)).to.equal(pt1 + BigInt(3 * PERIOD));
    expect(await nav.isCurrent(alice.address)).to.equal(true);
  });

  // ─── Scenario 11: fee-on-transfer rejected ───────────────────────────────
  it("S11: fee-on-transfer token shortfall reverts InsufficientPayment", async function () {
    const { nav, fotToken, alice } = await deploySub({ tokens: ["FOT"], fees: [E(10)] });
    await expect(nav.connect(alice).payFee(1, await fotToken.getAddress())).to.be.revertedWithCustomError(nav, "InsufficientPayment");
  });

  // ─── Scenario 12: property checks ────────────────────────────────────────
  it("S12: paidThrough never decreases; shares only removed when delinquent", async function () {
    const { nav, feeToken, shares, alice, bob, dave } = await deploySub();
    const tokenAddr = await feeToken.getAddress();
    let prev = 0n;
    for (const periods of [1, 2, 1, 3]) {
      await nav.connect(alice).payFee(periods, tokenAddr);
      const pt = await nav.paidThrough(alice.address);
      expect(pt >= prev).to.equal(true);
      prev = pt;
    }
    // bob current → cannot be collected
    await nav.connect(bob).payFee(5, tokenAddr);
    await expect(nav.connect(dave).collectFee(bob.address)).to.be.revertedWithCustomError(nav, "NotDelinquent");
    expect(await shares.balanceOf(bob.address)).to.equal(E(50));
  });

  // ─── Multi-token + native ────────────────────────────────────────────────
  describe("Multi-token & native", function () {
    it("accepts native QUAI with exact value and forwards to vault", async function () {
      const { nav, avatar, alice } = await deploySub({ tokens: [NATIVE], fees: [E(2)] });
      const vault = await avatar.getAddress();
      const before = await ethers.provider.getBalance(vault);
      await nav.connect(alice).payFee(3, NATIVE, { value: E(6) });
      expect(await ethers.provider.getBalance(vault)).to.equal(before + E(6));
      const now = BigInt(await time.latest());
      expect(await nav.paidThrough(alice.address)).to.equal(now + BigInt(3 * PERIOD));
    });

    it("native: wrong msg.value reverts IncorrectPayment", async function () {
      const { nav, alice } = await deploySub({ tokens: [NATIVE], fees: [E(2)] });
      await expect(nav.connect(alice).payFee(2, NATIVE, { value: E(3) })).to.be.revertedWithCustomError(nav, "IncorrectPayment");
      await expect(nav.connect(alice).payFee(2, NATIVE, { value: E(5) })).to.be.revertedWithCustomError(nav, "IncorrectPayment");
    });

    it("ERC20 path rejects stray native value", async function () {
      const { nav, feeToken, alice } = await deploySub();
      await expect(nav.connect(alice).payFee(1, await feeToken.getAddress(), { value: 1 })).to.be.revertedWithCustomError(nav, "IncorrectPayment");
    });

    it("supports a menu of native + two ERC20s, member chooses", async function () {
      const { nav, feeToken, feeToken2, avatar, alice } = await deploySub({
        tokens: [NATIVE, "FEE", "FEE2"],
        fees: [E(500), E(10), E(12)],
      });
      expect(await nav.acceptedTokenCount()).to.equal(3);
      expect(await nav.quote(2, await feeToken.getAddress())).to.equal(E(20));
      expect(await nav.quote(2, await feeToken2.getAddress())).to.equal(E(24));
      expect(await nav.quote(1, NATIVE)).to.equal(E(500));

      const vault = await avatar.getAddress();
      const fBefore = await feeToken.balanceOf(vault);
      await nav.connect(alice).payFee(1, await feeToken.getAddress());
      expect(await feeToken.balanceOf(vault)).to.equal(fBefore + E(10));
      const afterFirst = await nav.paidThrough(alice.address);
      // and pay a later period in QUAI — debt model extends from paidThrough, not now
      await nav.connect(alice).payFee(1, NATIVE, { value: E(500) });
      expect(await nav.paidThrough(alice.address)).to.equal(afterFirst + BigInt(PERIOD));
    });

    it("rejects an unaccepted token", async function () {
      const { nav, feeToken2, alice } = await deploySub({ tokens: ["FEE"], fees: [E(10)] });
      await expect(nav.connect(alice).payFee(1, await feeToken2.getAddress())).to.be.revertedWithCustomError(nav, "TokenNotAccepted");
      await expect(nav.quote(1, await feeToken2.getAddress())).to.be.revertedWithCustomError(nav, "TokenNotAccepted");
    });
  });

  // ─── Enrollment model ────────────────────────────────────────────────────
  describe("Enrollment", function () {
    it("governance enroll grants one complimentary period", async function () {
      const { nav, avatar, dave } = await deploySub();
      const av = await asAvatar(await avatar.getAddress());
      const tx = await nav.connect(av).enroll(dave.address);
      const now = BigInt(await time.latest());
      const expected = now + BigInt(PERIOD);
      expect(await nav.paidThrough(dave.address)).to.equal(expected);
      expect(await nav.isCurrent(dave.address)).to.equal(true);
      await expect(tx).to.emit(nav, "MemberEnrolled").withArgs(dave.address, expected);
    });

    it("enroll reverts on already-enrolled and non-avatar / zero", async function () {
      const { nav, avatar, dave, eve } = await deploySub();
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).enroll(dave.address);
      await expect(nav.connect(av).enroll(dave.address)).to.be.revertedWithCustomError(nav, "AlreadyEnrolled");
      await expect(nav.connect(eve).enroll(eve.address)).to.be.revertedWithCustomError(nav, "NotAuthorized");
      await expect(nav.connect(av).enroll(ethers.ZeroAddress)).to.be.revertedWithCustomError(nav, "InvalidMember");
    });

    it("enrollBatch skips already-enrolled members", async function () {
      const { nav, feeToken, avatar, alice, dave, eve } = await deploySub();
      await nav.connect(alice).payFee(2, await feeToken.getAddress()); // alice already enrolled w/ real payment
      const aliceBefore = await nav.paidThrough(alice.address);
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).enrollBatch([alice.address, dave.address, eve.address]);
      // alice untouched (skip), dave/eve newly enrolled
      expect(await nav.paidThrough(alice.address)).to.equal(aliceBefore);
      expect(await nav.isEnrolled(dave.address)).to.equal(true);
      expect(await nav.isEnrolled(eve.address)).to.equal(true);
    });

    it("collect un-enrolls; member can re-enroll fresh afterward", async function () {
      const { nav, feeToken, avatar, shares, alice, dave } = await deploySub();
      await nav.connect(alice).payFee(1, await feeToken.getAddress());
      await time.increase(PERIOD + GRACE + 1);
      await nav.connect(dave).collectFee(alice.address);
      expect(await nav.isEnrolled(alice.address)).to.equal(false);
      // re-enroll via a fresh payment starts a brand-new clock from now
      await nav.connect(alice).payFee(1, await feeToken.getAddress());
      const now = BigInt(await time.latest());
      expect(await nav.paidThrough(alice.address)).to.equal(now + BigInt(PERIOD));
    });
  });

  // ─── Sponsor-threshold edge ──────────────────────────────────────────────
  it("collect bubbles up sponsor-threshold revert when removal would breach it", async function () {
    // alice 100, bob 50, total 150; sponsorThreshold 100 → burning alice's 100 leaves 50 < 100+100
    const { nav, feeToken, alice, dave } = await deploySub({ sponsorThreshold: E(100), burnOnCollect: true });
    await nav.connect(alice).payFee(1, await feeToken.getAddress());
    await time.increase(PERIOD + GRACE + 1);
    await expect(nav.connect(dave).collectFee(alice.address)).to.be.revertedWithCustomError(
      await ethers.getContractAt("DAOShip", await nav.daoShip()),
      "BurnBreachesSponsorThreshold"
    );
    // state rolled back — alice still enrolled & delinquent
    expect(await nav.isEnrolled(alice.address)).to.equal(true);
    expect(await nav.isDelinquent(alice.address)).to.equal(true);
  });

  it("collect bubbles up sponsor-threshold revert in convert mode too (default), rolling back", async function () {
    // Same setup but burnOnCollect:false → convertSharesToLoot hits ConvertBreachesSponsorThreshold.
    const { nav, feeToken, alice, dave } = await deploySub({ sponsorThreshold: E(100), burnOnCollect: false });
    await nav.connect(alice).payFee(1, await feeToken.getAddress());
    await time.increase(PERIOD + GRACE + 1);
    await expect(nav.connect(dave).collectFee(alice.address)).to.be.revertedWithCustomError(
      await ethers.getContractAt("DAOShip", await nav.daoShip()),
      "ConvertBreachesSponsorThreshold"
    );
    // delete paidThrough rolled back — alice still enrolled & delinquent
    expect(await nav.isEnrolled(alice.address)).to.equal(true);
    expect(await nav.isDelinquent(alice.address)).to.equal(true);
  });

  // ─── Access control & pause ──────────────────────────────────────────────
  describe("Access control & pause", function () {
    it("payFee reverts ZeroPeriods / payFeeFor zero member", async function () {
      const { nav, feeToken, alice } = await deploySub();
      await expect(nav.connect(alice).payFee(0, await feeToken.getAddress())).to.be.revertedWithCustomError(nav, "ZeroPeriods");
      await expect(nav.connect(alice).payFeeFor(ethers.ZeroAddress, 1, await feeToken.getAddress())).to.be.revertedWithCustomError(nav, "InvalidMember");
    });

    it("pause blocks payFee, collectFee, and enroll; unpause restores", async function () {
      const { nav, feeToken, avatar, alice, dave } = await deploySub();
      await nav.connect(alice).payFee(1, await feeToken.getAddress());
      await time.increase(PERIOD + GRACE + 1);
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).pause();
      expect(await nav.paused()).to.equal(true);
      await expect(nav.connect(alice).payFee(1, await feeToken.getAddress())).to.be.revertedWithCustomError(nav, "IsPaused");
      await expect(nav.connect(dave).collectFee(alice.address)).to.be.revertedWithCustomError(nav, "IsPaused");
      await expect(nav.connect(av).enroll(dave.address)).to.be.revertedWithCustomError(nav, "IsPaused");
      await nav.connect(av).unpause();
      await nav.connect(dave).collectFee(alice.address); // works again
      expect(await nav.isEnrolled(alice.address)).to.equal(false);
    });

    it("pause is GOVERNOR-or-avatar only", async function () {
      const { nav, alice } = await deploySub();
      await expect(nav.connect(alice).pause()).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });

    it("withdrawStuckTokens is avatar-only and recovers mis-sent ERC20", async function () {
      const { nav, feeToken2, avatar, alice, dave } = await deploySub();
      await feeToken2.mint(await nav.getAddress(), E(5)); // mistaken direct transfer
      await expect(nav.connect(alice).withdrawStuckTokens(await feeToken2.getAddress(), alice.address, E(5))).to.be.revertedWithCustomError(nav, "NotAuthorized");
      const av = await asAvatar(await avatar.getAddress());
      await expect(nav.connect(av).withdrawStuckTokens(await feeToken2.getAddress(), dave.address, E(5)))
        .to.emit(nav, "StuckTokensRecovered")
        .withArgs(await feeToken2.getAddress(), dave.address, E(5));
      expect(await feeToken2.balanceOf(dave.address)).to.equal(E(5));
    });

    it("collectFee without MANAGER reverts (DAOShip rejects the burn)", async function () {
      const { nav, feeToken, alice, dave } = await deploySub({ grantManager: false });
      await nav.connect(alice).payFee(1, await feeToken.getAddress());
      await time.increase(PERIOD + GRACE + 1);
      await expect(nav.connect(dave).collectFee(alice.address)).to.be.reverted; // NotManager from core
    });
  });
});
