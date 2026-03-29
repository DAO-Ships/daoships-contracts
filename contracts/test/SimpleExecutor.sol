// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title SimpleExecutor
 * @notice Simple executor for single-call proposals in tests
 * @dev Decodes [address, uint256, bytes] and executes the call
 */
contract SimpleExecutor {
    /**
     * @notice Execute a single call
     * @param data ABI-encoded [address target, uint256 value, bytes callData]
     */
    function execute(bytes memory data) external payable returns (bool success) {
        (address target, uint256 value, bytes memory callData) = abi.decode(
            data,
            (address, uint256, bytes)
        );

        (success, ) = target.call{value: value}(callData);
        require(success, "SimpleExecutor: call failed");
    }

    /// @notice Fallback to handle delegatecall from Avatar
    fallback() external payable {
        // When called via delegatecall, msg.data contains the encoded transaction
        (address target, uint256 value, bytes memory callData) = abi.decode(
            msg.data,
            (address, uint256, bytes)
        );

        (bool success, ) = target.call{value: value}(callData);
        require(success, "SimpleExecutor: call failed");
    }

    receive() external payable {}
}
