# DAO Ships DAO Configuration Guide

Reference configurations for deploying DAO Ships DAOs at different scales and organizational structures. Each configuration specifies governance parameters, navigator setup, vault configuration, and the navigators needed (existing or to-be-built) to operate effectively.

### Operator Notes

- **`quorumPercent = 0`** is a valid configuration. It means any proposal with at least 1 yes vote (and a simple majority) will pass. This is appropriate for high-trust micro-DAOs or agent-operated DAOs where speed matters more than broad consensus. For DAOs managing significant treasuries, set quorum to at least 10-20% to prevent single-actor governance.
- **`pauseSharesOnLaunch` / `pauseLootOnLaunch`** can be set to `true` during DAO creation to block token transfers until all founding members are onboarded. Minting still works while paused. Unpause via a governance proposal calling `setAdminConfig(false, false)`.
- **Batch mint/burn limits:** When crafting governance proposals that call `mintShares`, `mintLoot`, `burnShares`, or `burnLoot`, limit each call to **200 recipients** or fewer. Each recipient costs ~55-60K gas (token mint + checkpoint write + storage update). Exceeding block gas limits will cause the proposal to revert on processing. For larger distributions, split across multiple proposals.
- **MultiSend batch limits:** Governance proposals use MultiSend to batch multiple actions into one transaction. Keep batches to **50 actions or fewer**. Most proposals need 1-5 actions (e.g., transfer QUAI + update config). The `DAOShipUtils.encodeMultisend` on-chain helper and the off-chain `encodeProposalData` TypeScript utility both support arbitrary batch sizes, but gas limits are the practical constraint.
- **Guild token limits:** The contract enforces `MAX_GUILD_TOKENS = 20`. Guild tokens are only the subset of vault holdings available during ragequit — the vault itself can hold unlimited tokens for treasury and governance purposes. Each guild token in a ragequit costs a `balanceOf` + `execTransactionFromModule` call, so the cap prevents out-of-gas failures. Removing guild tokens scans the list linearly (~2,100 gas per token). Duplicate addresses passed during DAO creation are automatically deduplicated. Exceeding the cap reverts with `TooManyGuildTokens()`.
- **Ragequit recipients:** When calling `ragequit`, use an EOA (externally owned account) as the `to` address. If `to` is a contract, its `receive()` function executes during the withdrawal loop. The `nonReentrant` guard prevents re-entering ragequit, and burns complete before any transfers, so the fair share calculation is safe. However, a contract recipient with MANAGER permissions could theoretically call `mintShares` during the callback — an implausible but avoidable setup.
- **Proposal processing is final.** Once `processProposal` is called, the proposal is consumed — even if the action fails due to insufficient gas or a revert. The proposal is marked `passed=true, actionFailed=true` and cannot be retried. The DAO must submit and vote on a new proposal. To avoid griefing, ensure a trusted member or keeper processes important proposals with sufficient gas. Anyone can call `processProposal` — it is permissionless.
- **`defaultExpiryWindow`:** If set to `0`, passing proposals auto-expire after `2 * (votingPeriod + gracePeriod)`. With very short periods (e.g., 60s voting + 0s grace), this creates a 120-second window to process passing proposals before they expire. Set an explicit `defaultExpiryWindow` to avoid surprises.
- **Navigator locks are one-way.** `lockAdmin()`, `lockManager()`, and `lockGovernor()` are **irreversible**. Once locked, no new navigators can be granted that role. However, existing navigators with a locked role *can* still be revoked via governance — this is intentional so compromised navigators can always be removed. Even if all navigators with a locked role are revoked, governance proposals can still call those functions via `executeAsGovernance`. Lock carefully — there is no unlock.

---

## 1. Startup Team (3-10 Members)

**Profile:** Founding team managing a shared treasury. High trust, fast decisions, all members are active daily. Treasury under $100K.

**Examples:** Dev shop, investment club, hackathon team, grant-funded project.

### Governance Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `votingPeriod` | 86400 (1 day) | Small group, fast coordination |
| `gracePeriod` | 86400 (1 day) | Enough time to ragequit but doesn't slow operations |
| `quorumPercent` | 5000 (50%) | High bar — majority of a small group should participate |
| `sponsorThreshold` | 1e18 (1 share) | Any member can sponsor |
| `minRetentionPercent` | 6600 (66%) | Standard protection — 34% exit blocks proposals |
| `proposalOffering` | 0 | No spam risk in a small trusted group |
| `defaultExpiryWindow` | 259200 (3 days) | Clear stuck proposals quickly |

### Token Distribution
- Equal shares to all founding members (e.g., 100 shares each)
- No loot at launch
- Shares paused initially (transfers disabled until governance decides otherwise)

### Vault Configuration
- Vault owners = all founding members
- Vault threshold = ceil(N/2) (e.g., 3-of-5, 2-of-3)
- `delegatecallAllowed[multisendCallOnly] = true` (set automatically by DAOShipAndVaultLauncher)
- `minExecutionDelay = 0`

### Navigators Needed
- **OnboarderNavigator** (multiplier mode, allowlist enabled) — Gate new member admission via Merkle allowlist. Set `mintCap` to limit dilution (e.g., 2x founding supply). Set `perAddressCap` equal to founding member share amount.
- No other navigators needed at this scale — all operations go through governance proposals.

### Operational Notes
- Proposals execute in parallel — no sequential queue bottleneck. Multiple proposals can be in flight simultaneously.
- Cycle time per proposal: ~2 days (1-day vote + 1-day grace)
- All members self-sponsor (no offering friction)
- Batching optional but useful for monthly contributor payments
- No delegation needed — everyone votes directly

---

## 2. Community DAO (20-50 Members)

**Profile:** Open community with shared mission. Mix of active contributors and passive holders. Some members joined via tribute, others via grants. Treasury $100K-$1M.

**Examples:** Service DAO (consulting/dev), media DAO, local community fund, protocol guild.

### Governance Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `votingPeriod` | 259200 (3 days) | Long enough for async participation across time zones |
| `gracePeriod` | 172800 (2 days) | Meaningful exit window |
| `quorumPercent` | 2000 (20%) | Realistic for 30% participation rate |
| `sponsorThreshold` | 10e18 (10 shares) | Prevents drive-by sponsorship from minimal holders |
| `minRetentionPercent` | 6600 (66%) | Standard protection |
| `proposalOffering` | 0.01 QUAI | Low anti-spam barrier for non-member proposals |
| `defaultExpiryWindow` | 604800 (7 days) | Week-long processing window |

### Token Distribution
- Founding members: equal shares (e.g., 100 shares each)
- New members join via OnboarderNavigator with defined tribute rate
- Loot used for non-voting economic participants (advisors, early contributors)

### Vault Configuration
- Vault owners = 3-5 most trusted founding members
- Vault threshold = 3-of-5 (or 2-of-3 minimum)
- `delegatecallAllowed[multisendCallOnly] = true` (set automatically by DAOShipAndVaultLauncher)

### Navigators Needed

**Existing (ship with v1):**
- **OnboarderNavigator** (multiplier mode, open or allowlisted) — Primary onboarding. Set `mintCap` to 2-5x founding supply to bound dilution. Set `perAddressCap` to prevent whale capture (e.g., 5% of target total supply per address). Set `expiry` for time-bounded membership rounds.
- **ERC20TributeNavigator** — If the DAO accepts stablecoin tribute alongside native QUAI. Same cap discipline.

**Future (build for v1.1):**
- **BudgetNavigator** (MANAGER) — Pre-approved quarterly budgets for contributor payments. Governance votes a budget; navigator disburses within it. Eliminates 60-70% of proposal volume.
- **SignalNavigator** — Non-executing polls for temperature checks and sentiment gathering.

### Operational Notes
- Proposals execute in parallel — multiple proposals can be in flight simultaneously
- Cycle time per proposal: ~5 days (3-day vote + 2-day grace)
- Batch routine operations (monthly payments, parameter tweaks) into single proposals for efficiency
- Encourage delegation to 3-5 active council members to reliably hit quorum
- Guild tokens: register QUAI (`address(0)`) and any ERC20s the treasury holds

---

## 3. Protocol DAO (50-200 Members)

**Profile:** Governs a protocol or platform. Token holders are stakeholders — some are builders, some are users, some are investors. Treasury $1M-$10M. Decisions are consequential and require deliberation.

**Examples:** DeFi protocol governance, NFT platform DAO, infrastructure protocol, ecosystem fund.

### Governance Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `votingPeriod` | 432000 (5 days) | Sufficient time for community review of complex proposals |
| `gracePeriod` | 432000 (5 days) | Equal to voting — members always have as much time to exit as the vote ran |
| `quorumPercent` | 1000 (10%) | Realistic for 20% active participation at this scale |
| `sponsorThreshold` | 100e18 (100 shares) | ~0.1% of target supply — meaningful skin in the game |
| `minRetentionPercent` | 5000 (50%) | Lower than smaller DAOs — harder to coordinate 50% ragequit at scale |
| `proposalOffering` | 0.1 QUAI | Meaningful anti-spam for non-sponsored proposals |
| `defaultExpiryWindow` | 604800 (7 days) | Standard processing window |

### Token Distribution
- Founding team: 20-30% of initial supply (vested when VestingNavigator exists)
- Community allocation: 40-50% distributed via onboarding navigators over 12-24 months
- Treasury reserve: 20-30% held by the vault (not minted, available via governance)
- Loot for advisory roles, grants recipients, inactive founders who converted shares

### Vault Configuration
- Vault owners = 5-7 council members (security council role)
- Vault threshold = 4-of-7
- `delegatecallAllowed[multisendCallOnly] = true` (set automatically by DAOShipAndVaultLauncher)
- Council members are founding team + elected community representatives

### Navigators Needed

**Existing (ship with v1):**
- **OnboarderNavigator** (fixed-price mode) — Structured membership rounds with defined pricing. Use `expiry` for round deadlines. Use allowlist for curated rounds, open for public rounds. `perAddressCap` set to 1-2% of total supply.
- **ERC20TributeNavigator** — For stablecoin-denominated membership (investors, grant-funded members).

**Future (critical for this scale):**
- **TimelockNavigator** (GOVERNOR) — 48-hour delay on governance parameter changes (the recommended value; the contract floor `MIN_DELAY` is only 10 min, which is too short to be a real exit window — use ≥ 2 days). Wraps `setGovernanceConfig` behind a timelock so members can exit before radical parameter changes take effect.
- **BudgetNavigator** (MANAGER) — Quarterly contributor budgets. Reduces per-cycle proposal overhead for routine payroll operations.
- **SignalNavigator** — Non-binding governance polls. Critical at this scale for temperature checks before committing to full proposals.
- **VestingNavigator** (MANAGER) — Time-locked share distribution for core team and long-term contributors. Cliff + linear vest. Burns unvested shares on departure.
- **DelegateRegistryNavigator** — On-chain delegation metadata (delegate statements, categories). Reads DAOShipVotes delegation state and provides queryable registry for UIs.

### Operational Notes
- Proposals execute in parallel — no throughput bottleneck from sequential processing
- Cycle time per proposal: ~10 days (5-day vote + 5-day grace)
- Batching still recommended for routine operations to reduce voter fatigue
- Delegation is critical — designate 10-15 active delegates to reliably hit 10% quorum
- Consider dual-track governance: BudgetNavigator for operations, DAOShip proposals for policy
- Security council (vault owners) can emergency-pause via direct vault multisig

---

## 4. Investment / Treasury DAO (10-100 Members)

**Profile:** Manages a pooled investment fund. Members contribute capital, governance allocates it. Economic exit rights (ragequit) are the primary value proposition. Treasury $500K-$50M. Security is paramount.

**Examples:** Investment club, venture DAO, treasury management DAO, real-world asset fund.

### Governance Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `votingPeriod` | 604800 (7 days) | Maximum deliberation for financial decisions |
| `gracePeriod` | 604800 (7 days) | Full week to ragequit — equal to voting period |
| `quorumPercent` | 3000 (30%) | Higher bar for fund allocation decisions |
| `sponsorThreshold` | 1000e18 (1000 shares) | Only meaningful stakeholders can drive proposals |
| `minRetentionPercent` | 7500 (75%) | Strong minority protection — 25%+ exit blocks any proposal |
| `proposalOffering` | 1 QUAI | Significant anti-spam for non-members |
| `defaultExpiryWindow` | 1209600 (14 days) | Long processing window for proposals requiring off-chain coordination |

### Token Distribution
- Shares proportional to capital contribution (1 share = 1 QUAI contributed, or similar)
- No free shares — every share backed by tribute
- Loot for advisors/service providers who earn economic rights without voting
- Consider shares paused (non-transferable) to prevent secondary market governance manipulation

### Vault Configuration
- Vault owners = 3-5 founding investors
- Vault threshold = 3-of-5 (strict majority)
- `delegatecallAllowed[multisendCallOnly] = true` (set automatically by DAOShipAndVaultLauncher)
- **Consider multiple vaults** — operational vault (small, for gas/expenses) + treasury vault (large, for investments). Only the treasury vault is the DAOShip avatar.

### Navigators Needed

**Existing (ship with v1):**
- **OnboarderNavigator** (fixed-price mode) — Capital calls with defined pricing. `pricePerUnit` = 1:1 QUAI-to-share. Allowlist for accredited/approved investors. `mintCap` per round. `perAddressCap` for concentration limits. `expiry` for round deadlines.
- **ERC20TributeNavigator** — For stablecoin-denominated capital contributions.

**Future (critical for investment DAOs):**
- **TimelockNavigator** (GOVERNOR) — 7-day delay on parameter changes. Non-negotiable for a fund managing significant capital.
- **RageKick** (MultiSend pattern) — Forced fair exit for members who violate fund terms. See "Future Navigator Details" section below.
- **SubscriptionNavigator** (MANAGER) — Recurring management fee deduction. Burns shares proportional to a periodic fee (e.g., 2% annual). Common in investment fund structures.

### Operational Notes
- Proposals execute in parallel, but cycle time per proposal is ~14 days (7-day vote + 7-day grace)
- **This is intentionally slow** — investment decisions should not be rushed
- Every proposal is a capital allocation decision — batch sparingly, one investment per proposal
- Ragequit is the primary member protection — the 75% retention threshold means any investment the DAO makes must have >75% support or members will exit and block it
- Guild tokens must include every asset the fund holds — members ragequit into proportional slices of the entire portfolio. The `MAX_GUILD_TOKENS = 20` cap means investment DAOs should consolidate into fewer token positions or accept that only the top 20 assets are ragequit-eligible
- **Shares should be paused** (non-transferable) to prevent governance-by-acquisition

---

## 5. Agent / Automated DAO (2-50 Agents + Human Oversight)

**Profile:** AI agents or automated systems managing shared resources with human oversight. Decisions are frequent, fast, and programmatic. Humans intervene only for policy changes and emergencies. Treasury $10K-$1M.

**Examples:** AI agent collective, automated market maker governance, bot-managed treasury, automated grant distribution.

### Governance Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `votingPeriod` | 300 (5 minutes) | Agents vote programmatically — no human wait time |
| `gracePeriod` | 60 (1 minute) | Minimal grace — agents don't need time to "think about ragequitting" |
| `quorumPercent` | 5000 (50%) | High quorum — agents should all participate |
| `sponsorThreshold` | 1e18 (1 share) | Any agent can sponsor |
| `minRetentionPercent` | 0 | No ragequit veto — agents don't ragequit |
| `proposalOffering` | 0 | No spam risk with authenticated agents |
| `defaultExpiryWindow` | 600 (10 minutes) | Fast queue clearing |

### Token Distribution
- Equal shares to each authorized agent
- Human oversight committee holds loot (economic claim, no voting — or separate shares with manual delegation)
- Agent shares are non-transferable (paused) to prevent agent key compromise from enabling share sales

### Vault Configuration
- Vault owners = human oversight committee (2-3 humans)
- Vault threshold = 2-of-3
- `delegatecallAllowed[multisendCallOnly] = true` (set automatically by DAOShipAndVaultLauncher)
- Humans retain the nuclear option: `disableModule(daoShip)` to halt all agent governance

### Navigators Needed

**Existing (ship with v1):**
- **OnboarderNavigator** (fixed-price mode, allowlisted) — Agent onboarding gated by Merkle allowlist. Only pre-approved agent addresses can join. `perAddressCap = 1 share` (one agent, one vote).

**Future (critical for agent DAOs):**
- **BudgetNavigator** (MANAGER) — Agents execute within pre-approved budgets without proposals. The primary operational pattern: governance sets the budget, agents operate within it.
- **OracleNavigator** (GOVERNOR) — Adjusts governance parameters based on on-chain conditions (e.g., increase quorum if treasury exceeds threshold, decrease voting period during off-peak).
- **CircuitBreakerNavigator** (ADMIN) — Auto-pauses tokens if anomalous activity detected (large unexpected mints, rapid ragequits, etc.). Human override to unpause.

### Operational Notes
- Proposals execute in parallel — agents can have many proposals in flight simultaneously
- Cycle time per proposal: ~6 minutes (5min vote + 1min grace)
- Agents submit, vote, and process proposals programmatically
- Human oversight committee monitors via events and can intervene by:
  - Pausing tokens (via ADMIN navigator or vault multisig)
  - Disabling DAOShip as module (vault multisig — nuclear option)
  - Ragequitting on behalf of human loot holders
- **PoW timestamp manipulation (±15s) is relevant at this speed** — 15s uncertainty on a 5-minute vote is 5% of the period. Accept this as a tradeoff of compressed governance cycles.
- Consider `sponsorThreshold = 0` for fully automated operation (any address can propose)

---

## Configuration Comparison Matrix

| Parameter | Startup | Community | Protocol | Investment | Agent |
|-----------|---------|-----------|----------|------------|-------|
| Members | 3-10 | 20-50 | 50-200 | 10-100 | 2-50 |
| Treasury | <$100K | $100K-$1M | $1M-$10M | $500K-$50M | $10K-$1M |
| votingPeriod | 1 day | 3 days | 5 days | 7 days | 5 min |
| gracePeriod | 1 day | 2 days | 5 days | 7 days | 1 min |
| quorumPercent | 50% | 20% | 10% | 30% | 50% |
| sponsorThreshold | 1 share | 10 shares | 100 shares | 1000 shares | 1 share |
| minRetention | 66% | 66% | 50% | 75% | 0% |
| proposalOffering | 0 | 0.01 | 0.1 | 1.0 | 0 |
| expiryWindow | 3 days | 7 days | 7 days | 14 days | 10 min |
| Execution model | Parallel | Parallel | Parallel | Parallel | Parallel |
| Shares paused | Yes | No | No | Yes | Yes |
| Delegation needed | No | Helpful | Critical | No | No |
| Key navigator | Onboarder | Budget | Timelock + Budget | Timelock | Budget + CircuitBreaker |

---

## Navigator Ecosystem Roadmap

See [docs/NAVIGATORS.md](docs/NAVIGATORS.md) for the full navigator ecosystem roadmap and implementation plans.

---

*This guide assumes the DAO Ships core (DAOShip + DAOShipLauncher + DAOShipAndVaultLauncher + SharesERC20 + LootERC20) is deployed.*
