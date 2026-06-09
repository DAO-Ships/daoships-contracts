# DAO Ships Navigator Reference

Navigators are permissioned extension contracts that extend DAOShip's governance kernel. DAOShip.sol handles proposals, voting, share accounting, and ragequit. Everything else belongs in navigators.

---

## Permission System

Navigator permissions are additive bitmasks stored in `DAOShip.navigators(address)`:

| Bit | Value | Role | DAOShip Functions Unlocked |
|-----|-------|------|---------------------------|
| 0 | **1** | ADMIN | `setAdminConfig(bool pauseShares, bool pauseLoot)` -- pause/unpause token transfers |
| 1 | **2** | MANAGER | `mintShares`, `mintLoot`, `burnShares`, `burnLoot`, `convertSharesToLoot` -- all take `(address[], uint256[])` |
| 2 | **4** | GOVERNOR | `setGovernanceConfig(bytes)` -- encodes `(uint32 votingPeriod, uint32 gracePeriod, uint256 proposalOffering, uint256 quorumPercent, uint256 sponsorThreshold, uint256 minRetentionPercent, uint32 defaultExpiryWindow)`. Also `cancelProposal(uint32 id)`. |

Combined values: `3` = ADMIN+MANAGER, `6` = MANAGER+GOVERNOR, `7` = full access. Permission `0` revokes all access. Values above `7` are rejected with `InvalidPermission()` — only bits 0-2 are valid.

**governanceOnly functions** (`setNavigators`, `setGuildTokens`) are only callable via `executeAsGovernance` during proposal processing -- no navigator permission grants access.

**Vault execution:** `IAvatar(avatar).execTransactionFromModule(to, value, data, operation)` requires the caller to be an enabled module on the vault.

**Navigator locks are one-way.** `lockAdmin()`, `lockManager()`, and `lockGovernor()` are irreversible. Once locked, no new navigators can be granted that role. Existing navigators with a locked role can still be revoked. Even if all navigators with a locked role are revoked, governance proposals can still call those functions via `executeAsGovernance`.

---

## Common Patterns

All navigators MUST implement `INavigator` (`contracts/interfaces/INavigator.sol`) and follow these patterns established by the shipped navigators:

- **`INavigator` interface** — Required. All navigators MUST implement this interface, which requires:
  - `address public immutable deployer` — set to `msg.sender` in the constructor. The indexer uses this to verify Poster metadata authorship.
  - `string public constant navigatorType = "YourNavigatorName";` — Compile-time constant. The indexer calls this once at discovery time to identify the navigator type.
  - `NavigatorDeployed(address indexed daoShip, address indexed deployer, string navigatorType, string name, string description)` — Emitted exactly once in the constructor. This is the canonical source of navigator metadata. The `name` and `description` parameters are optional (can be empty strings) and are only emitted in the event, not stored on-chain.
- `DAOShip public immutable daoShip` stored at construction
- Constructor accepts optional `string memory _name` and `string memory _description` as the final parameters
- `ReentrancyGuard` on all state-changing external functions
- `mintCap` and `perAddressCap` if minting tokens
- Immutable config variables where possible
- Pause mechanism controllable by DAO governance (GOVERNOR or avatar)
- `SafeERC20` for all token transfers
- Custom errors for gas efficiency
- NatSpec documenting permission requirements
- No upgradeable proxies — change config by deploying a new navigator and registering via governance proposal

---

## Shipped Navigators

### OnboarderNavigator (MANAGER)

> **Canonical reference:** [`docs/ONBOARDER_NAVIGATOR.md`](ONBOARDER_NAVIGATOR.md) — full ABI, gotchas, and audit sign-off.

**What it does:** Instant onboarding via native token (QUAI) tribute. Members send QUAI, receive shares/loot atomically.

**Key features:** Dual pricing (multiplier or fixed-price), Merkle allowlist, mintCap, perAddressCap, expiry, pause, refund handling, stuck native token recovery (`withdrawStuckETH`). Implements `INavigator` with `deployer` immutable and `NavigatorDeployed` event.

**Why DAO Ships needs this:** `mintShares` requires MANAGER permission. Without a navigator, every new member would need a governance proposal to mint their shares -- impossible at scale.

**Deployed address:** `0x0031C843A919dFc022DeA5A809B693009A29464b` (Cyprus1 Orchard Testnet)

### ERC20TributeNavigator (MANAGER)

> **Canonical reference:** [`docs/ERC20_TRIBUTE_NAVIGATOR.md`](ERC20_TRIBUTE_NAVIGATOR.md) — full ABI, gotchas, and audit sign-off.

**What it does:** Instant onboarding via ERC20 token tribute. Accepts any configured ERC20, transfers to vault, mints shares/loot. Supports ERC-2612 permit for single-transaction onboarding (sign + onboard instead of approve + onboard).

**Key features:** Per-token pricing, fee-on-transfer detection (balance before/after check), SafeERC20, ERC-2612 permit support via `onboardWithPermit()`, same cap/allowlist/expiry/pause as OnboarderNavigator. Implements `INavigator` with `deployer` immutable and `NavigatorDeployed` event.

**ERC-2612 Permit support:** For tokens that implement ERC-2612 (USDC, most modern ERC20s), users can sign a gasless permit message and call `onboardWithPermit()` in a single transaction -- eliminating the separate `approve()` tx. The permit call is wrapped in try/catch per OpenZeppelin's recommended pattern, so it gracefully handles front-running, retries, and non-permit tokens. Frontend should detect permit support by probing `nonces()` on the tribute token.

**Why DAO Ships needs this:** Same as OnboarderNavigator -- `mintShares` requires a proposal without a MANAGER navigator.

---

## Why Not TributeMinion?

Upstream zodiacBaal includes TributeMinion -- a proposal-gated escrow for membership admission. The applicant's tribute is escrowed while existing members vote on whether to admit them. DAO Ships' instant onboarding approach is better for most configurations:

| Aspect | TributeMinion (Upstream) | OnboarderNavigator (DAO Ships) |
|--------|------------------------|----------------------|
| Admission speed | votingPeriod + gracePeriod (days-weeks) | Instant (one transaction) |
| Per-applicant discretion | Full governance vote | Algorithmic (caps, allowlist, price) |
| Throughput | ~3 admissions/month (sequential) | Unlimited (parallel) |
| Governance overhead | One proposal per applicant | Zero proposals |
| Whale protection | Vote to reject | perAddressCap, mintCap |
| KYC/compliance | Proposal description links to verification | Merkle allowlist (curated off-chain) |

**When TributeMinion would be needed:** Only for negotiated-terms admission (each applicant at a different price/share ratio) or hostile-applicant defense (blocking a specific actor who meets all algorithmic criteria). Both scenarios can be handled via `executeAsGovernance` governance proposals that call `mintShares` directly -- no dedicated TributeMinion contract required.

**Recommendation:** Do not build a TributeMinion. The combination of OnboarderNavigator (instant, capped) + Merkle allowlist (curated membership) + governance proposals via `executeAsGovernance` (ad-hoc admission) covers all use cases without the escrow complexity and governance bottleneck.

---

## Planned Navigators

### Priority 1: Blocking for Protocol/Investment DAOs

#### TimelockNavigator (GOVERNOR) — **SHIPPED**

> **Canonical reference:** [`docs/TIMELOCK_NAVIGATOR.md`](TIMELOCK_NAVIGATOR.md) — full ABI, gotchas, and audit sign-off.

**What it does:** Wraps `setGovernanceConfig` behind a mandatory delay. When governance passes a parameter change, it is queued for N hours/days before taking effect. Members who disagree can ragequit during the delay.

**Why DAO Ships needs this:** `setGovernanceConfig` takes effect immediately upon proposal processing. A compromised GOVERNOR navigator can set `gracePeriod=0, quorumPercent=0` in one transaction, stripping all minority protections instantly.

**Why it matters at 1000+ members:** Not every member monitors every proposal. A 48-hour timelock gives the community, delegates, and watchdogs time to raise alarms about dangerous parameter changes even after they pass. Every major DeFi protocol with significant TVL uses timelocks -- Compound, Aave, Uniswap.

**Permission:** GOVERNOR (4). Routes parameter changes through the timelock instead of directly to DAOShip.

**Urgency:** Non-negotiable at $1M+ treasury.

**Architecture:** The navigator is registered as a GOVERNOR on DAOShip. By convention, governance proposals no longer call `daoShip.setGovernanceConfig()` directly -- instead they call `timelockNavigator.queueChange(bytes governanceConfig)`. After `delay` seconds elapse, anyone can call `executeChange(uint256 changeId, bytes governanceConfig)` to forward the config to DAOShip. No DAOShip code changes required.

The delay is additive to the existing proposal lifecycle: `votingPeriod` -> `gracePeriod` -> proposal processed (calls `queueChange`) -> `delay` (second ragequit window) -> `executeChange`. Members see the exact parameters that will take effect and can exit before they do.

**Config storage is hash-only.** Only `keccak256(governanceConfig)` is stored on-chain (gas). The full config bytes are emitted in `ChangeQueued` and must be re-supplied to `executeChange`, where they are hash-checked. The navigator does not decode or validate the config — `DAOShip.setGovernanceConfig` validates it at execute time, so a malformed config simply cannot be executed and expires harmlessly (the `executed` flag is set before the forward call and rolled back by EVM atomicity on revert — no lock-out).

> **⚠️ Advisory, not enforced.** The timelock cannot be made mandatory at the contract layer. A governance proposal can always bypass it and call `setGovernanceConfig` directly via `DAOShip.executeAsGovernance`, because that path runs the inner call as `msg.sender == address(daoShip)`, which `onlyGovernor` accepts. `lockGovernor()` does **not** close this — governance reaches governor functions through `executeAsGovernance` regardless of navigator locks. So the guarantee is:
> - **Enforced** against a rogue/buggy GOVERNOR *navigator* (it can only queue delayed, cancellable, visible changes) — provided the timelock is the only GOVERNOR navigator granted.
> - **Advisory** against a malicious *proposal* — a proposal author can route around it. "All config changes go through the timelock" is enforced in the **app** (the dapp routes config changes through `queueChange`) and surfaced by the **indexer** (elevate a warning on any proposal that calls `setGovernanceConfig` directly on a timelock-enabled DAO). Making it truly mandatory would require a DAOShip change and is out of scope for a navigator.

**State variables:**

```solidity
DAOShip public immutable daoShip;
uint256 public immutable delay;          // e.g., 48 hours in seconds
uint256 public immutable expiryWindow;   // how long after delay a queued change remains executable

struct QueuedChange {
    bytes32 configHash;      // keccak256 of the governance config bytes
    uint64 queuedAt;
    uint64 executableAfter;  // queuedAt + delay
    uint64 expiresAt;        // executableAfter + expiryWindow
    address queuedBy;
    bool executed;
    bool cancelled;
}

uint256 public changeCount;
mapping(uint256 => QueuedChange) public queuedChanges;
bool public paused;
```

**Constructor:** `address _daoShip, uint256 _delay, uint256 _expiryWindow`. Validations: `_delay >= 10 minutes` (`MIN_DELAY`), `_delay <= 30 days` (`MAX_DELAY`), `_expiryWindow` in `[1 hours, 3650 days]`.

> **Sizing the delay.** `MIN_DELAY` (10 min) is only a sanity floor — it guarantees a queued change is *observable* before it executes, not that members have time to react. It is **not** a protective window. The `gracePeriod` already gives every proposal its first ragequit window; for this navigator's delay to be a meaningful *second* exit window it must be sized in days. Production DAOs should pass at least `RECOMMENDED_DELAY` (2 days, advisory — matches common practice like Compound's 2-day floor). The contract enforces only `MIN_DELAY`; the dapp/indexer warn on sub-`RECOMMENDED_DELAY` deployments.

**Key functions:**

```solidity
function queueChange(bytes calldata _governanceConfig) external returns (uint256 changeId);
function executeChange(uint256 changeId, bytes calldata _governanceConfig) external;
function cancelChange(uint256 changeId) external;
function emergencyCancelAll() external;
```

- `queueChange` -- restricted to `msg.sender == daoShip.avatar()` (only via governance proposal). Reverts `IsPaused` when paused. Stores `keccak256(_governanceConfig)` (not full bytes -- gas optimization); emits full bytes in `ChangeQueued`.
- `executeChange` -- permissionless after delay (`nonReentrant`). Verifies the change exists, is not executed/cancelled, is within `[executableAfter, expiresAt]`, and that the supplied bytes hash to the stored hash. Calls `daoShip.setGovernanceConfig(_governanceConfig)`. Not blocked by pause (use cancel/emergencyCancelAll to stop pending changes).
- `cancelChange` -- avatar only.
- `emergencyCancelAll` -- GOVERNOR or avatar. Cancels all pending changes and pauses. Bounded by `changeCount`, which grows slowly (one full multi-day proposal per queued change).
- `pause` / `unpause` -- GOVERNOR or avatar. Pause blocks new `queueChange` calls only.
- `isExecutable(changeId)` view -- true iff the change is ready, unexpired, and not executed/cancelled (for frontends/keepers).

**Events:** `ChangeQueued`, `ChangeExecuted`, `ChangeCancelled`, `Paused`, `Unpaused`.

**Custom errors:** `InvalidConfig`, `NotAuthorized`, `IsPaused`, `ChangeNotReady`, `ChangeExpired`, `ChangeAlreadyExecuted`, `ChangeAlreadyCancelled`, `ConfigHashMismatch`, `DelayTooShort`, `DelayTooLong`.

**Test scenarios:**

1. Happy path: queue via avatar, wait delay, execute, verify DAOShip config updated
2. Revert: execute before delay elapsed -> `ChangeNotReady`
3. Revert: execute after expiryWindow -> `ChangeExpired`
4. Revert: hash mismatch -> `ConfigHashMismatch`
5. Cancel: avatar cancels, execution reverts `ChangeAlreadyCancelled`
6. Revert: non-avatar calls queueChange -> `NotAuthorized`
7. Double execute -> `ChangeAlreadyExecuted`
8. Pause: queueChange reverts `IsPaused`
9. Emergency cancel all: multiple queued changes cancelled
10. Fuzz: random delays/configs/timestamps -- invariant: config never changes before delay

**Tests:**
- **Unit** — `test/unit/TimelockNavigator.test.ts` (30 passing). Constructor bounds (`DelayTooShort`/`DelayTooLong`/expiry window/zero DAO), the `MIN_DELAY` floor + `RECOMMENDED_DELAY` constants, avatar-gated `queueChange` + `IsPaused`, the happy-path execute applying config to DAOShip, permissionless execution, every revert path (`ChangeNotReady`, `ChangeExpired`, `ConfigHashMismatch`, `ChangeAlreadyExecuted`, `ChangeAlreadyCancelled`, `ChangeDoesNotExist`), the no-lock-out behavior when DAOShip rejects a malformed config, the missing-GOVERNOR-permission revert, exact `[executableAfter, expiresAt]` boundaries, cancel auth, `pause`/`unpause`/`emergencyCancelAll` via **both** the avatar **and** a non-avatar GOVERNOR navigator (the `_isGovernorOrAvatar` navigator branch), and the `isExecutable` view.
- **Local E2E** — `test/e2e/local/TimelockNavigator.e2e.test.ts` (3 passing). Real DAOShip driven through the full proposal lifecycle: registering the timelock as GOVERNOR via governance, a passed proposal queueing a change (arriving as `msg.sender == avatar`), executing after the delay, avatar cancelling via a follow-up proposal, and an explicit test proving the **advisory bypass** (a proposal applies config directly via `executeAsGovernance` while `changeCount` stays 0).
- **Onchain E2E** — `test/e2e/onchain/OnChainDAOLifecycle.test.ts` Phase 2g. Against a live Cyprus1 DAO: timelock registered as GOVERNOR (4) at launch, a real proposal queues a quorum change (validating `queueChange` arrives as `msg.sender == avatar` through the vault MultiSend), `ChangeNotReady` before the delay, then a wait of the **real** on-chain delay (deployed at the `MIN_DELAY` floor so the suite can wait it) and a permissionless `executeChange` that applies the config via the GOVERNOR `setGovernanceConfig`.

**Status:** Shipped. Contract `contracts/navigators/TimelockNavigator.sol` (~290 lines incl. NatSpec), deploy script `scripts/deploy/007_deploy_timelock_navigator.ts`. Must be registered with GOVERNOR (4) via a `setNavigators` governance proposal. Advisory at the contract layer (see warning above) — usage is enforced in the app and bypass is flagged by the indexer.

---

#### BudgetNavigator (MANAGER + Vault Module)

**What it does:** Governance pre-approves a spending budget (e.g., "50,000 QUAI for Q2 contributor payments"). A designated budget manager can then disburse funds within that budget without individual proposals per payment.

**Why DAO Ships needs this:** `executeAsGovernance` can transfer funds, but every transfer requires a full governance proposal (votingPeriod + gracePeriod). At 20 contributor payments/month with 5-day cycles, that is the entire governance bandwidth spent on payroll.

**Why it matters at 1000+ members:** At 1000 members with 10% quorum, you need 100 voters per proposal. 20 payment proposals/month = 2000 vote-actions for payroll alone. BudgetNavigator reduces this to 1 quarterly budget approval -- a 95% reduction in governance overhead.

**Permission:** MANAGER (2) for share/loot minting if compensation includes tokens. Also needs vault module status for direct treasury disbursement.

**Urgency:** Blocking for any DAO with regular operational spending (Community, Protocol).

**Architecture:** Two-level budget system: **budget schedules** (governance-approved overall spending plans) containing **allocation periods** (recurring cycles for payroll and discretionary spending). The navigator needs dual authority: MANAGER permission on DAOShip (for token compensation) and enabled module on the vault (for treasury disbursement via `IAvatar.execTransactionFromModule`). Funds never leave the vault until disbursement.

**State variables:**

```solidity
DAOShip public immutable daoShip;

struct PayrollEntry {
    address recipient;
    uint256 amountPerPeriod;
    bool active;
}

struct BudgetSchedule {
    address manager;
    address token;               // ERC20 address (address(0) for native token)
    uint256 totalCeiling;        // max total spending (0 = uncapped)
    uint256 totalSpent;
    uint64 startsAt;
    uint64 endsAt;               // 0 = perpetual until cancelled
    uint64 allocationPeriod;     // period length in seconds
    uint64 lastPayrollExecution;
    uint256 discretionaryPerPeriod;
    uint256 discretionarySpentThisPeriod;
    uint64 currentPeriodStart;
    bool cancelled;
    string description;
}

uint256 public scheduleCount;
mapping(uint256 => BudgetSchedule) public schedules;
mapping(uint256 => PayrollEntry[]) public payroll;
bool public paused;
```

**Constructor:** `address _daoShip`. Schedules are created dynamically via governance.

**Key functions:**

```solidity
function createSchedule(
    address manager, address token, uint256 totalCeiling,
    uint64 startsAt, uint64 endsAt, uint64 allocationPeriod,
    uint256 discretionaryPerPeriod, string calldata description,
    address[] calldata payrollRecipients, uint256[] calldata payrollAmounts
) external returns (uint256 scheduleId);

function executePayroll(uint256 scheduleId) external;
function disburse(uint256 scheduleId, address to, uint256 amount) external;
function disburseBatch(uint256 scheduleId, address[] calldata to, uint256[] calldata amounts) external;
function updatePayroll(uint256 scheduleId, uint256 entryIndex, address recipient, uint256 amountPerPeriod, bool active) external;
function cancelSchedule(uint256 scheduleId) external;

function discretionaryRemaining(uint256 scheduleId) external view returns (uint256);
function totalRemaining(uint256 scheduleId) external view returns (uint256);
function payrollReady(uint256 scheduleId) external view returns (bool);
```

- `createSchedule` -- avatar only (via proposal).
- `executePayroll` -- permissionless (anyone, including bots). Iterates active payroll entries, transfers each via `execTransactionFromModule`. Resets discretionary spend and advances period.
- `disburse` -- manager only, within period ceiling and total ceiling.
- Period advancement happens inside `executePayroll`. If payroll is not executed, the discretionary manager keeps spending against the old period's allocation (not accumulating multiple periods).
- Each schedule is for a single token. Create multiple schedules for multiple tokens via batched governance proposals.

**Example: Q2 2026 Budget**

```
Schedule: "Q2 2026 Operations"
Token: QUAI (address(0)), Total ceiling: 150,000 QUAI
Starts: April 1, Ends: June 30, Allocation period: 30 days
Discretionary per period: 5,000 QUAI, Manager: ops-lead.eth
Payroll: Alice 10K, Bob 8K, Carol 6K, Dave 4K (monthly)

Monthly flow:
  1. Anyone calls executePayroll() -> 28,000 QUAI auto-disbursed
  2. Ops lead disburses within 5,000 QUAI discretionary
  3. Total: ~33,000/month x 3 months = 99,000 QUAI
  4. Remaining ceiling: 51,000 QUAI buffer
```

**Events:** `ScheduleCreated`, `PayrollExecuted`, `Disbursed`, `PayrollUpdated`, `ScheduleCancelled`, `Paused`, `Unpaused`.

**Custom errors:** `InvalidConfig`, `NotAuthorized`, `IsPaused`, `ScheduleExpired`, `ScheduleNotStarted`, `ScheduleCancelledError`, `DiscretionaryExceeded`, `TotalCeilingExceeded`, `PayrollNotReady`, `LengthMismatch`, `ZeroAmount`, `TransferFailed`, `InvalidPayrollIndex`.

**Test scenarios:**

1. Happy path payroll: create schedule, advance one period, executePayroll, verify amounts
2. Happy path discretionary: manager disburses within ceiling
3. Discretionary resets on new period
4. Revert: payroll too early -> `PayrollNotReady`
5. Revert: discretionary exceeded -> `DiscretionaryExceeded`
6. Revert: total ceiling exceeded -> `TotalCeilingExceeded`
7. Revert: non-manager disburse -> `NotAuthorized`
8. Revert: expired schedule -> `ScheduleExpired`
9. Cancel: avatar cancels, payroll and disburse revert
10. Update payroll: add recipient mid-schedule
11. Deactivate payroll entry: set active=false, skipped next execution
12. Permissionless payroll: non-member calls executePayroll -> succeeds
13. Multiple schedules: QUAI and USDC operate independently
14. Perpetual schedule: endsAt=0, runs until cancelled
15. Batch discretionary: 10 recipients in one call

**Estimated size:** ~280 lines of Solidity.

---

### Priority 2: Critical for Scale

#### DelegateRegistryNavigator (No Permission)

**What it does:** On-chain registry where delegates publish their voting philosophy, expertise, and categories. Reads DAOShipVotes delegation state and provides a queryable directory.

**Why DAO Ships needs this:** DAOShipVotes supports `delegate(address)` but provides zero metadata about delegates. No way to enumerate active delegates, their voting records, or their stated positions.

**Why it matters at 1000+ members:** Delegation is the only way large DAOs hit quorum. At 1000 members with 10% quorum, you need 100 active voters. In practice, 5-10% vote regularly. Delegation concentrates power into 10-20 active delegates. Without a registry, new members cannot discover delegates or make informed delegation choices.

**Permission:** None. Read-only metadata layer.

**Architecture:** Fully standalone -- no DAOShip permission needed. Delegates self-register by calling `register()` with their metadata. The contract reads `sharesToken.delegates(account)` and `sharesToken.getCurrentVotes(account)` from DAOShipVotes to provide delegation state alongside metadata. On-chain enumeration via `_delegateList` array (expected 10-50 delegates for a 1000-member DAO -- safe to iterate). Swap-and-pop pattern keeps the array dense.

**State variables:**

```solidity
DAOShip public immutable daoShip;
IDAOShipVotingToken public immutable sharesToken;

struct DelegateProfile {
    string name;
    string metadataURI;       // IPFS hash -> full profile
    uint64 registeredAt;
    uint64 updatedAt;
    bool active;
}

mapping(address => DelegateProfile) public profiles;
address[] private _delegateList;
mapping(address => uint256) private _delegateIndex;  // address => index+1 (0 = not in list)
```

**Key functions:**

```solidity
function register(string calldata name, string calldata metadataURI) external;
function updateProfile(string calldata name, string calldata metadataURI) external;
function deactivate() external;
function reactivate() external;
function withdraw() external;
function delegateCount() external view returns (uint256);
function getDelegates(uint256 offset, uint256 limit) external view returns (address[] memory);
function getDelegateInfo(address delegate) external view returns (
    string memory name, string memory metadataURI,
    uint64 registeredAt, uint64 updatedAt, bool active, uint256 currentVotingPower
);
```

- `register` -- requires `sharesToken.balanceOf(msg.sender) > 0 || sharesToken.getCurrentVotes(msg.sender) > 0`.
- `getDelegateInfo` -- combines stored metadata with live `getCurrentVotes()` data.
- No ReentrancyGuard needed (no value transfers). No pause needed (informational only).

**Events:** `DelegateRegistered`, `DelegateUpdated`, `DelegateDeactivated`, `DelegateReactivated`, `DelegateWithdrawn`.

**Custom errors:** `NotRegistered`, `AlreadyRegistered`, `NoStake`, `EmptyName`.

**Test scenarios:**

1. Happy path: register, verify getDelegateInfo
2. Update name and URI, verify updatedAt changes
3. Deactivate/reactivate toggle
4. Withdraw: delegateCount decreases, getDelegates excludes address
5. Revert: no stake -> `NoStake`
6. Revert: double register -> `AlreadyRegistered`
7. Revert: unregistered update -> `NotRegistered`
8. Enumeration: register 5, paginate with offset/limit
9. Swap-and-pop: register A, B, C; withdraw B; verify A and C remain
10. Live voting power: delegate shares, verify getDelegateInfo reflects increase

**Estimated size:** ~120 lines of Solidity.

---

#### SignalNavigator (No Permission) — **SHIPPED**

> **Canonical reference:** [`docs/SIGNAL_NAVIGATOR.md`](SIGNAL_NAVIGATOR.md) — full ABI, gotchas, and audit sign-off.

**What it does:** Non-executing, share-weighted governance polls. Members vote using their delegation-aware voting power, but no on-chain action executes. Used for temperature checks before committing to binding proposals. Polls can open immediately or be **scheduled** to open at a future time.

**Why DAO Ships needs this:** DAOShip proposals are heavyweight -- full votingPeriod + gracePeriod, retention check, gas to process. A proposal that does nothing still costs 10 days and requires 100 voters at 10% quorum.

**Why it matters at 1000+ members:** Gauging community sentiment on 5 potential directions before committing to one binding proposal would take 50 days through DAOShip's proposal system. Signal polls with 24-48 hour durations compress this to days. They also reduce voter fatigue -- members know signal polls carry no execution risk.

**Permission:** None. The lowest-blast-radius navigator in the suite: it **never calls a mutating function on DAOShip**. It only reads voting power and writes its own poll storage, so a bug cannot mint, burn, pause, or alter governance — the worst case is a mis-tallied, non-binding poll. No governance proposal is needed to wire it up; deploy and use.

**Official onboarding (sanctioning):** Because it holds no permission, a SignalNavigator is **never registered via `setNavigators()` and emits no `NavigatorSet`** — its DAO association comes only from the indexed `daoShip` in its `NavigatorDeployed` event, which is *self-asserted* (anyone can deploy a contract claiming any DAO). It still *functions* unsanctioned — "deploy and use" is unchanged — but to be **officially endorsed** (and surfaced by default in indexers/frontends rather than flagged "unverified"), the DAO passes a governance proposal that has the **vault post a `daoships.dao.navigators` allowlist** naming the navigator address. That post is authenticated (`msg.sender == vault`), grants **zero permission**, and is purely a trust signal — it changes how the poll is *displayed*, not what the contract can *do*. See [POSTER.md → DAO Sanctioned Navigators](POSTER.md#dao-sanctioned-navigators-daoshipsdaonavigators) for the tag schema and [INDEXER-GUIDE.md → Protecting DAOs from spam read-only navigators](INDEXER-GUIDE.md#protecting-daos-from-spam-read-only-navigators) for how indexers consume it. This sanctioning path is the model for **all** future read-only (no-permission) navigators, e.g. `DelegateRegistryNavigator`.

**Architecture:** Fully standalone — reads delegation-aware voting power via `daoShip.getPriorVotes()` (which proxies the DAOShipVotes checkpoint system). No `BaseNavigator` inheritance (no minting/caps/allowlist), no ReentrancyGuard (no value transfers, no untrusted external calls), no pause (non-executing).

**Scheduling + snapshot-at-START (not creation):** Each poll stores `snapshotTimestamp = votingStarts - 1`. Because votes can only land once `block.timestamp >= votingStarts`, the snapshot is always strictly in the past at vote time, so `getPriorVotes` never trips its `timepoint < block.timestamp` guard — **no keeper / "activation" tx is required**; the snapshot point is simply *defined* as poll-start and resolved lazily on the first vote. Voting power is therefore measured the instant voting opens: shares/delegations settled *before* start count (a scheduled poll gives a lead window to organize delegation); anything acquired *after* start carries no weight (anti-vote-buying). `startTime == 0` opens immediately (`votingStarts = block.timestamp`); otherwise `block.timestamp <= startTime <= block.timestamp + maxStartDelay`. Set `maxStartDelay = 0` to forbid scheduling (immediate-only).

**Two distinct snapshots, by design:** *creation gating* checks the creator's power at `now - 1` (you need shares to open a poll today, and the poll's own snapshot may be in the future and thus unqueryable at creation); the *poll voting snapshot* is at `votingStarts - 1`.

**Constructor bounds:** `minDuration > 0`, `maxDuration` in `[minDuration, MAX_WINDOW]`, `maxStartDelay <= MAX_WINDOW`, where `MAX_WINDOW = 3650 days` — an overflow backstop for the uint64 timestamp math and a sanity gate against nonsensical config.

**Same-block caveat (immediate polls):** an immediate poll snapshots at `block.timestamp - 1`, so holders whose *first* checkpoint is the creation block (shares acquired in the **same block** as `createPoll`) read as 0 weight. Schedule the poll, or let a block pass after minting, to include same-block acquisitions.

**State variables:**

```solidity
address public immutable deployer;        // INavigator: set to msg.sender in constructor
DAOShip public immutable daoShip;
uint256 public immutable minSharesToCreatePoll;
uint64  public immutable minDuration;
uint64  public immutable maxDuration;
uint64  public immutable maxStartDelay;   // 0 = immediate-only (no scheduling)

enum Status { Pending, Active, Ended, Cancelled }

struct Poll {
    address creator;
    string question;            // IPFS hash or short text
    uint8 optionCount;          // MIN_OPTIONS..MAX_OPTIONS (2..10)
    uint64 snapshotTimestamp;   // votingStarts - 1; voting power measured here
    uint64 votingStarts;
    uint64 votingEnds;
    bool cancelled;
    mapping(uint8 => uint256) optionVotes;
    mapping(address => bool) voted;
}

uint256 public pollCount;
mapping(uint256 => Poll) public polls;   // public getter omits nested mappings
```

**Key functions:**

```solidity
function createPoll(string calldata question, uint8 optionCount, uint64 startTime, uint64 duration) external returns (uint256 pollId);
function vote(uint256 pollId, uint8 option) external;
function cancelPoll(uint256 pollId) external;
function getOptionVotes(uint256 pollId, uint8 option) external view returns (uint256);
function getResults(uint256 pollId) external view returns (uint256[] memory);
function hasVoted(uint256 pollId, address voter) external view returns (bool);
function pollStatus(uint256 pollId) external view returns (Status);
```

- `createPoll` — validates option count (2..10), duration (`minDuration..maxDuration`) and start time; requires `getPriorVotes(msg.sender, block.timestamp - 1) >= minSharesToCreatePoll`.
- `vote` — checks poll exists, not cancelled, started, not ended, valid option, not already voted. The window is **half-open `[votingStarts, votingEnds)`** (start inclusive, end exclusive) — exactly matching `DAOShip.castVote`, so a poll is votable for precisely `duration` seconds. Weight = `getPriorVotes(msg.sender, snapshotTimestamp)`; requires weight > 0.
- `cancelPoll` — **before voting opens:** creator or avatar. **After voting opens:** avatar only (so a creator cannot nuke an in-progress poll they are losing). Cannot cancel an already-ended poll.

**Events:** `PollCreated(pollId, creator, question, optionCount, snapshotTimestamp, votingStarts, votingEnds)`, `Voted(pollId, voter, option, weight)`, `PollCancelled(pollId, caller)`, `NavigatorDeployed`.

**Custom errors:** `InvalidConfig`, `InsufficientShares`, `InvalidOptionCount`, `InvalidDuration`, `InvalidStartTime`, `PollDoesNotExist`, `PollNotStarted`, `PollHasEnded`, `PollIsCancelled`, `AlreadyVoted`, `InvalidOption`, `NoVotingPower`, `NotAuthorized`.

**Tests:**
- **Unit** — `test/unit/SignalNavigator.test.ts` (37 passing). Immediate & scheduled polls, the full `pollStatus` lifecycle (Pending→Active→Ended/Cancelled), share-weighted tallies, every revert path, the creator-vs-avatar cancel rule, the snapshot-at-start guarantees (shares acquired after the snapshot carry no weight; a scheduled poll's pre-start lead window does count), the half-open window boundaries (votable at exactly `votingStarts`, closed at exactly `votingEnds`), multiple coexisting polls with independent tallies, view-side reverts for unknown ids, and the `MAX_WINDOW` constructor caps.
- **Local E2E** — `test/e2e/local/SignalNavigator.e2e.test.ts` (5 passing, CI-runnable on Hardhat). Integration against a real DAOShip: delegation flowing through `getPriorVotes` (re-snapshot moves weight), **loot excluded** from voting weight (only shares vote), creation gating on live DAO power, and the scheduled/cancel lifecycle.
- **Onchain E2E** — Phase 2e in `test/e2e/onchain/OnChainDAOLifecycle.test.ts` (validate against Cyprus1/Orchard). Deploys SignalNavigator with **no permission**, opens a poll, two members vote with snapshot-exact weights, asserts the tally + `PollCreated`/`Voted` events and the one-vote-per-address guard.

**Status:** Shipped & audited. Contract `contracts/navigators/SignalNavigator.sol` (~325 lines incl. NatSpec), deploy script `scripts/deploy/006_deploy_signal_navigator.ts`. Reads voting power via `daoShip.getPriorVotes()` — no separate token interface wired. A three-lens audit (security / gas / correctness) found no Critical/High issues; the `MAX_WINDOW` caps, same-block-snapshot documentation, and expanded boundary/multi-poll tests above were the resulting hardening.

---

#### VestingNavigator (MANAGER) — **SHIPPED**

> **Canonical reference:** [`docs/VESTING_NAVIGATOR.md`](VESTING_NAVIGATOR.md) — full ABI, gotchas, and audit sign-off.

**What it does:** Mints shares or loot on a vesting schedule -- cliff period followed by linear unlock, minted *incrementally as it vests* (nothing is escrowed up front, so unvested tokens never exist and carry no voting power). Revocation is **non-destructive**: it freezes future accrual but does not claw back already-minted tokens (clawback is a separate governance `burnShares`/`burnLoot`).

**Why DAO Ships needs this:** DAOShip can mint shares, but has no time-locked minting concept. Minting upfront gives full voting power immediately. The only way to vest is to mint incrementally -- which requires either a proposal per tranche or a navigator that mints automatically on schedule.

**Why it matters at 1000+ members:** Protocol DAOs hire core contributors with multi-year commitments. Without vesting, a contributor receives full shares on day one and can immediately ragequit, extracting value without delivering work. At 1000 members, 20-50 active vesting schedules would be unmanageable through individual proposals.

**Permission:** MANAGER (2). Calls `mintShares` to release tranches and governance can call `burnShares` for clawback.

**Architecture:** Does NOT mint all shares upfront. Stores vesting schedules and mints shares incrementally as they vest. Beneficiary calls `claim()` to mint vested-but-unclaimed shares. Unvested shares never exist on-chain -- no risk of a buggy unlock mechanism. Multiple schedules per address supported. Shares and loot vesting are separate schedules (no mixing).

**State variables:**

```solidity
DAOShip public immutable daoShip;

struct VestingSchedule {
    address beneficiary;
    uint256 totalAmount;
    uint256 claimed;
    uint64 startTime;
    uint64 cliffEnd;
    uint64 vestingEnd;
    bool isLoot;          // false = shares, true = loot
    bool revoked;
    uint256 revokedAt;
}

uint256 public scheduleCount;
mapping(uint256 => VestingSchedule) public schedules;
mapping(address => uint256[]) public beneficiarySchedules;
bool public paused;
```

**Cliff + linear math:**

```solidity
function _vestedAmount(VestingSchedule storage s) internal view returns (uint256) {
    uint256 effectiveEnd = s.revoked ? s.revokedAt : block.timestamp;
    if (effectiveEnd < s.cliffEnd) return 0;
    if (effectiveEnd >= s.vestingEnd) return s.totalAmount;
    return (s.totalAmount * (effectiveEnd - s.startTime)) / (s.vestingEnd - s.startTime);
}
```

**Key functions:**

```solidity
function createSchedule(
    address beneficiary, uint256 totalAmount, uint64 startTime,
    uint64 cliffDuration, uint64 vestingDuration, bool isLoot
) external returns (uint256 scheduleId);

function claim(uint256 scheduleId) external;
function revoke(uint256 scheduleId) external;

function vested(uint256 scheduleId) external view returns (uint256);
function claimable(uint256 scheduleId) external view returns (uint256);
function getSchedules(address beneficiary) external view returns (uint256[] memory);
```

- `createSchedule` -- avatar only (via proposal); reverts `IsPaused` when paused. `startTime == 0` means "now". Validates beneficiary, amount, `vestingDuration > 0`, `cliffDuration <= vestingDuration`.
- `claim` -- beneficiary or avatar. Mints shares or loot (per `isLoot`) **to the beneficiary** regardless of caller. CEI: `claimed` updated before the mint, so a mint revert (e.g. missing MANAGER) rolls back cleanly. Allowed even after revoke (to collect the pre-revoke vested portion) and even when paused (vested funds are never trapped).
- `revoke` -- avatar only. Sets `revoked = true` and `revokedAt = block.timestamp`. Does NOT burn already-minted shares (non-destructive). Future claims capped at the revocation point. Separate governance `burnShares` needed to claw back already-vested shares.
- `pause` / `unpause` -- GOVERNOR navigator or avatar. Blocks only `createSchedule`.

**Standalone (not `BaseNavigator`).** Unlike NFTGated, `claim` may be called by the beneficiary *or* the avatar, so `BaseNavigator`'s `msg.sender`-keyed `mintCap`/`perAddressCap` would mis-attribute. Dilution is bounded per schedule by the governance-set `totalAmount` instead. Struct fields are ordered for storage packing (4 slots, not 5).

**Events:** `ScheduleCreated`, `TokensClaimed`, `ScheduleRevoked` (carries `revokedAt` + `vestedAtRevoke`), `Paused`, `Unpaused`, `NavigatorDeployed`.

**Custom errors:** `InvalidConfig`, `NotAuthorized`, `IsPaused`, `InvalidBeneficiary`, `ZeroAmount`, `CliffExceedsVesting`, `ScheduleDoesNotExist`, `NothingToClaim`, `AlreadyRevoked`. (The spec's `ScheduleRevoked` error was dropped as dead code — claims are *allowed* after revoke, so nothing reverts with it; `ScheduleDoesNotExist` was added to guard unknown ids.)

**Test scenarios:**

1. Happy path: 4-year schedule, 1-year cliff. Claim at cliff -> 25%, year 2 -> 50%, year 4 -> 100%
2. Revert: before cliff -> `NothingToClaim`
3. Partial claim: claim at year 2, then year 3, verify incremental mint
4. Revoke at 50% vested, verify future claims capped
5. Revoke before cliff: 0 claimable forever
6. Revoke then claim unclaimed portion
7. Revert: double revoke -> `AlreadyRevoked`
8. Multiple schedules per beneficiary, independent tracking
9. Revert: non-avatar create -> `NotAuthorized`
10. Fuzz: random times/durations. Invariant: `claimed <= totalAmount` and `claimed <= vestedAmount`

**Tests:**
- **Unit** — `test/unit/VestingNavigator.test.ts` (24 passing). All 10 spec scenarios plus: `startTime=0`→now, every constructor/param revert (`InvalidBeneficiary`/`ZeroAmount`/`InvalidConfig`/`CliffExceedsVesting`), loot vesting, avatar-claims-for-beneficiary, stranger-claim rejection, revoke-after-full-vest, the missing-MANAGER revert, view reverts (`ScheduleDoesNotExist`), and a monotone-invariant walk asserting `claimed == vested ≤ total` against a JS mirror of the formula at exact block timestamps.
- **Local E2E** — `test/e2e/local/VestingNavigator.e2e.test.ts` (2 passing). Real DAOShip via the proposal lifecycle: register MANAGER by governance, create a schedule by proposal (arrives as `msg.sender == avatar`), `claim` mints real shares conferring **live voting power** (auto self-delegation), and revoke-by-proposal freezes accrual.
- **Onchain E2E** — Phase 2f in `test/e2e/onchain/OnChainDAOLifecycle.test.ts` (Cyprus1/Orchard). Deploys the navigator with MANAGER, creates a short cliff-less schedule via a governance proposal, waits past `vestingEnd` on the chain clock, claims the full amount, and asserts the second claim reverts.

**Audit:** Three-lens review (security / scalability / stability / efficiency / succinctness) found no Critical/High issues. One efficiency fix applied — struct fields reordered for storage packing (4 slots instead of 5, ~2,900 gas saved per schedule). CEI + `ReentrancyGuard` on all state-changing externals; `claim` mints to the beneficiary (not the caller); `_vestedAmount` proven free of underflow/division-by-zero; the `claimed ≤ vested ≤ totalAmount` invariant holds across revoke. The spec's unused `ScheduleRevoked` error was removed.

**Status:** Shipped. Contract `contracts/navigators/VestingNavigator.sol` (~270 lines incl. NatSpec), deploy script `scripts/deploy/008_deploy_vesting_navigator.ts`. Must be registered with MANAGER (2) via a `setNavigators` governance proposal; schedules are then created by governance via `createSchedule`.

---

#### NFTGatedNavigator (MANAGER) — **SHIPPED**

> **Canonical reference:** [`docs/NFT_GATE_NAVIGATOR.md`](NFT_GATE_NAVIGATOR.md) — full ABI, gotchas, and audit sign-off.

**What it does:** Gates DAO membership behind ownership of a specific **ERC-721** collection. A holder calls `onboard(tokenId)` and receives a fixed amount of shares/loot. Supports free-mint (credential = membership) and tribute-required (credential + payment = membership) modes. Ownership is checked live — no allowlist maintenance.

**Why DAO Ships needs this:** `mintShares` is permissionless from MANAGER navigators but has no built-in NFT check. The Merkle allowlist on OnboarderNavigator approximates this but requires off-chain tree updates whenever NFTs change hands.

**Why it matters at 1000+ members:** Gaming guilds, creator DAOs, protocol contributor programs, and real-world asset DAOs all use NFTs as credentials. Baking the check into the navigator eliminates continuous allowlist maintenance.

**Permission:** MANAGER (2).

**Scope — ERC-721 only.** ERC-1155 is intentionally out of scope. ERC-1155's native gating idiom is amount-based (`balanceOf(account, id) >= N`, tiered membership), which is a different feature reserved for a future dedicated navigator (see *Planned: ERC1155GateNavigator* below). Critically, a *fungible* ERC-1155 id has no unique identity to anchor a one-time claim to, and fungibility cannot be reliably detected on-chain (no standard flag; `totalSupply` is optional and spoofable). Restricting to ERC-721 keeps the claim model sound and the audit surface small.

**Claim model — "claim ticket", one claim per `tokenId`, forever.** Claim tracking is per-**token** (`claimed[tokenId]`), not per-address. This defeats the transfer-and-reclaim recycle attack: passing the NFT to a fresh wallet does not unlock a second claim because the *token itself* is spent. Shares are a ticket — once minted they persist even if the NFT is later sold (the buyer of an already-claimed NFT receives nothing; frontends should surface `claimed[tokenId]`). True revocable "lose-NFT-lose-shares" membership is **not** offered here — it is not enforceable for an arbitrary external NFT and is reserved for a future escrow-based navigator.

**Architecture:** Extends `BaseNavigator` (reusing `mintCap`, `perAddressCap`, optional Merkle allowlist, `expiry`, pause, and the mint helper) and implements `IMembershipGate`. On `onboard(tokenId)`: checks pause/expiry/allowlist, verifies `gateToken.ownerOf(tokenId) == msg.sender` (reverts → `NotHolder`), requires `!claimed[tokenId]`, validates tribute, sets `claimed[tokenId]=true`, enforces caps, mints, and forwards tribute to the vault. `mintCap` is **mandatory** (constructor reverts on 0) — an arbitrary gate collection may be mintable, so the cap bounds total dilution. The only untrusted external call is `ownerOf`, guarded by `nonReentrant` + checks-effects-interactions.

**`IMembershipGate`:** stateless eligibility (`isEligible(addr)` → `balanceOf > 0`; `isEligibleToken(addr, id)` → `ownerOf == addr`), separate from claim-tracking, so a future gate-aware navigator family can consult one eligibility source. A `canOnboard(addr, tokenId)` view combines eligibility + claim status + pause + expiry for frontends.

**State variables:**

```solidity
// inherited from BaseNavigator: daoShip, expiry, mintCap, perAddressCap,
//   allowlistRoot, totalMinted, mintedTo, paused, deployer
IERC721 public immutable gateToken;
uint256 public immutable sharesPerHolder;
uint256 public immutable lootPerHolder;
bool    public immutable requireTribute;
uint256 public immutable tributeAmount;
mapping(uint256 => bool) public claimed;   // tokenId => spent
```

**Key functions:**

```solidity
function onboard(uint256 tokenId) external payable nonReentrant;
function onboard(uint256 tokenId, bytes32[] calldata proof) external payable nonReentrant;
function isEligible(address candidate) external view returns (bool);
function isEligibleToken(address candidate, uint256 tokenId) external view returns (bool);
function canOnboard(address candidate, uint256 tokenId) external view returns (bool);
// pause()/unpause() inherited (GOVERNOR navigator or avatar)
```

**Events:** `Onboard` (base, for onboarding feeds), `NFTClaimed(daoShipAddress, holder, tokenId, shares, loot)` (adds the tokenId dimension for claim-status indexing), `Paused`, `Unpaused`, `NavigatorDeployed`.

**Custom errors:** `NotHolder`, `AlreadyClaimed`, `IncorrectTribute`, `NoTributeRequired`, `TransferFailed` (+ inherited `IsPaused`, `Expired`, `MintCapExceeded`, `PerAddressCapExceeded`, `NotAllowlisted`, `NotAuthorized`, `InvalidConfig`).

**Tests:** `test/unit/NFTGatedNavigator.test.ts` — 27 passing. Covers happy path, loot-only, `NotHolder` (wrong/nonexistent/burned token), `AlreadyClaimed`, the transfer-and-reclaim defense, tribute modes, mint/per-address caps, expiry, pause auth, constructor validation, and the `IMembershipGate`/`canOnboard` views.

**Status:** Shipped. Contract `contracts/navigators/NFTGatedNavigator.sol` (~210 lines incl. NatSpec), interface `contracts/interfaces/IMembershipGate.sol`, deploy script `scripts/deploy/005_deploy_nft_gated_navigator.ts`.

---

#### ERC1155GateNavigator (MANAGER) — *Planned*

A dedicated companion to NFTGatedNavigator for ERC-1155 credentials, done in the standard's native idiom rather than crippled to supply-1. Amount-aware gating (`balanceOf(account, id) >= threshold`), optional quantity-scaled shares (more units → more shares, within caps), and tiered membership by id. Would consult the same `IMembershipGate` abstraction. Anti-recycle for fungible ids requires either escrow (lock the units) or DAO-controlled/soulbound tokens — to be specified when there is concrete demand.

---

### Priority 3: Important for Specific Configurations

#### CircuitBreakerNavigator (ADMIN)

**What it does:** Monitors on-chain conditions and auto-pauses tokens on anomalous activity. Triggers: large unexpected mints (compromised MANAGER), rapid ragequits (bank run), sudden parameter changes. Human governance required to unpause.

**Why DAO Ships needs this:** Token pausing requires ADMIN permission or a governance proposal. No automated monitoring exists. A compromised navigator minting 1 billion shares at 3am does all damage before any human reacts.

**Why it matters at 1000+ members:** Attack surface grows with member count and treasury size. At $10M+ TVL, a compromised navigator exploit executes in seconds; human response takes hours. The circuit breaker closes that gap. Critical for Agent DAOs where automated agents can malfunction within a single 6-minute governance cycle.

**Permission:** ADMIN (1). Calls `setAdminConfig(true, true)` to pause both tokens. Asymmetric by design: auto-pause (automated), unpause (human governance only).

**Architecture:** Uses a "check-on-action" pattern -- any external caller invokes `checkAndTrip()`, and the navigator evaluates conditions at that moment. No per-block monitoring required. Also provides `tripManual()` for authorized watchdogs.

**Monitored conditions (on-chain heuristics):**

1. **Mint spike:** `totalShares + totalLoot` increases by more than `mintThresholdBps` within `windowDuration`.
2. **Ragequit drain:** Total supply drops by more than `drainThresholdBps` within `windowDuration`.
3. **Governance hijack:** `quorumPercent` drops below `minSafeQuorum` or `votingPeriod` drops below `minSafeVotingPeriod`.

**State variables:**

```solidity
DAOShip public immutable daoShip;
uint256 public immutable mintThresholdBps;
uint256 public immutable drainThresholdBps;
uint256 public immutable windowDuration;
uint32 public immutable minSafeQuorum;
uint32 public immutable minSafeVotingPeriod;
uint256 public lastSnapshotSupply;
uint64 public lastSnapshotTime;
address public immutable recoveryMultisig;
mapping(address => bool) public watchdogs;
bool public tripped;
```

**Key functions:**

```solidity
function checkAndTrip() external;
function tripManual(string calldata reason) external;
function recover() external;
function wouldTrip() external view returns (bool mintSpike, bool drainSpike, bool govHijack);
```

- `checkAndTrip` -- permissionless. Reads supply, compares against snapshot. If threshold violated, calls `daoShip.setAdminConfig(true, true)`. Updates rolling window snapshot.
- `tripManual` -- watchdog only.
- `recover` -- avatar or `recoveryMultisig` only. Calls `setAdminConfig(false, false)`, resets snapshot.
- False positive strategy: thresholds set conservatively; `wouldTrip()` lets keepers preview; cost of false positive (temporary pause) far less than missed attack.

**Events:** `CircuitBreakerTripped`, `CircuitBreakerTrippedManual`, `CircuitBreakerRecovered`, `SnapshotUpdated`.

**Custom errors:** `NotAuthorized`, `AlreadyTripped`, `NotTripped`, `InvalidConfig`.

**Test scenarios:**

1. Mint spike: mint 25% of supply, checkAndTrip, verify paused
2. Drain spike: ragequit 35%, checkAndTrip, verify paused
3. Gov hijack: set quorum below minimum, trip
4. Normal activity within thresholds: no trip
5. Manual trip by watchdog
6. Revert: non-watchdog manual -> `NotAuthorized`
7. Recover: avatar calls recover, verify unpaused and snapshot reset
8. Revert: unauthorized recover -> `NotAuthorized`
9. Rolling window: 15% at t=0, 10% at t=windowDuration+1, no trip (separate windows)
10. Already tripped -> `AlreadyTripped`
11. `wouldTrip` view returns correct booleans
12. Fuzz: random supply changes/timestamps. Invariant: if tripped, tokens are paused

**Estimated size:** ~170 lines of Solidity.

---

#### OracleNavigator (GOVERNOR)

**What it does:** Reads on-chain data and adjusts governance parameters automatically. Examples: increase quorum when treasury exceeds $10M, decrease voting period during low-activity periods.

**Why DAO Ships needs this:** `setGovernanceConfig` is static -- parameters do not respond to conditions. A quorum that works at 100 members may be unreachable at 2000 members. Adjusting quorum requires a governance proposal that itself might fail to meet quorum (deadlock).

**Why it matters at 1000+ members:** Adaptive governance prevents the quorum deadlock spiral. The oracle adjusts parameters within bounded ranges based on observed participation rates.

**Permission:** GOVERNOR (4). Must be tightly scoped: bounded parameter ranges, rate limiting.

**Architecture:** Reads from DAOShip's own state (proposal participation rates, total supply) -- no external oracle dependency, eliminating oracle manipulation attacks. Defines immutable bounded parameter ranges at deployment. Can only adjust within those ranges. Rate limited to prevent oscillation.

**Interaction with TimelockNavigator:** Recommended to call `daoShip.setGovernanceConfig()` directly (bypassing timelock) with tight bounds. The oracle's purpose is real-time adaptation; routing through a 48-hour timelock defeats the purpose. Safety comes from immutable bounds.

**State variables:**

```solidity
DAOShip public immutable daoShip;
uint32 public immutable minVotingPeriod;
uint32 public immutable maxVotingPeriod;
uint32 public immutable minGracePeriod;
uint32 public immutable maxGracePeriod;
uint256 public immutable minQuorumPercent;
uint256 public immutable maxQuorumPercent;
uint256 public immutable cooldownPeriod;
uint64 public lastAdjustmentTime;
uint256 public immutable sampleSize;      // e.g., 10 proposals
bool public paused;
```

**Key functions:**

```solidity
function adjust() external;
function previewAdjustment() external view returns (
    uint32 newVotingPeriod, uint32 newGracePeriod, uint256 newQuorumPercent
);
```

- `adjust` -- permissionless. Reads participation from last N processed proposals. Computes average participation rate. High participation -> increase quorum toward max. Low participation -> decrease toward min. Linear interpolation. Non-adjusted parameters passed through unchanged.

**Events:** `ParametersAdjusted`, `Paused`, `Unpaused`.

**Custom errors:** `CooldownNotElapsed`, `InsufficientData`, `NotAuthorized`, `IsPaused`, `InvalidConfig`.

**Test scenarios:**

1. Low participation: 3 proposals at 10%, verify quorum decreased
2. High participation: 3 proposals at 90%, verify quorum increased
3. Bounds enforcement: adjusted quorum never exceeds max or drops below min
4. Cooldown: immediate re-adjust -> `CooldownNotElapsed`
5. Insufficient data: < sampleSize proposals -> `InsufficientData`
6. Preview matches actual adjustment
7. Pass-through: non-managed parameters unchanged
8. Pause reverts
9. Fuzz: random participation rates, output always within bounds

**Estimated size:** ~180 lines of Solidity.

---

#### SubscriptionNavigator (MANAGER)

**What it does:** Recurring membership fees. Members pay periodic tribute to maintain shares. Missed payments result in proportional share burning. Anyone can call `collectFee` to process overdue accounts.

**Why DAO Ships needs this:** `burnShares` exists but has no recurring payment logic, no deadline tracking, no automatic enforcement. A governance proposal per delinquent member per period is operationally untenable.

**Why it matters at 1000+ members:** Investment DAOs charging management fees (1-2% annual) need automated enforcement. At 1000 members, manually tracking 1000 subscription payments per period is impossible. Without it, free-riders hold shares indefinitely.

**Permission:** MANAGER (2). Burns shares/loot for non-payment.

**Architecture:** Pull payment model -- members call `payFee()` explicitly each period (no infinite approvals). Tracks `paidThrough` timestamp per member. Pre-payment supported. Grace period follows each deadline. After grace, anyone can call `collectFee(member)` to burn delinquent member's shares. Small collector reward (loot) incentivizes keepers.

**State variables:**

```solidity
DAOShip public immutable daoShip;
IERC20 public immutable feeToken;
uint256 public immutable feePerPeriod;
uint256 public immutable periodDuration;
uint256 public immutable graceDuration;
uint256 public immutable startTime;
mapping(address => uint256) public paidThrough;
uint256 public immutable collectorRewardBps;    // e.g., 100 = 1%
bool public paused;
```

**Key functions:**

```solidity
function payFee(uint256 periods) external;
function payFeeFor(address member, uint256 periods) external;
function collectFee(address member) external;

function isCurrent(address member) external view returns (bool);
function nextDeadline(address member) external view returns (uint256);
function inGracePeriod(address member) external view returns (bool);
function isDelinquent(address member) external view returns (bool);
```

- `payFee` -- transfers `feePerPeriod * periods` of `feeToken` to vault via SafeERC20. Advances `paidThrough`. Fee-on-transfer detection.
- `collectFee` -- checks `isDelinquent` (past grace period). Burns ALL shares. Mints `collectorRewardBps` of burned shares as loot to caller.

**Events:** `FeePaid`, `FeeCollected`, `Paused`, `Unpaused`.

**Custom errors:** `InvalidConfig`, `NotAuthorized`, `IsPaused`, `ZeroPeriods`, `NotDelinquent`, `NoSharesToBurn`, `TransferFailed`, `InsufficientPayment`.

**Test scenarios:**

1. Happy path: pay fee, verify paidThrough advances and token transferred to vault
2. Pre-pay 3 periods
3. Pay for another member
4. Grace period: missed deadline, isCurrent=false, inGracePeriod=true, isDelinquent=false
5. Collect: past grace, shares burned, reward minted to collector
6. Revert: not delinquent -> `NotDelinquent`
7. Revert: 0 shares -> `NoSharesToBurn`
8. Collector reward math: 1000 shares at 100bps -> 10 loot
9. Zero collector reward: no loot minted
10. Late catch-up: miss 2 periods, pay 3, verify current
11. Fee-on-transfer: insufficient received reverts
12. Fuzz: `paidThrough` never decreases; shares only burned when `isDelinquent`

**Estimated size:** ~190 lines of Solidity.

---

## Implementation Priority

| Phase | Navigators | Enables |
|-------|---------|---------|
| **v1.0 (shipped)** | OnboarderNavigator, ERC20TributeNavigator | Startup, Community, Agent DAOs |
| **v1.1** | TimelockNavigator (**shipped**), BudgetNavigator | Protocol, Investment DAOs |
| **v1.2** | SignalNavigator (**shipped**), DelegateRegistryNavigator, NFTGatedNavigator (**shipped**) | 200+ member governance, credential-gated DAOs |
| **v2.0** | VestingNavigator (**shipped**), CircuitBreakerNavigator | Core contributor compensation, safety automation |
| **v2.1** | OracleNavigator, SubscriptionNavigator | Adaptive governance, recurring fees |

### Navigator by DAO Configuration

| Navigator | Startup | Community | Protocol | Investment | Agent | Status |
|--------|---------|-----------|----------|------------|-------|--------|
| OnboarderNavigator | Required | Required | Required | Required | Required | **Shipped** |
| ERC20TributeNavigator | Optional | Required | Required | Required | -- | **Shipped** |
| BudgetNavigator | -- | Critical | Critical | -- | Critical | **Not built** |
| SignalNavigator | -- | Useful | Critical | -- | -- | **Shipped** |
| TimelockNavigator | -- | -- | Critical | Critical | -- | **Shipped** |
| VestingNavigator | -- | Useful | Critical | -- | -- | **Shipped** |
| DelegateRegistryNavigator | -- | Useful | Critical | -- | -- | **Not built** |
| RageKick (pattern) | -- | Useful | Useful | Required | -- | **Documented** |
| SubscriptionNavigator | -- | -- | -- | Useful | -- | **Not built** |
| OracleNavigator | -- | -- | -- | -- | Useful | **Not built** |
| CircuitBreakerNavigator | -- | -- | Useful | Useful | Critical | **Not built** |
| NFTGatedNavigator | Useful | Useful | Useful | -- | -- | **Shipped** |

---

## Summary Table

| Navigator | Permission | DAOShip Functions Called | Vault Module | Est. Lines |
|--------|-----------|---------------------|-------------|-----------|
| OnboarderNavigator | MANAGER (2) | `mintShares`, `mintLoot` | No | Shipped |
| ERC20TributeNavigator | MANAGER (2) | `mintShares`, `mintLoot` | No | Shipped |
| TimelockNavigator | GOVERNOR (4) | `setGovernanceConfig` | No | Shipped |
| BudgetNavigator | MANAGER (2) | `mintShares`, `mintLoot` (optional) | Yes | ~280 |
| SignalNavigator | None | None (reads only) | No | Shipped |
| DelegateRegistryNavigator | None | None (reads only) | No | ~120 |
| VestingNavigator | MANAGER (2) | `mintShares`, `mintLoot` | No | Shipped |
| CircuitBreakerNavigator | ADMIN (1) | `setAdminConfig` | No | ~170 |
| OracleNavigator | GOVERNOR (4) | `setGovernanceConfig` | No | ~180 |
| SubscriptionNavigator | MANAGER (2) | `burnShares`, `mintLoot` | No | ~190 |
| NFTGatedNavigator | MANAGER (2) | `mintShares`, `mintLoot` | No | Shipped |

**Total planned: ~1,410 lines of Solidity** across 8 contracts, plus test suites.

---

## Cross-Cutting Concerns

**Storage layout:** None of these navigators use upgradeable proxies. They are all deployed as immutable contracts. To change configuration, deploy a new instance and register it via governance proposal (which calls `setNavigators`). This eliminates upgrade bugs at the cost of redeployment -- an acceptable tradeoff for navigators whose config rarely changes.

**Gas budget:** Every navigator call to DAOShip costs the caller gas. The most expensive path is BudgetNavigator's `disburseBatch` with many recipients (one `execTransactionFromModule` per recipient). At 20 recipients, this is ~200K gas -- within block limits but worth noting for batch size guidance.

**Security dependency chain:** CircuitBreakerNavigator should be deployed before any MANAGER navigator that mints at scale (VestingNavigator, SubscriptionNavigator). The circuit breaker monitors for mint spikes that these navigators could cause if misconfigured or compromised.
