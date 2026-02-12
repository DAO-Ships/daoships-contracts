# E2E Testing Guide

Complete guide for running end-to-end tests for the Quai DAO Launcher contracts.

## Overview

The on-chain E2E test suite validates the complete DAO lifecycle on Cyprus1 testnet, triggering **all 20 core Baal events** for comprehensive indexer testing.

**Test Coverage:**
- ✅ 14/14 test phases passing
- ✅ 20/20 unique event types triggered
- ✅ ~42 total events emitted
- ✅ Runtime: ~13 minutes

## Running Tests

### On-Chain E2E Test (Cyprus1)

```bash
# Run complete lifecycle test on Cyprus1 testnet
npm run test:e2e:onchain

# Expected: 14 passing tests in ~13 minutes
```

### Unit Tests

```bash
# Run all unit tests
npm test

# Run with coverage
npm run coverage

# Run specific test file
npx hardhat test test/unit/Baal.test.ts
```

## Complete Event Coverage (20/20)

### Core Governance (5/5) ✅
1. **SubmitProposal** - Triggered in Phases 4, 6, 10, 11, 12
2. **SponsorProposal** - Triggered in Phases 4, 6, 10, 12
3. **SubmitVote** - Triggered in Phases 4, 6, 10, 12 (8 votes total)
4. **ProcessProposal** - Triggered in Phases 4, 6, 10, 12
5. **CancelProposal** - Triggered in Phase 11

### Governance Management (6/6) ✅
6. **SetGuildTokens** - Phase 12 (enable native QUAI)
7. **ShamanSet** - Phase 6 (ADD Bob as ADMIN), Phase 10 (REMOVE OnboarderShaman)
8. **GovernanceConfigSet** - Phase 12 (update quorum to 15%)
9. **LockAdmin** - Phase 12 (permanent lock)
10. **LockManager** - Phase 12 (permanent lock)
11. **LockGovernor** - Phase 12 (permanent lock)

### Token Operations (4/4) ✅
12. **MintShares** - Phases 2, 3, 5 (onboarding + check-in)
13. **MintLoot** - Phase 7 (deployer mints 50 loot to Carol)
14. **BurnShares** - Phase 8 (deployer burns 0.5 shares from Bob)
15. **BurnLoot** - Phase 8 (deployer burns 10 loot from Carol)

### Exit Mechanism (1/1) ✅
16. **Ragequit** - Phase 13 (Alice ragequits 30 shares)

### Shaman Events (2/2) ✅
17. **Onboard** - Phases 2, 3 (Bob via OnboarderShaman, Carol via EthOnboarderShaman)
18. **CheckIn** - Phase 5 (Alice claims periodic reward)

### Setup (1/1) ✅
19. **SetupComplete** - Phase 1 (DAO initialization)

### Admin Operations (1/1) ✅
20. **SetAdminConfig** - Phase 9 (pause both tokens, then unpause both)

## Test Phases Breakdown

### Phase 1: Mine Salts & Summon DAO (~120s)
- Mines CREATE2 salts for Cyprus1 shard addresses
- Deploys shamans (OnboarderShaman, EthOnboarderShaman, CheckInShamanV2)
- Summons DAO with Quai Vault via BaalAndVaultSummoner
- Enables Baal as module on vault
- Funds treasury with 1 QUAI
- **Events:** SetupComplete

### Phase 2: Bob Onboards (~5s)
- Bob sends 0.5 QUAI to OnboarderShaman
- Receives 1 share (2× multiplier)
- **Events:** Onboard, MintShares

### Phase 3: Carol Onboards (~5s)
- Carol sends 0.2 QUAI to EthOnboarderShaman
- Receives 2 shares (10× multiplier)
- **Events:** Onboard, MintShares

### Phase 4: Submit, Vote & Process Proposal (~137s)
- Submit proposal to send 0.5 QUAI to Carol
- Deployer and Alice vote YES
- Wait 90s (voting 60s + grace 30s)
- Process proposal → Carol receives funds
- **Events:** SubmitProposal, SponsorProposal, SubmitVote×2, ProcessProposal

### Phase 5: Check-In Rewards (~5s)
- Alice claims periodic check-in reward
- Receives 10 shares
- **Events:** CheckIn, MintShares

### Phase 6: Update Shamans (~132s)
- Governance proposal to add Bob as ADMIN shaman
- Deployer and Alice vote YES
- Wait 90s, process proposal
- Bob's permission changes to 1 (ADMIN)
- **Events:** SubmitProposal, SponsorProposal, SubmitVote×2, ProcessProposal, ShamanSet

### Phase 7: Mint Loot (~5s)
- Deployer (MANAGER) mints 50 loot to Carol
- **Events:** MintLoot

### Phase 8: Burn Shares & Loot (~17s)
- Deployer (MANAGER) burns 0.5 shares from Bob
- Deployer (MANAGER) burns 10 loot from Carol
- **Events:** BurnShares, BurnLoot

### Phase 9: Pause/Unpause Tokens (~21s)
- Bob (ADMIN) pauses both shares and loot tokens
- Bob (ADMIN) unpauses both tokens
- **Events:** SetAdminConfig (pause), SetAdminConfig (unpause)

### Phase 10: Remove Shaman (~133s)
- Governance proposal to remove OnboarderShaman
- Deployer and Alice vote YES
- Wait 90s, process proposal
- OnboarderShaman permission changes to 0 (removed)
- **Events:** SubmitProposal, SponsorProposal, SubmitVote×2, ProcessProposal, ShamanSet

### Phase 11: Cancel Proposal (~13s)
- Alice submits a proposal
- Alice cancels it (as submitter)
- **Events:** SubmitProposal, CancelProposal

### Phase 12: Governance Management (~145s)
- Batched governance proposal with 5 actions:
  1. Enable native QUAI as guild token
  2. Update quorum to 15%
  3. Lock admin functions (permanent)
  4. Lock manager functions (permanent)
  5. Lock governor functions (permanent)
- Deployer and Alice vote YES
- Wait 90s, process proposal
- **Events:** SubmitProposal, SponsorProposal, SubmitVote×2, ProcessProposal, SetGuildTokens, GovernanceConfigSet, LockAdmin, LockManager, LockGovernor

### Phase 13: Ragequit (~9s)
- Alice ragequits 30 shares
- Receives fair share of treasury (~0.158 QUAI)
- **Events:** Ragequit

### Phase 14: Final Summary
- Verifies all events triggered
- Reports final DAO state

## Configuration

### Environment Variables (.env.e2e)

```bash
# Network Configuration
CYPRUS1_RPC=https://rpc.orchard.quai.network

# Test Wallets (separate from mainnet!)
DEPLOYER_PRIVATE_KEY=0x...
ALICE_PRIVATE_KEY=0x...
BOB_PRIVATE_KEY=0x...
CAROL_PRIVATE_KEY=0x...

# Fast Governance for Testing
VOTING_PERIOD=60          # 1 minute (vs 7 days production)
GRACE_PERIOD=30           # 30 seconds (vs 3 days production)
PROPOSAL_OFFERING=0.001   # 0.001 QUAI
QUORUM_PERCENT=2000       # 20% (vs 33% production)
SPONSOR_THRESHOLD=1       # 1 share minimum

# Deployed Contracts (Cyprus1)
QUAI_VAULT_FACTORY=0x005261a837f1eFEa0e23b66dc526EB6054FD2250
QUAI_VAULT_IMPLEMENTATION=0x00707D5c7e35253265267DE764d2625cAb04082C
MULTISEND_LIBRARY=0x0060a725Ef00CB737f24F7e00da94c1Ce03bf1Dc
```

### Minimum Wallet Balances

To run the complete E2E test, ensure wallets have sufficient QUAI:

- **Deployer:** 2+ QUAI (gas + proposal offerings)
- **Alice:** 0.5+ QUAI (gas + proposal offerings)
- **Bob:** 0.6+ QUAI (gas + onboarding tribute)
- **Carol:** 0.3+ QUAI (gas + onboarding tribute)

Fund wallets at: https://faucet.quai.network

## Critical Implementation Details

### Checkpoint Timing

**Issue:** `BaalVotes.getPriorVotes()` requires `votingStarts < block.timestamp`

**Solution:** Wait 20 seconds after proposal submission before voting to ensure at least 2 blocks are mined (Quai has ~10s block times).

```typescript
// After submitting proposal
await new Promise((resolve) => setTimeout(resolve, 20000)); // 20 seconds

// Now safe to vote
await baal.submitVote(proposalId, true);
```

### Phase Ordering

Operations requiring permissions MUST execute BEFORE those permissions are locked:

1. **Phase 6:** ShamanSet (ADD) → BEFORE governor lock
2. **Phase 7:** MintLoot → BEFORE manager lock
3. **Phase 8:** BurnShares/BurnLoot → BEFORE manager lock
4. **Phase 9:** Pause/Unpause → BEFORE admin lock
5. **Phase 10:** ShamanSet (REMOVE) → BEFORE governor lock
6. **Phase 12:** ALL LOCKS applied here (Admin, Manager, Governor)
7. **Phase 13:** Ragequit (works after locks, no permissions needed)

### Permission Bitmasks

Shaman permissions use bitmask flags (NOT hierarchical):

```solidity
uint256 constant ADMIN = 1;    // binary: 001
uint256 constant MANAGER = 2;  // binary: 010
uint256 constant GOVERNOR = 4; // binary: 100
```

**Check permissions with bitwise AND:**
```solidity
// Correct
require((shamans[msg.sender] & MANAGER) != 0, "not manager");

// Wrong - misses combined permissions
require(shamans[msg.sender] == MANAGER, "not manager");
```

### executeAsBaal Pattern

Functions wrapped in `executeAsBaal` bypass locks because they execute AS the Baal contract itself:

```solidity
// This bypasses governorLock
bytes memory setShamansData = abi.encodeCall(baal.setShamans, (shamans, permissions));
bytes memory executeData = abi.encodeCall(baal.executeAsBaal, (baalAddress, 0, setShamansData));
```

## Indexer Integration

### Running Indexer Against Test

1. **Deploy indexer** pointing to Cyprus1 RPC
2. **Configure event listeners** for all 20 Baal events
3. **Run E2E test:** `npm run test:e2e:onchain`
4. **Verify indexer captured all events:**
   - 5 SubmitProposal events
   - 4 SponsorProposal events
   - 8 SubmitVote events
   - 4 ProcessProposal events
   - 1 CancelProposal event
   - 2 ShamanSet events (ADD + REMOVE)
   - 3 MintShares events
   - 1 MintLoot event
   - 1 BurnShares event
   - 1 BurnLoot event
   - 2 SetAdminConfig events (pause + unpause)
   - 1 Ragequit event
   - Plus governance management events (SetGuildTokens, GovernanceConfigSet, locks, etc.)

### Expected Final State

After test completion, indexer should show:

**Shaman Permissions:**
- Bob: 1 (ADMIN)
- Deployer: 2 (MANAGER)
- OnboarderShaman: 0 (removed)
- EthOnboarderShaman: 2 (MANAGER)
- CheckInShamanV2: 2 (MANAGER)

**Governance Config:**
- adminLock: true
- managerLock: true
- governorLock: true
- quorumPercent: 1500 (15%)
- votingPeriod: 60
- gracePeriod: 30

**Guild Tokens:**
- ZeroAddress (native QUAI): true

**Token Balances:**
- Bob shares: 0.5
- Carol shares: 2.0
- Carol loot: 40.0
- Alice shares: 30.0

**Proposals:**
- Proposal 1: Passed, processed, succeeded (funding)
- Proposal 2: Passed, processed, succeeded (add shaman)
- Proposal 3: Passed, processed, succeeded (remove shaman)
- Proposal 4: Cancelled
- Proposal 5: Passed, processed, succeeded (governance management)

## Troubleshooting

### "Baal: getPriorVotes failed"

**Cause:** Trying to vote before `block.timestamp > votingStarts`

**Fix:** Increase checkpoint wait time from 10s to 20s

### "Baal: manager locked"

**Cause:** Trying to call manager functions (mintLoot, burnShares, etc.) after lockManager()

**Fix:** Reorder phases to execute manager functions BEFORE Phase 12 locks

### "Baal: not admin"

**Cause:** Calling setAdminConfig with a shaman that only has MANAGER permission

**Fix:** Use a shaman with ADMIN permission (e.g., Bob in Phase 9)

### "Pausable: not paused"

**Cause:** Trying to unpause an already unpaused token

**Fix:** Pause first, then unpause (move from known state to known state)

### Insufficient testnet QUAI

**Cause:** Wallets don't have enough QUAI for gas + tributes

**Fix:** Fund wallets at https://faucet.quai.network

## Success Metrics

The E2E test is successful when:

- ✅ All 14 test phases pass
- ✅ All 20 unique event types triggered
- ✅ ~42 total events emitted
- ✅ No transaction reverts (except intentional ones)
- ✅ Final DAO state matches expectations
- ✅ Runtime completes in ~13 minutes

## Related Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture overview
- [GOVERNANCE.md](GOVERNANCE.md) - Governance mechanisms
- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) - Deployment instructions
- [SHAMAN_PATTERNS.md](SHAMAN_PATTERNS.md) - Shaman implementation patterns
