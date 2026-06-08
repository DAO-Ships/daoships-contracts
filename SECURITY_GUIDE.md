# DAO Ships DAO Security Guide

This guide documents security considerations for operators deploying and managing DAOs on daoships-contracts. It covers known architectural trust boundaries, required deployment steps, and configuration best practices derived from the [security audit](SECURITY-AUDIT.md).

---

## Table of Contents

1. [Navigator Permission Model](#1-navigator-permission-model-c-1)
2. [MultiSend DelegateCall and Vault Guard Layer](#2-multisend-delegatecall-and-vault-guard-layer-c-2)
3. [Vault Module Enablement Must Be Atomic](#3-vault-module-enablement-must-be-atomic-h-2)
4. [Governance Parameter Floors](#4-governance-parameter-floors-h-3)
5. [Guild Token Safety and Ragequit Guarantees](#5-guild-token-safety-and-ragequit-guarantees-h-5)
6. [Deployment Checklist](#6-deployment-checklist)

---

## 1. Navigator Permission Model (C-1)

### What navigators can do

DAOShip uses a three-bit permission bitmask for navigators:

| Bit | Name | Value | Capabilities |
|-----|------|-------|-------------|
| 0 | ADMIN | 1 | `setAdminConfig` — pause/unpause share and loot token transfers |
| 1 | MANAGER | 2 | `mintShares`, `mintLoot`, `burnShares`, `burnLoot`, `convertSharesToLoot` |
| 2 | GOVERNOR | 4 | `setGovernanceConfig`, `cancelProposal` |

Note: `setNavigators`, `setGuildTokens`, `lockAdmin`, `lockManager`, and `lockGovernor` are **governanceOnly** — they require a passed governance proposal via `executeAsGovernance`, not any navigator permission tier.

Permissions combine: a navigator with value `7` holds all three roles simultaneously.

### The trust assumption

**MANAGER navigators have unrestricted token supply control.** `mintShares` and `mintLoot` accept any recipient array with no restriction on who the recipients are. A MANAGER navigator can mint tokens to itself or to any address, including addresses it controls.

This is an intentional design pattern inherited from upstream baalZodiac (Moloch v3). The architecture assumes MANAGER navigators are:
- Immutable, fully audited smart contracts
- Logically bounded in what they can mint (e.g., `mintCap`, `expiryTime`, `allowlist`)
- Not EOAs or upgradeable contracts with unconstrained logic

### What can go wrong

A MANAGER navigator with no mint cap and no allowlist can:
1. Mint enough shares to itself to exceed `sponsorThreshold`
2. Self-sponsor a governance proposal
3. Vote yes with its newly minted shares (eligible after 1 block)
4. After `votingPeriod + gracePeriod`, execute the proposal

If that proposal calls `setNavigators([attacker], [7])` via `executeAsGovernance`, the attacker gains full control — admin, manager, and governor simultaneously. From there: mint unlimited supply, pause tokens (blocking ragequit), drain treasury.

### Rules for DAO operators

**Never grant MANAGER permission to:**
- An EOA (externally owned account)
- An upgradeable proxy contract without governance-controlled upgradeability
- Any contract that allows the deployer or any single party to change its minting logic

**Always verify a MANAGER navigator contract has at least one of:**
- A `mintCap` that hard-limits total issuance
- An allowlist restricting who can trigger minting
- An expiry time after which minting is disabled
- Bounded per-call minting (e.g., fixed amounts per QUAI tribute)

**Examples of acceptable MANAGER navigators:**
- `OnboarderNavigator` with `mintCap` set and no admin upgrade path
- `ERC20TributeNavigator` with `pricePerShare` set, verified token address, and expiry configured
- `NFTGatedNavigator` with a verified ERC-721 gate collection and `mintCap` set (cap is enforced mandatory in the constructor)

**Examples of unacceptable MANAGER navigators:**
- An EOA with MANAGER permission set during deployment
- A proxy contract where the deployer controls the implementation

### NFTGatedNavigator — gate-token trust and dilution bounds

`NFTGatedNavigator` mints to holders of an arbitrary external **ERC-721** collection (`gateToken`). Trust considerations specific to it:

- **The gate collection is untrusted code.** The only external call into it during onboarding is `ownerOf(tokenId)`, made before any state change and protected by `nonReentrant` + checks-effects-interactions, so a malicious/reentrant collection cannot recycle a claim or corrupt accounting. A collection that *lies* about ownership only harms the DAO that chose to gate on it — **verify the gate address points at the intended, legitimate collection before granting MANAGER.**
- **Mintable collections and dilution.** If the gate collection can mint new NFTs, each new token is a potential new claim. `mintCap` is therefore **mandatory** (the constructor reverts on `mintCap == 0`) and is the hard bound on **this navigator's** issuance. Note it is *navigator-local*, not DAO-global: DAO-wide dilution is the sum of all MANAGER navigators' caps plus any governance minting. Size `mintCap` against the *maximum* plausible claimable supply, not today's supply.
- **One claim per `tokenId`, forever.** Claim tracking is per-token (`claimed[tokenId]`), not per-address, which defeats transfer-and-reclaim recycling. Shares are a claim ticket and persist after the NFT is sold — there is no clawback. Do not use this navigator if revocable, NFT-bound membership is required (that needs an escrow-based design with non-transferable shares).
- **ERC-721 only.** ERC-1155 is rejected by design; fungibility cannot be reliably detected on-chain, so a fungible 1155 gate would be unsafe. Use a future dedicated ERC-1155 navigator instead.
- **To stop onboarding, use the navigator's own `pause()` (GOVERNOR or avatar).** Pausing the share/loot token via ADMIN does **not** stop minting — per M-8, token pause blocks transfers, not mint/burn — so a paused token still lets NFTGated issue governance-weighted shares.

#### ⚠️ Free-mint mode voids the ragequit-as-veto cost assumption (M-01)

§7 accepts the "mint-during-governance" behavior (V7-1 / M-4) on the explicit reasoning that new minting **costs full tribute**, making abuse economically equivalent to ragequit-then-re-onboard. **That rationale does not hold for an NFTGatedNavigator deployed in free-mint mode (`requireTribute = false`).** There, a holder of gate NFTs can mint shares at **zero cost**, gated only by NFT ownership and `mintCap`.

If the gate collection is open-mint or attacker-controlled, this lets an attacker **costlessly manipulate the `minRetentionPercent` retention check**: by claiming during a proposal's voting window they raise total supply (and the retention high-water-mark), and can land supply above `retentionRequired` at processing time to **neutralize an honest ragequit-as-veto for free** — or inflate the high-water-mark to make a legitimate proposal easier to veto-block. Quorum (frozen shares-only snapshot at sponsor time) and mid-proposal voting power (sponsor-time `getPriorVotes` snapshot) are **not** affected — those defenses hold identically to OnboarderNavigator. Only the retention veto's *cost assumption* breaks.

**Mitigations for any DAO that relies on `minRetentionPercent` as a governance check:**
- Prefer **tribute-required** mode, or gate on a **fixed-supply, non-attacker-controlled** collection, so the cost assumption is restored.
- During contentious votes, **`pause()` the navigator** (GOVERNOR or avatar) to halt costless minting for the duration.
- Size `minRetentionPercent` and `mintCap` with this interaction in mind; do not assume a free-mint gate preserves the veto.

### Mint cap is navigator-local, not global

`mintCap` in OnboarderNavigator and ERC20TributeNavigator is per-navigator. If you deploy two OnboarderNavigators for the same DAOShip, each has its own cap. The total issuable supply is the sum of all navigator caps, not a DAO-wide ceiling. Plan total share supply accordingly.

---

## 2. MultiSend DelegateCall and Vault Guard Layer (C-2) — FIXED

> **Status: FIXED at infrastructure level (QuaiVault v2).** The vault now uses a per-target `delegatecallAllowed` whitelist and defaults to MultiSendCallOnly, which rejects `operation=1` sub-transactions. The attack vector described below is eliminated.

### How proposal execution works

When a governance proposal executes, the call chain is:

```
DAOShip.processProposal()
  → QuaiVault.execTransactionFromModule(multisendCallOnlyLibrary, DelegateCall)
    → [MultiSendCallOnly runs in QuaiVault's storage context]
      → sub-transactions (CALL only — operation=1 reverts)
```

### The DelegateCall whitelist model

QuaiVault v2 replaces the `delegatecallDisabled` boolean with a per-target whitelist:

```solidity
mapping(address => bool) public delegatecallAllowed;
```

- Only addresses explicitly whitelisted can be DelegateCall targets via `execTransactionFromModule`
- `DAOShipAndVaultLauncher` creates vaults with `delegatecallAllowed[multisendCallOnlyAddress] = true`
- All other DelegateCall targets are rejected by default

### MultiSendCallOnly vs MultiSend

**MultiSendCallOnly** is now the default library. It differs from the original MultiSend in one critical way: it rejects any sub-transaction with `operation = 1` (DelegateCall). This means even if a malicious proposal passes governance, the sub-DelegateCall attack path is blocked at the library level.

The original MultiSend supported `operation = 1` sub-transactions, which could write arbitrary data to vault storage. MultiSendCallOnly eliminates this vector entirely.

### Why this is now safe

The combination of two layers provides defense-in-depth:

1. **Whitelist layer (vault):** Only MultiSendCallOnly is whitelisted for DelegateCall — no arbitrary contract can be DelegateCall'd into the vault's storage context
2. **Library layer (MultiSendCallOnly):** Even the whitelisted library rejects `operation = 1` sub-transactions — nested DelegateCall is impossible

### Remaining governance considerations

While C-2 is fixed at the infrastructure level, standard governance vigilance remains good practice:

- Higher quorum thresholds and longer voting periods increase the cost of passing any malicious proposal
- Vault owners retain emergency power via the multisig
- The `encodeMultisend` helper in DAOShipUtils always emits `operation = 0` (Call)

---

## 3. Vault Module Enablement Is Atomic (H-2) — FIXED

> **Status: FULLY FIXED (QuaiVault v2).** `DAOShipAndVaultLauncher` uses predict-then-create: it predicts the DAOShip address via CREATE2, creates the vault with `initialModules=[predictedDAOShip]`, then creates DAOShip. The module is enabled atomically during vault creation. There is no deployment gap.

### How atomic enablement works

`DAOShipAndVaultLauncher.launchDAOShipAndVault()` executes in a single transaction:

1. **Predict** the DAOShip clone address via `Clones.predictDeterministicAddress()`
2. **Create vault** via `IQuaiVaultFactory.createWallet()` with `initialModules=[predictedDAOShipAddress]` — the vault is deployed with DAOShip already registered as a module
3. **Create DAOShip** clone at the predicted address — it is immediately an active module on the vault

There is no window where the vault exists without DAOShip as a module. The previous H-2 attack scenario (deployer creates vault, never enables module, collects tribute) is eliminated.

### Deployment validation

After launching, verify the atomic enablement succeeded:

```typescript
const daoShipAddress = await launcher.getLastDAOShipAddress(); // or from event
const vaultAddress = await daoShip.avatar();
const vault = new ethers.Contract(vaultAddress, QuaiVaultABI, provider);

// Should always be true immediately after launchDAOShipAndVault
const moduleEnabled = await vault.isModuleEnabled(daoShipAddress);
if (!moduleEnabled) throw new Error("CRITICAL: DAOShip is not enabled as vault module");
```

This check should always pass immediately after `launchDAOShipAndVault()` returns. If it fails, the launching transaction itself failed.

### Vault owner identity requirements

The `vaultOwners` parameter passed to `launchDAOShipAndVault` has no on-chain validation beyond length and threshold checks. Operators are responsible for ensuring:

1. Vault owners are founding DAO members (or a multisig controlled by them)
2. Vault threshold requires `M-of-N` signatures where `M >= 2` for any DAO with meaningful treasury
3. The deployer EOA is NOT the sole vault owner unless they are also the only DAO member

---

## 4. Governance Parameter Floors (H-3)

### Who can change governance parameters

`setGovernanceConfig()` is callable by any address holding GOVERNOR navigator permission (bitmask `4`). This is the **lowest privilege tier** — lower than ADMIN. A GOVERNOR navigator can immediately change:

- `votingPeriod` — minimum `60 seconds` (enforced in contract)
- `gracePeriod` — minimum `0` (no floor enforced)
- `quorumPercent` — minimum `0` (no floor enforced)
- `sponsorThreshold` — minimum `0` (no floor enforced)
- `proposalOffering` — minimum `0`
- `minRetentionPercent` — minimum `0`

There is no time-lock between a GOVERNOR navigator calling `setGovernanceConfig` and the new parameters taking effect. This is consistent with upstream baalZodiac design. The protection is: GOVERNOR navigators can only be granted permission via a governance proposal (`setNavigators` is `governanceOnly`), so a GOVERNOR navigator should itself be a trusted, audited contract.

### Lock behavior

`lockAdmin()`, `lockManager()`, and `lockGovernor()` are `governanceOnly` (require a passed governance proposal). Once called, the corresponding lock prevents `setNavigators` from granting **new** navigator permissions with that bit set. Existing navigators retain their powers — locks do not revoke permissions from already-assigned navigators, and governance proposals can still call the protected functions via `executeAsGovernance`. This matches upstream zodiacBaal behavior where locks prevent new assignments, not function execution.

### Recommended parameter floors for human-facing DAOs

The contract enforces a `MIN_VOTING_PERIOD` of 60 seconds. This is designed for automated agent DAOs. Human-facing DAOs must set higher values:

| Parameter | Agent DAO | Human DAO (Recommended) | Enforced Bounds | Notes |
|-----------|-----------|------------------------|-----------------|-------|
| `votingPeriod` | 60–300s | ≥ 86400s (24h) | MIN: 60s, MAX: 31,536,000s (1 year) | Time for all members to see and vote |
| `gracePeriod` | 60s | ≥ 86400s (24h) | MIN: 0, MAX: 31,536,000s (1 year) | Time to ragequit before execution |
| `quorumPercent` | 100 (1%) | ≥ 2000 (20%) | 0–10000 (basis points) | Minimum participation to pass |
| `sponsorThreshold` | 1 | ≥ 1 share unit | 0–totalSupply (capped at runtime) | Non-zero prevents any address from sponsoring |
| `minRetentionPercent` | 0 | ≥ 5000 (50%) | 0–10000 (basis points) | Ragequit-as-veto protection |
| `proposalOffering` | 0 | > 0 (token-denominated) | No upper bound | Anti-spam cost for non-sponsor proposals |
| `defaultExpiryWindow` | 600s (10m) | ≥ 604800s (7 days) | No bounds | Processing window after grace before auto-expiry |

### Why gracePeriod matters

The grace period is the only window members have to ragequit (exit with proportional assets) before a passed proposal executes. If `gracePeriod = 0`, proposals execute immediately after voting ends. Members have no exit window regardless of what the proposal does. Set `gracePeriod >= votingPeriod` so members always have at least as much time to exit as the vote ran.

### defaultExpiryWindow: preventing zombie proposals

`defaultExpiryWindow` (in seconds) sets how long a passed proposal has to be processed before it auto-expires. It applies only to proposals that have no explicit submitter-set expiration (`expiration = 0` in `submitProposal`).

The lifecycle of an unprocessed passed proposal:
1. Passes voting period (yesBalance > noBalance)
2. Survives grace period (no ragequit veto triggered)
3. Enters **Ready** state — waiting for anyone to call `processProposal`
4. After `graceEnds + defaultExpiryWindow`: auto-expires → `Expired` state
5. Expired is a terminal state — the proposal can no longer be processed

**Why this matters:** A passed proposal in `Ready` state that is never processed (e.g., because the calldata was lost, the executor became unavailable, or the proposal is no longer relevant) remains processable indefinitely without auto-expiry. `defaultExpiryWindow` ensures that zombie proposals — passed proposals with lost or stale data — eventually expire rather than remaining executable forever.

**If `defaultExpiryWindow = 0` (not configured):** the contract falls back to `2 × (votingPeriod + gracePeriod)` using current governance values. This is a reasonable default but it means changing `votingPeriod` also changes the fallback window for all existing unprocessed proposals. Setting an explicit `defaultExpiryWindow` removes this dependency.

**Choosing a value:**
- Too short → legitimate proposals that are slow to process (e.g., multisig executors, offline members) may expire before execution
- Too long → zombie proposals remain processable longer than intended
- For human DAOs with 24h voting+grace: `7 days (604800s)` gives executors a full week after the grace period ends before auto-expiry
- For agent DAOs with 60–300s cycles: `600s (10 minutes)` provides a fast cleanup window

### minRetentionPercent: the ragequit veto mechanism

`minRetentionPercent` (default: `6600` in example configs, 66%) is checked in `processProposal`: if enough members ragequitted during the grace period that current supply falls below `minRetentionPercent` of the **high water mark** (`maxTotalSharesAndLootAtVote`), the proposal is blocked. The high water mark is initialized at sponsor time and updated on every vote to capture any supply growth during voting (e.g., new members joining via an OnboarderNavigator). This means the retention threshold reflects the peak membership during the proposal's voting period, not just the supply at sponsorship.

Setting `minRetentionPercent = 0` disables this mechanism entirely. With it disabled:
- Large holders can vote yes on a self-serving proposal
- Ragequit during grace period (extracting proportional treasury share)
- The proposal still executes after grace period

Keep `minRetentionPercent >= 5000` (50%) for any DAO where members' economic exit rights should serve as a governance check.

### GOVERNOR permission should not be granted to external automation

If you deploy an automated agent that calls `setGovernanceConfig` (e.g., to adjust parameters based on DAO activity), that agent holds GOVERNOR permission. A compromised agent can set `votingPeriod = 60, gracePeriod = 0, quorumPercent = 1, sponsorThreshold = 0` — reducing governance to a 60-second rubber stamp. Only grant GOVERNOR to automation with strictly bounded, audited parameter ranges.

### Proof-of-Work timestamp manipulation and vote snapshots (L-3)

Quai Network is a proof-of-work chain. Miners can shift `block.timestamp` within a bounded window of approximately ±15 seconds. DAOShip snapshots voting power at `votingStarts` (set to `block.timestamp` at sponsorship time). A colluding miner could shift the sponsorship block's timestamp backward by ~15 seconds, causing `votingStarts` to precede the checkpoints of members who received shares in that window — effectively excluding their votes from the proposal.

**The voting period is the primary mitigation.** The attack only affects members whose share checkpoints fall within the ~15-second manipulation window immediately before sponsorship. With `votingPeriod >= 86400` (24h), established members have checkpoints from hours or days prior — completely unaffected. The only exposed members are those who received shares in the ~15 seconds immediately before the sponsorship block, which is a narrow edge case in any real DAO.

For human-facing DAOs, the 24h voting period recommendation above renders this a negligible risk. For agent DAOs operating at 60–300 second voting periods, the ±15 second window is a known and accepted tradeoff of compressed governance cycles.

**Operational note:** Avoid minting shares to new members in the seconds immediately before an anticipated sponsorship event in high-stakes DAOs. Standard operational cadence (mint shares as part of onboarding, not immediately before a vote) eliminates the exposure entirely.

---

## 5. Guild Token Safety and Ragequit Guarantees (H-5)

### What guild tokens are

Guild tokens are the set of assets that members receive their proportional share of when they ragequit. They are managed via `setGuildTokens(address[] tokens, bool[] includeTokens)`, which is a `governanceOnly` function — only callable by DAOShip itself, meaning it requires a passed governance proposal.

The contract enforces `MAX_GUILD_TOKENS = 20`. Guild tokens are a subset of vault holdings — the vault itself can hold unlimited tokens for treasury and governance purposes. Only tokens explicitly registered as guild tokens are available during ragequit. Each guild token in a ragequit incurs a `balanceOf` call + `execTransactionFromModule` call, so the cap prevents out-of-gas failures in a single ragequit transaction. Attempting to exceed the cap (via `setUp` or `setGuildTokens`) reverts with `TooManyGuildTokens()`.

`address(0)` represents the native QUAI balance of the vault. It is **not included by default** — the DAO must explicitly add it via governance if native token ragequit is desired.

### The known limitation: one broken token blocks the entire exit

`ragequit()` iterates over the caller-supplied `tokens` array and attempts to transfer each token's fair share from the vault. If any single token transfer reverts, the **entire ragequit reverts** — including shares/loot burns. There is no skip-and-continue mechanism.

This is the same behavior as upstream baalZodiac, and is documented in the contract source as a known limitation (Gap 6).

**Consequence:** A malicious or dysfunctional token registered as a guild token can permanently prevent members from exiting the DAO with any of their assets.

### Member-controlled workaround

`ragequit()` accepts a caller-supplied `tokens` array. Members are not required to include every guild token. A member who suspects a guild token is malicious can omit it from their ragequit call and still exit with their share of the remaining tokens. Shares and loot are burned proportionally regardless of which tokens are claimed.

This is a meaningful protection — **members can always exit**, just potentially not with their share of every token. The worst case is forfeiting the fair share of one specific token, not being locked in entirely.

### Rules for adding guild tokens

Because a broken guild token affects all members, the bar for adding any new token should be high:

**Only add guild tokens that are:**
- Standard ERC20 implementations (verified source, no custom transfer hooks)
- Non-rebasing (fixed balances, no elastic supply changes)
- Non-pausable by a third party (or if pausable, the pause cannot block `transfer`)
- Not fee-on-transfer (transfer must deliver exactly the requested amount)
- Tokens where the DAO has a meaningful and persistent balance

**Never add guild tokens that are:**
- Tokens controlled by a single party who can block transfers
- Tokens with `transfer` callbacks that could re-enter DAOShip (even if the reentrancy guard limits the impact, the revert-on-transfer DoS remains)
- Tokens that can be drained to zero balance frequently (fair share rounds to 0, no harm, but adds noise)
- Unverified token contracts

### Access control: governanceOnly is stricter than upstream

In upstream baalZodiac, `setGuildTokens` is callable by MANAGER navigators (`governanceOrManagerOnly`). In daoships-contracts, it is `governanceOnly` — only callable by DAOShip itself via a passed governance proposal. This means:

- A compromised MANAGER navigator **cannot** add a malicious guild token unilaterally
- Adding or removing guild tokens always requires a full governance vote with the configured `votingPeriod` and `gracePeriod`

This is a deliberate improvement over upstream. It means members always have at least the grace period to observe an incoming malicious guild token addition and ragequit before it takes effect.

### Native token (QUAI) in guild tokens

`address(0)` represents the vault's native QUAI balance. If you intend for members to ragequit into QUAI:

1. Submit a governance proposal calling `setGuildTokens([address(0)], [true])`
2. After the proposal passes, verify `daoShip.guildTokens(address(0)) == true`
3. When ragequitting, include `address(0)` in the `tokens` array

If `address(0)` is not in guild tokens, QUAI in the vault is not accessible via ragequit. Members can still exit with their share of ERC20 guild tokens.

### Ragequit balance snapshot (audit fix H-1)

`ragequit()` snapshots all guild token balances from the vault BEFORE executing any transfers. Fair share amounts are calculated from these pre-transfer balances. The transfer loop then uses the pre-computed amounts.

This prevents a callback-based attack where the ragequit recipient's `receive()` function deposits tokens into the vault mid-loop, inflating balances for guild tokens processed later in the array. Without the snapshot, a reentrant callback (e.g., via a navigator's `onboard()`) could inflate the vault's balance of a later-processed guild token, causing the ragequitter to withdraw more than their proportional share.

The snapshot also means that ETH sent to the vault during the transfer callback does not inflate fair shares for subsequently processed ERC20 tokens, and vice versa.

### Token singleton bricking (audit fix H-2)

SharesERC20 and LootERC20 singleton implementations call `renounceOwnership()` in their constructors. This makes the singleton permanently inert — no one can call `mint()`, `burn()`, `pause()`, or `unpause()` on the implementation contract directly. EIP-1167 clones have zeroed storage (`owner == address(0)`), so `initialize()` remains callable on clones. This is a defense-in-depth measure that prevents any future misuse of the singleton implementation.

---

## 6. Deployment Checklist

Use this checklist before announcing a DAO as operational. All items are mandatory.

### Pre-deployment

- [ ] All MANAGER navigators are immutable contracts (not EOAs, not upgradeable proxies)
- [ ] Each MANAGER navigator has a `mintCap` or equivalent bound on total issuable tokens
- [ ] `pricePerShare` and `pricePerLoot` in ERC20TributeNavigator verified in tribute token's native decimal units (e.g., 100 USDC = `100e6`, not `100`)
- [ ] `vaultOwners` array contains only founding DAO member addresses (not a deployer bot EOA)
- [ ] `vaultThreshold` set to `M-of-N` with `M >= 2` for any multi-member DAO
- [ ] Governance parameters reviewed against the table in Section 4

### Post-deployment (required before accepting members)

- [ ] `vault.isModuleEnabled(daoShipAddress)` returns `true` (atomic enablement — no manual step needed)
- [ ] Test proposal submitted, voted on, and processed successfully end-to-end
- [ ] Test ragequit executed successfully (confirms module is active and vault accepts transfers)
- [ ] `vault.delegatecallAllowed(multisendCallOnlyAddress)` returns `true` (required for DAOShip proposal execution — see note below)
- [ ] All contracts deployed on the same Quai Network shard (cross-shard deployments cause timestamp inconsistency in all governance timing)

### Ongoing operations

- [ ] Any new MANAGER navigator proposed via governance must be reviewed against the rules in Section 1 before voting yes
- [ ] Governance proposals containing MultiSend calldata with `operation = 1` sub-transactions must be audited before voting
- [ ] GOVERNOR navigator permissions reviewed if any automated agent is granted this role
- [ ] Monitor `vault.isModuleEnabled(daoShipAddress)` — if DAOShip is ever removed as a module, governance is bricked
- [ ] Never set `sponsorThreshold` to a value equal to current `totalSupply()` — a subsequent token burn can cause permanent governance deadlock
- [ ] Any `setGuildTokens` governance proposal must include a source verification of the token contract (standard ERC20, non-rebasing, non-pausable transfer). The contract enforces `MAX_GUILD_TOKENS = 20` — exceeding the cap reverts with `TooManyGuildTokens()`
- [ ] If ragequit begins failing for all members, check whether a recently added guild token is the cause — members can omit that token from their `tokens` array as a workaround while a removal proposal is submitted

### Why the DelegateCall whitelist must include MultiSendCallOnly

`processProposal` unconditionally calls `IAvatar(avatar).execTransactionFromModule(multisendLibrary, 0, proposalData, Enum.Operation.DelegateCall)` on both execution paths. There is no Call-based alternative.

If the MultiSendCallOnly address is not in the vault's `delegatecallAllowed` whitelist, the vault rejects the DelegateCall and `processProposal` sets `actionFailed=true`. The proposal is marked processed but **nothing executes**. This silently breaks all of:

- Every governance proposal with calldata
- `setNavigators` — navigator roster frozen forever
- `setGuildTokens` — ragequit token list frozen forever
- `executeAsGovernance` — no arbitrary execution
- All treasury disbursements via governance

Ragequit, direct navigator calls (MANAGER mint/burn, GOVERNOR setGovernanceConfig), and tribute onboarding continue to work — they do not go through the module DelegateCall path.

`DAOShipAndVaultLauncher` creates vaults with `delegatecallAllowed[multisendCallOnlyAddress] = true` automatically. If creating a vault manually or via a different path, this whitelist entry must be verified before the DAO is announced as operational.

---

## 7. Accepted Audit Findings (Documented, Not Fixed)

The following findings from the SSSES audit v4 are accepted as design decisions. Each is documented here so operators and integrators understand the behavior and its implications.

### M-2: Navigator permission locks allow revocation but not granting

`lockAdmin()`, `lockManager()`, and `lockGovernor()` prevent GRANTING the locked permission to new navigators. However, governance proposals can still REVOKE a locked permission from existing navigators (by setting their permission to 0).

This is intentional. After locking a permission tier, governance retains the ability to remove a compromised navigator. Without this, a malicious navigator with a locked role would be irrevocable — a worse outcome than the current behavior.

**What operators should know:** Locking a role means "no new navigators with this role." It does NOT mean "existing navigators with this role are permanent." A governance proposal can always strip any navigator's permissions, even after the corresponding lock is engaged. Plan role assignment accordingly.

### M-3: Extreme governance parameters can soft-brick the DAO

`_validateGovernanceConfig` enforces minimum and maximum bounds on `votingPeriod`, `gracePeriod`, `quorumPercent`, and `minRetentionPercent`, but allows edge values:

- `quorumPercent = 10000` (100%) — every single share must vote YES
- `minRetentionPercent = 10000` (100%) — no ragequit possible
- `sponsorThreshold` close to `totalSupply` — only a near-100% holder can sponsor

These combinations are technically valid but effectively disable governance. Recovery requires a GOVERNOR navigator calling `setGovernanceConfig` directly.

**Recommended safe ranges:**

| Parameter | Minimum | Maximum | Risk if exceeded |
|-----------|---------|---------|-----------------|
| `quorumPercent` | 0 | 6600 (66%) | > 66% makes passing very difficult |
| `minRetentionPercent` | 0 | 9000 (90%) | > 90% makes ragequit nearly impossible |
| `sponsorThreshold` | 0 | 10% of totalSupply | Higher = fewer members can sponsor |

### L-2 (v5): Proposal ID space exhaustion when `sponsorThreshold=0` and `proposalOffering=0`

`proposalCount` is `uint32`, capping at 4,294,967,295 proposals. With `sponsorThreshold=0`, any address with zero shares can self-sponsor proposals. With `proposalOffering=0`, submission is free. Together, an attacker can submit unlimited free proposals to exhaust the ID space.

Once `proposalCount` reaches `type(uint32).max`, `submitProposal` reverts with `ProposalLimitReached()` permanently — no new proposals can ever be created.

**Why this is accepted:** On Quai Network, each proposal submission costs gas (~100-150K gas). Exhausting 4.3 billion IDs would cost trillions of transactions — economically impractical even with very low gas fees. The attack also provides no financial benefit to the attacker.

**What operators should know:** Set at least one of `proposalOffering > 0` or `sponsorThreshold > 0` to prevent zero-cost proposal spam. Both being zero is technically valid but removes all anti-spam protection.

### M-4: Governance config changes retroactively affect in-flight proposals

Governance parameters are read from live storage at evaluation time, not snapshotted at sponsor time. This means changes to `quorumPercent`, `votingPeriod`, `gracePeriod`, `defaultExpiryWindow`, and `minRetentionPercent` retroactively affect all in-flight proposals. This matches upstream MolochV3 (Baal) behavior.

**Affected parameters and their impact on in-flight proposals:**

| Parameter | Where read | Impact |
|-----------|-----------|--------|
| `quorumPercent` | `_didProposalPass()` at processing time | Raising quorum can retroactively defeat a passing proposal; lowering it can pass a failing one |
| `defaultExpiryWindow` | `state()` on every query | Changing the window can make a Ready proposal suddenly expire, or an expired one become processable |
| `votingPeriod` / `gracePeriod` | `state()` auto-expiry fallback (`2 * (votingPeriod + gracePeriod)`) | Same auto-expiry impact as `defaultExpiryWindow` |
| `minRetentionPercent` | `processProposal()` retention check | Raising retention can defeat a proposal that would have survived the old threshold |

**Why this is accepted:** This is the GOVERNOR trust model — GOVERNOR navigators (and governance proposals that change config) are explicitly trusted to manage parameters. Snapshotting each parameter at sponsor time would deviate from MolochV3 and add significant storage overhead (multiple new fields per Proposal struct). The scenario requires a GOVERNOR config change during an active vote, which is an explicit trust delegation.

**What operators should know:** If a governance proposal changes `quorumPercent` or `minRetentionPercent`, all currently in-flight proposals may see different pass/fail outcomes than members expected when they voted. For DAOs that change parameters frequently, use explicit `expiration` timestamps on proposals to avoid the auto-expiry variant of this issue.

### V7-1: Retention high water mark not updated during grace period — MANAGER mint dilutes ragequit-as-veto

The `maxTotalSharesAndLootAtVote` high water mark is only updated during voting (in `_submitVote`). During the grace period — the exact window when members exercise ragequit-as-veto — the high water mark is frozen. A MANAGER navigator minting shares during grace inflates the current total supply without proportionally raising the retention threshold, weakening the veto.

**Example:** Voting peak supply is 1000. `minRetentionPercent = 9000` (90%). Retention threshold = 900. During grace, a MANAGER mints 200 shares to allies. 250 members ragequit. Supply drops to 950. At processing: `950 >= 900` — proposal passes. Without the grace-period mint, supply would be 750, and `750 < 900` — proposal defeated by veto.

**Why this is accepted:** This matches upstream MolochV3 (Baal) behavior exactly. Both codebases update the high water mark only during voting. The MANAGER is a trusted role — the entire navigator permission model assumes MANAGER navigators act in the DAO's interest. The retention mechanism protects against organic member dissatisfaction (mass ragequit), not against MANAGER collusion. A compromised MANAGER can already mint unlimited supply, making this the lesser concern.

**What operators should know:** The ragequit-as-veto mechanism is effective against governance disputes where members disagree with a proposal. It is NOT effective against a compromised MANAGER who can mint shares during the grace period. If MANAGER trust is a concern, lock the MANAGER role after initial navigator setup and rely solely on governance proposals for minting.

### H-2 (v5): Ragequit callback into MANAGER functions — accepted, not exploitable

During ragequit's transfer loop, a callback from the `to` address can invoke `mintShares`, `mintLoot`, `burnShares`, `burnLoot`, or `convertSharesToLoot` via a MANAGER navigator. These functions intentionally do NOT have `nonReentrant` because they must be callable from governance proposals via `executeAsGovernance` (which runs inside `processProposal`, which holds the reentrancy lock).

This is accepted because:
- Ragequit fair shares are pre-computed from balance snapshots — callbacks cannot change withdrawal amounts
- New minting via callbacks requires paying full tribute price through a navigator
- The result is economically equivalent to ragequitting then re-onboarding in separate transactions
- `totalShares`/`totalLoot` cache remains arithmetically correct (burns decrement, reentrant mints increment)

### M-2 (v5): Delegation fluctuation can enable grief cancellation of proposals

The `cancelProposal` H-4 fix allows anyone to cancel a sponsored proposal if the sponsor's current voting power drops below the effective sponsor threshold. This uses live `getPriorVotes(sponsor, block.timestamp - 1)`, not a snapshot from sponsor time.

This means routine delegation activity during a voting period can inadvertently make proposals cancellable. If Alice sponsors a proposal with exactly `sponsorThreshold` delegated votes, and a delegator independently redelegates 1 share away during the voting period, anyone can cancel the proposal.

**Why this is accepted:** The H-4 fix serves a critical purpose — it prevents a sponsor whose delegation was deliberately withdrawn from keeping an illegitimate proposal alive. Snapshotting the sponsor's votes at sponsor time would re-introduce the original vulnerability (a delegator revokes delegation but the proposal remains alive with phantom voting power).

**Practical mitigation:** The sponsor threshold is typically low relative to total supply (e.g., 1-100 shares). A sponsor falling below threshold requires losing nearly ALL their delegated voting power, which is a significant event, not routine churn. For DAOs with active delegation markets, setting `sponsorThreshold` well below the typical delegate's balance provides a safety margin.

**What operators should know:** Proposals are safest when the sponsor holds shares directly (not delegated) or holds significantly more than `sponsorThreshold`. If a sponsor relies on delegated votes near the threshold boundary, the proposal is vulnerable to cancellation via delegation withdrawal — whether malicious or accidental.

### M-6: Navigator deployment has no on-chain MANAGER permission check

Navigator constructors cannot verify they will have MANAGER permission on the target DAOShip. This is a chicken-and-egg problem: the navigator's address is unknown until after deployment, and `setNavigators` requires the address.

A navigator deployed without being registered will permanently fail on all `onboard()` calls since config is immutable.

**Deployment order:** (1) Deploy navigator, (2) Submit governance proposal calling `setNavigators([navigatorAddr], [2])`, (3) Process proposal. The navigator is non-functional between steps 1 and 3. Frontends should verify `daoShip.navigators(navigatorAddr) & 2 != 0` before displaying a navigator as active.

### M-8: SharesERC20 and LootERC20 are governance tokens, not DeFi-compatible

These tokens deviate from standard ERC-20 behavior in ways that may break DeFi integrations:

1. **Pause blocks transfers but not mint/burn** — AMM pools freeze (no swaps), but the DAO can still mint and ragequit can still burn. A paused token in a Uniswap pool would trap liquidity.
2. **Auto-delegation on first receipt** — any contract receiving tokens for the first time (vaults, lending pools, DEX routers) gets self-delegated, accumulating voting power in contracts that cannot exercise it.
3. **MINT_CAP on shares is `type(uint216).max`** — lower than the standard `type(uint256).max`, which could confuse protocols that assume uint256 range.

These are deliberate design choices for governance tokens. If DeFi integration is desired, use a wrapper ERC-20 that proxies transfers without the governance-specific behavior.

---

*This guide covers findings from the daoships-contracts SSSES audits v1-v8. v5: C-1 (OnboarderNavigator receive() nonReentrant) fixed, M-1 (OOG grief protection) fixed. v6: state() expired unsponsored fix, defeated proposals require empty data, withdrawStuckTokens nonReentrant. v7: L-items (memory caching, struct packing, statusFlags bitfield, dead code removal, BaseNavigator/DAOShipPermit extraction, bounds checks). v8: delegate(address(0)) blocked (InvalidDelegatee), bitwise parentheses. Accepted: quorum snapshot (MolochV3), lock revocation (governance supreme), ragequit callback (non-exploitable), delegation grief (H-4 tradeoff), retention high water mark (MolochV3).*
