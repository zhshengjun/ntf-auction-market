import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("AuctionModule", (m) => {
  const owner = m.getParameter<string>("owner");
  const implementation = m.contract("Auction", [], { id: "AuctionImplementation" });
  const initialize = m.encodeFunctionCall(implementation, "initialize", [owner]);
  const proxy = m.contract("ERC1967Proxy", [implementation, initialize]);
  const auction = m.contractAt("Auction", proxy, { id: "AuctionProxy" });
  return { implementation, proxy, auction };
});
