// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "../core/Baal.sol";

/**
 * @title EthOnboarderShaman
 * @notice Simple ETH → shares/loot onboarding with fixed price per unit
 * @dev Simpler variant of OnboarderShaman with direct pricePerUnit
 *
 * Features:
 * - Fixed price per share/loot unit
 * - No multiplier math (easier to understand)
 * - Expiration support
 * - ETH forwarded to DAO treasury
 *
 * Example: pricePerUnit = 0.1 ETH, sharePerUnit = 1, lootPerUnit = 0
 *          Sending 1 ETH mints 10 shares
 */
contract EthOnboarderShaman {
    // ═══════════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Associated Baal DAO
    Baal public baal;

    /// @notice Price in wei per unit (e.g., 0.1 ETH = 100000000000000000)
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
     * @param amount ETH amount sent
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
     * @notice Onboard by sending ETH
     * @dev Calculates units based on msg.value / pricePerUnit
     *      Any remainder is refunded
     */
    function onboard() external payable {
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
     * @notice Fallback function to accept ETH and trigger onboard
     */
    receive() external payable {
        this.onboard();
    }
}
