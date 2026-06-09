// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../core/DAOShip.sol";
import "../interfaces/INavigator.sol";
import "../libraries/Permissions.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title TimelockNavigator
 * @notice Wraps `DAOShip.setGovernanceConfig` behind a mandatory delay. A passed
 *         governance proposal queues a parameter change here instead of applying it
 *         directly; the change becomes executable only after `delay` seconds and
 *         remains executable for `expiryWindow` seconds thereafter. The delay is a
 *         second ragequit window: members who disagree with a passed parameter
 *         change can exit before it takes effect.
 *
 * @dev GOVERNOR navigator. Holds GOVERNOR (4) permission on DAOShip so that
 *      `executeChange` can call the `onlyGovernor` `setGovernanceConfig`. No DAOShip
 *      code changes are required to use this navigator.
 *
 * Lifecycle (additive to the existing proposal flow):
 *   votingPeriod → gracePeriod → proposal processed (calls `queueChange`)
 *     → delay (second ragequit window) → `executeChange`
 *
 * Sizing the delay: `MIN_DELAY` is only a sanity floor (the change must not execute
 * instantly) — it is NOT a protective window. Minutes are not enough time for members
 * to notice a passed config change and ragequit ahead of it, and the existing
 * `gracePeriod` already provides the first exit window for every proposal. For this
 * navigator's delay to function as a real *second* exit window it must be meaningfully
 * longer than the grace period, sized in days. Production DAOs should therefore pass at
 * least `RECOMMENDED_DELAY` (2 days). The contract enforces only the `MIN_DELAY` floor;
 * the dapp/indexer surface a warning for sub-`RECOMMENDED_DELAY` deployments.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ADVISORY, NOT ENFORCED — READ THIS.
 * ────────────────────────────────────────────────────────────────────────────
 * This navigator CANNOT make the timelock mandatory at the contract layer. A
 * governance proposal can always bypass it and call `setGovernanceConfig`
 * directly via `DAOShip.executeAsGovernance`, because that path executes the
 * inner call as `msg.sender == address(daoShip)`, which `onlyGovernor` accepts.
 * `lockGovernor()` does not close this hole — governance reaches governor
 * functions through `executeAsGovernance` regardless of navigator locks.
 *
 * Therefore the timelock's guarantee is:
 *   - ENFORCED against a rogue/buggy GOVERNOR *navigator*: such a navigator can
 *     only queue (delayed, cancellable, visible) changes, never apply them
 *     instantly — provided the timelock is the only GOVERNOR navigator granted.
 *   - ADVISORY against a malicious *proposal*: a proposal author can route around
 *     the timelock with a direct `executeAsGovernance` call. Enforcement of "all
 *     config changes go through the timelock" is a SOCIAL + TOOLING commitment:
 *     the dapp routes config changes through `queueChange`, and the indexer
 *     elevates a warning on any proposal that calls `setGovernanceConfig`
 *     directly on a timelock-enabled DAO.
 *
 * Config storage is hash-only (gas): only `keccak256(_governanceConfig)` is
 * stored. The full config bytes are emitted in `ChangeQueued` and must be
 * re-supplied to `executeChange`. The navigator does NOT decode or validate the
 * config — `DAOShip.setGovernanceConfig` validates it at execute time, so a
 * malformed config simply cannot be executed and expires harmlessly.
 */
contract TimelockNavigator is ReentrancyGuard, INavigator {

    // ═══════════════════════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Navigator type identifier for indexer discovery
    string public constant navigatorType = "TimelockNavigator";

    /// @dev Sourced from the shared Permissions library — single definition of the
    ///      navigator permission bits, resolved at compile time (no runtime DAO call,
    ///      so it is safe under the predicted-address deployment pattern).
    uint256 private constant _GOVERNOR = Permissions.GOVERNOR;

    /// @notice Minimum permitted delay — a sanity floor ("not instant"), NOT a
    ///         protective guarantee.
    /// @dev Exists only so a queued change is observable on-chain before it can
    ///      execute. Ten minutes is far too short to be a meaningful member exit
    ///      window; production DAOs SHOULD pass a delay of at least
    ///      `RECOMMENDED_DELAY`. See the "Sizing the delay" note in the contract header.
    uint256 public constant MIN_DELAY = 10 minutes;

    /// @notice Recommended minimum delay for production DAOs (advisory; NOT enforced).
    /// @dev A real "second ragequit window" must give members days — not minutes — to
    ///      notice a passed config change and exit at the pre-change terms. Two days
    ///      matches common governance-timelock practice (e.g. Compound's MINIMUM_DELAY).
    ///      The contract enforces only the looser `MIN_DELAY` sanity floor; the dapp and
    ///      indexer should steer deployers to `>= RECOMMENDED_DELAY` and warn below it.
    uint256 public constant RECOMMENDED_DELAY = 2 days;

    /// @notice Maximum permitted delay
    uint256 public constant MAX_DELAY = 30 days;

    /// @notice Minimum permitted expiry window
    uint256 public constant MIN_EXPIRY = 1 hours;

    /// @notice Upper bound for the expiry window.
    /// @dev Overflow backstop for the uint64 timestamp math
    ///      (`queuedAt + delay + expiryWindow`) and a sanity gate at deploy time.
    uint256 public constant MAX_EXPIRY = 3650 days;

    // ═══════════════════════════════════════════════════════════════════════════
    // Immutables
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Address that deployed this navigator
    address public immutable deployer;

    /// @notice Associated DAOShip DAO (target of the queued config change)
    DAOShip public immutable daoShip;

    /// @notice Mandatory delay before a queued change becomes executable (seconds)
    uint256 public immutable delay;

    /// @notice How long after `executableAfter` a queued change remains executable (seconds)
    uint256 public immutable expiryWindow;

    // ═══════════════════════════════════════════════════════════════════════════
    // Storage
    // ═══════════════════════════════════════════════════════════════════════════

    struct QueuedChange {
        bytes32 configHash;      // keccak256 of the governance config bytes
        uint64 queuedAt;
        uint64 executableAfter;  // queuedAt + delay
        uint64 expiresAt;        // executableAfter + expiryWindow
        address queuedBy;
        bool executed;
        bool cancelled;
    }

    /// @notice Number of changes ever queued; also the id of the next change
    uint256 public changeCount;

    /// @notice Queued changes by id
    mapping(uint256 => QueuedChange) public queuedChanges;

    /// @notice Whether queueing new changes is paused (does NOT block executing
    ///         already-queued changes — use cancelChange/emergencyCancelAll for that)
    bool public paused;

    // ═══════════════════════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════════════════════

    event ChangeQueued(
        uint256 indexed changeId,
        address indexed queuedBy,
        bytes32 configHash,
        bytes governanceConfig,
        uint64 executableAfter,
        uint64 expiresAt
    );
    event ChangeExecuted(uint256 indexed changeId, address indexed executor, bytes32 configHash);
    event ChangeCancelled(uint256 indexed changeId, address indexed caller);
    event Paused(address indexed caller);
    event Unpaused(address indexed caller);

    // ═══════════════════════════════════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidConfig();
    error NotAuthorized();
    error IsPaused();
    error ChangeDoesNotExist();
    error ChangeNotReady();
    error ChangeExpired();
    error ChangeAlreadyExecuted();
    error ChangeAlreadyCancelled();
    error ConfigHashMismatch();
    error DelayTooShort();
    error DelayTooLong();

    // ═══════════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @param _daoShip DAOShip DAO address (target of queued config changes)
     * @param _delay Mandatory delay in seconds (MIN_DELAY..MAX_DELAY)
     * @param _expiryWindow Executable window after the delay in seconds (MIN_EXPIRY..MAX_EXPIRY)
     * @param _name Human-readable name (optional, can be empty)
     * @param _description Human-readable description (optional, can be empty)
     */
    constructor(
        address _daoShip,
        uint256 _delay,
        uint256 _expiryWindow,
        string memory _name,
        string memory _description
    ) {
        if (_daoShip == address(0)) revert InvalidConfig();
        if (_delay < MIN_DELAY) revert DelayTooShort();
        if (_delay > MAX_DELAY) revert DelayTooLong();
        if (_expiryWindow < MIN_EXPIRY || _expiryWindow > MAX_EXPIRY) revert InvalidConfig();

        deployer = msg.sender;
        daoShip = DAOShip(payable(_daoShip));
        delay = _delay;
        expiryWindow = _expiryWindow;

        emit NavigatorDeployed(_daoShip, msg.sender, navigatorType, _name, _description);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — write
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Queue a governance-config change behind the timelock
     * @dev Avatar only — i.e. only reachable from a passed proposal, which executes
     *      through the vault (`execTransactionFromModule`) and thus arrives with
     *      `msg.sender == daoShip.avatar()`. Stores only the config hash; the full
     *      bytes are emitted for off-chain recovery and must be re-supplied to
     *      `executeChange`.
     * @param _governanceConfig ABI-encoded governance config (see DAOShip.setGovernanceConfig)
     * @return changeId Id of the newly queued change
     */
    function queueChange(bytes calldata _governanceConfig)
        external
        returns (uint256 changeId)
    {
        if (paused) revert IsPaused();
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();

        uint64 executableAfter = uint64(block.timestamp + delay);
        uint64 expiresAt = uint64(block.timestamp + delay + expiryWindow);
        bytes32 configHash = keccak256(_governanceConfig);

        changeId = changeCount++;
        queuedChanges[changeId] = QueuedChange({
            configHash: configHash,
            queuedAt: uint64(block.timestamp),
            executableAfter: executableAfter,
            expiresAt: expiresAt,
            queuedBy: msg.sender,
            executed: false,
            cancelled: false
        });

        emit ChangeQueued(changeId, msg.sender, configHash, _governanceConfig, executableAfter, expiresAt);
    }

    /**
     * @notice Execute a queued change after its delay has elapsed
     * @dev Permissionless — anyone can push a matured change through. The supplied
     *      bytes must hash to the stored `configHash`. Forwards to
     *      `daoShip.setGovernanceConfig`, which validates the config; a malformed
     *      config reverts here (leaving the change un-executed until it expires).
     *      Paused state does NOT block execution — emergencyCancelAll is the tool
     *      for stopping pending changes.
     * @param changeId Id of the change to execute
     * @param _governanceConfig The exact bytes originally queued (recover from ChangeQueued)
     */
    function executeChange(uint256 changeId, bytes calldata _governanceConfig)
        external
        nonReentrant
    {
        QueuedChange storage c = _getChange(changeId);
        if (c.executed) revert ChangeAlreadyExecuted();
        if (c.cancelled) revert ChangeAlreadyCancelled();
        if (block.timestamp < c.executableAfter) revert ChangeNotReady();
        if (block.timestamp > c.expiresAt) revert ChangeExpired();
        if (keccak256(_governanceConfig) != c.configHash) revert ConfigHashMismatch();

        // Effects before interaction (CEI). If setGovernanceConfig reverts (e.g.
        // malformed config), the EVM unwinds this flag too — no lock-out.
        c.executed = true;

        daoShip.setGovernanceConfig(_governanceConfig);

        emit ChangeExecuted(changeId, msg.sender, c.configHash);
    }

    /**
     * @notice Cancel a queued change before it executes
     * @dev Avatar only (via a proposal). Cannot cancel an already-executed or
     *      already-cancelled change. An expired-but-unexecuted change may still be
     *      cancelled for bookkeeping (it could never execute anyway).
     * @param changeId Id of the change to cancel
     */
    function cancelChange(uint256 changeId) external {
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();
        QueuedChange storage c = _getChange(changeId);
        if (c.executed) revert ChangeAlreadyExecuted();
        if (c.cancelled) revert ChangeAlreadyCancelled();

        c.cancelled = true;
        emit ChangeCancelled(changeId, msg.sender);
    }

    /**
     * @notice Cancel ALL pending changes and pause queueing
     * @dev GOVERNOR navigator or avatar. The emergency brake: voids every
     *      not-yet-executed, not-yet-cancelled change and blocks new queues until
     *      `unpause`. Iterates over `changeCount`; this is bounded in practice
     *      because each change requires a full (multi-day) governance proposal to
     *      queue, so the id space grows very slowly.
     */
    function emergencyCancelAll() external {
        if (!_isGovernorOrAvatar(msg.sender)) revert NotAuthorized();

        uint256 n = changeCount;
        for (uint256 i = 0; i < n; i++) {
            QueuedChange storage c = queuedChanges[i];
            if (!c.executed && !c.cancelled) {
                c.cancelled = true;
                emit ChangeCancelled(i, msg.sender);
            }
        }

        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Pause queueing of new changes
     * @dev GOVERNOR navigator or avatar. Does not affect already-queued changes.
     */
    function pause() external {
        if (!_isGovernorOrAvatar(msg.sender)) revert NotAuthorized();
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Resume queueing of new changes
     * @dev GOVERNOR navigator or avatar.
     */
    function unpause() external {
        if (!_isGovernorOrAvatar(msg.sender)) revert NotAuthorized();
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — views
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Whether a change is currently executable (ready, not expired/executed/cancelled)
    function isExecutable(uint256 changeId) external view returns (bool) {
        if (changeId >= changeCount) return false;
        QueuedChange storage c = queuedChanges[changeId];
        return !c.executed
            && !c.cancelled
            && block.timestamp >= c.executableAfter
            && block.timestamp <= c.expiresAt;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Resolve a change storage pointer, reverting on a never-queued id
    function _getChange(uint256 changeId) private view returns (QueuedChange storage) {
        if (changeId >= changeCount) revert ChangeDoesNotExist();
        return queuedChanges[changeId];
    }

    /// @dev True if `account` is a GOVERNOR navigator on the DAO or the DAO avatar
    function _isGovernorOrAvatar(address account) private view returns (bool) {
        return (daoShip.navigators(account) & _GOVERNOR) != 0 || account == daoShip.avatar();
    }
}
