// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * AEToken —— 以 JC 計價的一般標的代幣（AE），標準 ERC20，無任何轉帳限制。
 *
 * 取代舊版 AE_Token（該版合約內建「AE: Private P2P transfers are restricted」
 * 規則，只允許跟 owner 有關的轉帳方向，導致二級市場「賣方→買方」的直接
 * transferFrom 一律 revert，AE 二級市場完全無法正常交割）。新版移除該限制，
 * 任何持有者對任何地址的 transfer/transferFrom 都遵循標準 ERC20 規則
 * （僅受 allowance 與餘額限制），二級市場可以直接 transferFrom(賣方→買方)
 * 一次交割，不需要再繞兩跳經過 ADMIN。
 *
 * 供給模式：部署時一次把「全額」鑄給 `initialVault`（通常是 Safe 金庫），
 * 之後不再有任何 mint，供給量從此固定。一級認購、二級成交都是從既有餘額
 * 轉帳，不會無上限增發。
 */
contract AEToken is ERC20, Ownable {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address initialVault, uint256 totalSupply_)
        ERC20(name_, symbol_)
        Ownable(msg.sender)
    {
        require(initialVault != address(0), "AEToken: zero vault");
        require(totalSupply_ > 0, "AEToken: zero supply");
        _decimals = decimals_;
        _mint(initialVault, totalSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
