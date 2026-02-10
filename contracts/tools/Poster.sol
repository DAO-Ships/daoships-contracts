// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

/**
 * @title Poster
 * @notice EIP-3722 implementation for on-chain metadata storage
 * @dev Minimal contract for emitting metadata as events
 *      Used for DAO profiles, proposal details, member information
 *
 * Specification: https://eips.ethereum.org/EIPS/eip-3722
 *
 * Use Cases:
 * - DAO profile information (name, description, logo, links)
 * - Proposal metadata (detailed description, voting options)
 * - Member profiles (ENS name, bio, avatar)
 * - General announcements and updates
 *
 * Integration:
 * - Indexers listen for NewPost events
 * - Content can be IPFS hash, JSON string, or plain text
 * - Tags allow filtering and categorization
 * - No on-chain state storage (gas efficient)
 */
contract Poster {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when content is posted
     * @param user Address that posted the content
     * @param content Posted content (IPFS hash, JSON, or plain text)
     * @param tag Category or identifier for filtering
     */
    event NewPost(
        address indexed user,
        string content,
        string indexed tag
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Post content on-chain as an event
     * @dev No state storage, just emits event for indexers
     * @param content Content to post (can be IPFS hash, JSON, or text)
     * @param tag Category or identifier (e.g., "proposal", "profile", "announcement")
     *
     * Examples:
     * - tag: "daoProfile", content: '{"name":"My DAO","description":"..."}'
     * - tag: "proposal", content: 'ipfs://QmXxx...' (IPFS hash)
     * - tag: "announcement", content: "New feature launched!"
     */
    function post(string calldata content, string calldata tag) external {
        emit NewPost(msg.sender, content, tag);
    }

    /**
     * @notice Post content with default tag
     * @param content Content to post
     */
    function post(string calldata content) external {
        emit NewPost(msg.sender, content, "");
    }
}
