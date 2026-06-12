// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IOnboarderTarget {
    function onboard() external payable;
}

/**
 * @title MockReentrantOnboardAttacker
 * @notice Overpays OnboarderNavigator.onboard() (fixed-price mode) so a refund is sent
 *         back to this contract, then — inside receive(), while the navigator still holds
 *         its reentrancy lock — attempts to re-enter the navigator's nonReentrant
 *         receive(). Used to PROVE the guard blocks the reentry: if the guard were
 *         absent the re-entrant call would succeed and `attack()` would NOT revert.
 */
contract MockReentrantOnboardAttacker {
    address public immutable target;
    bool private armed;

    constructor(address _target) {
        target = _target;
    }

    /// @notice Overpay onboard so the navigator refunds the remainder to this contract.
    function attack() external payable {
        armed = true;
        IOnboarderTarget(target).onboard{value: msg.value}();
    }

    receive() external payable {
        if (armed) {
            armed = false;
            // Re-enter the navigator's receive() (empty calldata) while its onboard()
            // still holds the lock. nonReentrant must revert this; bubble the failure so
            // the navigator's refund transfer fails (→ RefundFailed on the outer onboard).
            (bool ok, ) = target.call{value: 0}("");
            require(ok, "reentry blocked by guard");
        }
    }
}
