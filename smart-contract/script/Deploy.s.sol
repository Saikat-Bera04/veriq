// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DemoStorage} from "../src/DemoStorage.sol";

interface Vm {
    function envString(string calldata name) external returns (string memory value);
    function envUint(string calldata name) external returns (uint256 value);
    function envAddress(string calldata name) external returns (address value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract Deploy {
    Vm private constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant SEPOLIA_CHAIN_ID = 11_155_111;

    function run() external returns (DemoStorage deployed) {
        // The RPC URL is also passed to `forge script --rpc-url`; reading it
        // here validates that the documented environment is configured.
        string memory rpcUrl = vm.envString("SEPOLIA_RPC_URL");
        require(bytes(rpcUrl).length != 0, "SEPOLIA_RPC_URL is required");
        uint256 privateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address demoAddress = vm.envAddress("VERIQ_DEMO_ADDRESS");
        require(demoAddress != address(0), "VERIQ_DEMO_ADDRESS must not be zero");
        require(block.chainid == SEPOLIA_CHAIN_ID, "deployment must target Sepolia");

        vm.startBroadcast(privateKey);
        deployed = new DemoStorage();
        deployed.setCounter(42);
        deployed.setBalance(demoAddress, 7);
        vm.stopBroadcast();
    }
}
