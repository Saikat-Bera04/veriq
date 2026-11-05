// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DemoStorage} from "../src/DemoStorage.sol";

interface Vm {
    function load(address target, bytes32 slot) external returns (bytes32);
}

contract DemoStorageTest {
    Vm private constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    DemoStorage private demo;

    function setUp() public {
        demo = new DemoStorage();
    }

    function testCounterIsStoredAtSlotZero() public {
        demo.setCounter(42);

        bytes32 raw = vm.load(address(demo), bytes32(uint256(0)));
        require(uint256(raw) == 42, "counter must be stored at slot 0");
        require(demo.counter() == 42, "counter getter must return stored value");
    }

    function testBalancesMappingUsesSlotOne() public {
        address account = address(0x1234);
        demo.setBalance(account, 7);

        bytes32 mappingEntry = keccak256(abi.encode(account, uint256(1)));
        bytes32 raw = vm.load(address(demo), mappingEntry);
        require(uint256(raw) == 7, "mapping entry must use base slot 1");
        require(demo.balances(account) == 7, "mapping getter must return stored value");
    }

    function testSetAndReadCounterAndBalances() public {
        address account = address(0xBEEF);

        demo.setCounter(987654321);
        demo.setBalance(account, 123456789);

        require(demo.counter() == 987654321, "counter value mismatch");
        require(demo.balances(account) == 123456789, "balance value mismatch");
        require(
            uint256(vm.load(address(demo), bytes32(uint256(0)))) == 987654321,
            "raw counter slot mismatch"
        );
        require(
            uint256(vm.load(address(demo), keccak256(abi.encode(account, uint256(1)))))
                == 123456789,
            "raw mapping slot mismatch"
        );
    }
}
