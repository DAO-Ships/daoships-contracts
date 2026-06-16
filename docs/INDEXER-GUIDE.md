# DAO Ships Indexer Developer Guide

Complete reference for building or refactoring the DAO Ships indexer. Covers every event emitted by the contract system, database schema requirements, handler specifications, and the contract discovery pattern.

**Contracts version:** Post-v3 audit (2026-03-22)
**Breaking changes from upstream Baal/Summoner indexer:**
- All "Baal" concepts renamed to "DAOShip"
- All "Shaman" concepts renamed to "Navigator"
- All "Summoner" concepts renamed to "Launcher"
- `trustedForwarder` removed (no EIP-2771)
- `proposalGas` removed from proposals
- `initializationActions` removed from launchers
- `SubmitProposal` event now includes `submitter` (indexed)
- `Ragequit` event now includes per-token `amounts[]`
- Navigator `Onboard` events now include `daoShipAddress` (indexed)
- `LaunchDAOShip` event no longer includes `forwarder`

---

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Quai Network   │     │  DAO Ships       │     │  Poster         │
│  (RPC/WS)       │     │  Indexer         │     │  (EIP-3722)     │
│                 │     │                  │     │                 │
│  DAOShipLauncher├────►│  Block Processor │◄────┤  NewPost events │
│  DAOShip clones ├────►│  Event Handlers  │     └─────────────────┘
│  Token clones   ├────►│  Contract Reg.   │
│  Navigators     ├────►│  Database Writer │
└─────────────────┘     └────────┬─────────┘
                                 │
                        ┌────────▼─────────┐
                        │  Database        │
                        │  (Supabase/PG)   │
                        └──────────────────┘
```

### Contract Discovery Flow

1. **Static contracts** — Configured at startup: `DAOShipLauncher`, `DAOShipAndVaultLauncher`, `Poster`
2. **DAO discovery** — `LaunchDAOShip` / `LaunchDAOShipAndVault` events register new DAOShip + token addresses
3. **Navigator discovery** — `NavigatorSet` events on each DAOShip register navigator addresses
4. **Multi-pass processing** — Within each block range, process launcher events first (to discover DAOs), then fetch logs for newly discovered addresses in a second pass

---

## Complete Event Reference

### 1. Launcher Events

These are emitted by the factory contracts. They are the entry point for discovering new DAOs.

#### `LaunchDAOShip` (DAOShipLauncher)

```solidity
event LaunchDAOShip(
    address indexed daoShip,
    address indexed shares,
    address indexed loot,
    address avatar,
    address launcher
);
```

**Topic0:** `keccak256("LaunchDAOShip(address,address,address,address,address)")`

**Handler action:**
- Create DAO record with `daoShip`, `shares`, `loot`, `avatar` addresses
- Register `daoShip` address for governance event monitoring
- Register `shares` and `loot` addresses for token event monitoring
- `avatar` is the Quai Vault (treasury) address

**Important: `launcher` field semantics.**
When called directly by a deployer wallet, `launcher` is the deployer. When called by `DAOShipAndVaultLauncher`, `launcher` is the vault launcher **contract** address (not the deployer wallet). For Poster trust verification (`daoships.dao.profile.initial`), prefer the `launcher` from `LaunchDAOShipAndVault` (which always has the real deployer wallet). Store both if both events fire — see below.

#### `LaunchDAOShipAndVault` (DAOShipAndVaultLauncher)

```solidity
event LaunchDAOShipAndVault(
    address indexed daoShip,
    address indexed vault,
    address shares,
    address loot,
    bool newVault,
    address launcher
);
```

**Topic0:** `keccak256("LaunchDAOShipAndVault(address,address,address,address,bool,address)")`

**Handler action:**
- Update the DAO record created by `LaunchDAOShip` (both events fire in the same tx)
- Set `vault` as the avatar address
- `newVault = true` means the vault was created atomically; `false` means an existing vault was used
- **Store `launcher` as `deployer`** — this is always the real deployer wallet (the EOA that called `DAOShipAndVaultLauncher`)
- Use this `deployer` address (not the `LaunchDAOShip.launcher`) for Poster `daoships.dao.profile.initial` trust verification

**Processing order:** Both events fire in the same transaction. Process `LaunchDAOShip` first (creates the DAO record), then `LaunchDAOShipAndVault` (updates it with vault info and the real deployer address).

---

### 2. DAOShip Governance Events

All emitted by individual DAOShip clone contracts.

#### `SetupComplete`

```solidity
event SetupComplete(
    bool lootPaused,
    bool sharesPaused,
    uint32 votingPeriod,
    uint32 gracePeriod,
    uint256 proposalOffering,
    uint256 quorumPercent,
    uint256 sponsorThreshold,
    uint256 minRetentionPercent,
    uint32 defaultExpiryWindow,
    string name,
    string symbol,
    string lootName,
    string lootSymbol,
    address[] guildTokens,
    uint256 totalShares,
    uint256 totalLoot
);
```

**Handler action:**
- Update DAO record with all governance parameters
- Write `default_expiry_window` from the event (0 = DAO uses 2*(voting+grace) fallback at runtime)
- Store shares token name/symbol (`name`, `symbol`) and loot token name/symbol (`lootName`, `lootSymbol`) from the event
- Register initial guild tokens
- Store initial `totalShares` and `totalLoot`
- Store initial pause state

#### `SubmitProposal`

```solidity
event SubmitProposal(
    uint256 indexed proposal,
    bytes32 indexed proposalDataHash,
    address indexed submitter,
    uint256 votingPeriod,
    bytes proposalData,
    uint256 expiration,
    bool selfSponsor,
    uint256 timestamp,
    string details,
    uint256 proposalOffering
);
```

**Handler action:**
- Create proposal record with ID, hash, submitter, details, expiration
- If `selfSponsor = true`, the proposal is already sponsored (voting has started)
- `proposalData` contains the encoded MultiSend actions — can be decoded for display
- `details` is typically a JSON string or IPFS CID with proposal metadata
- `votingPeriod` is the DAO's current setting at submission time (useful for computing deadlines)
- `timestamp` is `block.timestamp` at submission
- `proposalOffering` is the `msg.value` sent with the proposal submission (required tribute to submit)

**Note:** `submitter` is now an indexed field. The old indexer extracted this from `tx.from` which was fragile.

**Note on `proposalDataHash`:** The hash is `keccak256(abi.encode(proposalData))`, NOT `keccak256(proposalData)`. The `abi.encode` wrapper adds a 32-byte offset and 32-byte length prefix before the raw bytes. Off-chain tools verifying proposal hashes must use the same double-encoding: `keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], [proposalData]))`.

#### `SponsorProposal`

```solidity
event SponsorProposal(
    address indexed member,
    uint256 indexed proposal,
    uint256 votingStarts,
    uint256 votingEnds,
    uint256 graceEnds,
    uint256 maxTotalSharesAtSponsor,
    uint256 maxTotalSharesAndLootAtVote
);
```

**Handler action:**
- Update proposal record: set sponsor, votingStarts, votingEnds, graceEnds
- `votingEnds` and `graceEnds` are now provided directly in the event -- no need to compute them from governance parameters or make RPC calls
- Store `maxTotalSharesAtSponsor` -- total shares snapshot used for quorum calculation
- Store `maxTotalSharesAndLootAtVote` -- initial high water mark for retention check (updated by `SubmitVote` if supply grows during voting)
- Note: for self-sponsored proposals, this event is emitted in the same tx as `SubmitProposal`
- **No RPC calls needed** -- all timing deadlines and supply snapshots are provided directly in the event

#### `SubmitVote`

```solidity
event SubmitVote(
    address indexed member,
    uint256 balance,
    uint256 indexed proposal,
    bool indexed approved
);
```

**Handler action:**
- Create vote record with voter, proposal ID, yes/no, voting power (balance)
- Update proposal aggregates: increment yesVotes/noVotes count, add balance to yesBalance/noBalance
- `balance` is the voter's share-weighted voting power at the proposal's `votingStarts` snapshot

#### `ProcessProposal`

```solidity
event ProcessProposal(
    uint256 indexed proposal,
    bool passed,
    bool actionFailed,
    address indexed processor
);
```

**Handler action:**
- Update proposal status: `processed = true`
- Store `processor` -- the address that called `processProposal` (indexed, available as topic)
- If `passed = true` and `actionFailed = false`: proposal executed successfully
- If `passed = true` and `actionFailed = true`: proposal passed vote but execution reverted (non-retryable)
- If `passed = false`: proposal was defeated (quorum not met, majority not reached, or retention check failed)

#### `CancelProposal`

```solidity
event CancelProposal(uint256 indexed proposal, address indexed canceller);
```

**Handler action:**
- Update proposal status: `cancelled = true`
- Store `canceller` -- the address that cancelled the proposal (indexed, available as topic). This may be the submitter, a governor-level navigator, or the DAO itself

#### `Ragequit`

```solidity
event Ragequit(
    address indexed member,
    address indexed to,
    uint256 lootToBurn,
    uint256 sharesToBurn,
    address[] tokens,
    uint256[] amounts
);
```

**Handler action:**
- Create ragequit record with member, recipient, shares/loot burned
- Store per-token withdrawal amounts (`tokens[i]` → `amounts[i]`)
- Update member balances (subtract shares and loot)
- `tokens` and `amounts` are parallel arrays — `amounts[i]` is the fair share withdrawn for `tokens[i]`
- `to` may differ from `member` (ragequit can send assets to a different address)
- `address(0)` in tokens means native QUAI

**Note:** `amounts[]` is new. The old indexer had to recompute proportional shares.

#### `NavigatorSet`

```solidity
event NavigatorSet(address indexed navigator, uint256 permission);
```

**Handler action:**
- If `permission > 0`: register navigator with bitmask permissions (valid range: 1-7)
  - `permission & 1` = ADMIN (can pause/unpause tokens)
  - `permission & 2` = MANAGER (can mint/burn shares and loot)
  - `permission & 4` = GOVERNOR (can update governance config, cancel proposals)
- If `permission == 0`: navigator revoked — mark as inactive
- Values above 7 are rejected on-chain (`InvalidPermission`), so the indexer will never see them
- Register the navigator address for `Onboard`/`Paused`/`Unpaused` event monitoring

#### `GovernanceConfigSet`

```solidity
event GovernanceConfigSet(
    uint32 votingPeriod,
    uint32 gracePeriod,
    uint256 proposalOffering,
    uint256 quorumPercent,
    uint256 sponsorThreshold,
    uint256 minRetentionPercent,
    uint32 defaultExpiryWindow
);
```

**Handler action:**
- Update DAO governance parameters
- `quorumPercent` and `minRetentionPercent` are in basis points (10000 = 100%)
- `defaultExpiryWindow` of 0 means fallback to `2 * (votingPeriod + gracePeriod)`

#### `SetGuildTokens`

```solidity
event SetGuildTokens(address[] tokens, bool[] enabled);
```

**Handler action:**
- For each token: if `enabled[i] = true`, add to guild tokens; if `false`, remove
- `address(0)` represents native QUAI
- The contract enforces `MAX_GUILD_TOKENS = 20` — if a `setGuildTokens` call would exceed the cap, the proposal action fails (`actionFailed=true`). Guild tokens are only the subset of vault holdings available during ragequit; the vault can hold unlimited tokens

#### `MintShares` / `MintLoot`

```solidity
event MintShares(address[] to, uint256[] amount);
event MintLoot(address[] to, uint256[] amount);
```

**Handler action:**
- For each entry: upsert member record, add `amount[i]` to their shares/loot balance
- Create new member records for addresses not yet seen
- Update DAO `totalShares` / `totalLoot` aggregates

#### `BurnShares` / `BurnLoot`

```solidity
event BurnShares(address[] from, uint256[] amount);
event BurnLoot(address[] from, uint256[] amount);
```

**Handler action:**
- For each entry: subtract `amount[i]` from member's shares/loot balance
- Update DAO `totalShares` / `totalLoot` aggregates
- If member's shares + loot reaches 0, consider marking as inactive (but don't delete — they may rejoin)

#### `ConvertSharesToLoot`

```solidity
event ConvertSharesToLoot(address indexed from, uint256 amount);
```

**Handler action:**
- Subtract `amount` from member's shares, add `amount` to member's loot
- Update DAO `totalShares` (decrease) and `totalLoot` (increase)
- Net member economic position unchanged, but voting power removed

#### `AdminConfigSet`

```solidity
event AdminConfigSet(bool sharesPaused, bool lootPaused);
```

**Handler action:**
- Update DAO pause state flags
- When shares are paused, transfers are blocked (minting/burning still works)

#### `LockAdmin` / `LockManager` / `LockGovernor`

```solidity
event LockAdmin(bool lock);
event LockManager(bool lock);
event LockGovernor(bool lock);
```

**Handler action:**
- Update DAO lock flags (irreversible — once true, always true)
- These indicate the DAO has permanently disabled the ability to grant new navigators with that permission level

---

### 3. Token Events (SharesERC20 / LootERC20)

Standard ERC20 events plus delegation events (SharesERC20 only).

#### `Transfer` (ERC20)

```solidity
event Transfer(address indexed from, address indexed to, uint256 value);
```

**Handler action:**
- Update member balances for both `from` and `to`
- `from = address(0)` → mint (also covered by `MintShares`/`MintLoot` — use one or the other, not both)
- `to = address(0)` → burn (also covered by `BurnShares`/`BurnLoot`)
- Regular transfers (both non-zero) represent peer-to-peer token movement

**Important:** `MintShares`/`BurnShares` events are emitted by DAOShip, while `Transfer` events are emitted by the token contracts. Both fire for the same operation. The indexer should use ONE source for balance tracking to avoid double-counting. Recommended: use `Transfer` events from token contracts as the authoritative balance source, and use `MintShares`/`BurnShares` for aggregate tracking and activity feeds.

#### `DelegateChanged` (SharesERC20 only)

```solidity
event DelegateChanged(address delegator, address fromDelegate, address toDelegate);
```

**Handler action:**
- Update delegation record: `delegator` changed their delegate from `fromDelegate` to `toDelegate`
- `toDelegate = address(0)` means delegation cleared (undelegated)
- Auto-delegation on first mint emits this with `fromDelegate = address(0)` and `toDelegate = delegator`

#### `DelegateVotesChanged` (SharesERC20 only)

```solidity
event DelegateVotesChanged(address delegate, uint256 previousBalance, uint256 newBalance);
```

**Handler action:**
- Update the voting power for `delegate`
- This fires whenever delegation changes OR when the delegator's balance changes
- `newBalance` is the current total voting power delegated to this address

---

### 4. Navigator Events

Emitted by navigator contracts (OnboarderNavigator, ERC20TributeNavigator, NFTGatedNavigator, SignalNavigator, TimelockNavigator, VestingNavigator, BudgetNavigator, SubscriptionNavigator). All navigators implement `INavigator` and emit `NavigatorDeployed` at construction time. Note that not every navigator is an *onboarding* navigator — `SignalNavigator` (polls), `TimelockNavigator` (config delay), `VestingNavigator` (cliff/linear vesting), `BudgetNavigator` (treasury budgets), and `SubscriptionNavigator` (recurring dues) emit no `Onboard` event; each has its own event set (see below).

#### `NavigatorDeployed` (All navigators implementing INavigator)

```solidity
event NavigatorDeployed(
    address indexed daoShip,
    address indexed deployer,
    string navigatorType,
    string name,
    string description
);
```

**Topic0:** `keccak256("NavigatorDeployed(address,address,string,string,string)")`

**Handler action:**
- This is the **canonical source** of navigator metadata (name, description, deployer, type)
- Store `deployer` in `ds_navigators.deployer` (add column if not present)
- Store `name` and `description` in `ds_navigators.name` / `ds_navigators.description`
- Store `navigatorType` in `ds_navigators.navigator_type`
- **Bind `ds_navigators.dao_id` from the indexed `daoShip` here — do not wait for `NavigatorSet`.** This is the canonical DAO association for *every* INavigator navigator; `NavigatorSet` only ever updates `permission` / `is_active` afterward (and never arrives at all for read-only navigators). Caveat: this binding is *self-asserted* and unauthenticated — `NavigatorDeployed` is permissionless, so for read-only navigators it must be treated as untrusted until sanctioned (see [Protecting DAOs from spam read-only navigators](#protecting-daos-from-spam-read-only-navigators)).
- `name` and `description` may be empty strings (they are optional at deploy time)
- This event is emitted exactly once per navigator (in the constructor), so there is no deduplication concern

**Discovery pattern:** The indexer should subscribe to `NavigatorDeployed` events from **all addresses** (unfiltered topic0 scan), not just from known navigator addresses. This allows the indexer to capture navigator metadata before the navigator is registered via `NavigatorSet`. When a `NavigatorSet` event arrives later, the metadata is already available.

**Legacy navigators:** Navigators deployed before the `INavigator` interface will not emit this event. For those navigators, use the `navigatorType()` view function via RPC as a fallback. Name and description will not be available for legacy navigators.

#### `Onboard` (OnboarderNavigator)

```solidity
event Onboard(
    address indexed daoShipAddress,
    address indexed contributor,
    uint256 amount,
    uint256 shares,
    uint256 loot
);
```

**Handler action:**
- Create onboard record: contributor paid `amount` QUAI and received `shares` + `loot`
- `daoShipAddress` identifies which DAO this onboarding belongs to
- Upsert member record for `contributor`

**Other events (optional to index):** `StuckETHRecovered(address indexed to, uint256 amount)` fires when governance recovers ETH stranded by a failed refund via `withdrawStuckETH`. It is not part of normal onboarding — index only if you surface treasury-recovery activity.

#### `Onboard` (ERC20TributeNavigator)

```solidity
event Onboard(
    address indexed daoShipAddress,
    address indexed contributor,
    uint256 amount,
    uint256 shares,
    uint256 loot
);
```

**Handler action:**
- Same event signature as OnboarderNavigator. `amount` is in ERC20 tokens (not native QUAI)
- The tribute token address is available from the navigator contract's `tributeToken()` view function (call once at registration time)

**Other events (optional to index):** `StuckTokensRecovered(address indexed token, address indexed to, uint256 amount)` fires when governance recovers mistakenly-sent tokens via `withdrawStuckTokens` — optional, like the Onboarder recovery event above.

**Note:** Both `onboard()` and `onboardWithPermit()` emit the same `Onboard` event. The indexer does not need to distinguish between the two entry points -- the event signature and handler logic are identical regardless of whether the user used standard approve or ERC-2612 permit.

**Note:** `daoShipAddress` is new. The old indexer had to do an on-chain `baal()` lookup to associate onboarding events with a DAO.

#### `Onboard` + `NFTClaimed` (NFTGatedNavigator)

`navigatorType = "NFTGatedNavigator"`. ERC-721-gated onboarding (one claim per `tokenId`). It emits the standard `Onboard` event (so the generic onboarding feed/`ds_navigator_events` handler works unchanged — `amount` is the native tribute, 0 in free-mint mode) **and** an additional `NFTClaimed` event carrying the token id:

```solidity
event NFTClaimed(
    address indexed daoShipAddress,
    address indexed holder,
    uint256 indexed tokenId,
    uint256 shares,
    uint256 loot
);
```

**Topic0:** `keccak256("NFTClaimed(address,address,uint256,uint256,uint256)")`

**Handler action:**
- Record that `tokenId` of this navigator's gate collection has been **claimed** (spent) by `holder`. This is the canonical per-token claim status — a token can be claimed exactly once, ever, regardless of subsequent transfers.
- `holder` received `shares` + `loot`; upsert the member record (or rely on the paired `Onboard`/`Transfer` events — do not double-count balances).
- Because both `Onboard` and `NFTClaimed` fire in the same transaction, treat `Onboard` as the onboarding-activity source and `NFTClaimed` purely as token-level claim state. Suggested storage:

```sql
CREATE TABLE ds_nft_claims (
    id VARCHAR(128) PRIMARY KEY,          -- {navigator_address}-{token_id}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    token_id NUMERIC(78,0) NOT NULL,
    holder VARCHAR(42) NOT NULL,          -- claimer at claim time (NFT may move later)
    shares NUMERIC(78,0) DEFAULT '0',
    loot NUMERIC(78,0) DEFAULT '0',
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);
```

The navigator's gate collection address is available from the `gateToken()` view (call once at registration). A frontend "can I join with token #N?" check maps to the `canOnboard(address,uint256)` view, or to absence of a `ds_nft_claims` row for that `(navigator, token_id)`.

#### `Paused` / `Unpaused` (Both navigators)

```solidity
event Paused(address indexed caller);
event Unpaused(address indexed caller);
```

**Handler action:**
- Update navigator status (paused/active)
- `caller` is the address that triggered the pause/unpause

#### `PollCreated` / `Voted` / `PollCancelled` (SignalNavigator)

`navigatorType = "SignalNavigator"`. Non-binding, share-weighted governance polls ("temperature checks"). **This is a read-only navigator: it holds NO permission, never calls a mutating function on DAOShip, and is therefore NEVER registered via `setNavigators()` — so no `NavigatorSet` event ever fires for it.** It is discovered exclusively from its `NavigatorDeployed` event (which carries the indexed `daoShip` association). See [Permissionless (read-only) navigators](#permissionless-read-only-navigators) under Navigator Discovery — the standard "register for monitoring on `NavigatorSet` with permission > 0" rule does **not** apply here, and an indexer that only monitors navigators seen via `NavigatorSet` will index zero polls.

It emits no `Onboard` event (it never mints shares or loot). Its three events stand alone:

```solidity
event PollCreated(
    uint256 indexed pollId,
    address indexed creator,
    string question,            // IPFS hash or short text
    uint8 optionCount,          // 2..10
    uint64 snapshotTimestamp,   // votingStarts - 1; voting power measured here
    uint64 votingStarts,
    uint64 votingEnds
);
event Voted(uint256 indexed pollId, address indexed voter, uint8 indexed option, uint256 weight);
event PollCancelled(uint256 indexed pollId, address indexed caller);
```

**Topic0:**
- `keccak256("PollCreated(uint256,address,string,uint8,uint64,uint64,uint64)")`
- `keccak256("Voted(uint256,address,uint8,uint256)")`
- `keccak256("PollCancelled(uint256,address)")`

**`pollId` is per-navigator, not global.** Ids start at 0 and increment within each SignalNavigator contract (`pollCount`). Key all poll rows by `(navigator_address, poll_id)`, and resolve the DAO from the navigator's `NavigatorDeployed.daoShip` (the poll events themselves do not carry the DAO address).

**Handler action — `PollCreated`:**
- Insert a poll row keyed by `(navigator_address, poll_id)`.
- `question` is an IPFS CID or short text (same convention as proposal / Poster content) — resolve off-chain if it is a CID. This is the **canonical headline**.
- **Option labels are off-chain.** `PollCreated` carries only `optionCount`; options are bare indices `0..optionCount-1`. The index→label map (plus optional `description` / `discussionUrl`) arrives via a `daoships.signal.poll` Poster post keyed by `(navigatorAddress, pollId)`. Trust it ONLY when the Poster `msg.sender == PollCreated.creator`, require `options.length == optionCount` (else discard and render `Option 1..n`), and apply last-write-wins per creator. The labels post is a separate tx that normally lands *after* this event — if it arrives first, hold it keyed by `(navigatorAddress, pollId)` and apply on `PollCreated` (hold-until-discovered). See [POSTER.md → Signal Poll Options](POSTER.md#signal-poll-options-daoshipssignalpoll).
- **Status is time-derived, not event-driven.** There is no "poll opened" or "poll ended" event. Compute status from the timestamps exactly as the contract's `pollStatus()` does: `Pending` while `now < votingStarts`, `Active` while `votingStarts <= now < votingEnds`, `Ended` once `now >= votingEnds`, `Cancelled` if the cancelled flag is set (terminal, overrides the others).
- `snapshotTimestamp = votingStarts - 1` is the timepoint at which every voter's weight is measured (delegation-aware `getPriorVotes`). Store it if you reconstruct or verify tallies.

**Handler action — `Voted`:**
- Insert a vote row keyed by `(navigator_address, poll_id, voter)`. One vote per address per poll is enforced on-chain — a second row for the same key is a reorg/replay; dedupe on it.
- `weight` is the voter's **share** voting power at the snapshot. **Loot does not count — shares only.** Increment the poll's per-option tally by `weight`; never derive weight from current balances (it is frozen at `votingStarts - 1`).
- `option` is the chosen index, `0..optionCount-1`.

**Handler action — `PollCancelled`:**
- Mark the poll cancelled (terminal). `caller` is the creator (allowed only before voting opens) or the DAO avatar (allowed any time before the poll ends). Ignore any later events for a cancelled poll.

**Views for backfill / reconciliation** (all on the navigator contract):
- `polls(pollId)` — scalar fields only (creator, question, optionCount, snapshotTimestamp, votingStarts, votingEnds, cancelled); the nested tallies and voted-flags are omitted from the public getter.
- `getResults(pollId) -> uint256[]` — full tally indexed by option. `getOptionVotes(pollId, option)`, `hasVoted(pollId, voter)`, `pollStatus(pollId)`, `pollCount`.
- Config immutables: `minSharesToCreatePoll`, `minDuration`, `maxDuration`, `maxStartDelay`.

**Frontend display — trust is mandatory, not optional.** Polls inherit the trust of their navigator. Every poll query MUST join `ds_navigators.trust_status` (keyed by `navigator_address`) and the frontend MUST act on it — a poll from a `self_asserted` navigator looks identical to a sanctioned one on-chain, so the only thing protecting a DAO's poll feed from injected spam is this label:
- **`sanctioned`** — the DAO endorsed this navigator via a vault `daoships.dao.navigators` proposal. Show in the default feed.
- **`self_asserted`** — deployed against the DAO but not (yet) endorsed. Hide behind a "show unverified polls" toggle, or render with a clear "unverified" badge. Never show in the default feed.
- **`unsanctioned`** — endorsement was revoked. Treat like `self_asserted` (or hide entirely).
- **`fabricated`** — weights failed reconciliation against the DAO's checkpoints. Never display.

Default the UI to the safe view (`sanctioned` only). Surface poll **status** with the same time-derived logic the contract uses (`pollStatus()`): `Pending` / `Active` / `Ended` / `Cancelled` — do not rely on an event to tell you a poll opened or closed. To let a DAO endorse a navigator from the UI, submit the governance proposal in [POSTER.md → Pattern 4](POSTER.md#pattern-4-sanction-a-read-only-navigator-governance-proposal).

This navigator has **no** `Paused`/`Unpaused` (no pause mechanism). Suggested storage:

```sql
-- SignalNavigator polls (non-binding temperature checks)
CREATE TABLE ds_signal_polls (
    id VARCHAR(128) PRIMARY KEY,           -- {navigator_address}-{poll_id}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    poll_id NUMERIC(78,0) NOT NULL,        -- per-navigator, starts at 0
    creator VARCHAR(42) NOT NULL,
    question TEXT,                          -- IPFS CID or short text (canonical headline, from PollCreated)
    option_count SMALLINT NOT NULL,         -- 2..10
    snapshot_timestamp BIGINT NOT NULL,     -- votingStarts - 1 (weight timepoint)
    voting_starts BIGINT NOT NULL,
    voting_ends BIGINT NOT NULL,
    cancelled BOOLEAN DEFAULT FALSE,
    tally NUMERIC(78,0)[] DEFAULT '{}',     -- per-option running totals (index = option)
    -- Off-chain option labels (Poster `daoships.signal.poll`, msg.sender == creator; len(options)==option_count)
    options TEXT[],                         -- index->label map; NULL until labels post seen (render Option 1..n)
    description TEXT,                        -- optional poll context
    discussion_url TEXT,                    -- optional forum/discussion link
    labels_updated_at TIMESTAMPTZ,          -- last-write-wins timestamp of the labels post
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(navigator_address, poll_id)
);

-- SignalNavigator votes (one row per address per poll)
CREATE TABLE ds_signal_votes (
    id VARCHAR(170) PRIMARY KEY,           -- {navigator_address}-{poll_id}-{voter}
    poll_pk VARCHAR(128) REFERENCES ds_signal_polls(id),
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    poll_id NUMERIC(78,0) NOT NULL,
    voter VARCHAR(42) NOT NULL,
    option SMALLINT NOT NULL,               -- 0..option_count-1
    weight NUMERIC(78,0) NOT NULL,          -- snapshot share weight (loot excluded)
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ,
    UNIQUE(navigator_address, poll_id, voter)
);
```

#### `ChangeQueued` / `ChangeExecuted` / `ChangeCancelled` (TimelockNavigator)

`navigatorType = "TimelockNavigator"`. A **GOVERNOR (4)** navigator that wraps `DAOShip.setGovernanceConfig` behind a mandatory delay. **Unlike SignalNavigator this is a permissioned navigator: it IS registered via `setNavigators()`, so a `NavigatorSet(address,4)` event fires and `trust_status` is `sanctioned`.** Discovery is the standard permissioned path (`NavigatorDeployed` for metadata + `NavigatorSet` for registration). It emits no `Onboard` event. Its events:

```solidity
event ChangeQueued(
    uint256 indexed changeId,
    address indexed queuedBy,      // always the DAO avatar (queued via proposal)
    bytes32 configHash,            // keccak256(governanceConfig)
    bytes governanceConfig,        // full ABI-encoded config — store it; only the hash is kept on-chain
    uint64 executableAfter,        // queuedAt + delay
    uint64 expiresAt               // executableAfter + expiryWindow
);
event ChangeExecuted(uint256 indexed changeId, address indexed executor, bytes32 configHash);
event ChangeCancelled(uint256 indexed changeId, address indexed caller);
```

**Topic0:**
- `keccak256("ChangeQueued(uint256,address,bytes32,bytes,uint64,uint64)")`
- `keccak256("ChangeExecuted(uint256,address,bytes32)")`
- `keccak256("ChangeCancelled(uint256,address)")`

**`changeId` is per-navigator, not global.** Ids start at 0 and increment within each TimelockNavigator (`changeCount`). Key change rows by `(navigator_address, change_id)`; resolve the DAO from the navigator's `NavigatorDeployed.daoShip`.

**Handler action — `ChangeQueued`:**
- Insert a change row. **Store the full `governanceConfig` bytes** — only the hash is on-chain, and `executeChange(changeId, governanceConfig)` requires the exact bytes, so the app recovers them from this event. Decode the 7 fields (votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent, defaultExpiryWindow) to render the pending parameters.
- **Status is time-derived until terminal**, like Signal polls. There is no "became executable" or "expired" event: `queued` while `now < executableAfter`, `executable` while `executableAfter <= now <= expiresAt`, `expired` once `now > expiresAt` — unless an event makes it terminal (`executed` / `cancelled`). The `delay` window is a second ragequit window; surface a countdown to `executableAfter`.

**Handler action — `ChangeExecuted`:** mark the change `executed` (terminal). The config is now live on DAOShip (a `GovernanceConfigSet` fires in the **same transaction** — see bypass detection).

**Handler action — `ChangeCancelled`:** mark the change `cancelled` (terminal). Emitted by `cancelChange` (avatar) or `emergencyCancelAll` (GOVERNOR/avatar — cancels every pending change and pauses; expect a burst of these followed by a `Paused`).

**⚠️ Bypass detection — the key indexer responsibility for this navigator.** The timelock is *advisory*, not enforced on-chain: a proposal can still change governance config directly via `executeAsGovernance` → `setGovernanceConfig`, skipping the timelock entirely (see NAVIGATORS.md → TimelockNavigator). The on-chain tell:

> Every **legitimate** timelocked change emits the timelock's `ChangeExecuted` in the **same transaction** as DAOShip's `GovernanceConfigSet`. A `GovernanceConfigSet` that fires on a DAO which has an **active `TimelockNavigator`** (a registered, non-revoked GOVERNOR navigator of `navigator_type = 'TimelockNavigator'`) **without** a paired `ChangeExecuted` from that navigator in the same tx is a **timelock bypass**.

Flag such `GovernanceConfigSet` events with elevated severity (e.g. `ds_governance_config_history.bypassed_timelock = TRUE`) so the app can surface a warning on that proposal / parameter change. DAOs with no active TimelockNavigator are unaffected (no expectation to route through it).

**Views for backfill:** `queuedChanges(changeId)` (all struct fields), `changeCount`, `isExecutable(changeId)`, and config immutables `delay` / `expiryWindow`.

```sql
-- TimelockNavigator queued config changes
CREATE TABLE ds_timelock_changes (
    id VARCHAR(128) PRIMARY KEY,           -- {navigator_address}-{change_id}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    change_id NUMERIC(78,0) NOT NULL,      -- per-navigator, starts at 0
    queued_by VARCHAR(42) NOT NULL,        -- the DAO avatar (always queued via proposal)
    config_hash VARCHAR(66) NOT NULL,      -- keccak256(governanceConfig)
    governance_config BYTEA,               -- full ABI-encoded bytes (needed to call executeChange + decode)
    executable_after BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    status VARCHAR(16) DEFAULT 'queued',   -- queued|executable|expired (time-derived) | executed|cancelled (terminal)
    executed_tx VARCHAR(66),
    cancelled_tx VARCHAR(66),
    tx_hash VARCHAR(66),                    -- queue tx
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(navigator_address, change_id)
);
```

#### `ScheduleCreated` / `TokensClaimed` / `ScheduleRevoked` (VestingNavigator)

`navigatorType = "VestingNavigator"`. A **MANAGER (2)** navigator that vests shares or loot on a cliff + linear schedule, minting incrementally via `claim`. **Permissioned — registered via `setNavigators()`, so `NavigatorSet(address,2)` fires and `trust_status` is `sanctioned`** (standard permissioned discovery). It emits no `Onboard` event; claims mint through DAOShip, so a `MintShares`/`MintLoot` + token `Transfer` fire in the same tx (take **balances** from `Transfer` as usual — `TokensClaimed` is the vesting-activity feed, do not double-count). Its events:

```solidity
event ScheduleCreated(
    uint256 indexed scheduleId,
    address indexed beneficiary,
    uint256 totalAmount,
    uint64 startTime,
    uint64 cliffEnd,
    uint64 vestingEnd,
    bool isLoot                    // false = shares, true = loot
);
event TokensClaimed(uint256 indexed scheduleId, address indexed beneficiary, uint256 amount, bool isLoot);
event ScheduleRevoked(uint256 indexed scheduleId, address indexed caller, uint64 revokedAt, uint256 vestedAtRevoke);
```

**Topic0:**
- `keccak256("ScheduleCreated(uint256,address,uint256,uint64,uint64,uint64,bool)")`
- `keccak256("TokensClaimed(uint256,address,uint256,bool)")`
- `keccak256("ScheduleRevoked(uint256,address,uint64,uint256)")`

**`scheduleId` is per-navigator, not global** (`scheduleCount`, starts at 0). Key by `(navigator_address, schedule_id)`; resolve the DAO from `NavigatorDeployed.daoShip`.

**Handler action — `ScheduleCreated`:** insert a schedule row. `startTime`/`cliffEnd`/`vestingEnd` are absolute timestamps (the contract resolves `startTime == 0` to the creation block before emitting, so the event always carries the concrete value). `isLoot` picks the token kind.

**Handler action — `TokensClaimed`:** `amount` is the **incremental** amount minted in this claim (not cumulative). Increment the schedule's `claimed` by it, and append a claim-feed row. Claims may be partial and repeated as more vests.

**Handler action — `ScheduleRevoked`:** set `revoked = true`, store `revoked_at` and `vested_at_revoke`. Revocation is non-destructive — already-minted tokens stay; future vesting is frozen at `revoked_at`. The beneficiary can still claim up to `vested_at_revoke - claimed`.

**Status / claimable are time-derived** (mirror the contract's `_vestedAmount`): `pending` while `now < cliffEnd`, `vesting` while `cliffEnd <= now < vestingEnd`, `fully_vested` once `now >= vestingEnd`; `revoked` overrides with the freeze at `revoked_at`. `claimable = vested(effectiveEnd) - claimed`, where `effectiveEnd = revoked_at if revoked else now`. Use the `vested(id)` / `claimable(id)` views for exact reconciliation; `getSchedules(beneficiary)` enumerates a member's schedules.

```sql
-- VestingNavigator schedules
CREATE TABLE ds_vesting_schedules (
    id VARCHAR(128) PRIMARY KEY,           -- {navigator_address}-{schedule_id}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    schedule_id NUMERIC(78,0) NOT NULL,    -- per-navigator, starts at 0
    beneficiary VARCHAR(42) NOT NULL,
    total_amount NUMERIC(78,0) NOT NULL,
    claimed NUMERIC(78,0) DEFAULT '0',     -- cumulative; += each TokensClaimed.amount
    is_loot BOOLEAN NOT NULL,              -- false = shares, true = loot
    start_time BIGINT NOT NULL,
    cliff_end BIGINT NOT NULL,
    vesting_end BIGINT NOT NULL,
    revoked BOOLEAN DEFAULT FALSE,
    revoked_at BIGINT,                      -- vesting freeze point (null until revoked)
    vested_at_revoke NUMERIC(78,0),         -- from ScheduleRevoked
    tx_hash VARCHAR(66),                    -- creation tx
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(navigator_address, schedule_id)
);

-- VestingNavigator claim feed (one row per claim tx)
CREATE TABLE ds_vesting_claims (
    id VARCHAR(170) PRIMARY KEY,           -- {navigator_address}-{schedule_id}-{tx_hash}
    schedule_pk VARCHAR(128) REFERENCES ds_vesting_schedules(id),
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    schedule_id NUMERIC(78,0) NOT NULL,
    beneficiary VARCHAR(42) NOT NULL,
    amount NUMERIC(78,0) NOT NULL,         -- incremental amount minted in this claim
    is_loot BOOLEAN NOT NULL,
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);
```

Both navigators also emit `Paused(address)` / `Unpaused(address)` (same handling as the shared section above — update `ds_navigators.paused`).

---

#### `BudgetCreated` / `Disbursed` / `ManagerUpdated` / `BudgetCancelled` (BudgetNavigator)

`navigatorType = "BudgetNavigator"`. A treasury-disbursement navigator: governance approves a recurring budget (per-budget manager, per-period allowance, lifetime ceiling) and the manager pays out from the **vault** without a proposal per payment. It mints nothing.

**⚠️ New discovery + trust case — read this.** BudgetNavigator holds **NO DAOShip permission**, so — like SignalNavigator — **it never fires `NavigatorSet`**. But it is **NOT a read-only navigator**, so the read-only Poster `daoships.dao.navigators` sanctioning path does **not** apply to it either. Its authority is **vault module status**, and its trust signal is **on-chain and authenticated**: the DAO's **vault** emits `EnabledModule(budgetNav)` when a governance proposal grants it. That is the strongest possible signal — it is the actual capability grant, gated by the vault (`msg.sender == vault`), unforgeable. Therefore:

- Discover the navigator from `NavigatorDeployed` (metadata + self-asserted DAO binding), as for every navigator.
- **Watch the DAO's vault** (the `vault` address from `LaunchDAOShipAndVault`) for the Zodiac module events and use them as the trust + active-state source:

```solidity
event EnabledModule(address indexed module);   // QuaiVault / IAvatar
event DisabledModule(address indexed module);
```

**Topic0:** `keccak256("EnabledModule(address)")`, `keccak256("DisabledModule(address)")`.

- On `EnabledModule(budgetNav)` from a DAO's vault → set the navigator `trust_status = 'sanctioned'` and `is_active = true` (it can now move treasury funds). On `DisabledModule(budgetNav)` → `trust_status = 'unsanctioned'`, `is_active = false`. A BudgetNavigator that has **never** been enabled on its claimed DAO's vault is `self_asserted` — show no budgets/disbursements from it in default views; it cannot actually move funds until enabled. (You may also confirm current state at any time via `vault.isModuleEnabled(budgetNav)`.)

Its own events:

```solidity
event BudgetCreated(uint256 indexed budgetId, address indexed manager, address token,
                    uint256 allowancePerPeriod, uint256 totalCeiling,
                    uint64 periodLength, uint64 startsAt, uint64 endsAt);   // token: 0x0 = native QUAI
event Disbursed(uint256 indexed budgetId, address indexed to, address token, uint256 amount);
event ManagerUpdated(uint256 indexed budgetId, address indexed oldManager, address indexed newManager);
event BudgetCancelled(uint256 indexed budgetId, address indexed caller);
```

**Topic0:**
- `keccak256("BudgetCreated(uint256,address,address,uint256,uint256,uint64,uint64,uint64)")`
- `keccak256("Disbursed(uint256,address,address,uint256)")`
- `keccak256("ManagerUpdated(uint256,address,address)")`
- `keccak256("BudgetCancelled(uint256,address)")`

**`budgetId` is per-navigator, not global** (`budgetCount`, starts at 0). Key by `(navigator_address, budget_id)`; resolve the DAO from `NavigatorDeployed.daoShip`.

**Handler action — `BudgetCreated`:** insert a budget row. `startsAt` is absolute (the contract resolves `startTime == 0` to the creation block before emitting). `endsAt == 0` means perpetual; `token == 0x0` means native QUAI.

**Handler action — `Disbursed`:** append a disbursement-feed row (one row per recipient — `disburse` emits one, `disburseBatch` emits N). Each disbursement also moves value out of the vault (a native transfer or an ERC20 `Transfer` **from the vault**); take balances from the token `Transfer` and treat `Disbursed` as the budget-activity feed (don't double-count). `spent_this_period` and `total_spent` are best maintained from the navigator's `budgets(id)` view or by summing `Disbursed`, since the on-chain `spentThisPeriod` resets lazily.

**Handler action — `ManagerUpdated`:** update the budget's `manager`. **`BudgetCancelled`:** set `cancelled = true` (irreversible; halts disbursement). Also emits `Paused(address)` / `Unpaused(address)` — same handling as the shared section (update `ds_navigators.paused`); note that for this navigator pause freezes **all disbursement**, not just creation.

**Period / remaining are time-derived** (mirror the contract): a budget is `active` while `now >= startsAt && (endsAt == 0 || now < endsAt) && !cancelled`. `remainingThisPeriod` resets every `periodLength` (lazily on-chain); reconcile exact values via the `remainingThisPeriod(id)` / `remainingTotal(id)` views rather than trusting a possibly-stale stored `spent_this_period`.

```sql
-- BudgetNavigator budgets
CREATE TABLE ds_budgets (
    id VARCHAR(128) PRIMARY KEY,           -- {navigator_address}-{budget_id}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    budget_id NUMERIC(78,0) NOT NULL,      -- per-navigator, starts at 0
    manager VARCHAR(42) NOT NULL,
    token VARCHAR(42) NOT NULL,            -- 0x0000...0000 = native QUAI
    allowance_per_period NUMERIC(78,0) NOT NULL,
    total_ceiling NUMERIC(78,0) NOT NULL,
    total_spent NUMERIC(78,0) DEFAULT '0', -- cumulative; += each Disbursed.amount
    period_length BIGINT NOT NULL,
    starts_at BIGINT NOT NULL,
    ends_at BIGINT NOT NULL,               -- 0 = perpetual
    cancelled BOOLEAN DEFAULT FALSE,
    tx_hash VARCHAR(66),                   -- creation tx
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(navigator_address, budget_id)
);

-- BudgetNavigator disbursement feed (one row per recipient per disburse/disburseBatch)
CREATE TABLE ds_budget_disbursements (
    id VARCHAR(180) PRIMARY KEY,           -- {navigator_address}-{budget_id}-{tx_hash}-{log_index}
    budget_pk VARCHAR(128) REFERENCES ds_budgets(id),
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    budget_id NUMERIC(78,0) NOT NULL,
    recipient VARCHAR(42) NOT NULL,
    token VARCHAR(42) NOT NULL,
    amount NUMERIC(78,0) NOT NULL,
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);
```

---

#### `MemberEnrolled` / `FeePaid` / `FeeCollected` (SubscriptionNavigator)

`navigatorType = "SubscriptionNavigator"`. A **MANAGER (2)** navigator for recurring membership dues: members pull-pay periodic fees (in a governance-set menu of native QUAI / ERC20 tokens) to the **vault**, and once a member is past grace **anyone** may `collectFee(member)` to strip their shares (converted to loot, or burned) for a small loot keeper reward. **Permissioned — registered via `setNavigators()`, so `NavigatorSet(address,2)` fires and `trust_status` is `sanctioned`** (standard permissioned discovery). It emits no `Onboard` event.

**Token-balance changes come from the core events, not from these — do not double-count.** `payFee` moves the fee **into** the vault (an ERC20 `Transfer` to the vault, or a native transfer). `collectFee` removes the member's shares through DAOShip, so the same tx carries either a `ConvertSharesToLoot` (convert mode → shares `Transfer`→0 + loot `Transfer`←0) or a `BurnShares` (burn mode), plus a `MintLoot` for the keeper reward. Take **balances** from those Transfer/mint/burn events as usual; treat `FeePaid` / `FeeCollected` as the subscription-activity feeds.

```solidity
event MemberEnrolled(address indexed member, uint256 paidThrough);
event FeePaid(address indexed member, address indexed payer, address indexed token,
              uint256 amount, uint256 periods, uint256 paidThrough);  // token: 0x0 = native QUAI
event FeeCollected(address indexed member, address indexed collector,
                   uint256 sharesRemoved, uint256 reward, bool burned); // burned: true=burn, false=convert-to-loot
```

**Topic0:**
- `keccak256("MemberEnrolled(address,uint256)")`
- `keccak256("FeePaid(address,address,address,uint256,uint256,uint256)")`
- `keccak256("FeeCollected(address,address,uint256,uint256,bool)")`

**Membership is keyed by `(navigator_address, member)`** — there is no per-member id; `paidThrough` is the whole state (`paidThrough == 0` ⇒ not enrolled, or collected/un-enrolled). Resolve the DAO from `NavigatorDeployed.daoShip`.

**Handler action — `MemberEnrolled`:** upsert the member row, setting `paid_through` to the event value. Fired on governance `enroll`/`enrollBatch` and for `_initialMembers` at construction (the complimentary-period grant). A member's **first `payFee`** self-enrolls **without** a `MemberEnrolled` event — so also upsert the member row on `FeePaid` (below).

**Handler action — `FeePaid`:** set the member's `paid_through` to the event's `paidThrough` (it is the new absolute value — do **not** add to it), upsert-creating the member row if absent (self-enroll). Append one `ds_subscription_payments` feed row and flag the member dirty. `token == 0x0` is native QUAI. **`amount` is per-payment; derive the member's cumulative `total_paid` by SUM over the payments feed at end-of-range — do NOT `+=` inline in the handler** (replay/reorg double-counts — see the cumulative-counter rule, same pattern as Vesting `claimed` / Budget `total_spent`).

**Handler action — `FeeCollected`:** set the member's `paid_through = 0` (collection un-enrolls them) and `last_collected_at`. Append one `ds_subscription_collections` feed row (`shares_removed`, `reward`, `burned`). Cumulative collected totals (if surfaced) are likewise a **SUM over the feed**, never an inline `+=`.

**Status is time-derived** (mirror the contract). With `pt = paid_through` and `grace = graceDuration` (read once from the navigator, immutable): `not_enrolled` if `pt == 0`; else `current` while `now <= pt`, `grace` while `pt < now <= pt + grace`, `delinquent` once `now > pt + grace` (collectible). The fee menu is immutable — read `getAcceptedTokens()` / `feePerPeriod(token)` once at discovery; `quote(periods, token)` reconciles cost. **Trust is mandatory in the UI:** dues/collection actions touch the cap table, so default views to `trust_status = 'sanctioned'` only.

```sql
-- SubscriptionNavigator membership (one row per member per navigator)
CREATE TABLE ds_subscription_members (
    id VARCHAR(128) PRIMARY KEY,           -- {navigator_address}-{member}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    member VARCHAR(42) NOT NULL,
    paid_through BIGINT DEFAULT 0,         -- absolute ts paid through; 0 = not enrolled / collected
    total_paid NUMERIC(78,0) DEFAULT '0',  -- RECOMPUTE by SUM(ds_subscription_payments.amount); never += inline
    last_collected_at TIMESTAMPTZ,
    tx_hash VARCHAR(66),                   -- enrollment/first-payment tx
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(navigator_address, member)
);

-- SubscriptionNavigator payment feed (one row per FeePaid)
CREATE TABLE ds_subscription_payments (
    id VARCHAR(180) PRIMARY KEY,           -- {navigator_address}-{member}-{tx_hash}-{log_index}
    member_pk VARCHAR(128) REFERENCES ds_subscription_members(id),
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    member VARCHAR(42) NOT NULL,
    payer VARCHAR(42) NOT NULL,            -- payFeeFor → differs from member
    token VARCHAR(42) NOT NULL,            -- 0x0000...0000 = native QUAI
    amount NUMERIC(78,0) NOT NULL,         -- per-payment; SUM for cumulative
    periods NUMERIC(78,0) NOT NULL,
    paid_through BIGINT NOT NULL,          -- member's new paid_through after this payment
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);

-- SubscriptionNavigator collection feed (one row per FeeCollected)
CREATE TABLE ds_subscription_collections (
    id VARCHAR(180) PRIMARY KEY,           -- {navigator_address}-{member}-{tx_hash}-{log_index}
    member_pk VARCHAR(128) REFERENCES ds_subscription_members(id),
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    member VARCHAR(42) NOT NULL,
    collector VARCHAR(42) NOT NULL,
    shares_removed NUMERIC(78,0) NOT NULL,
    reward NUMERIC(78,0) NOT NULL,         -- loot minted to collector
    burned BOOLEAN NOT NULL,               -- true = burnShares, false = convertSharesToLoot
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);
```

Also emits `Paused(address)` / `Unpaused(address)` — same handling as the shared section (update `ds_navigators.paused`); for this navigator pause freezes payFee, enroll, **and** collectFee.

---

### 5. Poster Events (EIP-3722)

#### `NewPost`

```solidity
event NewPost(
    address indexed user,
    string content,
    string indexed tag
);
```

**Handler action:**
- Store the post with user, content, and tag
- `tag` is indexed (hashed) — the raw tag string must be extracted from the log data, not the topic
- Parse `content` as JSON if it starts with `{`
- See [docs/POSTER.md](POSTER.md) for the complete domain schema and trust model

**Tag-based routing (8 tags total — see [POSTER.md](POSTER.md) for full schemas):**

| Tag | Action | Trust Check |
|-----|--------|-------------|
| `daoships.dao.profile.initial` | Create DAO metadata | `msg.sender` == deployer from launch event |
| `daoships.dao.profile` | Create/update DAO metadata incl. brand `theme` palette (invalidates initial) | `msg.sender` == vault address |
| `daoships.dao.announcement` | Store as DAO announcement | `msg.sender` == vault address |
| `daoships.member.profile` | Create/update member metadata | `msg.sender` has shares > 0 |
| `daoships.proposal.vote.reason` | Associate with vote record (one per voter per proposal) | `msg.sender` matches voter in SubmitVote |
| `daoships.navigator.allowlist` | Store Merkle tree for navigator allowlist proof generation | `msg.sender` has shares > 0 (MEMBER trust) |
| `daoships.dao.navigators` | Set sanctioned read-only navigators (updates `ds_navigators.trust_status`) — see [Protecting DAOs from spam read-only navigators](#protecting-daos-from-spam-read-only-navigators) | `msg.sender` == vault address |
| `daoships.signal.poll` | Set/update option labels + description/discussion link for a poll, keyed by `(navigatorAddress, pollId)` (last-write-wins; `options.length` must equal on-chain `optionCount`) | `msg.sender` == `PollCreated.creator` for that poll |

**IMPORTANT:** Never index a post based on tag alone. Always verify `msg.sender` against the trust model before writing to the database. Discard posts where content exceeds 16 KB.

**Schema versioning:** All Poster content includes `schemaVersion`. Content without it is treated as version `0.0`.

**Brand theme (`dao.profile.theme`, schema 1.1+):** The `daoships.dao.profile` (and `.initial`) content may carry an optional `theme` object (`mode`, `primary`, `secondary`, `accent`, `background`, `surface`, `text`) — store it as-is in `ds_daos.theme` (JSONB). Treat `theme` as a **whole field** under the profile's last-write-wins merge (like `links`): a post's `theme` replaces the stored one, `null` clears it, omission leaves it unchanged — do **not** deep-merge tokens. The indexer MAY drop tokens that fail strict-hex validation (`^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$`) on ingest, but the **render-time** hex check is mandatory on the frontend regardless (CSS-injection guard — see [POSTER.md → Security: Content Rendering](POSTER.md#security-content-rendering)). `avatar`/`banner` are unchanged — `theme` adds colors only, no background image.

**`details` field convention:** The `SubmitProposal` event's `details` string should be parsed as JSON when possible. Extract `title` and `type` for display, and `discussionUrl` for linking to off-chain discussion. Fall back to plain text if not valid JSON. See [POSTER.md](POSTER.md) for the convention.

---

## Database Schema

### Naming Convention

- Table prefix: `ds_` (DAO Ships)
- All addresses: `VARCHAR(42)` (0x-prefixed, lowercase)
- All token amounts: `NUMERIC(78,0)` (uint256 as string)
- All timestamps: `TIMESTAMPTZ`
- Composite IDs: `{dao_address}-{entity_id}` (e.g., proposal ID = `0x00ab...-42`)

### Core Tables

```sql
-- DAO registry
CREATE TABLE ds_daos (
    id VARCHAR(42) PRIMARY KEY,           -- DAOShip contract address
    avatar VARCHAR(42) NOT NULL,           -- Vault/treasury address
    shares_address VARCHAR(42) NOT NULL,   -- SharesERC20 clone address
    loot_address VARCHAR(42) NOT NULL,     -- LootERC20 clone address
    deployer VARCHAR(42),                   -- Real deployer wallet (from LaunchDAOShipAndVault.launcher or direct LaunchDAOShip.launcher)
    launcher_contract VARCHAR(42),          -- Contract that called DAOShipLauncher (may be DAOShipAndVaultLauncher or deployer wallet)

    -- Governance parameters (from SetupComplete / GovernanceConfigSet)
    voting_period INTEGER,
    grace_period INTEGER,
    proposal_offering NUMERIC(78,0),
    quorum_percent NUMERIC(78,0),          -- Basis points (10000 = 100%)
    sponsor_threshold NUMERIC(78,0),
    min_retention_percent NUMERIC(78,0),   -- Basis points
    default_expiry_window INTEGER,

    -- State
    shares_paused BOOLEAN DEFAULT FALSE,
    loot_paused BOOLEAN DEFAULT FALSE,
    admin_locked BOOLEAN DEFAULT FALSE,
    manager_locked BOOLEAN DEFAULT FALSE,
    governor_locked BOOLEAN DEFAULT FALSE,
    total_shares NUMERIC(78,0) DEFAULT '0',
    total_loot NUMERIC(78,0) DEFAULT '0',
    proposal_count INTEGER DEFAULT 0,
    active_member_count INTEGER DEFAULT 0,

    -- Metadata (from Poster `dao.profile` / `dao.profile.initial`)
    name VARCHAR(255),
    description TEXT,
    avatar_img TEXT,                        -- IPFS CID or URL (the DAO icon)
    banner_img TEXT,                        -- IPFS CID or URL (the DAO banner)
    theme JSONB,                            -- brand palette (schema 1.1+); colors must pass strict-hex check before CSS use

    -- Tracking
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Members (upserted on mint/burn/transfer)
CREATE TABLE ds_members (
    id VARCHAR(85) PRIMARY KEY,            -- {dao_address}-{member_address}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    member_address VARCHAR(42) NOT NULL,
    shares NUMERIC(78,0) DEFAULT '0',
    loot NUMERIC(78,0) DEFAULT '0',
    delegating_to VARCHAR(42),             -- Current delegate
    voting_power NUMERIC(78,0) DEFAULT '0', -- Delegated votes received
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(dao_id, member_address)
);

-- Proposals
CREATE TABLE ds_proposals (
    id VARCHAR(85) PRIMARY KEY,            -- {dao_address}-{proposal_number}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    proposal_number INTEGER NOT NULL,
    submitter VARCHAR(42) NOT NULL,
    sponsor VARCHAR(42),
    proposal_data_hash VARCHAR(66),        -- bytes32 hex
    proposal_data TEXT,                     -- Raw hex-encoded proposal data
    details TEXT,                           -- JSON or IPFS CID

    -- Timing
    voting_period INTEGER,
    voting_starts TIMESTAMPTZ,
    voting_ends TIMESTAMPTZ,
    grace_ends TIMESTAMPTZ,
    expiration TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,

    -- Vote tallies
    yes_votes INTEGER DEFAULT 0,           -- Headcount
    no_votes INTEGER DEFAULT 0,
    yes_balance NUMERIC(78,0) DEFAULT '0', -- Share-weighted
    no_balance NUMERIC(78,0) DEFAULT '0',

    -- Status
    self_sponsored BOOLEAN DEFAULT FALSE,
    cancelled BOOLEAN DEFAULT FALSE,
    processed BOOLEAN DEFAULT FALSE,
    passed BOOLEAN DEFAULT FALSE,
    action_failed BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Individual votes
CREATE TABLE ds_votes (
    id VARCHAR(128) PRIMARY KEY,           -- {proposal_id}-{voter_address}
    proposal_id VARCHAR(85) REFERENCES ds_proposals(id),
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    voter VARCHAR(42) NOT NULL,
    approved BOOLEAN NOT NULL,
    balance NUMERIC(78,0) NOT NULL,        -- Voting power used
    created_at TIMESTAMPTZ
);

-- Navigators (shamans)
CREATE TABLE ds_navigators (
    id VARCHAR(85) PRIMARY KEY,            -- {dao_address}-{navigator_address}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    deployer VARCHAR(42),                  -- From INavigator.deployer() or NavigatorDeployed event (null for legacy navigators)
    permission INTEGER NOT NULL,           -- Bitmask: 1=ADMIN, 2=MANAGER, 4=GOVERNOR (valid: 0-7)
    permission_ever_granted BOOLEAN DEFAULT FALSE, -- TRUE once any NavigatorSet(>0) seen; separates revoked (TRUE) from read-only/never-registered (FALSE)
    trust_status VARCHAR(16) DEFAULT 'self_asserted', -- read-only DAO-binding trust: 'sanctioned'|'self_asserted'|'unsanctioned'|'fabricated' (permissioned navs are vouched by NavigatorSet → 'sanctioned')
    is_active BOOLEAN DEFAULT TRUE,        -- functional now? read-only stays TRUE at permission 0; FALSE on revoke. NOT a proxy for "has permission"
    navigator_type VARCHAR(50),            -- 'OnboarderNavigator', 'ERC20TributeNavigator', 'NFTGatedNavigator', 'SignalNavigator', 'TimelockNavigator', 'VestingNavigator', 'unknown'
    paused BOOLEAN DEFAULT FALSE,

    -- Metadata (from NavigatorDeployed event; legacy navigators: navigatorType() RPC only)
    name VARCHAR(255),
    description TEXT,
    config JSONB,

    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(dao_id, navigator_address)
);

-- Ragequit records
CREATE TABLE ds_ragequits (
    id SERIAL PRIMARY KEY,
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    member_address VARCHAR(42) NOT NULL,
    to_address VARCHAR(42) NOT NULL,
    shares_burned NUMERIC(78,0) DEFAULT '0',
    loot_burned NUMERIC(78,0) DEFAULT '0',
    tokens TEXT[],                          -- Array of token addresses
    amounts TEXT[],                         -- Parallel array of amounts (as strings)
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);

-- Guild tokens
CREATE TABLE ds_guild_tokens (
    id VARCHAR(85) PRIMARY KEY,            -- {dao_address}-{token_address}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    token_address VARCHAR(42) NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(dao_id, token_address)
);

-- Delegation history
CREATE TABLE ds_delegations (
    id SERIAL PRIMARY KEY,
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    delegator VARCHAR(42) NOT NULL,
    from_delegate VARCHAR(42),
    to_delegate VARCHAR(42),
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);

-- Navigator events (onboard, pause, unpause)
CREATE TABLE ds_navigator_events (
    id SERIAL PRIMARY KEY,
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    event_type VARCHAR(20) NOT NULL,       -- 'onboard', 'paused', 'unpaused'
    contributor VARCHAR(42),
    amount NUMERIC(78,0),                  -- Tribute amount (QUAI or ERC20)
    shares_minted NUMERIC(78,0),
    loot_minted NUMERIC(78,0),
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);

-- Poster records (off-chain metadata)
CREATE TABLE ds_records (
    id SERIAL PRIMARY KEY,
    user_address VARCHAR(42) NOT NULL,
    tag VARCHAR(255),
    content TEXT,
    content_json JSONB,                    -- Parsed JSON if content is valid JSON
    dao_id VARCHAR(42),                    -- Extracted from content if present
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);

-- Indexer state tracking
CREATE TABLE ds_indexer_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_block_number BIGINT DEFAULT 0,
    last_block_hash VARCHAR(66),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Processed logs (idempotency)
CREATE TABLE ds_processed_logs (
    log_id VARCHAR(130) PRIMARY KEY,       -- {tx_hash}-{log_index}
    processed_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Handler Mapping

### Topic0 → Handler

The indexer routes events by `topic0` (the event signature hash). Here's the complete mapping:

```typescript
const HANDLERS: Record<string, { name: string; handler: EventHandler }> = {
  // Launcher events
  [id("LaunchDAOShip(address,address,address,address,address)")]:
    { name: "LaunchDAOShip", handler: handleLaunchDAOShip },
  [id("LaunchDAOShipAndVault(address,address,address,address,bool,address)")]:
    { name: "LaunchDAOShipAndVault", handler: handleLaunchDAOShipAndVault },

  // DAOShip governance events
  [id("SetupComplete(bool,bool,uint32,uint32,uint256,uint256,uint256,uint256,uint32,string,string,string,string,address[],uint256,uint256)")]:
    { name: "SetupComplete", handler: handleSetupComplete },
  [id("SubmitProposal(uint256,bytes32,address,uint256,bytes,uint256,bool,uint256,string,uint256)")]:
    { name: "SubmitProposal", handler: handleSubmitProposal },
  [id("SponsorProposal(address,uint256,uint256,uint256,uint256,uint256,uint256)")]:
    { name: "SponsorProposal", handler: handleSponsorProposal },
  [id("SubmitVote(address,uint256,uint256,bool)")]:
    { name: "SubmitVote", handler: handleSubmitVote },
  [id("ProcessProposal(uint256,bool,bool,address)")]:
    { name: "ProcessProposal", handler: handleProcessProposal },
  [id("CancelProposal(uint256,address)")]:
    { name: "CancelProposal", handler: handleCancelProposal },
  [id("Ragequit(address,address,uint256,uint256,address[],uint256[])")]:
    { name: "Ragequit", handler: handleRagequit },
  [id("NavigatorSet(address,uint256)")]:
    { name: "NavigatorSet", handler: handleNavigatorSet },
  [id("GovernanceConfigSet(uint32,uint32,uint256,uint256,uint256,uint256,uint32)")]:
    { name: "GovernanceConfigSet", handler: handleGovernanceConfigSet },
  [id("SetGuildTokens(address[],bool[])")]:
    { name: "SetGuildTokens", handler: handleSetGuildTokens },
  [id("MintShares(address[],uint256[])")]:
    { name: "MintShares", handler: handleMintShares },
  [id("MintLoot(address[],uint256[])")]:
    { name: "MintLoot", handler: handleMintLoot },
  [id("BurnShares(address[],uint256[])")]:
    { name: "BurnShares", handler: handleBurnShares },
  [id("BurnLoot(address[],uint256[])")]:
    { name: "BurnLoot", handler: handleBurnLoot },
  [id("ConvertSharesToLoot(address,uint256)")]:
    { name: "ConvertSharesToLoot", handler: handleConvertSharesToLoot },
  [id("AdminConfigSet(bool,bool)")]:
    { name: "AdminConfigSet", handler: handleAdminConfigSet },
  [id("LockAdmin(bool)")]:
    { name: "LockAdmin", handler: handleLockAdmin },
  [id("LockManager(bool)")]:
    { name: "LockManager", handler: handleLockManager },
  [id("LockGovernor(bool)")]:
    { name: "LockGovernor", handler: handleLockGovernor },

  // Token events
  [id("Transfer(address,address,uint256)")]:
    { name: "Transfer", handler: handleTransfer },
  [id("DelegateChanged(address,address,address)")]:
    { name: "DelegateChanged", handler: handleDelegateChanged },
  [id("DelegateVotesChanged(address,uint256,uint256)")]:
    { name: "DelegateVotesChanged", handler: handleDelegateVotesChanged },

  // Navigator events
  [id("NavigatorDeployed(address,address,string,string,string)")]:
    { name: "NavigatorDeployed", handler: handleNavigatorDeployed },
  [id("Onboard(address,address,uint256,uint256,uint256)")]:
    { name: "Onboard", handler: handleOnboard },
  [id("NFTClaimed(address,address,uint256,uint256,uint256)")]:
    { name: "NFTClaimed", handler: handleNFTClaimed },

  // SignalNavigator events (read-only polls; navigator discovered via NavigatorDeployed, never NavigatorSet)
  [id("PollCreated(uint256,address,string,uint8,uint64,uint64,uint64)")]:
    { name: "PollCreated", handler: handlePollCreated },
  [id("Voted(uint256,address,uint8,uint256)")]:
    { name: "Voted", handler: handleVoted },
  [id("PollCancelled(uint256,address)")]:
    { name: "PollCancelled", handler: handlePollCancelled },

  // TimelockNavigator events (GOVERNOR; registered via NavigatorSet)
  [id("ChangeQueued(uint256,address,bytes32,bytes,uint64,uint64)")]:
    { name: "ChangeQueued", handler: handleChangeQueued },
  [id("ChangeExecuted(uint256,address,bytes32)")]:
    { name: "ChangeExecuted", handler: handleChangeExecuted },
  [id("ChangeCancelled(uint256,address)")]:
    { name: "ChangeCancelled", handler: handleChangeCancelled },

  // VestingNavigator events (MANAGER; registered via NavigatorSet)
  [id("ScheduleCreated(uint256,address,uint256,uint64,uint64,uint64,bool)")]:
    { name: "ScheduleCreated", handler: handleScheduleCreated },
  [id("TokensClaimed(uint256,address,uint256,bool)")]:
    { name: "TokensClaimed", handler: handleTokensClaimed },
  [id("ScheduleRevoked(uint256,address,uint64,uint256)")]:
    { name: "ScheduleRevoked", handler: handleScheduleRevoked },

  // BudgetNavigator events (no permission; trust from the vault's EnabledModule/DisabledModule)
  [id("BudgetCreated(uint256,address,address,uint256,uint256,uint64,uint64,uint64)")]:
    { name: "BudgetCreated", handler: handleBudgetCreated },
  [id("Disbursed(uint256,address,address,uint256)")]:
    { name: "Disbursed", handler: handleDisbursed },
  [id("ManagerUpdated(uint256,address,address)")]:
    { name: "ManagerUpdated", handler: handleManagerUpdated },
  [id("BudgetCancelled(uint256,address)")]:
    { name: "BudgetCancelled", handler: handleBudgetCancelled },

  // SubscriptionNavigator events (MANAGER; registered via NavigatorSet)
  [id("MemberEnrolled(address,uint256)")]:
    { name: "MemberEnrolled", handler: handleMemberEnrolled },
  [id("FeePaid(address,address,address,uint256,uint256,uint256)")]:
    { name: "FeePaid", handler: handleFeePaid },
  [id("FeeCollected(address,address,uint256,uint256,bool)")]:
    { name: "FeeCollected", handler: handleFeeCollected },

  // Shared across all pausable navigators (Onboarder, ERC20Tribute, NFTGated, Timelock, Vesting, Budget, Subscription)
  [id("Paused(address)")]:
    { name: "Paused", handler: handleNavigatorPaused },
  [id("Unpaused(address)")]:
    { name: "Unpaused", handler: handleNavigatorUnpaused },

  // Poster events
  [id("NewPost(address,string,string)")]:
    { name: "NewPost", handler: handleNewPost },
};
```

**Note on `Onboard` topic collision:** Both `OnboarderNavigator` and `ERC20TributeNavigator` emit `Onboard(address,address,uint256,uint256,uint256)` with the same signature. The handler can distinguish them by checking the emitting contract address against the navigator registry, or by checking the navigator's type stored at registration time.

---

## Renaming Reference (Old → New)

For teams migrating from the Baal-era indexer:

| Old Name | New Name | Context |
|----------|----------|---------|
| `Baal` | `DAOShip` | Core governance contract |
| `BaalSummoner` | `DAOShipLauncher` | Clone factory |
| `BaalAndVaultSummoner` | `DAOShipAndVaultLauncher` | Clone + vault factory |
| `SummonBaal` | `LaunchDAOShip` | Event name |
| `SummonBaalAndVault` | `LaunchDAOShipAndVault` | Event name |
| `ShamanSet` | `NavigatorSet` | Event name |
| `Shaman` | `Navigator` | Plugin/extension concept |
| `qdl_` | `ds_` | Database table prefix |
| `shamans` | `navigators` | Database table |
| `shaman_events` | `navigator_events` | Database table |
| `baalAddress` | `daoShipAddress` | Code variables |
| `daoShip.baal()` | N/A | Navigator lookup — use indexed event field instead |
| `proposalGas` | Removed | No longer in Proposal struct |
| `trustedForwarder` | Removed | No longer in DAOShip |
| `initializationActions` | Removed | No longer in launchers |

---

## Key Behavioral Notes

### Proposal State Machine

Proposals flow through these states. The `state()` view function computes the current state, but the indexer can derive it from events:

```
Submitted → Voting → Grace → Ready → Processed
    │          │                         │
    │          │                    (actionFailed?)
    │          │
    └──────────┴──────→ Cancelled
                        Defeated
                        Expired
```

**State derivation from events:**
- `SubmitProposal` → Submitted (or Voting if `selfSponsor = true`)
- `SponsorProposal` → Voting (votingEnds and graceEnds are provided directly in the event)
- Current time >= `votingEnds` → Grace
- Current time >= `graceEnds` → Ready (if passed) or Defeated (if failed)
- `ProcessProposal` → Processed (check `passed` and `actionFailed`)
- `CancelProposal` → Cancelled
- Current time > `expiration` → Expired

### Balance Tracking Strategy

Every mint/burn operation emits BOTH a DAOShip event (`MintShares`, `BurnShares`, etc.) AND a token `Transfer` event. **Never update the same database column from both handlers** — this causes double-counting.

**Recommended ownership model:**

| Data | Source | Handler | Notes |
|------|--------|---------|-------|
| `ds_members.shares` / `ds_members.loot` | Token `Transfer` events | `handleTransfer` | Covers mints, burns, AND peer-to-peer transfers |
| `ds_daos.total_shares` / `ds_daos.total_loot` | DAOShip events | See matrix below | Only DAOShip handlers touch DAO totals |
| `ds_members.delegating_to` / `ds_members.voting_power` | `DelegateChanged` / `DelegateVotesChanged` | `handleDelegateChanged` / `handleDelegateVotesChanged` | SharesERC20 only |
| Activity feed (who minted, context) | DAOShip Mint/Burn events | Store in activity log table | |

**DAO totals ownership per event:**

| Contract Action | DAOShip Event | Token Events | `handleTransfer` updates | DAOShip handler updates |
|-----------------|---------------|--------------|--------------------------|-------------------------|
| `mintShares` | `MintShares` | `Transfer(0→member)` | `ds_members.shares` only | `ds_daos.total_shares` only |
| `burnShares` | `BurnShares` | `Transfer(member→0)` | `ds_members.shares` only | `ds_daos.total_shares` only |
| `mintLoot` | `MintLoot` | `Transfer(0→member)` | `ds_members.loot` only | `ds_daos.total_loot` only |
| `burnLoot` | `BurnLoot` | `Transfer(member→0)` | `ds_members.loot` only | `ds_daos.total_loot` only |
| `convertSharesToLoot` | `ConvertSharesToLoot` | `Transfer(member→0)` shares + `Transfer(0→member)` loot | `ds_members.shares` AND `ds_members.loot` | `ds_daos.total_shares` AND `ds_daos.total_loot` |
| `ragequit` | `Ragequit` | `Transfer(member→0)` shares + `Transfer(member→0)` loot | `ds_members.shares` AND `ds_members.loot` | DAO totals via `Ragequit` handler (`totalShares -=`, `totalLoot -=`) |
| `setUp` (initial mint) | *(no MintShares/MintLoot)* | `Transfer(0→member)` | `ds_members.shares` AND `ds_members.loot` | Use `SetupComplete` event for initial `total_shares` / `total_loot` |
| Peer-to-peer transfer | *(none)* | `Transfer(member→member)` | `ds_members.shares` or `ds_members.loot` | *(no DAO total change)* |

**Known pitfall — `convertSharesToLoot`:** This calls `sharesToken.burn()` then `lootToken.mint()`, which emit Transfer events. But it does NOT emit `BurnShares` or `MintLoot`. The `ConvertSharesToLoot` handler must update DAO totals (`total_shares -= amount`, `total_loot += amount`) but must NOT update member balances — the two Transfer events handle that. The old indexer's `handleConvertSharesToLoot` updated member balances too, causing double-counting.

**Known pitfall — `ragequit`:** Ragequit calls `sharesToken.burn()` and `lootToken.burn()`, which emit Transfer events. But it does NOT emit `BurnShares` or `BurnLoot`. The `Ragequit` handler must update DAO totals but must NOT update member balances.

**Known pitfall — `setUp` initial minting:** The initial member minting during `setUp` calls `sharesToken.mint()` and `lootToken.mint()`, which emit Transfer events. But setUp does NOT emit `MintShares` or `MintLoot` events. Use `SetupComplete` for initial DAO totals, and let Transfer events handle member balances.

**Critical rule:** The `handleTransfer` handler must distinguish the emitting token (shares vs loot) by checking the contract address against the DAO's registered `shares_address` / `loot_address`.

### Proposal Offering

Non-sponsor proposals include a QUAI payment (`msg.value`) that is forwarded to the vault. There is no dedicated offering event — the payment is visible in:
- The transaction's `msg.value` field
- A native QUAI transfer to the vault address in the internal transaction trace

Self-sponsors (members with shares >= `sponsorThreshold`) are exempt and must send `msg.value = 0`. The `proposalOffering` amount is stored in the DAO's governance config (`ds_daos.proposal_offering`).

### Navigator Discovery

DAOs can launch with zero, one, or many navigators — there is no requirement to include navigators at launch. Navigators can be added or removed at any time via governance proposals.

Navigator discovery uses two complementary event sources:

1. **`NavigatorDeployed` events** (emitted by navigator contracts at deploy time) — provide metadata (name, description, deployer, type) before the navigator is even registered with a DAO. The indexer should subscribe to these globally (unfiltered topic0 scan).
2. **`NavigatorSet` events** (emitted by DAOShip contracts) — provide the DAO association and permission bitmask. These are emitted during `setUp()` (initial navigators) and `setNavigators()` (post-launch changes).

When `NavigatorDeployed` fires, the indexer should:
1. Store the deployer, navigatorType, name, and description keyed by the emitting contract address
2. If a `NavigatorSet` has already been processed for this address, update `ds_navigators` with the metadata
3. If no `NavigatorSet` has been seen yet, hold the metadata until one arrives

When `NavigatorSet` fires with `permission > 0`, the indexer should:
1. Register the navigator address for event monitoring
2. The DAO association is implicit — the emitting contract IS the DAOShip that owns this navigator
3. If a `NavigatorDeployed` event was already processed for this address, populate metadata from it
4. Otherwise, call `navigator.navigatorType()` to get the type string (one RPC call, cache forever) and call `navigator.deployer()` to get the deployer address
4. Start fetching `Onboard`/`Paused`/`Unpaused` events from the navigator address

When `NavigatorSet` fires with `permission == 0`, the navigator is revoked. Mark it as inactive. Continue monitoring for historical data if desired, but no new onboarding events will be emitted (the navigator's functions check permissions on every call).

#### Permissionless (read-only) navigators

Some navigators hold **no permission and never register via `setNavigators()`**, so they emit **no `NavigatorSet` event at all** — `SignalNavigator` (non-binding polls) is the first of these. They read voting power from DAOShip but never mutate it, so they need no permission grant to function.

For these, the **`NavigatorDeployed` event is the only discovery signal — and it is sufficient.** It carries the indexed `daoShip` (DAO association), `deployer`, `navigatorType`, `name`, and `description`. Handle it as follows:

1. On `NavigatorDeployed`, create the `ds_navigators` row immediately, using the event's `daoShip` for the DAO association. Do **not** wait for a `NavigatorSet` that will never arrive.
2. Route by `navigatorType`: if it is a known permissionless type (`"SignalNavigator"`), start fetching that navigator's own events right away (`PollCreated` / `Voted` / `PollCancelled`).
3. Set `permission = 0` and `is_active = TRUE`. Here `permission == 0` means "read-only," **not** "revoked" — distinguish it from a `NavigatorSet(addr, 0)` revocation, which sets `is_active = FALSE`.

**Pitfall:** an indexer that registers navigator addresses for event monitoring *only* inside `handleNavigatorSet` will index zero polls — a SignalNavigator address never passes through that handler. Drive monitoring off `NavigatorDeployed` with type-based routing, not off `NavigatorSet` alone.

#### Navigator lifecycle & pruning

`permission = 0` is overloaded — three distinct lifecycle states collapse onto it. Pruning must key off *which* state, not off the value `0` (and not off `dao_id IS NULL`, which no longer occurs once `dao_id` is bound from `NavigatorDeployed`).

The discriminator is **`permission_ever_granted`**: set it TRUE the first time a `NavigatorSet(addr, > 0)` from a known DAOShip is processed for the address. With that one bit, plus `navigator_type` and whether `daoShip` resolves to a known DAO:

| State | `permission_ever_granted` | `NavigatorSet` history | `is_active` | Prune? |
|-------|---------------------------|------------------------|-------------|--------|
| Read-only (e.g. SignalNavigator) | false | none, ever | true | **Never** |
| Never-registered, known DAO | false | none, ever | false | Never (keep inert) |
| Never-registered, unknown DAO | false | none, ever | false | Yes — at chain head only |
| Active permissioned | true | last set `> 0` | true | Never |
| Revoked | true | `> 0` then `0` | false | **Never** (keep history) |

**Never-registered, non-read-only.** A permissioned navigator (Onboarder / ERC20Tribute / NFTGated) can be deployed and bound to a DAO via `NavigatorDeployed` yet never granted permission — the `setNavigators()` proposal never passed, or is still in flight. With `permission = 0` it is inert: its mutating calls into DAOShip revert, so it emits no `Onboard` / `NFTClaimed` and produces no data. "Abandoned" and "governance pending" are indistinguishable on-chain, and a proposal can land arbitrarily long after deploy — so do **not** run a deploy-age timer. Two outcomes:
- `daoShip` resolves to a known DAO → keep as `is_active = false` ("deployed, unregistered"). It's cheap, harmless, and **self-heals**: if the proposal later passes, `handleNavigatorSet`'s RPC fallback (`navigatorType()` / `deployer()`) re-hydrates it from scratch. Pruning gains almost nothing and risks deleting a pending navigator.
- `daoShip` does NOT resolve to a known DAO → genuine orphan (spam against a junk address, or a deploy that raced ahead of DAO discovery). Prune it.

**Revoked (lost permission).** A `NavigatorSet(addr, > 0)` later followed by `NavigatorSet(addr, 0)`. Never prune — it was DAO-authorized, almost certainly minted or onboarded, and the row is the only durable record. Revocation is a status change: `is_active = false`, `permission = 0`, history intact. `permission_ever_granted = true` is exactly what separates this from a born-at-0 read-only navigator (both sit at `permission = 0`).

**Prune predicate** — the only rows safe to delete:

```
permission_ever_granted = false
  AND navigator_type NOT IN (<read-only types>)   -- never reap read-only
  AND daoShip does NOT resolve to a known ds_daos row
  AND no events have ever been indexed from the address
  AND the indexer is caught up to chain head        -- never prune mid-backfill
```

The chain-head guard is critical: a navigator whose DAO simply hasn't been ingested yet is indistinguishable from an orphan until you reach head.

#### Protecting DAOs from spam read-only navigators

Read-only navigators are the one case where the DAO association is **self-asserted, not DAO-authorized**. `NavigatorDeployed` is permissionless: anyone can deploy a contract whose constructor emits `NavigatorDeployed(victimDAO, attacker, "SignalNavigator", …)`, and the unfiltered topic0 scan picks it up. There is no `NavigatorSet` from the DAO to vouch for it — that absence is the whole point of a read-only navigator. So a naive indexer that binds `dao_id` from the event and materializes every `PollCreated` / `Voted` lets anyone inject polls into any DAO's feed.

Two spam classes, defended differently:

- **Real-but-unsanctioned** — genuine SignalNavigator bytecode, really pointed at the DAO (it *does* call `daoShip.getPriorVotes`), so the weights are real, but the DAO never endorsed this instance. Recomputing weights does **not** catch it (they reconcile). Caught only by sanctioning.
- **Fabricated** — a mimic that emits the same event signatures without reading the DAO. `Voted.weight` is invented; `Voted` can name addresses that never voted. Caught only by recomputing weights against the DAO's own checkpoints.

This is a **trust/curation problem, not garbage collection** — you cannot delete your way out of permissionless self-association. Defense is layered, cheap → strong; record the verdict in `ds_navigators.trust_status`:

1. **Resolution gate.** Ignore any read-only `NavigatorDeployed` whose `daoShip` does not resolve to a known DAO. Stops spam pointed at non-DAO addresses; does nothing against spam aimed at a real DAO.
2. **Identity probe** (one cached RPC pair). Call `navigator.daoShip()` and `navigator.navigatorType()`; both must agree with the event. Defeats lazy mimics that fake the topic but not the getters. A sophisticated mimic implements both — so this is necessary, not sufficient.
3. **Sanctioning — the authoritative "DAO authorized it" signal.** The DAO's vault publishes which read-only navigators it blesses via a vault-signed Poster post under the **`daoships.dao.navigators`** tag (full schema in [POSTER.md](POSTER.md#dao-sanctioned-navigators-daoshipsdaonavigators); handler spec below). Gated on `msg.sender == vault`, so it is unforgeable and grants no on-chain permission. Matched → `trust_status = 'sanctioned'`. This needs no on-chain registration, preserving the navigator's permissionlessness while giving the DAO control. Unmatched read-only navigators default to `'self_asserted'`.
4. **Weight reconciliation — the authoritative "numbers aren't fabricated" signal.** For a self-asserted navigator, recompute `getPriorVotes(voter, snapshotTimestamp)` on the claimed DAO for the first poll's votes (or a sample). All match → weights are real (raise confidence); any mismatch → `trust_status = 'fabricated'`, suppress the navigator. The DAO's checkpoint system is ground truth; this is the only check that definitively unmasks fabricated navigators. It is archive-RPC-heavy, so run it lazily / sampled, never on the hot path.
5. **Presentation policy.** The feed surfaces `'sanctioned'` polls by default; `'self_asserted'` behind a "show unverified polls" toggle or a warning badge; `'fabricated'` / `'unsanctioned'` hidden. The indexer's job is to label correctly; the frontend's job is to default to the safe view.

**Bounding volumetric spam.** You still *see* every event (the scan is unfiltered), but you need not *materialize* every one. Defer writing `ds_signal_polls` / `ds_signal_votes` for navigators that are neither `sanctioned` nor weight-reconciled — or require at least one reconciled vote before materializing a navigator's poll history — so a flood of fabricated navigators against one DAO cannot bloat the poll tables.

##### Handler action — `daoships.dao.navigators` (sanction list)

This post is the only thing that flips a read-only navigator to `'sanctioned'`. It is a `NewPost` like any other — route it through `handleNewPost` by tag.

1. **Trust gate (mandatory).** Verify `msg.sender == ds_daos.avatar` for the `daoAddress` in the content. If it does not match the vault, **discard** — a non-vault `daoships.dao.navigators` post is spam (same rule as `dao.profile`). Validate content ≤ 16 KB, JSON parses, addresses are valid hex.
2. **Full-set, last-write-wins.** The `navigators` array is the DAO's *complete* sanctioned set as of this post — not a delta. Dedup key: vault + tag + `daoAddress`. Compute the transition against the previously-sanctioned set for this DAO:
   - **address newly present** AND it resolves to a read-only navigator bound to this DAO → `trust_status = 'sanctioned'`.
   - **address previously sanctioned, now absent** → `trust_status = 'unsanctioned'` (revoked).
   - empty array → de-sanction all read-only navigators for the DAO.
3. **Scoping guard.** Apply a sanction only to an address whose `NavigatorDeployed.daoShip == daoAddress` and whose `navigator_type` is a read-only type. Silently ignore listed addresses that point at a different DAO, are permissioned (already vouched by `NavigatorSet`), or are unknown contract types. A vault can only sanction *its own* read-only navigators.
4. **Ordering hold.** If a listed address has no `ds_navigators` row yet (the sanction post was processed before that navigator's `NavigatorDeployed`), persist the intent keyed by `(daoAddress, address)` and apply it when `NavigatorDeployed` later creates the row — mirror the existing hold-until-discovered pattern for navigator metadata.
5. **Materialize on flip to `'sanctioned'`.** Because of the volumetric-spam bound above, a freshly-sanctioned navigator's polls may have been *seen but not materialized*. On the `→ sanctioned` transition, backfill its `PollCreated` / `Voted` / `PollCancelled` into `ds_signal_polls` / `ds_signal_votes` (replay from `ds_processed_logs` or re-fetch by address). This is the step indexer devs most often miss — sanctioning must trigger backfill, not just toggle a column.
6. **Hide (don't delete) on flip to `'unsanctioned'`.** Keep the rows for audit; exclude them from default feeds by `trust_status`. De-sanction is reversible — a later post can re-add the address.

**State transitions for a read-only navigator's `trust_status`:**

| From | Event | To |
|------|-------|-----|
| (new row) | `NavigatorDeployed`, `daoShip` resolves to known DAO | `self_asserted` |
| `self_asserted` | listed in vault `daoships.dao.navigators` | `sanctioned` |
| `self_asserted` / `sanctioned` | weight reconciliation fails (fabricated weights) | `fabricated` (terminal; suppress) |
| `sanctioned` | absent from a later vault `daoships.dao.navigators` | `unsanctioned` |
| `unsanctioned` | listed again in a later vault post | `sanctioned` |

Permissioned navigators never enter this machine — they are `'sanctioned'` by virtue of `NavigatorSet`, and `daoships.dao.navigators` does not apply to them.

### Navigator Type and Metadata Discovery

All DAO Ships navigators implement `INavigator` and expose both a `navigatorType` public constant and a `deployer` immutable:

```solidity
string public constant navigatorType = "OnboarderNavigator";  // or "ERC20TributeNavigator", etc.
address public immutable deployer;
```

**Primary path (recommended):** The `NavigatorDeployed` event emitted at construction time contains `navigatorType`, `deployer`, `name`, and `description`. If the indexer has already captured this event, no RPC calls are needed.

**Fallback path:** If the `NavigatorDeployed` event was missed (e.g., navigator deployed before the indexer started), the indexer calls `navigatorType()` and `deployer()` via RPC when the navigator is first discovered (on `NavigatorSet` with `permission > 0`) and caches the results. Both are immutable/constant and never change.

```typescript
// In handleNavigatorSet, when permission > 0 and no NavigatorDeployed event cached:
const navigatorContract = new ethers.Contract(navigatorAddress, [
  "function navigatorType() view returns (string)",
  "function deployer() view returns (address)"
], provider);
try {
  const [type, deployer] = await Promise.all([
    navigatorContract.navigatorType(),
    navigatorContract.deployer()
  ]);
  // Store in ds_navigators.navigator_type and ds_navigators.deployer
} catch {
  // Unknown navigator type (third-party or legacy contract without INavigator)
  // Store type as "unknown", deployer as null
}
```

Known types:
- `"OnboarderNavigator"` — native QUAI tribute onboarding
- `"ERC20TributeNavigator"` — ERC20 tribute onboarding
- `"NFTGatedNavigator"` — ERC-721-gated onboarding (one claim per tokenId)
- `"SignalNavigator"` — non-binding share-weighted polls; **no permission, never registered via `NavigatorSet`** (discovered from `NavigatorDeployed` only)
- Future navigators will follow the same pattern

**`NavigatorDeployed` vs `navigatorType()` view function:** The `NavigatorDeployed` event provides richer data (name, description) in addition to the type and deployer. The `navigatorType()` view function remains useful as a fallback and for legacy navigators. Both sources are equally authoritative for the type string.

**No on-chain lookup for DAO association.** The old indexer called `navigator.baal()` to associate navigators with DAOs. This is no longer necessary — the `NavigatorSet` event is emitted by the DAOShip contract, and the navigator `Onboard` event now includes `daoShipAddress` as an indexed field.

### Poster Trust Model

See [docs/POSTER.md](POSTER.md) for full details. Key rule: trust `daoships.dao.profile` only when `msg.sender` matches the DAO's avatar (vault) address. Trust `daoships.dao.profile.initial` when `msg.sender` matches the `launcher` field from the `LaunchDAOShip` event.

---

## Contract ABIs

The indexer needs ABIs for event decoding. Source them from:

```
artifacts/contracts/core/DAOShip.sol/DAOShip.json
artifacts/contracts/core/DAOShipLauncher.sol/DAOShipLauncher.json
artifacts/contracts/core/DAOShipAndVaultLauncher.sol/DAOShipAndVaultLauncher.json
artifacts/contracts/tokens/SharesERC20.sol/SharesERC20.json
artifacts/contracts/tokens/LootERC20.sol/LootERC20.json
artifacts/contracts/navigators/OnboarderNavigator.sol/OnboarderNavigator.json
artifacts/contracts/navigators/ERC20TributeNavigator.sol/ERC20TributeNavigator.json
artifacts/contracts/navigators/NFTGatedNavigator.sol/NFTGatedNavigator.json
artifacts/contracts/navigators/SignalNavigator.sol/SignalNavigator.json
artifacts/contracts/tools/Poster.sol/Poster.json
```

Only the `abi` field is needed from each artifact — the indexer doesn't deploy contracts.

---

## Deployed Contract Addresses

Read from `deployment-addresses.json` in the contracts repo:

```json
{
  "network": "cyprus1",
  "contracts": {
    "Poster": "0x...",
    "SharesERC20Singleton": "0x...",
    "LootERC20Singleton": "0x...",
    "DAOShipSingleton": "0x...",
    "DAOShipLauncher": "0x...",
    "DAOShipAndVaultLauncher": "0x..."
  }
}
```

The indexer monitors `DAOShipLauncher` and `DAOShipAndVaultLauncher` for launch events, and `Poster` for metadata. Individual DAOShip clones, token clones, and navigator addresses are discovered dynamically from events.

---

## Contract Changes Log (SSSES Audits v4-v8)

**No ABI-breaking changes across all audit rounds.** All existing event signatures, function selectors, and return types are preserved. This section documents behavioral changes and new features the indexer team should be aware of.

### Indexer Action Required

| Change | Impact | What to do |
|--------|--------|------------|
| **New: SignalNavigator (read-only polls)** | New navigator type emitting `PollCreated` / `Voted` / `PollCancelled`. Holds **no permission**, so it **never fires `NavigatorSet`** — an indexer that registers navigators only from `NavigatorSet` will index zero polls. | Discover it from `NavigatorDeployed` and route monitoring by `navigatorType` (see [Permissionless (read-only) navigators](#permissionless-read-only-navigators)). Add the three topic0 handlers and the `ds_signal_polls` / `ds_signal_votes` tables. Loot is excluded from tallies — `weight` is share power at `votingStarts - 1`. |
| **New: NFTGatedNavigator** | New navigator type emitting the standard `Onboard` **plus** `NFTClaimed(address,address,uint256,uint256,uint256)`. Registered normally via `NavigatorSet`. | Add the `NFTClaimed` topic0 handler and `ds_nft_claims` table (see §4). No change to the generic `Onboard` path. |
| **New: BudgetNavigator (treasury budgets)** | New navigator type emitting `BudgetCreated` / `Disbursed` / `ManagerUpdated` / `BudgetCancelled`. Holds **no DAOShip permission** (never fires `NavigatorSet`) but is **not read-only** — its authority is **vault module status**, signalled by the vault's `EnabledModule` event, not by `NavigatorSet` or Poster sanctioning. | Discover from `NavigatorDeployed`; **additionally watch the DAO's vault for `EnabledModule` / `DisabledModule`** to drive `trust_status`/`is_active`. Add the four topic0 handlers and the `ds_budgets` / `ds_budget_disbursements` tables (see §4). |
| **`state()` now returns Expired for unsponsored expired proposals (v6)** | Previously, an unsponsored proposal past its explicit expiration returned `Submitted (1)`. Now correctly returns `Expired (8)`. | If the indexer calls `state()` to display proposal status, expired unsponsored proposals will now show as Expired instead of Submitted. No code change needed unless the indexer had a workaround for the old behavior. |
| **Defeated proposals require empty calldata (v6)** | `processProposal(id, proposalData)` now reverts with `HashMismatch()` if `proposalData` is non-empty for a Defeated proposal. Previously accepted any data. | If the indexer or a keeper bot calls `processProposal` to close defeated proposals, pass `"0x"` (empty bytes) as `proposalData`. Non-empty data will revert. |
| **OOG grief protection (v5)** | If `processProposal` catches an OOG revert and `gasleft() < 50,000`, the entire transaction reverts with `InsufficientProcessGas()` instead of marking `actionFailed=true`. The proposal stays in Ready state. | If the indexer monitors for failed `processProposal` transactions, distinguish `InsufficientProcessGas` (proposal still Ready, can be retried with more gas) from `actionFailed=true` in `ProcessProposal` event (proposal permanently consumed). |

### No Action Required (internal refactoring, no indexer impact)

| Change | Audit | Description |
|--------|-------|-------------|
| Ragequit balance snapshot | v4 H-1 | Guild token balances snapshotted before transfers. `Ragequit` event unchanged. |
| Token singleton bricking | v4 H-2 | Singleton constructors renounce ownership. Clones behave identically. |
| setUp navigator cap | v4 M-1 | setUp rejects > 20 navigators. `NavigatorSet` events unchanged. |
| Post-execution module check | v4 M-7 | processProposal reverts if proposal removes DAOShip as vault module. `ProcessProposal` event unchanged. |
| Proposal struct reorder + statusFlags | v7 L-3/L-4 | Internal storage layout change. `getProposalStatus()` still returns `bool[4]` with identical semantics. |
| Dead code removal | v7 L-5/L-6 | Removed unreachable checks. No behavioral change. |
| Loop gas optimization | v7 L-1/L-2 | totalShares/totalLoot cached in memory. Final values identical. |
| BaseNavigator extraction | v7 L-11 | Shared logic extracted to abstract base. Event signatures unchanged. |
| DAOShipPermit extraction | v7 L-12 | Shared permit logic extracted. `permit()` signature unchanged. |
| OnboarderNavigator calldata refactor | v7 L-7 | `onboard(bytes32[])` parameter `memory` → `calldata`. ABI selector unchanged. |
| withdrawStuckETH nonReentrant | v7 L-8 | Added reentrancy guard. |
| withdrawStuckETH emits event | navigators | New `StuckETHRecovered(address indexed to, uint256 amount)` on OnboarderNavigator. Optional to index (treasury-recovery activity only). |
| withdrawStuckTokens nonReentrant | v6 | Added reentrancy guard to ERC20TributeNavigator. |
| withdrawStuckTokens emits event | navigators | New `StuckTokensRecovered(address indexed token, address indexed to, uint256 amount)` on ERC20TributeNavigator. Optional to index. |
| OnboarderNavigator receive() nonReentrant | v5 C-1 | Added reentrancy guard to `receive()`. No event changes. |
| getPriorVotes bounds check | v7 L-9 | Reverts with `TimepointOverflow()` for timepoints > uint40 max. |
| Vault code-size check | v7 L-10 | `launchDAOShipWithVault` rejects EOA vault addresses. |
| delegate(address(0)) blocked | v8 | `delegate(address(0))` reverts with `InvalidDelegatee()`. Self-delegate to "undelegate." |
| Bitwise parentheses | v8 | `(flags & CONSTANT) != 0` — readability only, no behavioral change. |
| ADMIN NatSpec corrected | v8 | ADMIN permission description corrected to "pause/unpause tokens" only. |

### New Custom Errors (v4-v8)

These errors may appear in failed transaction revert data. Update error decoding if the indexer surfaces revert reasons:

| Error | Contract | Audit | Condition |
|-------|----------|-------|-----------|
| `TooManyGuildTokens()` | DAOShip | v4 | setUp or setGuildTokens exceeds MAX_GUILD_TOKENS (20) |
| `TooManyNavigators()` | DAOShip | v4 | setUp exceeds MAX_NAVIGATORS_PER_CALL (20) |
| `TimepointOverflow()` | DAOShipVotes | v7 | getPriorVotes/getPastTotalSupply with timepoint > uint40 max |
| `NotAllowlisted()` | OnboarderNavigator | v4 | Plain ETH send to allowlisted navigator via receive() |
| `InsufficientProcessGas()` | DAOShip | v5 | processProposal caught OOG with gasleft < 50,000 — proposal stays Ready |
| `InvalidDelegatee()` | DAOShipVotes | v8 | delegate(address(0)) — use self-delegation instead |

### `proposalDataHash` Encoding

`proposalDataHash` in the `SubmitProposal` event is `keccak256(abi.encode(proposalData))`, NOT `keccak256(proposalData)`. The `abi.encode` wrapper adds a 32-byte offset and length prefix. Off-chain hash verification must use:

```typescript
const hash = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes"], [proposalData]));
```
