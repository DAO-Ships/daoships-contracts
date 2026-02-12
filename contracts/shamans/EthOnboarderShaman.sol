// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "../core/Baal.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title EthOnboarderShaman
 * @notice Simple native token → shares/loot onboarding with fixed price per unit
 * @dev Simpler variant of OnboarderShaman with direct pricePerUnit
 *
 * NOTE: "Eth" in the name is for compatibility with Baal ecosystem contracts.
 *       On Quai Network, this shaman accepts QUAI (native token), not ETH.
 *
 * Features:
 * - Fixed price per share/loot unit
 * - No multiplier math (easier to understand)
 * - Expiration support
 * - Native tokens forwarded to DAO treasury (QUAI on Quai Network)
 *
 * Example: pricePerUnit = 0.1 QUAI, sharePerUnit = 1, lootPerUnit = 0
 *          Sending 1 QUAI mints 10 shares
 *
 * Security:
 * - ReentrancyGuard protects against reentrancy attacks
 */
contract EthOnboarderShaman is ReentrancyGuard {
    // ═══════════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Associated Baal DAO
    Baal public baal;

    /// @notice Price in wei per unit (e.g., 0.1 QUAI = 100000000000000000)
    uint256 public pricePerUnit;

    /// @notice Shares minted per unit purchased
    uint256 public sharePerUnit;

    /// @notice Loot minted per unit purchased
    uint256 public lootPerUnit;

    /// @notice Expiration timestamp (0 = no expiration)
    uint256 public expiry;

    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when someone onboards
     * @param contributor Address that sent tribute
     * @param amount Native token amount sent (QUAI on Quai Network)
     * @param units Units purchased
     * @param shares Shares minted
     * @param loot Loot minted
     */
    event Onboard(
        address indexed contributor,
        uint256 amount,
        uint256 units,
        uint256 shares,
        uint256 loot
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deploy EthOnboarderShaman
     * @param _baal Baal DAO address
     * @param _pricePerUnit Price in wei per unit
     * @param _sharePerUnit Shares minted per unit
     * @param _lootPerUnit Loot minted per unit
     * @param _expiry Expiration timestamp (0 for no expiry)
     */
    constructor(
        address _baal,
        uint256 _pricePerUnit,
        uint256 _sharePerUnit,
        uint256 _lootPerUnit,
        uint256 _expiry
    ) {
        require(_baal != address(0), "EthOnboarderShaman: invalid baal");
        require(_pricePerUnit > 0, "EthOnboarderShaman: invalid price");
        require(_sharePerUnit > 0 || _lootPerUnit > 0, "EthOnboarderShaman: no rewards");

        baal = Baal(payable(_baal));
        pricePerUnit = _pricePerUnit;
        sharePerUnit = _sharePerUnit;
        lootPerUnit = _lootPerUnit;
        expiry = _expiry;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ONBOARDING
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Onboard by sending native tokens (QUAI on Quai Network)
     * @dev Calculates units based on msg.value / pricePerUnit
     *      Any remainder is refunded
     */
    function onboard() public payable nonReentrant {
        require(msg.value >= pricePerUnit, "EthOnboarderShaman: insufficient payment");
        require(expiry == 0 || block.timestamp <= expiry, "EthOnboarderShaman: expired");

        // Calculate units purchased (round down)
        uint256 units = msg.value / pricePerUnit;
        require(units > 0, "EthOnboarderShaman: zero units");

        uint256 cost = units * pricePerUnit;
        uint256 remainder = msg.value - cost;

        // Calculate shares and loot to mint
        uint256 sharesToMint = units * sharePerUnit;
        uint256 lootToMint = units * lootPerUnit;

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

        // Forward cost to DAO treasury
        (bool success, ) = baal.avatar().call{value: cost}("");
        require(success, "EthOnboarderShaman: transfer failed");

        // Refund remainder
        if (remainder > 0) {
            (bool refundSuccess, ) = msg.sender.call{value: remainder}("");
            require(refundSuccess, "EthOnboarderShaman: refund failed");
        }

        emit Onboard(msg.sender, cost, units, sharesToMint, lootToMint);
    }

    /**
     * @notice Fallback function to accept QUAI and trigger onboard
     */
    receive() external payable {
        onboard();
    }
}
