# End-to-End Tests

This directory contains E2E tests for the Quai DAO Launcher contracts.

## Quick Start

```bash
# Run on-chain lifecycle test (comprehensive)
npm run test:e2e:onchain

# Run deployment verification test
npm run test:e2e
```

## Full Documentation

For complete E2E testing documentation, see:

**📖 [docs/E2E_TESTING.md](../../docs/E2E_TESTING.md)**

Includes:
- Complete 14-phase lifecycle test breakdown
- All 20 event types coverage
- Configuration details
- Wallet funding requirements
- Indexer integration
- Troubleshooting guide

## Test Files

- **`OnChainLifecycle.test.ts`** - Complete DAO lifecycle on Cyprus1 (14 phases, 20 events)
- **`DeployedDAO.test.ts`** - Deployment verification for singletons and summoned DAOs

## Prerequisites

1. **Deployed contracts** - Run `npm run deploy:all` first
2. **Network access** - Set `RPC_URL` in `.env`
3. **Funded wallets** - Get testnet QUAI from https://faucet.quai.network

## Expected Results

- ✅ **OnChainLifecycle**: 14 phases, ~13 minutes, all events triggered
- ✅ **DeployedDAO**: Quick verification, <1 minute

See [docs/E2E_TESTING.md](../../docs/E2E_TESTING.md) for detailed expectations and troubleshooting.
