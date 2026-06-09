// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title MultiSendEncoder
 * @notice Utility library for encoding MultiSend transaction batches
 * @dev Encodes an array of (target, value, data) tuples into the packed format
 *      expected by MultiSend.multiSend(bytes). This is a convenience for on-chain
 *      encoding — most integrations encode MultiSend data off-chain in JS/TS.
 *
 *      Packed format per transaction:
 *      [operation (1 byte)][to (20 bytes)][value (32 bytes)][dataLength (32 bytes)][data (N bytes)]
 *
 *      Practical limit: ~50 actions per batch. Beyond that, memory expansion gas
 *      becomes significant. Proposals rarely need more than 5-10 actions.
 */
library MultiSendEncoder {
    error LengthMismatch();

    /**
     * @notice Encode multiple transactions into MultiSend packed format
     * @param targets Target addresses for each transaction
     * @param values ETH values for each transaction
     * @param datas Calldata for each transaction
     * @return encoded Packed transaction bytes ready for MultiSend.multiSend()
     */
    function encodeMultisend(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas
    ) external pure returns (bytes memory encoded) {
        if (targets.length != values.length || targets.length != datas.length) revert LengthMismatch();

        // Pre-compute total length to allocate once (avoids O(n^2) reallocation)
        uint256 totalLen;
        for (uint256 i = 0; i < targets.length; i++) {
            // 1 (operation) + 20 (address) + 32 (value) + 32 (dataLength) + data.length
            totalLen += 85 + datas[i].length;
        }

        encoded = new bytes(totalLen);
        uint256 offset;

        for (uint256 i = 0; i < targets.length; i++) {
            address target = targets[i];
            uint256 value = values[i];
            uint256 dataLen = datas[i].length;

            // solhint-disable-next-line no-inline-assembly
            assembly ("memory-safe") {
                let ptr := add(add(encoded, 32), offset)

                // operation = 0 (Call), stored in 1 byte
                mstore8(ptr, 0)
                ptr := add(ptr, 1)

                // target address (20 bytes, right-aligned in 32-byte word)
                mstore(ptr, shl(96, target))
                ptr := add(ptr, 20)

                // value (32 bytes)
                mstore(ptr, value)
                ptr := add(ptr, 32)

                // data length (32 bytes)
                mstore(ptr, dataLen)
                ptr := add(ptr, 32)
            }

            // Copy calldata bytes (word-sized copy via assembly)
            bytes calldata data = datas[i];
            // solhint-disable-next-line no-inline-assembly
            assembly ("memory-safe") {
                calldatacopy(add(add(encoded, 32), add(offset, 85)), data.offset, dataLen)
            }

            offset += 85 + dataLen;
        }
    }
}
