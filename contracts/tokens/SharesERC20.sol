// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "./BaalVotes.sol";
import "../interfaces/IBaalToken.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SharesERC20
 * @notice Voting token for Baal DAOs with delegation and pause functionality
 * @dev Extends BaalVotes for timestamp-based voting power tracking
 *      Owned by Baal contract - only owner or authorized shamans can mint/burn/pause
 *
 * Key Features:
 * - ERC20Votes: Delegation and historical voting power queries
 * - Pausable: Admin shamans can pause transfers
 * - Auto-delegation: First mint auto-delegates to self for convenience
 * - Owner-controlled: Only Baal contract (owner) can mint/burn
 */
contract SharesERC20 is BaalVotes, ERC20Pausable, Ownable, IBaalToken {
    /**
     * @notice Constructor
     * @dev Token starts with zero supply
     *      Name and symbol are set by the Baal contract after deployment
     */
    constructor() ERC20("Baal Shares", "SHARES") Ownable(msg.sender) {}

    /**
     * @notice Initialize token with custom name and symbol
     * @dev Called by Baal contract after clone deployment
     * @param _name Token name (e.g., "MyDAO Shares")
     * @param _symbol Token symbol (e.g., "MYDAO")
     */
    function initialize(string memory _name, string memory _symbol) external onlyOwner {
        // Note: OpenZeppelin ERC20 doesn't support post-deployment name change
        // This function is kept for interface compatibility
        // Name/symbol must be set via constructor or separate implementation
    }

    /**
     * @notice Mint new shares to an address
     * @dev Only callable by owner (Baal contract or authorized shaman)
     *      Auto-delegates to self on first mint for convenience
     * @param to Address to receive shares
     * @param amount Amount of shares to mint
     */
    function mint(address to, uint256 amount) external override onlyOwner {
        // Auto-delegate to self on first mint if no delegation exists
        if (balanceOf(to) == 0 && delegates(to) == address(0)) {
            _delegate(to, to);
        }

        _mint(to, amount);
    }

    /**
     * @notice Burn shares from an address
     * @dev Only callable by owner (Baal contract or authorized shaman)
     * @param from Address to burn shares from
     * @param amount Amount of shares to burn
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
        return super.name();
    }

    /**
     * @notice Get token symbol
     * @return Token symbol string
     */
    function symbol() public view override(ERC20, IBaalToken) returns (string memory) {
        return super.symbol();
    }

    /**
     * @notice Get token decimals
     * @return Number of decimals (18)
     */
    function decimals() public pure override(ERC20, IBaalToken) returns (uint8) {
        return 18;
    }

    /**
     * @notice Override _update to include pausable and voting power tracking
     * @dev Called on mint, burn, and transfer
     */
    function _update(address from, address to, uint256 value)
        internal
        override(BaalVotes, ERC20Pausable)
    {
        // Check pause status (doesn't apply to mint/burn)
        if (from != address(0) && to != address(0)) {
            require(!paused(), "ERC20Pausable: token transfer while paused");
        }

        // Call BaalVotes._update which handles voting power
        BaalVotes._update(from, to, value);
    }
}
