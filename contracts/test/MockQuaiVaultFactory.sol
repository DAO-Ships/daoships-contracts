// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../interfaces/IQuaiVaultFactory.sol";
import "./MockDelegatecallGuardAvatar.sol";

/**
 * @title MockQuaiVaultFactory
 * @notice Mock factory that records createWallet call parameters for testing
 * @dev Used to verify DAOShipAndVaultLauncher passes correct params (initialModules, initialDelegatecallTargets)
 */
contract MockQuaiVaultFactory {
    // Recorded call parameters
    uint32 public lastMinExecutionDelay;
    address[] public lastInitialModules;
    address[] public lastInitialDelegatecallTargets;
    bool public sixParamCalled;
    address public lastWallet;

    function createWallet(
        address[] calldata,
        uint256,
        bytes32 salt
    ) external returns (address wallet) {
        // 3-param overload — no modules, no delegatecall targets
        lastMinExecutionDelay = 0;
        delete lastInitialModules;
        delete lastInitialDelegatecallTargets;
        sixParamCalled = false;
        wallet = _deployMock(salt, new address[](0), new address[](0));
        lastWallet = wallet;
    }

    function createWallet(
        address[] calldata,
        uint256,
        bytes32 salt,
        uint32 minExecutionDelay
    ) external returns (address wallet) {
        lastMinExecutionDelay = minExecutionDelay;
        delete lastInitialModules;
        delete lastInitialDelegatecallTargets;
        sixParamCalled = false;
        wallet = _deployMock(salt, new address[](0), new address[](0));
        lastWallet = wallet;
    }

    function createWallet(
        address[] calldata,
        uint256,
        bytes32 salt,
        uint32 minExecutionDelay,
        address[] calldata initialModules
    ) external returns (address wallet) {
        lastMinExecutionDelay = minExecutionDelay;
        _copyToStorage(initialModules, lastInitialModules);
        delete lastInitialDelegatecallTargets;
        sixParamCalled = false;

        // Convert calldata to memory for constructor
        address[] memory mods = new address[](initialModules.length);
        for (uint256 i = 0; i < initialModules.length; i++) {
            mods[i] = initialModules[i];
        }
        wallet = _deployMock(salt, mods, new address[](0));
        lastWallet = wallet;
    }

    function createWallet(
        address[] calldata,
        uint256,
        bytes32 salt,
        uint32 minExecutionDelay,
        address[] calldata initialModules,
        address[] calldata initialDelegatecallTargets
    ) external returns (address wallet) {
        lastMinExecutionDelay = minExecutionDelay;
        _copyToStorage(initialModules, lastInitialModules);
        _copyToStorage(initialDelegatecallTargets, lastInitialDelegatecallTargets);
        sixParamCalled = true;

        // Convert calldata to memory for constructor
        address[] memory mods = new address[](initialModules.length);
        for (uint256 i = 0; i < initialModules.length; i++) {
            mods[i] = initialModules[i];
        }
        address[] memory targets = new address[](initialDelegatecallTargets.length);
        for (uint256 i = 0; i < initialDelegatecallTargets.length; i++) {
            targets[i] = initialDelegatecallTargets[i];
        }
        wallet = _deployMock(salt, mods, targets);
        lastWallet = wallet;
    }

    function _deployMock(
        bytes32 salt,
        address[] memory initialModules,
        address[] memory initialDelegatecallTargets
    ) internal returns (address) {
        MockDelegatecallGuardAvatar mock = new MockDelegatecallGuardAvatar{salt: salt}(
            initialModules,
            initialDelegatecallTargets
        );
        return address(mock);
    }

    /// @dev Copy calldata array into a storage array (replaces existing contents)
    function _copyToStorage(address[] calldata src, address[] storage dst) internal {
        // Clear existing
        while (dst.length > 0) {
            dst.pop();
        }
        for (uint256 i = 0; i < src.length; i++) {
            dst.push(src[i]);
        }
    }

    // Stubs for other interface functions
    function predictWalletAddress(
        address,
        bytes32,
        address[] calldata,
        uint256,
        uint32,
        address[] calldata,
        address[] calldata
    ) external pure returns (address) {
        return address(0);
    }

    function getWalletCount() external pure returns (uint256) { return 0; }
    function isWallet(address) external pure returns (bool) { return false; }
}
