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

Emitted by navigator contracts (OnboarderNavigator, ERC20TributeNavigator). All navigators implement `INavigator` and emit `NavigatorDeployed` at construction time.

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
- `daoShip` identifies which DAO this navigator belongs to
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

**Note:** Both `onboard()` and `onboardWithPermit()` emit the same `Onboard` event. The indexer does not need to distinguish between the two entry points -- the event signature and handler logic are identical regardless of whether the user used standard approve or ERC-2612 permit.

**Note:** `daoShipAddress` is new. The old indexer had to do an on-chain `baal()` lookup to associate onboarding events with a DAO.

#### `Paused` / `Unpaused` (Both navigators)

```solidity
event Paused(address indexed caller);
event Unpaused(address indexed caller);
```

**Handler action:**
- Update navigator status (paused/active)
- `caller` is the address that triggered the pause/unpause

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

**Tag-based routing (6 tags total — see [POSTER.md](POSTER.md) for full schemas):**

| Tag | Action | Trust Check |
|-----|--------|-------------|
| `daoships.dao.profile.initial` | Create DAO metadata | `msg.sender` == deployer from launch event |
| `daoships.dao.profile` | Create/update DAO metadata (invalidates initial) | `msg.sender` == vault address |
| `daoships.dao.announcement` | Store as DAO announcement | `msg.sender` == vault address |
| `daoships.member.profile` | Create/update member metadata | `msg.sender` has shares > 0 |
| `daoships.proposal.vote.reason` | Associate with vote record (one per voter per proposal) | `msg.sender` matches voter in SubmitVote |
| `daoships.navigator.allowlist` | Store Merkle tree for navigator allowlist proof generation | `msg.sender` has shares > 0 (MEMBER trust) |

**IMPORTANT:** Never index a post based on tag alone. Always verify `msg.sender` against the trust model before writing to the database. Discard posts where content exceeds 16 KB.

**Schema versioning:** All Poster content includes `schemaVersion`. Content without it is treated as version `0.0`.

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

    -- Metadata (from Poster)
    name VARCHAR(255),
    description TEXT,
    avatar_img TEXT,                        -- IPFS CID or URL

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
    is_active BOOLEAN DEFAULT TRUE,        -- FALSE when permission set to 0
    navigator_type VARCHAR(50),            -- 'OnboarderNavigator', 'ERC20TributeNavigator', 'unknown'
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
| withdrawStuckETH nonReentrant | v7 L-8 | Added reentrancy guard. No event changes. |
| withdrawStuckTokens nonReentrant | v6 | Added reentrancy guard to ERC20TributeNavigator. No event changes. |
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
