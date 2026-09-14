import assert from "node:assert/strict";
import {network} from "hardhat";
import AuctionModule from "../ignition/modules/Auction.js";
import JunNFTModule from "../ignition/modules/JunNFT.js";

describe("JunNFT proxy deployment on Sepolia fork", function () {
    this.timeout(60_000);
    it("initializes the proxy atomically with an explicit owner and deployable bytecode", async function () {
        const {ethers, ignition} = await network.create("sepoliaFork");
        const [, owner] = await ethers.getSigners();
        const {implementation, proxy, junNFT} = await ignition.deploy(JunNFTModule, {
            parameters: {JunNFTModule: {maxSupply: 1000, owner: owner.address}},
        });
        assert.equal(await junNFT.owner(), owner.address);
        assert.equal(await junNFT.getAddress(), await proxy.getAddress());
        assert.notEqual(await junNFT.getAddress(), await implementation.getAddress());
        assert.equal(await implementation.owner(), ethers.ZeroAddress);
        const code = await ethers.provider.getCode(await implementation.getAddress());
        assert.ok((code.length - 2) / 2 <= 24_576, "Implementation exceeds EIP-170 size limit");
    });
});

describe("Auction proxy deployment on Sepolia fork", function () {
    this.timeout(60_000);
    it("initializes the proxy atomically with an explicit owner and deployable bytecode", async function () {
        const {ethers, ignition} = await network.create("sepoliaFork");
        const [, owner] = await ethers.getSigners();
        const {auction, implementation, proxy} = await ignition.deploy(AuctionModule, {
            parameters: {AuctionModule: {owner: owner.address}},
        });
        assert.equal(await auction.owner(), owner.address);
        assert.equal(await auction.getAddress(), await proxy.getAddress());
        assert.notEqual(await auction.getAddress(), await implementation.getAddress());
        assert.equal(await implementation.owner(), ethers.ZeroAddress);
        const code = await ethers.provider.getCode(await implementation.getAddress());
        assert.ok((code.length - 2) / 2 <= 24_576, "Implementation exceeds EIP-170 size limit");
    });
});