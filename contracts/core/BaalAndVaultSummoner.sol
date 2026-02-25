// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "../interfaces/IBaalSummoner.sol";
import "../interfaces/IQuaiVaultFactory.sol";

/**
 * @title BaalAndVaultSummoner
 * @notice Factory for deploying Baal DAOs with integrated Quai Vault treasury
 * @dev Uses composition pattern (not inheritance) to avoid external self-call issues
 *      Holds reference to BaalSummoner and calls it as a separate contract
 *      Based on DAOHaus's BaalAndVaultSummoner design
 *
 * Architecture:
 * - BaalAndVaultSummoner holds reference to BaalSummoner (composition)
 * - Calls baalSummoner.summonBaal() as regular external call (not self-call)
 * - Creates Quai Vault via QuaiVaultFactory
 * - Vault owners must separately enable Baal as module via enableModule()
 *
 * Key Difference from Previous Implementation:
 * - OLD: BaalAndVaultSummoner extends BaalSummoner → this.summonBaal() (external self-call) ❌
 * - NEW: BaalAndVaultSummoner → baalSummoner.summonBaal() (call to separate contract) ✅
 */
contract BaalAndVaultSummoner {
    // ═══════════════════════════════════════════════════════════════════════════════
    // IMMUTABLE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice BaalSummoner reference (separate contract)
    IBaalSummoner public immutable baalSummoner;

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
     * @param _baalSummoner BaalSummoner contract address (separate contract)
     * @param _quaiVaultFactory Quai Vault factory address
     */
    constructor(address _baalSummoner, address _quaiVaultFactory) {
        require(_baalSummoner != address(0), "BaalAndVaultSummoner: invalid summoner");
        require(_quaiVaultFactory != address(0), "BaalAndVaultSummoner: invalid factory");

        baalSummoner = IBaalSummoner(_baalSummoner);
        quaiVaultFactory = _quaiVaultFactory;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SUMMON FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Summon Baal with new Quai Vault
     * @dev Creates vault via QuaiVaultFactory, then summons Baal via separate BaalSummoner
     *      Vault owners must call vault.enableModule(baal) afterwards
     *      Uses composition pattern - no external self-call issues
     * @param initializationParams Encoded Baal initialization (with avatar = address(0))
     * @param initializationActions Optional Baal setup actions
     * @param shareTokenName Name for the shares token
     * @param shareTokenSymbol Symbol for the shares token
     * @param lootTokenName Name for the loot token
     * @param lootTokenSymbol Symbol for the loot token
     * @param vaultOwners Initial vault owners
     * @param vaultThreshold Signature threshold for vault
     * @param vaultSalt Create2 salt for Quai Vault
     * @param sharesSalt Create2 salt for SharesERC20 clone
     * @param lootSalt Create2 salt for LootERC20 clone
     * @param baalSalt Create2 salt for Baal clone
     * @return baal Deployed Baal address
     * @return vault Deployed Quai Vault address
     */
    function summonBaalAndVault(
        bytes calldata initializationParams,
        bytes[] calldata initializationActions,
        string calldata shareTokenName,
        string calldata shareTokenSymbol,
        string calldata lootTokenName,
        string calldata lootTokenSymbol,
        address[] calldata vaultOwners,
        uint256 vaultThreshold,
        uint256 vaultSalt,
        uint256 sharesSalt,
        uint256 lootSalt,
        uint256 baalSalt
    ) external returns (address payable baal, address vault) {
        // Validate vault parameters
        require(vaultOwners.length > 0, "BaalAndVaultSummoner: no owners");
        require(
            vaultThreshold > 0 && vaultThreshold <= vaultOwners.length,
            "BaalAndVaultSummoner: invalid threshold"
        );

        // Deploy Quai Vault
        vault = IQuaiVaultFactory(quaiVaultFactory).createWallet(vaultOwners, vaultThreshold, bytes32(vaultSalt));

        // Replace avatar (3rd param) in initializationParams with vault address
        bytes memory actualInitParams = _replaceAvatar(initializationParams, vault);

        // Summon Baal via separate BaalSummoner contract
        // KEY CHANGE: This is a regular external call to a DIFFERENT contract
        // NOT an external self-call (this.summonBaal())
        baal = baalSummoner.summonBaal(actualInitParams, initializationActions, shareTokenName, shareTokenSymbol, lootTokenName, lootTokenSymbol, sharesSalt, lootSalt, baalSalt);

        // Get deployed token addresses from Baal
        (address shares, address loot) = _getTokenAddresses(baal);

        emit SummonBaalAndVault(baal, vault, shares, loot, true, msg.sender);

        return (baal, vault);
    }

    /**
     * @notice Summon Baal with existing Quai Vault
     * @dev Connects Baal to existing vault
     *      Vault owners must call vault.enableModule(baal) afterwards
     * @param initializationParams Encoded Baal initialization (with actual avatar address)
     * @param initializationActions Optional Baal setup actions
     * @param shareTokenName Name for the shares token
     * @param shareTokenSymbol Symbol for the shares token
     * @param lootTokenName Name for the loot token
     * @param lootTokenSymbol Symbol for the loot token
     * @param existingVault Existing Quai Vault address
     * @param sharesSalt Create2 salt for SharesERC20 clone
     * @param lootSalt Create2 salt for LootERC20 clone
     * @param baalSalt Create2 salt for Baal clone
     * @return baal Deployed Baal address
     */
    function summonBaalWithVault(
        bytes calldata initializationParams,
        bytes[] calldata initializationActions,
        string calldata shareTokenName,
        string calldata shareTokenSymbol,
        string calldata lootTokenName,
        string calldata lootTokenSymbol,
        address existingVault,
        uint256 sharesSalt,
        uint256 lootSalt,
        uint256 baalSalt
    ) external returns (address payable baal) {
        require(existingVault != address(0), "BaalAndVaultSummoner: invalid vault");

        // Replace avatar in params if needed
        bytes memory actualInitParams = _replaceAvatar(initializationParams, existingVault);

        // Summon Baal via separate BaalSummoner contract
        // Regular external call to different contract (not self-call)
        baal = baalSummoner.summonBaal(actualInitParams, initializationActions, shareTokenName, shareTokenSymbol, lootTokenName, lootTokenSymbol, sharesSalt, lootSalt, baalSalt);

        // Get deployed token addresses from Baal
        (address shares, address loot) = _getTokenAddresses(baal);

        emit SummonBaalAndVault(baal, existingVault, shares, loot, false, msg.sender);

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
        // Decode params (skip oldAvatar as it's being replaced)
        (
            address lootToken,
            address sharesToken,
            , // oldAvatar - skip unused parameter
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

        // Re-encode with new avatar
        return
            abi.encode(
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
                initLootAmounts,
                guildTokens
            );
    }

    /**
     * @notice Get token addresses from deployed Baal
     * @param baal Baal contract address
     * @return shares SharesERC20 address
     * @return loot LootERC20 address
     */
    function _getTokenAddresses(address baal) internal view returns (address shares, address loot) {
        // Call Baal to get token addresses
        // Using low-level call to avoid importing full Baal interface
        (bool success1, bytes memory data1) = baal.staticcall(abi.encodeWithSignature("sharesToken()"));
        require(success1, "BaalAndVaultSummoner: failed to get shares");
        shares = abi.decode(data1, (address));

        (bool success2, bytes memory data2) = baal.staticcall(abi.encodeWithSignature("lootToken()"));
        require(success2, "BaalAndVaultSummoner: failed to get loot");
        loot = abi.decode(data2, (address));
    }
}
