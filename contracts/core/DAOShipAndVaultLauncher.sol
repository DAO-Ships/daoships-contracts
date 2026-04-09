// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../interfaces/IDAOShipLauncher.sol";
import "../interfaces/IQuaiVaultFactory.sol";

/**
 * @title DAOShipAndVaultLauncher
 * @notice Factory for deploying DAOShip DAOs with integrated Quai Vault treasury
 * @dev Uses composition pattern (not inheritance) to avoid external self-call issues.
 *      Holds reference to DAOShipLauncher and calls it as a separate contract.
 *      Inspired by the MolochV3 BaalAndVaultSummoner pattern.
 *
 * Architecture:
 * - DAOShipAndVaultLauncher holds reference to DAOShipLauncher (composition)
 * - Calls daoShipLauncher.launchDAOShip() as regular external call (not self-call)
 * - Creates Quai Vault via QuaiVaultFactory with predict-then-create flow
 * - Vault is created with DAOShip pre-enabled as a module and MultiSendCallOnly
 *   whitelisted for DelegateCall — no separate post-creation setup needed
 *
 * Predict-then-create flow:
 * 1. Predict DAOShip address deterministically via daoShipLauncher.calculateAddresses()
 * 2. Create vault with predictedDAOShip as initialModule and multisendCallOnly as
 *    initialDelegatecallTarget (atomic setup via 6-param createWallet)
 * 3. Launch DAOShip with the vault address as avatar
 * 4. Verify predicted address matches actual DAOShip address (safety invariant)
 */
contract DAOShipAndVaultLauncher {
    // ═══════════════════════════════════════════════════════════════════════════════
    // IMMUTABLE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice DAOShipLauncher reference (separate contract)
    IDAOShipLauncher public immutable daoShipLauncher;

    /// @notice Quai Vault factory address
    address public immutable quaiVaultFactory;

    /// @notice MultiSendCallOnly singleton — whitelisted for DelegateCall in new vaults
    /// @dev Must be a MultiSendCallOnly (not MultiSend) to prevent nested DelegateCall bypass.
    ///      See MultiSendCallOnly contract for security rationale.
    address public immutable multisendCallOnly;

    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when DAOShip and Vault are launched together
     * @param daoShip Deployed DAOShip address
     * @param vault Deployed or existing Quai Vault address
     * @param shares Deployed SharesERC20 address
     * @param loot Deployed LootERC20 address
     * @param newVault Whether a new vault was created (true) or existing used (false)
     * @param launcher Address that launched
     */
    event LaunchDAOShipAndVault(
        address indexed daoShip,
        address indexed vault,
        address shares,
        address loot,
        bool newVault,
        address launcher
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deploy DAOShipAndVaultLauncher
     * @param _daoShipLauncher DAOShipLauncher contract address (separate contract)
     * @param _quaiVaultFactory Quai Vault factory address
     * @param _multisendCallOnly MultiSendCallOnly singleton address — whitelisted as
     *        DelegateCall target in every new vault created by this launcher
     */
    constructor(address _daoShipLauncher, address _quaiVaultFactory, address _multisendCallOnly) {
        require(_daoShipLauncher != address(0), "DAOShipAndVaultLauncher: invalid launcher");
        require(_quaiVaultFactory != address(0), "DAOShipAndVaultLauncher: invalid factory");
        require(_multisendCallOnly != address(0), "DAOShipAndVaultLauncher: invalid multisend");

        daoShipLauncher = IDAOShipLauncher(_daoShipLauncher);
        quaiVaultFactory = _quaiVaultFactory;
        multisendCallOnly = _multisendCallOnly;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // LAUNCH FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Launch DAOShip with new Quai Vault using predict-then-create flow
     * @dev Creates vault with DAOShip pre-enabled as module and MultiSendCallOnly whitelisted
     *      for DelegateCall. No separate post-creation setup transactions needed.
     *
     *      Flow:
     *      1. Predict DAOShip address from salts (deterministic via CREATE2)
     *      2. Create vault with predictedDAOShip as initialModule
     *      3. Launch DAOShip with vault as avatar
     *      4. Assert predicted == actual DAOShip address
     *
     * @param initializationParamsTemplate Encoded DAOShip initialization params where the avatar
     *        field (3rd param) is a placeholder — it will be replaced with the newly created
     *        vault address before being passed to DAOShipLauncher. All other fields are used as-is.
     * @param shareTokenName Name for the shares token
     * @param shareTokenSymbol Symbol for the shares token
     * @param lootTokenName Name for the loot token
     * @param lootTokenSymbol Symbol for the loot token
     * @param vaultOwners Initial vault owners
     * @param vaultThreshold Signature threshold for vault
     * @param vaultSalt Create2 salt for Quai Vault
     * @param sharesSalt Create2 salt for SharesERC20 clone
     * @param lootSalt Create2 salt for LootERC20 clone
     * @param daoShipSalt Create2 salt for DAOShip clone
     * @return daoShip Deployed DAOShip address
     * @return vault Deployed Quai Vault address
     */
    function launchDAOShipAndVault(
        bytes calldata initializationParamsTemplate,
        string calldata shareTokenName,
        string calldata shareTokenSymbol,
        string calldata lootTokenName,
        string calldata lootTokenSymbol,
        address[] calldata vaultOwners,
        uint256 vaultThreshold,
        uint256 vaultSalt,
        uint256 sharesSalt,
        uint256 lootSalt,
        uint256 daoShipSalt
    ) external returns (address payable daoShip, address vault) {
        // Validate vault parameters
        require(vaultOwners.length > 0, "DAOShipAndVaultLauncher: no owners");
        require(
            vaultThreshold > 0 && vaultThreshold <= vaultOwners.length,
            "DAOShipAndVaultLauncher: invalid threshold"
        );

        // Step 1: Predict DAOShip address deterministically BEFORE creating vault
        (address predictedDAOShip, , ) = daoShipLauncher.calculateAddresses(
            address(this), sharesSalt, lootSalt, daoShipSalt
        );

        // Step 2: Create vault with atomic module enablement and DelegateCall whitelisting
        address[] memory initialModules = new address[](1);
        initialModules[0] = predictedDAOShip;
        address[] memory initialDelegatecallTargets = new address[](1);
        initialDelegatecallTargets[0] = multisendCallOnly;

        vault = IQuaiVaultFactory(quaiVaultFactory).createWallet(
            vaultOwners, vaultThreshold, bytes32(vaultSalt),
            0, initialModules, initialDelegatecallTargets
        );

        // Step 3: Replace avatar placeholder and launch DAOShip
        bytes memory actualInitParams = _replaceAvatar(initializationParamsTemplate, vault);
        address shares;
        address loot;
        (daoShip, shares, loot) = daoShipLauncher.launchDAOShip(
            actualInitParams,
            shareTokenName, shareTokenSymbol,
            lootTokenName, lootTokenSymbol,
            sharesSalt, lootSalt, daoShipSalt
        );

        // Step 4: Safety check — predicted address must match actual
        require(address(daoShip) == predictedDAOShip, "DAOShipAndVaultLauncher: address mismatch");

        emit LaunchDAOShipAndVault(daoShip, vault, shares, loot, true, msg.sender);

        return (daoShip, vault);
    }

    /**
     * @notice Launch DAOShip with existing Quai Vault
     * @dev Connects DAOShip to existing vault.
     *      Vault owners must call vault.enableModule(daoShip) afterwards if the vault
     *      was not created with DAOShip as an initialModule.
     * @param initializationParamsTemplate Encoded DAOShip initialization params where the avatar
     *        field (3rd param) will be replaced with existingVault before calling DAOShipLauncher.
     * @param shareTokenName Name for the shares token
     * @param shareTokenSymbol Symbol for the shares token
     * @param lootTokenName Name for the loot token
     * @param lootTokenSymbol Symbol for the loot token
     * @param existingVault Existing Quai Vault address
     * @param sharesSalt Create2 salt for SharesERC20 clone
     * @param lootSalt Create2 salt for LootERC20 clone
     * @param daoShipSalt Create2 salt for DAOShip clone
     * @return daoShip Deployed DAOShip address
     */
    function launchDAOShipWithVault(
        bytes calldata initializationParamsTemplate,
        string calldata shareTokenName,
        string calldata shareTokenSymbol,
        string calldata lootTokenName,
        string calldata lootTokenSymbol,
        address existingVault,
        uint256 sharesSalt,
        uint256 lootSalt,
        uint256 daoShipSalt
    ) external returns (address payable daoShip) {
        require(existingVault != address(0), "DAOShipAndVaultLauncher: invalid vault");
        require(existingVault.code.length > 0, "DAOShipAndVaultLauncher: vault has no code");

        // Replace avatar placeholder with existing vault address
        bytes memory actualInitParams = _replaceAvatar(initializationParamsTemplate, existingVault);

        // Launch DAOShip via separate DAOShipLauncher contract
        address shares;
        address loot;
        (daoShip, shares, loot) = daoShipLauncher.launchDAOShip(
            actualInitParams,
            shareTokenName, shareTokenSymbol,
            lootTokenName, lootTokenSymbol,
            sharesSalt, lootSalt, daoShipSalt
        );

        emit LaunchDAOShipAndVault(daoShip, existingVault, shares, loot, false, msg.sender);

        return daoShip;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Predict all deterministic addresses before launching
     * @dev Enables off-chain salt mining (required on Quai Network where CREATE2
     *      addresses must match the shard prefix, e.g. 0x00... for cyprus1).
     *      Use calculateAllAddresses to verify that mined salts produce addresses on
     *      the correct shard before submitting the launch transaction.
     *
     *      IMPORTANT: `minExecutionDelay` must be 0 to match the actual launch.
     *      `launchDAOShipAndVault` hardcodes `minExecutionDelay = 0` when creating
     *      vaults. Passing any other value here produces a vault prediction that
     *      will NOT match the deployed address, wasting salt-mining compute.
     *      Execution delays for DAO vaults require vault-owner processing overhead
     *      and are not currently supported by the launcher.
     *
     *      Predicts the DAOShip address first, then uses it as an initialModule when
     *      predicting the vault address — mirroring the actual launch flow.
     *
     * @param sender Address that will call launchDAOShipAndVault
     * @param sharesSalt Create2 salt for SharesERC20 clone
     * @param lootSalt Create2 salt for LootERC20 clone
     * @param daoShipSalt Create2 salt for DAOShip clone
     * @param vaultSalt Create2 salt for Quai Vault
     * @param vaultOwners Vault owner addresses (needed for initialization encoding)
     * @param vaultThreshold Vault signature threshold
     * @param minExecutionDelay Vault min execution delay (0 for standard DAO)
     * @return daoShip Predicted DAOShip address
     * @return shares Predicted SharesERC20 address
     * @return loot Predicted LootERC20 address
     * @return vault Predicted Quai Vault address
     */
    function calculateAllAddresses(
        address sender,
        uint256 sharesSalt,
        uint256 lootSalt,
        uint256 daoShipSalt,
        uint256 vaultSalt,
        address[] calldata vaultOwners,
        uint256 vaultThreshold,
        uint32 minExecutionDelay
    ) external view returns (address daoShip, address shares, address loot, address vault) {
        // Predict DAOShip first (needed as initialModule for vault prediction)
        (daoShip, shares, loot) = daoShipLauncher.calculateAddresses(sender, sharesSalt, lootSalt, daoShipSalt);

        // Predict vault with initialModules=[predictedDAOShip] and initialDelegatecallTargets=[multisendCallOnly]
        address[] memory initialModules = new address[](1);
        initialModules[0] = daoShip;
        address[] memory initialDelegatecallTargets = new address[](1);
        initialDelegatecallTargets[0] = multisendCallOnly;

        vault = IQuaiVaultFactory(quaiVaultFactory).predictWalletAddress(
            address(this),
            bytes32(vaultSalt),
            vaultOwners,
            vaultThreshold,
            minExecutionDelay,
            initialModules,
            initialDelegatecallTargets
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Replace avatar address in initialization params template
     * @dev Decodes params, replaces avatar (3rd param), re-encodes.
     *      The avatar field in the template is treated as a placeholder (typically address(0)
     *      or any sentinel value) — it is unconditionally overwritten with newAvatar.
     * @param initializationParamsTemplate Template params with placeholder avatar
     * @param newAvatar Actual avatar address to inject
     * @return Modified params with newAvatar in the avatar field
     */
    function _replaceAvatar(bytes calldata initializationParamsTemplate, address newAvatar)
        internal
        pure
        returns (bytes memory)
    {
        // Decode params (skip oldAvatar as it's being replaced)
        (
            address lootToken,
            address sharesToken,
            , // oldAvatar - unconditionally replaced
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
                initializationParamsTemplate,
                (address, address, address, address, bytes, address[], uint256[], address[], uint256[], uint256[], address[], bool, bool)
            );

        // Re-encode with new avatar
        return
            abi.encode(
                lootToken,
                sharesToken,
                newAvatar, // replaced
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
    }
}
