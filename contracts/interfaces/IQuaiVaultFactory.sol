// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

/**
 * @title IQuaiVaultFactory
 * @notice Interface for Quai Vault factory contract
 * @dev Used by BaalAndVaultSummoner to create Quai Vaults
 *
 * Reference: https://github.com/Quai-Vault/quaivault-contracts
 * Deployed at: 0x005261a837f1eFEa0e23b66dc526EB6054FD2250 (Cyprus1)
 */
interface IQuaiVaultFactory {
    /**
     * @notice Create a new Quai Vault
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
     * @notice Predict vault address for given parameters
     * @param owners Initial owners
     * @param threshold Signature threshold
     * @param salt Create2 salt
     * @return Predicted vault address
     */
    function predictWalletAddress(
        address[] calldata owners,
        uint256 threshold,
        bytes32 salt
    ) external view returns (address);
}
