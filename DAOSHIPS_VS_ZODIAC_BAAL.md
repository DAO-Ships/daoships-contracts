# DAO Ships vs zodiacBaal: Technical Comparison

**DAO Ships version:** 2026-03-30
**Upstream ref:** HausDAO/Baal `feat/baalZodiac` (last commit 2024-06-11, confirmed latest as of 2026-03-30)

## Executive Summary

DAO Ships is a DAO framework and launchpad for Quai Network, inspired by HausDAO Baal (MolochV3). It is not a fork with patches. Every contract has been rewritten from scratch against Solidity 0.8.22 and OpenZeppelin v5.0.0, the entire Gnosis Safe / Zodiac / OpenGSN dependency tree has been removed, and a substantial layer of governance safety hardening has been added that upstream does not have.

The result is a smaller, more gas-efficient, and more auditable codebase. DAO Ships' DAOShip.sol compiles to 21,729 bytes (88.4% of the 24KB limit). The test suite includes 506 tests (unit + local E2E) and 24 on-chain E2E phases. Key security improvements include scoping `executeAsGovernance` to self-calls only, flash-loan-resistant sponsorship, deadlock prevention via `_effectiveSponsorThreshold` and `defaultExpiryWindow`, parallel proposal execution (removing upstream's sequential queue), and a DelegateCall whitelist on the vault.

The tradeoff is explicit: DAO Ships drops upstream's token upgradeability, EIP-712 signature voting/delegation, OpenGSN meta-transactions, and Gnosis Safe ecosystem compatibility. These are appropriate tradeoffs for Quai Network, where gas fees are low and the deployment target is Quai Vault rather than Gnosis Safe.

---

## 1. Architecture

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Solidity | ^0.8.7 | ^0.8.22 |
| OpenZeppelin | v4.8.3 (upgradeable) | v5.0.0 (non-upgradeable) |
| Gnosis Safe | @gnosis.pm/safe-contracts ^1.3.0 | Removed |
| Zodiac | @gnosis.pm/zodiac ^3.3.7 | Removed (custom IAvatar) |
| OpenGSN | @opengsn/contracts 2.2.5 | Removed |
| Proxy pattern | ERC1967 (UUPS upgradeable) | EIP-1167 minimal clones |
| Treasury | Gnosis Safe (multisig) | Quai Vault (IAvatar-compatible) |
| Baal inheritance | `Module, EIP712Upgradeable, ReentrancyGuardUpgradeable, BaseRelayRecipient` | `ReentrancyGuard` |
| msg.sender | `_msgSender()` via OpenGSN BaseRelayRecipient | Raw `msg.sender` |
| Error style | `require` strings | Custom errors (52 in DAOShip.sol) |
| Percentage encoding | Raw 0-100 | Basis points 0-10000 |

**Zodiac compatibility note:** DAO Ships' treasury (QuaiVault) implements the Zodiac `IAvatar` interface with the same function selectors and `Enum.Operation` values. Any Zodiac-compatible module can interact with a QuaiVault. DAO Ships' DAOShip does not inherit the Zodiac `Module` base class; it calls `IAvatar` directly. This means DAOShip has no `target` address, no `setAvatar()`/`setTarget()`, and no `Ownable` ownership relationship to the vault.

QuaiVault v2 replaces the `delegatecallDisabled` boolean with a per-target `delegatecallAllowed` whitelist. `DAOShipAndVaultLauncher` creates vaults with `delegatecallAllowed[multisendCallOnly] = true` and the predicted DAOShip address as an initial module, all atomically.

---

## 2. Governance Core

### 2.1 Initialization

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Guard | `initializer` modifier (OZ) | `require(avatar == address(0))` |
| Constructor | `_disableInitializers()` | `avatar = address(0xdead)` sentinel |
| setUp params | 6 (loot, shares, multisend, avatar, forwarder, multisendData) | 13 (loot, shares, avatar, multisend, govConfig, navigators[], perms[], members[], shares[], loot[], guildTokens[], pauseSharesOnLaunch, pauseLootOnLaunch) |
| Init execution | All init actions encoded as multisend, executed via `exec(multisendLibrary, DelegateCall)` | Direct loops in setUp; no delegatecall needed during init |
| multisend validation | `require(_multisendLibrary != address(0))` | `require(_multisendLibrary != address(0) && _multisendLibrary.code.length > 0)` |

DAO Ships' self-contained initialization is simpler, cheaper, and removes delegatecall from the init path entirely.

### 2.2 Proposal Struct

| Field | Upstream | DAO Ships | Notes |
|-------|----------|-----|-------|
| `id` | uint32 | uint32 | Same |
| `prevProposalId` | uint32 | **Removed** | DAO Ships uses parallel execution; no sequential queue linkage |
| `votingStarts` | uint32 | **uint40** | DAO Ships extends to year ~36,812 |
| `votingEnds` | uint32 | **uint40** | Same reasoning |
| `graceEnds` | uint32 | **uint40** | Same reasoning |
| `expiration` | uint32 | **uint40** | Same reasoning |
| `daoShipGas` | uint256 | **Removed** | DAO Ships proposals use all available gas; no per-proposal gas limit |
| `yesVotes` | uint256 (share-weighted) | **uint32** (head count) | Different semantics |
| `noVotes` | uint256 (share-weighted) | **uint32** (head count) | Different semantics |
| `yesBalance` | Not present | uint256 (share-weighted) | DAO Ships separates head count from weight |
| `noBalance` | Not present | uint256 (share-weighted) | DAO Ships separates head count from weight |
| `maxTotalSharesAndLootAtVote` | uint256 (high water mark) | uint256 (high water mark) | Matches upstream: updated on each vote |
| `maxTotalSharesAtSponsor` | uint256 | uint256 | Same |
| `submitter` | Not present | address | DAO Ships tracks submitter for cancellation |
| `details` | Not present (event only) | string (stored on-chain) | DAO Ships stores for queryability |
| `sponsor` | address | address | Same |
| `proposalDataHash` | bytes32 | bytes32 | Same |
| `status` | bool[4] | bool[4] | Same layout |

### 2.3 State Machine

| State | Upstream | DAO Ships |
|-------|----------|-----|
| 0-7 | Unborn through Defeated | Same |
| 8 Expired | Not present | Added: auto-expiry for Ready proposals via `defaultExpiryWindow` |

The Expired state prevents zombie proposals from remaining processable indefinitely (see Section 6).

### 2.4 Modifiers

| Modifier | Upstream | DAO Ships |
|----------|----------|-----|
| `governanceOnly` | `_msgSender() == avatar` | `msg.sender == address(this)` |
| `governanceOrAdminOnly` | `avatar \|\| isAdmin` | Replaced by `onlyAdmin` (includes `address(this)` bypass) |
| `governanceOrManagerOnly` | `avatar \|\| isManager` | Replaced by `onlyManager` (includes `address(this)` bypass) |
| `governanceOrGovernorOnly` | `avatar \|\| isGovernor` | Replaced by `onlyGovernor` (includes `address(this)` bypass) |
| `governanceOrAvatar` | Not present | Added: `avatar \|\| address(this)` |
| Lock bypass | Lock checks block all callers including governance | `onlyAdmin` allows governance (`address(this)`) to bypass `adminLock` |

**Execution flow difference:** Upstream: Safe delegatecalls MultiSend, which calls Baal functions, so `msg.sender` = avatar. DAO Ships: DAOShip calls `avatar.execTransactionFromModule(multisend, DelegateCall)`, MultiSend calls `DAOShip.executeAsGovernance()`, which calls `address(this).call(data)`, so `msg.sender` = DAOShip.

### 2.5 Submission

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Self-sponsor check | `sharesToken.getVotes(_msgSender())` (current block) | `sharesToken.getPriorVotes(msg.sender, block.timestamp - 1)` |
| Flash-loan protection | None: attacker can borrow, delegate, self-sponsor in same block | Protected: snapshot is 1 second in the past |
| daoShipGas limit | `require(daoShipGas <= 20000000)` | Removed: proposals use all available gas |
| proposalOffering | Self-sponsors still pay offering | Self-sponsors skip offering entirely |
| proposalCount overflow | Silent uint32 wrap | `require(proposalCount < type(uint32).max)` |
| Self-sponsor ETH rejection | Not checked | Reverts if `msg.value > 0` when self-sponsoring (prevents accidental ETH loss) |

### 2.6 Sponsorship

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Threshold check | `sharesToken.getVotes()` (current, flash-loan vulnerable) | `getPriorVotes(timestamp - 1)` (historical) |
| votingEnds calc | `unchecked { uint32(block.timestamp) + votingPeriod }` | Checked arithmetic with `MAX_VOTING_PERIOD` bound |
| graceEnds calc | Same unchecked overflow risk | Same bounds protection |
| Deadlock prevention | None: if threshold > supply, no proposals can be sponsored | `_effectiveSponsorThreshold()` caps at current supply |

Upstream uses `unchecked` for votingEnds/graceEnds. An extreme `votingPeriod` value (set by a compromised GOVERNOR navigator) can cause uint32 overflow. DAO Ships enforces `MAX_VOTING_PERIOD = 31_536_000` and `MAX_GRACE_PERIOD = 31_536_000` (~1 year each).

### 2.7 Voting

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Vote weight source | `sharesToken.getPastVotes(voter, prop.votingStarts)` | `getPriorVotes(msg.sender, prop.votingStarts)` |
| High water mark | Updates `maxTotalSharesAndLootAtVote` on each yes vote | **Matches upstream:** updates on every vote (yes or no) |
| Head count | Not tracked | Tracked separately (`yesVotes`/`noVotes` as uint32) |
| Signature voting | `submitVoteWithSig()` via EIP-712 | Removed |
| State check | Calls `state()` function (external overhead) | Inline voting state check (gas optimization) |

Both codebases update `maxTotalSharesAndLootAtVote` as a high water mark during voting and use it for the retention check in `processProposal`. DAO Ships initializes the high water mark at sponsor time and updates it on every vote (yes or no). `maxTotalSharesAtSponsor` is still used separately for quorum calculation.

### 2.8 Processing

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Accepted states | Ready only | Ready or Defeated |
| Module check | None | `require(IAvatar(avatar).isModuleEnabled(address(this)))` |
| Execution | `exec(multisendLibrary, DelegateCall)` via Zodiac Module | `IAvatar(avatar).execTransactionFromModule(multisend, DelegateCall)` with try/catch |
| Gas handling | `require(gasleft() >= prop.daoShipGas)` pre-check | Proposals use all available gas; try/catch captures reverts |
| Quorum calc | `yesVotes * 100 < quorumPercent * totalSharesAtSponsor` (100-based) | `yesBalance * BASIS_POINTS_DIVISOR < quorumPercent * maxTotalSharesAtSponsor` (10000-based) |
| Retention check | `totalSupply() < maxTotalSharesAndLootAtVote * minRetentionPercent / 100` | `totalSupply() < maxTotalSharesAndLootAtVote * minRetentionPercent / BASIS_POINTS_DIVISOR` (high water mark — matches upstream) |
| Execution model | Sequential queue: predecessor must be processed first | **Parallel:** any Ready proposal can be processed in any order |
| Zombie proposal prevention | None: Ready proposals remain processable forever | `defaultExpiryWindow` auto-expires Ready proposals |
| Defeated proposals | Revert (cannot process) | Processable with empty data (no queue to advance) |
| Pass check optimization | Calls `_didProposalPass` for all states | Skips `_didProposalPass` for Ready state (already known to have passed) |

DAO Ships' try/catch execution means a reverting proposal sets `actionFailed=true` without affecting other proposals. Upstream's `exec()` propagates reverts, which can block the sequential queue.

### 2.9 Cancellation

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Who can cancel | Sponsor, governor, or anyone if sponsor below threshold | **Submitter** (not sponsor), governor, or anyone if sponsor below threshold |
| Cancellable states | Voting only | Submitted **or** Voting |
| Threshold check | `sharesToken.getPastVotes(prop.sponsor, block.timestamp - 1) < sponsorThreshold` | `getPriorVotes(prop.sponsor, block.timestamp - 1) < _effectiveSponsorThreshold()` |

Cancelling during Submitted state prevents a proposal from being sponsored against the submitter's wishes.

### 2.10 executeAsGovernance

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Access control | `governanceOnly` (msg.sender == avatar) | `governanceOrAvatar` + `require(_inProposalExecution)` |
| Target | `_to.call{value}(_data)` to **any address** | `address(this).call(_data)` to **self only** |
| Context guard | None | `_inProposalExecution` flag set/cleared in processProposal |
| Target validation | None | `require(_to == address(this))` (preserves ABI, enforces self-call) |
| Value validation | None: `_value` passed through to call | `require(_value == 0)` — DAOShip has no `receive()`, cannot hold native token |
| Error handling | Reverts bubble up from `_to.call` | Revert data bubbled up via assembly for debuggability |

**This is the single most important security improvement in DAO Ships.** Upstream's `executeAsBaal` allows the avatar to call any external address with arbitrary data as Baal. In DAO Ships, `executeAsGovernance` can only call DAOShip's own functions, and only during active proposal execution. This eliminates an entire class of privilege escalation attacks.

### 2.11 Ragequit

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Token validation | None: accepts any token array | Requires tokens registered via `setGuildTokens()` |
| Module check | None | `require(IAvatar(avatar).isModuleEnabled(address(this)))` |
| ETH sentinel | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` | `address(0)` |
| Transfer execution | `_safeTransferETH`/`_safeTransfer` via Zodiac `execAndReturnData` | `IAvatar.execTransactionFromModule()` |
| balanceOf call | `staticcall` without success check | `staticcall` with `require(success)` |
| Retention check | Not in ragequit (only in processProposal) | Explicit retention check in ragequit |
| Recipient validation | None | `require(to != address(0))` |

Guild token registration prevents ragequitting with arbitrary tokens (which could drain the vault via malicious token contracts). The retention check in ragequit prevents members from collectively exiting below the minimum. The tradeoff: upstream needs no governance proposal to add ragequit tokens.

### 2.12 Governance Config

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Parameters | 6: voting, grace, offering, quorum, sponsor, minRetention | 7: + `defaultExpiryWindow` |
| Percentage encoding | Raw 0-100 | Basis points 0-10000 |
| Min voting period | None: can be set to 0 | `MIN_VOTING_PERIOD = 60` seconds |
| Max voting period | None | `MAX_VOTING_PERIOD = 31_536_000` (~1 year) |
| Max grace period | None | `MAX_GRACE_PERIOD = 31_536_000` (~1 year) |
| Sponsor threshold check | `sponsor <= totalShares()` (skipped if 0) | `_sponsorThreshold <= sharesToken.totalSupply()` |
| Zero-value handling | `if (voting != 0) votingPeriod = voting` (0 = "don't change") | Direct assignment (0 fails `MIN_VOTING_PERIOD` for voting) |

Upstream quirk: setting `votingPeriod = 0` or `gracePeriod = 0` in `setGovernanceConfig` is a no-op that keeps the current value. This is undocumented. DAO Ships treats values literally.

### 2.13 Navigator Permissions

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| isAdmin | `permission == 1 \|\| 3 \|\| 5 \|\| 7` | `(navigators[account] & ADMIN) != 0` (bitwise) |
| isManager | `permission == 2 \|\| 3 \|\| 6 \|\| 7` | `(navigators[account] & MANAGER) != 0` |
| isGovernor | `permission == 4 \|\| 5 \|\| 6 \|\| 7` | `(navigators[account] & GOVERNOR) != 0` |
| setNavigators lock check | Enumeration of disallowed values per lock | Bitwise AND per lock |
| MAX_NAVIGATORS_PER_CALL | None | 20 |
| Permission validation | None: any uint256 accepted | `MAX_PERMISSION = 7` — values > 7 rejected with `InvalidPermission()` |

Bitwise checks are more gas-efficient. Permission validation prevents storing meaningless high bits that would confuse indexers and frontends.

---

## 3. Tokens

### 3.1 Architecture

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Proxy pattern | ERC1967 (UUPS upgradeable) | EIP-1167 minimal clones (non-upgradeable) |
| Shares base | `DAOShipVotes + ERC20SnapshotUpgradeable + OwnableUpgradeable + PausableUpgradeable + UUPSUpgradeable` | `DAOShipVotes + ERC20Pausable + Ownable + Nonces + IERC20Permit` |
| Loot base | `ERC20SnapshotUpgradeable + ERC20PermitUpgradeable + PausableUpgradeable + OwnableUpgradeable + UUPSUpgradeable` | `ERC20 + ERC20Pausable + Ownable + Nonces + IERC20Permit` |
| Snapshots | `ERC20SnapshotUpgradeable` (both tokens) | Removed |
| Upgradeability | `UUPSUpgradeable` (owner can upgrade) | Not upgradeable |

**Upstream advantage:** Token upgradeability allows fixing bugs in token logic post-deployment. ERC20 snapshots enable off-chain balance queries at historical points.

**DAO Ships advantage:** Non-upgradeable tokens cannot have their logic changed by a compromised owner (DAOShip). Smaller bytecode, lower deployment cost. No snapshot storage overhead.

### 3.2 SharesERC20 / DAOShipVotes

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Checkpoint struct | `uint32 fromTimePoint + uint256 votes` (2 storage slots) | `uint40 timestamp + uint216 votes` (1 storage slot) |
| Storage layout | `mapping(address => mapping(uint256 => Checkpoint))` + `mapping(address => uint256) numCheckpoints` | `mapping(address => Checkpoint[]) _checkpoints` |
| Timestamp width | uint32 (overflows year 2106) | uint40 (overflows year ~36,812) |
| Votes width | uint256 | uint216 (~1.05e65) |
| Auto-delegation | `if (balanceOf(to) == 0 && numCheckpoints[to] == 0)` | `if (_delegates[to] == address(0) && amount > 0)` |
| Delegation clearing | Never cleared: persists at 0 balance | Cleared on full burn (`if (balanceOf(from) == 0)`) |
| delegateBySig | Yes (EIP-712 signature delegation) | Removed |
| EIP-2612 Permit | Not on SharesERC20 (Loot only via upgradeable) | **Yes**: clone-safe implementation with storage-based domain separator |
| Mint cap | `type(uint256).max / 2` | `type(uint216).max` (aligned with checkpoint packing) |
| EIP-712 domain | Separate `DelegationEIP712Upgradeable` | Storage-based `_domainSeparatorV4()` (recomputed per call, clone-safe) |

Packed checkpoints (1 slot vs 2) save ~20,000 gas per checkpoint write. Delegation clearing on full burn means re-joining members get fresh self-delegation instead of stale delegation to a potentially inactive address.

### 3.3 LootERC20

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| EIP-2612 Permit | `ERC20PermitUpgradeable` | **Yes**: clone-safe implementation (same pattern as SharesERC20) |
| Snapshots | `ERC20SnapshotUpgradeable` | Removed |
| Voting power | None | None |
| Pausable | Yes | Yes |
| Mint cap | `type(uint256).max / 2` | `type(uint256).max / 2` (same) |

Both codebases now have EIP-2612 Permit on Loot. DAO Ships' implementation is clone-safe (storage-based domain separator).

---

## 4. Factories

### 4.1 DAOShipLauncher

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Upgradeability | UUPS (`OwnableUpgradeable + UUPSUpgradeable`) | Not upgradeable |
| Singleton storage | Mutable via `setAddrs()` (owner-controlled) | `immutable` (set once in constructor) |
| Token deployment | `new ERC1967Proxy(singleton, initData)` | `Clones.cloneDeterministic()` |
| Baal deployment | `moduleProxyFactory.deployModule()` | `Clones.cloneDeterministic()` |
| Safe deployment | `GnosisSafeProxyFactory.createProxyWithNonce()` | Not handled (vault created by DAOShipAndVaultLauncher) |
| Module enablement | Atomic via `configureSafe()` during Safe.setup() | Atomic via predict-then-create with `initialModules=[predictedDAOShip]` |
| Salt handling | Single `_saltNonce` for all | Separate salts per contract with `msg.sender` prefix (front-running protection) |
| Address prediction | Not available | `calculateAddresses(sender, sharesSalt, lootSalt, daoShipSalt)` |
| Referral tracking | `summonBaalFromReferrer()` with `DaoReferral` event | Not present |
| Loot naming | Auto-appends " LOOT" / "-LOOT" | Fully customizable (separate name/symbol params) |
| Init actions | Encoded as multisend batch via delegatecall | Direct parameter decoding in setUp; no post-setup execution |
| Init action error handling | Errors swallowed | Revert data forwarded (assembly-based revert propagation) |

### 4.2 DAOShipAndVaultLauncher

| Aspect | Upstream | DAO Ships |
|--------|----------|-----|
| Purpose | Vault **registry** (tracks existing vaults) | Vault **factory** (creates new vaults atomically) |
| Vault creation | Calls `_baalSummoner.deployAndSetupSafe()` | Calls `IQuaiVaultFactory.createWallet()` |
| Vault registry | Yes: `mapping(uint256 => Vault)` with active/inactive tracking | No registry |
| Delegate system | DAOs can set delegates to manage vault entries | Not present |
| Upgradeability | UUPS | Not upgradeable |
| Avatar replacement | Not needed (Safe address known at summon time) | Decodes init params, replaces avatar placeholder with actual vault address |
| DelegateCall control | Not applicable (Safe uses guard framework) | Per-target `delegatecallAllowed` whitelist; MultiSendCallOnly whitelisted by default |
| Address prediction | Not available | `calculateAllAddresses()` for all 4 contracts (DAOShip, shares, loot, vault) |
| Existing vault support | Not applicable | `launchDAOShipWithVault()` for connecting to pre-existing vaults |

These are entirely different designs. Upstream's BaalAndVaultSummoner is primarily a vault registry. DAO Ships' is a purpose-built atomic deployment factory.

---

## 5. Navigators

| Navigator | DAO Ships | Upstream Equivalent |
|--------|-----|---------------------|
| `OnboarderNavigator` | Instant native-token onboarding | No equivalent in production |
| `ERC20TributeNavigator` | Instant ERC20 onboarding | Partially similar to TributeMinion but without governance vote |

Upstream's TributeMinion (176 lines) is a proposal-based tribute system with ERC20 escrow and DAO voting. DAO Ships' navigators are instant-onboarding with richer features:

- Dual pricing modes (multiplier or fixed-price)
- Merkle allowlists
- Mint caps (global and per-address via `perAddressCap`)
- Expiry timestamps
- Pause/unpause (GOVERNOR or avatar only)
- `withdrawStuckETH()` for governance recovery (OnboarderNavigator), `withdrawStuckTokens()` (ERC20TributeNavigator)
- `ReentrancyGuard` on all entry points
- Fee-on-transfer token detection (ERC20TributeNavigator: balance-before/after check)
- ERC-2612 permit support (`onboardWithPermit()` on ERC20TributeNavigator — single-tx onboarding)
- `navigatorType()` view function for indexer discovery
- Custom errors throughout

---

## 6. Security Comparison

### Vulnerabilities Fixed in DAO Ships (Not Fixed in Upstream)

| ID | Issue | Upstream Status | DAO Ships Fix |
|----|-------|----------------|---------|
| H-1 | `executeAsGovernance` calls arbitrary addresses | Open: `_to.call{value}(_data)` | Self-call only + `_inProposalExecution` guard |
| H-4 | Flash-loan self-sponsoring | Open: uses `getVotes()` (current block) | `getPriorVotes(timestamp - 1)` |
| M-6 | sponsorThreshold > totalSupply deadlocks governance | Open | `_effectiveSponsorThreshold()` caps at supply |
| M-7 | Ready proposals remain processable forever (zombie proposals) | Open: no auto-expiry | `defaultExpiryWindow` with Expired state |
| -- | Sequential proposal queue limits throughput | Open: predecessor check required | **Parallel execution:** no queue, any Ready proposal processable independently |
| L-1 | MANAGER burns can deadlock governance | Open: no burn guard | `BurnBreachesSponsorThreshold` error |
| L-2 | proposalCount uint32 overflow | Open: silent wrap | `require(proposalCount < type(uint32).max)` |
| -- | uint32 overflow in votingEnds/graceEnds | Open: `unchecked` arithmetic | `MAX_VOTING_PERIOD` / `MAX_GRACE_PERIOD` bounds |
| -- | No minimum voting period | Open: can set to 0 | `MIN_VOTING_PERIOD = 60` |
| -- | isModuleEnabled guard | N/A (Safe-level) | `require(isModuleEnabled)` on processProposal + ragequit |
| -- | multisendLibrary=0 bricks proposals | Open | Explicit validation in setUp |
| -- | Self-sponsor ETH loss | Not checked | Reverts if `msg.value > 0` when self-sponsoring |
| -- | Delegation stale after ragequit+rejoin | Never cleared | Delegation cleared on full burn |

### Features Present in Upstream, Missing in DAO Ships

| Feature | Impact | DAO Ships Mitigation |
|---------|--------|----------------|
| EIP-712 signature voting | Gasless voting | Members submit on-chain (acceptable for Quai's low fees) |
| delegateBySig | Gasless delegation | Members delegate on-chain |
| Meta-transactions (OpenGSN) | Relayer-paid gas | Not needed on Quai |
| Token upgradeability (UUPS) | Fix token bugs post-deploy | Accept immutability; redeploy if critical |
| ERC20 Snapshots | Off-chain historical balance queries | Use checkpoint system or events |
| Referral tracking | Ecosystem analytics | Can be added to frontend/events |
| setTrustedForwarder() | Change meta-tx forwarder | Removed (no EIP-2771 support) |
| votingPeriod=0 as no-op | Partial config updates | Pass current value explicitly |

### Shared Architectural Risks

| Issue | Description | Status in Both |
|-------|-------------|----------------|
| MANAGER unrestricted mint | MANAGER navigators can mint without limit | Architectural; mitigated by operator documentation |
| GOVERNOR instant param change | GOVERNOR can change governance config immediately | Mitigated in DAO Ships by `MIN_VOTING_PERIOD` |
| Malicious guild token blocks ragequit | A reverting token can block ragequit | Mitigated by member-controlled token array in the ragequit call |
| MultiSend sub-DelegateCall | Sub-transactions could delegatecall into vault | DAO Ships: MultiSendCallOnly rejects `operation=1`; vault whitelist restricts targets |

---

## 7. Gas & Efficiency

| Operation | Upstream | DAO Ships | Savings |
|-----------|----------|-----|---------|
| Checkpoint write | 2 storage slots (~40K gas) | 1 storage slot (~20K gas) | ~50% |
| DAO deployment | ~4M gas (ERC1967 proxies + Safe) | ~300K gas (EIP-1167 clones) | ~93% |
| Permission check | 4-way equality comparison | Single bitwise AND | Minor |
| totalShares/totalLoot | External call to token contract | Cached state variables | ~2600 gas per read |
| setUp | Requires multisend delegatecall | Direct loops | Lower gas, simpler flow |
| Proposal pass check | Calls `_didProposalPass` for all states | Skips for Ready state | Minor per-process |
| Proposal writes | Writes all fields | Writes only non-zero fields | Saves SSTORE for defaults |
| totalSupply in quorum | External calls to both token contracts | Reads cached `totalShares` / `totalLoot` | ~5200 gas |

---

## 8. Feature Matrix

| Feature | Upstream | DAO Ships |
|---------|----------|-----|
| Share-weighted voting | Yes | Yes |
| Delegation | Yes | Yes |
| Delegation by signature | Yes | No |
| Vote by signature | Yes | No |
| Meta-transactions | Yes (OpenGSN) | No |
| Proposal submit/sponsor/vote/process | Yes | Yes |
| Self-sponsoring | Yes | Yes (with flash-loan protection) |
| Grace period ragequit | Yes | Yes |
| Ragequit retention check | In processProposal only | In processProposal **and** ragequit |
| Guild token registration | No (any token accepted) | Yes (governance-approved) |
| Proposal auto-expiry | No | Yes (`defaultExpiryWindow`) |
| Proposal cancellation (Submitted state) | No | Yes |
| Submitter cancellation | No (sponsor cancels) | Yes |
| Parallel proposal execution | No (sequential queue) | Yes (any Ready proposal processable independently) |
| Defeated proposal processing | No | Yes (processable with empty data) |
| convertSharesToLoot | No | Yes |
| EIP-2612 Permit (Shares) | No | Yes (clone-safe) |
| EIP-2612 Permit (Loot) | Yes (upgradeable) | Yes (clone-safe) |
| Mint cap (Shares) | `type(uint256).max / 2` | `type(uint216).max` (aligned with checkpoint packing) |
| Mint cap (Loot) | `type(uint256).max / 2` | `type(uint256).max / 2` |
| Navigator permission locks | Yes | Yes (with admin lock bypass for governance) |
| Token upgradeability | Yes (UUPS) | No |
| Factory upgradeability | Yes (UUPS) | No |
| Deterministic address prediction | No | Yes (all 4 contracts) |
| DAOShipUtils encodeMultisend | No | Yes |
| Poster (EIP-3722) | Not included | Included |
| OnboarderNavigator (native token) | Removed from production | Included |
| ERC20TributeNavigator | TributeMinion (proposal-based) | Instant onboarding |
| Vault registry | Yes (BaalAndVaultSummoner) | No |
| Referral tracking | Yes | No |
| per-address mint caps (navigators) | No | Yes |
| Merkle allowlists (navigators) | No | Yes |
| Fee-on-transfer detection | No | Yes (ERC20TributeNavigator) |

---

## 9. What DAO Ships Has That Upstream Doesn't

1. **`executeAsGovernance` self-call restriction** with `_inProposalExecution` guard (H-1 fix)
2. **Flash-loan-resistant sponsorship** via `getPriorVotes(timestamp - 1)` (H-4 fix)
3. **`_effectiveSponsorThreshold()`** that caps at current supply (M-6 fix)
4. **`defaultExpiryWindow`** with Expired proposal state (M-7 fix)
5. **Parallel proposal execution** — no sequential queue; any Ready proposal can be processed independently (try/catch + `actionFailed` ensures one reverting proposal cannot block others; retention check still works per-proposal)
6. **Burn guard** preventing MANAGER burns from deadlocking governance (L-1 fix)
7. **proposalCount overflow check** (L-2 fix)
8. **`MAX_VOTING_PERIOD` / `MAX_GRACE_PERIOD`** bounds preventing uint32 overflow
9. **`MIN_VOTING_PERIOD = 60`** preventing zero-length voting windows
10. **`isModuleEnabled` guard** on processProposal and ragequit
11. **Delegation clearing on full burn** for clean re-entry
12. **Packed checkpoints** (uint40 + uint216 in 1 slot)
13. **EIP-2612 Permit on SharesERC20** (clone-safe, storage-based domain separator)
14. **Defeated proposal processing** (processable with empty data, no queue dependency)
15. **`convertSharesToLoot`** for voluntary voting power reduction
16. **Submitter-based cancellation** (not sponsor-based)
17. **Submitted state cancellation** (before sponsorship)
18. **Self-sponsor ETH rejection** preventing accidental ETH loss
19. **Per-address mint caps** on both navigators
20. **Merkle allowlists** on both navigators
21. **Deterministic address prediction** for all contracts
22. **No initializationActions** — launchers have no post-setup execution capability, eliminating an attack surface
23. **52 custom errors** (zero require strings in DAOShip.sol)
24. **Head count tracking** (yesVotes/noVotes as uint32) separate from share-weighted balance
25. **DAOShipUtils library** for `encodeMultisend`
26. **EIP-2612 Permit on LootERC20** (clone-safe, matching upstream feature parity)
27. **Mint caps** on both tokens (Shares: `type(uint216).max`, Loot: `type(uint256).max / 2`)

---

## 10. What Upstream Has That DAO Ships Doesn't

1. **Gnosis Safe ecosystem integration** (Safe modules, Safe apps, Safe UI)
2. **Zodiac Module inheritance** (`Module.exec()`, `setAvatar()`, `setTarget()`, `Ownable`)
3. **OpenGSN meta-transactions** (`_msgSender()`, `setTrustedForwarder()`)
4. **EIP-712 signature voting** (`submitVoteWithSig()`)
5. **EIP-712 signature delegation** (`delegateBySig()`)
6. **Token upgradeability** (UUPS proxy, owner can upgrade token logic)
7. **Factory upgradeability** (UUPS proxy, owner can change singletons via `setAddrs()`)
8. **ERC20 Snapshots** (on-chain historical balance queries for both tokens)
9. **Vault registry** with active/inactive tracking and delegate management
10. **Referral tracking** (`DaoReferral` event for ecosystem analytics)
11. **Partial governance config updates** (0 = "keep current value")

---

## 11. Summary

**DAO Ships is ahead of upstream on:**
- Governance security (flash-loan protection, executeAsGovernance scoping, deadlock prevention, parallel proposal execution, burn guards)
- Input validation (period bounds, overflow checks, multisend validation, module enablement guard)
- Gas efficiency (packed checkpoints, cached totals, EIP-1167 clones, inline state checks)
- Code clarity (OZ v5, Solidity 0.8.22, bitwise permissions, custom errors, self-contained initialization)
- Navigator functionality (dual pricing, allowlists, per-address caps, expiry, fee-on-transfer detection)

**Upstream is ahead of DAO Ships on:**
- Ecosystem integration (Gnosis Safe, Zodiac, OpenGSN, DAOhaus tooling)
- Flexibility (token upgradeability, factory upgradeability, meta-transactions)
- Gasless UX (signature voting, signature delegation)
- Off-chain tooling (ERC20 Snapshots, referral tracking, vault registry)

**Bottom line:** DAO Ships is a more secure and more efficient implementation of the same governance model, purpose-built for Quai Network. It trades upstream's Ethereum ecosystem integration and upgrade flexibility for stronger security guarantees, lower gas costs, and unlimited parallel proposal throughput (vs upstream's sequential queue). Neither codebase is universally better -- the tradeoffs are appropriate for their respective deployment targets.
