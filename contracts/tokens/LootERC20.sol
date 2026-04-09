// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "./DAOShipPermit.sol";
import "../interfaces/IDAOShipToken.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title LootERC20
 * @notice Non-voting economic token for DAOShip DAOs
 * @dev Basic ERC20 with pause functionality and EIP-2612 Permit, no voting/delegation
 *      Owned by DAOShip contract - only owner or authorized navigators can mint/burn/pause
 *
 * Key Features:
 * - ERC20: Standard fungible token
 * - ERC20Permit (EIP-2612): Gasless approvals via signatures (via DAOShipPermit)
 * - Pausable: Admin navigators can pause transfers
 * - No voting: Loot does not have voting power (no delegation)
 * - Owner-controlled: Only DAOShip contract (owner) can mint/burn
 * - Ragequittable: Can be burned to withdraw proportional treasury assets
 * - Mint cap: totalSupply capped at type(uint256).max / 2 to prevent overflow
 *   when shares + loot are summed in DAOShip.totalSupply()
 */
contract LootERC20 is ERC20Pausable, Ownable, DAOShipPermit, IDAOShipToken {
    /// @dev Custom name/symbol storage for EIP-1167 clones (OZ ERC20._name/_symbol are private)
    string private _customName;
    string private _customSymbol;

    /// @notice Maximum mintable supply — type(uint256).max / 2 ensures shares + loot
    ///         totalSupply in DAOShip cannot overflow uint256.
    ///         Higher than SharesERC20's MINT_CAP (uint216.max) because loot has no voting
    ///         power and therefore no checkpoint packing constraint (uint40 + uint216 = 256 bits).
    uint256 public constant MINT_CAP = type(uint256).max / 2;

    error MintCapExceeded();

    /**
     * @notice Constructor for singleton deployment
     * @dev Sets deployer as initial owner
     *      For EIP-1167 clones, storage is empty so owner() returns address(0)
     *      Clones must call initialize() to set owner and token metadata
     */
    constructor() ERC20("DAOShip Loot", "LOOT") Ownable(msg.sender) {
        // Brick the singleton: renounce ownership so the implementation contract
        // cannot be used directly. EIP-1167 clones have zeroed storage (owner == address(0)),
        // so initialize() remains callable on clones.
        renounceOwnership();
    }

    /**
     * @notice Initialize token clone with owner and metadata
     * @dev Only works for clones (where owner is address(0) due to empty storage)
     *      Sets custom name/symbol since OZ ERC20 constructor only runs on singleton
     * @param _initialOwner Address to set as owner (DAOShip contract)
     * @param tokenName Custom token name for this clone
     * @param tokenSymbol Custom token symbol for this clone
     */
    function initialize(address _initialOwner, string calldata tokenName, string calldata tokenSymbol) external {
        require(owner() == address(0), "LootERC20: already initialized");
        _transferOwnership(_initialOwner);
        _customName = tokenName;
        _customSymbol = tokenSymbol;
    }

    /**
     * @notice Mint new loot to an address
     * @dev Only callable by owner (DAOShip contract or authorized navigator)
     * @param to Address to receive loot
     * @param amount Amount of loot to mint
     */
    function mint(address to, uint256 amount) external override onlyOwner {
        if (totalSupply() + amount > MINT_CAP) revert MintCapExceeded();
        _mint(to, amount);
    }

    /**
     * @notice Burn loot from an address
     * @dev Only callable by owner (DAOShip contract or authorized navigator)
     * @param from Address to burn loot from
     * @param amount Amount of loot to burn
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
    // INTERNAL OVERRIDES
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Override _update to include pausable check
     * @dev Called on mint, burn, and transfer
     */
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Pausable)
    {
        // Check pause status (doesn't apply to mint/burn)
        if (from != address(0) && to != address(0)) {
            require(!paused(), "ERC20Pausable: token transfer while paused");
        }

        super._update(from, to, value);
    }
}
