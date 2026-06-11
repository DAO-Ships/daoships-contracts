import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployDAOShipFixture, encodeProposalData } from "../../fixtures";

const DAY = 24 * 60 * 60;
const PERIOD = 30 * DAY;
const NATIVE = ethers.ZeroAddress;
const E = (n: string | number) => ethers.parseEther(String(n));

/**
 * E2E: BudgetNavigator against a real DAOShip + vault, driven through the actual
 * proposal lifecycle. Demonstrates the full treasury-budget flow:
 *   - a governance proposal ENABLING the navigator as a vault module (the self-call
 *     enableModule path — arrives as msg.sender == vault),
 *   - a governance proposal CREATING a budget (arrives as msg.sender == avatar),
 *   - the per-budget manager disbursing real native + ERC20 treasury funds within the
 *     allowance/ceiling caps, with the lazy period reset, and
 *   - a governance proposal CANCELLING a budget, halting further disbursement.
 * The navigator holds NO DAOShip permission — only vault module status.
 */
describe("BudgetNavigator E2E", function () {
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
    const { daoShip, avatar, deployer, alice } = fx;

    const BudgetNavigator = await ethers.getContractFactory("BudgetNavigator");
    const budget = await BudgetNavigator.deploy(await daoShip.getAddress(), "Budget", "treasury budgets");
    await budget.waitForDeployment();

    // Fund the treasury (vault): native QUAI + an ERC20.
    const avatarAddr = await avatar.getAddress();
    await ethers.provider.send("hardhat_setBalance", [avatarAddr, "0x3635c9adc5dea00000"]); // 1000 ether
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USDX", "USDX");
    await token.waitForDeployment();
    await token.mint(avatarAddr, E(1_000_000));

    // Enable the navigator as a vault module via a governance proposal (self-call path).
    const enableCall = avatar.interface.encodeFunctionData("enableModule", [await budget.getAddress()]);
    await runProposal(daoShip, deployer, alice, [avatarAddr], [enableCall], "Enable budget navigator as vault module");
    expect(await avatar.isModuleEnabled(await budget.getAddress())).to.equal(true);
    expect(await daoShip.navigators(await budget.getAddress())).to.equal(0); // holds NO DAOShip permission

    return { ...fx, budget, token };
  }

  it("creates a budget via proposal; manager disburses native + ERC20 within caps; period resets", async function () {
    const { daoShip, deployer, alice, bob, carol, budget, token } = await setup();
    const manager = carol;

    // Two budgets created by governance: one native, one ERC20.
    const createNative = budget.interface.encodeFunctionData("createBudget", [manager.address, NATIVE, E(100), E(1000), PERIOD, 0, 0]);
    const createToken = budget.interface.encodeFunctionData("createBudget", [manager.address, await token.getAddress(), E(500), E(5000), PERIOD, 0, 0]);
    const tx = await runProposal(daoShip, deployer, alice, [await budget.getAddress(), await budget.getAddress()], [createNative, createToken], "Create Q2 budgets");
    const rc = await tx.wait();
    const created = rc!.logs
      .map((l: any) => { try { return budget.interface.parseLog(l); } catch { return null; } })
      .filter((p: any) => p?.name === "BudgetCreated");
    expect(created.length).to.equal(2);
    expect((await budget.budgets(0)).manager).to.equal(manager.address);

    // Manager disburses native to bob within the 100/period allowance.
    const bobBefore = await ethers.provider.getBalance(bob.address);
    await budget.connect(manager).disburse(0, bob.address, E(70));
    expect(await ethers.provider.getBalance(bob.address)).to.equal(bobBefore + E(70));

    // Batch payroll for the remaining 30 of the period (bob + alice).
    await budget.connect(manager).disburseBatch(0, [bob.address, alice.address], [E(20), E(10)]);
    expect((await budget.budgets(0)).spentThisPeriod).to.equal(E(100));
    await expect(budget.connect(manager).disburse(0, bob.address, E(1))).to.be.revertedWithCustomError(budget, "AllowanceExceeded");

    // ERC20 budget: manager pays a contributor.
    await budget.connect(manager).disburse(1, bob.address, E(250));
    expect(await token.balanceOf(bob.address)).to.equal(E(250));

    // Next period: native allowance resets (lazy).
    await time.increase(PERIOD);
    expect(await budget.remainingThisPeriod(0)).to.equal(E(100));
    await budget.connect(manager).disburse(0, bob.address, E(40));
    expect((await budget.budgets(0)).totalSpent).to.equal(E(140));
  });

  it("cancelBudget via proposal halts further disbursement", async function () {
    const { daoShip, deployer, alice, bob, carol, budget } = await setup();
    const manager = carol;

    const createNative = budget.interface.encodeFunctionData("createBudget", [manager.address, NATIVE, E(100), E(1000), PERIOD, 0, 0]);
    await runProposal(daoShip, deployer, alice, [await budget.getAddress()], [createNative], "Create budget");

    await budget.connect(manager).disburse(0, bob.address, E(10)); // works before cancel

    const cancelCall = budget.interface.encodeFunctionData("cancelBudget", [0]);
    await runProposal(daoShip, deployer, alice, [await budget.getAddress()], [cancelCall], "Cancel budget");

    expect((await budget.budgets(0)).cancelled).to.equal(true);
    await expect(budget.connect(manager).disburse(0, bob.address, E(1))).to.be.revertedWithCustomError(budget, "BudgetCancelled_");
  });
});
