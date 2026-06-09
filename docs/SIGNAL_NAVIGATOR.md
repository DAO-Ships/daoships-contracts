# SignalNavigator — Canonical Reference & Audit Sign-off

Source of truth for the Signal navigator. Indexer and app integration guides live in their
own repos and reference this document; the indexer event spec is in
`docs/INDEXER-GUIDE.md` (SignalNavigator section).

- **Contract:** `contracts/navigators/SignalNavigator.sol`
- **Interface:** `contracts/interfaces/INavigator.sol` (deployer identity + `NavigatorDeployed`)
- **Deploy script:** `scripts/deploy/006_deploy_signal_navigator.ts`
- **Tests:** `test/unit/SignalNavigator.test.ts` (37 passing); local E2E `test/e2e/local/SignalNavigator.e2e.test.ts` (5 passing); on-chain E2E Phase 2e in `test/e2e/onchain/OnChainDAOLifecycle.test.ts`
- **Permission tier:** **NONE (0)** — holds no permission bit, never mutates the DAO (see §1)
- **Extends:** none — **standalone** (intentionally NOT `BaseNavigator`; no caps/allowlist/pause/mint helper apply)

---

## 1. What it does

Runs **non-executing, share-weighted governance polls** ("temperature checks"). A member calls
`createPoll`, others `vote`, and anyone reads the running tally with `getResults`. That is the
whole contract.

### This navigator is the odd one out — read this first

- **No permission. Ever.** It holds **no** `navigators[addr]` bitmask bit (`ADMIN`/`MANAGER`/`GOVERNOR`).
  It never calls a mutating function on `DAOShip` — it only **reads** delegation-aware voting power via
  `daoShip.getPriorVotes()` and the `daoShip.avatar()` address, and records votes in its own storage.
  It therefore needs **no `setNavigators` grant to function** — "deploy and use" (see §6).
- **Polls are non-binding.** There is **no on-chain execution path**. A poll result mints nothing,
  burns nothing, queues nothing, executes nothing. The output is a tally in this contract's storage
  for humans and frontends to read. The worst case of a bug here is a *mis-tallied non-binding poll*.
- **No ReentrancyGuard, no pause.** There are no value transfers and no untrusted external calls
  (`getPriorVotes`/`avatar` target the trusted, governance-bound `DAOShip`), so there is nothing to
  re-enter and nothing to freeze. See §4 for why this is safe rather than an omission.

### Trust model — functions unsanctioned, but endorsement is a separate signal

Because it holds no permission, a SignalNavigator is **never registered via `setNavigators()` and
emits no `NavigatorSet`**. Its DAO association comes **only** from the indexed `daoShip` field in its
`NavigatorDeployed` event — which is **self-asserted** (anyone can deploy a contract claiming any
DAO). The contract still **functions** without any sanctioning.

To be **officially endorsed** (surfaced by default in indexers/frontends rather than flagged
"unverified"), the DAO passes a governance proposal that has the **vault post a
`daoships.dao.navigators` allowlist** naming the navigator address. That post is authenticated
(`msg.sender == vault`), **grants zero permission**, and is purely a trust signal — it changes how
the poll is *displayed*, not what the contract can *do*. See `docs/NAVIGATORS.md` (SignalNavigator
section), `docs/POSTER.md → DAO Sanctioned Navigators`, and `docs/INDEXER-GUIDE.md`. This sanctioning
path is the model for all future read-only (no-permission) navigators.

### Share-weighted, loot excluded

Vote weight is `daoShip.getPriorVotes(voter, snapshotTimestamp)` — the same delegation-aware **shares**
voting power that binding DAOShip proposals use. **Loot carries no weight** (loot is non-voting by
construction in DAOShip). A voter with zero shares power at the snapshot reverts `NoVotingPower`.

### Snapshot at poll start — anti vote-buying

Voting power is measured at **poll start, not poll creation**. Each poll stores
`snapshotTimestamp = votingStarts - 1`, and votes are weighted by `getPriorVotes(voter, snapshotTimestamp)`.

The safety argument is exact and requires no keeper/activation transaction:

- `vote()` requires `block.timestamp >= votingStarts`.
- The DAO's underlying `getPriorVotes` reverts unless `timepoint < block.timestamp`
  (`contracts/tokens/DAOShipVotes.sol`: `require(timepoint < block.timestamp, "DAOShipVotes: not yet determined")`).
- Since `snapshotTimestamp = votingStarts - 1 < votingStarts <= block.timestamp` at vote time, the
  snapshot is **always strictly in the past**, so `getPriorVotes` never reverts on its timepoint guard.
  The snapshot point is defined at start-time and resolved **lazily on the first vote**.

**Consequence:** shares acquired (or delegations received) *after* voting opens carry no weight, but
anything settled *before* `votingStarts` counts — giving scheduled polls a lead window to organize
delegation. This defeats buying votes mid-poll.

### Two distinct snapshots, by design

- **Creation gating** measures the *creator's* power at `block.timestamp - 1` (you must already hold
  `minSharesToCreatePoll` to open a poll *today*).
- **The poll's voting snapshot** is at `votingStarts - 1` (which may be in the future at creation time
  and therefore unqueryable then — which is exactly why gating uses `now - 1` instead).

### Scheduling

`startTime == 0` opens the poll **immediately** (`votingStarts = block.timestamp`). Otherwise the poll
is **scheduled**: `block.timestamp <= startTime <= block.timestamp + maxStartDelay`. A
`maxStartDelay == 0` forbids scheduling (immediate-only polls).

### Lifecycle (`pollStatus`)

Derived purely from timestamps + the `cancelled` flag: `Pending` (before `votingStarts`) →
`Active` (`[votingStarts, votingEnds)`) → `Ended` (at/after `votingEnds`); `Cancelled` short-circuits
all of the above.

---

## 2. ABI surface

### Constructor

```solidity
constructor(
    address _daoShip,               // DAOShip clone (read-only); reverts InvalidConfig if 0
    uint256 _minSharesToCreatePoll, // min voting power at creation to open a poll (0 = anyone with power)
    uint64  _minDuration,           // min voting-window seconds; reverts InvalidConfig if 0
    uint64  _maxDuration,           // max voting-window seconds; reverts InvalidConfig if < _minDuration or > MAX_WINDOW
    uint64  _maxStartDelay,         // max scheduling lead seconds (0 = immediate-only); reverts InvalidConfig if > MAX_WINDOW
    string  _name,                  // optional, emitted once in NavigatorDeployed
    string  _description            // optional
)
```

The constructor only stores config and emits `NavigatorDeployed` — it makes **no call** to the DAO,
so it is safe to deploy against a *predicted* DAO address (the launch pattern used by the on-chain E2E).
Constructor reverts (`InvalidConfig`) when: `_daoShip == 0`; `_minDuration == 0`;
`_maxDuration < _minDuration`; `_maxDuration > MAX_WINDOW`; or `_maxStartDelay > MAX_WINDOW`.
`MAX_WINDOW == 3650 days` (overflow backstop for the `uint64` timestamp math and a sanity gate).

### Functions

```solidity
// Write — open to any member meeting the creation threshold (NO governance/avatar gate)
function createPoll(
    string  calldata question,   // IPFS hash or short text
    uint8   optionCount,         // MIN_OPTIONS(2)..MAX_OPTIONS(10)
    uint64  startTime,           // 0 = now; else now..now+maxStartDelay
    uint64  duration             // minDuration..maxDuration
) external returns (uint256 pollId);

function vote(uint256 pollId, uint8 option) external; // share-weighted; one vote per address per poll
function cancelPoll(uint256 pollId) external;          // creator-or-avatar before start, avatar-only after (see §4)

// Views
function getResults(uint256 pollId) external view returns (uint256[] memory); // tally indexed by option
function getOptionVotes(uint256 pollId, uint8 option) external view returns (uint256);
function hasVoted(uint256 pollId, address voter) external view returns (bool);
function pollStatus(uint256 pollId) external view returns (Status);            // Pending/Active/Ended/Cancelled
function polls(uint256 pollId) external view returns (...);                    // scalar fields only (mappings omitted)
function pollCount() external view returns (uint256);                          // also the id of the next poll
// Immutable config getters: daoShip(), minSharesToCreatePoll(), minDuration(), maxDuration(), maxStartDelay()
// Constants: MIN_OPTIONS()==2, MAX_OPTIONS()==10, MAX_WINDOW()==3650 days
// INavigator: deployer(), navigatorType() == "SignalNavigator"
```

`createPoll` validates: `MIN_OPTIONS <= optionCount <= MAX_OPTIONS` (`InvalidOptionCount`);
`minDuration <= duration <= maxDuration` (`InvalidDuration`); a non-zero `startTime` within
`[block.timestamp, block.timestamp + maxStartDelay]` (`InvalidStartTime`); and that the **creator**
holds `>= minSharesToCreatePoll` voting power at `block.timestamp - 1` (`InsufficientShares`).
Pollids are sequential from `0` (`pollId = pollCount++`).

`vote` enforces the **half-open window `[votingStarts, votingEnds)`** — votable at exactly
`votingStarts`, closed at exactly `votingEnds` (matching `DAOShip.castVote` semantics) — rejects
cancelled polls (`PollIsCancelled`), out-of-range options (`InvalidOption`), double votes
(`AlreadyVoted`), and zero-weight voters (`NoVotingPower`). The `polls(id)` getter and all views
revert `PollDoesNotExist` for any `pollId >= pollCount`.

### Events

```solidity
event PollCreated(
    uint256 indexed pollId, address indexed creator, string question, uint8 optionCount,
    uint64 snapshotTimestamp, uint64 votingStarts, uint64 votingEnds
);
event Voted(uint256 indexed pollId, address indexed voter, uint8 indexed option, uint256 weight);
event PollCancelled(uint256 indexed pollId, address indexed caller);
// INavigator (constructor, once)
event NavigatorDeployed(address indexed daoShip, address indexed deployer, string navigatorType, string name, string description);
```

`Voted.weight` is the voter's **snapshot** voting power (at `votingStarts - 1`), and is the exact
amount added to `optionVotes[option]` — indexers can reconstruct any tally by summing `Voted.weight`
per option, or read `getResults` directly. There are **no token `Transfer`/`Mint`/`Burn` events** from
this navigator (it mints/transfers nothing).

### Errors

`InvalidConfig`, `InsufficientShares`, `InvalidOptionCount`, `InvalidDuration`, `InvalidStartTime`,
`PollDoesNotExist`, `PollNotStarted`, `PollHasEnded`, `PollIsCancelled`, `AlreadyVoted`,
`InvalidOption`, `NoVotingPower`, `NotAuthorized`.

---

## 3. Configuration guidance

- **`minSharesToCreatePoll` is the only spam control.** Poll *creation* is permissionless (any address
  meeting the threshold) — there is no avatar/governance gate on opening a poll. Set it to a meaningful
  shares amount (in QUAI units) to keep the poll list clean; `0` lets anyone with *any* voting power
  open a poll. Voting itself always requires non-zero snapshot power regardless of this setting.
- **`minDuration` / `maxDuration` bound the voting window.** `minDuration` must be `> 0`;
  `maxDuration >= minDuration` and `<= MAX_WINDOW (3650 days)`. The deploy script defaults are
  `minDuration = 3600` (1h) and `maxDuration = 2592000` (30d). Short windows (24–48h) are the typical
  temperature-check cadence.
- **`maxStartDelay` enables (or forbids) scheduling.** `0` = immediate-only polls. A positive value
  (deploy default `2592000`, 30d) lets creators schedule a future `startTime`, which is what gives a
  poll a pre-start **lead window** for delegation to settle into the start-time snapshot.
- **Immediate-poll snapshot caveat.** For an immediate poll, `snapshotTimestamp == block.timestamp - 1`,
  so holders whose **first checkpoint is the creation block** (e.g. shares minted in the same block)
  read as `0` at the snapshot and **cannot vote**. To include same-block mints, schedule the poll (or
  wait a block) before opening.
- **No mintCap / perAddressCap / allowlist / expiry.** Those `BaseNavigator` knobs do not exist here —
  this navigator never mints and never gates membership. Configuration is purely about *who can open a
  poll* and *how long polls run*.
- **There is nothing to register and nothing to revoke for it to work.** To officially *endorse* a
  deployed instance, use the vault-posted `daoships.dao.navigators` allowlist (§1, trust model), not
  `setNavigators`.

---

## 4. Gotchas (read this)

1. **Cancel access control flips at `votingStarts`.** Before voting opens, **the creator or the
   avatar** may cancel. Once voting has opened, **only the avatar** may cancel — so a creator who is
   *losing* an in-progress poll cannot nuke it. Neither party can cancel a poll that has **ended**
   (`block.timestamp >= votingEnds` reverts `PollHasEnded`), and a cancelled poll cannot be
   re-cancelled (`PollIsCancelled`).
2. **No ReentrancyGuard is by design, not an omission.** The only external calls are
   `daoShip.getPriorVotes()` and `daoShip.avatar()` against the trusted DAO; there are no value
   transfers and no callbacks into attacker code. Even a hypothetical re-entry could only touch this
   contract's non-binding tally — it cannot mint, burn, pause, or alter governance. The worst case
   remains a *mis-tallied non-binding poll*.
3. **Snapshot is at start, so post-start acquisitions don't count.** Shares bought or delegations
   received *after* `votingStarts` carry **zero** weight. Conversely, a scheduled poll's pre-start
   window *does* count — design poll timing with this in mind.
4. **The window is half-open `[votingStarts, votingEnds)`.** Votable at exactly `votingStarts`,
   **closed** at exactly `votingEnds` (the last votable second is `votingEnds - 1`). The window is
   therefore exactly `duration` seconds. `pollStatus` uses the same bounds.
5. **Creation gating and voting use different snapshots.** Meeting `minSharesToCreatePoll` at creation
   (`now - 1`) does **not** guarantee the creator can later vote — voting weight is read at
   `votingStarts - 1`. A creator who divests before the poll opens can open a poll they cannot vote in.
6. **Loot never votes.** Only delegation-aware **shares** power counts. A loot-heavy / shares-light
   member may revert `NoVotingPower`. This mirrors binding DAOShip governance.
7. **`question` is opaque on-chain.** It is stored/emitted verbatim (IPFS hash or short text) and is
   **not** validated; option *labels* are off-chain — the contract only knows option **indices**
   `0..optionCount-1`. Frontends own the index→label mapping.
8. **Self-asserted DAO binding.** A deployed instance claiming your DAO is not proof of endorsement.
   Trust only instances on the DAO's vault-posted `daoships.dao.navigators` allowlist (§1).

---

## 5. Security audit sign-off

The formal `docs/AUDIT_REPORT.md` (initial audit 2026-04-11) **predates this contract** and does
**not** list `SignalNavigator` in its scope (§2 of that report). The sign-off below reflects the
navigator-specific three-lens review recorded in `docs/NAVIGATORS.md` (SignalNavigator section); there
is no separate `SECURITY_GUIDE.md` entry for this navigator.

| Lens | Outcome |
|---|---|
| Three-lens review (security / gas / correctness), per `docs/NAVIGATORS.md` | **No Critical/High issues.** Hardening applied: `MAX_WINDOW` constructor caps; same-block-snapshot behavior documented; expanded boundary and multi-poll tests. |

**Verified properties (grounded in source + tests):**

- **No permission, no mutation.** The contract calls only `daoShip.getPriorVotes()` (view) and reads
  `daoShip.avatar()` (public state getter). It holds no `navigators[addr]` bit and cannot mint, burn,
  pause, or move value. The blast radius of any bug is a non-binding tally.
- **Snapshot never reverts the vote.** `snapshotTimestamp = votingStarts - 1` combined with the
  `vote()` guard `block.timestamp >= votingStarts` guarantees `timepoint < block.timestamp`, satisfying
  `DAOShipVotes.getPriorVotes`'s `require(timepoint < block.timestamp)` on every vote. No keeper or
  activation tx is required.
- **Anti vote-buying.** Weight is fixed at the start-time snapshot; post-open acquisitions carry zero
  weight (`test/e2e/local`: delegation re-snapshot moves weight; post-snapshot shares do not).
- **One vote per address per poll** (`voted[msg.sender]` guard), **share-only weight** (loot excluded —
  local E2E), and **half-open window** boundaries (votable at exactly `votingStarts`, closed at exactly
  `votingEnds`) are test-covered.
- **Cancel rule enforced:** creator-or-avatar before start, avatar-only after start, never after end
  (unit-tested).
- **Views fail safe:** unknown `pollId` reverts `PollDoesNotExist` rather than returning garbage;
  out-of-range option reverts `InvalidOption`.
- **`uint64` timestamp math is bounded** by `MAX_WINDOW (3650 days)` on both `duration` and
  `maxStartDelay`, keeping `votingStarts + duration` and `block.timestamp + maxStartDelay` clear of
  overflow.

**Operational caveats (configuration/trust, not contract defects):** poll creation is permissionless
above `minSharesToCreatePoll` (size it for spam, §3); DAO binding is self-asserted until the vault
posts the `daoships.dao.navigators` allowlist (§1); immediate-poll snapshots exclude same-block mints (§3).

**Verdict:** Production-ready for its scope — a read-only, non-binding polling tool. The caveats above
are governance/trust-model concerns, not contract defects.

---

## 6. Deployment

`scripts/deploy/006_deploy_signal_navigator.ts` (env-configured: `DAOSHIP_ADDRESS`,
`SIGNAL_MIN_SHARES_TO_CREATE`, `SIGNAL_MIN_DURATION`, `SIGNAL_MAX_DURATION`, `SIGNAL_MAX_START_DELAY`,
`SIGNAL_NAME`, `SIGNAL_DESCRIPTION`).

**No permission step.** Unlike every other navigator, there is **no `setNavigators` governance
proposal** to run — the script deploys and members can call `createPoll`/`vote` immediately. To make
the DAO **officially endorse** the instance (so indexers/frontends surface it as trusted rather than
"unverified"), pass a governance proposal that has the vault post the navigator's address to the
`daoships.dao.navigators` allowlist (§1) — that post grants zero permission and only affects display.

Each navigator is bound to one DAOShip clone and is immutable (constructor-set config) — change
behavior by deploying a new instance and (if endorsed) re-posting the allowlist entry.
