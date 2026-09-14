import {buildModule} from "@nomicfoundation/hardhat-ignition/modules";


export default buildModule("JunNFTModule", (m) => {
    const maxSupply = m.getParameter<number>("maxSupply");
    const owner = m.getParameter<string>("owner");

    const implementation = m.contract("JunNFT", [], {id: "JunNFTImplementation"});
    const initialize = m.encodeFunctionCall(implementation, "initialize", [maxSupply, owner]);

    const proxy = m.contract("ERC1967Proxy", [implementation, initialize]);
    const junNFT = m.contractAt("JunNFT", proxy, {id: "JunNFTProxy"});

    return {implementation, proxy, junNFT};
});