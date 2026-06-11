// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../interfaces/IAvatar.sol";
import "../libraries/Enum.sol";

/**
 * @title MockAvatar
 * @notice Simple mock implementation of IAvatar for testing
 * @dev Always returns true for execTransactionFromModule
 */
contract MockAvatar is IAvatar {
    /// @notice Mapping to track enabled modules
    mapping(address => bool) public modules;

    /// @notice Owner of the mock avatar
    address public owner;

    /// @notice Sentinel address for linked list
    address internal constant SENTINEL_MODULES = address(0x1);

    constructor() {
        owner = msg.sender;
    }

    /// @notice Enable a module
    /// @dev Authorized either by the owner (test convenience) or by the avatar itself
    ///      (msg.sender == address(this)) — the latter mirrors the real Quai Vault /
    ///      Gnosis Safe, where an enabled module enables another via a self-call routed
    ///      through MultiSend (e.g. a DAOShip governance proposal enabling a navigator
    ///      as a treasury module).
    function enableModule(address module) external override {
        require(msg.sender == owner || msg.sender == address(this), "MockAvatar: not authorized");
        modules[module] = true;
    }

    /// @notice Disable a module
    function disableModule(address, address module) external override {
        require(msg.sender == owner || msg.sender == address(this), "MockAvatar: not authorized");
        modules[module] = false;
    }

    /// @notice Get modules paginated (mock implementation)
    function getModulesPaginated(address, uint256)
        external
        pure
        override
        returns (address[] memory array, address next)
    {
        // Mock implementation - just return empty array
        return (new address[](0), SENTINEL_MODULES);
    }

    /// @notice Execute transaction from module
    /// @dev Actually executes the transaction for realistic testing
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external override returns (bool success) {
        require(modules[msg.sender], "MockAvatar: not enabled module");

        // Execute the transaction
        if (operation == Enum.Operation.Call) {
            // Standard call
            (success, ) = to.call{value: value}(data);
        } else if (operation == Enum.Operation.DelegateCall) {
            // Delegate call
            (success, ) = to.delegatecall(data);
        } else {
            // Create operation not supported in mock
            revert("MockAvatar: create not supported");
        }

        return success;
    }

    /// @notice Execute transaction from module and return data
    /// @dev Actually executes the transaction and returns data
    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external override returns (bool success, bytes memory returnData) {
        require(modules[msg.sender], "MockAvatar: not enabled module");

        // Execute the transaction
        if (operation == Enum.Operation.Call) {
            // Standard call
            (success, returnData) = to.call{value: value}(data);
        } else if (operation == Enum.Operation.DelegateCall) {
            // Delegate call
            (success, returnData) = to.delegatecall(data);
        } else {
            // Create operation not supported in mock
            revert("MockAvatar: create not supported");
        }

        return (success, returnData);
    }

    /// @notice Check if module is enabled
    function isModuleEnabled(address module) external view override returns (bool) {
        return modules[module];
    }

    /// @notice Receive ETH
    receive() external payable {}
}
