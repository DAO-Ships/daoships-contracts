# Deployment & Summoning Guide

Complete guide for deploying contracts and summoning DAOs on Quai Network.

## Prerequisites

1. **Environment Setup**:
   ```bash
   cp .env.example .env
   # Edit .env and set CYPRUS1_PK=your_private_key
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Compile Contracts**:
   ```bash
   npm run compile
   ```

---

## Step 1: Deploy Contracts

Deploy all contracts to Quai Network (Cyprus1 testnet):

```bash
npm run deploy:all
```

This deploys:
- **Poster** - On-chain metadata storage (EIP-3722)
- **SharesERC20 Singleton** - Voting token template
- **LootERC20 Singleton** - Non-voting token template
- **Baal Singleton** - DAO governance template
- **BaalSummoner** - Factory for Baal DAOs
- **BaalAndVaultSummoner** - Atomic DAO + Vault factory

**Update environment variables** with deployed addresses:

```bash
npm run update-env
```

This creates/updates:
- `.env` file with contract addresses
- `deployment-addresses.json` for easy reference

---

## Step 2: Summon a DAO

### Atomic DAO + Vault Deployment

```bash
npm run summon-dao
```

This creates **4 contracts in a single transaction**:
1. **Quai Vault** - Multisig treasury (via QuaiVaultFactory)
2. **SharesERC20** - Voting tokens (via BaalSummoner)
3. **LootERC20** - Non-voting tokens (via BaalSummoner)
4. **Baal** - DAO governance (via BaalSummoner)

**Features**:
- ✅ Single transaction deployment
- ✅ Predictable CREATE2 addresses
- ✅ All addresses match Cyprus1 shard (`0x00` prefix)
- ✅ ~1.2M gas for 3 members
- ✅ Composition pattern (no external self-call issues)

---

## Configuration

### Environment Variables

Edit `.env` to configure your DAO:

```bash
# Vault Configuration
VAULT_OWNERS=0x007204C0F8eB96e207482e1C472E4f74309aDb86,0x00AnotherAddress,0x00ThirdOwner
VAULT_THRESHOLD=2  # Number of signatures required (2 of 3)

# DAO Members (can be different from vault owners)
DAO_MEMBERS=0x007204C0F8eB96e207482e1C472E4f74309aDb86,0x00Member2,0x00Member3
DAO_SHARES=100,50,25      # Voting shares per member (in QUAI)
DAO_LOOT=0,25,10          # Non-voting loot per member (in QUAI)
```

**Defaults** (if not set):
- Vault: Single owner (deployer wallet), threshold = 1
- DAO: Single member (deployer wallet), 175 shares, 0 loot

---

## Post-Deployment

### Module Enablement (Automated!)

**For 1/1 Vaults (Default):**
- ✅ **Fully automated** - no manual steps required!
- The `summon-dao` script automatically:
  1. Proposes `enableModule(baalAddress)`
  2. Approves the proposal
  3. Executes the proposal
- Your DAO is immediately operational after script completion

**For Multisig Vaults:**
- ✅ **Deployer approval automated** - script approves on behalf of deployer
- ⏳ **Additional approvals needed** - other vault owners must:
  1. Connect to Quai Vault at the deployed address
  2. View pending proposals
  3. Approve the `enableModule(baalAddress)` transaction
  4. Execute once threshold reached (e.g., 2/3)

**Why this step exists:**
- Baal acts as a Zodiac module on the Quai Vault
- Only vault owners can enable modules (security feature)
- Once enabled, DAO proposals can execute vault transactions
- Prevents unauthorized module installation

---

## Deployment Outputs

All deployments are saved to `deployments/` directory:

| File | Description |
|------|-------------|
| `deployment-complete-*.json` | Full contract deployment with metadata |
| `atomic-dao-vault-*.json` | DAO summoning details and configuration |
| `deployment-addresses.json` | Latest addresses (used by summon script) |

---

## Script Reference

| Command | Description |
|---------|-------------|
| `npm run compile` | Compile Solidity contracts |
| `npm run deploy:all` | Deploy all contracts to Cyprus1 |
| `npm run update-env` | Update .env with deployed addresses |
| `npm run summon-dao` | Summon DAO + Vault atomically |
| `npm run test` | Run all tests |
| `npm run clean` | Clean artifacts and cache |

---

## Architecture

### BaalAndVaultSummoner (Composition Pattern)

The atomic deployment uses DAOHaus's proven composition pattern:

```solidity
contract BaalAndVaultSummoner {
    IBaalSummoner public immutable baalSummoner;
    address public immutable quaiVaultFactory;

    function summonBaalAndVault(...) external {
        // 1. Create Quai Vault
        vault = IQuaiVaultFactory(quaiVaultFactory).createWallet(...);

        // 2. Summon Baal (regular external call, not self-call)
        baal = baalSummoner.summonBaal(...);

        // Returns both addresses
        return (baal, vault);
    }
}
```

**Key Benefits**:
- No external self-call issues
- Clean separation of concerns
- Proven architecture (used by DAOHaus)
- Easy to test and debug

### Salt Calculation for CREATE2

**Critical**: Sender addresses for salt calculation:

```typescript
// Vault salt:
// msg.sender = BaalAndVaultSummoner (calling QuaiVaultFactory)
keccak256(BaalAndVaultSummoner, userSalt)

// Baal/Shares/Loot salts:
// msg.sender = BaalAndVaultSummoner (calling BaalSummoner)
keccak256(BaalAndVaultSummoner, userSalt)
```

The script automatically mines salts with correct sender addresses to ensure all deployed contracts have Cyprus1 shard addresses (`0x00` prefix).

---

## Troubleshooting

### Salt Mining Takes Too Long

Salt mining finds CREATE2 addresses matching Cyprus1 shard:
- **Expected**: 1-30 seconds per salt
- **If stuck**: Ctrl+C and retry (randomized search)
- **Why needed**: Quai Network requires shard-specific addresses

### Configuration Mismatch Error

If you see "BaalSummoner address mismatch":
1. Verify `deployment-addresses.json` is up to date
2. Run `npm run update-env` to refresh .env
3. Check that BaalAndVaultSummoner was deployed with correct constructor args

### Insufficient Funds

For testnet deployment, you need QUAI:
- **Deployment**: ~0.5-1 QUAI for all contracts
- **DAO Summoning**: ~0.05 QUAI per DAO (depends on # of members)
- **Get testnet QUAI**: [Quai Network Faucet](https://faucet.quai.network)

### Gas Limit Issues

If deployment fails with "out of gas":
- Current limit: 20M gas (conservative)
- Actual usage: ~1.2M for 3 members
- Each additional member adds ~50K gas

---

## Example Workflow

```bash
# 1. Setup
cp .env.example .env
# Edit .env with your CYPRUS1_PK and DAO configuration
npm install

# 2. Deploy contracts
npm run deploy:all
npm run update-env

# 3. Summon your DAO
npm run summon-dao

# 4. Enable module (via Quai Vault interface)
# vault.enableModule(baalAddress)

# 5. Start using your DAO!
# - Submit proposals
# - Vote on proposals
# - Execute approved proposals
```

---

## Gas Costs (Cyprus1 Testnet)

| Operation | Gas Used | Members |
|-----------|----------|---------|
| Deploy All Contracts | ~4M | - |
| Summon DAO (1 member) | ~800K | 1 |
| Summon DAO (3 members) | ~1.2M | 3 |
| Summon DAO (5 members) | ~1.5M | 5 |

**Note**: Each member adds ~50K gas due to:
- Auto-delegation (one-time voting setup)
- Checkpoint writes (voting power tracking)
- Token minting

---

## Resources

- **Quai Vault**: [github.com/Quai-Vault/quaivault-contracts](https://github.com/Quai-Vault/quaivault-contracts)
- **DAOHaus Baal**: [github.com/HausDAO/Baal](https://github.com/HausDAO/Baal)
- **Zodiac Standard**: [github.com/gnosis/zodiac](https://github.com/gnosis/zodiac)
- **MolochDAO V3**: [moloch.daohaus.fun](https://moloch.daohaus.fun)
- **Quai Network**: [qu.ai](https://qu.ai)

---

**Last Updated**: 2026-02-10
**Status**: Production-ready, tested on Cyprus1 testnet
