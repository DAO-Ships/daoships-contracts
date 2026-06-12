// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockFeeOnTransferERC20
 * @notice ERC20 that burns a fixed basis-point fee on every transfer/transferFrom,
 *         so the recipient receives less than `amount`.
 * @dev Used to test that fee-collecting navigators reject deflationary tokens via
 *      their balance-before/after check. `feeBps` is taken out of the transferred
 *      amount and burned; the recipient nets `amount * (10000 - feeBps) / 10000`.
 */
contract MockFeeOnTransferERC20 is ERC20 {
    uint256 public immutable feeBps;

    constructor(string memory name, string memory symbol, uint256 _feeBps) ERC20(name, symbol) {
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / 10_000;
            if (fee > 0) {
                super._update(from, address(0), fee); // burn the fee
                value -= fee;
            }
        }
        super._update(from, to, value);
    }
}
