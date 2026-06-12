# SubscriptionNavigator — Canonical Reference & Audit Sign-off

Source of truth for the Subscription navigator. Indexer and app integration guides live in their
own repos and reference this document; the indexer event spec is in
`docs/INDEXER-GUIDE.md` (SubscriptionNavigator section).

- **Contract:** `contracts/navigators/SubscriptionNavigator.sol`
- **Interface:** `contracts/interfaces/INavigator.sol`
- **Deploy script:** `scripts/deploy/010_deploy_subscription_navigator.ts`
- **Tests:** `test/unit/SubscriptionNavigator.test.ts` (32 passing); local E2E `test/e2e/local/SubscriptionNavigator.e2e.test.ts` (2 passing); on-chain E2E Phase 2i in `test/e2e/onchain/OnChainDAOLifecycle.test.ts`
- **Permission tier:** **MANAGER (2)** — calls `burnShares` / `convertSharesToLoot` (enforcement) and `mintLoot` (keeper reward)
- **Extends:** none — **standalone** (intentionally NOT `BaseNavigator`; see §3)

---

## 1. What it does

Recurring **membership dues**. Members **pull-pay** periodic fees to keep their membership current;
fees are forwarded straight to the DAO treasury (the vault, `daoShip.avatar()`). When a member lapses
past a grace window, **anyone** may `collectFee(member)` to strip the lapsed member's shares — and the
collector earns a small loot reward, funding a permissionless keeper.

### Mental model — "a subscription club over the cap table"

Dues are a rule for **everyone the DAO enrolls**, not an opt-in: stop paying and you lose your seat.
Two enforcement modes, fixed at deploy (`burnOnCollect`):

| | `burnOnCollect = false` (default) | `burnOnCollect = true` |
|---|---|---|
| Delinquent shares | **converted to loot** (`convertSharesToLoot`) | **burned** (`burnShares`) |
| Member keeps | economic value (loot), loses the **vote** | nothing — shares destroyed |
| Cap-table effect | shares→loot 1:1, value-neutral to the member | supply shrinks |
| Use case | membership / club dues | punitive seizure |

The non-destructive default resolves the "free-riders hold shares without paying" problem by removing
the **vote**, not the **equity** — a ragequit-style ejection.

### Multi-token, native + ERC20, oracle-free

The accepted-payment **menu** is set at construction: parallel `tokens[]` / `feesPerPeriod[]`, where
`token == address(0)` (`NATIVE`) is native QUAI and any other address is an ERC20 (WQI, USDT, USDC, …).
`payFee(periods, token)` lets the member **choose** which accepted token to pay in. Pricing is a fixed
governance-set fee **per token** (e.g. 10 USDC **or** 10 USDT **or** 500 QUAI per period) — **no price
oracle**. Members paying in whichever token is momentarily cheapest is an accepted, documented property;
governance sets the menu knowing this.

The menu is **immutable** — to change accepted tokens or prices, deploy a new navigator and
re-register it. (Suite-wide immutable-config convention; it also means members know the exact deal for
the life of the contract and governance cannot raise the fee mid-stream then mass-collect.)

### Enrollment & the clock

`paidThrough[member]` is the timestamp the member is paid up through, and doubles as the enrollment
flag (`0` ⇒ not enrolled, never collectible):

- `isCurrent` — enrolled && `now <= paidThrough`
- `inGracePeriod` — enrolled && `paidThrough < now <= paidThrough + grace`
- `isDelinquent` — enrolled && `now > paidThrough + grace` **(collectible)**

A member is brought under the subscription three ways, all of which **set the clock** (dues are never
optional, only un-started):

1. their own first `payFee` (self-enroll; **no** complimentary period — they paid),
2. governance `enroll` / `enrollBatch` — grants **one complimentary period** before dues begin, so
   bolting this navigator onto an existing DAO can never retroactively mass-eject the roster (every
   enrollee gets a full period + grace before they can be collected), or
3. `_initialMembers` at construction (same complimentary-period grant).

Because governance can **compel** enrollment, refusing to ever pay is not a loophole: governance
enrolls you, the clock runs, a keeper collects you if you still don't pay.

### Catch-up is a DEBT model

Paying advances `paidThrough` **forward from where it stood**, so a lapsed-but-still-enrolled member
must cover the missed periods to become current again — it does **not** silently forgive arrears by
restarting at "now". Arrears are naturally bounded: once past grace the member is collected, and
`collectFee` **un-enrolls** them (`paidThrough → 0`), so any later return starts fresh rather than
owing an unbounded historical debt.

---

## 2. ABI surface

### Constructor

```solidity
constructor(
    address   _daoShip,            // DAOShip clone (its avatar/vault is the treasury); reverts InvalidConfig if 0
    address[] _tokens,             // accepted payment tokens; address(0) = native QUAI, else ERC20
    uint256[] _feesPerPeriod,      // parallel to _tokens; each > 0; no duplicate tokens
    uint64    _periodDuration,     // MIN_PERIOD (1h) .. MAX_PERIOD (3650d)
    uint64    _graceDuration,      // 0 .. MAX_PERIOD
    uint64    _startTime,          // 0 = now
    uint256   _collectorRewardBps, // <= MAX_COLLECTOR_BPS (1000 = 10%)
    bool      _burnOnCollect,      // false = convert to loot, true = burn
    address[] _initialMembers,     // enrolled at deploy (one complimentary period each)
    string    _name, string _description
)
```

The constructor makes **no call** to the DAO (only stores immutables, builds the menu, stamps initial
members, emits `NavigatorDeployed`), so it is safe to deploy against a *predicted* DAO address.

### Functions

```solidity
// Members (pull payment) — payable; send native value only when token == NATIVE
function payFee(uint256 periods, address token) external payable;
function payFeeFor(address member, uint256 periods, address token) external payable; // gift/sponsor; payer funds it

// Permissionless keeper
function collectFee(address member) external; // member must be past grace; removes ALL their shares

// Governance (avatar-only — via a passed proposal)
function enroll(address member) external;             // one complimentary period; reverts AlreadyEnrolled
function enrollBatch(address[] members) external;     // skips already-enrolled (no revert)
function withdrawStuckTokens(IERC20 token, address to, uint256 amount) external; // recover mis-sent ERC20

// Emergency freeze of payFee + enroll + collectFee
function pause() external;   // GOVERNOR navigator OR avatar
function unpause() external; // GOVERNOR navigator OR avatar

// Views
function isCurrent(address) / inGracePeriod(address) / isDelinquent(address) / isEnrolled(address) returns (bool);
function nextDeadline(address member) external view returns (uint256);   // == paidThrough; 0 if not enrolled
function quote(uint256 periods, address token) external view returns (uint256); // reverts TokenNotAccepted
function getAcceptedTokens() external view returns (address[]);
function acceptedTokenCount() external view returns (uint256);
function feePerPeriod(address token) external view returns (uint256);    // 0 ⇒ not accepted
function paidThrough(address member) external view returns (uint256);
function acceptedTokens(uint256) external view returns (address);
// immutables: periodDuration, graceDuration, startTime, collectorRewardBps, burnOnCollect
// constants: NATIVE (address(0)), MAX_COLLECTOR_BPS (1000), MIN_PERIOD (1h), MAX_PERIOD (3650d)
// + INavigator: deployer(), navigatorType() == "SubscriptionNavigator", daoShip()
```

### Events

```solidity
event MemberEnrolled(address indexed member, uint256 paidThrough);
event FeePaid(address indexed member, address indexed payer, address indexed token,
              uint256 amount, uint256 periods, uint256 paidThrough);
event FeeCollected(address indexed member, address indexed collector,
                   uint256 sharesRemoved, uint256 reward, bool burned);
event StuckTokensRecovered(address indexed token, address indexed to, uint256 amount);
event Paused(address indexed caller);
event Unpaused(address indexed caller);
event NavigatorDeployed(address indexed daoShip, address indexed deployer, string navigatorType, string name, string description);
```

`FeePaid` fires **once per payment** and `FeeCollected` **once per collection** — the indexer derives
cumulative paid/collected totals by **SUM over these rows at end-of-range**, never an inline running
`+=` (replay/reorg would double-count). `FeeCollected.burned` distinguishes the enforcement mode;
in convert mode the member's `sharesRemoved` shares become loot (a `ConvertSharesToLoot` from the core
also fires), in burn mode they are destroyed (a `BurnShares`). The keeper reward is always a `MintLoot`.

### Errors

`InvalidConfig`, `NotAuthorized`, `IsPaused`, `InvalidMember`, `ZeroPeriods`, `TokenNotAccepted`,
`DuplicateToken`, `IncorrectPayment`, `InsufficientPayment`, `TransferFailed`, `AlreadyEnrolled`,
`NotDelinquent`, `NoSharesToBurn`.

---

## 3. Why standalone (not BaseNavigator), permission, and the trust model

`BaseNavigator` exists for **minting** navigators (`mintCap`/`perAddressCap`, keyed on `msg.sender`).
Subscription's dominant operation **removes** tokens (burn/convert) and its payer (`payFeeFor`) and
affected member differ, so the inherited `msg.sender`-keyed caps are the wrong shape — it is standalone.

**It is NOT a vault module.** `payFee` only moves *member* funds **into** the vault (ERC20
`transferFrom` member→vault, or native forwarded to the vault), never vault funds out, so it needs no
`execTransactionFromModule` privilege. It is registered the standard way, via a governance proposal
calling `setNavigators([this], [2])`.

**Permission scope (MANAGER, 2):** it can `burnShares`, `convertSharesToLoot`, and `mintLoot` on the
DAO. Blast radius if compromised/buggy: it could convert/burn member shares or mint loot. The keeper
reward is bounded (`<= MAX_COLLECTOR_BPS = 10%` of shares removed, minted as loot), and collection only
fires on members genuinely past grace. Governance recourse: `pause` (fast freeze) → re-register with
permission `0` to revoke → deploy a corrected navigator.

---

## 4. Gotchas (read this)

1. **Sponsor-threshold floor can block collection.** `DAOShip.burnShares` and `convertSharesToLoot`
   revert (`BurnBreachesSponsorThreshold` / `ConvertBreachesSponsorThreshold`) if removing the member's
   shares would drop shares' `totalSupply` below `sponsorThreshold`. Collecting a member who holds a
   large fraction of all shares can therefore be **un-callable** in a small DAO — the core revert
   bubbles up and the whole `collectFee` rolls back (the member stays enrolled & delinquent). This is
   intentional (governance must not be deadlocked by an automated collection), documented, not worked around.
2. **`collectFee` removes the member's ENTIRE current share balance**, read live at collection time —
   not a per-period proportional slice. A member can avoid this only by curing (paying) before grace ends.
3. **Debt model, not forgiveness.** A lapsed member must pay enough periods to push `paidThrough` past
   `now` to become current again. Paying one period when several are owed leaves them still delinquent.
4. **Native payments must be EXACT.** `payFee(periods, NATIVE)` requires `msg.value == feePerPeriod * periods`
   (`IncorrectPayment` otherwise) — no change is made. The ERC20 path rejects any stray `msg.value`.
5. **Fee-on-transfer tokens are rejected.** ERC20 payments are checked balance-before/after on the vault;
   a deflationary token that delivers less than `amount` reverts `InsufficientPayment`. Don't put one on the menu.
6. **The menu is immutable.** No setter for tokens/prices/period/grace/reward/mode — redeploy to change
   any of them. `feePerPeriod[token] == 0` means "not accepted" (`TokenNotAccepted`).
7. **Enrollment grants one complimentary period; first payment does not.** Governance `enroll` / initial
   members get `paidThrough = max(now, startTime) + periodDuration`; a member's own first `payFee` anchors
   at `max(now, startTime)` with no free period (they paid for what they got).
8. **`enrollBatch` skips already-enrolled members silently** (no revert, no event) so an overlapping batch
   still lands; `enroll` reverts `AlreadyEnrolled`. Neither resets a paid-ahead member's clock.
9. **Collection un-enrolls.** After `collectFee`, `paidThrough[member] → 0`; a later return re-enrolls fresh.
10. **`pause` freezes payFee, enroll, AND collectFee** — a paused subscription also shields members from
    delinquency enforcement. Pause does not alter any member's clock.
11. **Keeper-reward dilution.** The reward is freshly-minted loot (`<= 10%` of shares removed). In convert
    mode the member's converted loot is value-neutral; the only net dilution to other members is the small
    keeper reward.

---

## 5. Security audit sign-off

No Critical/High/Medium open against the contract.

| Lens | Outcome |
|---|---|
| Access control | `payFee`/`payFeeFor`/`collectFee` permissionless by design (collect gated on `isDelinquent`); `enroll`/`enrollBatch`/`withdrawStuckTokens` avatar-only; `pause`/`unpause` GOVERNOR-navigator-or-avatar. |
| Reentrancy | `nonReentrant` on every state-changing external. `payFee` writes `paidThrough` before the transfer (a failed/short transfer reverts the call). `collectFee` un-enrolls before the external DAOShip burn/convert/mint, so a re-entrant collect finds the member un-enrolled and a sponsor-threshold revert rolls the un-enroll back. |
| Payment integrity | Native requires exact `msg.value`; ERC20 uses `SafeERC20.safeTransferFrom` + balance-before/after on the vault (fee-on-transfer rejected); ERC20 path forbids stray native. |
| Arithmetic | Reward `= sharesRemoved * collectorRewardBps / 10000`, `collectorRewardBps <= 1000`; `paidThrough` only ever increases on payment (debt model) and resets to 0 only at collection; uint64 period math bounded by `MAX_PERIOD`. |
| Mint/burn surface | Only `collectFee` touches the cap table, only on a past-grace member with a non-zero share balance; sponsor-threshold guard enforced by the core bubbles up. |

**Verified properties (tests):** all 12 spec scenarios (happy path, pre-pay, pay-for-another, grace
transitions, collect+reward, not-delinquent revert, zero-shares revert, reward math, zero reward,
debt-model catch-up, fee-on-transfer rejection, monotonic `paidThrough`); convert vs burn mode;
native + multi-ERC20 menu and member token choice; exact-value / stray-value reverts; enrollment
(complimentary period, AlreadyEnrolled, batch-skip, un-enroll-on-collect, re-enroll-fresh);
sponsor-threshold revert rolls back; pause freezes all three rails; MANAGER-less collection reverts;
`withdrawStuckTokens` authorization; and on-chain registration via `setNavigators` proposal + the live
MANAGER burn/convert/mint path.

**Operational caveats (configuration, not contract defects):** sponsor-threshold floor can block
collection (§4.1); whole-balance collection (§4.2); oracle-free per-token pricing invites pay-in-cheapest
(§1); fee-on-transfer tokens unsupported (§4.5).

**Verdict:** Production-ready. The caveats above are governance/configuration concerns.

---

## 6. Deployment & wiring

`scripts/deploy/010_deploy_subscription_navigator.ts` (env-configured: token menu, fees, period, grace,
collector bps, burn mode, initial members). Subscription binds to one DAOShip clone and is immutable —
change behavior by deploying a new instance and re-registering. Two governance steps:

1. **Register with MANAGER:** a proposal calling `setNavigators([subNav], [2])` (routed through
   `executeAsGovernance` so the DAO self-calls — `setNavigators` is `governanceOnly`). Fires
   `NavigatorSet(subNav, 2)` → indexer `trust_status = 'sanctioned'` (the standard permissioned path).
2. **(optional) Enroll the existing roster:** proposals calling `enroll` / `enrollBatch` (avatar-only)
   to bring current members under dues with one complimentary period each. New members self-enroll on
   their first `payFee`.

Members then `payFee(periods, token)`; keepers `collectFee(member)` once a member is past grace.
Kill switch: `pause` (fast) → re-register with permission `0` (revoke) → redeploy a corrected navigator.
