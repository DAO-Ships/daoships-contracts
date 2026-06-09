// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "./BaseNavigator.sol";

/**
 * @title OnboarderNavigator
 * @notice Allows onboarding to a DAOShip DAO by sending native tokens (QUAI on Quai Network)
 * @dev MANAGER navigator that mints shares/loot in exchange for native token tribute
 *
 * Supports two pricing models via constructor configuration:
 * - Multiplier mode: shareMultiplier/lootMultiplier in basis points (10000 = 1x)
 * - Fixed-price mode: set pricePerUnit > 0 for unit-based pricing with refunds
 *
 * Security features:
 * - Mint cap prevents unbounded dilution
 * - Optional Merkle allowlist for curated membership
 * - Pause mechanism for emergency stops
 * - ReentrancyGuard on all external entry points
 * - Immutable configuration for gas efficiency
 */
contract OnboarderNavigator is BaseNavigator {

    /// @notice Navigator type identifier for indexer discovery
    string public constant navigatorType = "OnboarderNavigator";

    /// @notice Share multiplier in basis points (10000 = 1x). 0 if using fixed-price mode.
    uint256 public immutable shareMultiplier;

    /// @notice Loot multiplier in basis points (10000 = 1x). 0 if using fixed-price mode.
    uint256 public immutable lootMultiplier;

    /// @notice Fixed price per unit in wei. 0 if using multiplier mode.
    uint256 public immutable pricePerUnit;

    /// @notice Shares minted per unit (only used in fixed-price mode)
    uint256 public immutable sharesPerUnit;

    /// @notice Loot minted per unit (only used in fixed-price mode)
    uint256 public immutable lootPerUnit;

    /// @notice Minimum native token required to onboard (anti-spam, in wei)
    uint256 public immutable minTribute;

    error InsufficientTribute();
    error TransferFailed();
    error RefundFailed();

    /// @notice Emitted when governance recovers stuck ETH (e.g. a failed refund) from this contract
    event StuckETHRecovered(address indexed to, uint256 amount);

    /**
     * @notice Deploy OnboarderNavigator
     * @param _daoShip DAOShip DAO address
     * @param _shareMultiplier Share multiplier (basis points). Set 0 for fixed-price mode.
     * @param _lootMultiplier Loot multiplier (basis points). Set 0 for fixed-price mode.
     * @param _pricePerUnit Fixed price per unit in wei. Set 0 for multiplier mode.
     * @param _sharesPerUnit Shares per unit (fixed-price mode only)
     * @param _lootPerUnit Loot per unit (fixed-price mode only)
     * @param _minTribute Minimum tribute in wei (multiplier mode) or 0
     * @param _expiry Expiration timestamp (0 for no expiry)
     * @param _mintCap Maximum total tokens mintable (0 for unlimited)
     * @param _perAddressCap Maximum tokens any single address can receive (0 for unlimited)
     * @param _allowlistRoot Merkle root for allowlist (bytes32(0) for open)
     * @param _name Human-readable name (optional, can be empty. Recommended: up to 100 chars)
     * @param _description Human-readable description (optional, can be empty. Recommended: up to 500 chars)
     */
    constructor(
        address _daoShip,
        uint256 _shareMultiplier,
        uint256 _lootMultiplier,
        uint256 _pricePerUnit,
        uint256 _sharesPerUnit,
        uint256 _lootPerUnit,
        uint256 _minTribute,
        uint256 _expiry,
        uint256 _mintCap,
        uint256 _perAddressCap,
        bytes32 _allowlistRoot,
        string memory _name,
        string memory _description
    ) BaseNavigator(_daoShip, _expiry, _mintCap, _perAddressCap, _allowlistRoot) {
        // Must be either multiplier mode OR fixed-price mode, not both
        bool isMultiplierMode = _shareMultiplier > 0 || _lootMultiplier > 0;
        bool isFixedPriceMode = _pricePerUnit > 0;
        if (!isMultiplierMode && !isFixedPriceMode) revert InvalidConfig();
        if (isMultiplierMode && isFixedPriceMode) revert InvalidConfig();
        if (isFixedPriceMode && _sharesPerUnit == 0 && _lootPerUnit == 0) revert InvalidConfig();

        shareMultiplier = _shareMultiplier;
        lootMultiplier = _lootMultiplier;
        pricePerUnit = _pricePerUnit;
        sharesPerUnit = _sharesPerUnit;
        lootPerUnit = _lootPerUnit;
        minTribute = _minTribute;

        emit NavigatorDeployed(_daoShip, msg.sender, navigatorType, _name, _description);
    }

    /**
     * @notice Onboard by sending native tokens with allowlist proof
     * @param proof Merkle proof for allowlist (empty bytes32[] if no allowlist)
     */
    function onboard(bytes32[] calldata proof) external payable nonReentrant {
        _onboard(proof);
    }

    /**
     * @notice Onboard without allowlist proof (for open onboarding)
     */
    function onboard() external payable nonReentrant {
        _onboard(new bytes32[](0));
    }

    /**
     * @notice Withdraw any ETH stuck in this contract (e.g., failed refunds).
     * @dev Only callable by the DAOShip avatar (governance).
     *      In fixed-price mode, a refund can fail if the contributor is a contract that
     *      rejects ETH. Shares are already minted and tribute is already in the vault,
     *      but the remainder accumulates here. Governance can recover it to any address.
     * @param to Recipient of the recovered ETH
     * @param amount Amount of ETH to withdraw (in wei)
     */
    function withdrawStuckETH(address payable to, uint256 amount) external nonReentrant {
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit StuckETHRecovered(to, amount);
    }

    /**
     * @notice Accept plain ETH transfers and trigger onboarding.
     * @dev Delegates to _onboard() with an empty proof so that plain ETH sends
     *      (e.g., from a wallet or contract that uses transfer/send/call without data)
     *      participate in onboarding the same as explicit onboard() calls.
     *      Reverts early with a clear error when an allowlist is active, since
     *      plain transfers cannot include a Merkle proof.
     */
    receive() external payable nonReentrant {
        if (allowlistRoot != bytes32(0)) revert NotAllowlisted();
        _onboard(new bytes32[](0));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Internal onboard logic
     * @dev nonReentrant is on the external entry points, not here.
     * @param proof Merkle proof for allowlist
     */
    function _onboard(bytes32[] memory proof) internal {
        if (paused) revert IsPaused();
        if (expiry != 0 && block.timestamp > expiry) revert Expired();

        _checkAllowlist(proof);

        uint256 sharesToMint;
        uint256 lootToMint;
        uint256 cost;
        uint256 remainder;

        if (pricePerUnit > 0) {
            // Fixed-price mode
            if (msg.value < pricePerUnit) revert InsufficientTribute();
            uint256 units = msg.value / pricePerUnit;
            cost = units * pricePerUnit;
            remainder = msg.value - cost;
            sharesToMint = units * sharesPerUnit;
            lootToMint = units * lootPerUnit;
        } else {
            // Multiplier mode
            if (msg.value < minTribute) revert InsufficientTribute();
            cost = msg.value;
            sharesToMint = (msg.value * shareMultiplier) / 10000;
            lootToMint = (msg.value * lootMultiplier) / 10000;
        }

        // Reject if both amounts truncated to zero (dust payment produces nothing)
        uint256 toMint = sharesToMint + lootToMint;
        if (toMint == 0) revert InsufficientTribute();

        _checkAndUpdateCaps(toMint);

        // Mint shares and loot, then forward tribute to treasury.
        // Ordering note: minting happens before tribute transfer. This is safe because:
        //   1. nonReentrant prevents re-entry into onboard()
        //   2. ERC20._mint has no callbacks (no ERC777/ERC721-style hooks)
        //   3. If the tribute transfer reverts, EVM atomicity rolls back the mints
        // The alternative (transfer-first) is functionally identical but changes error
        // semantics — a rejected tribute would revert before any minting state is written.
        _mintSharesAndLoot(msg.sender, sharesToMint, lootToMint);

        // Forward tribute to DAO treasury
        (bool success, ) = daoShip.avatar().call{value: cost}("");
        if (!success) revert TransferFailed();

        // Refund remainder (fixed-price mode only)
        if (remainder > 0) {
            (bool refundSuccess, ) = msg.sender.call{value: remainder}("");
            if (!refundSuccess) revert RefundFailed();
        }

        emit Onboard(address(daoShip), msg.sender, cost, sharesToMint, lootToMint);
    }
}
