# ERC20TributeNavigator — Canonical Reference & Audit Sign-off

Source of truth for the ERC20 Tribute navigator. Indexer and app integration guides live in their
own repos and reference this document; the prose overview is in `docs/NAVIGATORS.md`
(ERC20TributeNavigator section).

- **Contract:** `contracts/navigators/ERC20TributeNavigator.sol`
- **Extends:** `BaseNavigator` (caps, allowlist, pause, mint helper); implements `INavigator`
- **Deploy script:** `scripts/deploy/004_deploy_navigators.ts` (deploys OnboarderNavigator + this; this one is skipped unless `TRIBUTE_TOKEN` is set)
- **Tests:** `test/unit/Navigators.test.ts` — `describe("ERC20TributeNavigator")`, 11 `it` cases; fee-on-transfer protection in `test/unit/DAOShipGaps.test.ts`; local E2E in `test/e2e/local/FullDAOLifecycle.test.ts`; on-chain E2E Phase 2b (approve flow) and Phase 2c (permit flow) in `test/e2e/onchain/OnChainDAOLifecycle.test.ts`
- **Permission tier:** MANAGER (2)

---

## 1. What it does

Onboards a contributor into a DAOShip DAO in exchange for an **ERC20 token tribute**. The caller asks
for an amount of shares and/or loot; the navigator computes the tribute price, pulls that ERC20 tribute
**directly to the DAO vault**, and mints the requested shares/loot to the caller — all in one transaction.
This is the ERC20 analogue of the native-tribute onboarder; the tribute is a configured ERC20 token,
**not native QUAI**.

### Mental model — "buy shares/loot at a fixed per-unit price, paid in ERC20"

There is **no escrow and no accumulation in the navigator**. Tribute is moved with
`SafeERC20.safeTransferFrom(msg.sender, vault, tributeAmount)` straight to `daoShip.avatar()`. The
navigator only ever holds the *right to mint* (its MANAGER permission); it never custodies the tribute
token. `withdrawStuckTokens` exists purely as a safety valve for tokens sent to the navigator address
by mistake (see §2 / §4).

### Pricing — raw-wei amounts, fixed per-unit price (`_calculateTribute`)

All amounts are in **raw wei** (1e18 = one whole share/loot token), which enables fractional purchases
and matches DAOShip's internal token accounting. The price is computed per component:

```solidity
// shares component (only if sharesToMint > 0)
if (pricePerShare == 0) revert InvalidConfig();          // shares not offered
uint256 shareTribute = (sharesToMint * pricePerShare) / 1e18;
if (shareTribute == 0) revert InsufficientAmount();      // dust truncated to 0

// loot component (only if lootToMint > 0)
if (pricePerLoot == 0) revert InvalidConfig();           // loot not offered
uint256 lootTribute = (lootToMint * pricePerLoot) / 1e18;
if (lootTribute == 0) revert InsufficientAmount();

tributeAmount = shareTribute + lootTribute;
```

`pricePerShare` and `pricePerLoot` are immutable and expressed in the tribute token's own decimals.
Example from the contract: `tributeToken = USDC`, `pricePerShare = 100e6` (100 USDC per whole share).
`onboard(5e18, 0)` mints 5 shares for 500 USDC; `onboard(5e17, 0)` mints 0.5 shares for 50 USDC.

### Each component is checked individually (anti-truncation)

Crucially, the `shareTribute == 0` and `lootTribute == 0` checks are applied **per component**, not on
the summed total. This is deliberate: it prevents a dust share request that truncates to 0 tribute from
piggybacking on a paid loot request (and vice-versa). A request whose share *or* loot tribute rounds to
zero reverts `InsufficientAmount`, even if the other component is non-zero.

### Tribute goes to the vault, not the navigator

The tribute is transferred to `daoShip.avatar()` (the DAO treasury / Gnosis-Safe-derived vault). The
navigator is never an intermediary holder. After the transfer it re-reads the vault balance to confirm
the full amount landed (see §4, fee-on-transfer).

### One call can mint shares, loot, or both

`onboard` takes both `sharesToMint` and `lootToMint`. Passing both as 0 reverts `InsufficientAmount`.
Minting shares dilutes voting power; minting loot dilutes economic/ragequit value but not votes.

---

## 2. ABI surface

### Constructor

```solidity
constructor(
    address _daoShip,          // DAOShip DAO address; reverts InvalidConfig if 0 (BaseNavigator)
    address _tributeToken,     // ERC20 accepted as tribute; reverts InvalidConfig if 0
    uint256 _pricePerShare,    // tribute per whole share, in tribute-token decimals (0 = shares not offered)
    uint256 _pricePerLoot,     // tribute per whole loot, in tribute-token decimals (0 = loot not offered)
    uint256 _expiry,           // unix ts, 0 = no expiry
    uint256 _mintCap,          // total shares+loot this navigator may mint, raw wei (0 = unlimited)
    uint256 _perAddressCap,    // per-address shares+loot cap, raw wei (0 = unlimited)
    bytes32 _allowlistRoot,    // Merkle root; bytes32(0) = open
    string  _name,             // optional, emitted once in NavigatorDeployed
    string  _description       // optional
) BaseNavigator(_daoShip, _expiry, _mintCap, _perAddressCap, _allowlistRoot)
```

Constructor reverts `InvalidConfig` when: `_daoShip == 0` (from `BaseNavigator`); `_tributeToken == 0`;
or **both** `_pricePerShare` and `_pricePerLoot` are 0 (at least one offering is required). Unlike some
sibling navigators, `_mintCap` is **not** required to be non-zero here — `0` means unlimited. The
constructor makes no call to the DAO, so it is safe against a *predicted* DAO address (the launch
pattern used by the on-chain E2E).

### Functions

```solidity
// Onboard — standard approve flow (caller must approve this contract for the tribute first)
function onboard(uint256 sharesToMint, uint256 lootToMint, bytes32[] calldata proof) public nonReentrant; // with allowlist proof
function onboard(uint256 sharesToMint, uint256 lootToMint) external nonReentrant;                          // no allowlist

// Onboard — ERC-2612 permit, single-tx approve + onboard
function onboardWithPermit(
    uint256 sharesToMint, uint256 lootToMint, bytes32[] calldata proof,
    uint256 deadline, uint8 v, bytes32 r, bytes32 s
) external nonReentrant;

// Governance recovery (avatar-only)
function withdrawStuckTokens(IERC20 token, address to, uint256 amount) external nonReentrant;

// Pause / unpause onboarding (GOVERNOR navigator OR avatar) — inherited from BaseNavigator
function pause() external;
function unpause() external;

// Public state
function tributeToken() external view returns (address);   // immutable
function pricePerShare() external view returns (uint256);   // immutable
function pricePerLoot() external view returns (uint256);    // immutable
string public constant navigatorType = "ERC20TributeNavigator";
// + inherited: daoShip, deployer, expiry, mintCap, perAddressCap, allowlistRoot, totalMinted, mintedTo, paused
```

All three onboard entry points funnel into the internal `_onboard`, which (in order): rejects when
`paused`; rejects when expired (`expiry != 0 && block.timestamp > expiry`); rejects zero/zero amounts;
checks the Merkle allowlist; computes tribute; enforces caps via `_checkAndUpdateCaps(sharesToMint +
lootToMint)`; transfers tribute to the vault with the fee-on-transfer balance check; mints; and emits
`Onboard`. `nonReentrant` lives on the external entry points, not on `_onboard`.

`onboardWithPermit` first calls `permit(msg.sender, address(this), tributeAmount, deadline, v, r, s)`
on the tribute token inside a `try/catch`, then runs the same `_onboard` path. The permit **owner is
always `msg.sender`** — the function takes no owner parameter (see §4, §5). If the permit reverts
(already consumed via retry/front-run, or the token is not ERC-2612), the catch swallows it and the
subsequent `safeTransferFrom` uses whatever allowance already exists; if none exists, the transfer
reverts and the whole call rolls back. Non-standard permits (e.g. DAI) are not supported.

`withdrawStuckTokens` requires `msg.sender == daoShip.avatar()` (else `NotAuthorized`), is
`nonReentrant`, transfers `amount` of `token` to `to` via `SafeERC20.safeTransfer`, and emits
`StuckTokensRecovered(token, to, amount)`.

### Events

```solidity
// BaseNavigator (shared onboarding feed)
event Onboard(address indexed daoShipAddress, address indexed contributor, uint256 amount, uint256 shares, uint256 loot);
event Paused(address indexed caller);
event Unpaused(address indexed caller);
// ERC20TributeNavigator-specific
event StuckTokensRecovered(address indexed token, address indexed to, uint256 amount);
// INavigator (constructor, once)
event NavigatorDeployed(address indexed daoShip, address indexed deployer, string navigatorType, string name, string description);
```

`Onboard.amount` is the **tribute amount actually paid** (in tribute-token decimals), and `shares`/`loot`
are the raw-wei amounts minted. Each successful onboard also fires the DAO's `MintShares`/`MintLoot`
plus the tribute token's `Transfer(msg.sender, vault, amount)` in the same tx — take balances from those
`Transfer` events and treat `Onboard` as the onboarding-activity feed (don't double-count).

### Errors

`InsufficientAmount` (navigator-specific) plus inherited from `BaseNavigator`: `IsPaused`, `Expired`,
`MintCapExceeded`, `PerAddressCapExceeded`, `NotAllowlisted`, `NotAuthorized`, `InvalidConfig`.

`InsufficientAmount` covers four distinct conditions: both onboard amounts zero; a share component that
truncates to zero tribute; a loot component that truncates to zero tribute; and the fee-on-transfer
shortfall (`actualReceived < tributeAmount`).

---

## 3. Configuration guidance

- **Prefer standard, well-behaved ERC20 tribute tokens.** Fee-on-transfer and rebasing/diverting
  tokens are *rejected* at onboard time by the balance-delta check (§4) — they don't break the contract,
  but onboarding with them simply reverts `InsufficientAmount`. Pick a normal ERC20 (e.g. USDC) so users
  can actually onboard.
- **Price in the tribute token's own decimals.** `pricePerShare`/`pricePerLoot` are per *whole*
  share/loot, denominated in the tribute token's units. For a 6-decimal token like USDC at 100 USDC/share,
  set `pricePerShare = 100e6`. The `/1e18` divisor in pricing is fixed and refers to the share/loot side,
  not the tribute side.
- **Set a price of 0 to disable an offering.** `pricePerShare = 0` means shares aren't sold (requesting
  shares reverts `InvalidConfig`); `pricePerLoot = 0` means loot isn't sold. At least one must be non-zero.
- **`mintCap` is the dilution backstop and is in raw wei.** It bounds *this navigator's* total
  shares+loot issuance — navigator-local, not DAO-global. `0` is unlimited; if you want a ceiling, size it
  against current supply at proposal-review time.
- **`perAddressCap` is per-wallet, also raw wei.** It is a per-wallet sanity bound, not an anti-whale
  guarantee (one actor can onboard from multiple wallets). `0` is unlimited.
- **Optional allowlist** composes on top of tribute: an allowlisted address still pays the tribute.
  Leaf encoding is `keccak256(bytes.concat(keccak256(abi.encode(msg.sender))))` (double-hashed, standard
  OpenZeppelin Merkle format).
- **Permit vs approve.** For ERC-2612 tokens (USDC and most modern ERC20s), the frontend can sign a
  gasless permit and call `onboardWithPermit` in a single tx, skipping the separate `approve`. Probe
  `nonces()` on the tribute token to detect permit support; fall back to approve + `onboard` otherwise.
- **To halt onboarding:** call the navigator's `pause()` (GOVERNOR navigator or avatar). Pausing the
  share/loot token via ADMIN does not stop this navigator from minting.

---

## 4. Gotchas (read this)

1. **Onboarding dies if you revoke the navigator's MANAGER bit.** Removing its permission is a
   fail-closed kill switch — `mintShares`/`mintLoot` revert and the whole onboard rolls back (CEI; tribute
   is not taken if minting fails). Use `pause()` for a reversible halt rather than yanking MANAGER.
2. **Per-component dust truncation reverts `InsufficientAmount`.** A share *or* loot request whose
   tribute rounds to zero reverts the whole call — even if the other component is paid. This is the
   anti-truncation guard; it is not a bug. Frontends should pre-compute `(amount * price) / 1e18 > 0`.
3. **Fee-on-transfer / diverting tokens are rejected, not silently under-credited.** After the
   `safeTransferFrom` to the vault, the navigator measures `balanceOf(vault)` before vs after and reverts
   `InsufficientAmount` if `actualReceived < tributeAmount`. So a token that skims a fee on transfer makes
   onboarding revert. This is the documented defense against fee-on-transfer and many ERC-777-style
   diverting tokens.
4. **`onboardWithPermit` never lets a third party spend someone else's allowance.** The permit owner is
   hard-coded to `msg.sender`; there is no `owner` parameter. This was an audit fix to prevent allowance
   theft via stale approvals (§5).
5. **`onboardWithPermit` swallows permit failures by design.** A consumed/front-run permit or a
   non-ERC-2612 token causes the `try/catch` to fall through to `safeTransferFrom`, which uses any
   existing allowance and reverts if there is none. So a "permit didn't apply" situation surfaces as a
   transfer revert, not a silent partial onboard.
6. **`withdrawStuckTokens` is avatar-only and not a tribute treasury.** Tribute never accumulates in the
   navigator (it goes straight to the vault), so this function only matters for tokens mistakenly sent to
   the navigator address. It is `nonReentrant` and emits `StuckTokensRecovered`. It can move *any* ERC20
   the navigator happens to hold — but the navigator is designed to hold none in normal operation.
7. **Caps and pricing are immutable.** `tributeToken`, `pricePerShare`, `pricePerLoot`, `mintCap`,
   `perAddressCap`, `expiry`, and `allowlistRoot` are fixed at deploy. To change pricing or the accepted
   token, deploy a new instance and re-register.
8. **`Onboard.amount` is tribute paid, not shares.** Read `shares`/`loot` for minted balances and
   `amount` for tribute. Cross-check against the tribute token's `Transfer` to the vault.

---

## 5. Security audit sign-off

No Critical/High/Medium open against the contract.

| Lens | Outcome |
|---|---|
| Blockchain Security Auditor (ERC-777 / fee-on-transfer tribute) | Originally filed **M-5 (Medium)** "ERC-777 tribute token callback risk"; **reclassified Informational (I-5) — already mitigated.** `SafeERC20` transfer + balance-before/after delta check rejects fee-on-transfer and diverting tokens; `nonReentrant` on all external entries; tribute goes **directly to the vault** (no `tokensReceived` hook target on the Safe-derived vault). No exploit path. |
| Allowance-theft review of `onboardWithPermit` | Permit owner is hard-coded to `msg.sender` (no owner parameter), preventing a caller from consuming a victim's stale approval. This is an applied audit fix and is enforced in source. |

**Verified properties:**
- Fee-on-transfer / diverting-token defense is in place and tested — see `docs/AUDIT_REPORT.md` (I-5)
  and the test `"ERC20TributeNavigator: fee-on-transfer (dust tribute) protection"` in
  `test/unit/DAOShipGaps.test.ts`.
- Reentrancy closed: `nonReentrant` on `onboard` (both overloads), `onboardWithPermit`, and
  `withdrawStuckTokens`; CEI ordering (caps updated before the external transfer; effects before mint).
- Per-component tribute truncation guard prevents dust-share-on-paid-loot piggybacking
  (`InsufficientAmount`).
- `onboardWithPermit` cannot spend a third party's allowance (owner fixed to `msg.sender`).
- `withdrawStuckTokens` is gated to `daoShip.avatar()` and emits `StuckTokensRecovered`.
- Inherited cap/allowlist/expiry/pause invariants from `BaseNavigator` apply unchanged.

**Operational caveats (configuration, not contract defects):** choosing a fee-on-transfer or
non-ERC-2612 tribute token degrades UX (onboarding reverts / permit unavailable) rather than introducing
a vulnerability; `mintCap`/`perAddressCap` default to unlimited (`0`) and must be sized by governance if
a ceiling is desired; `perAddressCap` is per-wallet, not a true anti-whale guarantee.

**Verdict:** Production-ready. The caveats above are governance/configuration concerns.

---

## 6. Deployment

`scripts/deploy/004_deploy_navigators.ts` deploys this alongside `OnboarderNavigator`. The ERC20 tribute
navigator is **skipped unless `TRIBUTE_TOKEN` is set** in the environment; it reads
`TRIBUTE_TOKEN`, `TRIBUTE_PRICE_PER_SHARE` (default `1e18`), `TRIBUTE_PRICE_PER_LOOT` (default `0`),
`TRIBUTE_MINT_CAP` (default `0` = unlimited), and `TRIBUTE_NAME`. After deploy, register as MANAGER
(permission `2`) via a `setNavigators` governance proposal. Each navigator is bound to one DAOShip clone
and is immutable — change pricing, the accepted token, caps, allowlist, or expiry by deploying a new
instance and re-registering.
