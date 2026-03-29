// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../interfaces/IAvatar.sol";
import "../libraries/Enum.sol";

/**
 * @title MockDelegatecallGuardAvatar
 * @notice Mock IAvatar that simulates Quai Vault's per-target DelegateCall whitelist
 * @dev Used to test that DAOShip handles DelegateCall target restrictions correctly.
 *      Replaces the old boolean delegatecallDisabled pattern with a per-address whitelist.
 *
 *      The whitelist pattern allows vaults to permit DelegateCall only to known-safe targets
 *      (e.g., MultiSendCallOnly) while blocking DelegateCall to arbitrary addresses. This
 *      closes the attack vector where a whitelisted MultiSend could be used to DelegateCall
 *      arbitrary targets within a batch.
 */
contract MockDelegatecallGuardAvatar is IAvatar {
    mapping(address => bool) public modules;
    mapping(address => bool) public delegatecallAllowed;
    address public owner;

    /// @notice Reverts when DelegateCall is attempted to a non-whitelisted target
    /// @param target The address that was not whitelisted for DelegateCall
    error DelegateCallNotAllowed(address target);

    /**
     * @notice Deploy mock avatar with initial modules and DelegateCall whitelist
     * @param _initialModules Addresses to enable as Zodiac modules at creation
     * @param _initialDelegatecallTargets Addresses whitelisted for DelegateCall operations
     */
    constructor(
        address[] memory _initialModules,
        address[] memory _initialDelegatecallTargets
    ) {
        owner = msg.sender;

        for (uint256 i = 0; i < _initialModules.length; i++) {
            modules[_initialModules[i]] = true;
        }

        for (uint256 i = 0; i < _initialDelegatecallTargets.length; i++) {
            delegatecallAllowed[_initialDelegatecallTargets[i]] = true;
        }
    }

    /**
     * @notice Add an address to the DelegateCall whitelist
     * @param target Address to whitelist
     */
    function addDelegatecallTarget(address target) external {
        require(msg.sender == owner, "not owner");
        delegatecallAllowed[target] = true;
    }

    /**
     * @notice Remove an address from the DelegateCall whitelist
     * @param target Address to remove from whitelist
     */
    function removeDelegatecallTarget(address target) external {
        require(msg.sender == owner, "not owner");
        delegatecallAllowed[target] = false;
    }

    function enableModule(address module) external override {
        require(msg.sender == owner, "not owner");
        modules[module] = true;
    }

    function disableModule(address, address module) external override {
        require(msg.sender == owner, "not owner");
        modules[module] = false;
    }

    function getModulesPaginated(address, uint256)
        external
        pure
        override
        returns (address[] memory array, address next)
    {
        return (new address[](0), address(0x1));
    }

    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external override returns (bool success) {
        require(modules[msg.sender], "not enabled module");

        if (operation == Enum.Operation.DelegateCall && !delegatecallAllowed[to]) {
            revert DelegateCallNotAllowed(to);
        }

        if (operation == Enum.Operation.Call) {
            (success, ) = to.call{value: value}(data);
        } else if (operation == Enum.Operation.DelegateCall) {
            (success, ) = to.delegatecall(data);
        }

        return success;
    }

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external override returns (bool success, bytes memory returnData) {
        require(modules[msg.sender], "not enabled module");

        if (operation == Enum.Operation.DelegateCall && !delegatecallAllowed[to]) {
            revert DelegateCallNotAllowed(to);
        }

        if (operation == Enum.Operation.Call) {
            (success, returnData) = to.call{value: value}(data);
        } else if (operation == Enum.Operation.DelegateCall) {
            (success, returnData) = to.delegatecall(data);
        }

        return (success, returnData);
    }

    function isModuleEnabled(address module) external view override returns (bool) {
        return modules[module];
    }

    receive() external payable {}
}
