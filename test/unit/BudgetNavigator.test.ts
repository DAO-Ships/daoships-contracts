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
const coder = ethers.AbiCoder.defaultAbiCoder();
const E = (n: string | number) => ethers.parseEther(String(n));
const NATIVE = ethers.ZeroAddress;
const PERIOD = 30 * DAY;

interface DeployOpts {
  enableNav?: boolean; // enable BudgetNavigator as a module on the vault
}

/**
 * Self-contained deployment: a DAOShip clone + a MockAvatar treasury (funded with
 * native QUAI and a MockERC20) + a BudgetNavigator enabled as a vault module.
 * The navigator holds NO DAOShip permission — its only privilege is module status.
 * alice/bob are members; manager runs disbursements; r1/r2 are payout recipients.
 */
async function deployBudget(opts: DeployOpts = {}) {
  const { enableNav = true } = opts;
  const [deployer, alice, bob, manager, r1, r2] = await ethers.getSigners();

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

  const BudgetNavigator = await ethers.getContractFactory("BudgetNavigator");
  const nav = await BudgetNavigator.deploy(await daoShip.getAddress(), "Budget", "treasury budgets");
  await nav.waitForDeployment();

  // Budget holds NO DAOShip permission — register nothing.
  const governanceConfig = coder.encode(
    ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256", "uint32"],
    [7 * DAY, 3 * DAY, ethers.parseEther("0.1"), 2000, ethers.parseEther("1"), 6600, 0]
  );

  const initParams = coder.encode(
    ["address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]", "address[]", "bool", "bool"],
    [
      await loot.getAddress(),
      await shares.getAddress(),
      await avatar.getAddress(),
      await multisend.getAddress(),
      governanceConfig,
      [],
      [],
      [alice.address, bob.address],
      [E(100), E(50)],
      [0n, 0n],
      [],
      false,
      false,
    ]
  );
  await daoShip.setUp(initParams);

  // Fund the treasury (avatar): native QUAI + a MockERC20.
  const avatarAddr = await avatar.getAddress();
  await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x3635c9adc5dea00000"]); // 1000 ether
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("USDX", "USDX");
  await token.waitForDeployment();
  await token.mint(avatarAddr, E(1_000_000));

  // Enable BudgetNavigator as a vault module (deployer is the MockAvatar owner).
  if (enableNav) await avatar.enableModule(await nav.getAddress());

  return { daoShip, shares, loot, avatar, multisend, nav, token, deployer, alice, bob, manager, r1, r2 };
}

/** Impersonate the avatar (a contract) so we can call avatar-authorized functions */
async function asAvatar(avatarAddr: string) {
  await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x3635c9adc5dea00000"]);
  return ethers.getImpersonatedSigner(avatarAddr);
}

/** Create a default native budget owned by `manager`. Returns budgetId 0. */
async function createNativeBudget(
  nav: any,
  avatar: any,
  manager: string,
  over: { token?: string; allowance?: bigint; ceiling?: bigint; period?: number; start?: number; end?: number } = {}
) {
  const av = await asAvatar(await avatar.getAddress());
  const allowance = over.allowance ?? E(100);
  const ceiling = over.ceiling ?? E(1000);
  const period = over.period ?? PERIOD;
  await nav.connect(av).createBudget(
    manager,
    over.token ?? NATIVE,
    allowance,
    ceiling,
    period,
    over.start ?? 0,
    over.end ?? 0
  );
}

describe("BudgetNavigator", function () {
  describe("Deployment & configuration", function () {
    it("sets immutables and emits NavigatorDeployed", async function () {
      const { daoShip, deployer } = await deployBudget();
      const BudgetNavigator = await ethers.getContractFactory("BudgetNavigator");
      const nav = await BudgetNavigator.deploy(await daoShip.getAddress(), "My Budget", "desc");
      await expect(nav.deploymentTransaction())
        .to.emit(nav, "NavigatorDeployed")
        .withArgs(await daoShip.getAddress(), deployer.address, "BudgetNavigator", "My Budget", "desc");

      expect(await nav.navigatorType()).to.equal("BudgetNavigator");
      expect(await nav.daoShip()).to.equal(await daoShip.getAddress());
      expect(await nav.budgetCount()).to.equal(0);
      expect(await nav.paused()).to.equal(false);
    });

    it("reverts InvalidConfig on zero DAOShip", async function () {
      const BN = await ethers.getContractFactory("BudgetNavigator");
      await expect(BN.deploy(ethers.ZeroAddress, "", "")).to.be.revertedWithCustomError(BN, "InvalidConfig");
    });
  });

  describe("createBudget", function () {
    it("avatar creates a budget, stored + emitted", async function () {
      const { nav, avatar, manager, token } = await deployBudget();
      const av = await asAvatar(await avatar.getAddress());
      const start = (await time.latest()) + 100;

      const tx = await nav.connect(av).createBudget(manager.address, await token.getAddress(), E(100), E(1000), PERIOD, start, start + 365 * DAY);
      await expect(tx)
        .to.emit(nav, "BudgetCreated")
        .withArgs(0, manager.address, await token.getAddress(), E(100), E(1000), PERIOD, start, start + 365 * DAY);

      expect(await nav.budgetCount()).to.equal(1);
      const b = await nav.budgets(0);
      expect(b.manager).to.equal(manager.address);
      expect(b.token).to.equal(await token.getAddress());
      expect(b.allowancePerPeriod).to.equal(E(100));
      expect(b.totalCeiling).to.equal(E(1000));
      expect(b.periodLength).to.equal(PERIOD);
      expect(b.currentPeriodStart).to.equal(start);
      expect(b.startsAt).to.equal(start);
      expect(b.endsAt).to.equal(start + 365 * DAY);
      expect(b.totalSpent).to.equal(0);
      expect(b.cancelled).to.equal(false);
    });

    it("startTime=0 means now", async function () {
      const { nav, avatar, manager } = await deployBudget();
      const av = await asAvatar(await avatar.getAddress());
      const tx = await nav.connect(av).createBudget(manager.address, NATIVE, E(100), E(1000), PERIOD, 0, 0);
      const rc = await tx.wait();
      const ts = (await ethers.provider.getBlock(rc!.blockNumber))!.timestamp;
      const b = await nav.budgets(0);
      expect(b.startsAt).to.equal(ts);
      expect(b.currentPeriodStart).to.equal(ts);
      expect(b.endsAt).to.equal(0); // perpetual
    });

    it("reverts NotAuthorized for non-avatar", async function () {
      const { nav, alice, manager } = await deployBudget();
      await expect(nav.connect(alice).createBudget(manager.address, NATIVE, E(100), E(1000), PERIOD, 0, 0))
        .to.be.revertedWithCustomError(nav, "NotAuthorized");
    });

    it("validates params: manager, allowance, ceiling, period bounds, end<=start", async function () {
      const { nav, avatar, manager } = await deployBudget();
      const av = await asAvatar(await avatar.getAddress());
      const now = await time.latest();
      await expect(nav.connect(av).createBudget(ethers.ZeroAddress, NATIVE, E(100), E(1000), PERIOD, 0, 0)).to.be.revertedWithCustomError(nav, "InvalidManager");
      await expect(nav.connect(av).createBudget(manager.address, NATIVE, 0, E(1000), PERIOD, 0, 0)).to.be.revertedWithCustomError(nav, "ZeroAmount");
      await expect(nav.connect(av).createBudget(manager.address, NATIVE, E(100), 0, PERIOD, 0, 0)).to.be.revertedWithCustomError(nav, "InvalidConfig");
      await expect(nav.connect(av).createBudget(manager.address, NATIVE, E(100), E(1000), HOUR - 1, 0, 0)).to.be.revertedWithCustomError(nav, "InvalidPeriod");
      await expect(nav.connect(av).createBudget(manager.address, NATIVE, E(100), E(1000), 3651 * DAY, 0, 0)).to.be.revertedWithCustomError(nav, "InvalidPeriod");
      // endTime <= start
      await expect(nav.connect(av).createBudget(manager.address, NATIVE, E(100), E(1000), PERIOD, now + 1000, now + 500)).to.be.revertedWithCustomError(nav, "InvalidConfig");
    });

    it("reverts IsPaused when paused", async function () {
      const { nav, avatar, manager } = await deployBudget();
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).pause();
      await expect(nav.connect(av).createBudget(manager.address, NATIVE, E(100), E(1000), PERIOD, 0, 0)).to.be.revertedWithCustomError(nav, "IsPaused");
    });
  });

  describe("disburse — native QUAI", function () {
    it("manager disburses within allowance; recipient paid; counters update; event", async function () {
      const { nav, avatar, manager, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);

      const before = await ethers.provider.getBalance(r1.address);
      await expect(nav.connect(manager).disburse(0, r1.address, E(60)))
        .to.emit(nav, "Disbursed")
        .withArgs(0, r1.address, NATIVE, E(60));
      expect(await ethers.provider.getBalance(r1.address)).to.equal(before + E(60));

      const b = await nav.budgets(0);
      expect(b.totalSpent).to.equal(E(60));
      expect(b.spentThisPeriod).to.equal(E(60));
      expect(await nav.remainingThisPeriod(0)).to.equal(E(40));
      expect(await nav.remainingTotal(0)).to.equal(E(940));
    });

    it("reverts NotAuthorized for non-manager (incl. avatar)", async function () {
      const { nav, avatar, manager, alice, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);
      const av = await asAvatar(await avatar.getAddress());
      await expect(nav.connect(alice).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "NotAuthorized");
      await expect(nav.connect(av).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });

    it("reverts InvalidRecipient and ZeroAmount", async function () {
      const { nav, avatar, manager, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);
      await expect(nav.connect(manager).disburse(0, ethers.ZeroAddress, E(1))).to.be.revertedWithCustomError(nav, "InvalidRecipient");
      await expect(nav.connect(manager).disburse(0, r1.address, 0)).to.be.revertedWithCustomError(nav, "ZeroAmount");
    });

    it("reverts AllowanceExceeded over the per-period allowance", async function () {
      const { nav, avatar, manager, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);
      await nav.connect(manager).disburse(0, r1.address, E(100)); // exhaust period
      await expect(nav.connect(manager).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "AllowanceExceeded");
    });

    it("reverts CeilingExceeded over the lifetime cap", async function () {
      const { nav, avatar, manager, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address, { allowance: E(100), ceiling: E(150) });
      await nav.connect(manager).disburse(0, r1.address, E(100)); // period 0
      await time.increase(PERIOD);
      await expect(nav.connect(manager).disburse(0, r1.address, E(100))).to.be.revertedWithCustomError(nav, "CeilingExceeded");
      await nav.connect(manager).disburse(0, r1.address, E(50)); // hits ceiling exactly
      expect(await nav.remainingTotal(0)).to.equal(0);
      expect(await nav.remainingThisPeriod(0)).to.equal(0); // ceiling binds tighter
    });

    it("reverts NotStarted before startsAt and BudgetEnded at/after endsAt", async function () {
      const { nav, avatar, manager, r1 } = await deployBudget();
      const now = await time.latest();
      await createNativeBudget(nav, avatar, manager.address, { start: now + 1000, end: now + 1000 + 10 * PERIOD });
      await expect(nav.connect(manager).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "NotStarted");
      await time.increaseTo(now + 1000 + 10 * PERIOD);
      await expect(nav.connect(manager).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "BudgetEnded");
    });

    it("reverts NotEnabledModule when the navigator is not a vault module", async function () {
      const { nav, avatar, manager, r1 } = await deployBudget({ enableNav: false });
      await createNativeBudget(nav, avatar, manager.address);
      await expect(nav.connect(manager).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "NotEnabledModule");
    });

    it("reverts IsPaused when paused (emergency freeze)", async function () {
      const { nav, avatar, manager, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);
      const av = await asAvatar(await avatar.getAddress());
      await nav.connect(av).pause();
      await expect(nav.connect(manager).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "IsPaused");
    });

    it("CEI: a failed transfer reverts and rolls back the spend counters", async function () {
      // DAOShip has no receive()/fallback, so a native send to it fails inside the
      // vault → execTransactionFromModule returns false → TransferFailed. Verify the
      // counters (written before the transfer) roll back via EVM atomicity.
      const { nav, avatar, manager, daoShip } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);
      await expect(nav.connect(manager).disburse(0, await daoShip.getAddress(), E(10)))
        .to.be.revertedWithCustomError(nav, "TransferFailed");
      const b = await nav.budgets(0);
      expect(b.totalSpent).to.equal(0);
      expect(b.spentThisPeriod).to.equal(0);
    });
  });

  describe("disburse — ERC20", function () {
    it("disburses an ERC20 from the vault to the recipient", async function () {
      const { nav, avatar, manager, r1, token } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address, { token: await token.getAddress() });
      await expect(nav.connect(manager).disburse(0, r1.address, E(75)))
        .to.emit(nav, "Disbursed")
        .withArgs(0, r1.address, await token.getAddress(), E(75));
      expect(await token.balanceOf(r1.address)).to.equal(E(75));
      expect((await nav.budgets(0)).totalSpent).to.equal(E(75));
    });
  });

  describe("Period reset (lazy)", function () {
    it("allowance resets next period; multiple skipped periods collapse", async function () {
      const { nav, avatar, manager, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address, { allowance: E(100), ceiling: E(10000) });

      await nav.connect(manager).disburse(0, r1.address, E(100)); // period 0 exhausted
      await expect(nav.connect(manager).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "AllowanceExceeded");

      // advance one full period → allowance resets
      await time.increase(PERIOD);
      expect(await nav.remainingThisPeriod(0)).to.equal(E(100));
      await nav.connect(manager).disburse(0, r1.address, E(100)); // period 1
      expect((await nav.budgets(0)).totalSpent).to.equal(E(200));

      // skip 3 periods at once (lazy reset): still a fresh full allowance
      await time.increase(3 * PERIOD);
      expect(await nav.remainingThisPeriod(0)).to.equal(E(100));
      await nav.connect(manager).disburse(0, r1.address, E(80));
      const b = await nav.budgets(0);
      expect(b.spentThisPeriod).to.equal(E(80));
      expect(b.totalSpent).to.equal(E(280));
    });
  });

  describe("disburseBatch — payroll", function () {
    it("pays many recipients in one call; sum bounded; one event per payee", async function () {
      const { nav, avatar, manager, r1, r2 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address, { allowance: E(100) });
      const b1 = await ethers.provider.getBalance(r1.address);
      const b2 = await ethers.provider.getBalance(r2.address);

      const tx = await nav.connect(manager).disburseBatch(0, [r1.address, r2.address], [E(30), E(45)]);
      await expect(tx).to.emit(nav, "Disbursed").withArgs(0, r1.address, NATIVE, E(30));
      await expect(tx).to.emit(nav, "Disbursed").withArgs(0, r2.address, NATIVE, E(45));
      expect(await ethers.provider.getBalance(r1.address)).to.equal(b1 + E(30));
      expect(await ethers.provider.getBalance(r2.address)).to.equal(b2 + E(45));
      expect((await nav.budgets(0)).spentThisPeriod).to.equal(E(75));
    });

    it("reverts LengthMismatch, EmptyBatch, InvalidRecipient, ZeroAmount", async function () {
      const { nav, avatar, manager, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);
      await expect(nav.connect(manager).disburseBatch(0, [r1.address], [E(1), E(2)])).to.be.revertedWithCustomError(nav, "LengthMismatch");
      await expect(nav.connect(manager).disburseBatch(0, [], [])).to.be.revertedWithCustomError(nav, "EmptyBatch");
      await expect(nav.connect(manager).disburseBatch(0, [ethers.ZeroAddress], [E(1)])).to.be.revertedWithCustomError(nav, "InvalidRecipient");
      await expect(nav.connect(manager).disburseBatch(0, [r1.address], [0])).to.be.revertedWithCustomError(nav, "ZeroAmount");
    });

    it("reverts AllowanceExceeded when the batch sum exceeds the period allowance", async function () {
      const { nav, avatar, manager, r1, r2 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address, { allowance: E(100) });
      await expect(nav.connect(manager).disburseBatch(0, [r1.address, r2.address], [E(60), E(50)]))
        .to.be.revertedWithCustomError(nav, "AllowanceExceeded");
    });

    it("reverts NotAuthorized for non-manager", async function () {
      const { nav, avatar, manager, alice, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);
      await expect(nav.connect(alice).disburseBatch(0, [r1.address], [E(1)])).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });
  });

  describe("updateManager", function () {
    it("avatar swaps the manager; old loses access, new gains it", async function () {
      const { nav, avatar, manager, alice, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);
      const av = await asAvatar(await avatar.getAddress());

      await expect(nav.connect(av).updateManager(0, alice.address))
        .to.emit(nav, "ManagerUpdated")
        .withArgs(0, manager.address, alice.address);

      await expect(nav.connect(manager).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "NotAuthorized");
      await nav.connect(alice).disburse(0, r1.address, E(1)); // new manager works
      expect((await nav.budgets(0)).totalSpent).to.equal(E(1));
    });

    it("reverts InvalidManager(0), NotAuthorized(non-avatar), BudgetCancelled_ after cancel", async function () {
      const { nav, avatar, manager, alice } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);
      const av = await asAvatar(await avatar.getAddress());
      await expect(nav.connect(av).updateManager(0, ethers.ZeroAddress)).to.be.revertedWithCustomError(nav, "InvalidManager");
      await expect(nav.connect(alice).updateManager(0, alice.address)).to.be.revertedWithCustomError(nav, "NotAuthorized");
      await nav.connect(av).cancelBudget(0);
      await expect(nav.connect(av).updateManager(0, alice.address)).to.be.revertedWithCustomError(nav, "BudgetCancelled_");
    });
  });

  describe("cancelBudget", function () {
    it("avatar cancels; disbursements blocked; double-cancel + non-avatar revert", async function () {
      const { nav, avatar, manager, alice, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);
      const av = await asAvatar(await avatar.getAddress());

      await expect(nav.connect(av).cancelBudget(0)).to.emit(nav, "BudgetCancelled").withArgs(0, await avatar.getAddress());
      await expect(nav.connect(manager).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "BudgetCancelled_");
      await expect(nav.connect(av).cancelBudget(0)).to.be.revertedWithCustomError(nav, "AlreadyCancelled");
      expect(await nav.remainingThisPeriod(0)).to.equal(0);

      await createNativeBudget(nav, avatar, manager.address); // id 1
      await expect(nav.connect(alice).cancelBudget(1)).to.be.revertedWithCustomError(nav, "NotAuthorized");
    });
  });

  describe("pause / unpause", function () {
    it("GOVERNOR-or-avatar gated; stranger rejected; freezes then resumes", async function () {
      const { nav, avatar, manager, alice, r1 } = await deployBudget();
      await createNativeBudget(nav, avatar, manager.address);
      const av = await asAvatar(await avatar.getAddress());

      await expect(nav.connect(alice).pause()).to.be.revertedWithCustomError(nav, "NotAuthorized");
      await expect(nav.connect(av).pause()).to.emit(nav, "Paused").withArgs(await avatar.getAddress());
      await expect(nav.connect(manager).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "IsPaused");
      await expect(nav.connect(av).unpause()).to.emit(nav, "Unpaused").withArgs(await avatar.getAddress());
      await nav.connect(manager).disburse(0, r1.address, E(1)); // resumed
      expect((await nav.budgets(0)).totalSpent).to.equal(E(1));
    });
  });

  describe("View robustness", function () {
    it("views revert BudgetDoesNotExist for unknown ids", async function () {
      const { nav, manager, r1 } = await deployBudget();
      await expect(nav.remainingThisPeriod(0)).to.be.revertedWithCustomError(nav, "BudgetDoesNotExist");
      await expect(nav.remainingTotal(3)).to.be.revertedWithCustomError(nav, "BudgetDoesNotExist");
      await expect(nav.connect(manager).disburse(0, r1.address, E(1))).to.be.revertedWithCustomError(nav, "BudgetDoesNotExist");
    });

    it("remainingThisPeriod is 0 before the budget starts", async function () {
      const { nav, avatar, manager } = await deployBudget();
      const now = await time.latest();
      await createNativeBudget(nav, avatar, manager.address, { start: now + 10_000 });
      expect(await nav.remainingThisPeriod(0)).to.equal(0);
    });
  });
});
