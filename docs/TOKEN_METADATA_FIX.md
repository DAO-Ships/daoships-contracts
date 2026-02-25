# Token Metadata Fix: Custom Names & Symbols for EIP-1167 Clones

## Problem

`SharesERC20` and `LootERC20` are deployed as EIP-1167 minimal proxy clones via `Clones.cloneDeterministic()`. OpenZeppelin v5 `ERC20` stores `_name` and `_symbol` as **regular storage variables** set in the constructor:

```solidity
// SharesERC20
constructor() ERC20("Baal Shares", "SHARES") Ownable(msg.sender) {}

// LootERC20
constructor() ERC20("Baal Loot", "LOOT") Ownable(msg.sender) {}
```

Since clones use `delegatecall`, storage reads come from the **proxy's storage**, not the implementation's. The constructor only runs on the singleton — the clone's `_name` and `_symbol` storage slots are never written.

**Result:** Every cloned token returns `""` (empty string) for both `name()` and `symbol()`.

## Root Cause

1. OZ v5 `ERC20` stores name/symbol in storage slots 3 and 4 (after balances, allowances, totalSupply)
2. The singleton's constructor writes to the singleton's storage — not the clone's
3. `initialize()` only calls `_transferOwnership()`, never sets name or symbol
4. The summoner pipeline (`BaalAndVaultSummoner` -> `BaalSummoner`) has no mechanism to pass token names through

## Fix Required

### 1. Token Contracts: Accept name/symbol in `initialize()`

Both `SharesERC20` and `LootERC20` need custom storage for name/symbol since OZ `ERC20._name` and `ERC20._symbol` are `private` (no setter).

```solidity
contract SharesERC20 is BaalVotes, ERC20Pausable, Ownable, IBaalToken {
    string private _customName;
    string private _customSymbol;

    constructor() ERC20("Baal Shares", "SHARES") Ownable(msg.sender) {}

    function initialize(address _initialOwner, string calldata tokenName, string calldata tokenSymbol) external {
        require(owner() == address(0), "SharesERC20: already initialized");
        _transferOwnership(_initialOwner);
        _customName = tokenName;
        _customSymbol = tokenSymbol;
    }

    function name() public view override(ERC20, IBaalToken) returns (string memory) {
        // Clone: return custom name; Singleton: return constructor default
        return bytes(_customName).length > 0 ? _customName : super.name();
    }

    function symbol() public view override(ERC20, IBaalToken) returns (string memory) {
        return bytes(_customSymbol).length > 0 ? _customSymbol : super.symbol();
    }
}
```

Apply the same pattern to `LootERC20`.

### 2. BaalSummoner: Pass token names to `initialize()`

```solidity
// In summonBaal(), after cloning:
SharesERC20(shares).initialize(baal, shareTokenName, shareTokenSymbol);
LootERC20(loot).initialize(baal, lootTokenName, lootTokenSymbol);
```

Token names need to be passed into `summonBaal()`. Options:
- **Option A**: Add them to `initializationParams` encoding (extend the ABI-encoded tuple)
- **Option B**: Add separate parameters to `summonBaal()` function signature

Option B is cleaner since token names are consumed by the summoner, not by `Baal.setUp()`:

```solidity
function summonBaal(
    bytes calldata initializationParams,
    bytes[] calldata initializationActions,
    string calldata shareTokenName,
    string calldata shareTokenSymbol,
    string calldata lootTokenName,
    string calldata lootTokenSymbol,
    uint256 sharesSalt,
    uint256 lootSalt,
    uint256 baalSalt
) external returns (address payable baal)
```

### 3. BaalAndVaultSummoner: Forward token names

`BaalAndVaultSummoner.summonBaalAndVault()` needs the same new parameters, forwarding them to `BaalSummoner.summonBaal()`.

### 4. Redeployment

All singletons and summoners must be redeployed:
- `SharesERC20` singleton (new storage layout)
- `LootERC20` singleton (new storage layout)
- `BaalSummoner` (new function signature, references new singletons)
- `BaalAndVaultSummoner` (new function signature, references new BaalSummoner)

`Baal` singleton does **not** need redeployment — it doesn't interact with token names.

## Frontend Impact

The `qdl-app` frontend already collects token names/symbols in the summon wizard (`SummonFormValues.shareTokenName`, etc.) but currently drops them before the contract call. Once the contracts are updated:

1. `useSummon.ts` — pass `tokenConfig` names to `daoService.summonBaalAndVault()`
2. `DaoService.ts` — add token name params to the contract call
3. `DaoService.ts` / `DaoIndexerService.ts` — read `name()` and `symbol()` from deployed token contracts to populate DAO metadata
4. DAO page and Treasury page already have display slots for this data (`dao.share_token_name`, etc.)

## Notes

- The `SummonBaal` event signature does not need to change (token addresses are already emitted; clients can call `name()`/`symbol()` on them)
- Existing DAOs deployed before this fix will continue to return empty strings — a migration script could call a new `setTokenMetadata()` admin function if desired, but this is optional
