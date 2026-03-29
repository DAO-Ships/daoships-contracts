// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "./DAOShip.sol";
import "../tokens/SharesERC20.sol";
import "../tokens/LootERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title DAOShipLauncher
 * @notice Factory for deploying DAOShip DAOs using EIP-1167 minimal proxies
 * @dev Deploys clones of singleton implementations for gas efficiency
 *      Each DAO gets its own DAOShip, SharesERC20, and LootERC20 instances
 *
 * Gas Savings:
 * - Singleton deployment: ~4M gas (one-time cost)
 * - Clone deployment: ~300K gas per DAO (90% savings)
 *
 * Architecture:
 * - DAOShipLauncher manages singleton addresses
 * - launchDAOShip() creates minimal proxies via Clones.clone()
 * - Initializes via setUp() with encoded parameters
 * - Transfers ownership of tokens to DAOShip contract
 */
contract DAOShipLauncher {
    // ═══════════════════════════════════════════════════════════════════════════════
    // IMMUTABLE SINGLETONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice DAOShip singleton implementation
    address public immutable daoShipSingleton;

    /// @notice SharesERC20 singleton implementation
    address public immutable sharesSingleton;

    /// @notice LootERC20 singleton implementation
    address public immutable lootSingleton;

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
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deploy DAOShipLauncher with singleton implementations
     * @param _daoShipSingleton DAOShip singleton address
     * @param _sharesSingleton SharesERC20 singleton address
     * @param _lootSingleton LootERC20 singleton address
     */
    constructor(
        address _daoShipSingleton,
        address _sharesSingleton,
        address _lootSingleton
    ) {
        require(_daoShipSingleton != address(0), "DAOShipLauncher: invalid daoShip");
        require(_sharesSingleton != address(0), "DAOShipLauncher: invalid shares");
        require(_lootSingleton != address(0), "DAOShipLauncher: invalid loot");

        daoShipSingleton = _daoShipSingleton;
        sharesSingleton = _sharesSingleton;
        lootSingleton = _lootSingleton;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // LAUNCH FUNCTIONS
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
    ) external returns (address payable daoShip, address shares, address loot) {
        // Decode initialization params to get avatar and validate
        // Note: lootToken and sharesToken are ignored (passed as address(0) by caller)
        (
            ,
            ,
            address avatar,
            address multisendLibrary,
            bytes memory governanceConfig,
            address[] memory navigators,
            uint256[] memory navigatorPermissions,
            address[] memory initMembers,
            uint256[] memory initShareAmounts,
            uint256[] memory initLootAmounts,
            address[] memory guildTokens,
            bool pauseSharesOnLaunch,
            bool pauseLootOnLaunch
        ) = abi.decode(
            initializationParams,
            (address, address, address, address, bytes, address[], uint256[], address[], uint256[], uint256[], address[], bool, bool)
        );

        // Validate avatar
        require(avatar != address(0), "DAOShipLauncher: invalid avatar");

        // Deploy token clones with msg.sender-specific salt to prevent front-running
        shares = Clones.cloneDeterministic(sharesSingleton, keccak256(abi.encodePacked(msg.sender, sharesSalt)));
        loot = Clones.cloneDeterministic(lootSingleton, keccak256(abi.encodePacked(msg.sender, lootSalt)));

        // Deploy DAOShip clone
        daoShip = payable(Clones.cloneDeterministic(daoShipSingleton, keccak256(abi.encodePacked(msg.sender, daoShipSalt))));

        // Initialize token clones with DAOShip as owner and custom metadata
        SharesERC20(shares).initialize(daoShip, shareTokenName, shareTokenSymbol);
        LootERC20(loot).initialize(daoShip, lootTokenName, lootTokenSymbol);

        // Encode initialization params with actual token addresses
        bytes memory actualInitParams = abi.encode(
            loot,
            shares,
            avatar,
            multisendLibrary,
            governanceConfig,
            navigators,
            navigatorPermissions,
            initMembers,
            initShareAmounts,
            initLootAmounts,
            guildTokens,
            pauseSharesOnLaunch,
            pauseLootOnLaunch
        );

        // Initialize DAOShip
        DAOShip(daoShip).setUp(actualInitParams);

        emit LaunchDAOShip(daoShip, shares, loot, avatar, msg.sender);

        return (daoShip, shares, loot);
    }

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
    function calculateAddresses(address sender, uint256 sharesSalt, uint256 lootSalt, uint256 daoShipSalt)
        external
        view
        returns (address daoShip, address shares, address loot)
    {
        shares = Clones.predictDeterministicAddress(
            sharesSingleton,
            keccak256(abi.encodePacked(sender, sharesSalt)),
            address(this)
        );

        loot = Clones.predictDeterministicAddress(
            lootSingleton,
            keccak256(abi.encodePacked(sender, lootSalt)),
            address(this)
        );

        daoShip = Clones.predictDeterministicAddress(
            daoShipSingleton,
            keccak256(abi.encodePacked(sender, daoShipSalt)),
            address(this)
        );

        return (daoShip, shares, loot);
    }
}
