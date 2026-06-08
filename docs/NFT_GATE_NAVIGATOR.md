# NFTGatedNavigator — Canonical Reference & Audit Sign-off

Source of truth for the NFT-Gated navigator. Indexer and app integration guides live in their
own repos (`daoships-indexer/docs/NFT_GATE_SUPPORT.md`, `daoships-app/docs/NFT_GATE_SUPPORT.md`)
and reference this document.

- **Contract:** `contracts/navigators/NFTGatedNavigator.sol`
- **Interface:** `contracts/interfaces/IMembershipGate.sol`
- **Deploy script:** `scripts/deploy/005_deploy_nft_gated_navigator.ts`
- **Tests:** `test/unit/NFTGatedNavigator.test.ts` (34 passing); on-chain E2E Phase 2d in `test/e2e/onchain/OnChainDAOLifecycle.test.ts`
- **Permission tier:** MANAGER (2)
- **Extends:** `BaseNavigator` (caps, allowlist, pause, mint helper); implements `IMembershipGate`

---

## 1. What it does

Onboards holders of a specific **ERC-721** collection into a DAOShip DAO. A holder calls
`onboard(tokenId)`; the navigator verifies `ownerOf(tokenId) == msg.sender` and mints a fixed
amount of shares/loot. Two modes: free-mint or exact native tribute (forwarded to the vault).

### Claim model — "claim ticket", one claim per `tokenId`, forever

- Claim tracking is **per-token** (`claimed[tokenId]`), not per-address.
- This defeats transfer-and-reclaim recycling: moving the NFT to a new wallet does **not** unlock a
  second claim, because the token itself is spent.
- Shares are a **ticket** — once minted they persist even if the NFT is later sold. The buyer of an
  already-claimed NFT receives nothing. **Frontends must surface `claimed[tokenId]`.**
- This is *not* revocable membership. "Lose-NFT-lose-shares" is not enforceable for an arbitrary
  external NFT and is reserved for a future escrow-based navigator.

### Scope — ERC-721 only

ERC-1155 is intentionally unsupported. Its native gating idiom is amount-based (`balanceOf(account,
id) >= N`) — a different feature reserved for a future `ERC1155GateNavigator`. Fungibility cannot be
reliably detected on-chain (no standard flag; `totalSupply` is optional and spoofable), so a fungible
1155 gate would be unsafe. See `docs/NAVIGATORS.md`.

---

## 2. ABI surface

### Constructor

```solidity
constructor(
    address _daoShip,
    address _gateToken,        // ERC-721 collection (must be a deployed contract)
    uint256 _sharesPerHolder,  // shares minted per claim (0 to mint only loot)
    uint256 _lootPerHolder,    // loot minted per claim (0 to mint only shares)
    bool    _requireTribute,
    uint256 _tributeAmount,    // wei; must be 0 iff _requireTribute == false
    uint256 _expiry,           // unix ts, 0 = none
    uint256 _mintCap,          // MANDATORY, > 0 — total shares+loot this navigator may mint
    uint256 _perAddressCap,    // 0 = unlimited (per-WALLET, see note)
    bytes32 _allowlistRoot,    // bytes32(0) = none; optional Merkle layer on top of the gate
    string  _name,
    string  _description
)
```

Constructor reverts (`InvalidConfig`) when: `_daoShip==0`; `_gateToken==0` or has no code;
both `_sharesPerHolder` and `_lootPerHolder` are 0; tribute flag/amount disagree (either direction);
`_mintCap==0`; one claim (`shares+loot`) exceeds `_mintCap`; or `_perAddressCap>0` and smaller than
one claim.

### Functions

```solidity
function onboard(uint256 tokenId) external payable;                       // no allowlist
function onboard(uint256 tokenId, bytes32[] calldata proof) external payable; // with allowlist proof

// IMembershipGate (stateless eligibility — independent of claim status)
function isEligible(address candidate) external view returns (bool);      // balanceOf > 0
function isEligibleToken(address candidate, uint256 tokenId) external view returns (bool); // ownerOf == candidate

// Frontend preflight: eligibility + claim status + pause + expiry (NOT tribute/caps)
function canOnboard(address candidate, uint256 tokenId) external view returns (bool);

// Public state
function claimed(uint256 tokenId) external view returns (bool);
function gateToken() external view returns (address);
function sharesPerHolder() external view returns (uint256);
function lootPerHolder() external view returns (uint256);
function requireTribute() external view returns (bool);
function tributeAmount() external view returns (uint256);
// + inherited: daoShip, expiry, mintCap, perAddressCap, allowlistRoot, totalMinted, mintedTo, paused, deployer
// + inherited: pause()/unpause()  (GOVERNOR navigator OR avatar)
```

### Events

```solidity
// BaseNavigator (shared across onboarding navigators — generic onboarding feed)
event Onboard(address indexed daoShipAddress, address indexed contributor, uint256 amount, uint256 shares, uint256 loot);
// NFTGatedNavigator-specific (adds the tokenId dimension)
event NFTClaimed(address indexed daoShipAddress, address indexed holder, uint256 indexed tokenId, uint256 shares, uint256 loot);
event Paused(address indexed caller);
event Unpaused(address indexed caller);
// INavigator (constructor, once)
event NavigatorDeployed(address indexed daoShip, address indexed deployer, string navigatorType, string name, string description);
```

Both `Onboard` and `NFTClaimed` fire on every successful claim. `Onboard.amount` is the native
tribute (0 in free-mint mode). `NFTClaimed` carries the spent `tokenId`. They are distinct
signatures — consumers must not double-count balances.

### Errors

`NotHolder`, `AlreadyClaimed`, `IncorrectTribute`, `NoTributeRequired`, `TransferFailed`
(+ inherited `IsPaused`, `Expired`, `MintCapExceeded`, `PerAddressCapExceeded`, `NotAllowlisted`,
`NotAuthorized`, `InvalidConfig`).

---

## 3. Configuration guidance

- **`mintCap` is mandatory and is the dilution backstop.** It bounds *this navigator's* total
  issuance — it is navigator-local, NOT DAO-global. If the gate collection is mintable, size the cap
  against the *maximum* plausible claimable supply, not today's supply.
- **`perAddressCap` is per-wallet**, so it is not an anti-whale guarantee for a transferable gate
  (a holder of N tokens can claim from N wallets). Use it only as a per-wallet sanity bound.
- **Free-mint vs tribute:** free-mint = `requireTribute=false, tributeAmount=0`; tribute =
  `requireTribute=true, tributeAmount>0` (exact match required, forwarded to the vault).
- **Optional allowlist** composes on top of the gate (must own an unclaimed token AND be allowlisted).
- **To halt onboarding:** call the navigator's `pause()` (GOVERNOR navigator or avatar). Pausing the
  share/loot token via ADMIN does **not** stop minting.

---

## 4. Security audit sign-off

Three review passes; no Critical/High/Medium open against the contract.

| Round | Lens | Outcome |
|---|---|---|
| 1 | Blockchain Security Auditor (reentrancy/claim/caps/tribute/constructor) | No Crit/High/Med. Applied: constructor guard `shares+loot ≤ mintCap`; per-wallet-cap sanity guard; documented no-ETH-recovery. |
| 2a | Blockchain Security Auditor (economic/governance/systemic) | One **Medium (M-01)**, doctrine-level — see below. Quorum & mid-proposal voting power correctly defended (sponsor-time snapshots). Hostile/self-referential gates contained. |
| 2b | Code Reviewer (correctness/succinctness) | No must-fix bugs ("cleanest navigator in the set"). Applied: extracted shared `_ownsToken`; added allowlist + tribute-failure + expiry + zero-gate tests. |
| 2c | Performance Benchmarker (gas) | "Not carrying fat." All config immutable, no redundant SLOADs, CEI correct. Dual event (~1.5k gas) kept for indexer uniformity. |

**Verified properties:** reentrancy closed (`nonReentrant` on entries + CEI; only untrusted call is
`ownerOf`, before effects); per-`tokenId` claim defeats recycling (no TOCTOU); `mintCap`/`perAddressCap`
accounting cannot be bypassed or drift; tribute mode exact and atomic (rejected forward reverts the
whole claim, `claimed` rolled back); ERC-1155 gates simply revert (`NotHolder`); views never revert.

### M-01 (accepted, documented operational caveat) — free-mint voids the retention-veto cost assumption

`SECURITY_GUIDE.md §7` accepts mint-during-governance on the basis that minting **costs tribute**. In
**free-mint mode** that rationale does not hold: a holder of a mintable/attacker-controlled gate can
mint shares at zero cost and time claims during a proposal's voting window to neutralize the
`minRetentionPercent` ragequit-as-veto (or inflate the high-water-mark). Quorum and mid-proposal
voting power are unaffected.

**Mitigations (for DAOs relying on `minRetentionPercent`):** prefer tribute-required mode; gate on a
fixed-supply, non-attacker-controlled collection; and/or `pause()` the navigator during contentious
votes. Documented in `SECURITY_GUIDE.md` (NFTGatedNavigator subsection).

**Verdict:** Production-ready. The free-mint caveat is an operational/configuration concern, not a
contract defect.

---

## 5. Deployment

`scripts/deploy/005_deploy_nft_gated_navigator.ts` (env-configured; enforces `mintCap > 0`). After
deploy, register as MANAGER (permission `2`) via a `setNavigators` governance proposal. Each navigator
is bound to one DAOShip clone and is immutable — change config by deploying a new instance and
re-registering.
