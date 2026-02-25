// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "./Baal.sol";
import "../tokens/SharesERC20.sol";
import "../tokens/LootERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title BaalSummoner
 * @notice Factory for deploying Baal DAOs using EIP-1167 minimal proxies
 * @dev Deploys clones of singleton implementations for gas efficiency
 *      Each DAO gets its own Baal, SharesERC20, and LootERC20 instances
 *
 * Gas Savings:
 * - Singleton deployment: ~4M gas (one-time cost)
 * - Clone deployment: ~300K gas per DAO (90% savings)
 *
 * Architecture:
 * - BaalSummoner manages singleton addresses
 * - summonBaal() creates minimal proxies via Clones.clone()
 * - Initializes via setUp() with encoded parameters
 * - Transfers ownership of tokens to Baal contract
 */
contract BaalSummoner {
    // ═══════════════════════════════════════════════════════════════════════════════
    // IMMUTABLE SINGLETONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Baal singleton implementation
    address public immutable baalSingleton;

    /// @notice SharesERC20 singleton implementation
    address public immutable sharesSingleton;

    /// @notice LootERC20 singleton implementation
    address public immutable lootSingleton;

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
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deploy BaalSummoner with singleton implementations
     * @param _baalSingleton Baal singleton address
     * @param _sharesSingleton SharesERC20 singleton address
     * @param _lootSingleton LootERC20 singleton address
     */
    constructor(
        address _baalSingleton,
        address _sharesSingleton,
        address _lootSingleton
    ) {
        require(_baalSingleton != address(0), "BaalSummoner: invalid baal");
        require(_sharesSingleton != address(0), "BaalSummoner: invalid shares");
        require(_lootSingleton != address(0), "BaalSummoner: invalid loot");

        baalSingleton = _baalSingleton;
        sharesSingleton = _sharesSingleton;
        lootSingleton = _lootSingleton;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SUMMON FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Summon a new Baal DAO
     * @dev Deploys clones and initializes with provided parameters
     * @param initializationParams Encoded initialization data (see Baal.setUp)
     * @param initializationActions Optional setup actions to execute (e.g., setGuildTokens)
     * @param shareTokenName Name for the shares token (e.g., "My DAO Shares")
     * @param shareTokenSymbol Symbol for the shares token (e.g., "MDAO")
     * @param lootTokenName Name for the loot token (e.g., "My DAO Loot")
     * @param lootTokenSymbol Symbol for the loot token (e.g., "MDAO-LOOT")
     * @param sharesSalt Create2 salt for SharesERC20 clone
     * @param lootSalt Create2 salt for LootERC20 clone
     * @param baalSalt Create2 salt for Baal clone
     * @return baal Deployed Baal address
     */
    function summonBaal(
        bytes calldata initializationParams,
        bytes[] calldata initializationActions,
        string calldata shareTokenName,
        string calldata shareTokenSymbol,
        string calldata lootTokenName,
        string calldata lootTokenSymbol,
        uint256 sharesSalt,
        uint256 lootSalt,
        uint256 baalSalt
    ) external returns (address payable baal) {
        // Decode initialization params to get avatar and validate
        // Note: lootToken and sharesToken are ignored (passed as address(0) by caller)
        (
            ,
            ,
            address avatar,
            address forwarder,
            address multisendLibrary,
            bytes memory governanceConfig,
            address[] memory shamans,
            uint256[] memory shamanPermissions,
            address[] memory initMembers,
            uint256[] memory initShareAmounts,
            uint256[] memory initLootAmounts,
            address[] memory guildTokens
        ) = abi.decode(
            initializationParams,
            (address, address, address, address, address, bytes, address[], uint256[], address[], uint256[], uint256[], address[])
        );

        // Validate avatar
        require(avatar != address(0), "BaalSummoner: invalid avatar");

        // Deploy token clones with msg.sender-specific salt to prevent front-running
        address shares = Clones.cloneDeterministic(sharesSingleton, keccak256(abi.encodePacked(msg.sender, sharesSalt)));
        address loot = Clones.cloneDeterministic(lootSingleton, keccak256(abi.encodePacked(msg.sender, lootSalt)));

        // Deploy Baal clone
        baal = payable(Clones.cloneDeterministic(baalSingleton, keccak256(abi.encodePacked(msg.sender, baalSalt))));

        // Initialize token clones with Baal as owner and custom metadata
        SharesERC20(shares).initialize(baal, shareTokenName, shareTokenSymbol);
        LootERC20(loot).initialize(baal, lootTokenName, lootTokenSymbol);

        // Encode initialization params with actual token addresses
        bytes memory actualInitParams = abi.encode(
            loot,
            shares,
            avatar,
            forwarder,
            multisendLibrary,
            governanceConfig,
            shamans,
            shamanPermissions,
            initMembers,
            initShareAmounts,
            initLootAmounts,
            guildTokens
        );

        // Initialize Baal
        Baal(baal).setUp(actualInitParams);

        // Execute initialization actions (e.g., setGuildTokens)
        if (initializationActions.length > 0) {
            for (uint256 i = 0; i < initializationActions.length; i++) {
                (bool success, ) = baal.call(initializationActions[i]);
                require(success, "BaalSummoner: initialization action failed");
            }
        }

        emit SummonBaal(baal, shares, loot, avatar, forwarder, msg.sender);

        return baal;
    }

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
    function calculateAddresses(address sender, uint256 sharesSalt, uint256 lootSalt, uint256 baalSalt)
        external
        view
        returns (address baal, address shares, address loot)
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

        baal = Clones.predictDeterministicAddress(
            baalSingleton,
            keccak256(abi.encodePacked(sender, baalSalt)),
            address(this)
        );

        return (baal, shares, loot);
    }
}
