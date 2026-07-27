/**
 * Generate a differential-testing corpus for the client's proposal status machine.
 *
 * daoships-app reimplements DAOShip.state() in TypeScript (deriveProposalStatus)
 * so the UI can label a proposal without an RPC round-trip per row. Where the two
 * disagree the app shows a confident verdict the chain does not share, and the
 * resulting processProposal call reverts — a defeated proposal must be closed
 * with '0x', a passing one needs its original action bytes.
 *
 * Hand-written parity fixtures already exist on the client. What they cannot do
 * is prove the fixtures themselves are right. This drives real proposals through
 * every reachable state on a local chain, records what state() actually returned
 * alongside the fields the client predicate reads, and writes it out as JSON for
 * the client suite to replay.
 *
 * state() and _didProposalPass() are chain-agnostic Solidity — timestamps,
 * status flags, token supplies — so hardhat reproduces them faithfully. The
 * Quai-specific parts (0x00 shard prefix, protobuf signing) affect deployment
 * and signing, not these predicates.
 *
 *   npx hardhat run scripts/gen-state-corpus.ts
 *
 * Output: test/fixtures/state-corpus.json
 */
import { ethers } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { deployDAOShipFixture, advanceTime } from "../test/fixtures";

// Mirrors DAOShip.sol's enum. Index = on-chain uint8.
const STATE_NAMES = [
  "Unborn", "Submitted", "Voting", "Cancelled",
  "Grace", "Ready", "Processed", "Defeated", "Expired",
] as const;

interface CorpusCase {
  /** What this case is exercising, for test output. */
  label: string;
  /**
   * The chain's block.timestamp when state() was read, as ISO. Replay at exactly
   * this instant — the phase boundaries are timestamp comparisons, so guessing a
   * "now" from the deadlines reproduces a different state than the chain saw.
   */
  evaluatedAt: string;
  /** The on-chain answer — the thing the client must agree with. */
  onChainState: string;
  /** Fields deriveProposalStatus() reads, in indexer row shape. */
  row: {
    cancelled: boolean;
    processed: boolean;
    passed: boolean;
    action_failed: boolean;
    sponsored: boolean;
    voting_ends: string | null;
    grace_ends: string | null;
    expiration: string | null;
    yes_balance: string;
    no_balance: string;
    max_total_shares_at_sponsor: string | null;
  };
  config: {
    voting_period: number;
    grace_period: number;
    quorum_percent: string;
    default_expiry_window: number;
  };
}

const iso = (sec: number | bigint) => new Date(Number(sec) * 1000).toISOString();

async function main() {
  const cases: CorpusCase[] = [];
  const fx = await deployDAOShipFixture();
  const { daoShip, deployer, alice, bob } = fx;

  const votingPeriod = Number(await daoShip.votingPeriod());
  const gracePeriod = Number(await daoShip.gracePeriod());
  const quorumPercent = (await daoShip.quorumPercent()).toString();
  const defaultExpiryWindow = Number(await daoShip.defaultExpiryWindow());
  const offering = await daoShip.proposalOffering();

  const config = {
    voting_period: votingPeriod,
    grace_period: gracePeriod,
    quorum_percent: quorumPercent,
    default_expiry_window: defaultExpiryWindow,
  };

  /** Read the live struct + state and snapshot it as an indexer-shaped row. */
  async function snapshot(id: number, label: string) {
    const p = await daoShip.proposals(id);
    const st = Number(await daoShip.state(id));
    const flags = await daoShip.getProposalStatus(id);
    const evaluatedAt = iso((await ethers.provider.getBlock("latest"))!.timestamp);

    cases.push({
      label,
      evaluatedAt,
      onChainState: STATE_NAMES[st],
      row: {
        cancelled: flags[0],
        processed: flags[1],
        passed: flags[2],
        action_failed: flags[3],
        sponsored: p.sponsor !== ethers.ZeroAddress,
        voting_ends: Number(p.votingEnds) > 0 ? iso(p.votingEnds) : null,
        grace_ends: Number(p.graceEnds) > 0 ? iso(p.graceEnds) : null,
        expiration: Number(p.expiration) > 0 ? iso(p.expiration) : null,
        yes_balance: p.yesBalance.toString(),
        no_balance: p.noBalance.toString(),
        max_total_shares_at_sponsor:
          Number(p.maxTotalSharesAtSponsor) > 0 ? p.maxTotalSharesAtSponsor.toString() : null,
      },
      config,
    });
  }

  const emptyAction = "0x";
  let next = 1;

  /**
   * Submit a signal proposal (no action bytes) and return its id.
   *
   * The offering rule is inverted from the obvious reading, and getting it wrong
   * reverts either way:
   *
   *   selfSponsor  -> msg.value MUST be 0            (else SelfSponsorNoOffering)
   *   otherwise    -> msg.value MUST be == offering  (else IncorrectOffering)
   *
   * where selfSponsor is `getPriorVotes(sender, block.timestamp - 1) >=
   * _effectiveSponsorThreshold()`. A member above the threshold pays nothing —
   * their stake is the spam deterrent — so paying "to be safe" fails.
   */
  async function submit(signer: any, expiration = 0): Promise<number> {
    // Predicting selfSponsor off-chain is unreliable here for the same reason the
    // client pads its timepoint by 60s: the contract evaluates
    // `getPriorVotes(sender, block.timestamp - 1)` in the block the tx LANDS in,
    // which is later than any timestamp readable beforehand. Rather than guess,
    // send 0 and fall back to the offering when the contract says otherwise.
    try {
      await daoShip.connect(signer).submitProposal(emptyAction, expiration, "corpus", { value: 0n });
    } catch (err) {
      if (!String(err).includes("IncorrectOffering")) throw err;
      await daoShip.connect(signer).submitProposal(emptyAction, expiration, "corpus", {
        value: offering,
      });
    }
    return next++;
  }

  // ── Submitted: sponsored on submit (deployer holds > sponsorThreshold) ──
  // deployer self-sponsors, so this lands in Voting rather than Submitted.
  const votingId = await submit(deployer);
  await snapshot(votingId, "sponsored on submit, inside voting window");

  // ── Submitted: bob has no shares, so no auto-sponsor ──
  const submittedId = await submit(bob);
  await snapshot(submittedId, "unsponsored, no explicit expiration");

  // ── Expired: unsponsored with an explicit expiration that passes ──
  // `expiration` must clear block.timestamp + votingPeriod + gracePeriod or the
  // submit reverts with ExpirationTooSoon — the contract refuses a window that
  // could not fit a full voting cycle.
  const nowSec = await ethers.provider.getBlock("latest").then((b) => b!.timestamp);
  const expiresAt = nowSec + votingPeriod + gracePeriod + 60;
  const shortExpiryId = await submit(bob, expiresAt);
  await snapshot(shortExpiryId, "unsponsored, explicit expiration still in future");
  await advanceTime(votingPeriod + gracePeriod + 120);
  await snapshot(shortExpiryId, "unsponsored past explicit expiration");

  // ── Grace: voting window closed, grace still open ──
  const graceId = await submit(deployer);
  await daoShip.connect(deployer).submitVote(graceId, true);
  await advanceTime(votingPeriod + 1);
  await snapshot(graceId, "voting closed, inside grace");

  // ── Ready: quorum + majority met, grace elapsed ──
  // Process immediately. With defaultExpiryWindow == 0 the auto-expiry window is
  // 2 * (votingPeriod + gracePeriod) past graceEnds, so letting other cases
  // advance the clock first would flip this to Expired and revert with NotReady.
  await advanceTime(gracePeriod + 1);
  await snapshot(graceId, "passed quorum and majority, grace elapsed");

  await daoShip.connect(deployer).processProposal(graceId, emptyAction);
  await snapshot(graceId, "processed after passing");

  // ── Defeated: no > yes ──
  const defeatedId = await submit(deployer);
  await daoShip.connect(alice).submitVote(defeatedId, false);
  await advanceTime(votingPeriod + gracePeriod + 2);
  await snapshot(defeatedId, "majority against, past grace");

  // ── Defeated + processed: a defeated proposal formally closed with '0x' ──
  await daoShip.connect(deployer).processProposal(defeatedId, emptyAction);
  await snapshot(defeatedId, "processed after defeat");

  // ── Ready: a single voter who alone clears quorum ──
  // alice holds 50 of 150 shares; quorum is 20%, so 50 >= 30 and yes > no.
  // Originally written expecting Defeated — the chain said Ready, and the chain
  // is the specification here. Kept because a one-voter pass is a real shape.
  const oneVoterId = await submit(deployer);
  await daoShip.connect(alice).submitVote(oneVoterId, true);
  await advanceTime(votingPeriod + gracePeriod + 2);
  await snapshot(oneVoterId, "single voter above quorum, past grace");

  // ── Defeated: nobody voted, so quorum cannot be met ──
  const noVotesId = await submit(deployer);
  await advanceTime(votingPeriod + gracePeriod + 2);
  await snapshot(noVotesId, "no votes cast, past grace");

  // ── Cancelled ──
  const cancelId = await submit(deployer);
  await daoShip.connect(deployer).cancelProposal(cancelId);
  await snapshot(cancelId, "cancelled by submitter");

  // ── Unborn: an id that was never used ──
  await snapshot(9999, "never submitted");

  const outDir = path.join(__dirname, "..", "test", "fixtures");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "state-corpus.json");
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        note:
          "Generated by scripts/gen-state-corpus.ts against a local hardhat chain. "
          + "onChainState is DAOShip.state() verbatim; the client predicate must agree. "
          + "Regenerate after any change to state() or _didProposalPass().",
        generatedFrom: "DAOShip.sol",
        cases,
      },
      null,
      2,
    ) + "\n",
  );

  const tally = cases.reduce<Record<string, number>>((acc, c) => {
    acc[c.onChainState] = (acc[c.onChainState] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Wrote ${cases.length} cases to ${outFile}`);
  console.log("States covered:", tally);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
