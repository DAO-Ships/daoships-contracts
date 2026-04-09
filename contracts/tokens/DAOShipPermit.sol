// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title DAOShipPermit
 * @notice Clone-safe EIP-2612 Permit implementation for DAOShip tokens
 * @dev OZ's ERC20Permit uses EIP712 with immutable name storage, which breaks on
 *      EIP-1167 clones (immutables are baked into the singleton's bytecode, not the
 *      clone's storage). This abstract contract implements IERC20Permit + Nonces
 *      directly with a clone-safe EIP-712 domain that reads name() from storage.
 *
 *      Inheritors must be ERC20 contracts so that name(), _approve(), etc. resolve.
 */
abstract contract DAOShipPermit is ERC20, Nonces, IERC20Permit {
    // EIP-712 constants for clone-safe Permit implementation
    bytes32 private constant _TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant _HASHED_VERSION = keccak256(bytes("1"));

    error ERC2612ExpiredSignature(uint256 deadline);
    error ERC2612InvalidSigner(address signer, address owner);

    // ═══════════════════════════════════════════════════════════════════════════════
    // EIP-2612 PERMIT (clone-safe implementation)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IERC20Permit
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external override {
        if (block.timestamp > deadline) {
            revert ERC2612ExpiredSignature(deadline);
        }

        bytes32 structHash = keccak256(
            abi.encode(_PERMIT_TYPEHASH, owner, spender, value, _useNonce(owner), deadline)
        );
        bytes32 hash = MessageHashUtils.toTypedDataHash(_domainSeparatorV4(), structHash);
        address signer = ECDSA.recover(hash, v, r, s);
        if (signer != owner) {
            revert ERC2612InvalidSigner(signer, owner);
        }

        _approve(owner, spender, value);
    }

    /// @inheritdoc IERC20Permit
    function nonces(address owner) public view override(IERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    /// @inheritdoc IERC20Permit
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view override returns (bytes32) {
        return _domainSeparatorV4();
    }

    /**
     * @notice Compute EIP-712 domain separator from clone storage
     * @dev Cannot use OZ's EIP712 because it stores name as an immutable (baked into
     *      singleton bytecode). Clones need to read from storage-based name() instead.
     *      Recomputed on every call — no caching, since the cache would belong to the
     *      singleton. On Quai's low-fee network, the extra ~2K gas is negligible.
     */
    function _domainSeparatorV4() internal view returns (bytes32) {
        return keccak256(
            abi.encode(_TYPE_HASH, keccak256(bytes(name())), _HASHED_VERSION, block.chainid, address(this))
        );
    }
}
