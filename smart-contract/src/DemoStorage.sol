// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal storage-layout fixture for Veriq's storage-proof demo.
contract DemoStorage {
    // Keep this declaration first: counter is committed at storage slot 0.
    uint256 public counter;

    // Keep this declaration second: balances uses mapping base slot 1.
    mapping(address => uint256) public balances;

    function setCounter(uint256 value) external {
        counter = value;
    }

    function setBalance(address account, uint256 value) external {
        balances[account] = value;
    }
}
