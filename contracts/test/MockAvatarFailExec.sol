// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../interfaces/IAvatar.sol";
import "../libraries/Enum.sol";

/**
 * @title MockAvatarFailExec
 * @notice IAvatar that always returns false from execTransactionFromModule
 * @dev Used to test ETHTransferFailed and TokenTransferFailed revert paths in ragequit.
 *      Can hold ETH and ERC20s (for balanceOf to succeed) but all exec calls fail.
 */
contract MockAvatarFailExec is IAvatar {
    mapping(address => bool) public modules;

    /// @notice When true, execTransactionFromModule always returns false
    bool public failExec;

    function enableModule(address module) external override {
        modules[module] = true;
    }

    function disableModule(address, address module) external override {
        modules[module] = false;
    }

    function isModuleEnabled(address module) external view override returns (bool) {
        return modules[module];
    }

    /// @notice Toggle exec failure mode
    function setFailExec(bool _fail) external {
        failExec = _fail;
    }

    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external override returns (bool success) {
        require(modules[msg.sender], "not module");
        if (failExec) return false;
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
        if (failExec) return (false, "");
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

    receive() external payable {}
}
