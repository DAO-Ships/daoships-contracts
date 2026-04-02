// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../core/DAOShip.sol";
import "../interfaces/INavigator.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

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
contract OnboarderNavigator is ReentrancyGuard, INavigator {

    /// @notice Navigator type identifier for indexer discovery
    string public constant navigatorType = "OnboarderNavigator";

    /// @notice Address that deployed this navigator
    address public immutable deployer;

    /// @notice Associated DAOShip DAO
    DAOShip public immutable daoShip;

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

    /// @notice Expiration timestamp (0 = no expiration)
    uint256 public immutable expiry;

    /// @notice Maximum total shares+loot this navigator can mint (0 = unlimited)
    uint256 public immutable mintCap;

    /// @notice Maximum shares+loot any single address can receive (0 = unlimited)
    uint256 public immutable perAddressCap;

    /// @notice Merkle root for allowlist (bytes32(0) = no allowlist, anyone can join)
    bytes32 public immutable allowlistRoot;

    /// @notice Total shares+loot minted so far
    uint256 public totalMinted;

    /// @notice Per-address minted tracking
    mapping(address => uint256) public mintedTo;

    /// @notice Whether the navigator is paused
    bool public paused;

    event Onboard(address indexed daoShipAddress, address indexed contributor, uint256 amount, uint256 shares, uint256 loot);
    event Paused(address indexed caller);
    event Unpaused(address indexed caller);

    error InsufficientTribute();
    error Expired();
    error MintCapExceeded();
    error PerAddressCapExceeded();
    error NotAllowlisted();
    error IsPaused();
    error TransferFailed();
    error RefundFailed();
    error NotAuthorized();
    error InvalidConfig();

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
    ) {
        if (_daoShip == address(0)) revert InvalidConfig();

        // Must be either multiplier mode OR fixed-price mode, not both
        bool isMultiplierMode = _shareMultiplier > 0 || _lootMultiplier > 0;
        bool isFixedPriceMode = _pricePerUnit > 0;
        if (!isMultiplierMode && !isFixedPriceMode) revert InvalidConfig();
        if (isMultiplierMode && isFixedPriceMode) revert InvalidConfig();
        if (isFixedPriceMode && _sharesPerUnit == 0 && _lootPerUnit == 0) revert InvalidConfig();

        deployer = msg.sender;
        daoShip = DAOShip(payable(_daoShip));
        shareMultiplier = _shareMultiplier;
        lootMultiplier = _lootMultiplier;
        pricePerUnit = _pricePerUnit;
        sharesPerUnit = _sharesPerUnit;
        lootPerUnit = _lootPerUnit;
        minTribute = _minTribute;
        expiry = _expiry;
        mintCap = _mintCap;
        perAddressCap = _perAddressCap;
        allowlistRoot = _allowlistRoot;

        emit NavigatorDeployed(_daoShip, msg.sender, navigatorType, _name, _description);
    }

    /**
     * @notice Onboard by sending native tokens
     * @param proof Merkle proof for allowlist (empty bytes32[] if no allowlist)
     */
    function onboard(bytes32[] memory proof) public payable nonReentrant {
        if (paused) revert IsPaused();
        if (expiry != 0 && block.timestamp > expiry) revert Expired();

        // Allowlist check
        if (allowlistRoot != bytes32(0)) {
            if (!MerkleProof.verify(proof, allowlistRoot, keccak256(bytes.concat(keccak256(abi.encode(msg.sender)))))) {
                revert NotAllowlisted();
            }
        }

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

        // Mint cap checks
        if (mintCap > 0 && totalMinted + toMint > mintCap) revert MintCapExceeded();
        if (perAddressCap > 0 && mintedTo[msg.sender] + toMint > perAddressCap) revert PerAddressCapExceeded();
        totalMinted += toMint;
        mintedTo[msg.sender] += toMint;

        // Mint shares and loot, then forward tribute to treasury.
        // Ordering note: minting happens before tribute transfer. This is safe because:
        //   1. nonReentrant prevents re-entry into onboard()
        //   2. ERC20._mint has no callbacks (no ERC777/ERC721-style hooks)
        //   3. If the tribute transfer reverts, EVM atomicity rolls back the mints
        // The alternative (transfer-first) is functionally identical but changes error
        // semantics — a rejected tribute would revert before any minting state is written.
        address[] memory recipients = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        recipients[0] = msg.sender;

        if (sharesToMint > 0) {
            amounts[0] = sharesToMint;
            daoShip.mintShares(recipients, amounts);
        }

        if (lootToMint > 0) {
            amounts[0] = lootToMint;
            daoShip.mintLoot(recipients, amounts);
        }

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

    /**
     * @notice Onboard without allowlist proof (for open onboarding)
     */
    function onboard() external payable {
        onboard(new bytes32[](0));
    }

    /**
     * @notice Pause onboarding
     * @dev Gap 10: Requires GOVERNOR navigator permission (navigators[msg.sender] & 4 != 0)
     *      OR the DAO avatar. This ensures both pause and unpause go through the same
     *      authorization path — preventing any large shareholder from unilaterally pausing
     *      while governance is required to unpause (asymmetric griefing vector).
     *      GOVERNOR navigators are explicitly authorized actors (set via governance proposal).
     */
    function pause() external {
        if ((daoShip.navigators(msg.sender) & 4) == 0 && msg.sender != daoShip.avatar()) revert NotAuthorized();
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause onboarding
     * @dev Requires GOVERNOR navigator permission or DAO avatar (same as pause).
     */
    function unpause() external {
        if ((daoShip.navigators(msg.sender) & 4) == 0 && msg.sender != daoShip.avatar()) revert NotAuthorized();
        paused = false;
        emit Unpaused(msg.sender);
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
    function withdrawStuckETH(address payable to, uint256 amount) external {
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();
        (bool success, ) = to.call{value: amount}("");
        require(success, "OnboarderNavigator: withdrawal failed");
    }

    /**
     * @notice Accept plain ETH transfers and trigger onboarding.
     * @dev Delegates to onboard() with an empty proof so that plain ETH sends
     *      (e.g., from a wallet or contract that uses transfer/send/call without data)
     *      participate in onboarding the same as explicit onboard() calls.
     */
    receive() external payable {
        onboard(new bytes32[](0));
    }
}
