// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "../core/Baal.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title OnboarderShaman
 * @notice Allows anyone to join a Baal DAO by sending native tokens
 * @dev MANAGER shaman that mints shares/loot in exchange for native token tribute
 *      Features configurable multiplier, expiry, and minimum tribute
 *
 * NOTE: On Quai Network, this shaman accepts QUAI (native token), not ETH.
 *       The contract name follows Baal ecosystem conventions.
 *
 * Features:
 * - Native token → shares and/or loot conversion (QUAI on Quai Network)
 * - Multiplier for flexible pricing (e.g., 2x means 1 QUAI = 2 shares)
 * - Expiration timestamp for time-limited onboarding
 * - Minimum tribute requirement (anti-spam)
 * - Only mints to tribute sender (no gifting)
 * - Native tokens forwarded to DAO treasury (avatar)
 *
 * Security:
 * - Requires MANAGER permission on Baal
 * - Cannot mint more than configured amounts
 * - Expiry prevents indefinite access
 * - Minimum tribute prevents dust attacks
 * - ReentrancyGuard protects against reentrancy attacks
 */
contract OnboarderShaman is ReentrancyGuard {
    // ═══════════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Associated Baal DAO
    Baal public baal;

    /// @notice Multiplier for shares (in basis points, 10000 = 1x)
    ///         Example: 20000 = 2x (1 QUAI = 2 shares on Quai Network)
    uint256 public shareMultiplier;

    /// @notice Multiplier for loot (in basis points, 10000 = 1x)
    uint256 public lootMultiplier;

    /// @notice Minimum native token required to onboard (anti-spam, in wei)
    uint256 public minTribute;

    /// @notice Expiration timestamp (0 = no expiration)
    uint256 public expiry;

    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when someone onboards
     * @param contributor Address that sent tribute
     * @param amount Native token amount sent (QUAI on Quai Network, in wei)
     * @param shares Shares minted
     * @param loot Loot minted
     */
    event Onboard(
        address indexed contributor,
        uint256 amount,
        uint256 shares,
        uint256 loot
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deploy OnboarderShaman
     * @param _baal Baal DAO address
     * @param _shareMultiplier Share multiplier (basis points, 10000 = 1x)
     * @param _lootMultiplier Loot multiplier (basis points, 10000 = 1x)
     * @param _minTribute Minimum tribute in wei
     * @param _expiry Expiration timestamp (0 for no expiry)
     */
    constructor(
        address _baal,
        uint256 _shareMultiplier,
        uint256 _lootMultiplier,
        uint256 _minTribute,
        uint256 _expiry
    ) {
        require(_baal != address(0), "OnboarderShaman: invalid baal");
        require(_shareMultiplier > 0 || _lootMultiplier > 0, "OnboarderShaman: no rewards");

        baal = Baal(payable(_baal));
        shareMultiplier = _shareMultiplier;
        lootMultiplier = _lootMultiplier;
        minTribute = _minTribute;
        expiry = _expiry;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ONBOARDING
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Onboard by sending native token tribute (QUAI on Quai Network)
     * @dev Mints shares/loot based on multipliers
     *      Native tokens are forwarded to DAO treasury
     */
    function onboard() public payable nonReentrant {
        require(msg.value >= minTribute, "OnboarderShaman: insufficient tribute");
        require(expiry == 0 || block.timestamp <= expiry, "OnboarderShaman: expired");

        // Calculate shares and loot to mint
        uint256 sharesToMint = (msg.value * shareMultiplier) / 10000;
        uint256 lootToMint = (msg.value * lootMultiplier) / 10000;

        // Mint shares if configured
        if (sharesToMint > 0) {
            address[] memory recipients = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            recipients[0] = msg.sender;
            amounts[0] = sharesToMint;
            baal.mintShares(recipients, amounts);
        }

        // Mint loot if configured
        if (lootToMint > 0) {
            address[] memory recipients = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            recipients[0] = msg.sender;
            amounts[0] = lootToMint;
            baal.mintLoot(recipients, amounts);
        }

        // Forward ETH to DAO treasury
        (bool success, ) = baal.avatar().call{value: msg.value}("");
        require(success, "OnboarderShaman: transfer failed");

        emit Onboard(msg.sender, msg.value, sharesToMint, lootToMint);
    }

    /**
     * @notice Fallback function to accept ETH and trigger onboard
     */
    receive() external payable {
        onboard();
    }
}
