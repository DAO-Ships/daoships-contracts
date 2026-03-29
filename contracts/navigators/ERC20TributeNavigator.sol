// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../core/DAOShip.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title ERC20TributeNavigator
 * @notice Allows onboarding to a DAO Ships DAO by depositing ERC20 tokens
 * @dev MANAGER navigator that mints shares/loot in exchange for ERC20 tribute.
 *
 * The tribute token is sent directly to the DAO treasury (avatar/vault).
 * Supports configurable exchange rates, mint caps, allowlists, expiry,
 * and ERC-2612 permit for single-transaction onboarding.
 *
 * Parameters are in RAW WEI (1e18 = 1 whole share/loot token).
 * Tribute = (sharesToMint * pricePerShare) / 1e18.
 * This enables fractional purchases and aligns with DAOShip's internal token accounting.
 *
 * Example: tributeToken = USDC, pricePerShare = 100e6 (100 USDC per whole share)
 *          User calls onboard(5e18, 0) -> gets 5 shares (5e18 wei), 500 USDC to vault
 *          User calls onboard(5e17, 0) -> gets 0.5 shares (5e17 wei), 50 USDC to vault
 *
 * mintCap is also in raw wei (e.g., mintCap=100e18 caps at 100 whole shares+loot).
 */
contract ERC20TributeNavigator is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Navigator type identifier for indexer discovery
    string public constant navigatorType = "ERC20TributeNavigator";

    /// @notice Associated DAOShip DAO
    DAOShip public immutable daoShip;

    /// @notice ERC20 token accepted as tribute
    IERC20 public immutable tributeToken;

    /// @notice Tribute amount per share (in tribute token decimals)
    uint256 public immutable pricePerShare;

    /// @notice Tribute amount per loot (in tribute token decimals). 0 = no loot minting.
    uint256 public immutable pricePerLoot;

    /// @notice Expiration timestamp (0 = no expiration)
    uint256 public immutable expiry;

    /// @notice Maximum total shares+loot this navigator can mint (0 = unlimited)
    uint256 public immutable mintCap;

    /// @notice Maximum shares+loot any single address can receive (0 = unlimited)
    uint256 public immutable perAddressCap;

    /// @notice Merkle root for allowlist (bytes32(0) = open to anyone)
    bytes32 public immutable allowlistRoot;

    /// @notice Total shares+loot minted so far
    uint256 public totalMinted;

    /// @notice Per-address minted tracking
    mapping(address => uint256) public mintedTo;

    /// @notice Whether the navigator is paused
    bool public paused;

    event Onboard(
        address indexed daoShipAddress,
        address indexed contributor,
        uint256 tributeAmount,
        uint256 shares,
        uint256 loot
    );
    event Paused(address indexed caller);
    event Unpaused(address indexed caller);

    error InsufficientAmount();
    error Expired();
    error MintCapExceeded();
    error PerAddressCapExceeded();
    error NotAllowlisted();
    error IsPaused();
    error NotAuthorized();
    error InvalidConfig();

    /**
     * @notice Deploy ERC20TributeNavigator
     * @param _daoShip DAOShip DAO address
     * @param _tributeToken ERC20 token accepted as tribute
     * @param _pricePerShare Tribute token amount per share (0 if shares not offered)
     * @param _pricePerLoot Tribute token amount per loot (0 if loot not offered)
     * @param _expiry Expiration timestamp (0 for no expiry)
     * @param _mintCap Maximum total tokens mintable (0 for unlimited)
     * @param _perAddressCap Maximum tokens any single address can receive (0 for unlimited)
     * @param _allowlistRoot Merkle root for allowlist (bytes32(0) for open)
     */
    constructor(
        address _daoShip,
        address _tributeToken,
        uint256 _pricePerShare,
        uint256 _pricePerLoot,
        uint256 _expiry,
        uint256 _mintCap,
        uint256 _perAddressCap,
        bytes32 _allowlistRoot
    ) {
        if (_daoShip == address(0)) revert InvalidConfig();
        if (_tributeToken == address(0)) revert InvalidConfig();
        if (_pricePerShare == 0 && _pricePerLoot == 0) revert InvalidConfig();

        daoShip = DAOShip(payable(_daoShip));
        tributeToken = IERC20(_tributeToken);
        pricePerShare = _pricePerShare;
        pricePerLoot = _pricePerLoot;
        expiry = _expiry;
        mintCap = _mintCap;
        perAddressCap = _perAddressCap;
        allowlistRoot = _allowlistRoot;
    }

    /**
     * @notice Onboard by depositing ERC20 tribute (standard approve flow)
     * @dev Caller must approve this contract for the required tribute amount first.
     *      Parameters are in RAW WEI: pass 1e18 for 1 whole share/loot token.
     * @param sharesToMint Raw wei amount of shares to mint (e.g. 1e18 = 1 share)
     * @param lootToMint Raw wei amount of loot to mint (e.g. 1e18 = 1 loot)
     * @param proof Merkle proof for allowlist (empty if no allowlist)
     */
    function onboard(uint256 sharesToMint, uint256 lootToMint, bytes32[] calldata proof) public nonReentrant {
        _onboard(sharesToMint, lootToMint, proof);
    }

    /**
     * @notice Onboard without allowlist proof (for open onboarding)
     * @param sharesToMint Raw wei amount of shares to mint (e.g. 1e18 = 1 share)
     * @param lootToMint Raw wei amount of loot to mint (e.g. 1e18 = 1 loot)
     */
    function onboard(uint256 sharesToMint, uint256 lootToMint) external nonReentrant {
        _onboard(sharesToMint, lootToMint, new bytes32[](0));
    }

    /**
     * @notice Onboard using ERC-2612 permit for single-transaction approval + onboard
     * @dev Calls permit() on the tribute token then proceeds with standard onboard logic.
     *      The permit call is wrapped in try/catch per OpenZeppelin's recommended pattern:
     *      if the permit has already been consumed (e.g., front-run or user retry), the
     *      catch block absorbs the revert and safeTransferFrom uses the existing allowance.
     *
     *      SECURITY: The permit owner is ALWAYS msg.sender. This function does not accept
     *      an owner parameter to prevent allowance theft via stale approvals.
     *
     *      Only supports standard ERC-2612 permit. Non-standard implementations (e.g., DAI)
     *      will fail silently in try/catch; safeTransferFrom will revert if no prior
     *      allowance exists. Frontend should detect permit support via nonces() probe.
     *
     * @param sharesToMint Raw wei amount of shares to mint (e.g. 1e18 = 1 share)
     * @param lootToMint Raw wei amount of loot to mint (e.g. 1e18 = 1 loot)
     * @param proof Merkle proof for allowlist (empty if no allowlist)
     * @param deadline Permit signature deadline (block.timestamp must be <= deadline)
     * @param v ECDSA signature v component
     * @param r ECDSA signature r component
     * @param s ECDSA signature s component
     */
    function onboardWithPermit(
        uint256 sharesToMint,
        uint256 lootToMint,
        bytes32[] calldata proof,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        uint256 tributeAmount = _calculateTribute(sharesToMint, lootToMint);

        // try/catch: if permit was already consumed (retry/front-run) or token
        // doesn't support ERC-2612, fall through to safeTransferFrom which will
        // use whatever allowance currently exists.
        try IERC20Permit(address(tributeToken)).permit(
            msg.sender,
            address(this),
            tributeAmount,
            deadline,
            v, r, s
        ) {} catch {} // solhint-disable-line no-empty-blocks

        _onboard(sharesToMint, lootToMint, proof);
    }

    /**
     * @notice Pause onboarding
     * @dev Requires GOVERNOR navigator permission (navigators[msg.sender] & 4 != 0)
     *      OR the DAO avatar. Symmetric with unpause to prevent unilateral griefing.
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
     * @notice Recover ERC20 tokens accidentally sent to this contract
     * @dev Only callable by the DAO avatar (governance). Tribute tokens are sent directly
     *      to the vault via safeTransferFrom — they should never accumulate here. This is
     *      a safety valve for tokens sent to the navigator address by mistake.
     * @param token ERC20 token address to recover
     * @param to Recipient of the recovered tokens
     * @param amount Amount to recover
     */
    function withdrawStuckTokens(IERC20 token, address to, uint256 amount) external {
        if (msg.sender != daoShip.avatar()) revert NotAuthorized();
        SafeERC20.safeTransfer(token, to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Calculate the total tribute cost for a given share and loot mint
     * @dev Each component is checked individually to prevent truncation exploits
     *      where a dust share request truncates to 0 tribute while piggybacking on loot
     * @param sharesToMint Raw wei amount of shares
     * @param lootToMint Raw wei amount of loot
     * @return tributeAmount Total tribute in tribute token decimals
     */
    function _calculateTribute(uint256 sharesToMint, uint256 lootToMint) internal view returns (uint256 tributeAmount) {
        if (sharesToMint > 0) {
            if (pricePerShare == 0) revert InvalidConfig();
            uint256 shareTribute = (sharesToMint * pricePerShare) / 1e18;
            if (shareTribute == 0) revert InsufficientAmount();
            tributeAmount += shareTribute;
        }
        if (lootToMint > 0) {
            if (pricePerLoot == 0) revert InvalidConfig();
            uint256 lootTribute = (lootToMint * pricePerLoot) / 1e18;
            if (lootTribute == 0) revert InsufficientAmount();
            tributeAmount += lootTribute;
        }
    }

    /**
     * @notice Internal onboard logic shared by onboard() and onboardWithPermit()
     * @dev nonReentrant is on the external entry points, not here.
     *      Follows checks-effects-interactions: state is updated before external calls.
     * @param sharesToMint Raw wei amount of shares to mint
     * @param lootToMint Raw wei amount of loot to mint
     * @param proof Merkle proof for allowlist
     */
    function _onboard(uint256 sharesToMint, uint256 lootToMint, bytes32[] memory proof) internal {
        if (paused) revert IsPaused();
        if (expiry != 0 && block.timestamp > expiry) revert Expired();
        if (sharesToMint == 0 && lootToMint == 0) revert InsufficientAmount();

        // Allowlist check
        if (allowlistRoot != bytes32(0)) {
            if (!MerkleProof.verify(proof, allowlistRoot, keccak256(abi.encodePacked(msg.sender)))) {
                revert NotAllowlisted();
            }
        }

        // Calculate tribute cost
        uint256 tributeAmount = _calculateTribute(sharesToMint, lootToMint);

        // Mint cap checks (cap is also in raw wei)
        uint256 toMint = sharesToMint + lootToMint;
        if (mintCap > 0 && totalMinted + toMint > mintCap) revert MintCapExceeded();
        if (perAddressCap > 0 && mintedTo[msg.sender] + toMint > perAddressCap) revert PerAddressCapExceeded();
        totalMinted += toMint;
        mintedTo[msg.sender] += toMint;

        // Transfer tribute directly to DAO treasury (avatar/vault)
        // Verify actual received amount to reject fee-on-transfer tokens
        address vault = daoShip.avatar();
        uint256 balanceBefore = tributeToken.balanceOf(vault);
        tributeToken.safeTransferFrom(msg.sender, vault, tributeAmount);
        uint256 actualReceived = tributeToken.balanceOf(vault) - balanceBefore;
        if (actualReceived < tributeAmount) revert InsufficientAmount();

        // Mint shares and loot (params are already raw wei amounts)
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

        emit Onboard(address(daoShip), msg.sender, tributeAmount, sharesToMint, lootToMint);
    }
}
