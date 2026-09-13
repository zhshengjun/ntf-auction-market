import assert from "node:assert/strict";
import { network } from "hardhat";
import AuctionModule from "../ignition/modules/Auction.js";

describe("Auction proxy deployment", function () {
  it("initializes the proxy atomically with an explicit owner and deployable bytecode", async function () {
    const { ethers, ignition } = await network.create();
    const [, owner] = await ethers.getSigners();
    const { auction, implementation, proxy } = await ignition.deploy(AuctionModule, {
      parameters: { AuctionModule: { owner: owner.address } },
    });
    assert.equal(await auction.owner(), owner.address);
    assert.equal(await auction.getAddress(), await proxy.getAddress());
    assert.notEqual(await auction.getAddress(), await implementation.getAddress());
    assert.equal(await implementation.owner(), ethers.ZeroAddress);
    const code = await ethers.provider.getCode(await implementation.getAddress());
    assert.ok((code.length - 2) / 2 <= 24_576, "Implementation exceeds EIP-170 size limit");
  });
});
