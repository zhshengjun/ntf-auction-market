import {expect} from "chai";
import {network} from "hardhat";
import "@nomicfoundation/hardhat-ethers-chai-matchers";

// -----------------------------------------------------------------------------
// 测试网络：Hardhat 本地 Sepolia Fork
// -----------------------------------------------------------------------------
// 这里只 fork Sepolia 状态，不会向 Sepolia 公网广播测试交易。
const {ethers, networkHelpers} = await network.create("sepoliaFork");
const {loadFixture} = networkHelpers;

// 说明：这是“原生 Hardhat TypeScript 测试”版本：
// - Mocha: describe / it
// - Chai: expect
// - Hardhat Ethers: getSigners / getContractFactory / connect
// - networkHelpers: loadFixture / time / setBalance / setStorageAt
//
// 不使用 合约类型生成工具。这里少量 `: any` 只是为了避免 ethers v6 的 BaseContract
// 静态类型限制影响学习 Hardhat 测试语法；不会改变运行时行为。
// 普通 ERC20 场景使用 Sepolia fork 中真实 Circle USDC。
// 特殊 fee-on-transfer / 重入 / 拒收 ETH 场景使用测试 Helper 合约。

// Circle 官方 Ethereum Sepolia USDC。
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

// 对 fork 中已经存在的第三方合约，原生 Hardhat/Ethers 可以直接使用 address + ABI。
// 直接使用 address + ABI，不依赖任何 USDC artifact。
const USDC_ABI = [
    "function balanceOf(address account) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
];

describe("Auction - Hardhat TypeScript tests", function () {
    this.timeout(180_000);

    const HOUR = 60 * 60;
    const DAY = 24 * HOUR;
    const ZERO = "0x0000000000000000000000000000000000000000";
    const ONE_USDC = 1_000_000n;
    const TEST_USDC_AMOUNT = 100n * ONE_USDC;

    /**
     * Circle USDC 的 balanceAndBlacklistStates mapping 位于 storage slot 9。
     *
     * 这对应 Foundry 原测试里的：
     *
     *   deal(address(token), bidder, 100e6);
     *
     * Hardhat 没有 vm.deal(token, ...)，所以在本地 Sepolia fork 上通过
     * networkHelpers.setStorageAt() 修改真实 USDC proxy 的余额 storage。
     *
     * 注意：
     * - 不调用 USDC mint()
     * - 不修改 Sepolia 公网
     * - 不需要扫描 Transfer 日志
     * - 不需要 whale / impersonateAccount
     * - 后面的 approve / transferFrom 仍然执行真实 Circle USDC 代码
     */
    const USDC_BALANCE_STORAGE_SLOT = 9n;

    /**
     * Solidity mapping(address => uint256) 的元素位置：
     *
     * keccak256(abi.encode(account, mappingSlot))
     */
    function getUsdcBalanceStorageKey(account: string) {
        return ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ["address", "uint256"],
                [account, USDC_BALANCE_STORAGE_SLOT],
            ),
        );
    }

    /**
     * 仅修改本地 fork 中指定账户的真实 USDC 余额。
     *
     * Circle FiatTokenV2_2 的 balanceAndBlacklistStates：
     * - 最高 1 bit：blacklist 标记
     * - 低 255 bit：余额
     *
     * 测试金额远小于 2^255，所以直接写 amount 即表示：
     * blacklist = false，balance = amount。
     */
    async function setForkUsdcBalance(
        usdc: any,
        account: string,
        amount: bigint,
    ) {
        const storageKey = getUsdcBalanceStorageKey(account);

        await networkHelpers.setStorageAt(
            SEPOLIA_USDC,
            storageKey,
            ethers.toBeHex(amount, 32),
        );

        // 立刻验证 storage layout，避免以后 Circle 实现变化时静默写错槽位。
        const actual = await usdc.balanceOf(account);

        if (actual !== amount) {
            throw new Error(
                `Failed to set fork USDC balance for ${account}. ` +
                `Expected ${amount}, got ${actual}. ` +
                `USDC storage layout may have changed.`,
            );
        }
    }

    // Auction.Status 的枚举值（按合约声明顺序）
    const STATUS_ACTIVE = 1n;
    const STATUS_CANCELLED = 2n;

    /**
     * 每个测试通过 loadFixture 回到同一个干净快照。
     *
     * 部署：
     * 1. Auction implementation
     * 2. ERC1967Proxy，并在构造时原子调用 initialize(owner)
     * 3. JunNFT implementation + proxy
     * 4. 连接 Sepolia fork 中真实 Circle USDC
     * 5. Mock price feed
     * 6. 用 setStorageAt 给 bidder / other 准备真实 fork USDC
     * 7. 创建第 1 个拍卖
     */
    async function deployFixture() {
        const [deployer, owner, bidder, other] = await ethers.getSigners();

        // 给竞拍账户准备足够 ETH。
        await networkHelpers.setBalance(
            bidder.address,
            ethers.parseEther("1000"),
        );
        await networkHelpers.setBalance(
            other.address,
            ethers.parseEther("1000"),
        );

        // ---------------- Auction proxy ----------------
        const Auction: any = await ethers.getContractFactory(
            "Auction",
            owner,
        );

        const implementation: any = await Auction.deploy();
        await implementation.waitForDeployment();

        const Proxy: any = await ethers.getContractFactory(
            "ERC1967Proxy",
            owner,
        );

        const auctionInitData = Auction.interface.encodeFunctionData(
            "initialize",
            [owner.address],
        );

        const proxy: any = await Proxy.deploy(
            await implementation.getAddress(),
            auctionInitData,
        );
        await proxy.waitForDeployment();

        const auction: any = Auction.attach(await proxy.getAddress());

        // ---------------- JunNFT proxy ----------------
        const JunNFT: any = await ethers.getContractFactory(
            "JunNFT",
            owner,
        );

        const nftImplementation: any = await JunNFT.deploy();
        await nftImplementation.waitForDeployment();

        const nftInitData = JunNFT.interface.encodeFunctionData(
            "initialize",
            [100n, owner.address],
        );

        const nftProxy: any = await Proxy.deploy(
            await nftImplementation.getAddress(),
            nftInitData,
        );
        await nftProxy.waitForDeployment();

        const nft: any = JunNFT.attach(await nftProxy.getAddress());

        // ---------------- Real Sepolia USDC + Mock Feed ----------------
        // 直接绑定 fork 状态中的 Circle 官方 Sepolia USDC。
        const usdc: any = new ethers.Contract(
            SEPOLIA_USDC,
            USDC_ABI,
            owner,
        );

        // 明确验证当前 fork 确实包含真实 USDC 合约，并且 decimals == 6。
        const usdcCode = await ethers.provider.getCode(SEPOLIA_USDC);
        expect(usdcCode).to.not.equal("0x");
        expect(await usdc.decimals()).to.equal(6n);

        const Feed: any = await ethers.getContractFactory(
            "HardhatAuctionFeed",
            owner,
        );
        const feed: any = await Feed.deploy();
        await feed.waitForDeployment();

        await (
            await auction
                .connect(owner)
                .configureToken(ZERO, await feed.getAddress(), HOUR)
        ).wait();

        await (
            await auction
                .connect(owner)
                .configureToken(
                    SEPOLIA_USDC,
                    await feed.getAddress(),
                    HOUR,
                )
        ).wait();

        // Hardhat 默认 signer 在 Sepolia fork 中通常没有真实 USDC。
        //
        // 对应 Foundry：
        //   deal(address(token), bidder, 100e6);
        //   deal(address(token), other, 100e6);
        //
        // 这里直接修改本地 fork 上真实 USDC 的余额 storage。
        // 不调用 mint，也不会向 Sepolia 公网发送交易。
        await setForkUsdcBalance(
            usdc,
            bidder.address,
            TEST_USDC_AMOUNT,
        );

        await setForkUsdcBalance(
            usdc,
            other.address,
            TEST_USDC_AMOUNT,
        );

        const bidderUsdcStart = await usdc.balanceOf(bidder.address);
        const otherUsdcStart = await usdc.balanceOf(other.address);

        await (
            await usdc
                .connect(bidder)
                .approve(await auction.getAddress(), TEST_USDC_AMOUNT)
        ).wait();

        await (
            await usdc
                .connect(other)
                .approve(await auction.getAddress(), TEST_USDC_AMOUNT)
        ).wait();

        const fixtureBeforeAuction: any = {
            deployer,
            owner,
            bidder,
            other,
            Auction,
            Proxy,
            auction,
            implementation,
            nft,
            nftImplementation,
            usdc,
            bidderUsdcStart,
            otherUsdcStart,
            feed,
        };

        // fixture 默认先创建一个拍卖，后续大部分测试都从这场拍卖开始。
        const created = await createAuction(fixtureBeforeAuction, 0n, HOUR);

        return {
            ...fixtureBeforeAuction,
            id: created.id,
            tokenId: created.tokenId,
        };
    }

    /** 创建 NFT -> approve Auction -> createAuction */
    async function createAuction(
        f: any,
        reserve: bigint,
        duration: number,
    ) {
        await (await f.nft.connect(f.owner).mint(f.owner.address)).wait();

        const balance = await f.nft.balanceOf(f.owner.address);

        const tokenId = await f.nft.tokenOfOwnerByIndex(
            f.owner.address,
            balance - 1n,
        );

        await (
            await f.nft
                .connect(f.owner)
                .approve(await f.auction.getAddress(), tokenId)
        ).wait();

        const id = (await f.auction.auctionCount()) + 1n;

        await (
            await f.auction
                .connect(f.owner)
                .createAuction(
                    await f.nft.getAddress(),
                    tokenId,
                    reserve,
                    duration,
                )
        ).wait();

        return {id, tokenId};
    }

    /** ETH 出价。amount 是本次追加的 ETH，合约内部会累计用户总 bid。 */
    async function bidEth(
        f: any,
        who: any,
        id: bigint,
        amount: bigint,
    ) {
        await (
            await f.auction
                .connect(who)
                .placeBid(id, ZERO, amount, {value: amount})
        ).wait();
    }

    /** 把 Hardhat 本地链时间推进到拍卖结束时间。 */
    async function endAuction(f: any, id: bigint) {
        const item = await f.auction.getAuction(id);
        await networkHelpers.time.increaseTo(item.endTime);
    }

    // ==========================================================================
    // 1. 创建与查询
    // ==========================================================================
    it("CreationAndQueries", async function () {
        const f = await loadFixture(deployFixture);

        const item = await f.auction.getAuction(f.id);

        expect(f.id).to.equal(1n);
        expect(await f.auction.auctionCount()).to.equal(1n);

        // 拍卖创建者就是 owner。
        expect(item.seller).to.equal(f.owner.address);

        // 第一个 NFT tokenId 应为 1。
        expect(item.tokenId).to.equal(1n);

        // 创建后状态必须为 Active。
        expect(item.status).to.equal(STATUS_ACTIVE);

        // createAuction 会把 NFT 托管进 Auction 合约。
        expect(await f.nft.ownerOf(1n)).to.equal(
            await f.auction.getAddress(),
        );

        expect(await f.nft.owner()).to.equal(f.owner.address);
        expect(await f.nft.name()).to.equal("JunNFT");
        expect(await f.nft.totalSupply()).to.equal(1n);

        expect(
            await f.nft.tokenOfOwnerByIndex(
                await f.auction.getAddress(),
                0n,
            ),
        ).to.equal(1n);

        // bidder 尚未出价。
        expect((await f.auction.getBid(f.id, f.bidder.address)).amount)
            .to.equal(0n);
    });

    // ==========================================================================
    // 2. 创建拍卖参数校验
    // ==========================================================================
    it("CreationRejectsInvalidInputsAndMissingApproval", async function () {
        const f = await loadFixture(deployFixture);

        await (await f.nft.connect(f.owner).mint(f.owner.address)).wait();

        // duration = 0
        await expect(
            f.auction
                .connect(f.owner)
                .createAuction(await f.nft.getAddress(), 2n, 0n, 0),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidDuration",
        );

        // duration > 30 days
        await expect(
            f.auction
                .connect(f.owner)
                .createAuction(
                    await f.nft.getAddress(),
                    2n,
                    0n,
                    30 * DAY + 1,
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidDuration",
        );

        // bidder.address 是 EOA，不是 ERC721 合约。
        await expect(
            f.auction
                .connect(f.owner)
                .createAuction(f.bidder.address, 2n, 0n, HOUR),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidNFT",
        );

        // bidder 不是 NFT 所有者。
        await expect(
            f.auction
                .connect(f.bidder)
                .createAuction(
                    await f.nft.getAddress(),
                    2n,
                    0n,
                    HOUR,
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "Unauthorized",
        );

        // owner 虽然拥有 NFT，但没有 approve Auction。
        await expect(
            f.auction
                .connect(f.owner)
                .createAuction(
                    await f.nft.getAddress(),
                    2n,
                    0n,
                    HOUR,
                ),
        ).to.revert(ethers);

        // 前面的失败必须全部回滚，auctionCount 仍为 1。
        expect(await f.auction.auctionCount()).to.equal(1n);
        expect(await f.nft.ownerOf(2n)).to.equal(f.owner.address);
    });

    // ==========================================================================
    // 3. 非预期 NFT 转入
    // ==========================================================================
    it("UnsolicitedSafeNFTTransferRejected", async function () {
        const f = await loadFixture(deployFixture);

        await (await f.nft.connect(f.owner).mint(f.owner.address)).wait();

        // safeTransferFrom 向合约转 NFT 时，会自动回调 onERC721Received。
        // Auction 没有提前登记“正在接收这个 NFT”，因此必须拒绝。
        await expect(
            f.nft
                .connect(f.owner)
                ["safeTransferFrom(address,address,uint256)"](
                f.owner.address,
                await f.auction.getAddress(),
                2n,
            ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "UnexpectedNFT",
        );

        // 整笔 safeTransferFrom 已回滚，NFT 仍属于 owner。
        expect(await f.nft.ownerOf(2n)).to.equal(f.owner.address);

        // 主动调用回调函数，验证任何人都不能绕过正常创建拍卖流程，
        // 直接伪造 ERC721 Receiver 回调。
        await expect(
            f.auction
                .connect(f.owner)
                .onERC721Received(
                    await f.auction.getAddress(),
                    f.owner.address,
                    1n,
                    "0x",
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "UnexpectedNFT",
        );
    });

    // ==========================================================================
    // 4. 首次出价可以等于 reserve，后续最高价必须真正超过
    // ==========================================================================
    it("FirstBidCanEqualReserveButSubsequentBidMustExceed", async function () {
        const f = await loadFixture(deployFixture);

        const {id} = await createAuction(
            f,
            ethers.parseEther("1"),
            HOUR,
        );

        await expect(
            f.auction
                .connect(f.bidder)
                .placeBid(
                    id,
                    ZERO,
                    ethers.parseEther("0.5"),
                    {value: ethers.parseEther("0.5")},
                ),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "BidTooLow",
            )
            .withArgs(
                ethers.parseEther("0.5"),
                ethers.parseEther("1"),
            );

        // 第一次出价 = reserve，允许。
        await bidEth(
            f,
            f.bidder,
            id,
            ethers.parseEther("1"),
        );

        // 另一个人的总出价如果只等于当前最高价，不允许。
        await expect(
            f.auction
                .connect(f.other)
                .placeBid(
                    id,
                    ZERO,
                    ethers.parseEther("1"),
                    {value: ethers.parseEther("1")},
                ),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "BidTooLow",
            )
            .withArgs(
                ethers.parseEther("1"),
                ethers.parseEther("1"),
            );

        // bidder 再追加 1 ETH，总 bid 变成 2 ETH。
        await bidEth(
            f,
            f.bidder,
            id,
            ethers.parseEther("1"),
        );

        expect(
            (await f.auction.getBid(id, f.bidder.address)).amount,
        ).to.equal(ethers.parseEther("2"));

        expect(
            (await f.auction.getAuction(id)).highestBidUsd,
        ).to.equal(ethers.parseEther("2"));
    });

    // ==========================================================================
    // 5. ETH 结算采用 Pull Payment，不主动给卖家/赢家转 ETH
    // ==========================================================================
    it("ETHSettlementDoesNotCallEitherParty", async function () {
        const f = await loadFixture(deployFixture);

        const Seller: any = await ethers.getContractFactory(
            "HardhatRejectEtherSeller",
            f.owner,
        );
        const seller: any = await Seller.deploy();
        await seller.waitForDeployment();

        // 创建一个新的 NFT，并转给“不接受 ETH”的 seller 合约。
        await (await f.nft.connect(f.owner).mint(f.owner.address)).wait();

        const balance = await f.nft.balanceOf(f.owner.address);
        const tokenId = await f.nft.tokenOfOwnerByIndex(
            f.owner.address,
            balance - 1n,
        );

        await (
            await f.nft
                .connect(f.owner)
                .transferFrom(
                    f.owner.address,
                    await seller.getAddress(),
                    tokenId,
                )
        ).wait();

        const id = (await f.auction.auctionCount()) + 1n;

        await (
            await seller.createAuction(
                await f.auction.getAddress(),
                await f.nft.getAddress(),
                tokenId,
                0n,
                HOUR,
            )
        ).wait();

        await bidEth(
            f,
            f.bidder,
            id,
            ethers.parseEther("1"),
        );

        await endAuction(f, id);

        // settleAuction 成功说明结算阶段没有强行向 seller 转 ETH。
        await expect(
            f.auction.connect(f.other).settleAuction(id),
        )
            .to.emit(f.auction, "AuctionSettled")
            .withArgs(
                id,
                await seller.getAddress(),
                f.bidder.address,
                ZERO,
                ethers.parseEther("1"),
                ethers.parseEther("1"),
            );

        // NFT 仍在 Auction 中，等待 winner 主动 claim。
        expect(await f.nft.ownerOf(tokenId)).to.equal(
            await f.auction.getAddress(),
        );

        // 卖家的 1 ETH 进入 proceeds 账本。
        expect(
            await f.auction.proceeds(
                await seller.getAddress(),
                ZERO,
            ),
        ).to.equal(ethers.parseEther("1"));

        // winner 的 bid 已被消费，不再是可退款 bid。
        expect(
            (await f.auction.getBid(id, f.bidder.address)).amount,
        ).to.equal(0n);

        expect(await f.auction.totalLiabilities(ZERO)).to.equal(
            ethers.parseEther("1"),
        );

        // seller 自己调用提现逻辑，但把钱发给 other。
        const otherBefore = await ethers.provider.getBalance(
            f.other.address,
        );

        await (
            await seller.withdrawProceeds(
                await f.auction.getAddress(),
                ZERO,
                f.other.address,
            )
        ).wait();

        const otherAfter = await ethers.provider.getBalance(
            f.other.address,
        );

        expect(otherAfter - otherBefore).to.equal(
            ethers.parseEther("1"),
        );

        await (
            await f.auction
                .connect(f.bidder)
                .claimNFT(id, f.bidder.address)
        ).wait();

        expect(await f.nft.ownerOf(tokenId)).to.equal(
            f.bidder.address,
        );
        expect((await f.auction.getAuction(id)).nftClaimed)
            .to.equal(true);

        expect(await f.auction.totalLiabilities(ZERO)).to.equal(0n);
    });

    // ==========================================================================
    // 6. 真实 Sepolia USDC 赢家 + ETH 输家退款
    // ==========================================================================
    it("ERC20WinnerAndMixedCurrencyRefund", async function () {
        const f = await loadFixture(deployFixture);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await (
            await f.auction
                .connect(f.other)
                .placeBid(
                    f.id,
                    SEPOLIA_USDC,
                    2_000_000n,
                )
        ).wait();

        await endAuction(f, f.id);
        await (await f.auction.settleAuction(f.id)).wait();

        // bidder 是输家，可以取回 ETH。
        await (
            await f.auction
                .connect(f.bidder)
                .withdrawBid(f.id, f.bidder.address)
        ).wait();

        // owner 是卖家，把 ERC20 proceeds 提现给 other。
        await (
            await f.auction
                .connect(f.owner)
                .withdrawProceeds(
                    SEPOLIA_USDC,
                    f.other.address,
                )
        ).wait();

        // winner(other) 可以选择把 NFT 发给 bidder。
        await (
            await f.auction
                .connect(f.other)
                .claimNFT(f.id, f.bidder.address)
        ).wait();

        // other 出价 2 USDC，之后又收到卖家的 2 USDC proceeds，
        // 因此回到初始 100 USDC。
        // other 先支付 2 USDC，随后又作为 proceeds recipient 收回 2 USDC，
        // 所以最终余额应回到 fixture 完成后的 baseline。
        expect(await f.usdc.balanceOf(f.other.address)).to.equal(
            f.otherUsdcStart,
        );

        expect(await f.nft.ownerOf(f.tokenId)).to.equal(
            f.bidder.address,
        );

        expect(
            await f.auction.totalLiabilities(
                SEPOLIA_USDC,
            ),
        ).to.equal(0n);

        expect(
            await ethers.provider.getBalance(
                await f.auction.getAddress(),
            ),
        ).to.equal(0n);
    });

    // ==========================================================================
    // 7. Cancelled / Unsold 的 NFT 领取
    // ==========================================================================
    it("UnsoldAndCancelledNFTClaims", async function () {
        const f = await loadFixture(deployFixture);

        await (await f.auction.connect(f.owner).cancelAuction(f.id)).wait();

        expect((await f.auction.getAuction(f.id)).status)
            .to.equal(STATUS_CANCELLED);

        // 取消拍卖后，seller 是 claimant，可以指定 NFT recipient。
        await (
            await f.auction
                .connect(f.owner)
                .claimNFT(f.id, f.bidder.address)
        ).wait();

        expect(await f.nft.ownerOf(f.tokenId)).to.equal(
            f.bidder.address,
        );

        // 再创建一个没有任何 bid 的拍卖。
        const second = await createAuction(f, 0n, HOUR);

        await endAuction(f, second.id);

        // 任何人都可以触发结算。
        await (
            await f.auction.connect(f.other).settleAuction(second.id)
        ).wait();

        // 无人竞拍时，seller 可以取回 NFT，也可以指定 recipient。
        await (
            await f.auction
                .connect(f.owner)
                .claimNFT(second.id, f.other.address)
        ).wait();

        expect(await f.nft.ownerOf(second.tokenId)).to.equal(
            f.other.address,
        );
    });

    // ==========================================================================
    // 8. 非卖家不能取消；已有 bid 也不能取消
    // ==========================================================================
    it("CancellationRejectsNonSellerAndExistingBids", async function () {
        const f = await loadFixture(deployFixture);

        await expect(
            f.auction.connect(f.bidder).cancelAuction(f.id),
        ).to.be.revertedWithCustomError(
            f.auction,
            "Unauthorized",
        );

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await expect(
            f.auction.connect(f.owner).cancelAuction(f.id),
        ).to.be.revertedWithCustomError(
            f.auction,
            "AuctionHasBids",
        );
    });

    // ==========================================================================
    // 9. 输家退款可以指定不同 recipient
    // ==========================================================================
    it("RefundCanUseDifferentRecipientAfterSettlement", async function () {
        const f = await loadFixture(deployFixture);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await bidEth(
            f,
            f.other,
            f.id,
            ethers.parseEther("2"),
        );

        await endAuction(f, f.id);
        await (await f.auction.settleAuction(f.id)).wait();

        const before = await ethers.provider.getBalance(
            f.other.address,
        );

        await (
            await f.auction
                .connect(f.bidder)
                .withdrawBid(f.id, f.other.address)
        ).wait();

        const after = await ethers.provider.getBalance(
            f.other.address,
        );

        // bidder 的 1 ETH refund 被发给了 other。
        expect(after - before).to.equal(
            ethers.parseEther("1"),
        );

        // winner 的 2 ETH 仍然作为 seller proceeds 留在合约账本里。
        expect(await f.auction.totalLiabilities(ZERO)).to.equal(
            ethers.parseEther("2"),
        );

        // bidder 的 credit 已经提现一次，再提必须失败。
        await expect(
            f.auction
                .connect(f.bidder)
                .withdrawBid(f.id, f.bidder.address),
        ).to.be.revertedWithCustomError(
            f.auction,
            "NothingToWithdraw",
        );
    });

    // ==========================================================================
    // 10. 最高 bid 在结算前不能取回；赢了以后也不是 refund
    // ==========================================================================
    it("HighestBidLockedUntilSettledAndNeverRefundedAfterWin", async function () {
        const f = await loadFixture(deployFixture);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await endAuction(f, f.id);

        await expect(
            f.auction
                .connect(f.bidder)
                .withdrawBid(f.id, f.bidder.address),
        ).to.be.revertedWithCustomError(
            f.auction,
            "HighestBidLocked",
        );

        await (await f.auction.settleAuction(f.id)).wait();

        await expect(
            f.auction
                .connect(f.bidder)
                .withdrawBid(f.id, f.bidder.address),
        ).to.be.revertedWithCustomError(
            f.auction,
            "NothingToWithdraw",
        );
    });

    // ==========================================================================
    // 11. ETH 提现失败不能破坏 credit / liability
    // ==========================================================================
    it("FailedWithdrawalPreservesCreditAndLiability", async function () {
        const f = await loadFixture(deployFixture);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await endAuction(f, f.id);
        await (await f.auction.settleAuction(f.id)).wait();

        const Reject: any = await ethers.getContractFactory(
            "HardhatRejectEther",
            f.owner,
        );
        const reject: any = await Reject.deploy();
        await reject.waitForDeployment();

        // reject 合约没有 receive/fallback，因此 ETH transfer 必须失败。
        await expect(
            f.auction
                .connect(f.owner)
                .withdrawProceeds(ZERO, await reject.getAddress()),
        ).to.be.revertedWithCustomError(
            f.auction,
            "ETHTransferFailed",
        );

        // 失败后记账必须完整恢复。
        expect(
            await f.auction.proceeds(f.owner.address, ZERO),
        ).to.equal(ethers.parseEther("1"));

        expect(await f.auction.totalLiabilities(ZERO)).to.equal(
            ethers.parseEther("1"),
        );

        // 换成正常 EOA recipient 后可以成功。
        await (
            await f.auction
                .connect(f.owner)
                .withdrawProceeds(ZERO, f.bidder.address)
        ).wait();

        await expect(
            f.auction
                .connect(f.owner)
                .withdrawProceeds(ZERO, f.bidder.address),
        ).to.be.revertedWithCustomError(
            f.auction,
            "NothingToWithdraw",
        );
    });

    // ==========================================================================
    // 12. NFT claim 失败不能阻塞独立结算
    // ==========================================================================
    it("FailedNFTClaimDoesNotBlockIndependentSettlement", async function () {
        const f = await loadFixture(deployFixture);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await endAuction(f, f.id);

        // feed 不是 ERC721Receiver，NFT safe transfer 会失败。
        await expect(
            f.auction
                .connect(f.bidder)
                .claimNFT(f.id, await f.feed.getAddress()),
        ).to.revert(ethers);

        // failed claim 不应该改变 auction 状态。
        expect((await f.auction.getAuction(f.id)).status)
            .to.equal(STATUS_ACTIVE);

        // 结算依然可以独立进行。
        await (await f.auction.settleAuction(f.id)).wait();

        await (
            await f.auction
                .connect(f.owner)
                .withdrawProceeds(ZERO, f.other.address)
        ).wait();

        // 再次发给不兼容 recipient，仍然失败。
        await expect(
            f.auction
                .connect(f.bidder)
                .claimNFT(f.id, await f.feed.getAddress()),
        ).to.revert(ethers);

        // nftClaimed 必须保持 false。
        expect((await f.auction.getAuction(f.id)).nftClaimed)
            .to.equal(false);

        // 改成合法 recipient 后成功。
        await (
            await f.auction
                .connect(f.bidder)
                .claimNFT(f.id, f.bidder.address)
        ).wait();

        // 已领取后不能重复领取。
        await expect(
            f.auction
                .connect(f.bidder)
                .claimNFT(f.id, f.bidder.address),
        ).to.be.revertedWithCustomError(
            f.auction,
            "NFTAlreadyClaimed",
        );
    });

    // ==========================================================================
    // 13. 只有 claimant 能决定 NFT recipient
    // ==========================================================================
    it("OnlyClaimantCanChooseNFTRecipient", async function () {
        const f = await loadFixture(deployFixture);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await endAuction(f, f.id);

        // bidder 是 winner；owner 不能代替 winner 领取。
        await expect(
            f.auction
                .connect(f.owner)
                .claimNFT(f.id, f.other.address),
        ).to.be.revertedWithCustomError(
            f.auction,
            "Unauthorized",
        );

        // winner 也不能指定 Auction 自己作为 recipient。
        await expect(
            f.auction
                .connect(f.bidder)
                .claimNFT(f.id, await f.auction.getAddress()),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidAddress",
        );
    });

    // ==========================================================================
    // 14. pause 只阻止新增风险，不阻止退出
    // ==========================================================================
    it("PauseBlocksExposureButNotExit", async function () {
        const f = await loadFixture(deployFixture);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await bidEth(
            f,
            f.other,
            f.id,
            ethers.parseEther("2"),
        );

        await (await f.auction.connect(f.owner).pause()).wait();

        // paused 后不能继续 bid。
        await expect(
            f.auction
                .connect(f.bidder)
                .placeBid(
                    f.id,
                    ZERO,
                    ethers.parseEther("3"),
                    {value: ethers.parseEther("3")},
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "EnforcedPause",
        );

        // paused 后也不能创建新 auction。
        await expect(
            f.auction
                .connect(f.owner)
                .createAuction(
                    await f.nft.getAddress(),
                    f.tokenId,
                    0n,
                    HOUR,
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "EnforcedPause",
        );

        // loser 的 withdraw 是“退出路径”，必须保持可用。
        await (
            await f.auction
                .connect(f.bidder)
                .withdrawBid(f.id, f.bidder.address)
        ).wait();

        await endAuction(f, f.id);
        await (await f.auction.settleAuction(f.id)).wait();

        // winner 仍然可以 claim NFT。
        await (
            await f.auction
                .connect(f.other)
                .claimNFT(f.id, f.other.address)
        ).wait();

        // seller 仍然可以提现 proceeds。
        await (
            await f.auction
                .connect(f.owner)
                .withdrawProceeds(ZERO, f.bidder.address)
        ).wait();

        expect(await f.auction.totalLiabilities(ZERO)).to.equal(0n);

        await (await f.auction.connect(f.owner).unpause()).wait();
        expect(await f.auction.paused()).to.equal(false);
    });

    // ==========================================================================
    // 15. 真实 Sepolia USDC disabled 后不能新出价，但已有资金仍然可以退出
    // ==========================================================================
    it("TokenDisableDoesNotBlockExits", async function () {
        const f = await loadFixture(deployFixture);

        await (
            await f.auction
                .connect(f.bidder)
                .placeBid(
                    f.id,
                    SEPOLIA_USDC,
                    1_000_000n,
                )
        ).wait();

        await (
            await f.auction
                .connect(f.owner)
                .setTokenEnabled(SEPOLIA_USDC, false)
        ).wait();

        await expect(
            f.auction
                .connect(f.other)
                .placeBid(
                    f.id,
                    SEPOLIA_USDC,
                    2_000_000n,
                ),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "TokenDisabled",
            )
            .withArgs(SEPOLIA_USDC);

        await endAuction(f, f.id);
        await (await f.auction.settleAuction(f.id)).wait();

        // 即使 token 已 disabled，seller 仍然能把已有 proceeds 提走。
        await (
            await f.auction
                .connect(f.owner)
                .withdrawProceeds(
                    SEPOLIA_USDC,
                    f.other.address,
                )
        ).wait();

        // other 没有参与这笔 1 USDC bid，却收到 seller 的 1 USDC proceeds。
        expect(await f.usdc.balanceOf(f.other.address)).to.equal(
            f.otherUsdcStart + ONE_USDC,
        );
    });

    // ==========================================================================
    // 16. Oracle price 校验 + decimal normalization
    // ==========================================================================
    it("PriceChecksAndDecimalNormalization", async function () {
        const f = await loadFixture(deployFixture);

        let now = await networkHelpers.time.latest();

        await (await f.feed.set(2000n * 10n ** 8n, now)).wait();

        expect(
            await f.auction.quoteUsd(
                ZERO,
                ethers.parseEther("0.5"),
            ),
        ).to.equal(1000n * 10n ** 18n);

        expect(
            await f.auction.quoteUsd(ZERO, 1n),
        ).to.equal(2000n);

        expect(
            await f.auction.quoteUsd(
                SEPOLIA_USDC,
                1_000_000n,
            ),
        ).to.equal(2000n * 10n ** 18n);

        now = await networkHelpers.time.latest();

        // price == 0
        await (await f.feed.set(0n, now)).wait();

        await expect(
            f.auction.quoteUsd(ZERO, ethers.parseEther("1")),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidPrice",
        );

        // price < 0
        await (await f.feed.set(-1n, now)).wait();

        await expect(
            f.auction.quoteUsd(ZERO, ethers.parseEther("1")),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidPrice",
        );

        // updatedAt == 0
        await (await f.feed.set(100_000_000n, 0n)).wait();

        await expect(
            f.auction.quoteUsd(ZERO, ethers.parseEther("1")),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidPrice",
        );

        // updatedAt 在未来
        now = await networkHelpers.time.latest();
        await (
            await f.feed.set(100_000_000n, BigInt(now + 100))
        ).wait();

        await expect(
            f.auction.quoteUsd(ZERO, ethers.parseEther("1")),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidPrice",
        );

        // price 超过 maxAge。
        now = await networkHelpers.time.latest();
        const staleAt = BigInt(now - HOUR - 1);

        await (await f.feed.set(100_000_000n, staleAt)).wait();

        await expect(
            f.auction.quoteUsd(ZERO, ethers.parseEther("1")),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "StalePrice",
            )
            .withArgs(staleAt);

        // feed decimals 配置异常。
        now = await networkHelpers.time.latest();
        await (
            await f.feed.set(100_000_000n, BigInt(now))
        ).wait();

        await (await f.feed.setDecimals(18)).wait();

        await expect(
            f.auction.quoteUsd(ZERO, ethers.parseEther("1")),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidPriceConfig",
        );
    });

    // ==========================================================================
    // 17. Oracle 后来坏掉，不应影响已经锁定价格的 settlement / withdrawal
    // ==========================================================================
    it("BadOracleDoesNotAffectSettlementAndWithdrawals", async function () {
        const f = await loadFixture(deployFixture);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await (await f.feed.set(-1n, 0n)).wait();

        await endAuction(f, f.id);

        await (await f.auction.settleAuction(f.id)).wait();

        await (
            await f.auction
                .connect(f.owner)
                .withdrawProceeds(ZERO, f.bidder.address)
        ).wait();

        expect(await f.auction.totalLiabilities(ZERO)).to.equal(0n);
    });

    // ==========================================================================
    // 18. 测试专用 fee-on-transfer Token：deposit 异常时整笔交易必须回滚
    // ==========================================================================
    it("RejectsFeeOnTransferDepositsAndRollsBack", async function () {
        const f = await loadFixture(deployFixture);

        const FeeToken: any = await ethers.getContractFactory(
            "HardhatFeeOnTransferToken",
            f.owner,
        );

        // 这是专门模拟 fee-on-transfer 的测试 Token，不是真实 USDC。
        // bidder 的 100 个测试 Token 在部署时一次性分配；
        // 测试执行过程中不调用 mint()。
        const feeToken: any = await FeeToken.deploy();
        await feeToken.waitForDeployment();

        await (
            await feeToken.mint(
                f.bidder.address,
                100_000_000n,
            )
        ).wait();

        await (
            await f.auction
                .connect(f.owner)
                .configureToken(
                    await feeToken.getAddress(),
                    await f.feed.getAddress(),
                    HOUR,
                )
        ).wait();

        await (
            await feeToken
                .connect(f.bidder)
                .approve(await f.auction.getAddress(), 100_000_000n)
        ).wait();

        await (await feeToken.setFee(1n)).wait();

        await expect(
            f.auction
                .connect(f.bidder)
                .placeBid(
                    f.id,
                    await feeToken.getAddress(),
                    1_000_000n,
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "UnexpectedTokenAmount",
        );

        // revert 后 token 余额也要回滚。
        expect(await feeToken.balanceOf(f.bidder.address))
            .to.equal(100_000_000n);

        expect(
            await f.auction.totalLiabilities(
                await feeToken.getAddress(),
            ),
        ).to.equal(0n);

        expect((await f.auction.getAuction(f.id)).highestBidder)
            .to.equal(ZERO);
    });

    // ==========================================================================
    // 19. 测试专用 fee-on-transfer Token：提现扣税时不能让用户丢 credit
    // ==========================================================================
    it("RejectsOutgoingTransferTaxWithoutLosingCredit", async function () {
        const f = await loadFixture(deployFixture);

        const FeeToken: any = await ethers.getContractFactory(
            "HardhatFeeOnTransferToken",
            f.owner,
        );

        // 这是专门模拟 fee-on-transfer 的测试 Token，不是真实 USDC。
        // bidder 的 100 个测试 Token 在部署时一次性分配；
        // 测试执行过程中不调用 mint()。
        const feeToken: any = await FeeToken.deploy();
        await feeToken.waitForDeployment();

        await (
            await feeToken.mint(
                f.bidder.address,
                100_000_000n,
            )
        ).wait();

        await (
            await f.auction
                .connect(f.owner)
                .configureToken(
                    await feeToken.getAddress(),
                    await f.feed.getAddress(),
                    HOUR,
                )
        ).wait();

        await (
            await feeToken
                .connect(f.bidder)
                .approve(await f.auction.getAddress(), 100_000_000n)
        ).wait();

        // deposit 阶段 fee == 0，因此 bid 正常进入。
        await (
            await f.auction
                .connect(f.bidder)
                .placeBid(
                    f.id,
                    await feeToken.getAddress(),
                    1_000_000n,
                )
        ).wait();

        await endAuction(f, f.id);
        await (await f.auction.settleAuction(f.id)).wait();

        // withdrawal 前才打开转账税。
        await (await feeToken.setFee(1n)).wait();

        await expect(
            f.auction
                .connect(f.owner)
                .withdrawProceeds(
                    await feeToken.getAddress(),
                    f.other.address,
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "UnexpectedTokenAmount",
        );

        // 失败后 seller credit 与 liability 不能被清零。
        expect(
            await f.auction.proceeds(
                f.owner.address,
                await feeToken.getAddress(),
            ),
        ).to.equal(1_000_000n);

        expect(
            await f.auction.totalLiabilities(
                await feeToken.getAddress(),
            ),
        ).to.equal(1_000_000n);

        // 取消 fee 后重试成功。
        await (await feeToken.setFee(0n)).wait();

        await (
            await f.auction
                .connect(f.owner)
                .withdrawProceeds(
                    await feeToken.getAddress(),
                    f.other.address,
                )
        ).wait();
    });

    // ==========================================================================
    // 20. Bid 参数校验 + refund 后允许切换支付 token
    // ==========================================================================
    it("BidValidationAndTokenSwitchAfterRefund", async function () {
        const f = await loadFixture(deployFixture);

        // seller 不能给自己的 auction 出价。
        await expect(
            f.auction
                .connect(f.owner)
                .placeBid(f.id, ZERO, 0n),
        ).to.be.revertedWithCustomError(
            f.auction,
            "SellerCannotBid",
        );

        // ETH msg.value != amount。
        await expect(
            f.auction
                .connect(f.bidder)
                .placeBid(
                    f.id,
                    ZERO,
                    ethers.parseEther("2"),
                    {value: ethers.parseEther("1")},
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidAmount",
        );

        // ERC20 bid 不应该携带 ETH。
        await expect(
            f.auction
                .connect(f.bidder)
                .placeBid(
                    f.id,
                    SEPOLIA_USDC,
                    1_000_000n,
                    {value: 1n},
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidAmount",
        );

        // other.address 不是配置过的 token。
        await expect(
            f.auction
                .connect(f.bidder)
                .placeBid(f.id, f.other.address, 1n),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "UnsupportedToken",
            )
            .withArgs(f.other.address);

        // bidder 第一次使用 ETH。
        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        // 同一份未退款 bid 不能直接从 ETH 切成真实 Sepolia USDC。
        await expect(
            f.auction
                .connect(f.bidder)
                .placeBid(
                    f.id,
                    SEPOLIA_USDC,
                    2_000_000n,
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "BidTokenMismatch",
        );

        // other 用 2 ETH 成为新最高价。
        await bidEth(
            f,
            f.other,
            f.id,
            ethers.parseEther("2"),
        );

        // bidder 已经不是 highest，可以先把旧 ETH bid 取回。
        await (
            await f.auction
                .connect(f.bidder)
                .withdrawBid(f.id, f.bidder.address)
        ).wait();

        // 旧 credit 清零后，允许 bidder 改用真实 Sepolia USDC。
        await (
            await f.auction
                .connect(f.bidder)
                .placeBid(
                    f.id,
                    SEPOLIA_USDC,
                    3_000_000n,
                )
        ).wait();

        expect(
            (await f.auction.getBid(f.id, f.bidder.address)).token,
        ).to.equal(SEPOLIA_USDC);
    });

    // ==========================================================================
    // 21. 时间边界 + 重复 settlement
    // ==========================================================================
    it("TimeBoundariesAndRepeatedSettlement", async function () {
        const f = await loadFixture(deployFixture);

        // 还没到 endTime。
        await expect(
            f.auction.settleAuction(f.id),
        ).to.be.revertedWithCustomError(
            f.auction,
            "AuctionNotEnded",
        ).withArgs(f.id);

        await endAuction(f, f.id);

        // 到了 endTime 以后不能再 bid。
        await expect(
            f.auction
                .connect(f.bidder)
                .placeBid(
                    f.id,
                    ZERO,
                    ethers.parseEther("1"),
                    {value: ethers.parseEther("1")},
                ),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "AuctionEnded",
            )
            .withArgs(f.id);

        // 第一次 settle 成功。
        await (await f.auction.settleAuction(f.id)).wait();

        // 同一个 auction 不能第二次 settle。
        await expect(
            f.auction.settleAuction(f.id),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "AuctionNotActive",
            )
            .withArgs(f.id);

        // id == 0 不存在。
        await expect(
            f.auction.getAuction(0n),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "AuctionNotFound",
            )
            .withArgs(0n);
    });

    // ==========================================================================
    // 22. Admin 权限 + Ownable2Step
    // ==========================================================================
    it("AdminPermissionsAndTwoStepTransfer", async function () {
        const f = await loadFixture(deployFixture);

        await expect(
            f.auction.connect(f.bidder).pause(),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "OwnableUnauthorizedAccount",
            )
            .withArgs(f.bidder.address);

        await expect(
            f.auction
                .connect(f.bidder)
                .configureToken(
                    f.other.address,
                    await f.feed.getAddress(),
                    HOUR,
                ),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "OwnableUnauthorizedAccount",
            )
            .withArgs(f.bidder.address);

        await expect(
            f.auction
                .connect(f.bidder)
                .setTokenEnabled(ZERO, false),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "OwnableUnauthorizedAccount",
            )
            .withArgs(f.bidder.address);

        // 项目禁止 renounceOwnership。
        await expect(
            f.auction.connect(f.owner).renounceOwnership(),
        ).to.be.revertedWithCustomError(
            f.auction,
            "OwnershipRequired",
        );

        // 第一步：owner 只设置 pendingOwner。
        await (
            await f.auction
                .connect(f.owner)
                .transferOwnership(f.other.address)
        ).wait();

        // 在 other accept 前，owner 仍是原 owner。
        expect(await f.auction.owner()).to.equal(f.owner.address);

        // 非 pending owner 不能 accept。
        await expect(
            f.auction.connect(f.bidder).acceptOwnership(),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "OwnableUnauthorizedAccount",
            )
            .withArgs(f.bidder.address);

        // 第二步：other 接受。
        await (
            await f.auction.connect(f.other).acceptOwnership()
        ).wait();

        expect(await f.auction.owner()).to.equal(f.other.address);

        // 原 owner 已失去管理权限。
        await expect(
            f.auction.connect(f.owner).pause(),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "OwnableUnauthorizedAccount",
            )
            .withArgs(f.owner.address);
    });

    // ==========================================================================
    // 23. 更新价格配置时保留 disabled 状态，并使用新 feed
    // ==========================================================================
    it("ConfigUpdatePreservesDisabledStateAndUsesNewFeed", async function () {
        const f = await loadFixture(deployFixture);

        const Feed: any = await ethers.getContractFactory(
            "HardhatAuctionFeed",
            f.owner,
        );

        const replacement: any = await Feed.deploy();
        await replacement.waitForDeployment();

        await (await replacement.setDecimals(6)).wait();

        const now = await networkHelpers.time.latest();
        await (await replacement.set(2_000_000n, now)).wait();

        await (
            await f.auction
                .connect(f.owner)
                .setTokenEnabled(SEPOLIA_USDC, false)
        ).wait();

        await (
            await f.auction
                .connect(f.owner)
                .configureToken(
                    SEPOLIA_USDC,
                    await replacement.getAddress(),
                    2 * HOUR,
                )
        ).wait();

        const config = await f.auction.priceConfigs(
            SEPOLIA_USDC,
        );

        expect(config.configuredFeed ?? config[0])
            .to.equal(await replacement.getAddress());

        expect(config.tokenDecimals ?? config[1]).to.equal(6n);
        expect(config.feedDecimals ?? config[2]).to.equal(6n);
        expect(config.enabled ?? config[3]).to.equal(false);
        expect(config.maxAge ?? config[4]).to.equal(BigInt(2 * HOUR));

        expect(
            await f.auction.quoteUsd(
                SEPOLIA_USDC,
                1_000_000n,
            ),
        ).to.equal(2n * 10n ** 18n);
    });

    // ==========================================================================
    // 24. maxAge / feed 更新不能篡改已有 bid 的历史 USD 值
    // ==========================================================================
    it("MaxAgeUpdateRestoresQuoteWithoutChangingExistingBid", async function () {
        const f = await loadFixture(deployFixture);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        let now = await networkHelpers.time.latest();
        const staleAt = BigInt(now - HOUR - 1);

        await (await f.feed.set(100_000_000n, staleAt)).wait();

        await expect(
            f.auction.quoteUsd(ZERO, ethers.parseEther("1")),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "StalePrice",
            )
            .withArgs(staleAt);

        // 扩大 maxAge 后，同一个 feed 重新变为可用。
        await (
            await f.auction
                .connect(f.owner)
                .configureToken(
                    ZERO,
                    await f.feed.getAddress(),
                    2 * HOUR,
                )
        ).wait();

        expect(
            await f.auction.quoteUsd(
                ZERO,
                ethers.parseEther("1"),
            ),
        ).to.equal(ethers.parseEther("1"));

        const Feed: any = await ethers.getContractFactory(
            "HardhatAuctionFeed",
            f.owner,
        );

        const replacement: any = await Feed.deploy();
        await replacement.waitForDeployment();

        now = await networkHelpers.time.latest();
        await (
            await replacement.set(200_000_000n, BigInt(now))
        ).wait();

        await (
            await f.auction
                .connect(f.owner)
                .configureToken(
                    ZERO,
                    await replacement.getAddress(),
                    HOUR,
                )
        ).wait();

        // 旧 bid 的 USD 价值不能因为 feed 更新而被重算。
        expect(
            (await f.auction.getAuction(f.id)).highestBidUsd,
        ).to.equal(ethers.parseEther("1"));

        expect(
            (await f.auction.getBid(f.id, f.bidder.address)).amount,
        ).to.equal(ethers.parseEther("1"));

        // 新 feed: 1 ETH = 2 USD。
        // other 只出 0.75 ETH，但 USD 价值 = 1.5，超过旧的 1。
        await bidEth(
            f,
            f.other,
            f.id,
            ethers.parseEther("0.75"),
        );

        expect(
            (await f.auction.getAuction(f.id)).highestBidUsd,
        ).to.equal(ethers.parseEther("1.5"));

        expect(await f.auction.totalLiabilities(ZERO)).to.equal(
            ethers.parseEther("1.75"),
        );

        await endAuction(f, f.id);
        await (await f.auction.settleAuction(f.id)).wait();

        // seller 收到的是 winner 实际支付的 0.75 ETH，而不是 1.5。
        expect(
            await f.auction.proceeds(f.owner.address, ZERO),
        ).to.equal(ethers.parseEther("0.75"));

        // loser 取回原来的 1 ETH。
        await (
            await f.auction
                .connect(f.bidder)
                .withdrawBid(f.id, f.bidder.address)
        ).wait();
    });

    // ==========================================================================
    // 25. 无效 config 更新必须完整回滚
    // ==========================================================================
    it("InvalidConfigUpdateLeavesPreviousConfigIntact", async function () {
        const f = await loadFixture(deployFixture);

        const Feed: any = await ethers.getContractFactory(
            "HardhatAuctionFeed",
            f.owner,
        );

        const replacement: any = await Feed.deploy();
        await replacement.waitForDeployment();

        const now = await networkHelpers.time.latest();
        await (await replacement.set(0n, now)).wait();

        await expect(
            f.auction
                .connect(f.owner)
                .configureToken(
                    ZERO,
                    await replacement.getAddress(),
                    2 * HOUR,
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidPrice",
        );

        // 原配置没有被破坏。
        let config = await f.auction.priceConfigs(ZERO);

        expect(config.configuredFeed ?? config[0])
            .to.equal(await f.feed.getAddress());
        expect(config.enabled ?? config[3]).to.equal(true);
        expect(config.maxAge ?? config[4]).to.equal(BigInt(HOUR));

        // maxAge == 0
        await expect(
            f.auction
                .connect(f.owner)
                .configureToken(
                    ZERO,
                    await f.feed.getAddress(),
                    0,
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidPriceConfig",
        );

        // feed 地址不是合约。
        await expect(
            f.auction
                .connect(f.owner)
                .configureToken(
                    ZERO,
                    f.other.address,
                    HOUR,
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidPriceConfig",
        );

        // 未支持的 token 地址。
        await expect(
            f.auction
                .connect(f.owner)
                .configureToken(
                    f.other.address,
                    await f.feed.getAddress(),
                    HOUR,
                ),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "UnsupportedToken",
            )
            .withArgs(f.other.address);

        // 真实 Circle USDC 的 decimals 不应该、也不能由测试随意修改。
        // 这个异常元数据场景使用明确命名的 MutableDecimalsTestToken：
        // 先以 6 decimals 成功配置，再人为改成 18，验证重新配置会被拒绝。
        const MutableToken: any = await ethers.getContractFactory(
            "HardhatMutableDecimalsTestToken",
            f.owner,
        );

        const mutableToken: any = await MutableToken.deploy();
        await mutableToken.waitForDeployment();

        await (
            await f.auction
                .connect(f.owner)
                .configureToken(
                    await mutableToken.getAddress(),
                    await f.feed.getAddress(),
                    HOUR,
                )
        ).wait();

        await (await mutableToken.setDecimals(18)).wait();

        await expect(
            f.auction
                .connect(f.owner)
                .configureToken(
                    await mutableToken.getAddress(),
                    await f.feed.getAddress(),
                    HOUR,
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidPriceConfig",
        );
    });

    // ==========================================================================
    // 26. 只有 owner 能修改已有价格配置
    // ==========================================================================
    it("OnlyOwnerCanUpdateExistingPriceConfig", async function () {
        const f = await loadFixture(deployFixture);

        await expect(
            f.auction
                .connect(f.bidder)
                .configureToken(
                    ZERO,
                    await f.feed.getAddress(),
                    2 * HOUR,
                ),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "OwnableUnauthorizedAccount",
            )
            .withArgs(f.bidder.address);
    });

    // ==========================================================================
    // 27. ETH recipient 无法在付款回调里重入 placeBid
    // ==========================================================================
    it("ReentrantETHRecipientCannotPlaceBidDuringPayment", async function () {
        const f = await loadFixture(deployFixture);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await bidEth(
            f,
            f.other,
            f.id,
            ethers.parseEther("2"),
        );

        const Recipient: any = await ethers.getContractFactory(
            "HardhatReentrantRecipient",
            f.owner,
        );

        const recipient: any = await Recipient.deploy(
            await f.auction.getAddress(),
            f.id,
        );
        await recipient.waitForDeployment();

        // bidder 是 loser，提现时把 ETH 发给恶意 recipient。
        await (
            await f.auction
                .connect(f.bidder)
                .withdrawBid(f.id, await recipient.getAddress())
        ).wait();

        // 恶意 recipient 的 receive() 中确实尝试过重入，
        // 但捕获到的是 ReentrancyGuardReentrantCall()。
        const expectedSelector = ethers
            .id("ReentrancyGuardReentrantCall()")
            .slice(0, 10);

        expect(await recipient.failure()).to.equal(
            expectedSelector,
        );

        expect(
            await ethers.provider.getBalance(
                await recipient.getAddress(),
            ),
        ).to.equal(ethers.parseEther("1"));

        // winner 的 2 ETH 仍然安全地记录在 liability 中。
        expect(await f.auction.totalLiabilities(ZERO)).to.equal(
            ethers.parseEther("2"),
        );
    });

    // ==========================================================================
    // 28. 测试专用恶意 ERC20：transferFrom 无法重入 settleAuction
    // ==========================================================================
    it("ReentrantTokenCannotSettleAnotherAuctionDuringDeposit", async function () {
        const f = await loadFixture(deployFixture);

        // 先让 id=1 到期，但保持 Active。
        await endAuction(f, f.id);
        const expiredId = f.id;

        // 创建 id=2。
        const second = await createAuction(f, 0n, HOUR);

        const now = await networkHelpers.time.latest();
        await (await f.feed.set(100_000_000n, now)).wait();

        const Malicious: any = await ethers.getContractFactory(
            "HardhatReentrantToken",
            f.owner,
        );

        // 这是专门模拟重入行为的测试 Token，不是真实 USDC。
        // bidder 的测试余额在部署时一次性分配，测试流程中不调用 mint()。
        const malicious: any = await Malicious.deploy(
            await f.auction.getAddress(),
            expiredId
        );
        await malicious.waitForDeployment();

        await (
            await malicious.mint(
                f.bidder.address,
                100_000_000n,
            )
        ).wait();

        await (
            await f.auction
                .connect(f.owner)
                .configureToken(
                    await malicious.getAddress(),
                    await f.feed.getAddress(),
                    HOUR,
                )
        ).wait();

        await (
            await malicious
                .connect(f.bidder)
                .approve(await f.auction.getAddress(), 1_000_000n)
        ).wait();

        // placeBid -> malicious.transferFrom -> 尝试 settle expiredId。
        await (
            await f.auction
                .connect(f.bidder)
                .placeBid(
                    second.id,
                    await malicious.getAddress(),
                    1_000_000n,
                )
        ).wait();

        const expectedSelector = ethers
            .id("ReentrancyGuardReentrantCall()")
            .slice(0, 10);

        expect(await malicious.failure()).to.equal(
            expectedSelector,
        );

        // expired auction 没有被恶意 settle。
        expect(
            (await f.auction.getAuction(expiredId)).status,
        ).to.equal(STATUS_ACTIVE);

        expect(
            await f.auction.totalLiabilities(
                await malicious.getAddress(),
            ),
        ).to.equal(1_000_000n);
    });

    // ==========================================================================
    // 29. 不同 auction 的 bid 必须隔离；seller proceeds 可以聚合
    // ==========================================================================
    it("AuctionsKeepBidsSeparateAndAggregateSellerProceeds", async function () {
        const f = await loadFixture(deployFixture);

        const second = await createAuction(f, 0n, HOUR);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await bidEth(
            f,
            f.bidder,
            second.id,
            ethers.parseEther("2"),
        );

        expect(
            (await f.auction.getBid(f.id, f.bidder.address)).amount,
        ).to.equal(ethers.parseEther("1"));

        expect(
            (await f.auction.getBid(second.id, f.bidder.address))
                .amount,
        ).to.equal(ethers.parseEther("2"));

        await endAuction(f, f.id);
        await endAuction(f, second.id);

        await (await f.auction.settleAuction(f.id)).wait();
        await (await f.auction.settleAuction(second.id)).wait();

        // 两个拍卖都是同一个 seller，因此 proceeds 汇总成 3 ETH。
        expect(
            await f.auction.proceeds(f.owner.address, ZERO),
        ).to.equal(ethers.parseEther("3"));

        expect(await f.auction.totalLiabilities(ZERO)).to.equal(
            ethers.parseEther("3"),
        );

        await (
            await f.auction
                .connect(f.owner)
                .withdrawProceeds(ZERO, f.other.address)
        ).wait();

        expect(await f.auction.totalLiabilities(ZERO)).to.equal(0n);

        expect(
            await ethers.provider.getBalance(
                await f.auction.getAddress(),
            ),
        ).to.equal(0n);
    });

    // ==========================================================================
    // 30. Stale price 必须在真实 USDC 真正转账前失败；0 bid 被拒绝
    // ==========================================================================
    it("StaleBidFailsBeforeMovingERC20AndZeroBidRejected", async function () {
        const f = await loadFixture(deployFixture);

        const now = await networkHelpers.time.latest();
        const staleAt = BigInt(now - HOUR - 1);

        await (await f.feed.set(100_000_000n, staleAt)).wait();

        await expect(
            f.auction
                .connect(f.bidder)
                .placeBid(
                    f.id,
                    SEPOLIA_USDC,
                    1_000_000n,
                ),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "StalePrice",
            )
            .withArgs(staleAt);

        // Oracle 检查应发生在真实 USDC transferFrom 之前，因此余额完全没动。
        const bidderBalanceBefore = f.bidderUsdcStart;
        const auctionBalanceBefore = await f.usdc.balanceOf(
            await f.auction.getAddress(),
        );

        expect(await f.usdc.balanceOf(f.bidder.address))
            .to.equal(bidderBalanceBefore);

        expect(
            await f.usdc.balanceOf(await f.auction.getAddress()),
        ).to.equal(auctionBalanceBefore);

        await expect(
            f.auction
                .connect(f.bidder)
                .placeBid(f.id, ZERO, 0n),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidAmount",
        );
    });

    // ==========================================================================
    // 31. 非法 refund recipient 不能销毁用户 credit
    // ==========================================================================
    it("InvalidRefundRecipientsCannotDestroyCredit", async function () {
        const f = await loadFixture(deployFixture);

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        await bidEth(
            f,
            f.other,
            f.id,
            ethers.parseEther("2"),
        );

        await expect(
            f.auction
                .connect(f.bidder)
                .withdrawBid(f.id, ZERO),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidAddress",
        );

        await expect(
            f.auction
                .connect(f.bidder)
                .withdrawBid(f.id, await f.auction.getAddress()),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidAddress",
        );

        // 两次失败都必须保留 bidder 的 1 ETH credit。
        expect(
            (await f.auction.getBid(f.id, f.bidder.address)).amount,
        ).to.equal(ethers.parseEther("1"));

        expect(await f.auction.totalLiabilities(ZERO)).to.equal(
            ethers.parseEther("3"),
        );
    });

    // ==========================================================================
    // 32. UUPS 初始化与升级必须保留代理 storage
    // ==========================================================================
    it("UUPSInitializationAndUpgradePreserveState", async function () {
        const f = await loadFixture(deployFixture);

        // 新部署的 implementation 构造时应该 _disableInitializers()。
        const rawImplementation: any = await f.Auction
            .connect(f.owner)
            .deploy();

        await rawImplementation.waitForDeployment();

        await expect(
            rawImplementation.initialize(f.bidder.address),
        ).to.be.revertedWithCustomError(
            rawImplementation,
            "InvalidInitialization",
        );

        // 已经初始化过的 proxy 也不能 initialize 第二次。
        await expect(
            f.auction
                .connect(f.owner)
                .initialize(f.bidder.address),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidInitialization",
        );

        // owner == zero 的初始化必须失败。
        const badInit = f.Auction.interface.encodeFunctionData(
            "initialize",
            [ZERO],
        );

        await expect(
            f.Proxy
                .connect(f.owner)
                .deploy(
                    await rawImplementation.getAddress(),
                    badInit,
                ),
        ).to.be.revertedWithCustomError(
            f.auction,
            "InvalidAddress",
        );

        await bidEth(
            f,
            f.bidder,
            f.id,
            ethers.parseEther("1"),
        );

        const V2: any = await ethers.getContractFactory(
            "HardhatAuctionTestV2",
            f.owner,
        );

        const next: any = await V2.deploy();
        await next.waitForDeployment();

        // 非 owner 不能升级。
        await expect(
            f.auction
                .connect(f.bidder)
                .upgradeToAndCall(
                    await next.getAddress(),
                    "0x",
                ),
        )
            .to.be.revertedWithCustomError(
                f.auction,
                "OwnableUnauthorizedAccount",
            )
            .withArgs(f.bidder.address);

        // feed 不是合法 UUPS implementation。
        await expect(
            f.auction
                .connect(f.owner)
                .upgradeToAndCall(
                    await f.feed.getAddress(),
                    "0x",
                ),
        ).to.revert(ethers);

        // 正常升级，并在同一笔交易里调用 reinitializer(2)。
        const initV2Data = V2.interface.encodeFunctionData(
            "initializeV2",
            [42n],
        );

        await (
            await f.auction
                .connect(f.owner)
                .upgradeToAndCall(
                    await next.getAddress(),
                    initV2Data,
                )
        ).wait();

        const upgraded: any = V2.attach(
            await f.auction.getAddress(),
        );

        expect(await upgraded.version()).to.equal(2n);
        expect(await upgraded.marker()).to.equal(42n);

        // 代理原有 storage 必须全部保留。
        expect(await upgraded.owner()).to.equal(f.owner.address);

        expect(
            (await upgraded.getBid(f.id, f.bidder.address)).amount,
        ).to.equal(ethers.parseEther("1"));

        expect(await upgraded.totalLiabilities(ZERO)).to.equal(
            ethers.parseEther("1"),
        );

        // 升级以后旧业务仍然可正常走完。
        await endAuction(
            {...f, auction: upgraded},
            f.id,
        );

        await (await upgraded.settleAuction(f.id)).wait();

        await (
            await upgraded
                .connect(f.owner)
                .withdrawProceeds(ZERO, f.bidder.address)
        ).wait();

        await (
            await upgraded
                .connect(f.bidder)
                .claimNFT(f.id, f.other.address)
        ).wait();

        expect(await f.nft.ownerOf(f.tokenId)).to.equal(
            f.other.address,
        );
    });

    // ==========================================================================
    // 33. 原 Foundry fuzz 测试的 Hardhat 参数化版本
    // ==========================================================================
    const cases: Array<[bigint, bigint]> = [
        [1n, 2n],
        [10n, 11n],
        [10n ** 9n, 2n * 10n ** 9n],
        [ethers.parseEther("0.1"), ethers.parseEther("0.2")],
        [ethers.parseEther("1"), ethers.parseEther("2")],
        [ethers.parseEther("5"), ethers.parseEther("7")],
        [ethers.parseEther("10"), ethers.parseEther("20")],
    ];

    for (const [a, b] of cases) {
        it(
            `LiabilitiesConservedAcrossRefundAndSettlement a=${a} b=${b}`,
            async function () {
                const f = await loadFixture(deployFixture);

                const created = await createAuction(
                    f,
                    0n,
                    HOUR,
                );

                await bidEth(
                    f,
                    f.bidder,
                    created.id,
                    a,
                );

                await bidEth(
                    f,
                    f.other,
                    created.id,
                    b,
                );

                expect(
                    await f.auction.totalLiabilities(ZERO),
                ).to.equal(a + b);

                expect(
                    await ethers.provider.getBalance(
                        await f.auction.getAddress(),
                    ),
                ).to.equal(a + b);

                await endAuction(
                    f,
                    created.id,
                );

                await (
                    await f.auction.settleAuction(
                        created.id,
                    )
                ).wait();

                await (
                    await f.auction
                        .connect(f.bidder)
                        .withdrawBid(
                            created.id,
                            f.bidder.address,
                        )
                ).wait();

                expect(
                    await f.auction.totalLiabilities(ZERO),
                ).to.equal(b);

                await (
                    await f.auction
                        .connect(f.owner)
                        .withdrawProceeds(
                            ZERO,
                            f.owner.address,
                        )
                ).wait();

                expect(
                    await f.auction.totalLiabilities(ZERO),
                ).to.equal(0n);

                expect(
                    await ethers.provider.getBalance(
                        await f.auction.getAddress(),
                    ),
                ).to.equal(0n);
            },
        );
    }

    // ==========================================================================
    // 34. NFT burn
    // ==========================================================================
    it("burnNFT", async function () {
        const f = await loadFixture(deployFixture);

        await (await f.nft.connect(f.owner).mint(f.owner.address)).wait();

        const balance = await f.nft.balanceOf(f.owner.address);

        const tokenId = await f.nft.tokenOfOwnerByIndex(
            f.owner.address,
            balance - 1n,
        );

        await (await f.nft.connect(f.owner).burn(tokenId)).wait();

        // burn 后 ownerOf 应当失败。
        await expect(
            f.nft.ownerOf(tokenId),
        ).to.revert(ethers);
    });
});
