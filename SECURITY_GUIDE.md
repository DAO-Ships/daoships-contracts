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

**Examples of unacceptable MANAGER navigators:**
- An EOA with MANAGER permission set during deployment
- A proxy contract where the deployer controls the implementation

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

| Parameter | Agent DAO | Human DAO (Recommended) | Notes |
|-----------|-----------|------------------------|-------|
| `votingPeriod` | 60–300s | ≥ 86400s (24h) | Time for all members to see and vote |
| `gracePeriod` | 60s | ≥ 86400s (24h) | Time to ragequit before execution |
| `quorumPercent` | 100 (1%) | ≥ 2000 (20%) | Minimum participation to pass |
| `sponsorThreshold` | 1 | ≥ 1 share unit | Non-zero prevents any address from sponsoring |
| `minRetentionPercent` | 0 | ≥ 5000 (50%) | Ragequit-as-veto protection |
| `proposalOffering` | 0 | > 0 (token-denominated) | Anti-spam cost for non-sponsor proposals |
| `defaultExpiryWindow` | 600s (10m) | ≥ 604800s (7 days) | Processing window after grace before auto-expiry |

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
- [ ] Any `setGuildTokens` governance proposal must include a source verification of the token contract (standard ERC20, non-rebasing, non-pausable transfer)
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

*This guide covers findings from the daoships-contracts security audit dated 2026-03-18. Updated 2026-03-19 to reflect QuaiVault v2 integration: H-2 (atomic module enablement) and C-2 (MultiSendCallOnly + DelegateCall whitelist) are now fully fixed.*
