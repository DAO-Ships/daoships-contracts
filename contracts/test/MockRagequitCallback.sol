// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockRagequitCallback
 * @dev Test contract that inflates the avatar's ERC20 balance when it receives ETH.
 *      Used to verify that ragequit snapshots guild token balances BEFORE transfers,
 *      preventing reentrant balance inflation from affecting fair share calculation.
 */
contract MockRagequitCallback {
    address public token;
    address public avatarTarget;
    uint256 public depositAmount;

    constructor(address _token, address _avatarTarget, uint256 _depositAmount) {
        token = _token;
        avatarTarget = _avatarTarget;
        depositAmount = _depositAmount;
    }

    receive() external payable {
        // When receiving ETH from ragequit, deposit ERC20 tokens into the avatar.
        // This inflates the avatar's balance for tokens processed later in ragequit.
        if (depositAmount > 0 && IERC20(token).balanceOf(address(this)) >= depositAmount) {
            IERC20(token).transfer(avatarTarget, depositAmount);
        }
    }
}
