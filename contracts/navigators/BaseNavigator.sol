// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../core/DAOShip.sol";
import "../interfaces/INavigator.sol";
import "../libraries/Permissions.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title BaseNavigator
 * @notice Abstract base contract for DAOShip navigator implementations
 * @dev Extracts shared state, errors, events, and logic (allowlist verification,
 *      mint-cap accounting, pause/unpause, share/loot minting helper) so that
 *      concrete navigators only implement their pricing and tribute mechanics.
 *
 *      Concrete contracts MUST:
 *        - Define `string public constant navigatorType`
 *        - Emit `NavigatorDeployed` in their own constructor
 *        - Call the BaseNavigator constructor with shared parameters
 */
abstract contract BaseNavigator is ReentrancyGuard, INavigator {

    // ═══════════════════════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Sourced from the shared Permissions library — single definition of the
    ///      navigator permission bits, resolved at compile time (no runtime DAO call,
    ///      so it is safe under the predicted-address deployment pattern).
    uint256 private constant _GOVERNOR = Permissions.GOVERNOR;

    // ═══════════════════════════════════════════════════════════════════════════
    // Immutables
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Address that deployed this navigator
    address public immutable deployer;

    /// @notice Associated DAOShip DAO
    DAOShip public immutable daoShip;

    /// @notice Expiration timestamp (0 = no expiration)
    uint256 public immutable expiry;

    /// @notice Maximum total shares+loot this navigator can mint (0 = unlimited)
    uint256 public immutable mintCap;

    /// @notice Maximum shares+loot any single address can receive (0 = unlimited)
    uint256 public immutable perAddressCap;

    /// @notice Merkle root for allowlist (bytes32(0) = open to anyone)
    bytes32 public immutable allowlistRoot;

    // ═══════════════════════════════════════════════════════════════════════════
    // Storage
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Total shares+loot minted so far
    uint256 public totalMinted;

    /// @notice Per-address minted tracking
    mapping(address => uint256) public mintedTo;

    /// @notice Whether the navigator is paused
    bool public paused;

    // ═══════════════════════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════════════════════

    event Onboard(
        address indexed daoShipAddress,
        address indexed contributor,
        uint256 amount,
        uint256 shares,
        uint256 loot
    );
    event Paused(address indexed caller);
    event Unpaused(address indexed caller);

    // ═══════════════════════════════════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════════════════════════════════

    error Expired();
    error MintCapExceeded();
    error PerAddressCapExceeded();
    error NotAllowlisted();
    error IsPaused();
    error NotAuthorized();
    error InvalidConfig();

    // ═══════════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @param _daoShip DAOShip DAO address
     * @param _expiry Expiration timestamp (0 for no expiry)
     * @param _mintCap Maximum total tokens mintable (0 for unlimited)
     * @param _perAddressCap Maximum tokens any single address can receive (0 for unlimited)
     * @param _allowlistRoot Merkle root for allowlist (bytes32(0) for open)
     */
    constructor(
        address _daoShip,
        uint256 _expiry,
        uint256 _mintCap,
        uint256 _perAddressCap,
        bytes32 _allowlistRoot
    ) {
        if (_daoShip == address(0)) revert InvalidConfig();

        deployer = msg.sender;
        daoShip = DAOShip(payable(_daoShip));
        expiry = _expiry;
        mintCap = _mintCap;
        perAddressCap = _perAddressCap;
        allowlistRoot = _allowlistRoot;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Shared external functions
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Pause onboarding
     * @dev Requires GOVERNOR navigator permission (navigators[msg.sender] & 4 != 0)
     *      OR the DAO avatar. Symmetric with unpause to prevent unilateral griefing.
     */
    function pause() external {
        if ((daoShip.navigators(msg.sender) & _GOVERNOR) == 0 && msg.sender != daoShip.avatar()) revert NotAuthorized();
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause onboarding
     * @dev Requires GOVERNOR navigator permission or DAO avatar (same as pause).
     */
    function unpause() external {
        if ((daoShip.navigators(msg.sender) & _GOVERNOR) == 0 && msg.sender != daoShip.avatar()) revert NotAuthorized();
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Shared internal functions
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Verify sender is on the Merkle allowlist (no-op if allowlist is disabled)
     * @param proof Merkle proof for allowlist verification
     */
    function _checkAllowlist(bytes32[] memory proof) internal view {
        if (!_isAllowlisted(msg.sender, proof)) revert NotAllowlisted();
    }

    /**
     * @notice Non-reverting allowlist membership check for an arbitrary account.
     * @dev Returns true when no allowlist is configured. Lets views (e.g. canOnboard)
     *      evaluate allowlist eligibility without reverting, using the same leaf encoding
     *      as `_checkAllowlist` so view and write paths agree.
     * @param account Address to check membership for
     * @param proof Merkle proof for `account`
     */
    function _isAllowlisted(address account, bytes32[] memory proof) internal view returns (bool) {
        if (allowlistRoot == bytes32(0)) return true;
        return MerkleProof.verify(proof, allowlistRoot, keccak256(bytes.concat(keccak256(abi.encode(account)))));
    }

    /**
     * @notice Enforce mint cap and per-address cap, then update accounting
     * @param toMint Total shares+loot being minted in this call
     */
    function _checkAndUpdateCaps(uint256 toMint) internal {
        if (mintCap > 0 && totalMinted + toMint > mintCap) revert MintCapExceeded();
        if (perAddressCap > 0 && mintedTo[msg.sender] + toMint > perAddressCap) revert PerAddressCapExceeded();
        totalMinted += toMint;
        mintedTo[msg.sender] += toMint;
    }

    /**
     * @notice Mint shares and/or loot to a single recipient via the DAOShip
     * @dev Builds the single-element arrays expected by DAOShip.mintShares / mintLoot
     * @param to Recipient address
     * @param sharesToMint Amount of shares to mint (0 to skip)
     * @param lootToMint Amount of loot to mint (0 to skip)
     */
    function _mintSharesAndLoot(address to, uint256 sharesToMint, uint256 lootToMint) internal {
        address[] memory recipients = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        recipients[0] = to;

        if (sharesToMint > 0) {
            amounts[0] = sharesToMint;
            daoShip.mintShares(recipients, amounts);
        }

        if (lootToMint > 0) {
            amounts[0] = lootToMint;
            daoShip.mintLoot(recipients, amounts);
        }
    }
}
