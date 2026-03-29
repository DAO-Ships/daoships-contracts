// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IDAOShipToken
 * @notice Interface for DAOShip-compatible tokens (Shares and Loot)
 * @dev Tokens are owned by the DAOShip contract and can only be minted/burned by:
 *      - The DAOShip contract itself (via passed proposals)
 *      - Authorized navigators with MANAGER permission
 *
 * Tokens can be paused by navigators with ADMIN permission, preventing transfers.
 */
interface IDAOShipToken is IERC20 {
    /**
     * @notice Mint tokens to an address
     * @dev Only callable by the token owner (DAOShip contract or authorized navigator)
     * @param to Address to mint tokens to
     * @param amount Amount of tokens to mint
     */
    function mint(address to, uint256 amount) external;

    /**
     * @notice Burn tokens from an address
     * @dev Only callable by the token owner (DAOShip contract or authorized navigator)
     * @param from Address to burn tokens from
     * @param amount Amount of tokens to burn
     */
    function burn(address from, uint256 amount) external;

    /**
     * @notice Pause token transfers
     * @dev Only callable by the token owner (DAOShip contract or admin navigator)
     *      When paused, all transfers are blocked except minting/burning
     */
    function pause() external;

    /**
     * @notice Unpause token transfers
     * @dev Only callable by the token owner (DAOShip contract or admin navigator)
     */
    function unpause() external;

    /**
     * @notice Check if token transfers are paused
     * @return True if transfers are paused, false otherwise
     */
    function paused() external view returns (bool);

    /**
     * @notice Get the token name
     * @return Token name string
     */
    function name() external view returns (string memory);

    /**
     * @notice Get the token symbol
     * @return Token symbol string
     */
    function symbol() external view returns (string memory);

    /**
     * @notice Get the number of decimals
     * @return Number of decimals (typically 18)
     */
    function decimals() external view returns (uint8);
}

/**
 * @title IDAOShipVotingToken
 * @notice Extended interface for DAOShip voting tokens (SharesERC20)
 * @dev Includes delegation and historical voting power functions.
 *      Only SharesERC20 implements this; LootERC20 uses IDAOShipToken only.
 */
interface IDAOShipVotingToken is IDAOShipToken {
    /**
     * @notice Get historical voting power at a specific timestamp
     * @param account Address to query
     * @param timepoint Timestamp to query (must be in past)
     * @return Voting power at the given timestamp
     */
    function getPriorVotes(address account, uint256 timepoint) external view returns (uint256);

    /**
     * @notice Get current voting power (delegated)
     * @param account Address to query
     * @return Current voting power
     */
    function getCurrentVotes(address account) external view returns (uint256);

    /**
     * @notice Get the delegate for an account
     * @param account Address to query
     * @return Delegate address
     */
    function delegates(address account) external view returns (address);

    /**
     * @notice Delegate voting power to another address
     * @param delegatee Address to delegate to
     */
    function delegate(address delegatee) external;
}
