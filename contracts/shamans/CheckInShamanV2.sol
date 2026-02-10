// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "../core/Baal.sol";

/**
 * @title CheckInShamanV2
 * @notice Periodic rewards shaman with miss tracking and slashing
 * @dev MANAGER shaman that mints shares/loot on periodic check-ins
 *      Tracks missed claims and can slash inactive members
 *
 * Features:
 * - Configurable claim interval (e.g., 30 days)
 * - Fixed shares/loot per claim
 * - Miss tracking: count consecutive missed claims
 * - Auto-slash after max missed claims exceeded
 * - First claim immediate, subsequent claims require interval
 *
 * Use Cases:
 * - Continuous contributor rewards
 * - DAO engagement incentives
 * - Activity-based membership maintenance
 * - Reputation building via consistency
 *
 * Security:
 * - Requires MANAGER permission on Baal
 * - Only member can claim for themselves
 * - Slashing prevents indefinite dormancy
 */
contract CheckInShamanV2 {
    // ═══════════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Associated Baal DAO
    Baal public baal;

    /// @notice Interval between claims in seconds (e.g., 30 days = 2592000)
    uint256 public claimInterval;

    /// @notice Shares minted per successful claim
    uint256 public sharesPerClaim;

    /// @notice Loot minted per successful claim
    uint256 public lootPerClaim;

    /// @notice Maximum consecutive missed claims before slashing
    uint256 public maxMissedClaims;

    /// @notice Mapping of member address to last claim timestamp
    mapping(address => uint256) public lastClaimTimestamp;

    /// @notice Mapping of member address to consecutive missed claims
    mapping(address => uint256) public missedClaims;

    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when a member claims
     * @param member Address that claimed
     * @param shares Shares minted
     * @param loot Loot minted
     * @param timestamp Claim timestamp
     * @param missedCount Missed claims count (before this claim)
     */
    event CheckIn(
        address indexed member,
        uint256 shares,
        uint256 loot,
        uint256 timestamp,
        uint256 missedCount
    );

    /**
     * @notice Emitted when a member is slashed for inactivity
     * @param member Address that was slashed
     * @param missedCount Final missed claims count
     */
    event Slash(address indexed member, uint256 missedCount);

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deploy CheckInShamanV2
     * @param _baal Baal DAO address
     * @param _claimInterval Seconds between claims (e.g., 2592000 for 30 days)
     * @param _sharesPerClaim Shares minted per claim
     * @param _lootPerClaim Loot minted per claim
     * @param _maxMissedClaims Max consecutive misses before slash (0 = no slashing)
     */
    constructor(
        address _baal,
        uint256 _claimInterval,
        uint256 _sharesPerClaim,
        uint256 _lootPerClaim,
        uint256 _maxMissedClaims
    ) {
        require(_baal != address(0), "CheckInShamanV2: invalid baal");
        require(_claimInterval > 0, "CheckInShamanV2: invalid interval");
        require(_sharesPerClaim > 0 || _lootPerClaim > 0, "CheckInShamanV2: no rewards");

        baal = Baal(payable(_baal));
        claimInterval = _claimInterval;
        sharesPerClaim = _sharesPerClaim;
        lootPerClaim = _lootPerClaim;
        maxMissedClaims = _maxMissedClaims;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CHECK-IN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Check in to claim periodic rewards
     * @dev First claim is immediate, subsequent claims require interval
     *      Tracks missed claims if checking in late
     */
    function checkIn() external {
        uint256 lastClaim = lastClaimTimestamp[msg.sender];
        uint256 currentTime = block.timestamp;

        // First claim (immediate)
        if (lastClaim == 0) {
            _mintRewards(msg.sender, 0);
            lastClaimTimestamp[msg.sender] = currentTime;
            return;
        }

        // Check if claim is available
        uint256 nextClaimTime = lastClaim + claimInterval;
        require(currentTime >= nextClaimTime, "CheckInShamanV2: too early");

        // Calculate missed claims (if late)
        uint256 timeSinceLast = currentTime - lastClaim;
        uint256 periodsPassed = timeSinceLast / claimInterval;
        uint256 missed = periodsPassed - 1; // -1 because current claim doesn't count as missed

        // Check if max missed exceeded (slash condition)
        if (maxMissedClaims > 0 && missed >= maxMissedClaims) {
            _slash(msg.sender, missed);
            return;
        }

        // Update missed count
        if (missed > 0) {
            missedClaims[msg.sender] += missed;
        } else {
            // Reset missed count on successful on-time claim
            missedClaims[msg.sender] = 0;
        }

        // Mint rewards
        uint256 currentMissed = missedClaims[msg.sender];
        _mintRewards(msg.sender, currentMissed);

        // Update last claim timestamp to current period start (not currentTime)
        // This prevents drift and maintains consistent intervals
        lastClaimTimestamp[msg.sender] = lastClaim + (periodsPassed * claimInterval);
    }

    /**
     * @notice Check if a member can claim now
     * @param member Address to check
     * @return canClaim Whether claim is available
     * @return nextClaimTime When next claim is available (0 if now)
     * @return missedCount Current missed claims count
     */
    function canCheckIn(address member)
        external
        view
        returns (bool canClaim, uint256 nextClaimTime, uint256 missedCount)
    {
        uint256 lastClaim = lastClaimTimestamp[member];

        // First claim always available
        if (lastClaim == 0) {
            return (true, 0, 0);
        }

        nextClaimTime = lastClaim + claimInterval;
        canClaim = block.timestamp >= nextClaimTime;
        missedCount = missedClaims[member];

        // Check if would be slashed
        if (canClaim && maxMissedClaims > 0) {
            uint256 timeSinceLast = block.timestamp - lastClaim;
            uint256 periodsPassed = timeSinceLast / claimInterval;
            uint256 missed = periodsPassed - 1;

            if (missed >= maxMissedClaims) {
                canClaim = false; // Would be slashed, not a valid claim
            }
        }

        return (canClaim, nextClaimTime, missedCount);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Internal function to mint rewards
     * @param member Address to mint to
     * @param currentMissed Current missed claims count
     */
    function _mintRewards(address member, uint256 currentMissed) internal {
        // Mint shares if configured
        if (sharesPerClaim > 0) {
            address[] memory recipients = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            recipients[0] = member;
            amounts[0] = sharesPerClaim;
            baal.mintShares(recipients, amounts);
        }

        // Mint loot if configured
        if (lootPerClaim > 0) {
            address[] memory recipients = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            recipients[0] = member;
            amounts[0] = lootPerClaim;
            baal.mintLoot(recipients, amounts);
        }

        emit CheckIn(member, sharesPerClaim, lootPerClaim, block.timestamp, currentMissed);
    }

    /**
     * @notice Internal function to slash inactive member
     * @param member Address to slash
     * @param missed Final missed count
     */
    function _slash(address member, uint256 missed) internal {
        // Burn all shares and loot
        uint256 memberShares = baal.sharesToken().balanceOf(member);
        uint256 memberLoot = baal.lootToken().balanceOf(member);

        if (memberShares > 0) {
            address[] memory members = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            members[0] = member;
            amounts[0] = memberShares;
            baal.burnShares(members, amounts);
        }

        if (memberLoot > 0) {
            address[] memory members = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            members[0] = member;
            amounts[0] = memberLoot;
            baal.burnLoot(members, amounts);
        }

        // Reset state
        lastClaimTimestamp[member] = 0;
        missedClaims[member] = 0;

        emit Slash(member, missed);
    }
}
