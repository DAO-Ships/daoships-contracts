// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title INavigator
 * @notice Standard interface that all DAO Ships navigator contracts must implement
 * @dev Provides deployer identity, type discovery, and trusted metadata for indexers.
 *      The NavigatorDeployed event MUST be emitted exactly once, in the constructor.
 *      This contract uses immutable variables and MUST NOT be deployed behind a proxy.
 *
 * Navigator metadata (name, description) is emitted in the constructor event, not stored.
 * Only the deployer (msg.sender in the constructor) can author the initial metadata.
 * Post-deployment metadata updates go through governance via Poster (VERIFIED trust).
 *
 * Recommended field lengths (not enforced on-chain — indexer truncates):
 *   name: up to 100 characters
 *   description: up to 500 characters
 */
interface INavigator {
    /**
     * @notice Emitted once at deployment with trusted metadata
     * @dev Because this is emitted in the constructor, only the deployer can author
     *      the name and description. No spoofing, squatting, or poisoning is possible.
     * @param daoShip The DAOShip DAO this navigator is bound to
     * @param deployer The address that deployed the navigator (msg.sender in constructor)
     * @param navigatorType Compile-time type identifier (e.g., "OnboarderNavigator")
     * @param name Human-readable name chosen by the deployer (optional, can be empty)
     * @param description Human-readable description (optional, can be empty)
     */
    event NavigatorDeployed(
        address indexed daoShip,
        address indexed deployer,
        string navigatorType,
        string name,
        string description
    );

    /// @notice The address that deployed this navigator
    function deployer() external view returns (address);

    /// @notice Compile-time navigator type identifier
    function navigatorType() external view returns (string memory);
}
