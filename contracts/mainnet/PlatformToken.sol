// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PlatformToken
/// @notice Base mainnet JC / AE: a plain 18-decimal ERC20 with no transfer restrictions,
///         no stored addresses, no pause, no fees and no supply cap.
///         - Only the owner (the platform Safe) can mint, and minting always goes to the owner itself.
///         - Anyone, including the owner, can only burn their own balance.
///         - Ownership moves in two steps (transferOwnership + acceptOwnership) and can never be renounced.
///         All business rules live in replaceable contracts (P2P escrow, RWA factory), never here.
abstract contract PlatformToken is ERC20, Ownable2Step {
    error ZeroAmount();
    error RenounceDisabled();

    constructor(string memory name_, string memory symbol_, address initialOwner)
        ERC20(name_, symbol_)
        Ownable(initialOwner)
    {}

    /// @notice Mint new supply to the owner (the Safe). There is no way to mint to anyone else.
    function mint(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        _mint(owner(), amount);
    }

    /// @notice Burn the caller's own balance. Nobody can burn tokens held by another address.
    function burn(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount);
    }

    /// @dev Ownership must always stay with a Safe; renouncing would freeze minting forever.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
