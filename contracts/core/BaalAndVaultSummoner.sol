// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "./BaalSummoner.sol";
import "../interfaces/IQuaiVaultFactory.sol";

/**
 * @title BaalAndVaultSummoner
 * @notice Factory for deploying Baal DAOs with integrated Quai Vault treasury
 * @dev Extends BaalSummoner to coordinate DAO + treasury deployment
 *      Can create new vault or connect to existing vault
 *
 * Architecture:
 * - Deploy Quai Vault via QuaiVaultFactory (or use existing)
 * - Deploy Baal + tokens via BaalSummoner
 * - Vault owners must separately enable Baal as module via enableModule()
 *
 * Note on Module Enablement:
 * - Baal needs to be enabled as a Zodiac module on the vault
 * - This requires vault owner signatures (cannot be done atomically)
 * - Vault owners should call vault.enableModule(baalAddress) after summoning
 * - Without enablement, Baal cannot execute treasury actions
 */
contract BaalAndVaultSummoner is BaalSummoner {
    // ═══════════════════════════════════════════════════════════════════════════════
    // IMMUTABLE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Quai Vault factory address
    address public immutable quaiVaultFactory;

    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when Baal and Vault are summoned together
     * @param baal Deployed Baal address
     * @param vault Deployed or existing Quai Vault address
     * @param shares Deployed SharesERC20 address
     * @param loot Deployed LootERC20 address
     * @param newVault Whether a new vault was created (true) or existing used (false)
     * @param summoner Address that summoned
     */
    event SummonBaalAndVault(
        address indexed baal,
        address indexed vault,
        address shares,
        address loot,
        bool newVault,
        address summoner
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deploy BaalAndVaultSummoner
     * @param _baalSingleton Baal singleton address
     * @param _sharesSingleton SharesERC20 singleton address
     * @param _lootSingleton LootERC20 singleton address
     * @param _quaiVaultFactory Quai Vault factory address
     */
    constructor(
        address _baalSingleton,
        address _sharesSingleton,
        address _lootSingleton,
        address _quaiVaultFactory
    ) BaalSummoner(_baalSingleton, _sharesSingleton, _lootSingleton) {
        require(_quaiVaultFactory != address(0), "BaalAndVaultSummoner: invalid factory");
        quaiVaultFactory = _quaiVaultFactory;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SUMMON FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Summon Baal with new Quai Vault
     * @dev Creates vault via QuaiVaultFactory, then summons Baal
     *      Vault owners must call vault.enableModule(baal) afterwards
     * @param initializationParams Encoded Baal initialization (with avatar = address(0))
     * @param initializationActions Optional Baal setup actions
     * @param vaultOwners Initial vault owners
     * @param vaultThreshold Signature threshold for vault
     * @param salt Create2 salt for deterministic addresses
     * @return baal Deployed Baal address
     * @return vault Deployed Quai Vault address
     */
    function summonBaalAndVault(
        bytes calldata initializationParams,
        bytes[] calldata initializationActions,
        address[] calldata vaultOwners,
        uint256 vaultThreshold,
        uint256 salt
    ) external returns (address payable baal, address vault) {
        // Validate vault parameters
        require(vaultOwners.length > 0, "BaalAndVaultSummoner: no owners");
        require(vaultThreshold > 0 && vaultThreshold <= vaultOwners.length, "BaalAndVaultSummoner: invalid threshold");

        // Deploy Quai Vault
        vault = IQuaiVaultFactory(quaiVaultFactory).createWallet(
            vaultOwners,
            vaultThreshold,
            bytes32(salt)
        );

        // Replace avatar (3rd param) in initializationParams with vault address
        bytes memory actualInitParams = _replaceAvatar(initializationParams, vault);

        // Summon Baal (inherited function from BaalSummoner)
        baal = this.summonBaal(actualInitParams, initializationActions, salt);

        emit SummonBaalAndVault(baal, vault, address(0), address(0), true, msg.sender);

        return (baal, vault);
    }

    /**
     * @notice Summon Baal with existing Quai Vault
     * @dev Connects Baal to existing vault
     *      Vault owners must call vault.enableModule(baal) afterwards
     * @param initializationParams Encoded Baal initialization (with actual avatar address)
     * @param initializationActions Optional Baal setup actions
     * @param existingVault Existing Quai Vault address
     * @param salt Create2 salt
     * @return baal Deployed Baal address
     */
    function summonBaalWithVault(
        bytes calldata initializationParams,
        bytes[] calldata initializationActions,
        address existingVault,
        uint256 salt
    ) external returns (address payable baal) {
        require(existingVault != address(0), "BaalAndVaultSummoner: invalid vault");

        // Replace avatar in params if needed
        bytes memory actualInitParams = _replaceAvatar(initializationParams, existingVault);

        // Summon Baal (inherited function from BaalSummoner)
        baal = this.summonBaal(actualInitParams, initializationActions, salt);

        emit SummonBaalAndVault(baal, existingVault, address(0), address(0), false, msg.sender);

        return baal;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Replace avatar address in initialization params
     * @dev Decodes params, replaces avatar (3rd param), re-encodes
     * @param initializationParams Original params
     * @param newAvatar New avatar address
     * @return Modified params with new avatar
     */
    function _replaceAvatar(bytes calldata initializationParams, address newAvatar)
        internal
        pure
        returns (bytes memory)
    {
        // Decode params
        (
            address lootToken,
            address sharesToken,
            address oldAvatar, // Replaced with newAvatar
            address forwarder,
            address multisendLibrary,
            bytes memory governanceConfig,
            address[] memory shamans,
            uint256[] memory shamanPermissions,
            address[] memory initMembers,
            uint256[] memory initShareAmounts,
            uint256[] memory initLootAmounts
        ) = abi.decode(
            initializationParams,
            (address, address, address, address, address, bytes, address[], uint256[], address[], uint256[], uint256[])
        );

        // Silence unused variable warning
        oldAvatar;

        // Re-encode with new avatar
        return abi.encode(
            lootToken,
            sharesToken,
            newAvatar, // replaced
            forwarder,
            multisendLibrary,
            governanceConfig,
            shamans,
            shamanPermissions,
            initMembers,
            initShareAmounts,
            initLootAmounts
        );
    }
}
