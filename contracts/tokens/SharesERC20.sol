// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "./DAOShipVotes.sol";
import "../interfaces/IDAOShipToken.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SharesERC20
 * @notice Voting token for DAOShip DAOs with delegation and pause functionality
 * @dev Extends DAOShipVotes for timestamp-based voting power tracking
 *      Owned by DAOShip contract - only owner or authorized navigators can mint/burn/pause
 *
 * Key Features:
 * - ERC20Votes: Delegation and historical voting power queries
 * - ERC20Permit (EIP-2612): Gasless approvals via signatures
 * - Pausable: Admin navigators can pause transfers
 * - Auto-delegation: First mint auto-delegates to self for convenience
 * - Owner-controlled: Only DAOShip contract (owner) can mint/burn
 *
 * EIP-2612 Note:
 *   OZ's ERC20Permit uses EIP712 with immutable name storage, which breaks on
 *   EIP-1167 clones (immutables are baked into the singleton's bytecode, not the
 *   clone's storage). This contract implements IERC20Permit + Nonces directly with
 *   a clone-safe EIP-712 domain that reads from _customName storage.
 */
contract SharesERC20 is DAOShipVotes, ERC20Pausable, Ownable, Nonces, IDAOShipToken, IERC20Permit {
    /// @dev Custom name/symbol storage for EIP-1167 clones (OZ ERC20._name/_symbol are private)
    string private _customName;
    string private _customSymbol;

    // EIP-712 constants for clone-safe Permit implementation
    bytes32 private constant _TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant _HASHED_VERSION = keccak256(bytes("1"));

    /// @notice Maximum mintable supply — aligned with uint216 checkpoint packing.
    ///         Also ensures shares + loot totalSupply in DAOShip cannot overflow uint256.
    uint256 public constant MINT_CAP = type(uint216).max;

    error ERC2612ExpiredSignature(uint256 deadline);
    error ERC2612InvalidSigner(address signer, address owner);
    error MintCapExceeded();

    /**
     * @notice Constructor for singleton deployment
     * @dev Sets deployer as initial owner
     *      For EIP-1167 clones, storage is empty so owner() returns address(0)
     *      Clones must call initialize() to set owner and token metadata
     */
    constructor() ERC20("DAOShip Shares", "SHARES") Ownable(msg.sender) {}

    /**
     * @notice Initialize token clone with owner and metadata
     * @dev Only works for clones (where owner is address(0) due to empty storage)
     *      Sets custom name/symbol since OZ ERC20 constructor only runs on singleton
     * @param _initialOwner Address to set as owner (DAOShip contract)
     * @param tokenName Custom token name for this clone
     * @param tokenSymbol Custom token symbol for this clone
     */
    function initialize(address _initialOwner, string calldata tokenName, string calldata tokenSymbol) external {
        require(owner() == address(0), "SharesERC20: already initialized");
        _transferOwnership(_initialOwner);
        _customName = tokenName;
        _customSymbol = tokenSymbol;
    }

    /**
     * @notice Mint new shares to an address
     * @dev Only callable by owner (DAOShip contract or authorized navigator)
     *      Auto-delegates to self on first mint for convenience
     * @param to Address to receive shares
     * @param amount Amount of shares to mint
     */
    function mint(address to, uint256 amount) external override onlyOwner {
        if (totalSupply() + amount > MINT_CAP) revert MintCapExceeded();
        _mint(to, amount);
    }

    /**
     * @notice Burn shares from an address
     * @dev Only callable by owner (DAOShip contract or authorized navigator)
     * @param from Address to burn shares from
     * @param amount Amount of shares to burn
     */
    function burn(address from, uint256 amount) external override onlyOwner {
        _burn(from, amount);
    }

    /**
     * @notice Pause all token transfers
     * @dev Only callable by owner (DAOShip contract or admin navigator)
     *      Minting and burning still work when paused
     */
    function pause() external override onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause token transfers
     * @dev Only callable by owner (DAOShip contract or admin navigator)
     */
    function unpause() external override onlyOwner {
        _unpause();
    }

    /**
     * @notice Check if token is paused
     * @return True if paused, false otherwise
     */
    function paused() public view override(Pausable, IDAOShipToken) returns (bool) {
        return super.paused();
    }

    /**
     * @notice Get token name
     * @return Token name string
     */
    function name() public view override(ERC20, IDAOShipToken) returns (string memory) {
        return bytes(_customName).length > 0 ? _customName : super.name();
    }

    /**
     * @notice Get token symbol
     * @return Token symbol string
     */
    function symbol() public view override(ERC20, IDAOShipToken) returns (string memory) {
        return bytes(_customSymbol).length > 0 ? _customSymbol : super.symbol();
    }

    /**
     * @notice Get token decimals
     * @return Number of decimals (18)
     */
    function decimals() public pure override(ERC20, IDAOShipToken) returns (uint8) {
        return 18;
    }

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
     *      singleton bytecode). Clones need to read from _customName storage instead.
     *      Recomputed on every call — no caching, since the cache would belong to the
     *      singleton. On Quai's low-fee network, the extra ~2K gas is negligible.
     */
    function _domainSeparatorV4() internal view returns (bytes32) {
        return keccak256(
            abi.encode(_TYPE_HASH, keccak256(bytes(name())), _HASHED_VERSION, block.chainid, address(this))
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL OVERRIDES
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Override _update to include pausable and voting power tracking
     * @dev Called on mint, burn, and transfer
     */
    function _update(address from, address to, uint256 value)
        internal
        override(DAOShipVotes, ERC20Pausable)
    {
        // Check pause status (doesn't apply to mint/burn)
        if (from != address(0) && to != address(0)) {
            require(!paused(), "ERC20Pausable: token transfer while paused");
        }

        // Call DAOShipVotes._update which handles voting power
        DAOShipVotes._update(from, to, value);
    }
}
