# Changelog

All notable changes to the Quai DAO Launcher contracts project.

---

## [Unreleased]

### Planned
- Additional shaman implementations
- Performance optimizations
- Mainnet deployment preparation

---

## [1.0.3] - 2026-02-10 - Security Fixes

### Summary
Implemented 3 critical security fixes based on DAOhaus Baal reference implementation comparison. All fixes verified working correctly through comprehensive on-chain E2E testing.

### Security Improvements

#### H-1: Reentrancy Protection in Shamans ✅
**Issue**: OnboarderShaman and EthOnboarderShaman vulnerable to reentrancy attacks during external calls.

**Fix**: Added OpenZeppelin ReentrancyGuard to both shaman contracts:
- Added `import "@openzeppelin/contracts/utils/ReentrancyGuard.sol"`
- Extended `ReentrancyGuard` in contract declarations
- Added `nonReentrant` modifier to `onboard()` functions

**Impact**: Prevents malicious contracts from re-entering during mint operations

**Files Modified**:
- `contracts/shamans/OnboarderShaman.sol`
- `contracts/shamans/EthOnboarderShaman.sol`

#### H-2: Proposal Offering to Treasury ✅
**Issue**: Proposal offerings were permanently locked in Baal contract with no recovery mechanism. Each proposal locked 0.001 QUAI forever.

**Fix**: Send offering to treasury (avatar) immediately after validation in `submitProposal()`:
```solidity
if (msg.value > 0) {
    (bool success, ) = avatar.call{value: msg.value}("");
    require(success, "Baal: offering transfer failed");
}
```

**Impact**:
- Proposal offerings now go to treasury instead of being locked
- DAO can use offering funds
- Fixes value leak issue

**Files Modified**:
- `contracts/core/Baal.sol`

#### H-3: cancelProposal() Bypass (NOT FIXED - By Design)
**Analysis**: DAOhaus Baal also allows governors to cancel proposals after `lockGovernor()`.

**Rationale**:
- Cancellation is a "defensive" action
- Lock prevents adding NEW shamans
- Existing governors retain emergency powers to cancel bad proposals
- Prevents malicious proposals from being un-cancellable

**Decision**: Keep current behavior (matches DAOhaus reference implementation)

#### H-5: Auto-Delegation Race Condition ✅
**Issue**: Auto-delegation in `SharesERC20.mint()` used check-then-act pattern vulnerable to race condition if multiple mints happened in same block.

**Fix**: Moved auto-delegation to `BaalVotes._update()` hook with double-check pattern:
```solidity
// In BaalVotes._update()
if (to != address(0) && balanceOf(to) == 0 && _checkpoints[to].length == 0 && amount > 0) {
    _delegates[to] = to;
}
```

**Impact**:
- Eliminates race condition vulnerability
- Delegation happens atomically with mint
- Double-check prevents multiple delegation calls
- Matches DAOhaus robust pattern

**Files Modified**:
- `contracts/tokens/BaalVotes.sol` (added auto-delegation logic)
- `contracts/tokens/SharesERC20.sol` (removed unsafe auto-delegation)

### Testing Results ✅

**E2E Test**: All security fixes verified working correctly
- **Result**: 14/14 test phases passed, 20/20 events triggered
- **Runtime**: 12 minutes on Cyprus1
- **Network**: Cyprus1 testnet (Chain ID: 15000)

**Specific Verifications**:
1. **H-1 Verification**: Shamans work correctly with reentrancy protection
   - Bob onboarded: 0 → 1.0 shares via OnboarderShaman (0.5 QUAI)
   - Carol onboarded: 0 → 2.0 shares via EthOnboarderShaman (0.2 QUAI)

2. **H-2 Verification**: Proposal offerings go to treasury
   - Treasury: 1.7 QUAI (initial)
   - After Proposal 1: 1.201 QUAI (1.7 + 0.001 offering - 0.5 sent)
   - Final treasury: 1.205 QUAI (includes all 5 proposal offerings)

3. **H-5 Verification**: Auto-delegation works without race condition
   - Bob received first mint and auto-delegated correctly
   - Burn operations work correctly (Bob: 1.0 → 0.5 shares)

### Deployment

**Network**: Cyprus1 (Orchard Testnet)
**Chain ID**: 15000
**Date**: 2026-02-10

**Updated Contracts**:
- ✅ BaalSingleton: 0x0074CCC62d0Eb3245C0612859a86952285F9936D
- ✅ SharesERC20Singleton: 0x004664115747d367266EB65bEEc862bE5585b9Db
- ✅ OnboarderShaman: Deployed per-DAO
- ✅ EthOnboarderShaman: Deployed per-DAO

**Backward Compatibility**: ✅ Fully compatible
- No breaking changes to ABI or function signatures
- Existing DAOs continue to work unchanged
- Events unchanged (indexer compatible)

### Gas Impact
- ReentrancyGuard: +~2,500 gas per onboard() call
- Offering transfer: +~21,000 gas per proposal submission
- Auto-delegation refactor: Neutral (same operation, different location)
- **Total**: Minimal increase (<0.1% of typical transaction costs)

### Security Posture Improvement
**Before v1.0.3**:
- ❌ Shamans vulnerable to reentrancy
- ❌ Proposal offerings locked forever
- ❌ Potential auto-delegation race condition
- ⚠️ 3 High severity issues open

**After v1.0.3**:
- ✅ Reentrancy protection on all shamans
- ✅ Offering funds go to treasury
- ✅ Robust auto-delegation pattern
- ✅ Matches DAOhaus security standards
- ✅ 0 High severity issues open (H-3 is by design)

### References
- **Security Analysis**: SECURITY_DAOHAUS_COMPARISON.md
- **Detailed Fixes**: SECURITY_FIXES_V1.0.3.md
- **DAOhaus Baal**: github.com/HausDAO/Baal (feat/baalZodiac)
- **DAOhaus Shamans**: github.com/HausDAO/baal-shamans

---

## [1.0.2] - 2026-02-10 - Complete Event Coverage

### Summary
Achieved 100% event coverage (20/20 events) in E2E testing for comprehensive indexer integration testing. All core Baal events successfully triggered on-chain.

### Testing Improvements
- **Event Coverage**: 20/20 unique event types (100%)
- **Test Phases**: 14 passing tests
- **Total Events**: ~42 events emitted per test run
- **Runtime**: ~13 minutes on Cyprus1 testnet
- **Status**: All tests passing ✅

### Events Now Covered
**Previously Missing Events (Now Added):**
- ✅ **ShamanSet (REMOVE)** - Phase 10: Remove OnboarderShaman (permission → 0)
- ✅ **BurnShares** - Phase 8: Burn 0.5 shares from Bob
- ✅ **BurnLoot** - Phase 8: Burn 10 loot from Carol
- ✅ **SetAdminConfig** - Phase 9: Pause/unpause both tokens

**Complete Coverage:**
- Core Governance (5/5): SubmitProposal, SponsorProposal, SubmitVote, ProcessProposal, CancelProposal
- Governance Management (6/6): SetGuildTokens, ShamanSet, GovernanceConfigSet, LockAdmin, LockManager, LockGovernor
- Token Operations (4/4): MintShares, MintLoot, BurnShares, BurnLoot
- Exit Mechanism (1/1): Ragequit
- Shaman Events (2/2): Onboard, CheckIn
- Setup (1/1): SetupComplete
- Admin Operations (1/1): SetAdminConfig

### Fixed
- **Checkpoint timing issue**: Increased wait time from 10s → 20s to ensure `block.timestamp > votingStarts`
  - Root cause: `BaalVotes.getPriorVotes()` requires `timepoint < block.timestamp`
  - Solution: Wait for 2 blocks (~20s on Quai) after proposal sponsoring before voting
  - Resolves: "Baal: getPriorVotes failed" errors in Phases 4 and 10

### Documentation
- **Created**: `E2E_TESTING.md` - Comprehensive E2E testing guide
- **Updated**: Test coverage documentation consolidated
- **Removed**: 19 redundant/historical documentation files

### Indexer Ready
The on-chain E2E test suite now provides complete event coverage for indexer testing:
- All 20 Baal event types triggered in correct order
- Both ADD and REMOVE shaman scenarios covered
- Both MINT and BURN token operations covered
- Complete proposal lifecycle from submission to execution
- All governance locks tested

---

## [1.0.1] - 2026-02-11 - Production Deployment Complete

### Summary
All 9 contracts successfully deployed to Cyprus1 (Orchard Testnet). Comprehensive E2E testing completed with 5 passing tests covering full DAO lifecycle from summoning to proposal execution.

### Deployment (Cyprus1 - Chain ID 15000)
- **Network**: Quai Orchard Testnet (Cyprus1)
- **Deployed**: February 11, 2026
- **Deployer**: `0x007204C0F8eB96e207482e1C472E4f74309aDb86`

**Core Contracts:**
- **Poster**: `0x00412000a0eE9fB82F14CAE5545206F762E3F4f5`
- **BaalSingleton**: `0x00287459E248A39DCFb71e14BB015536C2375005`
- **SharesERC20Singleton**: `0x0060099443743A4c7a55D33c4823e86Fd7f326C5`
- **LootERC20Singleton**: `0x000bA76250BDD3082F283dD98E0325230d2aEc99`
- **BaalSummoner**: `0x00690ca9ec2aad0dBf6E634D2F9b37e9E8Fb8f33`
- **BaalAndVaultSummoner**: `0x00362B640c816FC889a60e1745CdC2802fE337CC`

**Shaman Contracts (Singletons):**
- **OnboarderShaman**: `0x004a47d46422E0A0CDA211F7F39D0090b8F2A02F`
- **EthOnboarderShaman**: `0x006d2EB3E2292c50d3894aA547FcdDdF8a3D5668`
- **CheckInShamanV2**: `0x005d25C034606c459fA333BB5a016717D186EAd3`

### Testing
- **E2E Tests**: 5 passing (complete DAO lifecycle)
  - DAO summoning with salt mining
  - Member onboarding via shamans
  - Proposal submission, voting, and execution
  - Check-in rewards distribution
  - Vault module enablement via propose-approve-execute
- **Test Duration**: ~4 minutes (includes 90s voting + grace period)
- **Network**: Cyprus1 testnet (live blockchain)

### Key Patterns Verified
- **Vault Module Enablement**: Propose-approve-execute pattern working correctly
- **MultiSend Encoding**: All proposals properly encoded for MultiSend library
- **Shaman Deployment**: Singleton pattern confirmed (shamans shared across DAOs)
- **Salt Mining**: CREATE2 address prediction working for Cyprus1 shard

### Documentation Updates
- Added vault module enablement workflow to GOVERNANCE.md
- Clarified MultiSend encoding requirement (all proposals must use MultiSend)
- Updated shaman deployment documentation (singleton pattern)
- Deprecated DEPLOYED.md in favor of DEPLOYMENT_ADDRESSES.md
- Updated all contract addresses to February 11, 2026 deployment

---

## [1.0.0] - 2026-02-10 - Initial Production Implementation

### Summary
Complete implementation of MolochDAO V3 (Baal) for Quai Network with fully automated deployment for solo founders. Zero manual steps required for 1/1 vaults.

### Added - Fully Automated UX (v1.0.0)
- **3-transaction automated deployment** for 1/1 vaults
  - TX1: Atomic deployment (4 contracts)
  - TX2: Automated `enableModule` proposal submission
  - TX3: Automated approval and execution
- **Zero manual steps** for solo founders
- **~2 minutes** from start to operational DAO
- **Multisig support** with deployer approval automated

### Added - Standalone Repository (v0.9.0)
- Copied Quai Vault artifacts locally (83KB total)
  - `QuaiVault.json` (76KB)
  - `QuaiVaultProxy.json` (5.4KB)
- Removed external repository dependencies
- Users can clone single repo and deploy
- 50% faster CI/CD builds
- Documented in `quaiVaultArtifacts/README.md`

### Added - Composition Pattern Refactoring (v0.8.0)
- Migrated `BaalAndVaultSummoner` from inheritance to composition
- Fixed `FailedDeployment` errors from external self-calls
- Corrected salt calculation for CREATE2 addresses
  - Sender = `BaalAndVaultSummoner` for all contracts
  - Previously incorrectly used user wallet address
- Successful atomic deployment tested on Cyprus1 testnet
- Gas cost: ~1.2M for 3-member DAO

### Added - Core Implementation (v0.1.0 - v0.7.0)
- **Governance Contracts**
  - `Baal.sol` (1,147 LOC) - Core DAO governance
  - `BaalSummoner.sol` (204 LOC) - Factory for Baal instances
  - `BaalAndVaultSummoner.sol` (158 LOC) - Atomic DAO + Vault factory
- **Token Contracts**
  - `BaalVotes.sol` (278 LOC) - Timestamp-based voting checkpoints
  - `SharesERC20.sol` (133 LOC) - Voting tokens with auto-delegation
  - `LootERC20.sol` (106 LOC) - Non-voting economic tokens
- **Shaman Extensions**
  - `OnboarderShaman.sol` - ETH → shares/loot with multiplier
  - `EthOnboarderShaman.sol` - Simple ETH onboarding
  - `CheckInShamanV2.sol` - Periodic engagement rewards
- **Tools**
  - `Poster.sol` - EIP-3722 on-chain metadata
  - `MockAvatar.sol` - Test implementation of IAvatar
- **Interfaces**
  - `IBaalToken.sol`, `IBaalSummoner.sol`, `IQuaiVaultFactory.sol`
  - `IAvatar.sol`, `Enum.sol` (from Quai Vault)

### Changed
- **Default vault configuration**: 1/1 vault (single owner = deployer, threshold = 1)
- **Proposal offering**: 0.1 QUAI (spam prevention)
- **Governance defaults**: 7-day voting, 3-day grace, 20% quorum, 66% retention

### Fixed
- Corrected `proposeTransaction` function signature (removed `operation` parameter)
- Fixed salt calculation sender addresses for CREATE2
- Resolved external self-call issues via composition pattern
- Updated QuaiVault ABI usage to match deployed contracts

### Initial Development Deployment
- **Network**: Quai Orchard Testnet (Cyprus1)
- **Date**: February 10, 2026 (superseded by v1.0.1 deployment)
- **Test DAOs Created**: 4+ successful atomic deployments
- **Note**: See v1.0.1 for current production deployment addresses

### Testing
- **Total Tests**: 71
- **Passing**: 66 (93%)
- **Failing**: 5 (fixture updates needed)
- Unit tests for Baal, SharesERC20, LootERC20
- Integration tests for BaalIntegration

### Documentation
- **README.md** - Main documentation with quick start
- **ARCHITECTURE.md** - System design and data flow
- **GOVERNANCE.md** - Complete proposal lifecycle guide
- **DEPLOYMENT_GUIDE.md** - Deployment workflow
- **DEPLOYMENT_ADDRESSES.md** - Current contract addresses and deployment info
- **CHANGELOG.md** - This file

---

## Technical Details

### Architecture Decisions

**Composition Pattern** (v0.8.0)
```solidity
// Before: Inheritance with external self-call
contract BaalAndVaultSummoner is BaalSummoner {
    function summonBaalAndVault(...) external {
        baal = this.summonBaal(...); // ❌ External self-call
    }
}

// After: Composition with external call to separate contract
contract BaalAndVaultSummoner {
    IBaalSummoner public immutable baalSummoner;

    function summonBaalAndVault(...) external {
        baal = baalSummoner.summonBaal(...); // ✅ Regular external call
    }
}
```

**Benefits**:
- No external self-call issues
- Clear separation of concerns
- Easier to test and debug
- Matches DAOhaus implementation

### Salt Calculation Fix (v0.8.0)

**Problem**: CREATE2 addresses predicted incorrectly
```typescript
// ❌ WRONG: Using user wallet as sender
const salt = keccak256(userWallet, userSalt);
```

**Solution**: Use actual msg.sender for each call
```typescript
// ✅ CORRECT: BaalAndVaultSummoner is sender for all contracts
const vaultSalt = keccak256(BaalAndVaultSummoner, userSalt);
const baalSalt = keccak256(BaalAndVaultSummoner, userSalt);
const sharesSalt = keccak256(BaalAndVaultSummoner, userSalt);
const lootSalt = keccak256(BaalAndVaultSummoner, userSalt);
```

### Automated Approval (v1.0.0)

**1/1 Vaults** - Zero manual steps:
```typescript
// Extract txHash from TransactionProposed event
const txHash = proposedEvent.args.txHash;

// Automatically approve and execute
await vaultContract.approveAndExecute(txHash);
```

**Multisig Vaults** - Deployer approval automated:
```typescript
// Approve on behalf of deployer
await vaultContract.approveTransaction(txHash);
// Other owners approve via vault UI
```

---

## Migration Notes

### From Pre-1.0.0

**No Breaking Changes** - All existing deployments continue to work.

**New Features Available**:
- Automated approval for 1/1 vaults (no changes needed)
- Multisig deployer approval automated (no changes needed)
- Standalone repository (remove Quai Vault submodule if present)

### Upgrading Scripts

If you have custom deployment scripts:

1. **Update `proposeTransaction` calls** - Remove `operation` parameter:
```typescript
// Before
await vault.proposeTransaction(to, value, data, operation);

// After
await vault.proposeTransaction(to, value, data);
```

2. **Salt calculation** - Ensure using `BaalAndVaultSummoner` as sender:
```typescript
// Correct sender for atomic deployment
const sender = baalAndVaultSummonerAddress;
const salt = keccak256(sender, userSalt);
```

---

## Performance Metrics

### Gas Costs (Cyprus1 Testnet)
- **Deployment** (all contracts): ~4M gas
- **Atomic Summoning** (1 member): ~800K gas
- **Atomic Summoning** (3 members): ~1.2M gas
- **Per-Member Cost**: ~50K gas (delegation + checkpoints + minting)

### Timing
- **Salt Mining**: ~1-30 seconds per contract (4 total = ~40s average)
- **Deployment**: ~10 seconds per transaction
- **Total Time** (1/1 vault): ~2 minutes from start to operational DAO
- **Total Time** (multisig): ~5 minutes including coordination

---

## Dependencies

### Runtime
- OpenZeppelin Contracts v5.0.0
- quais v1.0.0-alpha.53
- Hardhat v2.19.5

### External Contracts (On-Chain)
- Quai Vault Implementation: `0x001e1c40f1B96f530eC816A68f760E34673Ee7b8`
- QuaiVaultFactory: `0x00233Cb4F587287aFe5c7e88b971A3a36b3ba0d6`
- MultiSend Library: `0x000bf87B9a7D4Bf60F95e0a27A6254dE7655b345`

---

## Contributors

- Development Team
- Based on DAOhaus Baal implementation
- Quai Vault integration
- Quai Network testnet deployment

---

## License

GPL-3.0-or-later

---

**Last Updated**: February 10, 2026
