// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * JCToken —— 全站購買/分潤用的平台幣（JC），標準 ERC20，無任何轉帳限制。
 *
 * 取代舊版 JC_Token（該版合約內建「P2P transfers are restricted」規則，只允許
 * 跟 owner 有關的轉帳方向，導致使用者對使用者的直接轉帳一律 revert，二級市場
 * 與贖回都因此要繞兩跳才能動）。新版移除該限制，任何持有者對任何地址的
 * transfer/transferFrom 都遵循標準 ERC20 規則（僅受 allowance 與餘額限制）。
 *
 * 供給模式：部署時一次把「全額」鑄給 `initialVault`（通常是 Safe 金庫），
 * 之後不再有任何 mint，供給量從此固定。所有發放（金庫買幣、分潤、認購找零等）
 * 都是從既有餘額轉帳，不會無上限增發。
 */
contract JCToken is ERC20, Ownable {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address initialVault, uint256 totalSupply_)
        ERC20(name_, symbol_)
        Ownable(msg.sender)
    {
        require(initialVault != address(0), "JCToken: zero vault");
        require(totalSupply_ > 0, "JCToken: zero supply");
        _decimals = decimals_;
        _mint(initialVault, totalSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
