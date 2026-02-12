# Quai DAO Launcher - Smart Contracts

> **MolochDAO V3 (Baal) for Quai Network** • Complete governance framework with Quai Vault treasury integration

[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](./LICENSE)
[![Solidity](https://img.shields.io/badge/solidity-^0.8.22-lightgrey)](https://soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/hardhat-2.19-yellow)](https://hardhat.org/)

## 🚀 Live Deployment

**Network**: Quai Orchard Testnet (Cyprus1)
**Chain ID**: 15000
**Deployed**: February 11, 2026
**Status**: ✅ Production Ready (All 9 contracts deployed and tested)

### Core Contracts

| Contract | Address |
|----------|---------|
| **Poster** | [`0x00412000a0eE9fB82F14CAE5545206F762E3F4f5`](https://cyprus1.colosseum.quaiscan.io/address/0x00412000a0eE9fB82F14CAE5545206F762E3F4f5) |
| **BaalSingleton** | [`0x00287459E248A39DCFb71e14BB015536C2375005`](https://cyprus1.colosseum.quaiscan.io/address/0x00287459E248A39DCFb71e14BB015536C2375005) |
| **SharesERC20Singleton** | [`0x0060099443743A4c7a55D33c4823e86Fd7f326C5`](https://cyprus1.colosseum.quaiscan.io/address/0x0060099443743A4c7a55D33c4823e86Fd7f326C5) |
| **LootERC20Singleton** | [`0x000bA76250BDD3082F283dD98E0325230d2aEc99`](https://cyprus1.colosseum.quaiscan.io/address/0x000bA76250BDD3082F283dD98E0325230d2aEc99) |
| **BaalSummoner** | [`0x00690ca9ec2aad0dBf6E634D2F9b37e9E8Fb8f33`](https://cyprus1.colosseum.quaiscan.io/address/0x00690ca9ec2aad0dBf6E634D2F9b37e9E8Fb8f33) |
| **BaalAndVaultSummoner** | [`0x00362B640c816FC889a60e1745CdC2802fE337CC`](https://cyprus1.colosseum.quaiscan.io/address/0x00362B640c816FC889a60e1745CdC2802fE337CC) |

### Shaman Contracts (Singletons)

| Contract | Address |
|----------|---------|
| **OnboarderShaman** | [`0x004a47d46422E0A0CDA211F7F39D0090b8F2A02F`](https://cyprus1.colosseum.quaiscan.io/address/0x004a47d46422E0A0CDA211F7F39D0090b8F2A02F) |
| **EthOnboarderShaman** | [`0x006d2EB3E2292c50d3894aA547FcdDdF8a3D5668`](https://cyprus1.colosseum.quaiscan.io/address/0x006d2EB3E2292c50d3894aA547FcdDdF8a3D5668) |
| **CheckInShamanV2** | [`0x005d25C034606c459fA333BB5a016717D186EAd3`](https://cyprus1.colosseum.quaiscan.io/address/0x005d25C034606c459fA333BB5a016717D186EAd3) |

### Pre-deployed Quai Vault Infrastructure

| Contract | Address |
|----------|---------|
| **QuaiVaultFactory** | [`0x005261a837f1eFEa0e23b66dc526EB6054FD2250`](https://cyprus1.colosseum.quaiscan.io/address/0x005261a837f1eFEa0e23b66dc526EB6054FD2250) |
| **QuaiVault Implementation** | [`0x00707D5c7e35253265267DE764d2625cAb04082C`](https://cyprus1.colosseum.quaiscan.io/address/0x00707D5c7e35253265267DE764d2625cAb04082C) |
| **MultiSend Library** | [`0x000bf87B9a7D4Bf60F95e0a27A6254dE7655b345`](https://cyprus1.colosseum.quaiscan.io/address/0x000bf87B9a7D4Bf60F95e0a27A6254dE7655b345) |

👉 **See [DEPLOYMENT_ADDRESSES.md](./DEPLOYMENT_ADDRESSES.md) for complete deployment information**

## 📚 Documentation

### Core Documentation

| Document | Description |
|----------|-------------|
| **[README.md](./README.md)** | 📖 Main documentation, quick start, overview (this file) |
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | 🏗️ System design, data flow, security model |
| **[GOVERNANCE.md](./GOVERNANCE.md)** | 🗳️ Complete proposal lifecycle and voting mechanics |
| **[CHANGELOG.md](./CHANGELOG.md)** | 📝 Version history, architectural decisions, migrations |

### Deployment & Operations

| Document | Description |
|----------|-------------|
| **[DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)** | 🚀 Step-by-step deployment workflow and troubleshooting |
| **[DEPLOYMENT_ADDRESSES.md](./DEPLOYMENT_ADDRESSES.md)** | 📍 Current contract addresses and deployment info |
| **[SHAMAN_DEPLOYMENT.md](./SHAMAN_DEPLOYMENT.md)** | 🧙 Shaman-specific deployment instructions |

### Development & Testing

| Document | Description |
|----------|-------------|
| **[E2E_TESTING.md](./E2E_TESTING.md)** | 🧪 Complete E2E testing guide (20/20 event coverage) |
| **[SHAMAN_PATTERNS.md](./SHAMAN_PATTERNS.md)** | 🔧 Shaman implementation patterns and examples |

### Security

| Document | Description |
|----------|-------------|
| **[SECURITY_AUDIT.md](./SECURITY_AUDIT.md)** | 🔒 Security audit findings and recommendations |

## Overview

The Quai DAO Launcher enables deploying fully-functional DAOs on Quai Network with:

- ✅ **Share-weighted governance** via proposal voting
- ✅ **Treasury management** through Quai Vault (Zodiac-compatible)
- ✅ **Flexible membership** with voting shares and non-voting loot
- ✅ **Exit mechanism** (ragequit) for proportional asset withdrawal
- ✅ **Modular extensions** (Shamans) for onboarding, subscriptions, etc.
- ✅ **Gas-efficient deployment** using EIP-1167 minimal proxies

## Quick Start

### Prerequisites

- Node.js v18+ and npm
- Quai Network wallet with testnet QUAI
- Basic understanding of DAOs and governance

**Note**: This repository is **standalone** - all required Quai Vault artifacts are included in `quaiVaultArtifacts/`. You do not need to clone the Quai Vault repository separately.

### Installation

```bash
git clone https://github.com/QuaiDAO/qdl-contracts.git
cd qdl-contracts
npm install
```

### Compile Contracts

```bash
npm run compile
```

### Run Tests

```bash
# All tests
npm run test

# Unit tests only
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests (local, fast governance)
npm run test:e2e:local

# E2E tests (deployed contracts on testnet)
npm run test:e2e

# With coverage
npm run test:coverage

# With gas reporting
npm run test:gas
```

**E2E Testing Setup**:
For comprehensive end-to-end testing with fast governance parameters:

```bash
# Copy E2E environment template
cp .env.e2e.example .env.e2e

# Edit .env.e2e with test wallet keys
# These should be test wallets with small amounts of testnet QUAI

# Run local E2E tests (uses 60s voting, 30s grace period)
npm run test:e2e:local
```

### Deploy Your Own Instance

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your private key
# CYPRUS1_PK=0x...

# Deploy to Quai testnet
npm run deploy:all

# Update .env with deployed addresses
npm run update-env

# (Optional) Deploy shamans for onboarding and rewards
npm run deploy:shamans

# Update .env again with shaman addresses
npm run update-env
```

**Shaman Deployment** (optional):

Shamans are modular extensions for onboarding and rewards:
- **OnboarderShaman**: QUAI → shares/loot with configurable multiplier
- **EthOnboarderShaman**: Simple QUAI → shares conversion (name for compatibility)
- **CheckInShamanV2**: Periodic check-in rewards for engagement

```bash
# Deploy shamans (after deploying core contracts)
npm run deploy:shamans

# Update environment with shaman addresses
npm run update-env
```

Configure shaman parameters in `.env` or `.env.e2e` before deploying:
```bash
# OnboarderShaman (QUAI → shares)
ONBOARDER_SHARES_PER_QUAI=20000     # 1 QUAI = 1 share
ONBOARDER_MIN_TRIBUTE=0.01          # Minimum: 0.01 QUAI

# EthOnboarderShaman (accepts QUAI on Quai Network)
QUAI_ONBOARDER_PRICE_PER_UNIT=0.1   # 0.1 QUAI per share

# CheckInShamanV2
CHECKIN_INTERVAL=86400              # 24 hours
CHECKIN_REWARD_SHARES=10            # 10 shares per check-in
```

### Summon a DAO

**Fully Automated Deployment**

```bash
npm run summon-dao
```

This creates a complete, operational DAO in **3 automated transactions** (for 1/1 vaults):

**Transaction 1** - Atomic deployment (creates 4 contracts):
- ✅ Quai Vault (multisig treasury)
- ✅ Baal (governance contract)
- ✅ SharesERC20 (voting tokens)
- ✅ LootERC20 (non-voting tokens)

**Transaction 2** - Automated proposal:
- ✅ Submits `enableModule(baalAddress)` proposal to vault

**Transaction 3** - Auto-approval and execution (1/1 vaults only):
- ✅ Approves and executes the enableModule proposal
- ✅ Baal is now enabled as a module on the vault
- 🎉 **DAO is immediately operational!**

**For multisig vaults** (threshold > 1): Transactions 1-2 complete automatically, TX3 approves on behalf of deployer, additional owners must approve via vault UI.

**Configuration** (optional, via `.env`):

```bash
# Vault Configuration
# Default: Creates a 1/1 vault (single owner = deployer, threshold = 1)
# This allows the deployer to approve the enableModule proposal in a single transaction
VAULT_OWNERS=0x007204...,0x00Another...  # Comma-separated (defaults to deployer)
VAULT_THRESHOLD=1                         # Required signatures (defaults to 1)

# DAO Member Configuration
DAO_MEMBERS=0x007204...,0x00Member2...   # Comma-separated (defaults to deployer)
DAO_SHARES=100,50,25                      # In QUAI, must match members length
DAO_LOOT=0,25,10                          # In QUAI, must match members length
```

**What Gets Created:**

| Component | Description | Owner/Control |
|-----------|-------------|---------------|
| **Quai Vault** | Multisig treasury holding assets | Vault owners (via threshold) |
| **Baal** | Governance contract | DAO members (via proposals) |
| **SharesERC20** | Voting tokens | Baal contract (mint via proposals/shamans) |
| **LootERC20** | Non-voting tokens | Baal contract (mint via proposals/shamans) |

**After Deployment:**

**For 1/1 Vaults (Default):**
- ✅ **No additional steps!** The DAO is immediately operational after `summon-dao` completes
- Start using your DAO right away:
  - Submit proposals via `Baal.submitProposal()`
  - Vote with your shares
  - Execute passed proposals to control vault assets

**For Multisig Vaults:**
1. **Additional approvals required** in the Quai Vault UI:
   - Deployer's approval is already submitted automatically
   - Other vault owners connect to vault at the deployed address
   - View pending proposals and approve the `enableModule(baalAddress)` transaction
   - Once threshold reached (e.g., 2/3), any owner can execute

2. **Your DAO is operational!** Once the module is enabled:
   - Submit proposals via `Baal.submitProposal()`
   - Vote with your shares
   - Execute passed proposals to control vault assets

**Important Notes:**
- **1/1 Vault Default**: ✨ **Fully automated!** Perfect for solo founders - zero manual steps, ~2 minutes from start to operational DAO, can add co-owners later
- **Multisig Vault**: Set `VAULT_THRESHOLD` ≥ 2 for team DAOs requiring coordination (deployer approval automated, others via vault UI)
- **Vault Owners**: Control emergency actions (can disable Baal module if needed)
- **DAO Members**: Control governance (proposals, voting, treasury spending via proposals)
- **Salt Mining**: Takes ~1-30 seconds per contract (4 total: vault, shares, loot, baal)
- **Composition Pattern**: Uses proven DAOhaus architecture, no external self-call issues
- **Total Time**: ~2 minutes for 1/1 vault (fully automated), ~5 minutes for multisig (with coordination)

## Architecture

### System Overview

```
┌─────────────────┐
│   Frontend      │ ← Users interact
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    Indexer      │ ← Listens for events
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│         Quai Network (Cyprus1)              │
│                                             │
│  ┌────────────────────────────────────┐    │
│  │  BaalSummoner (Factory)            │    │
│  │  Creates DAO instances via clones  │    │
│  └──────────────┬─────────────────────┘    │
│                 │                           │
│                 ▼                           │
│  ┌────────────────────────────────────┐    │
│  │  Baal (DAO Instance)               │    │
│  │  • Proposals & voting              │    │
│  │  • Shaman management               │    │
│  │  • Member tracking                 │    │
│  └──────┬──────────────────┬──────────┘    │
│         │                   │               │
│         ▼                   ▼               │
│  ┌─────────────┐    ┌─────────────┐        │
│  │ SharesERC20 │    │ LootERC20   │        │
│  │ (Voting)    │    │ (Economic)  │        │
│  └─────────────┘    └─────────────┘        │
│         │                                   │
│         │ executes via IAvatar              │
│         ▼                                   │
│  ┌────────────────────────────────────┐    │
│  │  Quai Vault (Treasury)             │    │
│  │  Multi-sig safe holding assets     │    │
│  └────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

### Key Concepts

**1. Baal (DAO Core)**
- Manages proposal lifecycle: submit → vote → process
- Tracks member voting power via ERC20Votes checkpoints
- Executes approved proposals via Quai Vault (IAvatar)

**2. SharesERC20 (Voting Token)**
- ERC20Votes with timestamp-based snapshots
- Auto-delegates to self on first mint
- Only Baal can mint/burn

**3. LootERC20 (Economic Token)**
- Non-voting ERC20
- Represents economic stake without governance rights
- Counts toward ragequit fair share

**4. Shamans (Extensions)**
- Privileged contracts with permissions on Baal
- Can mint/burn tokens, pause, change governance
- Examples: OnboarderShaman, CheckInShaman

**5. Quai Vault Integration**
- DAO doesn't hold assets directly
- Vault = Treasury (Gnosis Safe pattern)
- Baal = Module on vault (can execute txs)

## Project Structure

```
qdl-contracts/
├── contracts/
│   ├── core/                 # Core governance
│   │   ├── Baal.sol
│   │   ├── BaalSummoner.sol
│   │   └── BaalAndVaultSummoner.sol
│   ├── tokens/               # Voting & economic tokens
│   │   ├── BaalVotes.sol
│   │   ├── SharesERC20.sol
│   │   └── LootERC20.sol
│   ├── shamans/              # Modular extensions
│   │   ├── OnboarderShaman.sol
│   │   ├── EthOnboarderShaman.sol
│   │   └── CheckInShamanV2.sol
│   ├── tools/                # Supporting contracts
│   │   └── Poster.sol
│   ├── libraries/            # Utility libraries
│   │   └── Enum.sol
│   ├── interfaces/           # Contract interfaces
│   │   ├── IBaal.sol
│   │   ├── IBaalToken.sol
│   │   ├── IBaalSummoner.sol
│   │   ├── IQuaiVaultFactory.sol
│   │   └── IAvatar.sol
│   └── test/                 # Test mocks
│       └── MockAvatar.sol
├── test/
│   ├── unit/                 # Unit tests
│   │   ├── Baal.test.ts
│   │   └── SharesERC20.test.ts
│   ├── integration/          # Integration tests
│   │   └── BaalIntegration.test.ts
│   ├── fixtures.ts           # Test fixtures
│   └── fixtures-simple.ts    # Simplified test setup
├── scripts/
│   ├── deploy/               # Deployment scripts
│   │   ├── 001_deploy_poster.ts
│   │   ├── 002_deploy_singletons.ts
│   │   └── 003_deploy_factories.ts
│   ├── deploy-all.ts         # Full deployment orchestration
│   ├── summon-dao.ts         # Atomic DAO + Vault creation
│   └── update-env.ts         # Update .env with addresses
├── quaiVaultArtifacts/       # Quai Vault compiled artifacts
│   ├── QuaiVault.json        # (makes repo standalone)
│   ├── QuaiVaultProxy.json
│   └── README.md
├── deployments/              # Deployment records
│   ├── deployment-complete-*.json
│   └── atomic-dao-vault-*.json
├── hardhat.config.ts         # Hardhat configuration
├── package.json              # Dependencies & scripts
└── README.md                 # This file
```

## Core Contracts

### Governance

| Contract | LOC | Description |
|----------|-----|-------------|
| **Baal.sol** | 1,147 | Core governance engine with proposals, voting, execution |
| **BaalSummoner.sol** | 204 | Factory for deploying Baal instances via EIP-1167 clones |
| **BaalAndVaultSummoner.sol** | 158 | Factory that creates both Baal and Quai Vault atomically |

### Tokens

| Contract | LOC | Description |
|----------|-----|-------------|
| **BaalVotes.sol** | 278 | Abstract base with timestamp-based voting checkpoints |
| **SharesERC20.sol** | 133 | Voting token (ERC20Votes) with auto-delegation |
| **LootERC20.sol** | 106 | Non-voting economic token |

### Shamans

| Shaman | Purpose | Permissions |
|--------|---------|-------------|
| **OnboarderShaman** | ETH → shares/loot with multiplier | MANAGER |
| **EthOnboarderShaman** | Simple ETH tribute at fixed rate | MANAGER |
| **SimpleOnboarderShaman** | 1:1 token swap | MANAGER |
| **CheckInShamanV2** | Periodic claims for engagement | MANAGER |

### Tools

| Contract | Description |
|----------|-------------|
| **Poster.sol** | EIP-3722 on-chain metadata storage |
| **MockAvatar.sol** | Test implementation of IAvatar |

## Governance Parameters

Each DAO configures these at creation (changeable via proposal):

| Parameter | Typical Value | Description |
|-----------|---------------|-------------|
| **votingPeriod** | 7 days | Duration members can vote |
| **gracePeriod** | 3 days | Time to ragequit after vote ends |
| **proposalOffering** | 0.1 QUAI | Fee to submit proposal (spam prevention) |
| **quorumPercent** | 20% (2000 bp) | Min % of shares voting yes to pass |
| **sponsorThreshold** | 1 share | Min shares to auto-sponsor proposals |
| **minRetentionPercent** | 66% (6600 bp) | Min % of supply that must remain after ragequit |

**Basis Points**: 10000 = 100%, so 2000 = 20%, 6600 = 66%

## Usage Examples

### Summon a New DAO

```typescript
import { BaalAndVaultSummoner__factory } from './typechain-types';
import { parseEther, AbiCoder } from 'quais';

const summoner = BaalAndVaultSummoner__factory.connect(
  '0x00719d00ADEFEc8c22366eb45A56920B9e2389F1', // Deployed BaalAndVaultSummoner
  signer
);

// Configure governance parameters
const governanceConfig = AbiCoder.defaultAbiCoder().encode(
  ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
  [
    7 * 24 * 60 * 60,    // voting period: 7 days
    3 * 24 * 60 * 60,    // grace period: 3 days
    parseEther("0.1"),   // proposal offering: 0.1 QUAI
    2000,                // quorum: 20%
    parseEther("1"),     // sponsor threshold: 1 share
    6600                 // min retention: 66%
  ]
);

// Configure initialization
const initParams = AbiCoder.defaultAbiCoder().encode(
  ["address", "address", "address", "address", "address", "bytes", "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]"],
  [
    ZeroAddress,            // lootToken (filled by BaalSummoner)
    ZeroAddress,            // sharesToken (filled by BaalSummoner)
    ZeroAddress,            // avatar (filled with vault address)
    ZeroAddress,            // forwarder (not using meta-tx)
    multisendLibrary,       // multisend library
    governanceConfig,       // governance config
    [],                     // shamans (none initially)
    [],                     // shaman permissions
    [founderAddress],       // initial members
    [parseEther("175")],    // initial shares
    [parseEther("0")]       // initial loot
  ]
);

// Summon atomically (creates vault + DAO in one tx)
const tx = await summoner.summonBaalAndVault(
  initParams,
  [],                              // no initialization actions
  [founderAddress],                // vault owners
  1,                               // vault threshold (1/1)
  vaultSalt,                       // mined salts...
  sharesSalt,
  lootSalt,
  baalSalt
);

const receipt = await tx.wait();
const event = receipt.events?.find(e => e.event === 'SummonBaalAndVault');

console.log(`Vault: ${event.args.vault}`);
console.log(`Baal:  ${event.args.baal}`);
console.log(`Next: Approve enableModule proposal in vault UI`);
```

### Submit a Proposal

```typescript
// Simple funding proposal: send 10 QUAI from treasury
const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "uint256", "bytes"],
  [recipientAddress, parseEther("10"), "0x"]
);

const tx = await baal.submitProposal(
  proposalData,
  0, // No expiration
  0, // No gas limit
  "Fund community event", // Description or IPFS hash
  { value: await baal.proposalOffering() }
);

await tx.wait();
console.log("Proposal submitted!");
```

### Vote on Proposal

```typescript
// Vote yes on proposal #1
const tx = await baal.submitVote(1, true);
await tx.wait();

console.log("Voted yes!");
```

### Process Approved Proposal

```typescript
// After voting + grace period
const tx = await baal.processProposal(proposalId, proposalData);
await tx.wait();

// Check if execution succeeded
const proposal = await baal.proposals(proposalId);
console.log("Passed:", proposal.status[2]);
console.log("Action failed:", proposal.status[3]);
```

## Integration

### For Indexers

Listen for these events:

- `SummonComplete`: New DAO created
- `SetupComplete`: DAO initialized
- `SubmitProposal`: New proposal
- `SubmitVote`: Member voted
- `ProcessProposal`: Proposal executed
- `Ragequit`: Member exited

**Example**:
```typescript
baal.on("SubmitProposal", (proposalId, dataHash, votingPeriod, data, expiration, selfSponsor, timestamp, details) => {
  console.log(`New proposal ${proposalId}: ${details}`);
  // Store in database for indexing
});
```

### For SDKs

Use TypeChain-generated types:

```typescript
import { Baal__factory, BaalSummoner__factory } from './typechain-types';

// Connect to deployed contracts
const baal = Baal__factory.connect(baalAddress, provider);

// Query DAO state
const totalShares = await baal.totalShares();
const votingPeriod = await baal.votingPeriod();
const proposal = await baal.proposals(proposalId);
```

### For Frontends

```typescript
// Connect wallet
const provider = new BrowserProvider(window.ethereum, { usePathing: true });
const signer = await provider.getSigner();

// Interact with DAO
const baal = Baal__factory.connect(baalAddress, signer);

// Submit vote
await baal.submitVote(proposalId, true);
```

## Development

### Adding Features

1. **Create Contract**: Add to appropriate `contracts/` subdirectory
2. **Write Tests**: Add unit tests in `test/unit/`, integration in `test/integration/`
3. **Document**: Update relevant docs (ARCHITECTURE, GOVERNANCE, API)
4. **Deploy**: Add deployment script if needed

### Testing Best Practices

- ✅ Achieve >85% code coverage
- ✅ Test all event emissions
- ✅ Validate access control
- ✅ Test edge cases and failures
- ✅ Use fixtures for consistent state

### Gas Optimization Tips

- Use minimal proxies (EIP-1167) for deployment
- Store proposal hashes, not full data
- Batch operations when possible
- Use timestamp checkpoints (not block numbers)

## Security

### Audited Patterns

- **Reentrancy**: Uses OpenZeppelin's `ReentrancyGuard`
- **Access Control**: Shaman permission bitmasks
- **Integer Math**: Solidity 0.8.22 built-in overflow protection
- **Proposal Integrity**: Hash verification prevents manipulation

### Known Considerations

- **Vault Owners**: Retain emergency control (can disable Baal module)
- **Gas Griefing**: `baalGas` parameter limits proposal execution gas
- **Timestamp Manipulation**: Tolerated (±900s doesn't affect outcomes)
- **Upgrades**: No proxy pattern, migration required for major changes

## Resources

### Official Links

- **Deployed Contracts**: [DEPLOYMENT_ADDRESSES.md](./DEPLOYMENT_ADDRESSES.md)
- **Deployment Guide**: [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)
- **Changelog**: [CHANGELOG.md](./CHANGELOG.md)

### References

- **MolochDAO V3 Docs**: [moloch.daohaus.fun](https://moloch.daohaus.fun)
- **HausDAO Baal**: [github.com/HausDAO/Baal](https://github.com/HausDAO/Baal)
- **Quai Vault**: [github.com/Quai-Vault/quaivault-contracts](https://github.com/Quai-Vault/quaivault-contracts)
- **Zodiac Standard**: [github.com/gnosis/zodiac](https://github.com/gnosis/zodiac)

### Related Repositories

- **Indexer**: [github.com/QuaiDAO/qdl-indexer](https://github.com/QuaiDAO/qdl-indexer)
- **SDK**: [github.com/QuaiDAO/qdl-sdk](https://github.com/QuaiDAO/qdl-sdk)
- **Frontend**: [github.com/QuaiDAO/qdl-app](https://github.com/QuaiDAO/qdl-app)

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Write tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

GPL-3.0-or-later - See [LICENSE](./LICENSE)

## Acknowledgments

Built on the shoulders of giants:

- **MolochDAO**: Original DAO framework
- **DAOhaus**: Baal implementation
- **Gnosis**: Safe and Zodiac patterns
- **Quai Network**: Scalable blockchain platform
- **OpenZeppelin**: Secure contract libraries

---

**Built with ❤️ for Quai Network**
