// SPDX-License-Identifier: GPL-3.0-or-later
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
    function enableModule(address module) external override {
        require(msg.sender == owner, "MockAvatar: not owner");
        modules[module] = true;
    }

    /// @notice Disable a module
    function disableModule(address, address module) external override {
        require(msg.sender == owner, "MockAvatar: not owner");
        modules[module] = false;
    }

    /// @notice Get modules paginated (mock implementation)
    function getModulesPaginated(address, uint256)
        external
        view
        override
        returns (address[] memory array, address next)
    {
        // Mock implementation - just return empty array
        return (new address[](0), SENTINEL_MODULES);
    }

    /// @notice Execute transaction from module
    /// @dev Always succeeds for testing purposes
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) external override returns (bool success) {
        require(modules[msg.sender], "MockAvatar: not enabled module");

        // For testing, just return true
        // In a real implementation, this would execute the transaction
        return true;
    }

    /// @notice Execute transaction from module and return data
    /// @dev Always succeeds for testing purposes
    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) external override returns (bool success, bytes memory returnData) {
        require(modules[msg.sender], "MockAvatar: not enabled module");

        // For testing, just return true and empty data
        return (true, "");
    }

    /// @notice Check if module is enabled
    function isModuleEnabled(address module) external view override returns (bool) {
        return modules[module];
    }

    /// @notice Receive ETH
    receive() external payable {}
}
