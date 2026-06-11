# BudgetNavigator — Canonical Reference & Audit Sign-off

Source of truth for the Budget navigator. Indexer and app integration guides live in their
own repos and reference this document; the indexer event spec is in
`docs/INDEXER-GUIDE.md` (BudgetNavigator section).

- **Contract:** `contracts/navigators/BudgetNavigator.sol`
- **Interface:** `contracts/interfaces/INavigator.sol`
- **Deploy script:** `scripts/deploy/009_deploy_budget_navigator.ts`
- **Tests:** `test/unit/BudgetNavigator.test.ts` (28 passing); local E2E `test/e2e/local/BudgetNavigator.e2e.test.ts` (2 passing); on-chain E2E Phase 2h in `test/e2e/onchain/OnChainDAOLifecycle.test.ts`
- **Permission tier:** **none** (holds NO ADMIN/MANAGER/GOVERNOR) — its only privilege is **vault module** status
- **Extends:** none — **standalone** (intentionally NOT `BaseNavigator`; see §3)

---

## 1. What it does

Lets governance approve a **recurring spending budget** against the DAO treasury (the Quai Vault)
and delegate execution to a per-budget **manager**, who pays out from the vault **without a
governance proposal per payment** — bounded by two governance-set caps:

- **`allowancePerPeriod`** — the maximum disbursable per period, which **resets each period** (lazily).
- **`totalCeiling`** — a **lifetime** cap across all periods (required, `> 0`).

### Mental model — "a delegated, capped spending allowance over the treasury"

This is the DAOShips analogue of the Gnosis/Safe **Allowance Module**. The navigator **holds no
funds**: each disbursement pulls directly from the vault via `execTransactionFromModule`, bounded by
the per-budget caps that live entirely in this contract. Treasury assets **stay in vault custody**
(so ragequit still reaches whatever remains) until the moment of payout.

Two disbursement rails, both **manager-only**:

| | `disburse(id, to, amount)` | `disburseBatch(id, to[], amounts[])` |
|---|---|---|
| Recipients/amounts | caller-supplied (discretionary) | caller-supplied list (payroll) |
| Caller | the budget's `manager` | the budget's `manager` |
| Caps | `allowancePerPeriod` + `totalCeiling` | same caps on the batch **sum** |
| Atomicity | single transfer | all-or-nothing (one failed transfer reverts the batch) |

### Treasury disbursement only — not minting

BudgetNavigator moves **existing treasury assets** (native QUAI or an ERC20). It **never mints**.
Paying contributors in *shares/loot on a schedule* is a different concern handled by
**VestingNavigator**. Keeping them separate means Budget can drain only the treasury, never dilute
the cap table — half the blast radius, half the audit surface.

### Disbursement mechanics

Mirror the audited `DAOShip.ragequit` treasury path exactly, hardcoded to `Operation.Call`:

```solidity
// native QUAI
IAvatar(avatar).execTransactionFromModule(to,    amount, "",                  Enum.Operation.Call);
// ERC20
IAvatar(avatar).execTransactionFromModule(token, 0,      transfer(to,amount), Enum.Operation.Call);
```

The returned `success` bool is checked and reverts (`TransferFailed`) on failure. The per-budget
`token` is governance-vetted at `createBudget` time (same trust as a guild token), so the raw-bool
check is sufficient — as in ragequit.

### Lazy period reset (no keeper)

Each budget stores `currentPeriodStart`. On every disbursement, if `block.timestamp >=
currentPeriodStart + periodLength`, the navigator advances `currentPeriodStart` by whole periods and
zeroes `spentThisPeriod` — computed on the next spend, so **no keeper / cron is required**. Unused
allowance does **not** roll over (it is "up to X per period", not an accrual).

---

## 2. ABI surface

### Constructor

```solidity
constructor(
    address _daoShip,    // DAOShip clone (its avatar/vault is the treasury); reverts InvalidConfig if 0
    string  _name,       // optional, emitted once in NavigatorDeployed
    string  _description // optional
)
```

The constructor only stores `daoShip` and emits `NavigatorDeployed` — it makes **no call** to the
DAO, so it is safe to deploy against a *predicted* DAO address (the launch pattern used by the
on-chain E2E).

### Functions

```solidity
// Governance (avatar-only — via a passed proposal)
function createBudget(
    address manager, address token, uint256 allowancePerPeriod, uint256 totalCeiling,
    uint64 periodLength, uint64 startTime, uint64 endTime
) external returns (uint256 budgetId);              // reverts IsPaused when paused
function updateManager(uint256 budgetId, address newManager) external;
function cancelBudget(uint256 budgetId) external;   // irreversible; halts disbursement

// Manager (the budget's disbursement authority)
function disburse(uint256 budgetId, address to, uint256 amount) external;
function disburseBatch(uint256 budgetId, address[] to, uint256[] amounts) external;

// Emergency freeze of createBudget + ALL disbursements
function pause() external;                           // GOVERNOR navigator OR avatar
function unpause() external;                         // GOVERNOR navigator OR avatar

// Views
function remainingThisPeriod(uint256 budgetId) external view returns (uint256); // live (lazy-adjusted)
function remainingTotal(uint256 budgetId) external view returns (uint256);
function budgets(uint256 budgetId) external view returns (...);  // public struct getter
function budgetCount() external view returns (uint256);
function paused() external view returns (bool);
// + INavigator: deployer(), navigatorType() == "BudgetNavigator", daoShip()
// + constants MIN_PERIOD (1 hours), MAX_PERIOD (3650 days)
```

`createBudget` validates: `manager != 0` (`InvalidManager`), `allowancePerPeriod > 0` (`ZeroAmount`),
`totalCeiling > 0` (`InvalidConfig`), `MIN_PERIOD <= periodLength <= MAX_PERIOD` (`InvalidPeriod`),
and `endTime == 0 || endTime > effectiveStart` (`InvalidConfig`). `startTime == 0` means "now".

### Events

```solidity
event BudgetCreated(uint256 indexed budgetId, address indexed manager, address token,
                    uint256 allowancePerPeriod, uint256 totalCeiling,
                    uint64 periodLength, uint64 startsAt, uint64 endsAt);
event Disbursed(uint256 indexed budgetId, address indexed to, address token, uint256 amount);
event ManagerUpdated(uint256 indexed budgetId, address indexed oldManager, address indexed newManager);
event BudgetCancelled(uint256 indexed budgetId, address indexed caller);
event Paused(address indexed caller);
event Unpaused(address indexed caller);
event NavigatorDeployed(address indexed daoShip, address indexed deployer, string navigatorType, string name, string description);
```

`Disbursed` fires **once per recipient** — `disburse` emits one, `disburseBatch` emits N — so the
indexer has a single uniform payout-record type. Each disbursement also moves value out of the vault
(a native transfer or an ERC20 `Transfer` from the vault); use the token `Transfer`/balance for
on-chain accounting and treat `Disbursed` as the budget-activity feed (don't double-count).

### Errors

`InvalidConfig`, `NotAuthorized`, `IsPaused`, `InvalidManager`, `InvalidRecipient`, `ZeroAmount`,
`InvalidPeriod`, `BudgetDoesNotExist`, `BudgetCancelled_`, `AlreadyCancelled`, `NotStarted`,
`BudgetEnded`, `AllowanceExceeded`, `CeilingExceeded`, `LengthMismatch`, `EmptyBatch`,
`NotEnabledModule`, `TransferFailed`.

---

## 3. Why standalone (not BaseNavigator), and the trust model

`BaseNavigator` exists for **minting** navigators (`mintCap`/`perAddressCap`, the mint helper).
BudgetNavigator mints nothing — it disburses treasury assets — so there is nothing to inherit.
Spending discipline lives entirely here, because **the vault imposes no per-module limit**: an
enabled module may `Call` the vault for any amount, any token. Budget fields are ordered for storage
packing (7 slots).

**The vault module grant is unbounded at the vault layer — this contract is the only on-chain
guarantee.** Blast radius is scoped by role:

- A compromised **`manager`** is bounded to its budget's `allowancePerPeriod` (per period) and
  `totalCeiling` (lifetime) — never the whole treasury.
- A **bug in this contract** that lets a disbursement exceed those caps risks the whole treasury,
  which is why the surface is minimal and the *only* function that touches the vault is the internal
  `_transfer`, reachable solely from the two manager-gated disburse rails (both `nonReentrant`,
  CEI-ordered, `Operation.Call` hardcoded — no DelegateCall path).

**Governance recourse escalates:** `pause` (fast freeze of all outflows; GOVERNOR navigator or
avatar) → `cancelBudget` (surgical, per budget; avatar) → the vault owners disabling this module
entirely (`vault.disableModule`; nuclear).

---

## 4. Gotchas (read this)

1. **Module status is unbounded at the vault layer.** Enabling Budget as a module gives it
   unrestricted transfer power over the vault; *all* limits are this contract's caps. Audit/upgrade
   this contract with treasury-grade care, and prefer disabling the module over leaving a dormant,
   unused budget navigator enabled.
2. **Payout liveness depends on the manager.** Only the per-budget manager can disburse — an absent
   or rogue manager cannot be routed around by recipients. Recourse is `updateManager` (swap),
   `pause` (freeze), or `cancelBudget`. This is the deliberate posture for a delegated spender.
3. **Unused allowance does not roll over.** Each period resets `spentThisPeriod` to 0; it does not
   accrue. "0.15/period" means at most 0.15 in *any* period, never a saved-up 0.30.
4. **`totalCeiling` can bind tighter than `allowancePerPeriod`.** `remainingThisPeriod` returns the
   smaller of the two remaining amounts. A budget is exhausted forever once `totalSpent == totalCeiling`.
5. **`pause` freezes BOTH disburse rails AND createBudget** — it is the emergency treasury brake
   (unlike VestingNavigator, where pause only blocks creation). Pause does not touch already-disbursed funds.
6. **`cancelBudget` is irreversible and does not claw back.** It stops *future* disbursement; funds
   already paid out are gone (recover via a separate governance action if needed).
7. **`createBudget` does not enable the module.** Wiring is two steps (both via governance): a proposal
   calling `vault.enableModule(budgetNav)` and proposals calling `createBudget`. They can be batched.
   `disburse` reverts `NotEnabledModule` (clear error) if the module was never enabled or was disabled.
8. **Back-dating `startTime` / lazy reset.** A back-dated `startTime` may put the budget in a later
   period immediately; the first disburse lazily advances `currentPeriodStart`. The on-chain
   `budgets(id).spentThisPeriod`/`currentPeriodStart` are stale until the next disburse — read
   `remainingThisPeriod` for the live, period-adjusted figure.
9. **Fee-on-transfer tokens.** The caps count the **gross** `amount` requested; a fee-on-transfer
   token delivers less to the recipient while the budget is debited the full `amount`. Configure such
   tokens with that in mind (or avoid them).
10. **One token per budget.** Create multiple budgets for multiple tokens. `token == address(0)` is
    native QUAI.

---

## 5. Security audit sign-off

No Critical/High/Medium open against the contract.

| Lens | Outcome |
|---|---|
| Access control | `createBudget`/`updateManager`/`cancelBudget` avatar-only; `disburse`/`disburseBatch` manager-only; `pause`/`unpause` GOVERNOR-navigator-or-avatar. The only vault-touching path (`_transfer`) is reachable solely from the two manager-gated rails. |
| Reentrancy | `nonReentrant` on every state-changing external; CEI (spend counters written before the transfer). A recipient re-entering a disburse rail is rejected by the manager-auth gate; a manager re-entering is blocked by the guard. A failed transfer reverts the whole call and rolls back the counters. |
| Caps / arithmetic | `spentThisPeriod + amount <= allowancePerPeriod` and `totalSpent + amount <= totalCeiling` checked before transfer; lazy period reset cannot underflow (`block.timestamp >= startsAt == initial currentPeriodStart` enforced by the active-window guard); uint64 period math bounded by `MAX_PERIOD`. |
| DelegateCall surface | None. `Operation.Call` is hardcoded; no caller supplies an operation. The vault's DelegateCall whitelist is irrelevant to this navigator. |

**Verified properties (tests):** caps enforced (period + ceiling, single and batch); lazy reset across
one and multiple skipped periods; failed transfer rolls back counters (CEI); `NotEnabledModule` clear
error when not a module; manager/avatar/governor authorization boundaries; cancel halts disbursement;
`updateManager` swaps authority; pause freezes both rails; views revert `BudgetDoesNotExist` on unknown
ids; on-chain disbursement of real treasury QUAI via the vault module path with the allowance cap enforced.

**Operational caveats (configuration, not contract defects):** unbounded module grant at the vault
layer (§3, §4.1); payout liveness depends on the manager (§4.2); fee-on-transfer accounting (§4.9).

**Verdict:** Production-ready. The caveats above are governance/configuration concerns.

---

## 6. Deployment & wiring

`scripts/deploy/009_deploy_budget_navigator.ts` (env-configured). Budget binds to one DAOShip clone
and is immutable — change behavior by deploying a new instance and re-wiring. Two governance steps
(batchable):

1. **Enable as a vault module:** a proposal whose MultiSend batch calls `vault.enableModule(budgetNav)`.
   The batch runs in the vault's context, so the self-call is authorized (`msg.sender == vault`).
   **No `setNavigators` — Budget holds no DAOShip permission.**
2. **Create budgets:** proposals calling `createBudget(manager, token, allowancePerPeriod, totalCeiling,
   periodLength, startTime, endTime)` (avatar-only). Managers then disburse within caps with zero
   further proposals.

Kill switches, escalating: `pause` (fast) → `cancelBudget` (surgical) → `vault.disableModule` (nuclear).
