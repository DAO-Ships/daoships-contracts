# VestingNavigator — Canonical Reference & Audit Sign-off

Source of truth for the Vesting navigator. Indexer and app integration guides live in their
own repos and reference this document; the indexer event spec is in
`docs/INDEXER-GUIDE.md` (VestingNavigator section).

- **Contract:** `contracts/navigators/VestingNavigator.sol`
- **Interface:** `contracts/interfaces/INavigator.sol`
- **Deploy script:** `scripts/deploy/008_deploy_vesting_navigator.ts`
- **Tests:** `test/unit/VestingNavigator.test.ts` (24 passing); local E2E `test/e2e/local/VestingNavigator.e2e.test.ts` (2 passing); on-chain E2E Phase 2f in `test/e2e/onchain/OnChainDAOLifecycle.test.ts`
- **Permission tier:** MANAGER (2)
- **Extends:** none — **standalone** (intentionally NOT `BaseNavigator`; see §3)

---

## 1. What it does

Mints shares **or** loot to a beneficiary on a **cliff + linear schedule**, minting *incrementally
as tokens vest*. Schedules are created by governance (the avatar, via a passed proposal); the
beneficiary (or governance) pulls vested tokens with `claim`.

### Mental model — "a mint authorization that ripens over time"

There is **no escrow**. Unvested tokens are never minted, so they carry **no voting power and no
economic weight** until claimed. The navigator simply holds the *right to mint* up to a per-schedule
`totalAmount`, and `claim` mints whatever has vested but not yet been minted. Two consequences:

- Unclaimed/unvested tokens don't exist on-chain — they can't vote, can't be ragequit, can't be transferred.
- The navigator **must keep its MANAGER permission** for claims to work. Revoking that permission
  is a fail-closed kill switch that strands every beneficiary's unclaimed vested tokens until re-granted.

### Vesting math (`_vestedAmount`)

```solidity
uint64 effectiveEnd = s.revoked ? s.revokedAt : block.timestamp;
if (effectiveEnd < s.cliffEnd) return 0;                 // before cliff → nothing
if (effectiveEnd >= s.vestingEnd) return s.totalAmount;  // at/after end → exact total (sweeps dust)
return (s.totalAmount * (effectiveEnd - s.startTime)) / (s.vestingEnd - s.startTime);  // linear from startTime
```

Accrual is **linear from `startTime`**, not from the cliff. A 1-year cliff on a 4-year vest therefore
**unlocks 25% in a lump the instant the cliff passes**, then continues linearly — standard cliff
semantics, but surprising if you expected accrual to *begin* at the cliff. `cliffDuration == vestingDuration`
is a pure 100%-at-end cliff; `cliffDuration == 0` is pure linear from start.

### One token kind per schedule

Each schedule vests shares **or** loot (`isLoot`). Vesting **shares** dilutes voting power (on claim);
vesting **loot** dilutes economic/ragequit value but not votes. To grant both, create two schedules.

---

## 2. ABI surface

### Constructor

```solidity
constructor(
    address _daoShip,          // DAOShip clone (mint target); reverts InvalidConfig if 0
    string  _name,             // optional, emitted once in NavigatorDeployed
    string  _description       // optional
)
```

The constructor only stores `daoShip` and emits `NavigatorDeployed` — it makes **no call** to the DAO,
so it is safe to deploy against a *predicted* DAO address (the launch pattern used by the on-chain E2E).

### Functions

```solidity
// Governance (avatar-only — via a passed proposal)
function createSchedule(
    address beneficiary, uint256 totalAmount, uint64 startTime,
    uint64 cliffDuration, uint64 vestingDuration, bool isLoot
) external returns (uint256 scheduleId);          // reverts IsPaused when paused
function revoke(uint256 scheduleId) external;       // freeze accrual at block.timestamp (non-destructive)

// Beneficiary OR avatar
function claim(uint256 scheduleId) external;        // mints vested-but-unclaimed TO THE BENEFICIARY

// Pause creation of new schedules (does NOT affect claim/revoke)
function pause() external;                           // GOVERNOR navigator OR avatar
function unpause() external;                         // GOVERNOR navigator OR avatar

// Views
function vested(uint256 scheduleId) external view returns (uint256);
function claimable(uint256 scheduleId) external view returns (uint256);
function getSchedules(address beneficiary) external view returns (uint256[] memory);
function schedules(uint256 scheduleId) external view returns (...);  // public struct getter
function scheduleCount() external view returns (uint256);
function paused() external view returns (bool);
// + INavigator: deployer(), navigatorType() == "VestingNavigator", daoShip()
```

`createSchedule` validates: `beneficiary != 0` (`InvalidBeneficiary`), `totalAmount > 0` (`ZeroAmount`),
`vestingDuration > 0` (`InvalidConfig`), `cliffDuration <= vestingDuration` (`CliffExceedsVesting`).
`startTime == 0` means "now"; non-zero may be back- or future-dated (see §4, gotcha 3).

### Events

```solidity
event ScheduleCreated(uint256 indexed scheduleId, address indexed beneficiary, uint256 totalAmount,
                      uint64 startTime, uint64 cliffEnd, uint64 vestingEnd, bool isLoot);
event TokensClaimed(uint256 indexed scheduleId, address indexed beneficiary, uint256 amount, bool isLoot);
event ScheduleRevoked(uint256 indexed scheduleId, address indexed caller, uint64 revokedAt, uint256 vestedAtRevoke);
event Paused(address indexed caller);
event Unpaused(address indexed caller);
event NavigatorDeployed(address indexed daoShip, address indexed deployer, string navigatorType, string name, string description);
```

`TokensClaimed.amount` is the **incremental** amount minted in that claim, **not** cumulative — sum
across claims. Each claim also fires a DAO `MintShares`/`MintLoot` + token `Transfer` in the same tx:
take **balances from `Transfer`** and treat `TokensClaimed` as the vesting-activity feed (don't double-count).

### Errors

`InvalidConfig`, `NotAuthorized`, `IsPaused`, `InvalidBeneficiary`, `ZeroAmount`, `CliffExceedsVesting`,
`ScheduleDoesNotExist`, `NothingToClaim`, `AlreadyRevoked`.

---

## 3. Why standalone (not BaseNavigator)

`BaseNavigator` keys its `mintCap`/`perAddressCap` accounting to `msg.sender`. Here `claim` may be
called by the **beneficiary or the avatar**, so a `msg.sender`-keyed cap would mis-attribute (split a
beneficiary's cap across two callers). Dilution is instead bounded **per schedule** by the
governance-set `totalAmount`. Struct fields are ordered for storage packing (4 slots, not 5).

**Implication:** there is **no global dilution cap** — `totalAmount` per schedule is the only bound.
N schedules of M each dilute supply by N×M with no contract-level ceiling. Governance must size grants
against current supply at proposal-review time.

---

## 4. Gotchas (read this)

1. **Claims die if you revoke the navigator's MANAGER bit.** Removing its permission is a fail-closed
   kill switch — but it strands every beneficiary's unclaimed vested tokens until you re-grant it.
   Don't yank MANAGER as a "pause"; use `pause()` (which only blocks new schedules) or `revoke` per schedule.
2. **The cliff is a delayed unlock of accrued-since-start, not "start accruing at the cliff."** See the
   25%-at-cliff example in §1. Plan grant terms accordingly.
3. **Back-dating bypasses the cliff entirely.** `startTime` may be in the past, so a schedule can be
   **immediately partially or fully claimable** with no cliff protection. It's avatar-only (governance's
   choice), but proposal reviewers should flag a back-dated `startTime`.
4. **Revoke is non-destructive and timing-sensitive.** It freezes accrual at *that block's* timestamp;
   whatever vested up to then stays claimable forever, and a beneficiary who `claim`s right before a
   `revoke` keeps it. **True clawback is a separate governance `burnShares`/`burnLoot` call.**
5. **`pause` only blocks `createSchedule`.** It does not stop existing claims or revokes. To stop a
   specific schedule, `revoke` it. There is no global "freeze all claims."
6. **Voting power activates on `claim`, not on `vest`.** A beneficiary controls *when* their (share)
   voting power turns on by choosing when to claim. Track *claimed/minted* balances for real power, not
   "vested." Claimed shares are normal tokens — transferable and **ragequit-able immediately** (vesting
   does not post-lock them).
7. **Beneficiary address is immutable.** Lost keys can't be redirected — the only recourse is `revoke`
   (no clawback of already-minted) plus a fresh schedule to a new address.
8. **Mid-vest amounts round down (integer-division dust); the final claim is exact.** The at/after-`vestingEnd`
   branch returns the full `totalAmount`, so nobody loses dust by the end.
9. **`claim` mints to the schedule's beneficiary regardless of caller.** The avatar can force-distribute,
   but tokens always go to the beneficiary, never the caller.

---

## 5. Security audit sign-off

No Critical/High/Medium open against the contract.

| Lens | Outcome |
|---|---|
| Blockchain Security Auditor (access control / reentrancy / vesting math / revoke accounting) | No Crit/High/Med. CEI verified (`claimed` updated before mint); `nonReentrant` on `createSchedule`/`claim`/`revoke`; mint tokens have no callbacks; uint64 timestamp math is checked (overflows revert, never wrap). |
| Adversarial re-review of the flagged `claimed` underflow on revoke | **False positive.** Vesting is monotonic in `effectiveEnd` and `revokedAt ≥` every prior claim time, so `vested(revokedAt) ≥ claimed` always holds — `claimable`/`claim` cannot underflow. The non-destructive revoke is documented-intentional, not a bug. |

**Verified properties:** reentrancy closed; `claimed` never exceeds `vested` or `totalAmount`
(monotone-partial-claims invariant test); revoke freezes accrual without trapping the pre-revoke vested
portion; claims succeed after revoke and while paused (vested funds are never trapped); views revert
`ScheduleDoesNotExist` on unknown ids rather than returning garbage; losing MANAGER fails claims closed
(rolls back cleanly via CEI).

**Operational caveats (configuration, not contract defects):** no global dilution cap (size `totalAmount`
vs supply — §3); back-dating bypasses the cliff (§4.3); revoke does not claw back already-minted tokens (§4.4).

**Verdict:** Production-ready. The caveats above are governance/configuration concerns.

---

## 6. Deployment

`scripts/deploy/008_deploy_vesting_navigator.ts` (env-configured). After deploy, register as MANAGER
(permission `2`) via a `setNavigators` governance proposal. Each navigator is bound to one DAOShip clone
and is immutable — change behavior by deploying a new instance and re-registering. Create grants with
`createSchedule` (avatar-only); batch many grants in one proposal via MultiSend.
