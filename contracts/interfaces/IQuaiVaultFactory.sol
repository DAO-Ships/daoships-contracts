// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IQuaiVaultFactory
 * @notice Interface for Quai Vault factory contract
 * @dev Used by DAOShipAndVaultLauncher to create Quai Vaults
 *
 * Reference: https://github.com/Quai-Vault/quaivault-contracts
 *
 * RECOMMENDED: Use the 6-param createWallet overload for DAO vaults. It enables
 * atomic module enablement and DelegateCall target whitelisting during vault creation,
 * removing the need for separate post-creation setup transactions.
 *
 * Overload summary:
 *   3-param: basic vault (no modules, no delegatecall targets)
 *   4-param: adds minExecutionDelay
 *   5-param: adds initialModules (atomic Zodiac module enablement at creation)
 *   6-param: adds initialDelegatecallTargets (recommended for DAO vaults)
 */
interface IQuaiVaultFactory {
    /**
     * @notice Create a new Quai Vault (no modules, no delegatecall targets, minExecutionDelay=0)
     * @dev WARNING: Creates vault with no DelegateCall targets whitelisted. Not suitable for DAO
     *      vaults that need DelegateCall for MultiSend batching (e.g., DAOShip) unless modules and
     *      delegatecall targets are configured separately after creation.
     * @param owners Initial owners of the vault
     * @param threshold Signature threshold for transactions
     * @param salt Create2 salt for deterministic address
     * @return wallet Deployed Quai Vault address
     */
    function createWallet(
        address[] calldata owners,
        uint256 threshold,
        bytes32 salt
    ) external returns (address wallet);

    /**
     * @notice Create a new Quai Vault with execution delay (no modules, no delegatecall targets)
     * @dev WARNING: Creates vault with no DelegateCall targets whitelisted. Not suitable for DAO vaults.
     * @param owners Initial owners of the vault
     * @param threshold Signature threshold for transactions
     * @param salt Create2 salt for deterministic address
     * @param minExecutionDelay Minimum delay in seconds before external txs can execute (max 30 days)
     * @return wallet Deployed Quai Vault address
     */
    function createWallet(
        address[] calldata owners,
        uint256 threshold,
        bytes32 salt,
        uint32 minExecutionDelay
    ) external returns (address wallet);

    /**
     * @notice Create a new Quai Vault with atomic module enablement
     * @dev Enables the specified modules during vault creation. No DelegateCall targets are
     *      whitelisted — use the 6-param overload if DelegateCall is needed.
     * @param owners Initial owners of the vault
     * @param threshold Signature threshold for transactions
     * @param salt Create2 salt for deterministic address
     * @param minExecutionDelay Minimum delay in seconds (0 = immediate, max 30 days)
     * @param initialModules Addresses to enable as Zodiac modules during vault creation
     *        (e.g., a predicted DAOShip address so the DAO can execute proposals through the vault)
     * @return wallet Deployed Quai Vault address
     */
    function createWallet(
        address[] calldata owners,
        uint256 threshold,
        bytes32 salt,
        uint32 minExecutionDelay,
        address[] calldata initialModules
    ) external returns (address wallet);

    /**
     * @notice Create a new Quai Vault with atomic module enablement and DelegateCall whitelisting
     * @dev RECOMMENDED FOR DAO VAULTS. Enables modules and whitelists DelegateCall targets
     *      atomically during vault creation. This eliminates the race condition where a vault
     *      exists but is not yet configured for DAO operation.
     *
     *      Typical DAO configuration:
     *        initialModules = [predictedDAOShipAddress]
     *        initialDelegatecallTargets = [multiSendCallOnlyAddress]
     *
     * @param owners Initial owners of the vault
     * @param threshold Signature threshold for transactions
     * @param salt Create2 salt for deterministic address
     * @param minExecutionDelay Minimum delay in seconds (0 = immediate, max 30 days)
     * @param initialModules Addresses to enable as Zodiac modules during vault creation
     *        (e.g., DAOShip DAO governance contract)
     * @param initialDelegatecallTargets Addresses whitelisted for DelegateCall operations
     *        (e.g., MultiSendCallOnly for batched proposal execution). Only these addresses
     *        can be called via DelegateCall through execTransactionFromModule.
     * @return wallet Deployed Quai Vault address
     */
    function createWallet(
        address[] calldata owners,
        uint256 threshold,
        bytes32 salt,
        uint32 minExecutionDelay,
        address[] calldata initialModules,
        address[] calldata initialDelegatecallTargets
    ) external returns (address wallet);

    /**
     * @notice Predict vault address for given parameters
     * @dev Uses CREATE2 to compute the deterministic address. All parameters that affect the
     *      vault's initialization must be included, as they are part of the CREATE2 init code hash.
     * @param deployer Address that will call createWallet (msg.sender)
     * @param salt Create2 salt
     * @param owners Initial owners
     * @param threshold Signature threshold
     * @param minExecutionDelay Minimum execution delay in seconds
     * @param initialModules Addresses to enable as Zodiac modules
     * @param initialDelegatecallTargets Addresses whitelisted for DelegateCall
     * @return Predicted vault address
     */
    function predictWalletAddress(
        address deployer,
        bytes32 salt,
        address[] calldata owners,
        uint256 threshold,
        uint32 minExecutionDelay,
        address[] calldata initialModules,
        address[] calldata initialDelegatecallTargets
    ) external view returns (address);

    /**
     * @notice Get total number of deployed wallets
     * @return Number of wallets created through this factory
     */
    function getWalletCount() external view returns (uint256);

    /**
     * @notice Check if an address is a registered wallet
     * @param wallet Address to check
     * @return True if the address is a registered wallet
     */
    function isWallet(address wallet) external view returns (bool);
}
