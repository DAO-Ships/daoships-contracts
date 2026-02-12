# Shaman Contract Patterns & Best Practices

## Architectural Patterns Applied

### 1. Function Visibility for Composition ✅

**Problem**: Using `external` functions with `this.functionName()` creates expensive external calls.

**Solution**: Use `public` functions that can be called both internally and externally.

#### Before (Problematic):
```solidity
function onboard() external payable {
    // ... logic ...
}

receive() external payable {
    this.onboard();  // ❌ External call - extra gas, can fail
}
```

#### After (Correct):
```solidity
function onboard() public payable {  // ✅ public instead of external
    // ... logic ...
}

receive() external payable {
    onboard();  // ✅ Internal call - efficient
}
```

**Reference**: [DAOHaus baal-shamans](https://github.com/HausDAO/baal-shamans/blob/main/contracts/onboarder/Onboarder.sol)

---

### 2. Internal Helper Functions ✅

**Pattern**: Use `internal` visibility for helper functions that should only be called within the contract.

```solidity
// CheckInShamanV2 - Proper internal helper pattern
function checkIn() external {
    // Main entry point (external)
    if (shouldSlash) {
        _slash(msg.sender, missed);  // ✅ Internal call
    } else {
        _mintRewards(msg.sender, currentMissed);  // ✅ Internal call
    }
}

function _mintRewards(address member, uint256 currentMissed) internal {
    // Helper function - only called internally
}

function _slash(address member, uint256 missed) internal {
    // Helper function - only called internally
}
```

**Benefits**:
- Clear separation of public API vs internal implementation
- Gas savings (no ABI encoding/decoding overhead)
- Better encapsulation

---

### 3. Setting Shamans During Initialization ✅

**Problem**: `setShamans()` has `baalOnly` modifier - cannot be called via proposals.

**Reason**: When called through Avatar → MultiSend → Baal, `msg.sender` is Avatar (not Baal).

**Solution**: Set shamans during `setUp()` initialization.

#### Correct Pattern:
```solidity
// In test fixtures or deployment scripts
const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "address", "address", "address", "address", "bytes", 
   "address[]", "uint256[]", "address[]", "uint256[]", "uint256[]"],
  [loot, shares, avatar, forwarder, multisend, governanceConfig,
   [onboarder, ethOnboarder, checkInShaman],  // ✅ Shaman addresses
   [2, 2, 2],                                   // ✅ MANAGER permissions
   [deployer, alice], [shares], [loot]]
);

await baal.setUp(initParams);
```

**DO NOT** use `setShamansViaProposal()` - it won't work due to `baalOnly` restriction.

---

## Contract Audit Summary

### ✅ OnboarderShaman.sol - GOOD
- `onboard()`: `public payable` ✅
- `receive()`: calls `onboard()` internally ✅
- No `this.` calls ✅
- Proper permission checks ✅

### ✅ EthOnboarderShaman.sol - GOOD
- `onboard()`: `public payable` ✅
- `receive()`: calls `onboard()` internally ✅
- No `this.` calls ✅
- Refund logic secure ✅

### ✅ CheckInShamanV2.sol - EXCELLENT
- `checkIn()`: `external` (main entry point) ✅
- `canCheckIn()`: `external view` (query function) ✅
- `_mintRewards()`: `internal` (helper) ✅
- `_slash()`: `internal` (helper) ✅
- No `receive()` needed (not a payment contract) ✅
- Perfect composition pattern ✅

---

## Test Coverage

All shamans have comprehensive test coverage:

### OnboarderShaman (6/6 tests passing)
- ✅ Deployment and initialization
- ✅ ETH → shares conversion with multiplier
- ✅ Minimum tribute validation
- ✅ ETH forwarding to treasury
- ✅ `receive()` fallback
- ✅ Expiration handling

### EthOnboarderShaman (6/6 tests passing)
- ✅ Fixed price onboarding
- ✅ Refund handling
- ✅ Share/loot minting
- ✅ Multiple users
- ✅ Expiration validation
- ✅ `receive()` fallback

### CheckInShamanV2 (9/9 tests passing)
- ✅ Initial claim
- ✅ Periodic claim interval
- ✅ Multiple claims tracking
- ✅ Miss calculation
- ✅ Slashing after max missed
- ✅ Claim restrictions
- ✅ Full engagement lifecycle

**Total: 21/21 shaman tests passing (100%)**

---

## Key Takeaways

1. **Composition over External Calls**: Use `public` functions with internal calls instead of `external` functions with `this.` calls

2. **Visibility Matters**: 
   - `external`: Main entry points called from outside
   - `public`: Functions that need both external and internal calls
   - `internal`: Helper functions (use `_` prefix by convention)
   - `private`: Use sparingly (breaks inheritance)

3. **Initialization Constraints**: Shamans must be set during `setUp()`, not via proposals (due to `baalOnly` restriction)

4. **Gas Optimization**: Internal calls save gas by avoiding ABI encoding/decoding

5. **Reference Implementation**: Always check DAOHaus reference implementations for best practices

---

## Files Modified

1. `contracts/shamans/OnboarderShaman.sol`
   - Changed `onboard()` from `external` to `public`
   - Changed `receive()` from `this.onboard()` to `onboard()`

2. `contracts/shamans/EthOnboarderShaman.sol`
   - Changed `onboard()` from `external` to `public`
   - Changed `receive()` from `this.onboard()` to `onboard()`

3. `test/unit/Shamans.test.ts`
   - Fixed expiration test to set shaman during `setUp()`
   - Removed dependency on `setShamansViaProposal()`

4. `test/fixtures-simple.ts`
   - Updated `deployShamanFixture()` to set shamans during initialization
   - Kept `setShamansViaProposal()` helper for reference (but note it won't work)

---

## References

- [DAOHaus baal-shamans Repository](https://github.com/HausDAO/baal-shamans)
- [Baal Documentation](https://moloch.daohaus.fun/)
- [Solidity Function Visibility](https://docs.soliditylang.org/en/latest/contracts.html#visibility-and-getters)
- [Gas Optimization Patterns](https://github.com/dragonfly-xyz/useful-solidity-patterns/tree/main/patterns/basic-proxies)

---

**Last Updated**: 2026-02-10  
**Audit Status**: ✅ All shamans reviewed and compliant with best practices
