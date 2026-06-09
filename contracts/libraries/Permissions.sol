// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title Permissions
 * @notice Canonical navigator permission bitmask values — the single definition shared
 *         by DAOShip and every navigator, so the bits live in exactly one place.
 * @dev Navigators are deployed against a *predicted* DAO address and cannot read the DAO
 *      in their constructor; a runtime `daoShip.GOVERNOR()` call is therefore unavailable.
 *      Referencing these compile-time library constants gives a single source of truth
 *      with no runtime call. DAOShip re-exports them as public constants
 *      (ADMIN/MANAGER/GOVERNOR/MAX_PERMISSION) so external readers and indexers keep
 *      their getters.
 *
 * Bitmask (checked with bitwise AND, e.g. `navigators[addr] & MANAGER != 0`):
 *   ADMIN    = 1  — admin operations
 *   MANAGER  = 2  — mint/burn shares and loot
 *   GOVERNOR = 4  — cancel proposals, set governance config
 *   ALL      = ADMIN | MANAGER | GOVERNOR = 7  (MAX_PERMISSION)
 */
library Permissions {
    uint256 internal constant ADMIN = 1;
    uint256 internal constant MANAGER = 2;
    uint256 internal constant GOVERNOR = 4;
    uint256 internal constant MAX_PERMISSION = 7;
}
