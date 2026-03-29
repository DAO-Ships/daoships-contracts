// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IDAOShipLauncher
 * @notice Interface for DAOShipLauncher factory contract
 * @dev Used by DAOShipAndVaultLauncher to call DAOShipLauncher as a separate contract
 */
interface IDAOShipLauncher {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when a new DAOShip is launched
     * @param daoShip Deployed DAOShip address
     * @param shares Deployed SharesERC20 address
     * @param loot Deployed LootERC20 address
     * @param avatar Quai Vault address (treasury)
     * @param launcher Address that launched the DAO
     */
    event LaunchDAOShip(
        address indexed daoShip,
        address indexed shares,
        address indexed loot,
        address avatar,
        address launcher
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Launch a new DAOShip DAO
     * @dev Deploys clones and initializes with provided parameters.
     *      All launch-time configuration (members, navigators, guild tokens, token pausing)
     *      is handled by DAOShip.setUp() — no post-setup actions are needed.
     * @param initializationParams Encoded initialization data (see DAOShip.setUp)
     * @param shareTokenName Name for the shares token (e.g., "My DAO Shares")
     * @param shareTokenSymbol Symbol for the shares token (e.g., "MDAO")
     * @param lootTokenName Name for the loot token (e.g., "My DAO Loot")
     * @param lootTokenSymbol Symbol for the loot token (e.g., "MDAO-LOOT")
     * @param sharesSalt Create2 salt for SharesERC20 clone
     * @param lootSalt Create2 salt for LootERC20 clone
     * @param daoShipSalt Create2 salt for DAOShip clone
     * @return daoShip Deployed DAOShip address
     * @return shares Deployed SharesERC20 address
     * @return loot Deployed LootERC20 address
     */
    function launchDAOShip(
        bytes calldata initializationParams,
        string calldata shareTokenName,
        string calldata shareTokenSymbol,
        string calldata lootTokenName,
        string calldata lootTokenSymbol,
        uint256 sharesSalt,
        uint256 lootSalt,
        uint256 daoShipSalt
    ) external returns (address payable daoShip, address shares, address loot);

    /**
     * @notice Calculate deterministic addresses for a given sender and salts
     * @param sender Address that will call launchDAOShip
     * @param sharesSalt Create2 salt for SharesERC20 clone
     * @param lootSalt Create2 salt for LootERC20 clone
     * @param daoShipSalt Create2 salt for DAOShip clone
     * @return daoShip Predicted DAOShip address
     * @return shares Predicted SharesERC20 address
     * @return loot Predicted LootERC20 address
     */
    function calculateAddresses(
        address sender,
        uint256 sharesSalt,
        uint256 lootSalt,
        uint256 daoShipSalt
    ) external view returns (address daoShip, address shares, address loot);

    // ═══════════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Get DAOShip singleton implementation address
     * @return DAOShip singleton address
     */
    function daoShipSingleton() external view returns (address);

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
