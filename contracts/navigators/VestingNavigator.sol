// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../core/DAOShip.sol";
import "../interfaces/INavigator.sol";
import "../libraries/Permissions.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title VestingNavigator
 * @notice Mints shares or loot on a cliff + linear vesting schedule. Tokens are
 *         minted incrementally as they vest — nothing is minted up front, so
 *         unvested tokens never exist on-chain and carry no voting power until
 *         claimed. Each schedule vests a single token kind (shares OR loot).
 *
 * @dev MANAGER navigator (permission 2). Calls `daoShip.mintShares` / `mintLoot`
 *      from `claim`. Schedules are created only by governance (the avatar, via a
 *      passed proposal). Standalone — NOT a BaseNavigator: `claim` may be called
 *      by the beneficiary *or* the avatar, so BaseNavigator's `msg.sender`-keyed
 *      caps would mis-attribute. Dilution is instead bounded per schedule by the
 *      governance-set `totalAmount`.
 *
 * Vesting math (cliff then linear; see `_vestedAmount`):
 *   - before `cliffEnd`            → 0
 *   - at/after `vestingEnd`        → `totalAmount` (exact; final claim sweeps any
 *                                     integer-division dust)
 *   - in between                   → totalAmount * (t - startTime) / (vestingEnd - startTime)
 *
 * Revocation is NON-DESTRUCTIVE: `revoke` freezes the clock at `revokedAt` so no
 * further vesting accrues, but it does not burn already-minted tokens and the
 * beneficiary may still claim whatever had vested up to `revokedAt`. Burning
 * already-vested tokens (if desired) is a separate governance `burnShares` call.
 */
contract VestingNavigator is ReentrancyGuard, INavigator {

    // ═══════════════════════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Navigator type identifier for indexer discovery
    string public constant navigatorType = "VestingNavigator";

    /// @dev Sourced from the shared Permissions library — single definition of the
    ///      navigator permission bits, resolved at compile time (no runtime DAO call,
    ///      so it is safe under the predicted-address deployment pattern).
    uint256 private constant _GOVERNOR = Permissions.GOVERNOR;

    // ═══════════════════════════════════════════════════════════════════════════
    // Immutables
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Address that deployed this navigator
    address public immutable deployer;

    /// @notice Associated DAOShip DAO (mints routed here)
    DAOShip public immutable daoShip;

    // ═══════════════════════════════════════════════════════════════════════════
    // Storage
    // ═══════════════════════════════════════════════════════════════════════════

    // Field order is chosen for storage packing (4 slots, not 5):
    //   slot0: beneficiary(20) + isLoot(1) + revoked(1)
    //   slot1: totalAmount   slot2: claimed
    //   slot3: startTime(8) + cliffEnd(8) + vestingEnd(8) + revokedAt(8) = 32 bytes
    struct VestingSchedule {
        address beneficiary;
        bool isLoot;          // false = shares, true = loot
        bool revoked;
        uint256 totalAmount;
        uint256 claimed;
        uint64 startTime;
        uint64 cliffEnd;
        uint64 vestingEnd;
        uint64 revokedAt;
    }

    /// @notice Number of schedules ever created; also the id of the next schedule
    uint256 public scheduleCount;

    /// @dev Public getter omits nothing (no nested mappings)
    mapping(uint256 => VestingSchedule) public schedules;

    /// @notice Schedule ids for a beneficiary (enumeration)
    mapping(address => uint256[]) private beneficiarySchedules;

    /// @notice Whether creating new schedules is paused
    bool public paused;

    // ═══════════════════════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════════════════════

    event ScheduleCreated(
        uint256 indexed scheduleId,
        address indexed beneficiary,
        uint256 totalAmount,
        uint64 startTime,
        uint64 cliffEnd,
        uint64 vestingEnd,
        bool isLoot
    );
    event TokensClaimed(uint256 indexed scheduleId, address indexed beneficiary, uint256 amount, bool isLoot);
    event ScheduleRevoked(uint256 indexed scheduleId, address indexed caller, uint64 revokedAt, uint256 vestedAtRevoke);
    event Paused(address indexed caller);
    event Unpaused(address indexed caller);

    // ═══════════════════════════════════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidConfig();
    error NotAuthorized();
    error IsPaused();
    error InvalidBeneficiary();
    error ZeroAmount();
    error CliffExceedsVesting();
    error ScheduleDoesNotExist();
    error NothingToClaim();
    error AlreadyRevoked();

    // ═══════════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @param _daoShip DAOShip DAO address (mint target)
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
    // External — write
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Create a vesting schedule (avatar only — via governance proposal)
     * @param beneficiary Recipient of the vested tokens
     * @param totalAmount Total tokens to vest over the schedule (> 0)
     * @param startTime Vesting start (0 = now); may be back- or future-dated by governance
     * @param cliffDuration Seconds from start before anything vests (<= vestingDuration)
     * @param vestingDuration Total vesting length in seconds (> 0)
     * @param isLoot false = vest shares, true = vest loot
     * @return scheduleId Id of the new schedule
     */
    function createSchedule(
        address beneficiary,
        uint256 totalAmount,
        uint64 startTime,
        uint64 cliffDuration,
        uint64 vestingDuration,
        bool isLoot
    ) external nonReentrant returns (uint256 scheduleId) {
        if (paused) revert IsPaused();
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();
        if (beneficiary == address(0)) revert InvalidBeneficiary();
        if (totalAmount == 0) revert ZeroAmount();
        if (vestingDuration == 0) revert InvalidConfig();
        if (cliffDuration > vestingDuration) revert CliffExceedsVesting();

        uint64 start = startTime == 0 ? uint64(block.timestamp) : startTime;
        uint64 cliffEnd = start + cliffDuration;
        uint64 vestingEnd = start + vestingDuration;

        scheduleId = scheduleCount++;
        VestingSchedule storage s = schedules[scheduleId];
        s.beneficiary = beneficiary;
        s.totalAmount = totalAmount;
        s.startTime = start;
        s.cliffEnd = cliffEnd;
        s.vestingEnd = vestingEnd;
        s.isLoot = isLoot;

        beneficiarySchedules[beneficiary].push(scheduleId);

        emit ScheduleCreated(scheduleId, beneficiary, totalAmount, start, cliffEnd, vestingEnd, isLoot);
    }

    /**
     * @notice Claim vested-but-unclaimed tokens for a schedule
     * @dev Beneficiary or avatar. Mints to the schedule's beneficiary regardless
     *      of caller. CEI: `claimed` is updated before the external mint.
     * @param scheduleId Schedule to claim from
     */
    function claim(uint256 scheduleId) external nonReentrant {
        VestingSchedule storage s = _getSchedule(scheduleId);
        if (msg.sender != s.beneficiary && msg.sender != daoShip.avatar()) revert NotAuthorized();

        uint256 amount = _vestedAmount(s) - s.claimed;
        if (amount == 0) revert NothingToClaim();

        s.claimed += amount;
        _mint(s.beneficiary, amount, s.isLoot);

        emit TokensClaimed(scheduleId, s.beneficiary, amount, s.isLoot);
    }

    /**
     * @notice Revoke a schedule, freezing vesting at the current time (avatar only)
     * @dev Non-destructive: already-minted tokens are untouched; the beneficiary can
     *      still claim whatever vested up to `revokedAt`. Future accrual stops.
     * @param scheduleId Schedule to revoke
     */
    function revoke(uint256 scheduleId) external nonReentrant {
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();
        VestingSchedule storage s = _getSchedule(scheduleId);
        if (s.revoked) revert AlreadyRevoked();

        s.revoked = true;
        s.revokedAt = uint64(block.timestamp);

        emit ScheduleRevoked(scheduleId, msg.sender, s.revokedAt, _vestedAmount(s));
    }

    /**
     * @notice Pause creation of new schedules (GOVERNOR navigator or avatar)
     * @dev Does not affect claims or revokes on existing schedules.
     */
    function pause() external {
        if (!_isGovernorOrAvatar(msg.sender)) revert NotAuthorized();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Resume creation of new schedules (GOVERNOR navigator or avatar)
    function unpause() external {
        if (!_isGovernorOrAvatar(msg.sender)) revert NotAuthorized();
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External — views
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Total amount vested so far for a schedule (capped at revokedAt if revoked)
    function vested(uint256 scheduleId) external view returns (uint256) {
        return _vestedAmount(_getSchedule(scheduleId));
    }

    /// @notice Vested-but-unclaimed amount currently claimable
    function claimable(uint256 scheduleId) external view returns (uint256) {
        VestingSchedule storage s = _getSchedule(scheduleId);
        return _vestedAmount(s) - s.claimed;
    }

    /// @notice All schedule ids for a beneficiary
    function getSchedules(address beneficiary) external view returns (uint256[] memory) {
        return beneficiarySchedules[beneficiary];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @dev Vested amount for a schedule at the effective time (revokedAt if revoked,
     *      else now). Monotonic up to the freeze point; never exceeds totalAmount.
     */
    function _vestedAmount(VestingSchedule storage s) private view returns (uint256) {
        uint64 effectiveEnd = s.revoked ? s.revokedAt : uint64(block.timestamp);
        if (effectiveEnd < s.cliffEnd) return 0;
        if (effectiveEnd >= s.vestingEnd) return s.totalAmount;
        // cliffEnd >= startTime, so (effectiveEnd - startTime) cannot underflow here;
        // (vestingEnd - startTime) == vestingDuration > 0, so no division by zero.
        return (s.totalAmount * (effectiveEnd - s.startTime)) / (s.vestingEnd - s.startTime);
    }

    /// @dev Resolve a schedule storage pointer, reverting on a never-created id
    function _getSchedule(uint256 scheduleId) private view returns (VestingSchedule storage) {
        if (scheduleId >= scheduleCount) revert ScheduleDoesNotExist();
        return schedules[scheduleId];
    }

    /// @dev Mint shares or loot to a single recipient via DAOShip
    function _mint(address to, uint256 amount, bool isLoot) private {
        address[] memory recipients = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        recipients[0] = to;
        amounts[0] = amount;
        if (isLoot) {
            daoShip.mintLoot(recipients, amounts);
        } else {
            daoShip.mintShares(recipients, amounts);
        }
    }

    /// @dev True if `account` is a GOVERNOR navigator on the DAO or the DAO avatar
    function _isGovernorOrAvatar(address account) private view returns (bool) {
        return (daoShip.navigators(account) & _GOVERNOR) != 0 || account == daoShip.avatar();
    }
}
