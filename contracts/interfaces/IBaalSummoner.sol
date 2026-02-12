// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

/**
 * @title IBaalSummoner
 * @notice Interface for BaalSummoner factory contract
 * @dev Used by BaalAndVaultSummoner to call BaalSummoner as a separate contract
 */
interface IBaalSummoner {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when a new Baal is summoned
     * @param baal Deployed Baal address
     * @param shares Deployed SharesERC20 address
     * @param loot Deployed LootERC20 address
     * @param avatar Quai Vault address (treasury)
     * @param forwarder Trusted forwarder address
     * @param summoner Address that summoned the DAO
     */
    event SummonBaal(
        address indexed baal,
        address indexed shares,
        address indexed loot,
        address avatar,
        address forwarder,
        address summoner
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Summon a new Baal DAO
     * @dev Deploys clones and initializes with provided parameters
     * @param initializationParams Encoded initialization data (see Baal.setUp)
     * @param initializationActions Optional setup actions to execute (e.g., setGuildTokens)
     * @param sharesSalt Create2 salt for SharesERC20 clone
     * @param lootSalt Create2 salt for LootERC20 clone
     * @param baalSalt Create2 salt for Baal clone
     * @return baal Deployed Baal address
     */
    function summonBaal(
        bytes calldata initializationParams,
        bytes[] calldata initializationActions,
        uint256 sharesSalt,
        uint256 lootSalt,
        uint256 baalSalt
    ) external returns (address payable baal);

    /**
     * @notice Calculate deterministic addresses for a given sender and salts
     * @param sender Address that will call summonBaal
     * @param sharesSalt Create2 salt for SharesERC20 clone
     * @param lootSalt Create2 salt for LootERC20 clone
     * @param baalSalt Create2 salt for Baal clone
     * @return baal Predicted Baal address
     * @return shares Predicted SharesERC20 address
     * @return loot Predicted LootERC20 address
     */
    function calculateAddresses(
        address sender,
        uint256 sharesSalt,
        uint256 lootSalt,
        uint256 baalSalt
    ) external view returns (address baal, address shares, address loot);

    // ═══════════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Get Baal singleton implementation address
     * @return Baal singleton address
     */
    function baalSingleton() external view returns (address);

    /**
     * @notice Get SharesERC20 singleton implementation address
     * @return SharesERC20 singleton address
     */
    function sharesSingleton() external view returns (address);

    /**
     * @notice Get LootERC20 singleton implementation address
     * @return LootERC20 singleton address
     */
    function lootSingleton() external view returns (address);
}
