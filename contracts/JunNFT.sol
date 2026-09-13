// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;
import {
    ERC721EnumerableUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract JunNFT is
    ERC721EnumerableUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    uint256 private _lastTokenId; // 默认 0
    uint256 private _maxSupply;

    function initialize(uint256 maxSupply_) external initializer {
        __ERC721_init("JunNFT", "JNFT");
        __ERC721Enumerable_init();
        __Ownable_init();
        __UUPSUpgradeable_init();
        _maxSupply = maxSupply_;
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    /**
     * 铸造NFT
     */
    function mint(address to) external onlyOwner {
        require(totalSupply() < _maxSupply, "Max supply reached");

        uint256 tokenId = ++_lastTokenId;
        _safeMint(to, tokenId);
    }

    /**
     * 销毁NFT
     */
    function burn(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        _burn(tokenId);
    }

    /**
     * @dev Reserved storage space to allow for layout changes in the future.
     */
    uint256[48] private __gap;
}
