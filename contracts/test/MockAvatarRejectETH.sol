// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../interfaces/IAvatar.sol";
import "../libraries/Enum.sol";

/**
 * @title MockAvatarRejectETH
 * @notice IAvatar implementation that cannot receive ETH (no receive/fallback)
 * @dev Used to test OfferingTransferFailed revert path
 */
contract MockAvatarRejectETH is IAvatar {
    mapping(address => bool) public modules;

    function enableModule(address module) external override {
        modules[module] = true;
    }

    function disableModule(address, address module) external override {
        modules[module] = false;
    }

    function isModuleEnabled(address module) external view override returns (bool) {
        return modules[module];
    }

    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external override returns (bool success) {
        require(modules[msg.sender], "not module");
        if (operation == Enum.Operation.Call) {
            (success, ) = to.call{value: value}(data);
        } else {
            (success, ) = to.delegatecall(data);
        }
    }

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external override returns (bool success, bytes memory returnData) {
        require(modules[msg.sender], "not module");
        if (operation == Enum.Operation.Call) {
            (success, returnData) = to.call{value: value}(data);
        } else {
            (success, returnData) = to.delegatecall(data);
        }
    }

    function getModulesPaginated(address, uint256)
        external
        pure
        override
        returns (address[] memory, address)
    {
        return (new address[](0), address(0x1));
    }

    // Intentionally NO receive() or fallback() — ETH transfers to this contract revert
}
