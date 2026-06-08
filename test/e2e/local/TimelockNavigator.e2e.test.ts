import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployDAOShipFixture, encodeProposalData } from "../../fixtures";

const DAY = 24 * 60 * 60;
const coder = ethers.AbiCoder.defaultAbiCoder();

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

/**
 * E2E: TimelockNavigator against a real DAOShip, driven through the actual proposal
 * lifecycle (submit → vote → grace → process). Demonstrates:
 *   - registering the timelock as a GOVERNOR navigator via governance,
 *   - a passed proposal queueing a config change (arrives as msg.sender == avatar),
 *   - executing after the delay, applying the config to DAOShip,
 *   - and the ADVISORY nature: a proposal can still bypass the timelock via
 *     executeAsGovernance (documented honestly, not a bug).
 */
describe("TimelockNavigator E2E", function () {
  // Run a governance proposal with arbitrary (target, calldata) actions.
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

    const TimelockNavigator = await ethers.getContractFactory("TimelockNavigator");
    const timelock = await TimelockNavigator.deploy(await daoShip.getAddress(), 2 * DAY, 7 * DAY, "Timelock", "config timelock");
    await timelock.waitForDeployment();

    // Register the timelock as a GOVERNOR (4) navigator via governance.
    const setNav = daoShip.interface.encodeFunctionData("setNavigators", [[await timelock.getAddress()], [4]]);
    const wrap = daoShip.interface.encodeFunctionData("executeAsGovernance", [await daoShip.getAddress(), 0, setNav]);
    await runProposal(daoShip, deployer, alice, [await daoShip.getAddress()], [wrap], "Register timelock as GOVERNOR");
    expect(await daoShip.navigators(await timelock.getAddress())).to.equal(4);

    return { ...fx, timelock };
  }

  it("queues a config change via proposal, then executes after the delay", async function () {
    const { daoShip, deployer, alice, timelock, avatar } = await setup();

    const newCfg = encodeConfig({ votingPeriod: 5 * DAY, gracePeriod: 2 * DAY, quorumPercent: 1500, defaultExpiryWindow: 1234 });

    // Proposal action: call queueChange on the timelock (executed by the avatar via MultiSend).
    const queueCall = timelock.interface.encodeFunctionData("queueChange", [newCfg]);
    const tx = await runProposal(daoShip, deployer, alice, [await timelock.getAddress()], [queueCall], "Queue config change");
    const rc = await tx.wait();

    // ChangeQueued was emitted with queuedBy == avatar
    const queued = rc!.logs.map((l: any) => { try { return timelock.interface.parseLog(l); } catch { return null; } }).find((p: any) => p?.name === "ChangeQueued");
    expect(queued).to.not.be.undefined;
    expect(queued!.args.queuedBy).to.equal(await avatar.getAddress());
    expect(queued!.args.changeId).to.equal(0);

    // Config not applied yet — still the original
    expect(await daoShip.votingPeriod()).to.equal(7 * DAY);
    expect(await timelock.isExecutable(0)).to.equal(false);

    // Before the delay, execution reverts
    await expect(timelock.executeChange(0, newCfg)).to.be.revertedWithCustomError(timelock, "ChangeNotReady");

    // After the delay, anyone executes and the config applies
    await time.increase(2 * DAY);
    expect(await timelock.isExecutable(0)).to.equal(true);
    await timelock.connect(alice).executeChange(0, newCfg);

    expect(await daoShip.votingPeriod()).to.equal(5 * DAY);
    expect(await daoShip.gracePeriod()).to.equal(2 * DAY);
    expect(await daoShip.quorumPercent()).to.equal(1500);
    expect(await daoShip.defaultExpiryWindow()).to.equal(1234);
  });

  it("avatar can cancel a queued change via a follow-up proposal", async function () {
    const { daoShip, deployer, alice, timelock } = await setup();
    const newCfg = encodeConfig({ votingPeriod: 6 * DAY });

    const queueCall = timelock.interface.encodeFunctionData("queueChange", [newCfg]);
    await runProposal(daoShip, deployer, alice, [await timelock.getAddress()], [queueCall], "Queue");

    const cancelCall = timelock.interface.encodeFunctionData("cancelChange", [0]);
    await runProposal(daoShip, deployer, alice, [await timelock.getAddress()], [cancelCall], "Cancel");

    await time.increase(2 * DAY);
    await expect(timelock.executeChange(0, newCfg)).to.be.revertedWithCustomError(timelock, "ChangeAlreadyCancelled");
    expect(await daoShip.votingPeriod()).to.equal(7 * DAY); // unchanged
  });

  it("ADVISORY: a proposal can still bypass the timelock via executeAsGovernance (documented, not enforced)", async function () {
    const { daoShip, deployer, alice, timelock } = await setup();

    // Direct setGovernanceConfig through executeAsGovernance — no queueChange, no delay.
    const bypassCfg = encodeConfig({ votingPeriod: 4 * DAY });
    const setCfg = daoShip.interface.encodeFunctionData("setGovernanceConfig", [bypassCfg]);
    const wrap = daoShip.interface.encodeFunctionData("executeAsGovernance", [await daoShip.getAddress(), 0, setCfg]);
    await runProposal(daoShip, deployer, alice, [await daoShip.getAddress()], [wrap], "Bypass timelock");

    // Applied immediately — the timelock saw nothing. This is why enforcement lives
    // in the app/indexer layer, not the contract.
    expect(await daoShip.votingPeriod()).to.equal(4 * DAY);
    expect(await timelock.changeCount()).to.equal(0);
  });
});
