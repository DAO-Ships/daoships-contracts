# DAO Ships — Smart Contracts

> **A DAO framework and launchpad for Quai Network, inspired by MolochV3** · Complete governance framework with Quai Vault treasury integration

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Solidity](https://img.shields.io/badge/solidity-^0.8.22-lightgrey)](https://soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/hardhat-2.19-yellow)](https://hardhat.org/)

## Live Deployment

**Network**: Quai Orchard Testnet (Cyprus1) · **Chain ID**: 15000 · **Status**: ✅ Production Ready

### Core Contracts

| Contract | Address |
|----------|---------|
| **Poster** | `0x000fDaA55dD7d46b5802250F932d0fEd5465E0f8` |
| **DAOShipSingleton** | `0x00670fa8666615Fb9Ad971EE829fa2333e866c5b` |
| **SharesERC20Singleton** | `0x007522Ae0576a9e1B88751E18dbD31Cb6D952e57` |
| **LootERC20Singleton** | `0x00334AFfcC0e61fd734134ddcd4524ecCB7eF6A8` |
| **DAOShipLauncher** | `0x007e532914AF668F40590d1BdB62d714F0dF84Bd` |
| **DAOShipAndVaultLauncher** | `0x006d31EE6E7A2A800693B52Bcf2E7C8d137DBa53` |

### Navigator Singletons

| Contract | Address |
|----------|---------|
| **OnboarderNavigator** | `0x0031C843A919dFc022DeA5A809B693009A29464b` |

### Quai Vault Infrastructure (pre-deployed)

| Contract | Address |
|----------|---------|
| **QuaiVaultFactory** | `0x00613Bd358C36Bed84bf64A9F1bC632d3125779b` |
| **QuaiVault Implementation** | `0x0006bFD36432079e4E813E383A8FD60f7a131388` |
| **MultiSend Library** | `0x00465B948541CE357ea54BD3C3d8B9995097d199` |

---

## Documentation

| Document | Description |
|----------|-------------|
| **[README.md](./README.md)** | This file — overview, quick start, integration guide |
| **[SECURITY_GUIDE.md](./SECURITY_GUIDE.md)** | Operator security manual, deployment checklists |
| **[SECURITY-AUDIT.md](./SECURITY-AUDIT.md)** | Consolidated audit report, findings, threat models |
| **[DAO-CONFIGURATIONS.md](./DAO-CONFIGURATIONS.md)** | 5 reference configurations for different DAO types |
| **[DAOSHIPS_VS_ZODIAC_BAAL.md](./DAOSHIPS_VS_ZODIAC_BAAL.md)** | Technical comparison: DAO Ships vs upstream zodiacBaal / MolochV3 |
| **[docs/NAVIGATORS.md](./docs/NAVIGATORS.md)** | Navigator ecosystem: shipped, planned, implementation designs, and guidelines |
| **[docs/POSTER.md](./docs/POSTER.md)** | Poster protocol: domain schema, content schemas, integration patterns for metadata |
| **[docs/INDEXER-GUIDE.md](./docs/INDEXER-GUIDE.md)** | Indexer developer guide: every event, database schema, handler specs, migration reference |

---

## Overview

DAO Ships deploys fully operational DAOs on Quai Network:

- **Share-weighted governance** via proposal voting
- **Treasury management** through Quai Vault (Zodiac IAvatar-compatible)
- **Dual token model**: voting shares + non-voting loot
- **Ragequit**: proportional treasury exit during grace period
- **Navigators**: permissioned extensions for onboarding, automation, and more
- **Gas-efficient deployment**: EIP-1167 minimal proxies (~300K gas vs 4M for singleton)
- **Deterministic addresses**: shard-aware CREATE2 salt mining for Cyprus1 `0x00` prefix

> **See [DAOSHIPS_VS_ZODIAC_BAAL.md](./DAOSHIPS_VS_ZODIAC_BAAL.md)** for a full technical comparison against the upstream HausDAO Baal (MolochV3) — covering all Quai-specific fixes, governance improvements, and API changes.

---

## Quick Start

### Prerequisites

- Node.js v18+
- Quai Network wallet with testnet QUAI
- [Quai Vault](https://github.com/Quai-Vault/quaivault-contracts) pre-deployed (addresses above)

> **Standalone repo**: all Quai Vault artifacts are bundled in `quaiVaultArtifacts/`. No separate clone needed.

### Install & Compile

```bash
git clone https://github.com/QuaiDAO/daoships-contracts.git
cd daoships-contracts
npm install
npm run compile
```

### Run Tests

```bash
# Unit + local E2E
npm run test

# Unit tests only
npm run test:unit

# On-chain E2E (requires .env.e2e with testnet keys)
npm run test:e2e:onchain
```

### E2E Testing Setup

```bash
cp .env.e2e.example .env.e2e
# Fill in private keys for deployer, alice, bob, carol
# Default governance: 3min voting, 60s grace — runs in ~20-30min total
npm run test:e2e:onchain
```

### Deploy Contracts

```bash
cp .env.example .env
# Set CYPRUS1_PK=0x...

npm run deploy:all          # Deploys poster, singletons, factories
npm run update-env          # Writes addresses to .env

npm run deploy:navigators      # (optional) Deploy OnboarderNavigator, ERC20TributeNavigator
npm run update-env
```

### Create a DAO

```bash
npm run create-dao
```

Creates a complete DAO in a single transaction:

1. **Atomic deploy** — Quai Vault (with DAOShip as initial module) + DAOShip + SharesERC20 + LootERC20

Module enablement is atomic: `DAOShipAndVaultLauncher` predicts the DAOShip address, creates the vault with `initialModules=[predictedDAOShip]`, then deploys DAOShip. No separate `enableModule` step is needed.

**Result**: DAOShip is an enabled module on the vault immediately. Governance proposals execute via `execTransactionFromModule`.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Quai Network (Cyprus1)              │
│                                                     │
│  DAOShipAndVaultLauncher ──────────────────────────┐  │
│     │ (CREATE2 clone + ERC1967 proxy)            │  │
│     ▼                                            │  │
│  DAOShip (governance)                               │  │
│  ├── SharesERC20  (voting token)                 │  │
│  ├── LootERC20    (economic token)               │  │
│  └── Navigators      (permissioned extensions)      │  │
│         │                                        │  │
│         │ execTransactionFromModule              │  │
│         ▼                                        │  │
│  QuaiVaultProxy (ERC1967 treasury) ◄─────────────┘  │
│     └── QuaiVault implementation                    │
└─────────────────────────────────────────────────────┘
```

**Key relationships:**
- DAOShip is a *module* on the vault — it calls `execTransactionFromModule` to spend treasury funds
- The vault (`avatar`) holds all assets; DAOShip holds none
- Proposals execute via DelegateCall to MultiSendCallOnly, which is whitelisted in the vault's `delegatecallAllowed` mapping
- Navigators are trusted contracts with bitmask permissions (ADMIN=1, MANAGER=2, GOVERNOR=4)

---

## Project Structure

```
daoships-contracts/
├── contracts/
│   ├── core/                   # Governance engine
│   │   ├── DAOShip.sol
│   │   ├── DAOShipLauncher.sol
│   │   └── DAOShipAndVaultLauncher.sol
│   ├── tokens/                 # Voting & economic tokens
│   │   ├── DAOShipVotes.sol
│   │   ├── SharesERC20.sol
│   │   └── LootERC20.sol
│   ├── navigators/                # Modular extensions
│   │   ├── OnboarderNavigator.sol     (QUAI → shares/loot, multiplier or fixed-price)
│   │   └── ERC20TributeNavigator.sol  (ERC20 → shares/loot)
│   ├── interfaces/
│   │   ├── IAvatar.sol           (LGPL-3.0-only, Gnosis-derived)
│   │   ├── IDAOShipToken.sol
│   │   ├── IDAOShipLauncher.sol
│   │   └── IQuaiVaultFactory.sol
│   ├── tools/
│   │   └── Poster.sol
│   ├── libraries/
│   │   ├── DAOShipUtils.sol
│   │   └── Enum.sol              (LGPL-3.0-only, Gnosis-derived)
│   └── test/                   # Test mocks & helpers
│       ├── MockAvatar.sol
│       ├── MockERC20.sol
│       ├── MockQuaiVaultFactory.sol
│       ├── MockDelegatecallGuardAvatar.sol
│       ├── MultiSend.sol         (LGPL-3.0-only, Gnosis-derived)
│       ├── MultiSendCallOnly.sol (LGPL-3.0-only, Gnosis-derived)
│       └── SimpleExecutor.sol
├── test/
│   ├── unit/
│   │   ├── DAOShip.test.ts
│   │   ├── DAOShipGaps.test.ts
│   │   ├── DAOShipAndVaultLauncher.test.ts
│   │   ├── CoverageGaps.test.ts
│   │   ├── SharesERC20.test.ts
│   │   ├── Navigators.test.ts
│   │   ├── DelegatecallGuard.test.ts
│   │   └── MultiSend.test.ts
│   ├── e2e/
│   │   ├── local/              # Fast Hardhat tests
│   │   │   ├── FullDAOLifecycle.test.ts
│   │   │   ├── GovernanceAndEvents.test.ts
│   │   │   └── Ragequit.test.ts
│   │   └── onchain/            # Live Cyprus1 tests
│   │       ├── DeployedDAO.test.ts
│   │       └── OnChainDAOLifecycle.test.ts
│   └── fixtures.ts
├── scripts/
│   ├── deploy-all.ts               # Canonical deployment: poster + singletons + factories
│   ├── deploy/
│   │   └── 004_deploy_navigators.ts  # Per-DAO navigator deployment (OnboarderNavigator, ERC20TributeNavigator)
│   ├── create-dao.ts
│   ├── update-env.ts
│   └── replace-navigator.ts       # Governance helper: replace navigator via proposal
├── quaiVaultArtifacts/         # Bundled vault ABIs & bytecode
│   ├── QuaiVault.json
│   ├── QuaiVaultProxy.json
│   ├── MultiSend.json
│   ├── MultiSendCallOnly.json
│   └── README.md
├── deployment-addresses.json
├── .env.example
├── .env.e2e.example
└── hardhat.config.ts
```

---

## Contracts Reference

### Core

| Contract | Description |
|----------|-------------|
| **DAOShip.sol** | Governance engine: proposals, voting, ragequit, navigator management |
| **DAOShipLauncher.sol** | EIP-1167 clone factory for DAOShip + token instances |
| **DAOShipAndVaultLauncher.sol** | Atomic factory: one tx creates DAOShip + Quai Vault |

### Tokens

| Contract | Description |
|----------|-------------|
| **SharesERC20.sol** | Voting token with timestamp checkpoints, auto-delegation |
| **LootERC20.sol** | Non-voting economic token, counts toward ragequit share |
| **DAOShipVotes.sol** | Abstract base: timestamp-based voting power & `getPriorVotes()` |

### Navigators

| Navigator | Permissions | Description |
|--------|-------------|-------------|
| **OnboarderNavigator** | MANAGER (2) | QUAI → shares/loot. Dual mode: multiplier (basis points) or fixed-price with refund. Merkle allowlist, mint cap, expiry. |
| **ERC20TributeNavigator** | MANAGER (2) | ERC20 → shares/loot. SafeERC20, fee-on-transfer rejection, per-token pricing. |

### Tools

| Contract | Description |
|----------|-------------|
| **Poster.sol** | [EIP-3722](https://eips.ethereum.org/EIPS/eip-3722) on-chain content bus. Emits `NewPost(user, content, tag)` with zero state storage. Used by indexers and frontends to attach metadata to DAOs, proposals, and members. |

`post(content, tag)` is the primary entry point. Content is typically an IPFS hash or JSON string; tag is a namespaced string used for filtering (e.g. `"daoships.launcher.daoProfile"`, `"proposal"`). Because only events are emitted, gas cost is minimal — around 25K gas regardless of content length.

**Navigator permissions** are additive bitmasks:
- `1` ADMIN — pause/unpause tokens
- `2` MANAGER — mint and burn shares/loot
- `4` GOVERNOR — cancel proposals, set governance config
- Combined: `3` = ADMIN+MANAGER, `6` = MANAGER+GOVERNOR, `7` = full access

---

## Governance Parameters

Each DAO configures these at launching (changeable via governance proposal):

| Parameter | Typical | Agent DAO Min | Description |
|-----------|---------|---------------|-------------|
| **votingPeriod** | 7 days | **60 seconds** | Duration members can vote |
| **gracePeriod** | 3 days | 0 seconds | Window to ragequit after voting ends |
| **proposalOffering** | 0.1 QUAI | 0 | Native tokens required to submit |
| **quorumPercent** | 2000 bp | 0 | Min % of shares voting YES (basis points: 10000 = 100%) |
| **sponsorThreshold** | 1 share | 0 | Min shares to auto-sponsor a proposal |
| **minRetentionPercent** | 6600 bp | 0 | Min % supply remaining after ragequit batch |

> **Basis points**: All percentage parameters use basis points. Pass `2000` for 20%, `10000` for 100%. Passing raw percentages (e.g., `20`) will create near-zero thresholds — a critical misconfiguration.

> **Agent DAOs**: `MIN_VOTING_PERIOD = 60 seconds`. Automated coordinators that can vote within seconds do not need 1-hour windows. Set `gracePeriod = 0` if ragequit protection is not needed.

---

## Proposal Lifecycle

```
Submitted → (sponsor) → Voting → Grace → Ready → Processed
                                        ↘ Defeated  (no-votes ≥ yes-votes after grace)
                                        ↘ Expired   (timestamp > expiration)
                 ↘ Cancelled            (submitter or governor)
```

**ProposalState enum**:

| Value | Name | Meaning |
|-------|------|---------|
| 0 | Unborn | Does not exist |
| 1 | Submitted | Created, awaiting sponsor |
| 2 | Voting | Voting window open |
| 3 | Cancelled | Cancelled by submitter or GOVERNOR navigator |
| 4 | Grace | Voting ended, ragequit window |
| 5 | Ready | Grace ended, passing — call `processProposal` |
| 6 | Processed | Executed |
| 7 | Defeated | Failed quorum or majority — `processProposal` accepted to clear queue |
| 8 | Expired | Expiration timestamp passed |

`processProposal` accepts both **Ready** and **Defeated** states. Defeated proposals do not block the execution queue — calling `processProposal` on a defeated proposal marks it as processed and clears the sequential lock.

---

## Usage Examples

### Create a DAO (TypeScript)

```typescript
import { quais } from "quais";

// Encode governance config
const governanceConfig = quais.AbiCoder.defaultAbiCoder().encode(
  ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
  [
    7 * 24 * 3600,       // votingPeriod: 7 days
    3 * 24 * 3600,       // gracePeriod: 3 days
    quais.parseQuai("0.1"), // proposalOffering
    2000,                // quorumPercent: 20% (basis points)
    quais.parseQuai("1"),   // sponsorThreshold: 1 share
    6600,                // minRetentionPercent: 66%
  ]
);

// Encode initialization params (avatar is ZeroAddress — replaced by DAOShipAndVaultLauncher)
const initParams = quais.AbiCoder.defaultAbiCoder().encode(
  ["address","address","address","address","bytes","address[]","uint256[]","address[]","uint256[]","uint256[]","address[]","bool","bool"],
  [
    quais.ZeroAddress,        // lootToken (filled by launcher)
    quais.ZeroAddress,        // sharesToken (filled by launcher)
    quais.ZeroAddress,        // avatar (filled with vault address)
    MULTISEND_ADDRESS,
    governanceConfig,
    [],                       // navigators
    [],                       // navigator permissions
    [founderAddress],         // members
    [quais.parseQuai("100")], // shares
    [quais.parseQuai("0")],   // loot
    [],                       // guildTokens
    false,                    // pauseSharesOnLaunch
    false,                    // pauseLootOnLaunch
  ]
);

const tx = await launcher.launchDAOShipAndVault(
  initParams, [], "MyDAO Shares", "MDS", "MyDAO Loot", "MDL",
  [founderAddress], 1, vaultSalt, sharesSalt, lootSalt, daoShipSalt
);
const receipt = await tx.wait();
// Event: LaunchDAOShipAndVault(daoShip, vault, shares, loot, newVault, launcher)
```

### Submit a Proposal

```typescript
import { encodeMultiSend } from "./helpers"; // see replace-navigator.ts for encoding helpers

// Send 10 QUAI from treasury to recipient
const proposalData = encodeMultiSend([{
  operation: 0,           // Call
  to: recipientAddress,
  value: quais.parseQuai("10"),
  data: "0x",
}]);

await daoShip.submitProposal(proposalData, 0, "Fund community event", {
  value: await daoShip.proposalOffering(),
});
```

### Post Metadata via Poster

```typescript
const POSTER_ADDRESS = "0x000fDaA55dD7d46b5802250F932d0fEd5465E0f8";
const poster = new quais.Contract(POSTER_ADDRESS, [
  "function post(string content, string tag) external",
  "event NewPost(address indexed user, string content, string indexed tag)",
], signer);

// Attach a profile to the DAO (indexers filter on tag "daoships.launcher.daoProfile")
await poster.post(
  JSON.stringify({ name: "My DAO", description: "...", logo: "ipfs://Qm..." }),
  "daoships.launcher.daoProfile"
);

// Attach rich text to a proposal (use proposalId in the tag for easy lookup)
await poster.post("ipfs://QmProposalDetails...", `proposal:${proposalId}`);

// Listen for all DAO profile posts
poster.on(poster.filters.NewPost(null, null, "daoships.launcher.daoProfile"), (user, content) => {
  console.log(`DAO profile from ${user}:`, JSON.parse(content));
});
```

Content may be a raw JSON string, an IPFS CID, or any plain text. Because `NewPost` indexes both `user` and `tag`, frontends can efficiently filter by DAO address, proposal, or content category without reading contract state.

### Replace a Navigator (Governance)

See `scripts/replace-navigator.ts` for the complete pattern: deploy new navigator → build `setNavigators()` calldata → wrap in MultiSend → submit as proposal.

### Ragequit

```typescript
// Burn 50 shares and 25 loot, receive proportional QUAI + any ERC20 guildTokens
await daoShip.ragequit(
  memberAddress,
  quais.parseQuai("50"),   // shares to burn
  quais.parseQuai("25"),   // loot to burn
  [quais.ZeroAddress],     // address(0) = native QUAI
);
```

---

## Integration

### Events to Index

| Event | Trigger |
|-------|---------|
| `NewPost` | Poster: on-chain metadata attached (DAO profile, proposal detail, member profile) |
| `SetupComplete` | DAO initialized |
| `SubmitProposal` | New proposal submitted |
| `SponsorProposal` | Proposal sponsored, voting starts |
| `SubmitVote` | Member cast a vote |
| `ProcessProposal` | Proposal executed or defeated |
| `CancelProposal` | Proposal cancelled |
| `Ragequit` | Member exited with proportional share |
| `NavigatorSet` | Navigator permission granted/revoked |
| `GovernanceConfigSet` | Governance parameters changed |
| `MintShares` / `BurnShares` | Token supply changed |
| `MintLoot` / `BurnLoot` | Loot supply changed |
| `LockAdmin` / `LockManager` / `LockGovernor` | Permission lock activated |
| `AdminConfigSet` | Token pause state changed (shares and/or loot) |

### TypeChain

```typescript
import { DAOShip__factory } from "./typechain-types";

const daoShip = DAOShip__factory.connect(daoShipAddress, provider);
const votingPeriod = await daoShip.votingPeriod();
const proposal     = await daoShip.proposals(proposalId);
const navigatorPerm   = await daoShip.navigators(navigatorAddress);
```

### Address Prediction

Before deploying, predict all four contract addresses to mine salts that satisfy the Cyprus1 `0x00` shard prefix:

```typescript
const [daoShip, shares, loot, vault] = await launcher.calculateAllAddresses(
  senderAddress,
  sharesSalt, lootSalt, daoShipSalt, vaultSalt,
  vaultOwners, threshold, 0  // minExecutionDelay
);
```

---

## Security

| Property | Implementation |
|----------|---------------|
| Reentrancy | `ReentrancyGuard` on all state-changing external functions |
| Access control | Navigator bitmask + `governanceOnly` (msg.sender == address(this)) + owner locks |
| Proposal integrity | `keccak256(abi.encode(proposalData))` stored at submission, verified at execution |
| Integer safety | Solidity 0.8.22 built-in overflow/underflow protection |
| DelegateCall | Vault uses per-target `delegatecallAllowed` whitelist; only MultiSendCallOnly is whitelisted by default |
| Token isolation | No `receive()` on DAOShip; treasury is always the vault |
| Checkpoint overflow | `uint40` timestamps (safe through year ~36,812) |

**Known considerations:**
- Vault owners retain emergency power (can disable DAOShip module)
- Proposals use all available gas; reverting proposals set `actionFailed=true` without blocking other proposals
- Timestamp tolerance: ±900s validator skew does not affect governance outcomes
- No upgrade proxy on DAOShip — migration required for major changes

---

## Development

### Adding a Navigator

1. Extend the navigator pattern from `OnboarderNavigator.sol`
2. Constructor takes `_daoShip` address; store as `DAOShip public immutable daoShip`
3. Use `(daoShip.navigators(msg.sender) & 4) != 0` for GOVERNOR auth on pause/unpause
4. Add `ReentrancyGuard`, mint cap, expiry, and Merkle allowlist where appropriate
5. See `DAO-CONFIGURATIONS.md` for the post-MVP roadmap

### Testing

```bash
npm run test              # unit + local E2E
npm run test:unit         # unit only
npm run test:e2e:onchain  # live Cyprus1 (requires .env.e2e)
npm run test:gas          # with gas reporting
npm run test:coverage     # coverage report
```

---

## Resources

- **MolochDAO V3**: [moloch.daohaus.fun](https://moloch.daohaus.fun)
- **HausDAO Baal (MolochV3)**: [github.com/HausDAO/Baal](https://github.com/HausDAO/Baal)
- **Quai Vault**: [github.com/Quai-Vault/quaivault-contracts](https://github.com/Quai-Vault/quaivault-contracts)
- **Zodiac Standard**: [github.com/gnosis/zodiac](https://github.com/gnosis/zodiac)
- **Quai Network**: [qu.ai](https://qu.ai)

---

## License

MIT — see [LICENSE](./LICENSE). Four Gnosis-derived files (`IAvatar.sol`, `Enum.sol`, `MultiSend.sol`, `MultiSendCallOnly.sol`) are LGPL-3.0-only.

## Acknowledgments

Built on the work of MolochDAO, DAOhaus, Gnosis Safe, Quai Network, and OpenZeppelin.
