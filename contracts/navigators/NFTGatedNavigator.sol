// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "./BaseNavigator.sol";
import "../interfaces/IMembershipGate.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title NFTGatedNavigator
 * @notice Onboards holders of a specific ERC-721 collection into a DAOShip DAO.
 * @dev MANAGER navigator. A holder calls `onboard(tokenId)`; the navigator verifies
 *      `ownerOf(tokenId) == msg.sender` and mints a fixed amount of shares/loot.
 *
 * Claim model — "claim ticket", one claim per tokenId, forever:
 * - Each tokenId can be used to onboard exactly once (`claimed[tokenId]`).
 * - Tracking is per-TOKEN, not per-address. This defeats the transfer-and-reclaim
 *   recycle attack: passing the NFT to a new wallet does NOT unlock a second claim,
 *   because the token itself is already spent.
 * - Shares are a ticket: once minted they persist even if the NFT is later sold.
 *   The buyer of an already-claimed NFT receives nothing (frontends should surface
 *   `claimed[tokenId]`).
 *
 * Scope:
 * - ERC-721 only. ERC-1155 is intentionally NOT supported here — its native gating
 *   idiom is amount-based ("hold >= N of id"), which is a different feature reserved
 *   for a future dedicated navigator. See docs/NAVIGATORS.md.
 *
 * Modes:
 * - Free mint: `requireTribute = false`, `tributeAmount = 0`. `onboard` rejects value.
 * - Tribute required: `requireTribute = true`, `tributeAmount > 0`. Exact native
 *   tribute is forwarded to the vault.
 *
 * Security:
 * - `mintCap` is MANDATORY. The gate collection is an arbitrary external contract and
 *   may be mintable; the cap bounds total dilution regardless of collection growth.
 * - `ReentrancyGuard` on every external entry point; checks-effects-interactions order.
 * - Optional Merkle allowlist composes on top of the NFT gate (defense in depth).
 * - Pause controllable by GOVERNOR navigator or the DAO avatar (via BaseNavigator).
 * - No `receive()`/`fallback()` and tribute is exact (no refund remainder), so this contract
 *   never holds ETH and intentionally exposes no ETH-recovery surface. Tribute is forwarded to
 *   the vault in the same call; a rejected forward reverts the whole claim atomically.
 *
 * Implements `IMembershipGate` so its eligibility check is reusable by other contracts.
 */
contract NFTGatedNavigator is BaseNavigator, IMembershipGate {

    /// @notice Navigator type identifier for indexer discovery
    string public constant navigatorType = "NFTGatedNavigator";

    /// @notice The ERC-721 collection that gates membership
    IERC721 public immutable gateToken;

    /// @notice Shares minted to a holder on a successful claim
    uint256 public immutable sharesPerHolder;

    /// @notice Loot minted to a holder on a successful claim
    uint256 public immutable lootPerHolder;

    /// @notice Whether a native-token tribute is required to onboard
    bool public immutable requireTribute;

    /// @notice Exact native tribute required when `requireTribute` is true (wei)
    uint256 public immutable tributeAmount;

    /// @notice Per-tokenId claim tracking. True once a token has been used to onboard.
    mapping(uint256 => bool) public claimed;

    error NotHolder();
    error AlreadyClaimed();
    error IncorrectTribute();
    error NoTributeRequired();
    error TransferFailed();

    /**
     * @notice Emitted on a successful NFT-gated claim (adds tokenId over the base `Onboard` event)
     * @param daoShipAddress DAO this claim belongs to
     * @param holder Address that claimed (and received shares/loot)
     * @param tokenId The ERC-721 token id consumed by this claim
     * @param shares Shares minted
     * @param loot Loot minted
     */
    event NFTClaimed(
        address indexed daoShipAddress,
        address indexed holder,
        uint256 indexed tokenId,
        uint256 shares,
        uint256 loot
    );

    /**
     * @notice Deploy NFTGatedNavigator
     * @param _daoShip DAOShip DAO address
     * @param _gateToken ERC-721 collection that gates membership (must be a deployed contract)
     * @param _sharesPerHolder Shares minted per claim (0 to mint only loot)
     * @param _lootPerHolder Loot minted per claim (0 to mint only shares)
     * @param _requireTribute Whether a native tribute is required
     * @param _tributeAmount Exact native tribute (wei); must be 0 iff `_requireTribute` is false
     * @param _expiry Expiration timestamp (0 for no expiry)
     * @param _mintCap Maximum total tokens mintable — MANDATORY, must be > 0
     * @param _perAddressCap Maximum tokens any single address can receive (0 for unlimited)
     * @param _allowlistRoot Optional Merkle root layered on top of the NFT gate (bytes32(0) for none)
     * @param _name Human-readable name (optional, can be empty)
     * @param _description Human-readable description (optional, can be empty)
     */
    constructor(
        address _daoShip,
        address _gateToken,
        uint256 _sharesPerHolder,
        uint256 _lootPerHolder,
        bool _requireTribute,
        uint256 _tributeAmount,
        uint256 _expiry,
        uint256 _mintCap,
        uint256 _perAddressCap,
        bytes32 _allowlistRoot,
        string memory _name,
        string memory _description
    ) BaseNavigator(_daoShip, _expiry, _mintCap, _perAddressCap, _allowlistRoot) {
        // Gate must be a deployed contract (not an EOA / undeployed address)
        if (_gateToken == address(0) || _gateToken.code.length == 0) revert InvalidConfig();
        // Must mint something
        if (_sharesPerHolder == 0 && _lootPerHolder == 0) revert InvalidConfig();
        // Tribute flag and amount must agree
        if (_requireTribute && _tributeAmount == 0) revert InvalidConfig();
        if (!_requireTribute && _tributeAmount != 0) revert InvalidConfig();
        // mintCap is a mandatory dilution backstop for an arbitrary, possibly-mintable collection
        if (_mintCap == 0) revert InvalidConfig();
        // A single claim must be able to fit under the global cap, else the navigator is dead on arrival
        if (_sharesPerHolder + _lootPerHolder > _mintCap) revert InvalidConfig();
        // If a per-address cap is set, one claim must be able to fit under it too.
        // NOTE: perAddressCap is keyed to msg.sender (per-WALLET), so it is NOT an anti-whale
        // guarantee for a transferable gate — a holder of N tokens can claim from N wallets.
        if (_perAddressCap != 0 && _perAddressCap < _sharesPerHolder + _lootPerHolder) revert InvalidConfig();

        gateToken = IERC721(_gateToken);
        sharesPerHolder = _sharesPerHolder;
        lootPerHolder = _lootPerHolder;
        requireTribute = _requireTribute;
        tributeAmount = _tributeAmount;

        emit NavigatorDeployed(_daoShip, msg.sender, navigatorType, _name, _description);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // External
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Onboard by proving ownership of `tokenId` (no allowlist)
     * @param tokenId The ERC-721 token id to claim with
     */
    function onboard(uint256 tokenId) external payable nonReentrant {
        _onboard(tokenId, new bytes32[](0));
    }

    /**
     * @notice Onboard by proving ownership of `tokenId`, with a Merkle allowlist proof
     * @param tokenId The ERC-721 token id to claim with
     * @param proof Merkle proof for the optional allowlist
     */
    function onboard(uint256 tokenId, bytes32[] calldata proof) external payable nonReentrant {
        _onboard(tokenId, proof);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // IMembershipGate (stateless eligibility — independent of claim status)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IMembershipGate
    function isEligible(address candidate) external view returns (bool eligible) {
        try gateToken.balanceOf(candidate) returns (uint256 bal) {
            return bal > 0;
        } catch {
            return false;
        }
    }

    /// @inheritdoc IMembershipGate
    function isEligibleToken(address candidate, uint256 tokenId) external view returns (bool eligible) {
        return _ownsToken(candidate, tokenId);
    }

    /**
     * @notice Frontend convenience: can `candidate` onboard with `tokenId` right now?
     * @dev Combines eligibility, claim status, expiry and pause. Does NOT check tribute
     *      or mint caps (those depend on msg.value / running totals at call time).
     */
    function canOnboard(address candidate, uint256 tokenId) external view returns (bool) {
        if (paused) return false;
        if (expiry != 0 && block.timestamp > expiry) return false;
        if (claimed[tokenId]) return false;
        return _ownsToken(candidate, tokenId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Whether `candidate` currently owns `tokenId` on the gate collection.
     * @dev Never reverts: the gate is untrusted, so a reverting/nonexistent `ownerOf`
     *      (burned or never-minted token, non-conforming gate) resolves to false.
     *      Single source of truth for the ownership check used by the views and onboarding.
     */
    function _ownsToken(address candidate, uint256 tokenId) private view returns (bool) {
        try gateToken.ownerOf(tokenId) returns (address tokenOwner) {
            return tokenOwner == candidate;
        } catch {
            return false;
        }
    }

    /**
     * @notice Internal onboard logic. nonReentrant is on the external entry points.
     * @dev Checks-effects-interactions: the only untrusted external read is `ownerOf`
     *      at the top, and reentry is blocked by the guard on the entry point. All state
     *      (claimed, caps) is written before the trusted DAOShip mint and tribute forward.
     */
    function _onboard(uint256 tokenId, bytes32[] memory proof) internal {
        if (paused) revert IsPaused();
        if (expiry != 0 && block.timestamp > expiry) revert Expired();

        // Optional allowlist layered on top of the NFT gate
        _checkAllowlist(proof);

        // Gate: caller must own this specific token. Covers wrong owner AND nonexistent
        // tokens (burned / never minted), both surfaced as NotHolder.
        if (!_ownsToken(msg.sender, tokenId)) revert NotHolder();

        // One claim per tokenId, ever
        if (claimed[tokenId]) revert AlreadyClaimed();

        // Tribute must match the configured mode exactly
        if (requireTribute) {
            if (msg.value != tributeAmount) revert IncorrectTribute();
        } else {
            if (msg.value != 0) revert NoTributeRequired();
        }

        // Effects
        claimed[tokenId] = true;
        _checkAndUpdateCaps(sharesPerHolder + lootPerHolder);

        // Interactions: mint via DAOShip (trusted), then forward tribute to the vault
        _mintSharesAndLoot(msg.sender, sharesPerHolder, lootPerHolder);

        if (msg.value > 0) {
            (bool success, ) = daoShip.avatar().call{value: msg.value}("");
            if (!success) revert TransferFailed();
        }

        emit Onboard(address(daoShip), msg.sender, msg.value, sharesPerHolder, lootPerHolder);
        emit NFTClaimed(address(daoShip), msg.sender, tokenId, sharesPerHolder, lootPerHolder);
    }
}
