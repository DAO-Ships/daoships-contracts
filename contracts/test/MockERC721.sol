// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title MockERC721
 * @notice Minimal mintable/burnable ERC-721 for navigator unit tests.
 */
contract MockERC721 is ERC721 {
    constructor() ERC721("Mock NFT", "MNFT") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function burn(uint256 tokenId) external {
        _burn(tokenId);
    }
}
