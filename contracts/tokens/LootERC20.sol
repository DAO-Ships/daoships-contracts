// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "../interfaces/IBaalToken.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title LootERC20
 * @notice Non-voting economic token for Baal DAOs
 * @dev Basic ERC20 with pause functionality, no voting/delegation
 *      Owned by Baal contract - only owner or authorized shamans can mint/burn/pause
 *
 * Key Features:
 * - ERC20: Standard fungible token
 * - Pausable: Admin shamans can pause transfers
 * - No voting: Loot does not have voting power (no delegation)
 * - Owner-controlled: Only Baal contract (owner) can mint/burn
 * - Ragequittable: Can be burned to withdraw proportional treasury assets
 */
contract LootERC20 is ERC20, ERC20Pausable, Ownable, IBaalToken {
    /// @dev Custom name/symbol storage for EIP-1167 clones (OZ ERC20._name/_symbol are private)
    string private _customName;
    string private _customSymbol;

    /**
     * @notice Constructor for singleton deployment
     * @dev Sets deployer as initial owner
     *      For EIP-1167 clones, storage is empty so owner() returns address(0)
     *      Clones must call initialize() to set owner and token metadata
     */
    constructor() ERC20("Baal Loot", "LOOT") Ownable(msg.sender) {}

    /**
     * @notice Initialize token clone with owner and metadata
     * @dev Only works for clones (where owner is address(0) due to empty storage)
     *      Sets custom name/symbol since OZ ERC20 constructor only runs on singleton
     * @param _initialOwner Address to set as owner (Baal contract)
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
     * @dev Only callable by owner (Baal contract or authorized shaman)
     * @param to Address to receive loot
     * @param amount Amount of loot to mint
     */
    function mint(address to, uint256 amount) external override onlyOwner {
        _mint(to, amount);
    }

    /**
     * @notice Burn loot from an address
     * @dev Only callable by owner (Baal contract or authorized shaman)
     * @param from Address to burn loot from
     * @param amount Amount of loot to burn
     */
    function burn(address from, uint256 amount) external override onlyOwner {
        _burn(from, amount);
    }

    /**
     * @notice Pause all token transfers
     * @dev Only callable by owner (Baal contract or admin shaman)
     *      Minting and burning still work when paused
     */
    function pause() external override onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause token transfers
     * @dev Only callable by owner (Baal contract or admin shaman)
     */
    function unpause() external override onlyOwner {
        _unpause();
    }

    /**
     * @notice Check if token is paused
     * @return True if paused, false otherwise
     */
    function paused() public view override(Pausable, IBaalToken) returns (bool) {
        return super.paused();
    }

    /**
     * @notice Get token name
     * @return Token name string
     */
    function name() public view override(ERC20, IBaalToken) returns (string memory) {
        return bytes(_customName).length > 0 ? _customName : super.name();
    }

    /**
     * @notice Get token symbol
     * @return Token symbol string
     */
    function symbol() public view override(ERC20, IBaalToken) returns (string memory) {
        return bytes(_customSymbol).length > 0 ? _customSymbol : super.symbol();
    }

    /**
     * @notice Get token decimals
     * @return Number of decimals (18)
     */
    function decimals() public pure override(ERC20, IBaalToken) returns (uint8) {
        return 18;
    }

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
