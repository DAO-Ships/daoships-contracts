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

All navigators MUST follow these patterns established by the shipped navigators:

- **`string public constant navigatorType = "YourNavigatorName";`** — Required. The indexer calls this once at discovery time to identify the navigator type. Must be a compile-time constant (not a storage variable). This is how the indexer populates `ds_navigators.navigator_type` without needing an extra event or Poster call.
- `DAOShip public immutable daoShip` stored at construction
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

**What it does:** Instant onboarding via native token (QUAI) tribute. Members send QUAI, receive shares/loot atomically.

**Key features:** Dual pricing (multiplier or fixed-price), Merkle allowlist, mintCap, perAddressCap, expiry, pause, refund handling, stuck native token recovery (`withdrawStuckETH`).

**Why DAO Ships needs this:** `mintShares` requires MANAGER permission. Without a navigator, every new member would need a governance proposal to mint their shares -- impossible at scale.

**Deployed address:** `0x0031C843A919dFc022DeA5A809B693009A29464b` (Cyprus1 Orchard Testnet)

### ERC20TributeNavigator (MANAGER)

**What it does:** Instant onboarding via ERC20 token tribute. Accepts any configured ERC20, transfers to vault, mints shares/loot. Supports ERC-2612 permit for single-transaction onboarding (sign + onboard instead of approve + onboard).

**Key features:** Per-token pricing, fee-on-transfer detection (balance before/after check), SafeERC20, ERC-2612 permit support via `onboardWithPermit()`, same cap/allowlist/expiry/pause as OnboarderNavigator.

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

#### TimelockNavigator (GOVERNOR)

**What it does:** Wraps `setGovernanceConfig` behind a mandatory delay. When governance passes a parameter change, it is queued for N hours/days before taking effect. Members who disagree can ragequit during the delay.

**Why DAO Ships needs this:** `setGovernanceConfig` takes effect immediately upon proposal processing. A compromised GOVERNOR navigator can set `gracePeriod=0, quorumPercent=0` in one transaction, stripping all minority protections instantly.

**Why it matters at 1000+ members:** Not every member monitors every proposal. A 48-hour timelock gives the community, delegates, and watchdogs time to raise alarms about dangerous parameter changes even after they pass. Every major DeFi protocol with significant TVL uses timelocks -- Compound, Aave, Uniswap.

**Permission:** GOVERNOR (4). Routes parameter changes through the timelock instead of directly to DAOShip.

**Urgency:** Non-negotiable at $1M+ treasury.

**Architecture:** The navigator is registered as a GOVERNOR on DAOShip. Governance proposals no longer call `daoShip.setGovernanceConfig()` directly -- instead they call `timelockNavigator.queueChange(bytes governanceConfig)`. After `delay` seconds elapse, anyone can call `executeChange(bytes32 changeId)` to forward the config to DAOShip. No DAOShip code changes required.

The delay is additive to the existing proposal lifecycle: `votingPeriod` -> `gracePeriod` -> proposal processed (calls `queueChange`) -> `delay` (second ragequit window) -> `executeChange`. Members see the exact parameters that will take effect and can exit before they do.

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

**Constructor:** `address _daoShip, uint256 _delay, uint256 _expiryWindow`. Validations: `_delay >= 1 hours`, `_delay <= 30 days`, `_expiryWindow >= 1 hours`.

**Key functions:**

```solidity
function queueChange(bytes calldata _governanceConfig) external returns (uint256 changeId);
function executeChange(uint256 changeId, bytes calldata _governanceConfig) external;
function cancelChange(uint256 changeId) external;
function emergencyCancelAll() external;
```

- `queueChange` -- restricted to `msg.sender == daoShip.avatar()` (only via governance proposal). Stores `keccak256(_governanceConfig)` (not full bytes -- gas optimization).
- `executeChange` -- permissionless after delay. Verifies hash, time window. Calls `daoShip.setGovernanceConfig(_governanceConfig)`.
- `cancelChange` -- avatar only.
- `emergencyCancelAll` -- GOVERNOR or avatar. Cancels all pending changes and pauses.

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

**Estimated size:** ~150 lines of Solidity.

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

#### SignalNavigator (No Permission)

**What it does:** Non-executing governance polls. Members vote using share weight, but no on-chain action executes. Used for temperature checks before committing to binding proposals.

**Why DAO Ships needs this:** DAOShip proposals are heavyweight -- full votingPeriod + gracePeriod, retention check, gas to process. A proposal that does nothing still costs 10 days and requires 100 voters at 10% quorum.

**Why it matters at 1000+ members:** Gauging community sentiment on 5 potential directions before committing to one binding proposal would take 50 days through DAOShip's proposal system. Signal polls with 24-48 hour durations compress this to days. They also reduce voter fatigue -- members know signal polls carry no execution risk.

**Permission:** None. Standalone contract that records share-weighted votes by reading `balanceOf` snapshots.

**Architecture:** Fully standalone -- does NOT need any DAOShip navigator permission. Reads share balances from SharesERC20 using `getPriorVotes` (the DAOShipVotes checkpoint system) for snapshot-based voting. Has its own lightweight poll lifecycle separate from DAOShip's proposal system.

**State variables:**

```solidity
DAOShip public immutable daoShip;
IDAOShipVotingToken public immutable sharesToken;

struct Poll {
    address creator;
    string question;          // IPFS hash or short text
    uint8 optionCount;        // 2-10
    uint64 snapshotTimestamp;  // block.timestamp at creation - 1
    uint64 votingEnds;
    bool cancelled;
    mapping(uint8 => uint256) optionVotes;
    mapping(address => bool) hasVoted;
}

uint256 public pollCount;
mapping(uint256 => Poll) public polls;
uint256 public immutable minSharesToCreatePoll;
uint256 public immutable maxDuration;
uint256 public immutable minDuration;
```

**Snapshot mechanism:** Reads `sharesToken.getPriorVotes(voter, poll.snapshotTimestamp)` at vote time. Snapshot is `block.timestamp - 1` at poll creation. Reuses DAOShipVotes' existing checkpoint system -- prevents vote buying (acquiring shares after poll creation does not grant voting power).

**Key functions:**

```solidity
function createPoll(string calldata question, uint8 optionCount, uint256 duration) external returns (uint256 pollId);
function vote(uint256 pollId, uint8 option) external;
function cancelPoll(uint256 pollId) external;
function getOptionVotes(uint256 pollId, uint8 option) external view returns (uint256);
function getResults(uint256 pollId) external view returns (uint256[] memory);
function hasVoted(uint256 pollId, address voter) external view returns (bool);
```

- `createPoll` -- requires `getPriorVotes(msg.sender, block.timestamp - 1) >= minSharesToCreatePoll`.
- `vote` -- checks not already voted, within deadline, valid option. Weight = `getPriorVotes(msg.sender, snapshotTimestamp)`. Requires weight > 0.
- No ReentrancyGuard needed (no external calls with value). No pause needed (non-executing).

**Events:** `PollCreated`, `Voted`, `PollCancelled`.

**Custom errors:** `InsufficientShares`, `InvalidOptionCount`, `InvalidDuration`, `PollEnded`, `PollCancelled`, `AlreadyVoted`, `InvalidOption`, `NoVotingPower`, `NotAuthorized`.

**Test scenarios:**

1. Happy path: 3 options, 3 voters with different weights, verify tallies
2. Revert: double vote -> `AlreadyVoted`
3. Revert: vote after deadline -> `PollEnded`
4. Revert: invalid option index -> `InvalidOption`
5. Revert: 0 shares -> `InsufficientShares`
6. Revert: delegated all shares -> `NoVotingPower`
7. Snapshot integrity: acquire shares after creation, verify 0 voting power
8. Cancel: creator cancels, voting reverts
9. Duration bounds: below min or above max -> `InvalidDuration`
10. Fuzz: random weights/options -- invariant: sum(optionVotes) == sum(voter weights)

**Estimated size:** ~130 lines of Solidity.

---

#### VestingNavigator (MANAGER)

**What it does:** Mints shares on a vesting schedule -- cliff period followed by linear unlock. Unvested shares are clawed back if the recipient leaves.

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

- `createSchedule` -- avatar only.
- `claim` -- beneficiary or avatar. Mints shares or loot depending on `isLoot` flag.
- `revoke` -- avatar only. Sets `revoked = true` and `revokedAt = block.timestamp`. Does NOT burn already-minted shares (non-destructive). Future claims capped at revocation point. Separate governance proposal needed to burn already-vested shares.

**Events:** `ScheduleCreated`, `TokensClaimed`, `ScheduleRevoked`, `Paused`, `Unpaused`.

**Custom errors:** `InvalidConfig`, `NotAuthorized`, `IsPaused`, `NothingToClaim`, `ScheduleRevoked`, `AlreadyRevoked`, `ZeroAmount`, `CliffExceedsVesting`, `InvalidBeneficiary`.

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

**Estimated size:** ~180 lines of Solidity.

---

#### NFTGatedNavigator (MANAGER)

**What it does:** Gates DAO membership behind NFT ownership (ERC-721 or ERC-1155). Members must hold a specific token to onboard. Supports free-mint (credential = membership) and tribute-required (credential + payment = membership) modes. Ownership checked live on every call -- no allowlist maintenance.

**Why DAO Ships needs this:** `mintShares` is permissionless from MANAGER navigators but has no built-in NFT check. The Merkle allowlist on OnboarderNavigator approximates this but requires off-chain tree updates whenever NFTs change hands.

**Why it matters at 1000+ members:** Gaming guilds, creator DAOs, protocol contributor programs, and real-world asset DAOs all use NFTs as credentials. Baking the check into the navigator eliminates continuous allowlist maintenance and makes membership instantly responsive to NFT transfers.

**Permission:** MANAGER (2). One claim per address (prevents transfer-and-reclaim attacks).

**Architecture:** On `onboard()`, checks `IERC721(gate).balanceOf(msg.sender) > 0` (or ERC-1155 equivalent). The `mintedTo` mapping tracks addresses (not token IDs) to prevent the transfer-and-reclaim attack. Two modes: free mint (`requireTribute = false`) and tribute required (`requireTribute = true`).

**State variables:**

```solidity
DAOShip public immutable daoShip;
address public immutable gateToken;
bool public immutable isERC1155;
uint256 public immutable requiredTokenId;   // ERC-1155 only
uint256 public immutable sharesPerHolder;
uint256 public immutable lootPerHolder;
bool public immutable requireTribute;
uint256 public immutable tributeAmount;
uint256 public immutable mintCap;
uint256 public immutable expiry;
uint256 public totalMinted;
mapping(address => bool) public mintedTo;
bool public paused;
```

**Key functions:**

```solidity
function onboard() external payable nonReentrant;
function pause() external;
function unpause() external;
```

- `onboard` -- checks pause, expiry, not already claimed, NFT ownership, tribute (if required), mint cap. Mints shares and/or loot.
- No perAddressCap needed (each address can only claim once).
- ERC-721: `balanceOf > 0` (any token in collection). ERC-1155: `balanceOf(account, tokenId) > 0` (specific ID).

**Events:** `Onboard`, `Paused`, `Unpaused`.

**Custom errors:** `IsPaused`, `Expired`, `AlreadyClaimed`, `NotHolder`, `IncorrectTribute`, `NoTributeRequired`, `TransferFailed`, `MintCapExceeded`, `NotAuthorized`, `InvalidConfig`.

**Test scenarios:**

1. ERC-721 happy path: mint NFT, onboard, verify shares received
2. ERC-1155 happy path with specific tokenId
3. Revert: no NFT -> `NotHolder`
4. Revert: already claimed -> `AlreadyClaimed`
5. NFT transfer: alice onboards, transfers NFT to bob, bob onboards (succeeds), alice cannot re-onboard
6. Tribute required: correct amount succeeds, wrong amount reverts
7. Free mint: 0 value succeeds, nonzero value reverts `NoTributeRequired`
8. Mint cap: cap=2, third onboard reverts
9. Expiry: past expiry reverts
10. Pause/unpause

**Estimated size:** ~140 lines of Solidity.

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
| **v1.1** | TimelockNavigator, BudgetNavigator | Protocol, Investment DAOs |
| **v1.2** | SignalNavigator, DelegateRegistryNavigator, NFTGatedNavigator | 200+ member governance, credential-gated DAOs |
| **v2.0** | VestingNavigator, CircuitBreakerNavigator | Core contributor compensation, safety automation |
| **v2.1** | OracleNavigator, SubscriptionNavigator | Adaptive governance, recurring fees |

### Navigator by DAO Configuration

| Navigator | Startup | Community | Protocol | Investment | Agent | Status |
|--------|---------|-----------|----------|------------|-------|--------|
| OnboarderNavigator | Required | Required | Required | Required | Required | **Shipped** |
| ERC20TributeNavigator | Optional | Required | Required | Required | -- | **Shipped** |
| BudgetNavigator | -- | Critical | Critical | -- | Critical | **Not built** |
| SignalNavigator | -- | Useful | Critical | -- | -- | **Not built** |
| TimelockNavigator | -- | -- | Critical | Critical | -- | **Not built** |
| VestingNavigator | -- | Useful | Critical | -- | -- | **Not built** |
| DelegateRegistryNavigator | -- | Useful | Critical | -- | -- | **Not built** |
| RageKick (pattern) | -- | Useful | Useful | Required | -- | **Documented** |
| SubscriptionNavigator | -- | -- | -- | Useful | -- | **Not built** |
| OracleNavigator | -- | -- | -- | -- | Useful | **Not built** |
| CircuitBreakerNavigator | -- | -- | Useful | Useful | Critical | **Not built** |
| NFTGatedNavigator | Useful | Useful | Useful | -- | -- | **Not built** |

---

## Summary Table

| Navigator | Permission | DAOShip Functions Called | Vault Module | Est. Lines |
|--------|-----------|---------------------|-------------|-----------|
| OnboarderNavigator | MANAGER (2) | `mintShares`, `mintLoot` | No | Shipped |
| ERC20TributeNavigator | MANAGER (2) | `mintShares`, `mintLoot` | No | Shipped |
| TimelockNavigator | GOVERNOR (4) | `setGovernanceConfig` | No | ~150 |
| BudgetNavigator | MANAGER (2) | `mintShares`, `mintLoot` (optional) | Yes | ~280 |
| SignalNavigator | None | None (reads only) | No | ~130 |
| DelegateRegistryNavigator | None | None (reads only) | No | ~120 |
| VestingNavigator | MANAGER (2) | `mintShares`, `mintLoot` | No | ~180 |
| CircuitBreakerNavigator | ADMIN (1) | `setAdminConfig` | No | ~170 |
| OracleNavigator | GOVERNOR (4) | `setGovernanceConfig` | No | ~180 |
| SubscriptionNavigator | MANAGER (2) | `burnShares`, `mintLoot` | No | ~190 |
| NFTGatedNavigator | MANAGER (2) | `mintShares`, `mintLoot` | No | ~140 |

**Total planned: ~1,540 lines of Solidity** across 9 contracts, plus test suites.

---

## Cross-Cutting Concerns

**Storage layout:** None of these navigators use upgradeable proxies. They are all deployed as immutable contracts. To change configuration, deploy a new instance and register it via governance proposal (which calls `setNavigators`). This eliminates upgrade bugs at the cost of redeployment -- an acceptable tradeoff for navigators whose config rarely changes.

**Gas budget:** Every navigator call to DAOShip costs the caller gas. The most expensive path is BudgetNavigator's `disburseBatch` with many recipients (one `execTransactionFromModule` per recipient). At 20 recipients, this is ~200K gas -- within block limits but worth noting for batch size guidance.

**Security dependency chain:** CircuitBreakerNavigator should be deployed before any MANAGER navigator that mints at scale (VestingNavigator, SubscriptionNavigator). The circuit breaker monitors for mint spikes that these navigators could cause if misconfigured or compromised.
