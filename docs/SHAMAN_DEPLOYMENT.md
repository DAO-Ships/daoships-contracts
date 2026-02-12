# Shaman Deployment Guide

> Deploy and configure shaman contracts for DAO onboarding and rewards

## Overview

Shamans are modular smart contracts that extend DAO functionality. They have special permissions to mint shares/loot without governance proposals, enabling automated onboarding and reward mechanisms.

## Singleton vs Per-DAO Deployment

⚠️ **CRITICAL UNDERSTANDING**: Shamans can be deployed in two ways:

### 1. Singleton Deployment (Production Pattern)

**What**: One shaman contract instance shared across multiple DAOs

**When to use**:
- Default production deployment
- Standard onboarding/rewards functionality
- No custom parameters needed per-DAO

**Advantages**:
- Lower deployment costs (deploy once, reference many times)
- Simpler management and upgrades
- Consistent behavior across DAOs

**Example** (Cyprus1 production shamans):
```
OnboarderShaman:    0x004a47d46422E0A0CDA211F7F39D0090b8F2A02F (shared)
EthOnboarderShaman: 0x006d2EB3E2292c50d3894aA547FcdDdF8a3D5668 (shared)
CheckInShamanV2:    0x005d25C034606c459fA333BB5a016717D186EAd3 (shared)
```

**How it works**:
- Shamans deployed once with Baal singleton reference
- During DAO initialization, shamans are granted MANAGER permissions (2)
- Each DAO references the same shaman address in its `setUp()` call
- Shamans check `msg.sender == baal` to ensure only authorized DAOs can use them

### 2. Per-DAO Deployment (Custom Pattern)

**What**: Deploy new shaman instance for each DAO

**When to use**:
- Custom parameters needed (e.g., different reward amounts per DAO)
- Testing/development with specific DAO addresses
- Isolation required for security/governance reasons

**Advantages**:
- Custom configuration per-DAO
- Full isolation (one DAO can't affect another)
- Fine-grained control

**Example** (E2E test pattern):
```typescript
// Deploy shamans with predicted Baal address
const predictedBaalAddress = baalSalt.address;

const onboarderShaman = await OnboarderShamanFactory.deploy(
  predictedBaalAddress,  // Specific to this DAO
  sharesPerQuai,         // Custom multiplier for this DAO
  lootPerQuai,
  minTribute,
  expiry
);
```

**How it works**:
- New shaman instances deployed for each DAO
- Shamans reference specific Baal address in constructor
- DAOs reference their dedicated shaman addresses in `setUp()`
- Higher deployment cost but more flexibility

### Production Deployment (Singleton Pattern)

The shamans on Cyprus1 are deployed as **singletons** and shared across all DAOs:

## Available Shamans

### 1. OnboarderShaman
**Purpose**: Convert QUAI contributions to shares/loot with configurable multipliers

**NOTE**: Contract name follows Baal ecosystem conventions. On Quai Network, it accepts QUAI (native token).

**Features**:
- Configurable shares-per-QUAI multiplier
- Configurable loot-per-QUAI multiplier
- Minimum tribute requirement
- Optional expiration timestamp
- Direct `receive()` fallback for easy onboarding

**Use Cases**:
- Fundraising for DAO treasury
- Weighted contribution (1 QUAI = custom shares)
- Time-limited onboarding campaigns

**Configuration** (`.env` or `.env.e2e`):
```bash
ONBOARDER_SHARES_PER_QUAI=20000     # 1 QUAI = 1 share (20000/20000)
ONBOARDER_LOOT_PER_QUAI=0           # No loot by default
ONBOARDER_MIN_TRIBUTE=0.01          # 0.01 QUAI minimum
ONBOARDER_EXPIRY=0                  # 0 = no expiry
```

**Example**: 2:1 share ratio (2 QUAI = 1 share)
```bash
ONBOARDER_SHARES_PER_QUAI=40000  # 2 QUAI = 1 share (40000/20000 = 2)
```

### 2. EthOnboarderShaman
**Purpose**: Simple QUAI → shares conversion at fixed price

**NOTE**: Contract name is "EthOnboarderShaman" for Baal ecosystem compatibility, but it accepts QUAI (native token) on Quai Network.

**Features**:
- Fixed price per share (in QUAI)
- All as shares or mix shares/loot
- Simpler configuration than OnboarderShaman
- Direct `receive()` fallback

**Use Cases**:
- Fixed-price DAO membership
- Simple contribution mechanism
- Uniform share distribution

**Configuration** (`.env` or `.env.e2e`):
```bash
QUAI_ONBOARDER_PRICE_PER_UNIT=0.1   # 0.1 QUAI per share
QUAI_ONBOARDER_SHARES_PER_UNIT=1    # 1 share per unit (1e18 wei)
QUAI_ONBOARDER_SHARES_LOOT=0        # All as shares
QUAI_ONBOARDER_LOOT_LOOT=0          # No loot
```

**Example**: 0.05 QUAI per share
```bash
QUAI_ONBOARDER_PRICE_PER_UNIT=0.05
```

### 3. CheckInShamanV2
**Purpose**: Reward members for periodic check-ins (engagement tracking)

**Features**:
- Configurable check-in interval (e.g., daily, weekly)
- Configurable reward amounts (shares and/or loot)
- Miss tracking with maximum allowed misses
- Per-member state tracking

**Use Cases**:
- Engagement rewards (active participation)
- Attendance tracking for events/meetings
- Gradual vesting of additional shares
- Retention incentives

**Configuration** (`.env` or `.env.e2e`):
```bash
CHECKIN_INTERVAL=86400              # 24 hours (1 day)
CHECKIN_REWARD_SHARES=10            # 10 shares per check-in
CHECKIN_REWARD_LOOT=0               # No loot
CHECKIN_MAX_MISSED=3                # Penalize after 3 missed check-ins
```

**Example**: Weekly check-ins with 5 share reward
```bash
CHECKIN_INTERVAL=604800     # 7 days
CHECKIN_REWARD_SHARES=5
```

## Using Production Singleton Shamans

For most DAOs, you should **reference the existing singleton shamans** instead of deploying new ones.

### Singleton Addresses (Cyprus1)

Add these to your `.env`:

```bash
# Singleton Shamans (deployed Feb 11, 2026)
ONBOARDER_SHAMAN=0x004a47d46422E0A0CDA211F7F39D0090b8F2A02F
ETH_ONBOARDER_SHAMAN=0x006d2EB3E2292c50d3894aA547FcdDdF8a3D5668
CHECKIN_SHAMAN=0x005d25C034606c459fA333BB5a016717D186EAd3
```

### Using Singletons in DAO Initialization

When summoning a DAO, reference the singleton addresses:

```typescript
const shamans = [
  "0x004a47d46422E0A0CDA211F7F39D0090b8F2A02F", // OnboarderShaman
  "0x006d2EB3E2292c50d3894aA547FcdDdF8a3D5668", // EthOnboarderShaman
  "0x005d25C034606c459fA333BB5a016717D186EAd3"  // CheckInShamanV2
];

const shamanPermissions = [2, 2, 2]; // MANAGER = 2

// Pass to summonBaalAndVault() or summonBaal()
```

⚠️ **Important**: Shamans must be set during initialization. They **cannot be added later** via proposals due to the `baalOnly` constraint on `setShamans()`.

## Deployment Workflow (Custom Shamans Only)

**Only follow this section if you need custom shaman instances with specific parameters.**

For standard use cases, use the [singleton addresses](#using-production-singleton-shamans) above.

### Step 1: Deploy Core Contracts

```bash
# Deploy Baal, tokens, summoners
npm run deploy:all

# Update .env with core contract addresses
npm run update-env
```

**Required**: `BAAL_SINGLETON` must be set in `.env` before deploying custom shamans.

### Step 2: Configure Shaman Parameters

Edit `.env` or `.env.e2e` with your desired configuration:

```bash
# For production DAO
nano .env

# For E2E testing
nano .env.e2e
```

Set the configuration values documented above.

### Step 3: Deploy Shamans

```bash
# Deploy all shamans with configured parameters
npm run deploy:shamans --network cyprus1

# Or for local testing
npm run deploy:shamans
```

This deploys:
- OnboarderShaman
- EthOnboarderShaman
- CheckInShamanV2

### Step 4: Update Environment

```bash
# Update .env and .env.e2e with shaman addresses
npm run update-env
```

This updates:
- `ONBOARDER_SHAMAN`
- `QUAI_ONBOARDER_SHAMAN`
- `CHECKIN_SHAMAN`

### Step 5: Verify Deployment

Check `deployment-addresses.json`:

```json
{
  "contracts": {
    "BaalSingleton": "0x...",
    "OnboarderShaman": "0x...",
    "EthOnboarderShaman": "0x...",
    "CheckInShamanV2": "0x..."
  }
}
```

## Using Shamans in DAO Initialization

When summoning a DAO, include shamans during `setUp()`:

```typescript
const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
  [
    "address", "address", "address", "address", "address", "bytes",
    "address[]", "uint256[]",  // <- Shamans and permissions
    "address[]", "uint256[]", "uint256[]"
  ],
  [
    lootAddress,
    sharesAddress,
    avatarAddress,
    ethers.ZeroAddress,
    multisendAddress,
    governanceConfig,
    [
      onboarderAddress,      // Shaman addresses
      ethOnboarderAddress,
      checkInAddress
    ],
    [2, 2, 2],               // Permission level 2 = MANAGER
    initialMembers,
    initialShares,
    initialLoot
  ]
);

await baal.setUp(initParams);
```

**Permission Levels**:
- `1` = ADMIN (can pause tokens, set admin config)
- `2` = MANAGER (can mint/burn shares/loot)
- `4` = GOVERNOR (can change governance settings)

**Important**: Shamans must be set during initialization. They **cannot** be added via proposals due to the `baalOnly` constraint (msg.sender would be Avatar, not Baal).

## Testing Shamans

### Unit Tests

```bash
# Test individual shaman functionality
npm run test:unit
```

Tests in `test/unit/Shamans.test.ts`:
- OnboarderShaman onboarding and multipliers
- EthOnboarderShaman price calculations
- CheckInShamanV2 interval enforcement and rewards
- Permission validation

### Integration Tests

```bash
# Test shamans with complete DAO setup
npm run test:integration
```

### E2E Tests

```bash
# Complete DAO lifecycle with shamans
npm run test:e2e:local
```

Test in `test/e2e/FullDAOLifecycle.test.ts`:
- Bob onboards via OnboarderShaman
- Carol onboards via EthOnboarderShaman
- Alice receives check-in rewards
- Complete voting and governance with new members

## Configuration Examples

### Example 1: Simple DAO Membership ($10/share)

Assuming 1 QUAI = $5:

```bash
QUAI_ONBOARDER_PRICE_PER_UNIT=2    # 2 QUAI = $10
QUAI_ONBOARDER_SHARES_PER_UNIT=1   # 1 share per unit
```

### Example 2: Fundraising DAO (1:1 ratio)

```bash
ONBOARDER_SHARES_PER_QUAI=20000    # 1 ETH = 1 share
ONBOARDER_LOOT_PER_QUAI=0          # Pure shares
ONBOARDER_MIN_TRIBUTE=0.1         # 0.1 QUAI minimum
```

### Example 3: Engagement-Focused DAO

```bash
# Daily check-ins with small rewards
CHECKIN_INTERVAL=86400            # 24 hours
CHECKIN_REWARD_SHARES=1           # 1 share per day
CHECKIN_MAX_MISSED=7              # Allow 1 week of misses

# Low-barrier onboarding
QUAI_ONBOARDER_PRICE_PER_UNIT=0.01  # Very low price
```

### Example 4: Weighted Contribution DAO

```bash
# Higher contributions get more shares
ONBOARDER_SHARES_PER_QUAI=10000    # 0.5 ETH = 1 share
ONBOARDER_MIN_TRIBUTE=1           # 1 QUAI minimum (serious contributors)
```

### Example 5: Time-Limited Campaign

```bash
# Expires in 30 days (from deployment time)
ONBOARDER_EXPIRY=2592000          # 30 days in seconds

# Set actual expiry timestamp in deployment script:
const expiry = Math.floor(Date.now() / 1000) + 2592000;
```

## Shaman Economics

### OnboarderShaman Math

Formula: `shares = (msg.value * sharesPerQuai) / 1e18`

Examples:
- `sharesPerQuai = 20000`: 1 QUAI → 1 share (20000/20000)
- `sharesPerQuai = 40000`: 2 QUAI → 1 share (40000/20000)
- `sharesPerQuai = 10000`: 0.5 QUAI → 1 share (10000/20000)

### EthOnboarderShaman Math

Formula: `shares = (msg.value * sharesPerUnit) / pricePerUnit`

Examples:
- `pricePerUnit = 0.1 QUAI, sharesPerUnit = 1`: 0.1 QUAI → 1 share
- `pricePerUnit = 1 QUAI, sharesPerUnit = 10`: 1 QUAI → 10 shares

### CheckInShamanV2 Vesting

If `rewardShares = 10` and `interval = 86400` (1 day):
- Day 1: Check in → +10 shares
- Day 2: Check in → +10 shares (total: +20)
- Day 30: Check in → +10 shares (total: +300)

After 1 year of daily check-ins: 3,650 shares accumulated.

## Security Considerations

### Permission Management

**CRITICAL**: Shamans with MANAGER permission (level 2) can mint unlimited shares/loot.

**Best Practices**:
1. **Audit shaman logic** before deploying
2. **Set reasonable limits** in configuration (e.g., expiry, max rewards)
3. **Monitor shaman activity** via events
4. **Use time-locks** for high-value shamans
5. **Test thoroughly** before production use

### OnboarderShaman Risks

- **Unlimited minting** if no expiry set
- **Tribute sent to DAO treasury**, not held in escrow
- **No refunds** after onboarding

**Mitigation**:
- Set `expiry` timestamp for campaigns
- Set `minTribute` to prevent dust attacks
- Test with small amounts first

### EthOnboarderShaman Risks

- Similar to OnboarderShaman
- **Price manipulation** if not configured correctly

**Mitigation**:
- Double-check `pricePerUnit` calculation
- Test conversion rates before going live

### CheckInShamanV2 Risks

- **Sybil attacks** (multiple addresses checking in)
- **Reward inflation** if interval too short

**Mitigation**:
- Require initial shares to check in (members only)
- Set reasonable `interval` (e.g., 24 hours minimum)
- Monitor total supply growth
- Use `maxMissed` to penalize inactive members

## Troubleshooting

### Issue: "Baal: not manager"

**Cause**: Shaman doesn't have MANAGER permission (level 2)

**Fix**: Include shaman in `setUp()` with permission level 2:
```typescript
shamans: [shamanAddress],
permissions: [2]  // MANAGER
```

### Issue: Shaman deployment fails

**Cause**: BAAL_SINGLETON not set in `.env`

**Fix**:
```bash
# Deploy core contracts first
npm run deploy:all
npm run update-env

# Then deploy shamans
npm run deploy:shamans
```

### Issue: OnboarderShaman receives ETH but doesn't mint

**Cause**: `receive()` fallback may have failed, or shaman lacks permission

**Debug**:
1. Check shaman permission: `await baal.shamans(shamanAddress)` should return `2`
2. Check event logs for `OnboardMemberCall` event
3. Verify transaction didn't revert

### Issue: CheckInShaman "too soon" error

**Cause**: Trying to check in before interval elapsed

**Fix**: Wait for full interval period. Check:
```typescript
const lastClaim = await checkInShaman.lastClaimTimestamp(memberAddress);
const nextAllowed = lastClaim + interval;
console.log("Next check-in allowed:", new Date(nextAllowed * 1000));
```

## Advanced Usage

### Custom Shaman Parameters Per-DAO

Each DAO can deploy its own shaman instances with custom parameters:

```typescript
// Deploy custom OnboarderShaman for DAO
const CustomOnboarderShaman = await ethers.getContractFactory("OnboarderShaman");
const customOnboarder = await CustomOnboarderShaman.deploy(
  daoAddress,
  50000,  // Custom multiplier: 2.5 ETH = 1 share
  5000,   // 0.25 loot per ETH
  ethers.parseEther("0.5"),  // Higher minimum
  Math.floor(Date.now() / 1000) + 7776000  // 90 day expiry
);

// Include in DAO initialization
const shamans = [await customOnboarder.getAddress()];
const permissions = [2];  // MANAGER
```

### Multiple Shamans of Same Type

A DAO can have multiple onboarder shamans with different configurations:

```typescript
const shamans = [
  earlyBirdOnboarder,   // Low price, short expiry
  standardOnboarder,    // Normal price, no expiry
  whaleOnboarder        // High minimum, bonus shares
];
const permissions = [2, 2, 2];
```

### Programmatic Shaman Management

**Note**: Cannot add shamans via proposals. Must be done during `setUp()`.

For dynamic shaman management, consider:
1. Deploy DAO with "governor shaman" that has ADMIN permission
2. Governor shaman can set other shamans via `executeAsBaal()`

---

## Next Steps

After deploying shamans:

1. **Test thoroughly**: Run E2E tests with real onboarding flows
2. **Update documentation**: Document shaman addresses for your DAO
3. **Integrate with frontend**: Build UI for onboarding and check-ins
4. **Monitor events**: Set up indexer to track OnboardMemberCall and CheckInCall events
5. **Community education**: Explain how members can onboard and earn rewards

---

**Related Documentation**:
- [E2E Testing Guide](./docs/E2E_TESTING.md) - Testing shamans with fast governance
- [Architecture](./ARCHITECTURE.md) - Shaman system design
- [Governance](./GOVERNANCE.md) - Permission system details
