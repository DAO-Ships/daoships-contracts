# Quai DAO Launcher - Architecture

> Complete MolochDAO V3 (Baal) implementation for Quai Network with Quai Vault integration

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
- [System Architecture](#system-architecture)
- [Contract Hierarchy](#contract-hierarchy)
- [Key Design Decisions](#key-design-decisions)
- [Data Flow](#data-flow)
- [Security Model](#security-model)

## Overview

The Quai DAO Launcher (QDL) is a complete governance framework based on MolochDAO V3 (Baal), adapted for Quai Network. It enables the creation and management of DAOs with:

- **Share-weighted voting** on proposals
- **Treasury management** via Quai Vault (Zodiac-compatible)
- **Flexible membership** with voting shares and non-voting loot
- **Exit mechanism** (ragequit) with proportional asset withdrawal
- **Extensibility** via shamans (privileged contracts)

## Core Concepts

### 1. Baal (DAO Core)

The central governance contract. Named after the Canaanite god, continuing the Moloch naming tradition.

**Responsibilities:**
- Proposal lifecycle management (submit → vote → process)
- Member voting power tracking (ERC20Votes checkpoints)
- Treasury action execution (via IAvatar interface)
- Shaman permission management

**Key Features:**
- Timestamp-based voting (not block numbers) for Quai compatibility
- Dual vote tracking: vote counts AND share-weighted balances
- Proposal hash verification (prevents data manipulation)
- Gas-limited execution (prevents griefing)

### 2. SharesERC20 & LootERC20

**SharesERC20** (Voting Token):
- Extends `ERC20Votes` with checkpoint mechanism
- Auto-delegates to self on first mint
- Pausable by admin shamans
- Only owner (Baal) can mint/burn

**LootERC20** (Non-Voting Token):
- Basic ERC20 without voting power
- Used for economic rights without governance
- Same ownership/pausability as shares
- Counts toward ragequit calculations

**Design Rationale:**
- Separates economic vs governance rights
- Allows contributors without diluting voting power
- Both count for ragequit (fair exit mechanism)

### 3. Factories (Summoners)

**BaalSummoner**:
- Deploys EIP-1167 minimal proxy clones
- 90% gas savings vs full deployment
- Deterministic addresses via CREATE2
- Initializes with encoded parameters

**BaalAndVaultSummoner**:
- Integrates with QuaiVaultFactory
- Creates both DAO and treasury atomically
- Handles vault owner/threshold setup
- Optional: works with existing vaults too

### 4. Quai Vault Integration (IAvatar)

The DAO doesn't hold assets directly. Instead:

1. **Quai Vault** = Treasury (multi-sig safe)
2. **Baal** = Module on vault (can execute transactions)
3. **Proposals** = Execute via `IAvatar.execTransactionFromModule()`

**Benefits:**
- Vault owners retain emergency control
- Separates custody from governance
- Compatible with existing Quai Vaults
- Uses battle-tested Gnosis Safe patterns

#### Module Enablement Workflow

⚠️ **CRITICAL**: Before proposals can execute, Baal must be enabled as a module on the vault.

**Architecture Pattern**: Vault uses propose-approve-execute for security

```
┌─────────────────────────────────────────────────────────┐
│ Step 1: Propose Transaction                             │
│   vault.proposeTransaction(vault, 0, enableModuleData)  │
│   • Target: vault itself                                │
│   • Data: enableModule(baalAddress)                     │
│   • Returns: txHash                                     │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Step 2: Approve Transaction                             │
│   vault.approveTransaction(txHash)                      │
│   • Called by each owner until threshold met            │
│   • 1/1 vault: Use approveAndExecute() in one step      │
│   • Multisig: Each owner approves separately            │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Step 3: Execute Transaction                             │
│   vault.executeTransaction(txHash)                      │
│   • After threshold met, anyone can execute             │
│   • Calls: vault.enableModule(baalAddress)              │
│   • Result: Baal added to vault's enabled modules       │
└─────────────────────────────────────────────────────────┘
```

**Important Notes:**
- `enableModule` requires `msg.sender == vault` (only vault can call itself)
- Cannot use `execTransaction` directly (deprecated pattern)
- For 1/1 vaults: Automated by `summon-dao.ts` script
- For multisig: Deployer proposes/approves, other owners must approve manually

**Verification:**
```typescript
const isEnabled = await vault.isModuleEnabled(baalAddress);
// Must be true before submitting proposals
```

### 5. Shamans (Privileged Extensions)

Contracts with special permissions on Baal:

**Permission Levels** (bitmask):
- `ADMIN = 1`: Can pause tokens, set admin config
- `MANAGER = 2`: Can mint/burn shares and loot
- `GOVERNOR = 4`: Can set governance parameters

**Deployment Pattern:** Shamans are deployed as **singletons** (one instance shared across all DAOs)

**Built-in Shamans** (Cyprus1):
- `OnboarderShaman` (`0x004a47...A02F`): QUAI → shares/loot (with multiplier)
- `EthOnboarderShaman` (`0x006d2E...5668`): Simple QUAI → shares at fixed rate
- `CheckInShamanV2` (`0x005d25...6EAd3`): Periodic claims for engagement

**How Singletons Work:**
1. Shamans deployed once with standard Baal singleton reference
2. During DAO initialization, shamans granted MANAGER permissions via `setUp()`
3. Each DAO references the same shaman addresses
4. Shamans verify `msg.sender == authorizedBaal` before minting

**Custom Shamans:**
- Must implement `IShaman` interface
- ⚠️ **Cannot be added after initialization** (setShamans is `baalOnly`)
- Must be specified during `summonBaal()` or `summonBaalAndVault()`
- Can deploy per-DAO instances if custom parameters needed

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend / SDK                         │
│  (Proposal creation, voting, member queries)                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  Indexer (Event Processor)                  │
│  Listens: SetupComplete, SubmitProposal, SubmitVote, etc.  │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   Quai Network (Cyprus1)                    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Factory Layer                          │   │
│  │  ┌────────────────┐     ┌─────────────────────┐    │   │
│  │  │ BaalSummoner   │     │ BaalAndVault        │    │   │
│  │  │                │     │ Summoner            │    │   │
│  │  │ (Clone Baal)   │     │ (Baal + Vault)      │    │   │
│  │  └────────┬───────┘     └─────────┬───────────┘    │   │
│  └───────────┼─────────────────────────┼──────────────┘   │
│              │                          │                  │
│              ▼                          ▼                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           DAO Instance (Baal Clone)                  │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │ Baal Contract                                  │  │  │
│  │  │ • Proposal management                          │  │  │
│  │  │ • Voting logic                                 │  │  │
│  │  │ • Shaman permissions                           │  │  │
│  │  └───────────┬────────────────────────────────────┘  │  │
│  │              │                                        │  │
│  │              │ owns                                   │  │
│  │              ▼                                        │  │
│  │  ┌──────────────────┐      ┌──────────────────┐     │  │
│  │  │ SharesERC20      │      │ LootERC20        │     │  │
│  │  │ (Voting)         │      │ (Non-voting)     │     │  │
│  │  └──────────────────┘      └──────────────────┘     │  │
│  │              │                                        │  │
│  │              │ module on                              │  │
│  │              ▼                                        │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │ Quai Vault (Treasury)                          │  │  │
│  │  │ • Multi-sig safe                               │  │  │
│  │  │ • Holds DAO assets                             │  │  │
│  │  │ • Executes approved proposals                  │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           Shaman Layer (Extensions)                  │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │  │
│  │  │ Onboarder    │  │ CheckIn      │  │ Custom    │  │  │
│  │  │ Shaman       │  │ Shaman       │  │ Shaman    │  │  │
│  │  └──────────────┘  └──────────────┘  └───────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Contract Hierarchy

### Inheritance Tree

```
SharesERC20
├── BaalVotes (timestamp-based checkpoints)
├── ERC20Pausable
├── Ownable
└── IBaalToken

LootERC20
├── ERC20Pausable
├── Ownable
└── IBaalToken

Baal
├── ReentrancyGuard
├── Initializable (via setUp pattern)
└── IBaal

BaalSummoner
└── (Standalone factory)

BaalAndVaultSummoner
└── (Standalone factory with Vault integration)

OnboarderShaman
└── IShaman

CheckInShamanV2
└── IShaman
```

### Deployment Pattern (EIP-1167 Clones)

```
Singleton Deployment (Once):
┌──────────────────────┐
│ Baal Implementation  │ ← Full bytecode deployed once
└──────────────────────┘
         ▲
         │ clone (minimal proxy)
         │
┌────────┴─────────┐
│ Baal Instance 1  │ ← Only 55 bytes + init data
└──────────────────┘
         ▲
         │ clone
         │
┌────────┴─────────┐
│ Baal Instance 2  │ ← Only 55 bytes + init data
└──────────────────┘
```

**Gas Savings**:
- Full Baal deployment: ~5M gas
- Clone deployment: ~500K gas (90% savings)
- Deterministic addresses via CREATE2 + salt

## Key Design Decisions

### 1. Timestamp-Based Voting (Not Block Numbers)

**Decision**: Use `block.timestamp` instead of `block.number` for voting power snapshots.

**Rationale**:
- Quai Network has variable block times
- Timestamp-based is more predictable for users
- Matches MolochDAO V3 upstream specification
- Prevents gaming via block production manipulation

**Implementation**:
```solidity
function getPriorVotes(address account, uint256 timestamp) public view returns (uint256) {
    require(timestamp < block.timestamp, "BaalVotes: not yet determined");
    return _checkpointsLookup(_checkpoints[account], uint32(timestamp));
}
```

### 2. Proposal Data Hash Storage

**Decision**: Store only `keccak256(proposalData)` on-chain, verify full data at processing.

**Rationale**:
- Saves gas on submission (no need to store full calldata)
- Prevents front-running (hash committed at submission)
- Enables large/complex proposals without hitting block gas limits
- Data availability via event logs (indexer stores full data)

**Trade-off**: Requires passing full `proposalData` again at processing time.

### 3. Dual Vote Tracking

**Decision**: Track both vote counts AND share-weighted balances.

```solidity
struct Proposal {
    uint32 yesVotes;      // Number of yes voters
    uint256 yesBalance;   // Share-weighted yes votes
    uint32 noVotes;       // Number of no voters
    uint256 noBalance;    // Share-weighted no votes
}
```

**Rationale**:
- Quorum based on share-weighted balance (prevents sybil)
- Vote counts useful for UI/analytics
- Majority check: `yesBalance > noBalance`
- Quorum check: `yesBalance >= (totalShares * quorumPercent) / 10000`

### 4. Baal as Zodiac Module (Not Owner)

**Decision**: Baal is a *module* on Quai Vault, not the owner.

**Rationale**:
- Vault owners retain emergency control
- Can disable Baal module if compromised
- DAO can upgrade governance without migrating assets
- Follows Gnosis Safe / Zodiac best practices

**Module Pattern**:
```solidity
// In Baal.processProposal():
bool success = IAvatar(avatar).execTransactionFromModule(
    target,
    value,
    data,
    operation
);
```

### 5. Shaman Permission Bitmasks

**Decision**: Use bitmask flags instead of separate mappings.

```solidity
uint256 constant ADMIN = 1;
uint256 constant MANAGER = 2;
uint256 constant GOVERNOR = 4;

mapping(address => uint256) public shamans;

function setShamans(address[] calldata _shamans, uint256[] calldata _permissions) {
    for (uint256 i = 0; i < _shamans.length; i++) {
        shamans[_shamans[i]] = _permissions[i];
    }
}

modifier onlyManager() {
    require((shamans[msg.sender] & MANAGER) != 0, "Baal: not manager");
    _;
}
```

**Benefits**:
- Single storage slot per shaman
- Can combine permissions: `ADMIN | MANAGER = 3`
- Easy to check: `(shamans[addr] & PERMISSION) != 0`
- Extensible: Can add more permission bits later

### 6. Ragequit Fair Share Calculation

**Decision**: Proportional withdrawal based on total supply (shares + loot).

```solidity
uint256 fairShare = (tokenBalance * toBurn) / (totalShares + totalLoot);
```

**Rationale**:
- Fair to all token holders (shares and loot)
- No advantage to ragequitting early vs late
- Enforces minimum retention (66% default) to prevent bank run
- Simple, auditable math

### 7. Auto-Delegation on First Mint

**Decision**: Automatically delegate voting power to self when receiving first shares.

```solidity
function mint(address to, uint256 amount) external onlyOwner {
    if (balanceOf(to) == 0 && delegates(to) == address(0)) {
        _delegate(to, to); // Auto-delegate to self
    }
    _mint(to, amount);
}
```

**Rationale**:
- Better UX (new members can vote immediately)
- Prevents unintentional delegation to zero address
- Members can still delegate to others if desired
- Matches OpenZeppelin's ERC20Votes pattern

## Data Flow

### Proposal Lifecycle

```
1. SUBMISSION
   Member → Baal.submitProposal(proposalData, expiration, baalGas, details)
   ├─ Pay proposalOffering (e.g., 0.1 QUAI)
   ├─ Store: proposalId, dataHash, submitter, timestamps
   ├─ Auto-sponsor if balance >= sponsorThreshold
   ├─ Emit: SubmitProposal (with full proposalData in event)
   └─ State: Submitted (or Voting if auto-sponsored)

2. SPONSORSHIP (if not auto-sponsored)
   Member → Baal.sponsorProposal(proposalId)
   ├─ Require: balance >= sponsorThreshold
   ├─ Set: votingStarts, votingEnds, graceEnds
   ├─ Link: prevProposalId (for indexer ordering)
   ├─ Emit: SponsorProposal
   └─ State: Voting

3. VOTING
   Members → Baal.submitVote(proposalId, approved)
   ├─ Snapshot: voting power at votingStarts timestamp
   ├─ Require: not already voted, voting period active
   ├─ Update: yesVotes/noVotes, yesBalance/noBalance
   ├─ Emit: SubmitVote
   └─ State: Voting (until votingEnds)

4. GRACE PERIOD
   (No actions, members can ragequit if they disagree)
   └─ State: Grace (until graceEnds)

5. PROCESSING
   Anyone → Baal.processProposal(proposalId, proposalData)
   ├─ Verify: hash(proposalData) == stored hash
   ├─ Check: quorum met, majority yes, not expired
   ├─ Execute: IAvatar.execTransactionFromModule(target, value, data)
   ├─ Set: processed=true, passed=result, actionFailed=!success
   ├─ Emit: ProcessProposal
   └─ State: Processed (if passed) or Defeated (if failed quorum)
```

### Member Onboarding Flow (via Shaman)

```
1. TRIBUTE PAYMENT
   New Member → OnboarderShaman.onboard()
   ├─ Send ETH (e.g., 0.1 QUAI)
   ├─ Calculate: shares = amount * multiplier / 10000
   ├─ Call: Baal.mintShares([newMember], [shares])
   └─ Emit: Onboard

2. TOKEN MINTING
   OnboarderShaman → Baal.mintShares()
   ├─ Check: msg.sender has MANAGER permission
   ├─ Call: SharesERC20.mint(newMember, shares)
   ├─ Auto-delegate to self (if first tokens)
   └─ Member now has voting power

3. IMMEDIATE VOTING
   New Member → Baal.submitVote(proposalId, approved)
   ├─ Voting power determined by: getPriorVotes(member, proposal.votingStarts)
   ├─ If minted before votingStarts: can vote with full power
   └─ If minted after votingStarts: no voting power for this proposal
```

### Treasury Action Execution

```
1. PROPOSAL APPROVED
   Baal.processProposal() → IAvatar(vault).execTransactionFromModule()

2. VAULT EXECUTION
   QuaiVault receives call from Baal (enabled module)
   ├─ Check: Baal is enabled module
   ├─ Execute: call to target contract (e.g., ERC20.transfer)
   └─ Return: success boolean

3. RESULT RECORDING
   Baal receives return value
   ├─ If success: actionFailed = false, passed = true
   ├─ If failed: actionFailed = true, passed = true (passed vote, failed action)
   └─ Emit: ProcessProposal(proposalId, passed, actionFailed)
```

## Security Model

### Access Control Hierarchy

```
┌─────────────────────────────────────────────────────────┐
│                     Proposal Approval                   │ ← Highest authority
│  (Only via successful member vote + execution)          │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  GOVERNOR Shamans                       │
│  Can: setGovernanceConfig, setAdminConfig              │
│  Examples: DAO upgrade shaman, emergency pause shaman   │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  MANAGER Shamans                        │
│  Can: mintShares, mintLoot, burnShares, burnLoot       │
│  Examples: OnboarderShaman, CheckInShaman              │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   ADMIN Shamans                         │
│  Can: pause/unpause tokens                             │
│  Examples: Security monitoring shaman                   │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                      Members                            │
│  Can: submitProposal, submitVote, ragequit             │
└─────────────────────────────────────────────────────────┘
```

### Critical Invariants

1. **Token Ownership**: Baal MUST be the owner of SharesERC20 and LootERC20
   - Enforced by: `Ownable`, checked in mint/burn functions
   - Prevents: Unauthorized minting/burning

2. **Proposal Hash Integrity**: Processed proposals MUST match original hash
   - Enforced by: `require(keccak256(proposalData) == proposal.proposalDataHash)`
   - Prevents: Front-running, data manipulation

3. **Vote Immutability**: Members cannot change their vote once cast
   - Enforced by: `require(!memberVoted[msg.sender][id])`
   - Prevents: Vote manipulation, double voting

4. **Minimum Retention**: Ragequit MUST leave >= 66% of total supply
   - Enforced by: `require(remaining >= total * minRetentionPercent / 10000)`
   - Prevents: Bank run, treasury drain

5. **Module Authorization**: Only enabled modules can execute on vault
   - Enforced by: Quai Vault's `execTransactionFromModule` checks
   - Prevents: Unauthorized treasury access

### Reentrancy Protection

**Where Applied**:
- `processProposal()`: Calls external contract (IAvatar)
- `ragequit()`: Loops over tokens, calls transfers
- Token minting/burning: External calls to ERC20

**Mitigation**:
- OpenZeppelin's `ReentrancyGuard` on critical functions
- Checks-Effects-Interactions pattern
- State updates before external calls

### Gas Griefing Protection

**Attack Vector**: Malicious proposal with infinite loop or massive computation.

**Mitigation**:
```solidity
// Proposal can specify gas limit for execution
uint256 baalGas = proposal.baalGas;
if (baalGas > 0) {
    success = IAvatar(avatar).execTransactionFromModule{gas: baalGas}(...);
} else {
    success = IAvatar(avatar).execTransactionFromModule(...);
}
```

**Effect**: Execution fails gracefully if gas exceeded, doesn't block processing.

### Upgrade Path

**Immutable Components**:
- Singletons (Baal, SharesERC20, LootERC20 implementations)
- Factory contracts (BaalSummoner, BaalAndVaultSummoner)

**Upgradeable via Proposal**:
- Shamans (can add/remove via setShamans)
- Governance parameters (votingPeriod, quorumPercent, etc.)
- Guild tokens (ragequittable asset list)

**DAO Migration**:
If critical bug in Baal:
1. Deploy new Baal singleton
2. Deploy new instance via factory
3. Migrate members (mint equivalent shares/loot)
4. Transfer treasury assets via proposal in old DAO
5. Disable old Baal as vault module

**No proxy pattern** = No accidental ownership bugs, but requires migration for major upgrades.

---

**Next**: See [GOVERNANCE.md](./GOVERNANCE.md) for detailed proposal workflows and [API.md](./API.md) for complete contract reference.
