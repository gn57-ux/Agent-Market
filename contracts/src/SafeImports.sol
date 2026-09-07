// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

// Feature 21 (arbitration-committee), T-2103 (F-2112/F-2113, design.md
// v1.1 方案 B 决策): forces Hardhat to compile the REAL, UNMODIFIED
// official Gnosis Safe contracts (`@safe-global/safe-contracts@1.4.1`)
// as part of this project's own build — this file contains no logic of
// its own, it exists only so Hardhat's compiler discovers these imports
// (Hardhat only compiles `.sol` files it can trace from an import graph
// rooted in `contracts/src/`, never arbitrary `node_modules` contents on
// its own). `TaskEscrow.sol` itself is never modified to know about Safe
// (design.md's own point: "TaskEscrow 侧只看到 ARBITRATOR_ROLE 由一个地址
// 持有...完全不知道这个地址内部是 Safe 多签").
import "@safe-global/safe-contracts/contracts/Safe.sol";
import "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol";
