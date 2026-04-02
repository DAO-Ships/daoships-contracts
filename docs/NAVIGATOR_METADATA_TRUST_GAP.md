# Navigator Metadata Trust Gap

## Problem

Navigator contracts have no on-chain identity beyond `navigatorType` (a compile-time constant string). There is no way to determine who deployed a navigator or to associate human-readable metadata (name, description) with a navigator in a trusted way.

The current metadata flow is:

1. A DAO member deploys a navigator contract
2. The member posts metadata via the Poster contract (`daoships.navigator.metadata`)
3. A governance proposal grants the navigator permissions (`NavigatorSet`)

This flow has a fundamental trust gap: **any DAO member can post metadata for any navigator address**. The indexer has no way to verify that `msg.sender` is the deployer because:

- Navigator contracts don't expose `owner()`, `deployer()`, or any deployer identifier
- The deployer address only exists in the deployment transaction receipt, which the indexer doesn't track
- The `MEMBER` trust level (shares > 0) is the only gate, and it doesn't bind the poster to the navigator

### Attack Scenarios

| Attack | Description | Impact |
|--------|-------------|--------|
| **Spoofing** | Member B posts metadata with a misleading name/description for Member A's navigator | Users see wrong information for a legitimate navigator |
| **Squatting** | Member B posts metadata for a navigator address before the real deployer does | Deployer's later post overwrites, but the squatter's record pollutes `ds_records` |
| **Poisoning** | Member B overwrites legitimate metadata by posting after the deployer | `ds_navigators` displays malicious name/description |

### Current Mitigations (Insufficient)

- The indexer now only allows the first MEMBER-level metadata post per navigator (subsequent updates require VERIFIED/governance trust)
- The backfill from `ds_records` into `ds_navigators` filters by navigator address
- Content is length-limited and control-character-stripped

These mitigations reduce the window but don't close it. The first poster wins, regardless of whether they're the actual deployer.

---

## Implemented Solution: `INavigator` Interface with `deployer` Immutable + Constructor Event

### Option A: Add `deployer` immutable (minimal change)

Add to all navigator contracts:

```solidity
address public immutable deployer;

constructor(...) {
    deployer = msg.sender;
    // ... existing constructor logic
}
```

**Indexer impact:** When processing `navigator.metadata` posts, the indexer calls `navigator.deployer()` via RPC and rejects the post if `msg.sender` doesn't match. This closes all three attack scenarios.

**Gas cost:** ~2,100 gas for the SSTORE (immutable, so it's actually compiled into the bytecode — near-zero runtime cost for reads).

### Option B: Constructor metadata event (recommended)

Add `name` and `description` constructor parameters and emit them as an event:

```solidity
address public immutable deployer;

event NavigatorMetadata(string name, string description);

constructor(
    address _daoShip,
    string memory _name,
    string memory _description,
    // ... existing params
) {
    deployer = msg.sender;
    // ... existing constructor logic
    emit NavigatorMetadata(_name, _description);
}
```

**Benefits over Option A:**
- Metadata has full on-chain provenance — emitted by the navigator contract itself, authored by the deployer (the only entity that can call the constructor)
- The indexer can index `NavigatorMetadata` events directly, no Poster dependency for initial metadata
- No spoofing possible — the event comes from the contract, not from an arbitrary wallet via Poster
- The deployer sets name/description at deploy time in a single transaction, better UX

**Poster still used for updates:** If the DAO wants to change a navigator's name/description after deployment, they submit a governance proposal that posts via Poster with VERIFIED trust. The constructor event provides the initial trusted metadata; governance provides the update path.

**Gas cost:** Additional constructor calldata for the strings + event emission. For typical name (20 chars) + description (100 chars), approximately 5,000-8,000 additional gas at deployment. Negligible since deployment is a one-time operation.

### Option C: Deployer field only, metadata stays in Poster

Same as Option A but metadata continues to flow through Poster. The `deployer` immutable is only used by the indexer to verify the poster's identity.

**Tradeoff:** Simpler contract change but still requires two transactions (deploy + post metadata). Option B is one transaction.

---

## Implementation Status: IMPLEMENTED

**Option B was implemented** with an enhancement: instead of a standalone `NavigatorMetadata` event, a formal `INavigator` interface (`contracts/interfaces/INavigator.sol`) was created. The interface defines the `NavigatorDeployed` event (which includes `daoShip` and `deployer` as indexed params in addition to metadata), the `deployer()` view function, and the `navigatorType()` view function. Both shipped navigators implement `INavigator`.

This provides:

1. Trusted initial metadata with zero trust assumptions (constructor event = deployer authored)
2. A `deployer` immutable that the indexer can use to verify any future Poster-based metadata
3. Single-transaction deploy+metadata UX
4. Governance-gated update path via Poster (VERIFIED trust)
5. A formal interface contract that all future navigators must implement

### Implementation Checklist

**Contracts:**
- [x] Add `address public immutable deployer` to `OnboarderNavigator`
- [x] Add `address public immutable deployer` to `ERC20TributeNavigator`
- [x] Add `string memory _name, string memory _description` constructor params to both
- [x] Create `INavigator` interface with `NavigatorDeployed` event, `deployer()`, and `navigatorType()`
- [x] Both navigators implement `INavigator` and emit `NavigatorDeployed` in constructors
- [x] Update `NAVIGATORS.md` common patterns to include `INavigator` requirement
- [x] Add to navigator pattern requirements: all navigators MUST implement `INavigator`

**Indexer:**
- [ ] Register handler for `NavigatorDeployed` event (emitted by navigator contracts)
- [ ] On `NavigatorDeployed`: store deployer, type, name, description in `ds_navigators`
- [ ] On `daoships.navigator.metadata` Poster tag: RPC call `navigator.deployer()`, reject if `msg.sender != deployer`
- [ ] On `daoships.navigator.metadata` Poster tag with VERIFIED trust: skip deployer check (governance approved)
- [ ] Only accept first MEMBER-level metadata post per navigator (subsequent updates require VERIFIED)

**Frontend:**
- [ ] Pass `name` and `description` to navigator deployment transactions
- [ ] Remove post-deploy Poster metadata call (constructor handles it)
- [ ] Keep governance-based metadata update flow for VERIFIED path

### Migration

Existing navigators (already deployed without `deployer`) will not have the immutable. The indexer should handle this gracefully:

- If `navigator.deployer()` reverts or returns empty, fall back to accepting MEMBER-level metadata posts (current behavior) but log a warning
- New navigators deployed after the contract update get full deployer verification

---

## Interim Indexer Hardening (Before Contract Changes)

Until navigator contracts are updated, the indexer should:

1. Only accept the first `navigator.metadata` post per navigator at MEMBER trust
2. Require VERIFIED trust (governance) for any subsequent metadata updates
3. Validate `navigatorAddress` and `daoAddress` with `ETH_ADDRESS_RE`
4. Filter `getLatestNavigatorMetadata` by `navigatorAddress` at the DB level

These changes are already implemented or in progress in the indexer.
