// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlatformToken} from "./PlatformToken.sol";

/// @title AEToken
/// @notice AE token on Base mainnet. Same permissions as JC (see PlatformToken); there is no
///         forced reclaim — nobody can move or burn AE held by users.
contract AEToken is PlatformToken {
    constructor(address initialOwner) PlatformToken("AE Token", "AE", initialOwner) {}
}
