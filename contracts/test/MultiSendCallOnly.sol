// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.22;

/**
 * @title MultiSendCallOnly - Batched transactions restricted to Call operations only
 * @notice Unlike MultiSend, this variant rejects any transaction with operation=1 (DelegateCall).
 *         This closes the nested DelegateCall bypass vector where a whitelisted MultiSend could be
 *         used to DelegateCall arbitrary targets within a batch.
 *         Recommended as the default DelegateCall whitelist target for DAO vaults.
 *
 * @dev Security rationale:
 *      DAOShip executes proposals via DelegateCall to a MultiSend contract. If that MultiSend
 *      itself allows nested DelegateCall (operation=1 within a batch), an attacker could craft
 *      a proposal that DelegateCalls into the vault's context through an arbitrary contract,
 *      bypassing the vault's per-target whitelist. MultiSendCallOnly prevents this by rejecting
 *      any sub-transaction with operation != 0.
 *
 *      Transaction encoding (per sub-tx, packed):
 *        - operation (uint8): must be 0 (Call) — reverts on 1 (DelegateCall)
 *        - to (address): target address (20 bytes)
 *        - value (uint256): ETH value (32 bytes)
 *        - dataLength (uint256): length of calldata (32 bytes)
 *        - data (bytes): calldata (variable length)
 */
contract MultiSendCallOnly {
    address private immutable multisendSingleton;

    constructor() {
        multisendSingleton = address(this);
    }

    /// @dev Prevents direct calls — must be called via delegatecall to prevent
    ///      unintended storage modifications in this contract's context
    modifier onlyDelegateCall() {
        require(
            address(this) != multisendSingleton,
            "MultiSend should only be called via delegatecall"
        );
        _;
    }

    /**
     * @notice Execute multiple Call transactions in sequence
     * @dev Reverts if any sub-transaction uses DelegateCall (operation != 0).
     *      Reverts if any sub-transaction fails, forwarding the revert data.
     * @param transactions Encoded transactions (packed bytes, see contract-level docs)
     */
    function multiSend(bytes memory transactions) public payable onlyDelegateCall {
        assembly {
            let length := mload(transactions)
            let i := 0x20
            for {} lt(i, length) {} {
                let operation := shr(0xf8, mload(add(transactions, i)))
                let to := shr(0x60, mload(add(transactions, add(i, 0x01))))
                let value := mload(add(transactions, add(i, 0x15)))
                let dataLength := mload(add(transactions, add(i, 0x35)))
                let data := add(transactions, add(i, 0x55))

                // Reject DelegateCall (operation != 0)
                if operation {
                    // revert("DelegateCall not allowed")
                    mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
                    mstore(4, 0x20)
                    mstore(0x24, 23)
                    mstore(0x44, "DelegateCall not allowed")
                    revert(0, 0x64)
                }

                let success := call(gas(), to, value, data, dataLength, 0, 0)

                if eq(success, 0) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }

                i := add(i, add(0x55, dataLength))
            }
        }
    }
}
