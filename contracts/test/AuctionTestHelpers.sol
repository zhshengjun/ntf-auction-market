// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Auction} from "../Auction.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

// 这些合约只是 Hardhat TypeScript 测试使用的链上 Mock / 恶意合约。

/// @dev 用于 UUPS 升级测试的新实现。
contract HardhatAuctionTestV2 is Auction {
    uint256 public marker;

    function version() external pure returns (uint256) {
        return 2;
    }

    function initializeV2(uint256 value) external reinitializer(2) onlyOwner {
        marker = value;
    }
}

/// @dev 默认 6 位精度的测试 ERC20。
///      setDecimals 只用于测试“同一个 Token 的 decimals 异常变化”场景。
contract HardhatTestUSDC is ERC20 {
    uint8 private _testDecimals = 6;

    constructor() ERC20("Test USD", "tUSD") {}

    function decimals() public view override returns (uint8) {
        return _testDecimals;
    }

    function setDecimals(uint8 value) external {
        _testDecimals = value;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev 带转账税的 ERC20，用于测试 fee-on-transfer token。
contract HardhatFeeOnTransferToken is ERC20 {
    uint256 public fee;

    constructor() ERC20("Fee USD", "fUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFee(uint256 value) external {
        fee = value;
    }

    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override {
        if (fee != 0 && from != address(0) && to != address(0)) {
            super._update(from, address(0), fee);
            amount -= fee;
        }

        super._update(from, to, amount);
    }
}

/// @dev 极简价格预言机 Mock。
contract HardhatAuctionFeed {
    uint8 public decimals = 8;
    int256 public answer = 1e8;
    uint256 public updatedAt;

    constructor() {
        updatedAt = block.timestamp;
    }

    function set(int256 value, uint256 timestamp) external {
        answer = value;
        updatedAt = timestamp;
    }

    function setDecimals(uint8 value) external {
        decimals = value;
    }

    function latestRoundData()
    external
    view
    returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @dev 恶意 ERC20：Auction 在 transferFrom() 拉币时，尝试重入 settleAuction()。
contract HardhatReentrantToken is HardhatFeeOnTransferToken {
    Auction public auction;
    uint256 public auctionId;
    bytes public failure;

    constructor(Auction target, uint256 id) {
        auction = target;
        auctionId = id;
    }

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) public override returns (bool) {
        (bool success, bytes memory result) = address(auction).call(
            abi.encodeCall(Auction.settleAuction, (auctionId))
        );

        require(!success, "Reentry succeeded");
        failure = result;

        return super.transferFrom(from, to, value);
    }
}

/// @dev 收到 ETH 时，立刻尝试重入 Auction.placeBid()。
contract HardhatReentrantRecipient {
    Auction public auction;
    uint256 public auctionId;
    bytes public failure;

    constructor(Auction target, uint256 id) {
        auction = target;
        auctionId = id;
    }

    receive() external payable {
        (bool success, bytes memory result) = address(auction).call{value: 1}(
            abi.encodeCall(Auction.placeBid, (auctionId, address(0), 1))
        );

        require(!success, "Reentry succeeded");
        failure = result;
    }
}

/// @dev 故意不实现 receive/fallback，用于测试 ETH 转账失败时账本不能丢失。
contract HardhatRejectEther {}

/// @dev 作为卖家参与拍卖，但不实现 receive/fallback。
/// 用来证明 settleAuction 不会主动向卖家转 ETH，而是记入 proceeds 后再提现。
contract HardhatRejectEtherSeller {
    function createAuction(
        Auction auction,
        address nft,
        uint256 tokenId,
        uint256 reserve,
        uint256 duration
    ) external returns (uint256) {
        IERC721(nft).approve(address(auction), tokenId);
        return auction.createAuction(nft, tokenId, reserve, duration);
    }

    function withdrawProceeds(
        Auction auction,
        address token,
        address recipient
    ) external {
        auction.withdrawProceeds(token, recipient);
    }
}

// 测试专用 ERC20：允许测试动态修改 decimals。
// 用来替代 Foundry 的 vm.mockCall(token.decimals())。
contract HardhatMutableDecimalsTestToken is ERC20 {
    uint8 private _tokenDecimals = 6;

    constructor()
    ERC20("Mutable Decimals Token", "MDT")
    {}

    function decimals()
    public
    view
    override
    returns (uint8)
    {
        return _tokenDecimals;
    }

    function setDecimals(
        uint8 value
    ) external {
        _tokenDecimals = value;
    }
}
