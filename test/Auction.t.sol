// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Test} from "forge-std/Test.sol";
import {Auction} from "../contracts/Auction.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {
    ERC721Holder
} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {
    ERC1967Proxy
} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract AuctionTestV2 is Auction {
    uint256 public marker;
    function version() external pure returns (uint256) {
        return 2;
    }
    function initializeV2(uint256 value) external reinitializer(2) onlyOwner {
        marker = value;
    }
}

contract AuctionTestNFT is ERC721 {
    constructor() ERC721("Test NFT", "NFT") {}
    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract AuctionTestToken is ERC20 {
    uint256 public fee;
    constructor() ERC20("USD", "USD") {}
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

contract AuctionTestFeed {
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

contract AuctionReentrantToken is AuctionTestToken {
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

contract AuctionReentrantRecipient {
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

// 不实现 receive：测试合约作为卖家拒收 ETH，结算仍须成功。
contract AuctionTest is Test, ERC721Holder {
    Auction auction;
    AuctionTestNFT nft;
    AuctionTestToken token;
    AuctionTestFeed feed;
    address bidder = address(0xB1);
    address other = address(0xB2);
    uint256 id;

    event AuctionSettled(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed winner,
        address token,
        uint256 amount,
        uint256 valueUsd
    );

    function setUp() public {
        vm.warp(100_000);
        auction = Auction(
            address(
                new ERC1967Proxy(
                    address(new Auction()),
                    abi.encodeCall(Auction.initialize, (address(this)))
                )
            )
        );
        nft = new AuctionTestNFT();
        token = new AuctionTestToken();
        feed = new AuctionTestFeed();
        auction.configureToken(address(0), address(feed), 1 hours);
        auction.configureToken(address(token), address(feed), 1 hours);
        id = _create(1, 0, 1 hours);
        vm.deal(bidder, 100 ether);
        vm.deal(other, 100 ether);
        token.mint(bidder, 100e6);
        token.mint(other, 100e6);
        vm.prank(bidder);
        token.approve(address(auction), type(uint256).max);
        vm.prank(other);
        token.approve(address(auction), type(uint256).max);
    }

    function _create(
        uint256 tokenId,
        uint256 reserve,
        uint256 duration
    ) internal returns (uint256) {
        nft.mint(address(this), tokenId);
        nft.approve(address(auction), tokenId);
        return auction.createAuction(address(nft), tokenId, reserve, duration);
    }

    function _bid(address who, uint256 amount) internal {
        vm.prank(who);
        auction.placeBid{value: amount}(id, address(0), amount);
    }

    function _end() internal {
        vm.warp(auction.getAuction(id).endTime);
    }

    function test_CreationAndQueries() public view {
        Auction.AuctionItem memory item = auction.getAuction(id);
        assertEq(id, 1);
        assertEq(auction.auctionCount(), 1);
        assertEq(item.seller, address(this));
        assertEq(item.tokenId, 1);
        assertEq(uint256(item.status), uint256(Auction.Status.Active));
        assertEq(nft.ownerOf(1), address(auction));
        assertEq(auction.getBid(id, bidder).amount, 0);
    }

    function test_CreationRejectsInvalidInputsAndMissingApproval() public {
        nft.mint(address(this), 2);
        vm.expectRevert(Auction.InvalidDuration.selector);
        auction.createAuction(address(nft), 2, 0, 0);
        vm.expectRevert(Auction.InvalidDuration.selector);
        auction.createAuction(address(nft), 2, 0, 30 days + 1);
        vm.expectRevert(Auction.InvalidNFT.selector);
        auction.createAuction(bidder, 2, 0, 1 hours);
        vm.prank(bidder);
        vm.expectRevert(Auction.Unauthorized.selector);
        auction.createAuction(address(nft), 2, 0, 1 hours);
        vm.expectRevert();
        auction.createAuction(address(nft), 2, 0, 1 hours);
        assertEq(auction.auctionCount(), 1);
        assertEq(nft.ownerOf(2), address(this));
    }

    function test_UnsolicitedSafeNFTTransferRejected() public {
        nft.mint(address(this), 2);
        vm.expectRevert(Auction.UnexpectedNFT.selector);
        nft.safeTransferFrom(address(this), address(auction), 2);
        assertEq(nft.ownerOf(2), address(this));
        vm.expectRevert(Auction.UnexpectedNFT.selector);
        auction.onERC721Received(address(auction), address(this), 1, "");
    }

    function test_FirstBidCanEqualReserveButSubsequentBidMustExceed() public {
        id = _create(2, 1e18, 1 hours);
        vm.prank(bidder);
        vm.expectRevert(
            abi.encodeWithSelector(Auction.BidTooLow.selector, 0.5e18, 1e18)
        );
        auction.placeBid{value: 0.5 ether}(id, address(0), 0.5 ether);
        _bid(bidder, 1 ether);
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(Auction.BidTooLow.selector, 1e18, 1e18)
        );
        auction.placeBid{value: 1 ether}(id, address(0), 1 ether);
        _bid(bidder, 1 ether);
        assertEq(auction.getBid(id, bidder).amount, 2 ether);
        assertEq(auction.getAuction(id).highestBidUsd, 2e18);
    }

    function test_ETHSettlementDoesNotCallEitherParty() public {
        _bid(bidder, 1 ether);
        _end();
        vm.expectEmit(true, true, true, true, address(auction));
        emit AuctionSettled(
            id,
            address(this),
            bidder,
            address(0),
            1 ether,
            1e18
        );
        vm.prank(other);
        auction.settleAuction(id);
        assertEq(nft.ownerOf(1), address(auction));
        assertEq(auction.proceeds(address(this), address(0)), 1 ether);
        assertEq(auction.getBid(id, bidder).amount, 0);
        assertEq(auction.totalLiabilities(address(0)), 1 ether);
        auction.withdrawProceeds(address(0), other);
        assertEq(other.balance, 101 ether);
        vm.prank(bidder);
        auction.claimNFT(id, bidder);
        assertEq(nft.ownerOf(1), bidder);
        assertTrue(auction.getAuction(id).nftClaimed);
        assertEq(auction.totalLiabilities(address(0)), 0);
    }

    function test_ERC20WinnerAndMixedCurrencyRefund() public {
        _bid(bidder, 1 ether);
        vm.prank(other);
        auction.placeBid(id, address(token), 2e6);
        _end();
        auction.settleAuction(id);
        vm.prank(bidder);
        auction.withdrawBid(id, bidder);
        auction.withdrawProceeds(address(token), other);
        vm.prank(other);
        auction.claimNFT(id, bidder);
        assertEq(bidder.balance, 100 ether);
        assertEq(token.balanceOf(other), 100e6);
        assertEq(nft.ownerOf(1), bidder);
        assertEq(auction.totalLiabilities(address(token)), 0);
        assertEq(address(auction).balance, 0);
    }

    function test_UnsoldAndCancelledNFTClaims() public {
        auction.cancelAuction(id);
        assertEq(
            uint256(auction.getAuction(id).status),
            uint256(Auction.Status.Cancelled)
        );
        auction.claimNFT(id, bidder);
        assertEq(nft.ownerOf(1), bidder);
        id = _create(2, 0, 1 hours);
        _end();
        vm.prank(other);
        auction.settleAuction(id);
        auction.claimNFT(id, other);
        assertEq(nft.ownerOf(2), other);
    }

    function test_CancellationRejectsNonSellerAndExistingBids() public {
        vm.prank(bidder);
        vm.expectRevert(Auction.Unauthorized.selector);
        auction.cancelAuction(id);
        _bid(bidder, 1 ether);
        vm.expectRevert(Auction.AuctionHasBids.selector);
        auction.cancelAuction(id);
    }

    function test_RefundCanUseDifferentRecipientAfterSettlement() public {
        _bid(bidder, 1 ether);
        _bid(other, 2 ether);
        _end();
        auction.settleAuction(id);
        vm.prank(bidder);
        auction.withdrawBid(id, other);
        assertEq(other.balance, 99 ether);
        assertEq(auction.totalLiabilities(address(0)), 2 ether);
        vm.prank(bidder);
        vm.expectRevert(Auction.NothingToWithdraw.selector);
        auction.withdrawBid(id, bidder);
    }

    function test_HighestBidLockedUntilSettledAndNeverRefundedAfterWin()
        public
    {
        _bid(bidder, 1 ether);
        _end();
        vm.prank(bidder);
        vm.expectRevert(Auction.HighestBidLocked.selector);
        auction.withdrawBid(id, bidder);
        auction.settleAuction(id);
        vm.prank(bidder);
        vm.expectRevert(Auction.NothingToWithdraw.selector);
        auction.withdrawBid(id, bidder);
    }

    function test_FailedWithdrawalPreservesCreditAndLiability() public {
        _bid(bidder, 1 ether);
        _end();
        auction.settleAuction(id);
        vm.expectRevert(Auction.ETHTransferFailed.selector);
        auction.withdrawProceeds(address(0), address(this));
        assertEq(auction.proceeds(address(this), address(0)), 1 ether);
        assertEq(auction.totalLiabilities(address(0)), 1 ether);
        auction.withdrawProceeds(address(0), bidder);
        vm.expectRevert(Auction.NothingToWithdraw.selector);
        auction.withdrawProceeds(address(0), bidder);
    }

    function test_FailedNFTClaimDoesNotBlockIndependentSettlement() public {
        _bid(bidder, 1 ether);
        _end();
        vm.prank(bidder);
        vm.expectRevert();
        auction.claimNFT(id, address(feed));
        assertEq(
            uint256(auction.getAuction(id).status),
            uint256(Auction.Status.Active)
        );
        auction.settleAuction(id);
        auction.withdrawProceeds(address(0), other);
        vm.prank(bidder);
        vm.expectRevert();
        auction.claimNFT(id, address(feed));
        assertFalse(auction.getAuction(id).nftClaimed);
        vm.prank(bidder);
        auction.claimNFT(id, bidder);
        vm.prank(bidder);
        vm.expectRevert(Auction.NFTAlreadyClaimed.selector);
        auction.claimNFT(id, bidder);
    }

    function test_OnlyClaimantCanChooseNFTRecipient() public {
        _bid(bidder, 1 ether);
        _end();
        vm.expectRevert(Auction.Unauthorized.selector);
        auction.claimNFT(id, other);
        vm.prank(bidder);
        vm.expectRevert(Auction.InvalidAddress.selector);
        auction.claimNFT(id, address(auction));
    }

    function test_PauseBlocksExposureButNotExit() public {
        _bid(bidder, 1 ether);
        _bid(other, 2 ether);
        auction.pause();
        vm.prank(bidder);
        vm.expectRevert(bytes("Pausable: paused"));
        auction.placeBid{value: 3 ether}(id, address(0), 3 ether);
        vm.expectRevert(bytes("Pausable: paused"));
        auction.createAuction(address(nft), 1, 0, 1 hours);
        vm.prank(bidder);
        auction.withdrawBid(id, bidder);
        _end();
        auction.settleAuction(id);
        vm.prank(other);
        auction.claimNFT(id, other);
        auction.withdrawProceeds(address(0), bidder);
        assertEq(auction.totalLiabilities(address(0)), 0);
        auction.unpause();
        assertFalse(auction.paused());
    }

    function test_TokenDisableDoesNotBlockExits() public {
        vm.prank(bidder);
        auction.placeBid(id, address(token), 1e6);
        auction.setTokenEnabled(address(token), false);
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                Auction.TokenDisabled.selector,
                address(token)
            )
        );
        auction.placeBid(id, address(token), 2e6);
        _end();
        auction.settleAuction(id);
        auction.withdrawProceeds(address(token), other);
        assertEq(token.balanceOf(other), 101e6);
    }

    function test_PriceChecksAndDecimalNormalization() public {
        feed.set(2000e8, block.timestamp);
        assertEq(auction.quoteUsd(address(0), 0.5 ether), 1000e18);
        assertEq(auction.quoteUsd(address(0), 1), 2000);
        assertEq(auction.quoteUsd(address(token), 1e6), 2000e18);
        feed.set(0, block.timestamp);
        vm.expectRevert(Auction.InvalidPrice.selector);
        auction.quoteUsd(address(0), 1 ether);
        feed.set(-1, block.timestamp);
        vm.expectRevert(Auction.InvalidPrice.selector);
        auction.quoteUsd(address(0), 1 ether);
        feed.set(1e8, 0);
        vm.expectRevert(Auction.InvalidPrice.selector);
        auction.quoteUsd(address(0), 1 ether);
        feed.set(1e8, block.timestamp + 1);
        vm.expectRevert(Auction.InvalidPrice.selector);
        auction.quoteUsd(address(0), 1 ether);
        feed.set(1e8, block.timestamp - 1 hours - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                Auction.StalePrice.selector,
                block.timestamp - 1 hours - 1
            )
        );
        auction.quoteUsd(address(0), 1 ether);
        feed.set(1e8, block.timestamp);
        feed.setDecimals(18);
        vm.expectRevert(Auction.InvalidPriceConfig.selector);
        auction.quoteUsd(address(0), 1 ether);
    }

    function test_BadOracleDoesNotAffectSettlementAndWithdrawals() public {
        _bid(bidder, 1 ether);
        feed.set(-1, 0);
        _end();
        auction.settleAuction(id);
        auction.withdrawProceeds(address(0), bidder);
        assertEq(bidder.balance, 100 ether);
    }

    function test_RejectsFeeOnTransferDepositsAndRollsBack() public {
        token.setFee(1);
        vm.prank(bidder);
        vm.expectRevert(Auction.UnexpectedTokenAmount.selector);
        auction.placeBid(id, address(token), 1e6);
        assertEq(token.balanceOf(bidder), 100e6);
        assertEq(auction.totalLiabilities(address(token)), 0);
        assertEq(auction.getAuction(id).highestBidder, address(0));
    }

    function test_RejectsOutgoingTransferTaxWithoutLosingCredit() public {
        vm.prank(bidder);
        auction.placeBid(id, address(token), 1e6);
        _end();
        auction.settleAuction(id);
        token.setFee(1);
        vm.expectRevert(Auction.UnexpectedTokenAmount.selector);
        auction.withdrawProceeds(address(token), other);
        assertEq(auction.proceeds(address(this), address(token)), 1e6);
        assertEq(auction.totalLiabilities(address(token)), 1e6);
        token.setFee(0);
        auction.withdrawProceeds(address(token), other);
    }

    function test_BidValidationAndTokenSwitchAfterRefund() public {
        vm.expectRevert(Auction.SellerCannotBid.selector);
        auction.placeBid(id, address(0), 0);
        vm.prank(bidder);
        vm.expectRevert(Auction.InvalidAmount.selector);
        auction.placeBid{value: 1 ether}(id, address(0), 2 ether);
        vm.prank(bidder);
        vm.expectRevert(Auction.InvalidAmount.selector);
        auction.placeBid{value: 1}(id, address(token), 1e6);
        vm.prank(bidder);
        vm.expectRevert(
            abi.encodeWithSelector(Auction.UnsupportedToken.selector, other)
        );
        auction.placeBid(id, other, 1);
        _bid(bidder, 1 ether);
        vm.prank(bidder);
        vm.expectRevert(Auction.BidTokenMismatch.selector);
        auction.placeBid(id, address(token), 2e6);
        _bid(other, 2 ether);
        vm.prank(bidder);
        auction.withdrawBid(id, bidder);
        vm.prank(bidder);
        auction.placeBid(id, address(token), 3e6);
        assertEq(auction.getBid(id, bidder).token, address(token));
    }

    function test_TimeBoundariesAndRepeatedSettlement() public {
        vm.expectRevert(
            abi.encodeWithSelector(Auction.AuctionNotEnded.selector, id)
        );
        auction.settleAuction(id);
        _end();
        vm.prank(bidder);
        vm.expectRevert(
            abi.encodeWithSelector(Auction.AuctionEnded.selector, id)
        );
        auction.placeBid{value: 1 ether}(id, address(0), 1 ether);
        auction.settleAuction(id);
        vm.expectRevert(
            abi.encodeWithSelector(Auction.AuctionNotActive.selector, id)
        );
        auction.settleAuction(id);
        vm.expectRevert(
            abi.encodeWithSelector(Auction.AuctionNotFound.selector, 0)
        );
        auction.getAuction(0);
    }

    function test_AdminPermissionsAndTwoStepTransfer() public {
        vm.startPrank(bidder);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        auction.pause();
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        auction.configureToken(other, address(feed), 1 hours);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        auction.setTokenEnabled(address(0), false);
        vm.stopPrank();
        vm.expectRevert(Auction.OwnershipRequired.selector);
        auction.renounceOwnership();
        auction.transferOwnership(other);
        assertEq(auction.owner(), address(this));
        vm.prank(bidder);
        vm.expectRevert(bytes("Ownable2Step: caller is not the new owner"));
        auction.acceptOwnership();
        vm.prank(other);
        auction.acceptOwnership();
        assertEq(auction.owner(), other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        auction.pause();
    }

    function test_ConfigCannotBeSilentlyReplaced() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                Auction.PriceAlreadyConfigured.selector,
                address(0)
            )
        );
        auction.configureToken(address(0), address(feed), 2 hours);
        vm.expectRevert(Auction.InvalidPriceConfig.selector);
        auction.configureToken(other, address(feed), 0);
        vm.expectRevert(
            abi.encodeWithSelector(Auction.UnsupportedToken.selector, other)
        );
        auction.configureToken(other, address(feed), 1 hours);
    }

    function test_ReentrantETHRecipientCannotPlaceBidDuringPayment() public {
        _bid(bidder, 1 ether);
        _bid(other, 2 ether);
        AuctionReentrantRecipient recipient = new AuctionReentrantRecipient(
            auction,
            id
        );
        vm.prank(bidder);
        auction.withdrawBid(id, address(recipient));
        assertEq(
            recipient.failure(),
            abi.encodeWithSignature(
                "Error(string)",
                "ReentrancyGuard: reentrant call"
            )
        );
        assertEq(address(recipient).balance, 1 ether);
        assertEq(auction.totalLiabilities(address(0)), 2 ether);
    }

    function test_ReentrantTokenCannotSettleAnotherAuctionDuringDeposit()
        public
    {
        _end();
        uint256 expiredId = id;
        id = _create(2, 0, 1 hours);
        feed.set(1e8, block.timestamp);
        AuctionReentrantToken malicious = new AuctionReentrantToken(
            auction,
            expiredId
        );
        auction.configureToken(address(malicious), address(feed), 1 hours);
        malicious.mint(bidder, 1e6);
        vm.startPrank(bidder);
        malicious.approve(address(auction), 1e6);
        auction.placeBid(id, address(malicious), 1e6);
        vm.stopPrank();
        assertEq(
            malicious.failure(),
            abi.encodeWithSignature(
                "Error(string)",
                "ReentrancyGuard: reentrant call"
            )
        );
        assertEq(
            uint256(auction.getAuction(expiredId).status),
            uint256(Auction.Status.Active)
        );
        assertEq(auction.totalLiabilities(address(malicious)), 1e6);
    }

    function test_AuctionsKeepBidsSeparateAndAggregateSellerProceeds() public {
        uint256 secondId = _create(2, 0, 1 hours);
        _bid(bidder, 1 ether);
        vm.prank(bidder);
        auction.placeBid{value: 2 ether}(secondId, address(0), 2 ether);
        assertEq(auction.getBid(id, bidder).amount, 1 ether);
        assertEq(auction.getBid(secondId, bidder).amount, 2 ether);
        _end();
        auction.settleAuction(id);
        auction.settleAuction(secondId);
        assertEq(auction.proceeds(address(this), address(0)), 3 ether);
        assertEq(auction.totalLiabilities(address(0)), 3 ether);
        auction.withdrawProceeds(address(0), other);
        assertEq(auction.totalLiabilities(address(0)), 0);
        assertEq(address(auction).balance, 0);
    }

    function test_StaleBidFailsBeforeMovingERC20AndZeroBidRejected() public {
        feed.set(1e8, block.timestamp - 1 hours - 1);
        vm.prank(bidder);
        vm.expectRevert(
            abi.encodeWithSelector(
                Auction.StalePrice.selector,
                block.timestamp - 1 hours - 1
            )
        );
        auction.placeBid(id, address(token), 1e6);
        assertEq(token.balanceOf(bidder), 100e6);
        assertEq(token.balanceOf(address(auction)), 0);
        vm.prank(bidder);
        vm.expectRevert(Auction.InvalidAmount.selector);
        auction.placeBid(id, address(0), 0);
    }

    function test_InvalidRefundRecipientsCannotDestroyCredit() public {
        _bid(bidder, 1 ether);
        _bid(other, 2 ether);
        vm.prank(bidder);
        vm.expectRevert(Auction.InvalidAddress.selector);
        auction.withdrawBid(id, address(0));
        vm.prank(bidder);
        vm.expectRevert(Auction.InvalidAddress.selector);
        auction.withdrawBid(id, address(auction));
        assertEq(auction.getBid(id, bidder).amount, 1 ether);
        assertEq(auction.totalLiabilities(address(0)), 3 ether);
    }

    function test_UUPSInitializationAndUpgradePreserveState() public {
        Auction implementation = new Auction();
        vm.expectRevert(
            bytes("Initializable: contract is already initialized")
        );
        implementation.initialize(bidder);
        vm.expectRevert(
            bytes("Initializable: contract is already initialized")
        );
        auction.initialize(bidder);
        vm.expectRevert(Auction.InvalidAddress.selector);
        new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(Auction.initialize, (address(0)))
        );
        _bid(bidder, 1 ether);
        AuctionTestV2 next = new AuctionTestV2();
        vm.prank(bidder);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        auction.upgradeToAndCall(address(next), bytes(""));
        vm.expectRevert(
            bytes("ERC1967Upgrade: new implementation is not UUPS")
        );
        auction.upgradeToAndCall(address(feed), bytes(""));
        auction.upgradeToAndCall(
            address(next),
            abi.encodeCall(AuctionTestV2.initializeV2, (42))
        );
        assertEq(AuctionTestV2(address(auction)).version(), 2);
        assertEq(AuctionTestV2(address(auction)).marker(), 42);
        assertEq(auction.owner(), address(this));
        assertEq(auction.getBid(id, bidder).amount, 1 ether);
        assertEq(auction.totalLiabilities(address(0)), 1 ether);
        _end();
        auction.settleAuction(id);
        auction.withdrawProceeds(address(0), bidder);
        vm.prank(bidder);
        auction.claimNFT(id, other);
        assertEq(nft.ownerOf(1), other);
    }

    function testFuzz_LiabilitiesConservedAcrossRefundAndSettlement(
        uint96 first,
        uint96 extra
    ) public {
        uint256 a = bound(uint256(first), 1, 10 ether);
        uint256 b = a + bound(uint256(extra), 1, 10 ether);
        _bid(bidder, a);
        _bid(other, b);
        assertEq(auction.totalLiabilities(address(0)), a + b);
        assertEq(address(auction).balance, a + b);
        _end();
        auction.settleAuction(id);
        vm.prank(bidder);
        auction.withdrawBid(id, bidder);
        assertEq(auction.totalLiabilities(address(0)), b);
        auction.withdrawProceeds(address(0), bidder);
        assertEq(auction.totalLiabilities(address(0)), 0);
        assertEq(address(auction).balance, 0);
    }
}
