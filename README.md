# Quai DAO Launcher - Contracts

MolochDAO V3 (Baal) implementation for Quai Network with Quai Vault treasury integration.

## Overview

The Quai DAO Launcher enables deploying fully-functional DAOs on Quai Network with:
- **Share-weighted governance** via proposal voting
- **Treasury management** through Quai Vault (Zodiac-compatible)
- **Voting tokens** (Shares) and economic tokens (Loot)
- **Modular extensions** (Shamans) for onboarding, subscriptions, etc.
- **Ragequit mechanism** for proportional asset withdrawal

## Architecture

Built on the proven MolochDAO V3 (Baal) framework:
- **Baal.sol**: Core governance engine
- **Zodiac Module Pattern**: Executes treasury actions via `IAvatar.execTransactionFromModule()`
- **EIP-1167 Minimal Proxies**: Gas-efficient DAO deployment
- **ERC20Votes**: Timestamp-based voting snapshots

## Quick Start

### Installation

```bash
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

# With coverage
npm run test:coverage

# With gas reporting
npm run test:gas
```

### Deploy

```bash
# Local network
npm run deploy:local

# Orchard testnet (Cyprus1)
npm run deploy:orchard
```

### Environment Setup

Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
# Edit .env with your private keys and settings
```

## Project Structure

```
qdl-contracts/
├── contracts/
│   ├── core/           # Baal, Summoners
│   ├── tokens/         # Shares, Loot, BaalVotes
│   ├── shamans/        # Onboarder, CheckIn, etc.
│   ├── tools/          # Poster (metadata)
│   ├── libraries/      # Enum, MultiSendEncoder
│   └── interfaces/     # IBaal, IBaalToken, IAvatar
├── test/
│   ├── unit/           # Token, Baal unit tests
│   └── integration/    # Summoner, lifecycle tests
├── scripts/            # Deployment and utility scripts
└── deploy/             # Hardhat deploy scripts
```

## Key Contracts

### Core Governance

| Contract | Description |
|----------|-------------|
| **Baal.sol** | Main governance contract - proposal lifecycle, voting, execution |
| **BaalSummoner.sol** | Factory for deploying Baal instances |
| **BaalAndVaultSummoner.sol** | Factory that creates both Baal and Quai Vault |

### Tokens

| Contract | Description |
|----------|-------------|
| **SharesERC20.sol** | Voting token (ERC20Votes) with delegation |
| **LootERC20.sol** | Non-voting economic token |
| **BaalVotes.sol** | Abstract base for timestamp-based voting power |

### Shamans (Extensions)

| Shaman | Purpose |
|--------|---------|
| **OnboarderShaman** | ETH → shares/loot with multiplier |
| **CheckInShamanV2** | Periodic claims for engagement |
| **EthOnboarderShaman** | Simple ETH tribute |
| **SimpleOnboarderShaman** | 1:1 token swap |

## Integration with Quai Vault

Baal acts as a Zodiac module on Quai Vault:

```solidity
// Execute treasury action
bool success = IAvatar(vault).execTransactionFromModule(
    target,
    value,
    data,
    Enum.Operation.Call
);
```

### Deployed Quai Vault Addresses (Cyprus1)

| Contract | Address |
|----------|---------|
| QuaiVaultFactory | `0x005261a837f1eFEa0e23b66dc526EB6054FD2250` |
| QuaiVault Implementation | `0x00707D5c7e35253265267DE764d2625cAb04082C` |
| MultiSend Library | `0x000bf87B9a7D4Bf60F95e0a27A6254dE7655b345` |

## Governance Parameters

DAOs can configure:
- **Voting Period**: Duration of voting (e.g., 7 days)
- **Grace Period**: Time after voting before execution (e.g., 3 days)
- **Proposal Offering**: QUAI required to submit proposal
- **Quorum**: Minimum % of shares that must vote yes (basis points)
- **Sponsor Threshold**: Shares needed to auto-sponsor proposals
- **Min Retention**: Minimum % of tokens that must remain after ragequit

## Development

### Adding New Contracts

1. Create Solidity file in appropriate directory
2. Implement required interfaces
3. Add unit tests in `test/unit/`
4. Add integration tests if needed
5. Create deployment script in `deploy/`

### Testing Best Practices

- Unit tests should achieve >85% coverage
- Test all event emissions with correct parameters
- Validate all access control modifiers
- Test edge cases and failure modes
- Integration tests should verify cross-contract interactions

### Gas Optimization

- Use minimal proxies (EIP-1167) for DAO deployment
- Store proposal hashes, not full data
- Use timestamp-based checkpoints (not block numbers)
- Batch operations where possible

## Security Considerations

- **Reentrancy**: External calls to IAvatar (trusted contract)
- **Access Control**: Shaman permissions via bitmask validation
- **Integer Math**: Solidity 0.8.22 has built-in overflow protection
- **Proposal Integrity**: Hash verification prevents data manipulation
- **Gas Griefing**: `baalGas` parameter limits execution gas

## Resources

- **Implementation Plan**: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- **Specification**: [../INITIAL_PLAN.md](../INITIAL_PLAN.md)
- **Quai Vault Repo**: [github.com/Quai-Vault/quaivault-contracts](https://github.com/Quai-Vault/quaivault-contracts)
- **HausDAO Baal**: [github.com/HausDAO/Baal](https://github.com/HausDAO/Baal)
- **MolochDAO Docs**: [moloch.daohaus.fun](https://moloch.daohaus.fun)

## License

GPL-3.0-or-later

## Contributing

This project implements the MolochDAO V3 (Baal) specification adapted for Quai Network. For questions or contributions, refer to the implementation plan.
