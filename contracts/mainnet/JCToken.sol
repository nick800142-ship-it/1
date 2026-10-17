// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlatformToken} from "./PlatformToken.sol";

/// @title JCToken
/// @notice Platform settlement coin (JC) on Base mainnet. All permissions are defined in PlatformToken.
contract JCToken is PlatformToken {
    constructor(address initialOwner) PlatformToken("JC Coin", "JC", initialOwner) {}
}
