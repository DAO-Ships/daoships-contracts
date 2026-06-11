// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../core/DAOShip.sol";
import "../interfaces/INavigator.sol";
import "../interfaces/IAvatar.sol";
import "../libraries/Enum.sol";
import "../libraries/Permissions.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BudgetNavigator
 * @notice Lets governance approve a recurring spending budget against the DAO treasury
 *         (the Quai Vault) and delegate execution of that budget to a per-budget
 *         `manager`, who can pay out within two governance-set caps — a per-period
 *         allowance that resets each period and a lifetime ceiling — WITHOUT a
 *         governance proposal per payment.
 *
 * @dev TREASURY DISBURSEMENT ONLY. This navigator holds NO DAOShip permission bit
 *      (no ADMIN/MANAGER/GOVERNOR — it never mints, burns, or changes config). Its
 *      only privilege is being an ENABLED MODULE on the vault, which it uses to move
 *      treasury assets via `IAvatar.execTransactionFromModule`. Compensating
 *      contributors in *shares/loot* on a schedule is a different concern, handled by
 *      VestingNavigator — keep the two separate so this contract can drain only the
 *      treasury, never dilute the cap table.
 *
 *      Standalone (NOT a BaseNavigator): there is no minting and no `msg.sender`-keyed
 *      cap to inherit. Spending discipline lives entirely here, because the vault
 *      imposes NO per-module limit — an enabled module may `Call` the vault for any
 *      amount. Every disbursement path is therefore manager-gated, cap-checked,
 *      `nonReentrant`, and CEI-ordered, and the disbursement primitive is hardcoded to
 *      `Operation.Call` (this navigator never performs or accepts a DelegateCall).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TRUST MODEL — READ THIS.
 * ────────────────────────────────────────────────────────────────────────────
 * Being a vault module grants UNBOUNDED transfer ability at the vault layer; the
 * vault will not stop an oversized pull. All limits are enforced in THIS contract,
 * so its correctness is the treasury's only on-chain guarantee. The blast radius is
 * scoped by role:
 *   - A compromised `manager` is bounded to its budget's `allowancePerPeriod` (per
 *     period) and `totalCeiling` (lifetime) — never the whole treasury.
 *   - A bug in THIS contract that lets a disbursement exceed those caps risks the
 *     whole treasury, which is why the surface is kept minimal and the only function
 *     that touches the vault is the internal `_transfer`, reachable solely from the
 *     two manager-gated disburse paths.
 * Governance recourse escalates: `pause` (fast freeze of all outflows, by a GOVERNOR
 * navigator or the avatar) → `cancelBudget` (surgical, by the avatar) → the vault
 * owners disabling this module entirely (`vault.disableModule`, nuclear).
 *
 * Disbursement mechanics mirror the audited DAOShip.ragequit treasury path exactly:
 *   - native QUAI : execTransactionFromModule(to,    amount, "",                 Call)
 *   - ERC20       : execTransactionFromModule(token, 0,      transfer(to,amount), Call)
 * The returned `success` bool is checked and reverts the disbursement on failure.
 * As with ragequit, the per-budget `token` is governance-vetted at `createBudget`
 * time (same trust as a guild token), so the raw-bool success check is sufficient.
 */
contract BudgetNavigator is ReentrancyGuard, INavigator {

    // ═══════════════════════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Navigator type identifier for indexer discovery
    string public constant navigatorType = "BudgetNavigator";

    /// @dev Sourced from the shared Permissions library — single definition of the
    ///      navigator permission bits, resolved at compile time (no runtime DAO call,
    ///      so it is safe under the predicted-address deployment pattern).
    uint256 private constant _GOVERNOR = Permissions.GOVERNOR;

    /// @notice Minimum permitted period length — a sanity floor (sub-hour budget
    ///         periods are nonsensical for treasury spending).
    uint64 public constant MIN_PERIOD = 1 hours;

    /// @notice Maximum permitted period length.
    /// @dev Overflow backstop for the uint64 period math and a deploy-time sanity gate.
    uint64 public constant MAX_PERIOD = 3650 days;

    // ═══════════════════════════════════════════════════════════════════════════
    // Immutables
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Address that deployed this navigator
    address public immutable deployer;

    /// @notice Associated DAOShip DAO. The treasury is `daoShip.avatar()` (the vault).
    DAOShip public immutable daoShip;

    // ═══════════════════════════════════════════════════════════════════════════
    // Storage
    // ═══════════════════════════════════════════════════════════════════════════

    // Field order is chosen for storage packing (7 slots):
    //   slot0: manager(20) + periodLength(8) + cancelled(1) = 29 bytes
    //   slot1: token(20)   + currentPeriodStart(8)          = 28 bytes
    //   slot2: startsAt(8) + endsAt(8)                       = 16 bytes
    //   slot3: allowancePerPeriod  slot4: totalCeiling
    //   slot5: totalSpent          slot6: spentThisPeriod
    struct Budget {
        address manager;            // disbursement authority for this budget
        uint64  periodLength;       // seconds; allowance resets each period
        bool    cancelled;
        address token;              // address(0) = native QUAI, else ERC20
        uint64  currentPeriodStart; // anchor for the current period (lazily advanced)
        uint64  startsAt;           // budget is inactive before this time
        uint64  endsAt;             // 0 = perpetual; else inactive at/after this time
        uint256 allowancePerPeriod; // max disbursable per period
        uint256 totalCeiling;       // lifetime cap (> 0)
        uint256 totalSpent;         // cumulative disbursed, all periods
        uint256 spentThisPeriod;    // disbursed in the current (lazily-synced) period
    }

    /// @notice Number of budgets ever created; also the id of the next budget
    uint256 public budgetCount;

    /// @dev Public getter exposes every field (no nested mappings). NOTE: the raw
    ///      `spentThisPeriod`/`currentPeriodStart` are lazily synced — read
    ///      `remainingThisPeriod` for the live, period-adjusted figure.
    mapping(uint256 => Budget) public budgets;

    /// @notice Emergency freeze: blocks createBudget and ALL disbursements
    bool public paused;

    // ═══════════════════════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════════════════════

    event BudgetCreated(
        uint256 indexed budgetId,
        address indexed manager,
        address token,
        uint256 allowancePerPeriod,
        uint256 totalCeiling,
        uint64 periodLength,
        uint64 startsAt,
        uint64 endsAt
    );
    /// @dev Emitted once per recipient — disburse emits one, disburseBatch emits N —
    ///      so the indexer has a single uniform payout record type.
    event Disbursed(uint256 indexed budgetId, address indexed to, address token, uint256 amount);
    event ManagerUpdated(uint256 indexed budgetId, address indexed oldManager, address indexed newManager);
    event BudgetCancelled(uint256 indexed budgetId, address indexed caller);
    event Paused(address indexed caller);
    event Unpaused(address indexed caller);

    // ═══════════════════════════════════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidConfig();
    error NotAuthorized();
    error IsPaused();
    error InvalidManager();
    error InvalidRecipient();
    error ZeroAmount();
    error InvalidPeriod();
    error BudgetDoesNotExist();
    error BudgetCancelled_();
    error AlreadyCancelled();
    error NotStarted();
    error BudgetEnded();
    error AllowanceExceeded();
    error CeilingExceeded();
    error LengthMismatch();
    error EmptyBatch();
    error NotEnabledModule();
    error TransferFailed();

    // ═══════════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @param _daoShip DAOShip DAO address (its avatar/vault is the treasury)
     * @param _name Human-readable name (optional, can be empty)
     * @param _description Human-readable description (optional, can be empty)
     */
    constructor(address _daoShip, string memory _name, string memory _description) {
        if (_daoShip == address(0)) revert InvalidConfig();

        deployer = msg.sender;
        daoShip = DAOShip(payable(_daoShip));

        emit NavigatorDeployed(_daoShip, msg.sender, navigatorType, _name, _description);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — write (governance / avatar)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Create a spending budget (avatar only — via governance proposal)
     * @dev Reachable only from a passed proposal, which executes through the vault and
     *      so arrives with `msg.sender == daoShip.avatar()`. Does not itself enable the
     *      module; the wiring proposal must also call `vault.enableModule(this)` (it can
     *      batch both). Blocked while paused.
     * @param manager Disbursement authority for this budget (non-zero)
     * @param token Asset to disburse: address(0) for native QUAI, else an ERC20
     * @param allowancePerPeriod Max disbursable per period (> 0)
     * @param totalCeiling Lifetime cap across all periods (> 0)
     * @param periodLength Period length in seconds (MIN_PERIOD..MAX_PERIOD)
     * @param startTime Activation time (0 = now); may be future- or back-dated by governance
     * @param endTime Expiry time (0 = perpetual); if set, must be after the effective start
     * @return budgetId Id of the new budget
     */
    function createBudget(
        address manager,
        address token,
        uint256 allowancePerPeriod,
        uint256 totalCeiling,
        uint64 periodLength,
        uint64 startTime,
        uint64 endTime
    ) external nonReentrant returns (uint256 budgetId) {
        if (paused) revert IsPaused();
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();
        if (manager == address(0)) revert InvalidManager();
        if (allowancePerPeriod == 0) revert ZeroAmount();
        if (totalCeiling == 0) revert InvalidConfig();
        if (periodLength < MIN_PERIOD || periodLength > MAX_PERIOD) revert InvalidPeriod();

        uint64 start = startTime == 0 ? uint64(block.timestamp) : startTime;
        if (endTime != 0 && endTime <= start) revert InvalidConfig();

        budgetId = budgetCount++;
        Budget storage b = budgets[budgetId];
        b.manager = manager;
        b.token = token;
        b.allowancePerPeriod = allowancePerPeriod;
        b.totalCeiling = totalCeiling;
        b.periodLength = periodLength;
        b.currentPeriodStart = start;
        b.startsAt = start;
        b.endsAt = endTime;

        emit BudgetCreated(budgetId, manager, token, allowancePerPeriod, totalCeiling, periodLength, start, endTime);
    }

    /**
     * @notice Replace a budget's manager (avatar only — via governance proposal)
     * @dev The primary recourse against an absent or rogue manager short of cancelling.
     * @param budgetId Budget to update
     * @param newManager New disbursement authority (non-zero)
     */
    function updateManager(uint256 budgetId, address newManager) external {
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();
        if (newManager == address(0)) revert InvalidManager();
        Budget storage b = _getBudget(budgetId);
        if (b.cancelled) revert BudgetCancelled_();

        address old = b.manager;
        b.manager = newManager;
        emit ManagerUpdated(budgetId, old, newManager);
    }

    /**
     * @notice Permanently cancel a budget (avatar only — via governance proposal)
     * @dev Irreversible. After cancellation no further disbursements are possible.
     *      Does not claw back already-disbursed funds.
     * @param budgetId Budget to cancel
     */
    function cancelBudget(uint256 budgetId) external {
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();
        Budget storage b = _getBudget(budgetId);
        if (b.cancelled) revert AlreadyCancelled();

        b.cancelled = true;
        emit BudgetCancelled(budgetId, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — write (manager: disbursement)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Disburse `amount` of the budget's token to `to` (manager only)
     * @dev Bounded by the budget's per-period allowance and lifetime ceiling. CEI:
     *      the spend counters are written before the vault transfer, so a failed
     *      transfer reverts the whole call (counters roll back via EVM atomicity).
     * @param budgetId Budget to spend from
     * @param to Recipient (non-zero)
     * @param amount Amount to disburse (> 0)
     */
    function disburse(uint256 budgetId, address to, uint256 amount) external nonReentrant {
        Budget storage b = _authorizeSpend(budgetId);
        if (to == address(0)) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();

        _syncPeriod(b);
        if (b.spentThisPeriod + amount > b.allowancePerPeriod) revert AllowanceExceeded();
        if (b.totalSpent + amount > b.totalCeiling) revert CeilingExceeded();

        // Effects before interaction (CEI)
        b.spentThisPeriod += amount;
        b.totalSpent += amount;

        _transfer(b.token, to, amount);
        emit Disbursed(budgetId, to, b.token, amount);
    }

    /**
     * @notice Disburse to many recipients in one call (manager only) — payroll
     * @dev The batch sum is checked against the same per-period allowance and lifetime
     *      ceiling as `disburse`. Atomic: if any single transfer fails the entire batch
     *      reverts (no partial-spend accounting drift). Batch size is bounded by gas —
     *      keep it to a few dozen recipients.
     * @param budgetId Budget to spend from
     * @param to Recipients (each non-zero)
     * @param amounts Amount per recipient (each > 0), parallel to `to`
     */
    function disburseBatch(
        uint256 budgetId,
        address[] calldata to,
        uint256[] calldata amounts
    ) external nonReentrant {
        Budget storage b = _authorizeSpend(budgetId);
        uint256 n = to.length;
        if (n != amounts.length) revert LengthMismatch();
        if (n == 0) revert EmptyBatch();

        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            if (to[i] == address(0)) revert InvalidRecipient();
            if (amounts[i] == 0) revert ZeroAmount();
            total += amounts[i];
        }

        _syncPeriod(b);
        if (b.spentThisPeriod + total > b.allowancePerPeriod) revert AllowanceExceeded();
        if (b.totalSpent + total > b.totalCeiling) revert CeilingExceeded();

        // Effects before interactions (CEI)
        b.spentThisPeriod += total;
        b.totalSpent += total;

        address token = b.token;
        for (uint256 i = 0; i < n; i++) {
            _transfer(token, to[i], amounts[i]);
            emit Disbursed(budgetId, to[i], token, amounts[i]);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — write (emergency: governor or avatar)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Freeze createBudget and ALL disbursements (GOVERNOR navigator or avatar)
     * @dev The fast emergency brake — a GOVERNOR navigator (e.g. an emergency-pause
     *      navigator) or the avatar can halt every outflow without waiting for a full
     *      proposal to cancel individual budgets.
     */
    function pause() external {
        if (!_isGovernorOrAvatar(msg.sender)) revert NotAuthorized();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Resume disbursements and budget creation (GOVERNOR navigator or avatar)
    function unpause() external {
        if (!_isGovernorOrAvatar(msg.sender)) revert NotAuthorized();
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — views
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Live remaining allowance for the current period (accounts for lazy reset)
     * @dev Returns 0 if the budget is cancelled or outside its active window. If the
     *      period has rolled over since the last disbursement, returns the full
     *      `allowancePerPeriod` (the on-chain `spentThisPeriod` is stale until the next
     *      disburse syncs it).
     */
    function remainingThisPeriod(uint256 budgetId) external view returns (uint256) {
        Budget storage b = _getBudget(budgetId);
        if (b.cancelled || !_isActive(b)) return 0;

        uint256 spent = block.timestamp >= uint256(b.currentPeriodStart) + b.periodLength
            ? 0
            : b.spentThisPeriod;
        uint256 periodLeft = spent >= b.allowancePerPeriod ? 0 : b.allowancePerPeriod - spent;

        // The lifetime ceiling can bind tighter than the period allowance.
        uint256 totalLeft = b.totalSpent >= b.totalCeiling ? 0 : b.totalCeiling - b.totalSpent;
        return periodLeft < totalLeft ? periodLeft : totalLeft;
    }

    /// @notice Remaining lifetime budget (totalCeiling - totalSpent)
    function remainingTotal(uint256 budgetId) external view returns (uint256) {
        Budget storage b = _getBudget(budgetId);
        return b.totalSpent >= b.totalCeiling ? 0 : b.totalCeiling - b.totalSpent;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @dev Shared disbursement preamble: resolves the budget, enforces that the caller
     *      is the manager, the navigator is unpaused, the budget is live, and this
     *      navigator is actually an enabled module on the vault (clear error instead of
     *      an opaque transfer failure). Returns the storage pointer for the caller.
     */
    function _authorizeSpend(uint256 budgetId) private view returns (Budget storage b) {
        if (paused) revert IsPaused();
        b = _getBudget(budgetId);
        if (msg.sender != b.manager) revert NotAuthorized();
        if (b.cancelled) revert BudgetCancelled_();
        if (block.timestamp < b.startsAt) revert NotStarted();
        if (b.endsAt != 0 && block.timestamp >= b.endsAt) revert BudgetEnded();
        if (!IAvatar(daoShip.avatar()).isModuleEnabled(address(this))) revert NotEnabledModule();
    }

    /**
     * @dev Lazily advance the budget to the current period and reset the per-period
     *      spend. No keeper needed: the reset is computed on the next disbursement.
     *      Reached only after `_authorizeSpend` has confirmed `block.timestamp >=
     *      startsAt == initial currentPeriodStart`, so the subtraction cannot underflow.
     */
    function _syncPeriod(Budget storage b) private {
        uint256 periodEnd = uint256(b.currentPeriodStart) + b.periodLength;
        if (block.timestamp >= periodEnd) {
            uint256 periodsElapsed = (block.timestamp - b.currentPeriodStart) / b.periodLength;
            b.currentPeriodStart += uint64(periodsElapsed * b.periodLength);
            b.spentThisPeriod = 0;
        }
    }

    /**
     * @dev Move treasury assets out of the vault via the module path. Native and ERC20
     *      branches mirror DAOShip.ragequit exactly. Hardcoded to Operation.Call —
     *      this navigator never performs a DelegateCall.
     */
    function _transfer(address token, address to, uint256 amount) private {
        address avatar = daoShip.avatar();
        bool success;
        if (token == address(0)) {
            success = IAvatar(avatar).execTransactionFromModule(to, amount, "", Enum.Operation.Call);
        } else {
            success = IAvatar(avatar).execTransactionFromModule(
                token,
                0,
                abi.encodeWithSelector(IERC20.transfer.selector, to, amount),
                Enum.Operation.Call
            );
        }
        if (!success) revert TransferFailed();
    }

    /// @dev Resolve a budget storage pointer, reverting on a never-created id
    function _getBudget(uint256 budgetId) private view returns (Budget storage) {
        if (budgetId >= budgetCount) revert BudgetDoesNotExist();
        return budgets[budgetId];
    }

    /// @dev True if `now` is within the budget's [startsAt, endsAt) active window
    function _isActive(Budget storage b) private view returns (bool) {
        if (block.timestamp < b.startsAt) return false;
        if (b.endsAt != 0 && block.timestamp >= b.endsAt) return false;
        return true;
    }

    /// @dev True if `account` is a GOVERNOR navigator on the DAO or the DAO avatar
    function _isGovernorOrAvatar(address account) private view returns (bool) {
        return (daoShip.navigators(account) & _GOVERNOR) != 0 || account == daoShip.avatar();
    }
}
