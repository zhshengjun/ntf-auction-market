import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

import {configVariable, defineConfig,} from "hardhat/config";

const sepoliaFork = {
    url:
        configVariable(
            "SEPOLIA_RPC_URL",
        ),
};

export default defineConfig({
    plugins: [
        hardhatToolboxMochaEthersPlugin,
    ],

    solidity: {
        npmFilesToBuild: [
            "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
        ],

        profiles: {
            default: {
                version: "0.8.36",

                settings: {
                    evmVersion: "cancun",

                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },

                    outputSelection: {
                        "*": {
                            "*": [
                                "storageLayout",
                            ],
                        },
                    },
                },
            },

            production: {
                version: "0.8.36",

                settings: {
                    evmVersion: "cancun",

                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },

                    outputSelection: {
                        "*": {
                            "*": [
                                "storageLayout",
                            ],
                        },
                    },
                },
            },
        },
    },

    networks: {
        // 专门给测试使用的 Sepolia Fork。
        sepoliaFork: {
            type: "edr-simulated",
            chainType: "l1",
            chainId: 11155111,
            forking: sepoliaFork,
        },

        // 普通本地 Ethereum 模拟网络。
        hardhatMainnet: {
            type: "edr-simulated",
            chainType: "l1",
        },

        // OP 风格模拟网络。
        hardhatOp: {
            type: "edr-simulated",
            chainType: "op",
        },

        // 真正连接 Sepolia 公网。
        // 注意：测试 fork 不会使用这里。
        sepolia: {
            type: "http",
            chainType: "l1",

            url: configVariable(
                "SEPOLIA_RPC_URL",
            ),

            accounts: [
                configVariable(
                    "SEPOLIA_PRIVATE_KEY",
                ),
            ],
        },
    },

    verify: {
        etherscan: {
            apiKey: configVariable(
                "ETHERSCAN_API_KEY",
            ),
        },
    },
});