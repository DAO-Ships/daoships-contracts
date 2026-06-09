# OnboarderNavigator — Canonical Reference & Audit Sign-off

Source of truth for the Onboarder navigator. Indexer and app integration guides live in their
own repos and reference this document; the generic onboarding event spec is in
`docs/INDEXER-GUIDE.md`.

- **Contract:** `contracts/navigators/OnboarderNavigator.sol`
- **Interface:** `contracts/interfaces/INavigator.sol`
- **Deploy script:** `scripts/deploy/004_deploy_navigators.ts` (also deploys `ERC20TributeNavigator`)
- **Tests:** OnboarderNavigator coverage in `test/unit/Navigators.test.ts` (multiplier mode, fixed-price
  mode, mint cap, pause, expiry, Merkle allowlist describe blocks) and `test/unit/CoverageGaps.test.ts`
  (§12 and §28 `withdrawStuckETH`, §17 `perAddressCap`, §23 zero-mint truncation, plus `receive()`
  plain-transfer cases); on-chain E2E **Phase 2** ("Should onboard Bob via OnboarderNavigator") in
  `test/e2e/onchain/OnChainDAOLifecycle.test.ts`
- **Permission tier:** MANAGER (2)
- **Extends:** `BaseNavigator` (caps, allowlist, pause, mint helper, `_GOVERNOR` constant)

---

## 1. What it does

Onboards a contributor into a DAOShip DAO in exchange for **native tokens** (QUAI on Quai Network).
The contributor sends value to `onboard()`; the navigator mints shares and/or loot to the sender
(`msg.sender`) and forwards the tribute to the DAO treasury (`daoShip.avatar()`) — all atomically in
one transaction. This is the instant, permissionless, capped alternative to a per-applicant governance
admission proposal.

### Mental model — "pay native tokens, mint membership now"

`mintShares`/`mintLoot` on DAOShip require MANAGER permission. The navigator holds that permission and
gates it behind a pricing rule, so any contributor can mint their own membership without a proposal.
Tribute goes straight to the vault (`avatar`), not to the navigator — the navigator never custodies the
DAO's tribute (the only ETH that can land on the navigator is a failed fixed-price refund remainder;
see §1 fixed-price mode and §4).

### Two pricing modes (chosen at deploy, immutable)

The constructor enforces **exactly one** mode (it reverts `InvalidConfig` if neither or both are
configured):

- **Multiplier mode** — `shareMultiplier`/`lootMultiplier` are basis points (`10000` = 1×). Any payment
  `≥ minTribute` is accepted; the entire `msg.value` becomes the tribute (`cost = msg.value`) and:
  ```solidity
  sharesToMint = (msg.value * shareMultiplier) / 10000;
  lootToMint   = (msg.value * lootMultiplier)  / 10000;
  ```
  There is **no refund** — the full payment is forwarded to the vault.

- **Fixed-price mode** — set `pricePerUnit > 0` (and at least one of `sharesPerUnit`/`lootPerUnit > 0`).
  Payment is divided into whole units; the per-unit remainder is **refunded** to the sender:
  ```solidity
  if (msg.value < pricePerUnit) revert InsufficientTribute();
  uint256 units = msg.value / pricePerUnit;
  cost      = units * pricePerUnit;     // forwarded to vault
  remainder = msg.value - cost;         // refunded to msg.sender
  sharesToMint = units * sharesPerUnit;
  lootToMint   = units * lootPerUnit;
  ```

Mode is selected by which immutables are non-zero: `pricePerUnit > 0` ⇒ fixed-price; otherwise
multiplier. `minTribute` is the multiplier-mode anti-spam floor; in fixed-price mode the implicit floor
is `pricePerUnit` (a payment below one unit reverts `InsufficientTribute`).

### Anti-dust guard (both modes)

After computing amounts, the navigator rejects payments that mint nothing:
```solidity
uint256 toMint = sharesToMint + lootToMint;
if (toMint == 0) revert InsufficientTribute();
```
This catches multiplier-mode dust — a payment that clears `minTribute` but, after the `/ 10000` basis-
point division, truncates both `sharesToMint` and `lootToMint` to zero (see §4, gotcha 1).

### Plain ETH transfers onboard too (`receive()`)

A plain native-token send with **no calldata** (wallet/contract `transfer`/`send`/`call` without data)
hits `receive()`, which delegates to the same onboarding logic with an **empty proof**. This lets
ordinary "send to address" UX onboard a contributor identically to an explicit `onboard()` call. When
an allowlist is configured, `receive()` reverts early with `NotAllowlisted` (a plain transfer cannot
carry a Merkle proof) — allowlisted DAOs must use `onboard(bytes32[])`.

### Order of operations and atomicity

Within `_onboard`: pause/expiry checks → allowlist check → compute amounts → cap check/update → **mint
shares & loot** → **forward `cost` to the vault** → **refund `remainder`** (fixed-price only) → emit
`Onboard`. Minting happens before the tribute transfer; this is safe because `nonReentrant` blocks
re-entry, ERC20 `_mint` has no callbacks, and a reverting tribute transfer rolls back the mints by EVM
atomicity. A failed tribute forward reverts the whole call (`TransferFailed`); a failed refund reverts
the whole call (`RefundFailed`) — neither leaves a half-completed onboarding.

---

## 2. ABI surface

### Constants

```solidity
string public constant navigatorType = "OnboarderNavigator";
```

### Immutables

```solidity
// OnboarderNavigator
uint256 public immutable shareMultiplier;  // basis points (10000 = 1x); 0 in fixed-price mode
uint256 public immutable lootMultiplier;   // basis points; 0 in fixed-price mode
uint256 public immutable pricePerUnit;     // wei per unit; 0 in multiplier mode
uint256 public immutable sharesPerUnit;    // fixed-price mode only
uint256 public immutable lootPerUnit;      // fixed-price mode only
uint256 public immutable minTribute;       // wei; multiplier-mode anti-spam floor

// Inherited from BaseNavigator
address public immutable deployer;
DAOShip public immutable daoShip;
uint256 public immutable expiry;           // unix ts; 0 = no expiry
uint256 public immutable mintCap;          // total shares+loot this navigator may mint; 0 = unlimited
uint256 public immutable perAddressCap;    // max shares+loot per address; 0 = unlimited
bytes32 public immutable allowlistRoot;    // Merkle root; bytes32(0) = open
```

### Constructor

```solidity
constructor(
    address _daoShip,          // DAOShip clone (mint target); reverts InvalidConfig if 0 (BaseNavigator)
    uint256 _shareMultiplier,  // basis points; set 0 for fixed-price mode
    uint256 _lootMultiplier,   // basis points; set 0 for fixed-price mode
    uint256 _pricePerUnit,     // wei per unit; set 0 for multiplier mode
    uint256 _sharesPerUnit,    // fixed-price mode only
    uint256 _lootPerUnit,      // fixed-price mode only
    uint256 _minTribute,       // wei; multiplier-mode floor (0 allowed)
    uint256 _expiry,           // unix ts; 0 = none
    uint256 _mintCap,          // 0 = unlimited
    uint256 _perAddressCap,    // 0 = unlimited
    bytes32 _allowlistRoot,    // bytes32(0) = open
    string  _name,             // optional; emitted once in NavigatorDeployed
    string  _description       // optional
)
```

The constructor reverts `InvalidConfig` when: `_daoShip == 0` (from `BaseNavigator`); **neither** mode is
configured (no multiplier and `pricePerUnit == 0`); **both** modes are configured (a multiplier set
*and* `pricePerUnit > 0`); or fixed-price mode is selected but both `_sharesPerUnit` and `_lootPerUnit`
are 0. Mode flags: `isMultiplierMode = (_shareMultiplier > 0 || _lootMultiplier > 0)`,
`isFixedPriceMode = (_pricePerUnit > 0)`. The constructor makes **no call** to the DAO (only emits
`NavigatorDeployed`), so it is safe against a *predicted* DAO address.

> **Note:** `minTribute`, `mintCap`, and `perAddressCap` are not validated against the multiplier scale
> at deploy time. A `minTribute` too small for `shareMultiplier`/`lootMultiplier` can produce always-
> reverting dust onboards (§4, gotcha 1) — that is a configuration concern, not a constructor revert.

### Functions

```solidity
// Onboarding (payable)
function onboard(bytes32[] calldata proof) external payable nonReentrant;  // with allowlist proof
function onboard() external payable nonReentrant;                          // open onboarding (empty proof)
receive() external payable nonReentrant;                                   // plain ETH send → onboard (empty proof)

// Governance recovery of stuck native tokens
function withdrawStuckETH(address payable to, uint256 amount) external nonReentrant; // avatar-only

// Pause / unpause onboarding (BaseNavigator) — GOVERNOR navigator OR avatar
function pause() external;
function unpause() external;

// Public state / views
function shareMultiplier() external view returns (uint256);
function lootMultiplier() external view returns (uint256);
function pricePerUnit() external view returns (uint256);
function sharesPerUnit() external view returns (uint256);
function lootPerUnit() external view returns (uint256);
function minTribute() external view returns (uint256);
// + inherited: daoShip, expiry, mintCap, perAddressCap, allowlistRoot, totalMinted, mintedTo, paused, deployer
// + INavigator: navigatorType() == "OnboarderNavigator"
```

`withdrawStuckETH` is avatar-only (`msg.sender != daoShip.avatar()` ⇒ `NotAuthorized`), `nonReentrant`,
sends via low-level `call`, reverts `TransferFailed` on a failed send, and **emits
`StuckETHRecovered(to, amount)`** on success. It can withdraw to any address governance specifies.

### Events

```solidity
// BaseNavigator (generic onboarding feed — fires on every successful onboard)
event Onboard(address indexed daoShipAddress, address indexed contributor, uint256 amount, uint256 shares, uint256 loot);
event Paused(address indexed caller);
event Unpaused(address indexed caller);

// OnboarderNavigator-specific
event StuckETHRecovered(address indexed to, uint256 amount);

// INavigator (constructor, once)
event NavigatorDeployed(address indexed daoShip, address indexed deployer, string navigatorType, string name, string description);
```

`Onboard.amount` is the **tribute actually forwarded to the vault** (`cost`) — in fixed-price mode this
is the unit-multiple, **not** the gross `msg.value` (the refunded remainder is excluded). `shares` and
`loot` are the amounts minted in that call. Each onboard also fires a DAO `MintShares`/`MintLoot` plus
token `Transfer`; take **balances from `Transfer`** and treat `Onboard` as the onboarding-activity feed
(don't double-count). The contract does **not** emit a per-refund event — only `StuckETHRecovered` on
governance recovery of a *failed* refund.

### Errors

```solidity
// OnboarderNavigator
error InsufficientTribute();  // payment below floor, or anti-dust (mints zero)
error TransferFailed();       // tribute forward to vault failed, OR withdrawStuckETH send failed
error RefundFailed();         // fixed-price remainder refund to sender failed
```
Inherited from `BaseNavigator`: `Expired`, `MintCapExceeded`, `PerAddressCapExceeded`, `NotAllowlisted`,
`IsPaused`, `NotAuthorized`, `InvalidConfig`.

---

## 3. Configuration guidance

- **Pick one pricing mode.** Multiplier mode (proportional, no refunds) or fixed-price mode (unit-based,
  remainder refunded). The constructor rejects "neither" and "both." In fixed-price mode at least one of
  `sharesPerUnit`/`lootPerUnit` must be non-zero.
- **`mintCap` is the dilution backstop and is navigator-LOCAL, not DAO-global.** It bounds *this
  navigator's* total `shares + loot` issuance. Two OnboarderNavigators on the same DAO each have their
  own cap; total issuable supply is the **sum** of all navigator caps. Size grants against current
  supply at proposal-review time. `0 = unlimited`.
- **`perAddressCap` is keyed to `msg.sender`** (the caller, who is also the recipient here). It is a
  per-wallet bound, not an anti-whale guarantee — a whale can split across N wallets. `0 = unlimited`.
- **`minTribute` (multiplier mode) must clear the basis-point scale.** Set it high enough that the
  smallest accepted payment still mints ≥ 1 unit after `/ 10000`, or dust onboards always revert
  `InsufficientTribute` (§4, gotcha 1). In fixed-price mode the floor is `pricePerUnit` itself.
- **Optional Merkle allowlist** curates membership on top of pricing. Leaves are double-hashed
  (`keccak256(bytes.concat(keccak256(abi.encode(addr))))`, OZ standard) — generate the tree the same
  way. With an allowlist active, plain ETH sends to `receive()` revert `NotAllowlisted`; use
  `onboard(bytes32[])`.
- **Expiry** (`expiry`, unix ts; `0` = none) hard-stops onboarding after the timestamp (`Expired`).
- **To halt onboarding:** call the navigator's `pause()` (GOVERNOR navigator or avatar). Pausing the
  **share/loot token via ADMIN does NOT stop onboarding** — minting flows through the DAO's MANAGER
  mint path, not the token's pause. Use the navigator's own `pause()`.
- **Recovering stuck native tokens:** only a failed fixed-price refund (a contract sender that rejects
  ETH would revert the whole onboard anyway, so in practice stuck ETH arises from edge-case sends) can
  leave value on the navigator. Governance recovers it via `withdrawStuckETH` (avatar-only).

---

## 4. Gotchas (read this)

1. **Multiplier-mode dust reverts `InsufficientTribute`, even above `minTribute`.** Because
   `sharesToMint = (msg.value * shareMultiplier) / 10000`, a payment that clears `minTribute` but
   truncates both shares and loot to zero is rejected by the `toMint == 0` anti-dust guard — not minted
   as zero. Tested in `CoverageGaps.test.ts` §23 (`shareMultiplier = 1`, `minTribute = 1 wei`, pay 9999
   wei → reverts). Set `minTribute` against the multiplier scale.
2. **`Onboard.amount` is `cost`, not `msg.value`.** In fixed-price mode the refunded remainder is
   excluded from the event amount. Indexers reading "tribute paid" should use `cost`; the gross payment
   minus refund is not surfaced separately.
3. **`perAddressCap` is `msg.sender`-keyed.** This is correct *only because the recipient is always
   `msg.sender`* here. Do not assume the cap follows the recipient if you fork the recipient logic. It
   is per-wallet, so it is not whale-proof for a determined actor with multiple wallets.
4. **Caps are navigator-LOCAL, not DAO-global.** `mintCap`/`perAddressCap` bound only this navigator's
   issuance. Multiple navigators (or governance proposals minting directly) bypass each other's caps.
   The DAO's true dilution ceiling is the sum across all minting paths.
5. **Pausing the token via ADMIN does not stop onboarding.** Onboarding mints through the DAO's MANAGER
   path. Use the navigator's `pause()` (GOVERNOR navigator or avatar). `pause()` blocks `onboard()`,
   `onboard(bytes32[])`, and `receive()` (all hit `_onboard`, which reverts `IsPaused`).
6. **Allowlisted DAOs break plain ETH sends.** With `allowlistRoot != 0`, `receive()` reverts
   `NotAllowlisted` because a plain transfer cannot carry a proof. Wallets that "just send" will fail;
   the frontend must route through `onboard(bytes32[])`.
7. **A contract sender that rejects ETH refunds will revert the whole onboard.** In fixed-price mode a
   non-zero remainder is refunded via `call`; if that fails, the entire `_onboard` reverts
   (`RefundFailed`) and no shares are minted — fail-closed. `withdrawStuckETH` exists for edge-case
   residue, not as the normal refund path.
8. **Tribute goes to the avatar, not the navigator.** The navigator forwards `cost` to
   `daoShip.avatar()`. If that transfer fails it reverts `TransferFailed` and rolls back the mints —
   the DAO never receives a mint without the matching tribute.
9. **Losing MANAGER fails closed.** If governance revokes the navigator's MANAGER bit, every `onboard`
   reverts at the `mintShares`/`mintLoot` call and rolls back cleanly. That is a kill switch, distinct
   from `pause()` (which is the intended, reversible halt).

---

## 5. Security audit sign-off

No Critical/High/Medium open against the contract. OnboarderNavigator is tracked across the SSSES audit
cycles recorded in `SECURITY_GUIDE.md` and `docs/AUDIT_REPORT.md`.

| Lens | Outcome |
|---|---|
| Blockchain Security Auditor (reentrancy / access control / pricing / refund) | No Crit/High/Med. `nonReentrant` on all external entry points **including `receive()`**; CEI honored (caps updated before mint; mint-then-forward is atomic under the guard); ERC20 `_mint` has no callbacks. |
| `receive()` reentrancy (SSSES v5, labeled **C-1**) | **Fixed.** `SECURITY_GUIDE.md` records "v5: C-1 (OnboarderNavigator `receive()` nonReentrant) fixed" — the plain-ETH entry point carries the same `nonReentrant` guard as the explicit `onboard` functions. |
| Refund failure edge case (initial **L-6**, later removed) | **Removed / non-issue.** Per `docs/AUDIT_REPORT.md`: a failed refund reverts the entire `_onboard` (no ETH accumulates from the normal path), and `withdrawStuckETH` is the recovery safety valve for any residue. "Non-exploitable and already gracefully handled." |
| `withdrawStuckETH` hardening | Avatar-only + `nonReentrant`; reverts `TransferFailed` on a failed send (changed from a `require`-string to a custom error) and now emits `StuckETHRecovered(to, amount)` for indexer visibility. |

> **Terminology note.** "C-1" is overloaded across the docs: `SECURITY_GUIDE.md §1` titles its Navigator
> Permission Model section "C-1," `docs/AUDIT_REPORT.md` uses "C-1" for the (resolved) legacy
> deploy-script cleanup, and the SSSES v5 changelog uses "C-1" for the OnboarderNavigator `receive()`
> `nonReentrant` fix. They are distinct findings under the team's own per-cycle labeling. The
> OnboarderNavigator-relevant one is the v5 `receive()` `nonReentrant` fix.

**Verified properties:** reentrancy closed on every entry point (`onboard`, `onboard(bytes32[])`,
`receive`, `withdrawStuckETH`); exactly-one-mode is constructor-enforced (`InvalidConfig`); the anti-dust
guard prevents zero-mint onboards; `mintCap`/`perAddressCap` accounting cannot be bypassed or drift;
fixed-price refund is atomic (failed refund reverts the whole call); tribute always reaches the vault or
the mint rolls back; stuck-ETH recovery is avatar-only.

**Operational caveats (configuration, not contract defects):** caps are navigator-local (size against
supply — §3); `minTribute` must be sized against the multiplier scale (§4.1); `perAddressCap` is
per-wallet, not whale-proof (§4.3); allowlisted DAOs cannot use plain ETH `receive()` (§4.6).

**Verdict:** Production-ready. The caveats above are governance/configuration concerns.

---

## 6. Deployment

`scripts/deploy/004_deploy_navigators.ts` deploys OnboarderNavigator (env-configured; also deploys
`ERC20TributeNavigator` when `TRIBUTE_TOKEN` is set). Key env vars: `ONBOARDER_SHARE_MULTIPLIER`
(default `10000` = 1×), `ONBOARDER_LOOT_MULTIPLIER`, `ONBOARDER_PRICE_PER_UNIT` (0 = multiplier mode),
`ONBOARDER_SHARES_PER_UNIT`, `ONBOARDER_LOOT_PER_UNIT`, `ONBOARDER_MIN_TRIBUTE` (default `0.01` QUAI),
`ONBOARDER_EXPIRY`, `ONBOARDER_MINT_CAP`, `ONBOARDER_PER_ADDRESS_CAP`, `ONBOARDER_ALLOWLIST_ROOT`,
`ONBOARDER_NAME`, `ONBOARDER_DESCRIPTION`. The navigator must point at a deployed DAOShip **clone**
(`DAOSHIP_ADDRESS`), not the singleton.

After deploy, register as MANAGER (permission `2`) via a `setNavigators` governance proposal (or during
DAO `setUp`). Each navigator is bound to one DAOShip clone and is immutable — change pricing/caps/
allowlist by deploying a new instance and re-registering. To halt, call `pause()`; to retire, set its
permission to `0`.
