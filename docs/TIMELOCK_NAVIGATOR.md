# TimelockNavigator — Canonical Reference & Audit Sign-off

Source of truth for the Timelock navigator. Indexer and app integration guides live in their own
repos and reference this document; the indexer event spec is in `docs/INDEXER-GUIDE.md`
(TimelockNavigator section).

- **Contract:** `contracts/navigators/TimelockNavigator.sol`
- **Interface:** `contracts/interfaces/INavigator.sol`
- **Deploy script:** `scripts/deploy/007_deploy_timelock_navigator.ts`
- **Tests:** `test/unit/TimelockNavigator.test.ts` (30 passing); local E2E `test/e2e/local/TimelockNavigator.e2e.test.ts` (3 passing); on-chain E2E Phase 2g in `test/e2e/onchain/OnChainDAOLifecycle.test.ts`
- **Permission tier:** GOVERNOR (4)
- **Extends:** none — **standalone** (not `BaseNavigator`; it mints nothing, it gates config changes)

---

## 1. What it does

Wraps `DAOShip.setGovernanceConfig` behind a **mandatory delay**. Instead of a passed proposal
applying a governance-parameter change directly, the proposal **queues** the change here; the change
becomes executable only after `delay` seconds and stays executable for `expiryWindow` seconds. The
delay is a **second ragequit window** (after `gracePeriod`) specific to config changes — members who
disagree with a passed parameter change can exit before it takes effect.

### Lifecycle (additive to the normal proposal flow)

```
votingPeriod → gracePeriod → proposal processed (calls queueChange)
  → delay (second ragequit window) → executeChange
```

### ⚠️ Advisory, not enforced — read this

The timelock **cannot** be made mandatory at the contract layer. A governance proposal can always
bypass it by calling `setGovernanceConfig` directly via `DAOShip.executeAsGovernance` — that path runs
the inner call as `msg.sender == address(daoShip)`, which `onlyGovernor` accepts. `lockGovernor()` does
**not** close this (governance reaches governor functions through `executeAsGovernance` regardless of
navigator locks). So the guarantee is:

- **ENFORCED against a rogue/buggy GOVERNOR *navigator*:** such a navigator can only *queue* (delayed,
  cancellable, visible) changes, never apply them instantly — **provided the timelock is the only
  GOVERNOR navigator granted** (see gotcha 8).
- **ADVISORY against a malicious *proposal*:** a proposal author can route around the timelock with a
  direct `executeAsGovernance`. "All config changes go through the timelock" is a **social + tooling**
  commitment: the dapp routes config changes through `queueChange`, and the indexer raises a warning on
  any proposal that calls `setGovernanceConfig` directly on a timelock-enabled DAO.

### Config is stored hash-only

Only `keccak256(_governanceConfig)` is stored on-chain (gas). The **full config bytes are emitted in
`ChangeQueued`** and must be re-supplied verbatim to `executeChange`. The navigator does **not** decode
or validate the config — `DAOShip.setGovernanceConfig` validates it at execute time, so a malformed
config simply cannot execute and expires harmlessly.

---

## 2. ABI surface

### Constructor

```solidity
constructor(
    address _daoShip,        // DAOShip clone (target of config changes); reverts InvalidConfig if 0
    uint256 _delay,          // seconds; MIN_DELAY (10 min) .. MAX_DELAY (30 days)
    uint256 _expiryWindow,   // seconds; MIN_EXPIRY (1 hour) .. MAX_EXPIRY (3650 days)
    string  _name,
    string  _description
)
```

Reverts: `InvalidConfig` (`_daoShip == 0`, or `_expiryWindow` out of `[MIN_EXPIRY, MAX_EXPIRY]`),
`DelayTooShort` (`_delay < MIN_DELAY`), `DelayTooLong` (`_delay > MAX_DELAY`). The constructor makes
**no call** to the DAO, so it is safe to deploy against a predicted DAO address.

### Constants

```solidity
string  constant navigatorType    = "TimelockNavigator";
uint256 constant MIN_DELAY        = 10 minutes;  // sanity floor — NOT a protective window
uint256 constant RECOMMENDED_DELAY = 2 days;     // advisory production minimum (NOT enforced)
uint256 constant MAX_DELAY        = 30 days;
uint256 constant MIN_EXPIRY       = 1 hours;
uint256 constant MAX_EXPIRY       = 3650 days;
```

### Functions

```solidity
// Governance (avatar-only — via a passed proposal)
function queueChange(bytes calldata _governanceConfig) external returns (uint256 changeId); // reverts IsPaused
function cancelChange(uint256 changeId) external;     // cancel a pending change

// Permissionless crank
function executeChange(uint256 changeId, bytes calldata _governanceConfig) external; // nonReentrant; after delay

// GOVERNOR navigator OR avatar
function emergencyCancelAll() external;  // cancel ALL pending changes + pause queueing
function pause() external;               // block new queueChange (does NOT block executeChange)
function unpause() external;

// Views
function isExecutable(uint256 changeId) external view returns (bool); // ready, unexpired, not executed/cancelled
function queuedChanges(uint256 changeId) external view returns (...); // public struct getter
function changeCount() external view returns (uint256);
function paused() external view returns (bool);
// + immutables: delay(), expiryWindow(), daoShip()
// + INavigator: deployer(), navigatorType()
```

### Events

```solidity
event ChangeQueued(uint256 indexed changeId, address indexed queuedBy, bytes32 configHash,
                   bytes governanceConfig, uint64 executableAfter, uint64 expiresAt);  // full bytes here
event ChangeExecuted(uint256 indexed changeId, address indexed executor, bytes32 configHash);
event ChangeCancelled(uint256 indexed changeId, address indexed caller);
event Paused(address indexed caller);
event Unpaused(address indexed caller);
event NavigatorDeployed(address indexed daoShip, address indexed deployer, string navigatorType, string name, string description);
```

`ChangeQueued.governanceConfig` carries the **full config bytes** — the only place they exist on-chain.
Indexers and the dapp must persist them so `executeChange` can be supplied the exact bytes later.

### Errors

`InvalidConfig`, `NotAuthorized`, `IsPaused`, `ChangeDoesNotExist`, `ChangeNotReady`, `ChangeExpired`,
`ChangeAlreadyExecuted`, `ChangeAlreadyCancelled`, `ConfigHashMismatch`, `DelayTooShort`, `DelayTooLong`.

---

## 3. Configuration guidance

- **Sizing the delay.** `MIN_DELAY` (10 min) is only a *sanity floor* — it guarantees a queued change is
  observable before it executes, **not** that members have time to react. For the delay to be a real
  second exit window it must be **sized in days** and longer than `gracePeriod`; pass at least
  `RECOMMENDED_DELAY` (2 days). The deploy script warns on `delay < RECOMMENDED_DELAY`. See
  `SECURITY_GUIDE.md` (TimelockNavigator delay).
- **Must be registered as GOVERNOR (4)** via a `setNavigators` governance proposal — unlike MANAGER
  navigators, it needs governor powers to call the `onlyGovernor` `setGovernanceConfig`.
- **`expiryWindow`** should comfortably exceed your operational latency (a few days) so a matured change
  isn't missed before it expires.

---

## 4. Gotchas (read this)

1. **Advisory, not enforced (§1).** A proposal can bypass the timelock via `executeAsGovernance`. Enforce
   "route config changes through `queueChange`" in the dapp; have the indexer flag direct
   `setGovernanceConfig` calls on a timelock-enabled DAO.
2. **`MIN_DELAY` is not protection.** 10 minutes is too short for members to notice and ragequit. Use
   `RECOMMENDED_DELAY` (≥ 2 days) in production.
3. **It must keep GOVERNOR (4).** If governance revokes the navigator's GOVERNOR bit, `executeChange`
   reverts (it can no longer call `setGovernanceConfig`). A queued change then sits until it expires.
4. **Config bytes are hash-only on-chain — you must keep the full bytes.** Recover them from the
   `ChangeQueued` event; `executeChange` requires the exact bytes (`ConfigHashMismatch` otherwise). Lose
   them and the change can never execute (it expires harmlessly).
5. **`executeChange` is permissionless.** Anyone can crank a matured change — it was already authorized
   by the avatar at queue time. The only thing a caller controls is *when* within the window it lands.
6. **Pause only blocks new queues.** `pause()` does **not** stop execution of already-queued changes — to
   stop a pending change use `cancelChange(id)` (avatar) or `emergencyCancelAll()` (the emergency brake,
   which also pauses).
7. **Execution window.** A change is executable only in `[executableAfter, expiresAt]`. Before → `ChangeNotReady`;
   after → `ChangeExpired` (it can no longer execute; cancel it for bookkeeping if you like).
8. **The ENFORCED guarantee assumes the timelock is the *only* GOVERNOR navigator.** If a second GOVERNOR
   navigator is ever granted, it could reach `setGovernanceConfig` and the "navigator can only queue"
   property weakens. Treat "timelock is the sole GOVERNOR navigator" as an operational invariant.
9. **The navigator never validates config.** `DAOShip.setGovernanceConfig` does, at execute time. A
   malformed config reverts in `executeChange` (CEI rolls back the `executed` flag), so it stays
   retryable until `expiresAt` — no lock-out.
10. **`emergencyCancelAll` iterates `changeCount`.** Bounded in practice (each queue requires a full
    multi-day proposal, so the id space grows slowly), but technically unbounded — see the audit note.

---

## 5. Security audit sign-off

No Critical/High open against the contract.

| Lens | Outcome |
|---|---|
| Blockchain Security Auditor (access control / reentrancy / timestamp math / the advisory claim) | No Crit/High. Avatar-gating correct (`queueChange`/`cancelChange` reachable only via a passed proposal); `executeChange` CEI-correct (`executed` set before the external call) and `nonReentrant`; uint64 timestamp math safe (now + ≤ 10 years ≪ 2^64). The "advisory, not enforced" claim was **verified accurate** against `DAOShip.executeAsGovernance`/`onlyGovernor`. |
| Operational review | `emergencyCancelAll` unbounded-loop (**T-M-1**) accepted as backlog — the emergency brake could theoretically gas-out only after *thousands* of queued changes (years of constant governance), and the mitigation already exists (`pause()` + per-id `cancelChange`). A paged variant is a possible future hardening. |

**Verified properties:** only the avatar can queue/cancel (passed-proposal path); permissionless execution
is safe (config pre-authorized at queue time, hash-checked, CEI-correct); malformed config can't lock the
slot (rolls back, retryable until expiry); pause cannot trap a matured change from executing; the advisory
bypass is documented and asserted in the local E2E (a direct `executeAsGovernance` applies config while
`changeCount` stays 0).

**Operational caveats (configuration, not contract defects):** advisory enforcement is social + tooling
(§1, §4.1); `MIN_DELAY` is a sanity floor, not protection (§4.2); the enforced guarantee assumes the
timelock is the sole GOVERNOR navigator (§4.8).

**Verdict:** Production-ready. The advisory nature is by design and honestly documented.

---

## 6. Deployment

`scripts/deploy/007_deploy_timelock_navigator.ts` (env-configured; floor-checks `delay`/`expiryWindow`
and warns when `delay < RECOMMENDED_DELAY`). After deploy, register as **GOVERNOR (2's sibling, value 4)**
via a `setNavigators([thisNav],[4])` governance proposal, then route config changes through `queueChange`.
Each navigator is bound to one DAOShip clone and is immutable — change config by deploying a new instance
and re-registering.
