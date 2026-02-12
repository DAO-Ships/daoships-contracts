# Deployed Contract Addresses (Cyprus1 - Orchard Testnet)

## Quai Vault Infrastructure

These contracts are deployed and maintained by the Quai Vault team:

| Contract | Address | Purpose |
|----------|---------|---------|
| **QuaiVault Implementation** | `0x00707D5c7e35253265267DE764d2625cAb04082C` | Proxy target for vault logic |
| **QuaiVaultFactory** | `0x005261a837f1eFEa0e23b66dc526EB6054FD2250` | Factory for creating new vaults |
| **MultiSend Library** | `0x000bf87B9a7D4Bf60F95e0a27A6254dE7655b345` | Batched transaction execution |

**Note**: These addresses are referenced in `.env.example` and used by deployment scripts.

---

## Quai DAO Launcher (Deployed)

**Deployment Date**: February 11, 2026
**Deployer**: `0x007204C0F8eB96e207482e1C472E4f74309aDb86`
**Network**: Cyprus1 (Orchard Testnet)
**Chain ID**: 15000

### Core Contracts

| Contract | Address | Deployment Status |
|----------|---------|-------------------|
| **Poster** | `0x00412000a0eE9fB82F14CAE5545206F762E3F4f5` | ✅ Deployed |
| **BaalSingleton** | `0x00287459E248A39DCFb71e14BB015536C2375005` | ✅ Deployed |
| **SharesERC20Singleton** | `0x0060099443743A4c7a55D33c4823e86Fd7f326C5` | ✅ Deployed |
| **LootERC20Singleton** | `0x000bA76250BDD3082F283dD98E0325230d2aEc99` | ✅ Deployed |
| **BaalSummoner** | `0x00690ca9ec2aad0dBf6E634D2F9b37e9E8Fb8f33` | ✅ Deployed |
| **BaalAndVaultSummoner** | `0x00362B640c816FC889a60e1745CdC2802fE337CC` | ✅ Deployed |

### Shaman Contracts

| Contract | Address | Deployment Status |
|----------|---------|-------------------|
| **OnboarderShaman** | `0x004a47d46422E0A0CDA211F7F39D0090b8F2A02F` | ✅ Deployed |
| **EthOnboarderShaman** | `0x006d2EB3E2292c50d3894aA547FcdDdF8a3D5668` | ✅ Deployed |
| **CheckInShamanV2** | `0x005d25C034606c459fA333BB5a016717D186EAd3` | ✅ Deployed |

---

## Environment Configuration

Your `.env` file should contain these deployed addresses:

```bash
# Network Configuration
RPC_URL=https://rpc.orchard.quai.network
CHAIN_ID=15000

# Quai Vault Infrastructure (Pre-deployed by Quai Vault team)
QUAI_VAULT_IMPLEMENTATION=0x00707D5c7e35253265267DE764d2625cAb04082C
QUAI_VAULT_FACTORY=0x005261a837f1eFEa0e23b66dc526EB6054FD2250
MULTISEND_LIBRARY=0x000bf87B9a7D4Bf60F95e0a27A6254dE7655b345

# DAO Launcher Contracts (Deployed Feb 11, 2026)
POSTER=0x00412000a0eE9fB82F14CAE5545206F762E3F4f5
BAAL_SINGLETON=0x00287459E248A39DCFb71e14BB015536C2375005
SHARES_SINGLETON=0x0060099443743A4c7a55D33c4823e86Fd7f326C5
LOOT_SINGLETON=0x000bA76250BDD3082F283dD98E0325230d2aEc99
BAAL_SUMMONER=0x00690ca9ec2aad0dBf6E634D2F9b37e9E8Fb8f33
BAAL_AND_VAULT_SUMMONER=0x00362B640c816FC889a60e1745CdC2802fE337CC

# Shaman Contracts (Deployed Feb 11, 2026)
ONBOARDER_SHAMAN=0x004a47d46422E0A0CDA211F7F39D0090b8F2A02F
ETH_ONBOARDER_SHAMAN=0x006d2EB3E2292c50d3894aA547FcdDdF8a3D5668
CHECKIN_SHAMAN=0x005d25C034606c459fA333BB5a016717D186EAd3
```

---

## Deployment History

The contracts were deployed using the following commands:

```bash
# 1. Compile contracts
npm run compile

# 2. Deploy core contracts (Poster, Singletons, Factories)
npm run deploy:all

# 3. Deploy shaman contracts
npm run deploy:shamans

# 4. Update environment files with deployed addresses
npm run update-env
```

**Deployment Artifacts**: See `deployments/` directory for full deployment history.

---

## Verification

After deployment, verify contracts on Quai Explorer:

```bash
# Verify Baal singleton
npx hardhat verify --network cyprus1 <BAAL_ADDRESS>

# Verify BaalSummoner
npx hardhat verify --network cyprus1 <SUMMONER_ADDRESS> <BAAL_ADDRESS> <SHARES_ADDRESS> <LOOT_ADDRESS>
```

---

## References

- **Quai Vault Repository**: [github.com/Quai-Vault/quaivault-contracts](https://github.com/Quai-Vault/quaivault-contracts)
- **MultiSend Source**: Gnosis Safe compatible library for batched execution
- **Cyprus1 Explorer**: [cyprus1.colosseum.quaiscan.io](https://cyprus1.colosseum.quaiscan.io)

---

**Last Updated**: 2026-02-11
**Network**: Cyprus1 (Orchard Testnet)
**Status**: ✅ Fully Deployed (all 9 contracts deployed and tested)
