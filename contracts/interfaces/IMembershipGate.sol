// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IMembershipGate
 * @notice Standard-agnostic eligibility interface for membership gating.
 * @dev A "gate" answers a single, STATELESS question: is a candidate currently
 *      eligible to participate (e.g. does it hold the required credential)?
 *
 *      Gating is deliberately separated from claim-tracking. Eligibility ("do you
 *      own the credential right now?") belongs to the gate and is reusable across
 *      navigators. Anti-replay ("has this credential already been used to mint?")
 *      is navigator-local state and is NOT part of this interface.
 *
 *      v1 ships per-navigator gating (each navigator implements its own check).
 *      This interface exists so a future shared gate or gate-aware navigator family
 *      can consult a single eligibility source without rework. Implementations MUST
 *      be view-only and MUST NOT revert on unknown/nonexistent inputs — return
 *      `false` instead, so callers can probe safely.
 */
interface IMembershipGate {
    /**
     * @notice Whether `candidate` satisfies the gate by any means
     * @dev For an ERC-721 gate this is `balanceOf(candidate) > 0`.
     * @param candidate Address to check
     * @return eligible True if the candidate currently satisfies the gate
     */
    function isEligible(address candidate) external view returns (bool eligible);

    /**
     * @notice Whether `candidate` satisfies the gate via a specific token id
     * @dev For an ERC-721 gate this is `ownerOf(tokenId) == candidate`.
     *      Returns false (never reverts) if the token does not exist.
     * @param candidate Address to check
     * @param tokenId Token id to check ownership of
     * @return eligible True if the candidate currently owns `tokenId`
     */
    function isEligibleToken(address candidate, uint256 tokenId) external view returns (bool eligible);
}
