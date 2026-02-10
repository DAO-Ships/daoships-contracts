# Implementation Plan: qdl-contracts Repository

## Context

Building a complete MolochDAO V3 (Baal) launcher for Quai Network, integrated with the existing Quai Vault treasury system. This enables deploying fully-functional DAOs with:
- **Governance**: Share-weighted voting on proposals
- **Treasury**: Quai Vault integration via Zodiac IAvatar interface
- **Tokens**: Voting shares (ERC20Votes) and non-voting loot (ERC20)
- **Extensions**: Shamans for onboarding, subscriptions, and custom logic
- **Exit mechanism**: Ragequit with proportional asset withdrawal

**Current State**: Empty qdl-contracts directory, need to build from scratch.

**Reference**: Comprehensive specification in `/home/mpoletiek/Devspace/QUAIDAO/INITIAL_PLAN.md` (67KB)

## Approach

### Strategy: Incremental MVP → Full Implementation

Rather than attempting to fork and adapt the entire HausDAO Baal codebase at once, we'll build incrementally:

1. **Phase 1**: Core governance engine (tokens + Baal proposal lifecycle)
2. **Phase 2**: Factory system (BaalSummoner with Quai Vault integration)
3. **Phase 3**: Complete features (ragequit, metadata, shamans)

### Key Architectural Decisions

**1. Clone-Based Deployment (EIP-1167 Minimal Proxies)**
- Deploy singleton implementations once
- Use `Clones.clone()` for each DAO (saves 90% gas)
- Matches DAOhaus pattern, ensures indexer compatibility

**2. Token Ownership Model**
- Baal contract owns SharesERC20 and LootERC20
- Only Baal (via proposals) or authorized shamans can mint/burn
- Prevents external manipulation

**3. Proposal Data Storage**
- Store only hash on-chain at submission
- Full data passed at processing time
- Verified via hash match (prevents manipulation)

**4. Zodiac Module Pattern**
- Baal acts as a Zodiac module on Quai Vault
- Executes treasury actions via `IAvatar.execTransactionFromModule()`
- Vault owners retain emergency control

**5. Reference Implementation**
- HausDAO's Baal contracts are the reference (feat/baalZodiac branch)
- We adapt core logic rather than blind copy
- Maintain event signatures for indexer compatibility

## Implementation Phases

### Phase 1: Foundation (Weeks 1-2)

**Goal**: Working governance with basic token system

#### Week 1: Setup + Tokens

**Tasks**:
1. **Initialize project structure** (1 day)
   - Create directory structure per INITIAL_PLAN.md
   - Setup Hardhat config based on Quai Vault reference
   - Configure package.json with dependencies
   - Copy IAvatar.sol and Enum.sol from Quai Vault
   - Create .env.example with network configs

2. **Implement BaalVotes.sol** (1-2 days)
   - Abstract base contract for timestamp-based voting power
   - Checkpoint mechanism for historical balance queries
   - `getPastVotes(address, timestamp)` implementation
   - Delegation tracking with `DelegateChanged` events

3. **Implement SharesERC20.sol** (1 day)
   - Extends BaalVotes + ERC20Pausable + Ownable
   - Auto-delegation on first mint
   - Only owner (Baal) can mint/burn/pause
   - Test: transfers, delegation, voting power snapshots

4. **Implement LootERC20.sol** (1 day)
   - Basic ERC20 + Pausable + Ownable
   - No voting functionality
   - Only owner (Baal) can mint/burn/pause
   - Test: transfers, burn, pause

#### Week 2: Baal Core

**Tasks**:
1. **Baal.sol - State & Initialization** (2 days)
   - State variables (avatar, tokens, governance config)
   - Proposal struct and mapping
   - Shaman permission system (ADMIN=1, MANAGER=2, GOVERNOR=4)
   - `setUp()` function with parameter decoding
   - Event: `SetupComplete`

2. **Baal.sol - Proposal Submission** (1 day)
   - `submitProposal()` with offering payment
   - Auto-sponsor if threshold met
   - Proposal data hash storage
   - Events: `SubmitProposal`, `SponsorProposal`

3. **Baal.sol - Voting** (1 day)
   - `submitVote()` with balance snapshot
   - Vote tracking (yesVotes, noVotes, balances)
   - Prevent double voting
   - Event: `SubmitVote`

4. **Baal.sol - Processing** (2 days)
   - State machine for proposal status
   - `processProposal()` with hash verification
   - Execute via `IAvatar.execTransactionFromModule()`
   - Handle execution failures (actionFailed flag)
   - `cancelProposal()` for submitters/governors
   - Events: `ProcessProposal`, `CancelProposal`

**Phase 1 Exit Criteria**:
- ✅ Can deploy Baal with tokens
- ✅ Can submit and vote on proposals
- ✅ Proposals execute treasury actions via IAvatar
- ✅ Test coverage >85%
- ✅ All events match INITIAL_PLAN.md schema

### Phase 2: Integration (Week 3)

**Goal**: Factory deployment with Quai Vault integration

#### Tasks:

1. **BaalSummoner.sol** (2 days)
   - Deploy Baal clone via `Clones.clone()`
   - Deploy SharesERC20 and LootERC20 clones
   - Initialize all contracts
   - Mint initial shares/loot to founders
   - Set initial shamans (if any)
   - Event: `SetupComplete` with full config

2. **BaalAndVaultSummoner.sol** (2 days)
   - Integrate with QuaiVaultFactory
   - `summonBaalAndVault()` creates both in one tx
   - Support existing vault scenario
   - Handle module enablement (may require owner approval)
   - MultiSend integration for batched setup
   - Events: `SummonComplete`

3. **MultiSend Encoding Utilities** (1 day)
   - `encodeMultiSend()` helper function
   - Format: [operation][to][value][dataLength][data]...
   - Used for batched proposal execution
   - Test with complex multi-action proposals

**Phase 2 Exit Criteria**:
- ✅ Can summon DAO with new Quai Vault in single tx
- ✅ Can summon DAO with existing Quai Vault
- ✅ Module properly enabled on vault
- ✅ Factory events match indexer schema

### Phase 3: Complete Features (Week 4-5)

**Goal**: Full feature parity with Baal spec

#### Week 4: Core Extensions

1. **Ragequit mechanism** (2 days)
   - Guild token management (setGuildTokens)
   - `ragequit()` with fair share calculation
   - Minimum retention percentage enforcement
   - Withdraw assets via IAvatar
   - Event: `Ragequit`

2. **Poster.sol** (1 day)
   - EIP-3722 on-chain metadata storage
   - `post(content, tag)` function
   - Used for DAO profiles, proposal details
   - Event: `NewPost`

3. **Governance Configuration** (1 day)
   - `setGovernanceConfig()` for governors
   - Admin/Manager/Governor locks
   - Events: `GovernanceConfigSet`, `LockAdmin`, etc.

4. **Shaman System Enhancement** (1 day)
   - `setShamans()` via proposal
   - Permission validation
   - Event: `ShamanSet`

#### Week 5: Shamans

1. **OnboarderShaman.sol** (2 days)
   - ETH → shares/loot with multiplier
   - Expiry mechanism
   - Minimum tribute requirement
   - Only mints to tribute sender

2. **CheckInShamanV2.sol** (2 days)
   - Periodic claim mechanism
   - Track last claim timestamp
   - Miss tracking with max missed claims
   - Flexible shares/loot rewards

3. **Additional Shamans** (1 day)
   - EthOnboarderShaman (simple variant)
   - SimpleOnboarderShaman (1:1 token swap)
   - As needed based on priority

**Phase 3 Exit Criteria**:
- ✅ Members can ragequit and withdraw assets
- ✅ DAO metadata stored via Poster
- ✅ Onboarder allows ETH contributions
- ✅ Check-in tracks engagement
- ✅ All shamans tested

## Critical Files & Integration Patterns

### Files to Reference

**Quai Vault Integration** (symlink or copy):
- `/home/mpoletiek/Devspace/QUAI-VAULT/quaivault-contracts/contracts/interfaces/IAvatar.sol`
- `/home/mpoletiek/Devspace/QUAI-VAULT/quaivault-contracts/contracts/libraries/Enum.sol`

**Configuration Reference**:
- `/home/mpoletiek/Devspace/QUAI-VAULT/quaivault-contracts/hardhat.config.ts`
- Use as template for Solidity 0.8.22, evmVersion london, optimizer settings
- **Repository**: [github.com/Quai-Vault/quaivault-contracts](https://github.com/Quai-Vault/quaivault-contracts) - Production Hardhat setup for Quai Network with deployment scripts, network configs, and testing patterns

**Factory Pattern Reference**:
- `/home/mpoletiek/Devspace/QUAI-VAULT/quaivault-contracts/contracts/QuaiVaultFactory.sol`
- CREATE2 deployment with salt
- Proxy pattern with initialization

**Specification**:
- `/home/mpoletiek/Devspace/QUAIDAO/INITIAL_PLAN.md`
- All event schemas, data structures, function signatures

### Critical Implementation Details

#### Proposal Linked List Pattern

**Purpose**: Track sponsored proposal ordering for indexer

```solidity
// When sponsoring a proposal:
function sponsorProposal(uint32 id) external {
    Proposal storage prop = proposals[id];

    // Link to previous sponsored proposal
    prop.prevProposalId = latestSponsoredProposalId;

    // Update latest
    latestSponsoredProposalId = id;

    // Set timing
    prop.votingStarts = uint32(block.timestamp);
    prop.votingEnds = uint32(block.timestamp + votingPeriod);
    prop.graceEnds = uint32(block.timestamp + votingPeriod + gracePeriod);

    emit SponsorProposal(msg.sender, id, prop.votingStarts);
}
```

**Indexer Usage**: Follow linked list via prevProposalId to build chronological proposal list.

#### SetupComplete Event - EXACT Schema

```solidity
event SetupComplete(
    bool lootPaused,
    bool sharesPaused,
    uint32 gracePeriod,
    uint32 votingPeriod,
    uint256 proposalOffering,
    uint256 quorumPercent,
    uint256 sponsorThreshold,
    uint256 minRetentionPercent,
    string name,                    // Shares token name
    string symbol,                  // Shares token symbol
    address[] guildTokens,          // Initial ragequittable tokens (CRITICAL: array)
    uint256 totalShares,
    uint256 totalLoot
);

// Emit during setUp():
emit SetupComplete(
    lootToken.paused(),
    sharesToken.paused(),
    gracePeriod,
    votingPeriod,
    proposalOffering,
    quorumPercent,
    sponsorThreshold,
    minRetentionPercent,
    sharesToken.name(),
    sharesToken.symbol(),
    _guildTokens,  // Pass array, not individual
    sharesToken.totalSupply(),
    lootToken.totalSupply()
);
```

#### SubmitProposal Event - Complete Parameters

```solidity
event SubmitProposal(
    uint256 indexed proposal,       // Proposal ID
    bytes32 indexed proposalDataHash,
    uint256 votingPeriod,           // DAO's current voting period
    bytes proposalData,             // Raw multisend data (can be large)
    uint256 expiration,             // 0 if no expiry
    bool selfSponsor,               // true if auto-sponsored
    uint256 timestamp,              // block.timestamp
    string details                  // IPFS hash or JSON metadata
);

// Emit during submitProposal():
emit SubmitProposal(
    proposalCount,
    keccak256(proposalData),
    votingPeriod,
    proposalData,
    expiration,
    isSelfSponsored,
    block.timestamp,
    details
);
```

#### Auto-Sponsor Logic

```solidity
function submitProposal(...) external payable returns (uint256) {
    require(msg.value == proposalOffering, "Baal: incorrect offering");

    uint256 sponsorThresholdMet = sharesToken.balanceOf(msg.sender) >= sponsorThreshold;

    proposalCount++;
    proposals[proposalCount] = Proposal({
        id: proposalCount,
        // ... other fields
    });

    bool selfSponsor = sponsorThresholdMet;

    emit SubmitProposal(
        proposalCount,
        keccak256(proposalData),
        votingPeriod,
        proposalData,
        expiration,
        selfSponsor,
        block.timestamp,
        details
    );

    if (selfSponsor) {
        _sponsorProposal(proposalCount, msg.sender);
    }

    return proposalCount;
}
```

#### Vote Tracking - Dual Metrics

```solidity
function submitVote(uint32 id, bool approved) external {
    require(!memberVoted[msg.sender][id], "Baal: already voted");

    Proposal storage prop = proposals[id];
    uint256 balance = getPriorVotes(msg.sender, prop.votingStarts);

    require(balance > 0, "Baal: insufficient voting power");

    memberVoted[msg.sender][id] = true;

    if (approved) {
        prop.yesVotes++;          // Increment voter count
        prop.yesBalance += balance; // Add voting power
    } else {
        prop.noVotes++;
        prop.noBalance += balance;
    }

    emit SubmitVote(msg.sender, balance, id, approved);
}
```

#### Quorum & Passage Logic

```solidity
function _didProposalPass(uint32 id) internal view returns (bool) {
    Proposal storage prop = proposals[id];

    uint256 totalShares = sharesToken.totalSupply();
    uint256 quorumRequired = (totalShares * quorumPercent) / 10000;

    // Check quorum: yes votes must meet minimum threshold
    if (prop.yesBalance < quorumRequired) {
        return false;
    }

    // Check majority: yes must exceed no
    return prop.yesBalance > prop.noBalance;
}
```

### Key Integration Patterns

#### 1. Execute Treasury Action (Simple)

```solidity
import "../interfaces/IAvatar.sol";

contract Baal {
    address public avatar; // Quai Vault address

    function processProposal(uint32 id, bytes calldata proposalData) external {
        // ... validation ...

        // Execute via IAvatar
        bool success = IAvatar(avatar).execTransactionFromModule(
            target,
            value,
            data,
            Enum.Operation.Call
        );

        proposal.status[3] = !success; // actionFailed
        proposal.status[1] = true;     // processed

        emit ProcessProposal(id, success, !success);
    }
}
```

#### 2. MultiSend Batch Execution

```solidity
function processProposal(uint32 id, bytes calldata proposalData) external {
    // proposalData is MultiSend encoded: [op][to][value][len][data]...

    bool success = IAvatar(avatar).execTransactionFromModule(
        multisendLibrary,
        0,
        abi.encodeWithSignature("multiSend(bytes)", proposalData),
        Enum.Operation.DelegateCall // DelegateCall to MultiSend
    );
}
```

#### 3. Governance Config Encoding

```solidity
bytes memory governanceConfig = abi.encode(
    uint32(votingPeriod),        // e.g., 604800 (7 days)
    uint32(gracePeriod),         // e.g., 259200 (3 days)
    uint256(proposalOffering),   // e.g., 0.1 QUAI
    uint256(quorumPercent),      // e.g., 2000 (20%)
    uint256(sponsorThreshold),   // e.g., 1e18 (1 share)
    uint256(minRetentionPercent) // e.g., 6600 (66%)
);
```

#### 4. Factory Integration

```solidity
import "../interfaces/IQuaiVaultFactory.sol";

function summonBaalAndVault(
    bytes calldata baalParams,
    address[] calldata vaultOwners,
    uint256 vaultThreshold,
    bytes32 salt
) external returns (address baal, address vault) {
    // 1. Deploy Quai Vault
    vault = IQuaiVaultFactory(quaiVaultFactory).createWallet(
        vaultOwners,
        vaultThreshold,
        salt
    );

    // 2. Deploy Baal clone
    baal = Clones.clone(baalSingleton);

    // 3. Initialize (vault is the avatar)
    Baal(baal).setUp(
        abi.encode(
            lootToken,
            sharesToken,
            vault,  // avatar address
            forwarder,
            multisendLibrary,
            governanceConfig,
            // ... rest of params
        )
    );

    // 4. Note: enableModule(baal) must be called on vault by owners
}
```

## Project Structure

```
qdl-contracts/
├── contracts/
│   ├── core/
│   │   ├── Baal.sol
│   │   ├── BaalSummoner.sol
│   │   └── BaalAndVaultSummoner.sol
│   ├── tokens/
│   │   ├── BaalVotes.sol
│   │   ├── SharesERC20.sol
│   │   └── LootERC20.sol
│   ├── shamans/
│   │   ├── OnboarderShaman.sol
│   │   └── CheckInShamanV2.sol
│   ├── tools/
│   │   └── Poster.sol
│   ├── libraries/
│   │   └── MultiSendEncoder.sol
│   └── interfaces/
│       ├── IBaal.sol
│       ├── IBaalToken.sol
│       ├── IShaman.sol
│       ├── IQuaiVaultFactory.sol
│       ├── IAvatar.sol (symlink to Quai Vault)
│       └── IPoster.sol
├── test/
│   ├── unit/
│   │   ├── Baal.test.ts
│   │   ├── SharesERC20.test.ts
│   │   └── LootERC20.test.ts
│   └── integration/
│       ├── BaalSummoner.test.ts
│       ├── BaalVaultIntegration.test.ts
│       └── ProposalLifecycle.test.ts
├── scripts/
│   ├── summon-dao.ts
│   └── utils/
│       ├── encoding.ts
│       └── multisend.ts
├── deploy/
│   ├── 001_deploy_poster.ts
│   ├── 002_deploy_baal_singleton.ts
│   ├── 003_deploy_tokens.ts
│   └── 004_deploy_summoners.ts
├── hardhat.config.ts
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Dependencies

```json
{
  "dependencies": {
    "@openzeppelin/contracts": "^5.0.0",
    "@quai/hardhat-deploy-metadata": "^1.0.8",
    "dotenv": "^16.4.5",
    "quais": "^1.0.0-alpha.53"
  },
  "devDependencies": {
    "@nomicfoundation/hardhat-toolbox": "^5.0.0",
    "@nomicfoundation/hardhat-verify": "^2.0.3",
    "@typechain/hardhat": "^9.1.0",
    "hardhat": "^2.19.5",
    "hardhat-gas-reporter": "^1.0.9",
    "solidity-coverage": "^0.8.5",
    "typescript": "^5.3.3"
  }
}
```

## Verification Steps

### Unit Testing
```bash
npm run test:unit
```
- All token functions (mint, burn, transfer, delegation)
- Baal proposal lifecycle (submit, sponsor, vote, process)
- Shaman permissions and functions
- Target: >85% coverage

### Integration Testing
```bash
npm run test:integration
```
- End-to-end DAO summoning
- Proposal execution via IAvatar
- MultiSend batched actions
- Ragequit with asset withdrawal
- Module enablement flows

### Local Deployment
```bash
npm run deploy:local
```
- Deploy all singletons
- Deploy factory
- Summon test DAO
- Verify all addresses and initialization

### Testnet Deployment (Orchard - Cyprus1)
```bash
npm run deploy:orchard
```
- Deploy to Quai Network testnet
- Verify contracts on explorer
- Create test DAO with real transactions
- Verify indexer compatibility

### End-to-End Flow Validation

1. **Summon DAO**
   - Deploy via BaalAndVaultSummoner
   - Verify vault created with correct owners
   - Verify Baal initialized with tokens
   - Verify initial members have shares/loot

2. **Submit Proposal**
   - Member submits funding proposal
   - Verify auto-sponsor if threshold met
   - Verify proposal offering paid
   - Verify event emitted with correct data

3. **Vote on Proposal**
   - Multiple members vote yes/no
   - Verify voting power correctly calculated
   - Verify vote balances tracked
   - Verify cannot double vote

4. **Process Proposal**
   - Wait for voting + grace period
   - Process with original proposal data
   - Verify hash matches
   - Verify treasury action executed via IAvatar
   - Verify recipient received funds

5. **Ragequit**
   - Member ragequits with shares
   - Verify fair share calculation
   - Verify assets transferred from vault
   - Verify shares/loot burned

6. **Onboarder Usage**
   - Non-member sends ETH to onboarder
   - Verify shares minted by shaman
   - Verify member now has voting power
   - Verify can vote on proposals

### Compatibility Validation

**Indexer Compatibility** (qdl-indexer):
- Verify all events match schema in INITIAL_PLAN.md
- Test event parsing with example transactions
- Verify proposal status calculation logic
- Confirm member tracking (shares, loot, delegation)

**SDK Compatibility** (qdl-sdk):
- Generate TypeScript types from ABIs
- Test proposal encoding utilities
- Verify query interfaces work with database schema
- Test summon flows via SDK

## Timeline

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| Setup | 1 day | Project structure, Hardhat config |
| Tokens | 3 days | BaalVotes, SharesERC20, LootERC20 |
| Baal Core | 6 days | Full proposal lifecycle |
| Summoner | 3 days | Factory with vault integration |
| Extensions | 5 days | Ragequit, Poster, governance |
| Shamans | 5 days | Onboarder, CheckIn |
| Testing | 3 days | Integration tests, deployment |

**Total: ~4-5 weeks** for complete implementation

**MVP (Phases 1-2): ~2-3 weeks** for working governance + factory

## Success Metrics

**Phase 1 (MVP)**:
- ✅ Working Baal governance with voting
- ✅ Treasury execution via IAvatar
- ✅ Test coverage >85%
- ✅ Can deploy to testnet

**Phase 2 (Integration)**:
- ✅ One-transaction DAO summoning
- ✅ Module properly enabled on vault
- ✅ Factory events match spec

**Phase 3 (Complete)**:
- ✅ Full ragequit functionality
- ✅ Working shamans
- ✅ All events match INITIAL_PLAN.md
- ✅ Compatible with qdl-indexer
- ✅ Gas costs reasonable (<1M for summon)
- ✅ Documentation complete

## Deployment Addresses & Tracking

### Existing Quai Infrastructure (Cyprus1)

| Contract | Address | Notes |
|----------|---------|-------|
| QuaiVault Implementation | `0x00707D5c7e35253265267DE764d2625cAb04082C` | Proxy target |
| QuaiVaultFactory | `0x005261a837f1eFEa0e23b66dc526EB6054FD2250` | Used by BaalAndVaultSummoner |
| MultiSend | `0x000bf87B9a7D4Bf60F95e0a27A6254dE7655b345` | For batched proposals |

### Quai DAO Launcher (To Be Deployed)

Create `deployments/deployment-{network}-{timestamp}.json`:

```json
{
  "network": "cyprus1",
  "chainId": 15000,
  "timestamp": 1234567890,
  "deployer": "0x...",
  "contracts": {
    "Poster": {
      "address": "TBD",
      "txHash": "TBD",
      "blockNumber": 0
    },
    "BaalSingleton": {
      "address": "TBD",
      "txHash": "TBD",
      "blockNumber": 0
    },
    "SharesERC20Singleton": {
      "address": "TBD",
      "txHash": "TBD",
      "blockNumber": 0
    },
    "LootERC20Singleton": {
      "address": "TBD",
      "txHash": "TBD",
      "blockNumber": 0
    },
    "BaalSummoner": {
      "address": "TBD",
      "txHash": "TBD",
      "blockNumber": 0
    },
    "BaalAndVaultSummoner": {
      "address": "TBD",
      "txHash": "TBD",
      "blockNumber": 0
    },
    "OnboarderShaman": {
      "address": "TBD",
      "txHash": "TBD",
      "blockNumber": 0
    },
    "CheckInShamanV2": {
      "address": "TBD",
      "txHash": "TBD",
      "blockNumber": 0
    }
  }
}
```

**Deployment Script Template**:
```typescript
// deploy/001_deploy_poster.ts
const deploymentInfo = {
  address: poster.address,
  txHash: poster.deployTransaction.hash,
  blockNumber: (await poster.deployTransaction.wait()).blockNumber,
};

fs.writeFileSync(
  `./deployments/deployment-${network.name}-${Date.now()}.json`,
  JSON.stringify(deploymentInfo, null, 2)
);
```

---

## Common Pitfalls & How to Avoid Them

### 1. **Event Parameter Ordering**
❌ **Wrong**: Changing event parameter order breaks indexer
✅ **Right**: Match INITIAL_PLAN.md exactly, including indexed keywords

```solidity
// MUST match spec:
event SubmitVote(
    address indexed member,   // indexed
    uint256 balance,          // not indexed
    uint256 indexed proposal, // indexed
    bool indexed approved     // indexed
);
```

### 2. **Timestamp vs Block Number**
❌ **Wrong**: Using block.number for voting power snapshots
✅ **Right**: Use block.timestamp (Baal spec uses timestamps)

```solidity
uint256 balance = getPriorVotes(msg.sender, prop.votingStarts); // timestamp
```

### 3. **Proposal Data Storage**
❌ **Wrong**: Storing full proposalData on-chain (expensive)
✅ **Right**: Store hash, pass data at processing

```solidity
// Submit: store hash
prop.proposalDataHash = keccak256(proposalData);

// Process: verify hash
require(keccak256(proposalData) == prop.proposalDataHash, "Baal: hash mismatch");
```

### 4. **Shaman Permission Validation**
❌ **Wrong**: Using == for permission checks (misses combined permissions)
✅ **Right**: Use bitmask with &

```solidity
// Check if shaman has MANAGER permission (may have others too)
require(shamans[msg.sender] & MANAGER == MANAGER, "Baal: not manager");

// Or more clearly:
modifier onlyManager() {
    require((shamans[msg.sender] & MANAGER) != 0, "Baal: not manager");
    _;
}
```

### 5. **Clone Initialization**
❌ **Wrong**: Calling constructor on clones
✅ **Right**: Use setUp()/initialize() pattern

```solidity
// Singleton has empty constructor
constructor() {}

// Initialization via function
function setUp(bytes memory params) external {
    require(avatar == address(0), "Baal: already initialized");
    // ... initialize state
}
```

### 6. **Guild Token Validation**
❌ **Wrong**: Allowing any token in ragequit
✅ **Right**: Only guildTokens, validated subset

```solidity
function ragequit(..., address[] calldata tokens) external {
    for (uint256 i = 0; i < tokens.length; i++) {
        require(guildTokensEnabled[tokens[i]], "Baal: not guild token");
        // Prevent duplicates
        for (uint256 j = i + 1; j < tokens.length; j++) {
            require(tokens[i] != tokens[j], "Baal: duplicate token");
        }
    }
}
```

### 7. **Voting Power Snapshot Timing**
❌ **Wrong**: Using current balance for voting power
✅ **Right**: Use balance at votingStarts timestamp

```solidity
// Correct: snapshot at voting start
uint256 balance = getPriorVotes(voter, prop.votingStarts);

// Prevents: acquiring shares after vote starts to influence outcome
```

### 8. **Proposal Status State Machine**
❌ **Wrong**: Manual status tracking, can become inconsistent
✅ **Right**: Compute from timestamps + flags

```solidity
function state(uint32 id) public view returns (ProposalState) {
    Proposal storage prop = proposals[id];

    if (prop.id == 0) return ProposalState.Unborn;
    if (prop.status[0]) return ProposalState.Cancelled;
    if (prop.status[1]) {
        return prop.status[2] ? ProposalState.Processed : ProposalState.Defeated;
    }
    if (prop.sponsor == address(0)) return ProposalState.Submitted;
    if (prop.expiration != 0 && block.timestamp > prop.expiration) return ProposalState.Expired;
    if (block.timestamp < prop.votingEnds) return ProposalState.Voting;
    if (block.timestamp < prop.graceEnds) return ProposalState.Grace;
    return ProposalState.Ready;
}
```

### 9. **IAvatar Return Value Handling**
❌ **Wrong**: Ignoring return value from execTransactionFromModule
✅ **Right**: Check success, set actionFailed appropriately

```solidity
bool success = IAvatar(avatar).execTransactionFromModule(...);
prop.status[3] = !success; // actionFailed
prop.status[1] = true;     // processed (even if action failed)
prop.status[2] = _didProposalPass(id); // passed
```

### 10. **Array Length Mismatches**
❌ **Wrong**: Assuming arrays are same length
✅ **Right**: Validate explicitly

```solidity
function mintShares(address[] calldata to, uint256[] calldata amount) external {
    require(to.length == amount.length, "Baal: length mismatch");
    require(to.length > 0, "Baal: empty arrays");

    for (uint256 i = 0; i < to.length; i++) {
        sharesToken.mint(to[i], amount[i]);
    }
}
```

### 11. **Basis Points Calculations**
❌ **Wrong**: Using percentages (0-100)
✅ **Right**: Using basis points (0-10000)

```solidity
// Correct: 2000 basis points = 20%
uint256 quorumRequired = (totalShares * quorumPercent) / 10000;

// Example values:
// 2000 = 20%
// 6600 = 66%
// 10000 = 100%
```

### 12. **Token Name/Symbol in Events**
❌ **Wrong**: Hardcoding token names in events
✅ **Right**: Read from token contracts dynamically

```solidity
emit SetupComplete(
    // ...
    sharesToken.name(),   // Read dynamically
    sharesToken.symbol(), // Read dynamically
    // ...
);
```

---

## Risk Mitigation

**Complexity Risk**: Baal is complex (~1000 LOC core contract)
- Mitigation: Incremental implementation, extensive testing, reference HausDAO implementation

**Integration Risk**: Quai Vault integration edge cases
- Mitigation: Dedicated integration test suite, test with deployed vault, fail-safe patterns

**Compatibility Risk**: Indexer may not work with our events
- Mitigation: Strict adherence to event schemas, early integration testing

**Quai Network Risk**: Undocumented EVM differences
- Mitigation: Early testnet deployment, comprehensive on-chain testing

## AUDIT REPORT

### Audit Date: 2026-02-10
### Audited Against: INITIAL_PLAN.md v4.0 (Comprehensively Audited)

---

### ✅ Complete & Correct

**Architecture**:
- Clone-based deployment strategy ✅
- Zodiac module pattern ✅
- Proposal hash verification ✅
- Token ownership model ✅

**Core Contracts**:
- Baal.sol state variables complete ✅
- Proposal struct complete ✅
- Event schemas match specification ✅
- Integration patterns correct ✅

**Phase Structure**:
- Incremental MVP approach ✅
- Dependencies properly ordered ✅
- Testnet deployment strategy ✅

---

### ⚠️ Critical Gaps & Enhancements

#### 1. **Missing Baal Functions** (Must Implement)

**Shaman Functions** - Arrays, not single values:
```solidity
function mintShares(address[] calldata to, uint256[] calldata amount) external;
function mintLoot(address[] calldata to, uint256[] calldata amount) external;
function burnShares(address[] calldata from, uint256[] calldata amount) external;
function burnLoot(address[] calldata from, uint256[] calldata amount) external;
```

**Baal-Only Functions** (require proposal approval):
```solidity
function setShamans(address[] calldata _shamans, uint256[] calldata _permissions) external;
function setGuildTokens(address[] calldata _tokens) external;
function lockAdmin() external;
function lockGovernor() external;
function lockManager() external;
function executeAsBaal(address _to, uint256 _value, bytes calldata _data) external;
```

**View Functions** (critical for UI/SDK):
```solidity
function state(uint32 id) external view returns (ProposalState);
function getProposalStatus(uint32 id) external view returns (bool[4] memory);
function getCurrentVotes(address account) external view returns (uint256);
function getPriorVotes(address account, uint256 timeStamp) external view returns (uint256);
function hashOperation(bytes memory _transactions) external pure returns (bytes32);
function totalShares() external view returns (uint256);
function totalLoot() external view returns (uint256);
function totalSupply() external view returns (uint256); // shares + loot
```

**Meta-Transaction Support** (Phase 2 or 3):
```solidity
function submitVoteWithSig(
    uint32 id,
    bool approved,
    bytes calldata signature  // EIP-712 signature
) external;
```

#### 2. **Proposal Voting Logic - Share-Weighted Tracking**

**CRITICAL**: Proposals track TWO vote metrics:
1. **Vote counts** (yesVotes, noVotes) - number of voters
2. **Vote balances** (yesBalance, noBalance) - share-weighted voting power

```solidity
struct Proposal {
    // ... other fields ...
    uint256 yesVotes;      // COUNT of yes voters
    uint256 noVotes;       // COUNT of no voters
    uint256 yesBalance;    // SHARE-WEIGHTED yes votes (for quorum)
    uint256 noBalance;     // SHARE-WEIGHTED no votes
}
```

**Quorum Calculation**:
```solidity
// Proposal passes if:
// 1. yesBalance >= (totalShares * quorumPercent) / 10000
// 2. yesBalance > noBalance (simple majority)
```

#### 3. **setUp() Initialization Parameters**

**Complete parameter structure** (11 parameters):
```solidity
function setUp(bytes memory _initializationParams) external {
    (
        address _lootToken,
        address _sharesToken,
        address _avatar,              // Quai Vault
        address _forwarder,           // EIP-2771 forwarder or address(0)
        address _multisendLibrary,    // For batched execution
        bytes memory _governanceConfig,
        address[] memory _shamans,
        uint256[] memory _shamanPermissions,
        address[] memory _initMembers,
        uint256[] memory _initShareAmounts,
        uint256[] memory _initLootAmounts
    ) = abi.decode(_initializationParams, (...));

    // Decode governance config (6 params)
    (votingPeriod, gracePeriod, proposalOffering,
     quorumPercent, sponsorThreshold, minRetentionPercent) =
        abi.decode(_governanceConfig, (uint32, uint32, uint256, uint256, uint256, uint256));
}
```

#### 4. **Ragequit Fair Share Calculation**

**Formula** (must implement exactly):
```solidity
function ragequit(address to, uint256 sharesToBurn, uint256 lootToBurn, address[] calldata tokens) {
    uint256 totalToBurn = sharesToBurn + lootToBurn;
    uint256 totalSupply = totalShares + totalLoot;

    // Check retention: remaining supply >= total * minRetentionPercent / 10000
    require(
        totalSupply - totalToBurn >= (totalSupply * minRetentionPercent) / 10000,
        "Baal: insufficient retention"
    );

    // For each guild token:
    for (uint256 i = 0; i < tokens.length; i++) {
        require(guildTokensEnabled[tokens[i]], "Baal: token not enabled");

        uint256 balance = IERC20(tokens[i]).balanceOf(avatar);
        uint256 fairShare = (balance * totalToBurn) / totalSupply;

        // Execute withdrawal via IAvatar
        IAvatar(avatar).execTransactionFromModule(
            tokens[i],
            0,
            abi.encodeWithSignature("transfer(address,uint256)", to, fairShare),
            Enum.Operation.Call
        );
    }

    // Burn shares/loot
    sharesToken.burn(msg.sender, sharesToBurn);
    lootToken.burn(msg.sender, lootToBurn);
}
```

#### 5. **Proposal Expiration Logic**

```solidity
function processProposal(uint32 id, bytes calldata proposalData) external {
    Proposal storage prop = proposals[id];

    // Check expiration (if set)
    if (prop.expiration != 0) {
        require(block.timestamp <= prop.expiration, "Baal: proposal expired");
    }

    // ... rest of processing
}
```

#### 6. **Gas Limit Handling (baalGas)**

**Purpose**: Limit gas for proposal execution to prevent griefing

```solidity
function processProposal(uint32 id, bytes calldata proposalData) external {
    Proposal storage prop = proposals[id];

    // Execute with gas limit
    bool success;
    if (prop.baalGas > 0) {
        success = IAvatar(avatar).execTransactionFromModule{gas: prop.baalGas}(...);
    } else {
        success = IAvatar(avatar).execTransactionFromModule(...);
    }

    prop.status[3] = !success; // actionFailed
}
```

#### 7. **IBaalToken Interface Definition**

**Must create interface**:
```solidity
interface IBaalToken is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
}
```

#### 8. **MultiSend Library - Use Existing**

**Do NOT reimplement MultiSend**. Use deployed contract:
- Address: `0x000bf87B9a7D4Bf60F95e0a27A6254dE7655b345` (Cyprus1)
- Only need encoding utilities for client-side use
- Library call via DelegateCall during proposal execution

#### 9. **Additional Shamans to Consider**

From INITIAL_PLAN.md complete list:
- ✅ OnboarderShaman (priority: HIGH)
- ✅ EthOnboarderShaman (priority: HIGH)
- ✅ SimpleOnboarderShaman (priority: MEDIUM)
- ⚠️ MultiplyOnboarderShaman (priority: MEDIUM) - token with multiplier
- ✅ CheckInShamanV2 (priority: HIGH)
- ✅ SubscriptionShaman (priority: MEDIUM)
- ⚠️ NFTClaimerShaman (priority: LOW) - NFT-gated claims
- ⚠️ CommunityVeto (priority: LOW) - loot holder veto power

**Recommendation**: Implement first 3 onboarders + CheckIn in Phase 3. Defer others to Phase 4.

#### 10. **TributeMinion.sol - Missing from Plan**

**Purpose**: Escrow tribute tokens during proposal voting

```solidity
contract TributeMinion {
    // Hold tokens in escrow
    // Release to DAO if proposal passes
    // Return to proposer if defeated/cancelled
}
```

**Priority**: MEDIUM (useful for funding proposals)

#### 11. **Poster.sol Event Name**

Verify event name (likely `NewPost`, but confirm from EIP-3722):
```solidity
event NewPost(address indexed user, string content, string indexed tag);
```

#### 12. **Missing Test Scenarios**

Add to integration tests:
- [ ] Proposal expiration (submit, wait past expiration, attempt process)
- [ ] Gas limit enforcement (baalGas)
- [ ] Quorum failure (insufficient yes votes)
- [ ] Retention percentage violation during ragequit
- [ ] Sponsor threshold edge cases
- [ ] Linked list integrity (prevProposalId)
- [ ] Admin/Manager/Governor locks (prevent new shamans after lock)

---

### 📋 Enhanced Requirements Checklist

#### Phase 1 Enhancement:

**Baal.sol Core Functions** (add to Week 2):
- [ ] View functions: state(), getProposalStatus(), getCurrentVotes(), getPriorVotes()
- [ ] Helper: hashOperation() for proposal data hashing
- [ ] totalShares(), totalLoot(), totalSupply() views
- [ ] Share-weighted vote tracking (yesBalance, noBalance)
- [ ] Quorum calculation logic
- [ ] Expiration validation

**Token Contract Enhancements**:
- [ ] Define IBaalToken interface
- [ ] Ensure pause/unpause exposed
- [ ] Batch operations support (arrays)

#### Phase 2 Enhancement:

**BaalSummoner Enhancements**:
- [ ] Handle complex setUp() with 11 parameters
- [ ] Validate array lengths match (shamans/permissions, members/shares/loot)
- [ ] Emit SetupComplete with all fields per spec

**MultiSend Integration**:
- [ ] Reference existing MultiSend at 0x000bf87B9a7D4Bf60F95e0a27A6254dE7655b345
- [ ] Client-side encoding utilities only

#### Phase 3 Enhancement:

**Ragequit Enhancements**:
- [ ] Precise fair share calculation
- [ ] Retention percentage enforcement
- [ ] Multiple token withdrawal
- [ ] Handle native QUAI (address(0) or WQUAI)

**Baal-Only Functions**:
- [ ] setShamans (batch set/remove)
- [ ] setGuildTokens (batch enable/disable)
- [ ] Lock functions (one-way, permanent)
- [ ] executeAsBaal (self-execution)

**Additional Contracts**:
- [ ] TributeMinion.sol (escrow mechanism)

#### Phase 4 (Optional/Future):

**Meta-Transactions**:
- [ ] submitVoteWithSig (EIP-712)
- [ ] EIP-2771 forwarder integration
- [ ] Signature validation

**Additional Shamans**:
- [ ] MultiplyOnboarderShaman
- [ ] NFTClaimerShaman
- [ ] CommunityVeto

---

### 🎯 Priority Additions to Implementation

**Week 2 (Baal Core) - Add**:
1. Implement yesBalance/noBalance tracking (not just counts)
2. Add quorum calculation logic
3. Implement all view functions
4. Add expiration validation

**Week 3 (Summoner) - Add**:
1. Full 11-parameter setUp() decoding
2. Array length validation
3. Complete SetupComplete event

**Week 4 (Extensions) - Add**:
1. Precise ragequit math with retention check
2. All Baal-only functions (setShamans, setGuildTokens, locks)
3. executeAsBaal implementation

**Week 5 (Shamans) - Add**:
1. TributeMinion.sol
2. MultiplyOnboarderShaman (if time permits)

---

### 📊 Updated Timeline with Enhancements

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| Setup | 1 day | Project structure, Hardhat config |
| Tokens + Interfaces | 4 days | BaalVotes, Shares, Loot, IBaalToken |
| Baal Core + Views | 7 days | Full proposal lifecycle + all view functions |
| Summoner + MultiSend | 4 days | Factory with complete setUp() |
| Extensions + Baal-Only | 6 days | Ragequit, locks, governance, TributeMinion |
| Shamans (4 types) | 6 days | Onboarder×3, CheckIn |
| Testing + Docs | 4 days | Integration tests, deployment, docs |

**Updated Total: 32 days (~6.5 weeks)** for complete implementation

**MVP (Phases 1-2): ~2.5 weeks** for working governance + factory

---

### 🔒 Security Considerations (New Section)

**Reentrancy Protection**:
- Baal external calls to IAvatar (trusted)
- Ragequit loops over tokens (use Checks-Effects-Interactions)
- Shaman mint/burn operations (owner-only)

**Access Control**:
- Shaman permissions strictly enforced (bitmask validation)
- Locks are permanent (no unlock function)
- setUp() can only be called once (initializer pattern)

**Integer Overflow/Underflow**:
- Solidity 0.8.22 has built-in overflow protection
- Explicit checks for percentage calculations (basis points)

**Gas Griefing**:
- baalGas limits proposal execution gas
- Array operations (shamans, members) need reasonable limits

**Proposal Data Integrity**:
- Hash verification prevents data manipulation
- proposalData must match original submission

---

### 📚 Prerequisites for Implementation (New Section)

**Required Knowledge**:
- Solidity 0.8.x (intermediate to advanced)
- ERC20/ERC20Votes (OpenZeppelin v5)
- Proxy patterns (EIP-1167 minimal proxies)
- Zodiac module standard
- Hardhat development environment
- TypeScript for tests and scripts

**Recommended Reading**:
- [MolochDAO V3 (Baal) Documentation](https://moloch.daohaus.fun)
- [Zodiac Standard](https://github.com/gnosis/zodiac)
- [EIP-1167: Minimal Proxy Contract](https://eips.ethereum.org/EIPS/eip-1167)
- [EIP-712: Typed Structured Data Hashing](https://eips.ethereum.org/EIPS/eip-712)
- [EIP-3722: Poster](https://eips.ethereum.org/EIPS/eip-3722)

**Reference Implementations**:
- [HausDAO/Baal](https://github.com/HausDAO/Baal) - feat/baalZodiac branch (Baal governance contracts)
- [HausDAO/baal-tokens](https://github.com/HausDAO/baal-tokens) (SharesERC20, LootERC20 patterns)
- [HausDAO/baal-shamans](https://github.com/HausDAO/baal-shamans) (Shaman implementations)
- [Quai-Vault/quaivault-contracts](https://github.com/Quai-Vault/quaivault-contracts) - **EXCELLENT reference for Hardhat setup on Quai Network** (includes hardhat.config.ts, deployment patterns, Quai-specific configurations)

---

## Quick Reference: Implementation Checklist

### Phase 1: Foundation
- [ ] Project setup (Hardhat, package.json, tsconfig)
- [ ] Copy IAvatar.sol, Enum.sol from Quai Vault
- [ ] Create IBaalToken interface
- [ ] BaalVotes.sol (checkpoints, delegation, getPriorVotes)
- [ ] SharesERC20.sol (extends BaalVotes, pausable, owner-only mint/burn)
- [ ] LootERC20.sol (basic ERC20, pausable, owner-only mint/burn)
- [ ] **Baal.sol - State**:
  - [ ] All state variables (avatar, tokens, governance config, proposals, shamans)
  - [ ] Proposal struct with ALL 12 fields (including prevProposalId, yesBalance, noBalance)
  - [ ] Constants (ADMIN=1, MANAGER=2, GOVERNOR=4)
- [ ] **Baal.sol - setUp()**:
  - [ ] Decode 11 parameters from bytes
  - [ ] Decode 6 governance config params
  - [ ] Initialize tokens, shamans, initial members
  - [ ] Emit SetupComplete with array of guildTokens
- [ ] **Baal.sol - Proposals**:
  - [ ] submitProposal (hash storage, auto-sponsor, offering)
  - [ ] sponsorProposal (linked list, timing)
  - [ ] submitVote (dual tracking: counts + balances)
  - [ ] processProposal (hash verify, IAvatar exec, passed logic)
  - [ ] cancelProposal
- [ ] **Baal.sol - Views**:
  - [ ] state() - computed from timestamps
  - [ ] getProposalStatus() - bool[4]
  - [ ] getCurrentVotes() / getPriorVotes()
  - [ ] totalShares() / totalLoot() / totalSupply()
  - [ ] hashOperation()
- [ ] Unit tests (>85% coverage)

### Phase 2: Factory
- [ ] **BaalSummoner.sol**:
  - [ ] Clone Baal, Shares, Loot
  - [ ] Encode 11-parameter setUp()
  - [ ] Array validation (lengths match)
  - [ ] Event: SetupComplete
- [ ] **BaalAndVaultSummoner.sol**:
  - [ ] Integrate QuaiVaultFactory
  - [ ] CREATE2 vault creation
  - [ ] summonBaalAndVault()
  - [ ] Existing vault scenario
  - [ ] Document: enableModule must be called by vault owners
- [ ] MultiSend encoding utilities (client-side)
- [ ] Integration tests (vault integration, module calls)

### Phase 3: Extensions
- [ ] **Ragequit**:
  - [ ] Fair share calculation: (balance * toBurn) / totalSupply
  - [ ] Retention check: remaining >= total * minRetentionPercent / 10000
  - [ ] Guild token validation
  - [ ] IAvatar withdrawals
  - [ ] Burn shares/loot
- [ ] **Baal-Only Functions**:
  - [ ] setShamans (array, permission validation, locks check)
  - [ ] setGuildTokens (enable/disable array)
  - [ ] lockAdmin / lockManager / lockGovernor
  - [ ] executeAsBaal (self-execution)
- [ ] **Shaman Functions**:
  - [ ] mintShares / mintLoot (arrays, manager check)
  - [ ] burnShares / burnLoot (arrays, manager check)
  - [ ] setAdminConfig (pause tokens, admin check)
  - [ ] setGovernanceConfig (decode 6 params, governor check)
- [ ] **Poster.sol**:
  - [ ] post(content, tag)
  - [ ] Event: NewPost
- [ ] **TributeMinion.sol** (optional):
  - [ ] Escrow tribute tokens
  - [ ] Release on pass / return on defeat
- [ ] Integration tests (ragequit, shamans, governance changes)

### Phase 4: Shamans
- [ ] **OnboarderShaman**:
  - [ ] ETH → shares/loot with multiplier
  - [ ] Expiry validation
  - [ ] Minimum tribute
  - [ ] Manager permission
- [ ] **EthOnboarderShaman**:
  - [ ] Simple variant with pricePerUnit
- [ ] **SimpleOnboarderShaman**:
  - [ ] 1:1 ERC20 → shares/loot
- [ ] **CheckInShamanV2**:
  - [ ] Periodic claims (interval)
  - [ ] Miss tracking (maxMissed)
  - [ ] lastClaimTimestamp per member
- [ ] Unit tests for each shaman

### Critical Validations (Test Every One)
- [ ] Event schemas match INITIAL_PLAN.md (parameter order, indexed)
- [ ] Quorum calculation correct (basis points)
- [ ] Proposal expiration enforced
- [ ] Gas limit (baalGas) enforced
- [ ] Linked list integrity (prevProposalId)
- [ ] Share-weighted voting (yesBalance, not just yesVotes)
- [ ] Auto-delegation on first mint
- [ ] Shaman permission bitmasks (not ==, use &)
- [ ] Array length validation (setUp params, mint/burn arrays)
- [ ] Retention percentage math (ragequit)
- [ ] No duplicate tokens in ragequit
- [ ] Hash verification (processProposal)
- [ ] IAvatar return value checked
- [ ] Locks are permanent (no unlock)
- [ ] setUp can only be called once

---

## Next Steps After Plan Approval

1. Initialize npm project and Hardhat
2. Setup directory structure (including tools/, interfaces/)
3. Copy IAvatar.sol and Enum.sol from Quai Vault
4. Create IBaalToken.sol interface
5. Create initial test fixtures with proper setup encoding
6. Begin BaalVotes.sol implementation
7. Set up continuous integration for test coverage tracking

---

## Plan Approval Checklist

Before proceeding to implementation, confirm:
- [ ] All audit findings addressed in plan
- [ ] Event schemas match INITIAL_PLAN.md specification
- [ ] Timeline is realistic (32 days / ~6.5 weeks)
- [ ] All critical functions identified
- [ ] Integration patterns validated against Quai Vault
- [ ] Testing strategy comprehensive
- [ ] Deployment tracking structure in place
- [ ] Common pitfalls documented

**Plan Version**: 1.1 (Audited)
**Last Updated**: 2026-02-10
**Status**: Ready for Approval
