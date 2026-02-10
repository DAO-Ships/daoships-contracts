// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IBaalToken
 * @notice Interface for Baal-compatible tokens (Shares and Loot)
 * @dev Tokens are owned by the Baal contract and can only be minted/burned by:
 *      - The Baal contract itself (via passed proposals)
 *      - Authorized shamans with MANAGER permission
 *
 * Tokens can be paused by shamans with ADMIN permission, preventing transfers.
 */
interface IBaalToken is IERC20 {
    /**
     * @notice Mint tokens to an address
     * @dev Only callable by the token owner (Baal contract or authorized shaman)
     * @param to Address to mint tokens to
     * @param amount Amount of tokens to mint
     */
    function mint(address to, uint256 amount) external;

    /**
     * @notice Burn tokens from an address
     * @dev Only callable by the token owner (Baal contract or authorized shaman)
     * @param from Address to burn tokens from
     * @param amount Amount of tokens to burn
     */
    function burn(address from, uint256 amount) external;

    /**
     * @notice Pause token transfers
     * @dev Only callable by the token owner (Baal contract or admin shaman)
     *      When paused, all transfers are blocked except minting/burning
     */
    function pause() external;

    /**
     * @notice Unpause token transfers
     * @dev Only callable by the token owner (Baal contract or admin shaman)
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
