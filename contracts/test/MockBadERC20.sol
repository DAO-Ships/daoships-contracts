// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title MockBadERC20
 * @notice ERC20-like token that reverts on balanceOf
 * @dev Used to test BalanceQueryFailed revert path in ragequit.
 *      Has a valid address and can be registered as a guild token,
 *      but balanceOf always reverts.
 */
contract MockBadERC20 {
    function balanceOf(address) external pure returns (uint256) {
        revert("MockBadERC20: balanceOf reverts");
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}
