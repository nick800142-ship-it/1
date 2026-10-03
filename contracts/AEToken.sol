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
 * 供給模式：部署時先把「初始總量」鑄給 `initialVault`（通常是 Safe 金庫）。
 * owner（ADMIN 熱錢包）保留 `mint` 權限，之後可依需要再增發給任意地址
 * （例如金庫餘額不足時補充）。一級認購、二級成交平時仍是從既有餘額轉帳，
 * mint 僅在 owner 主動呼叫時才會增加供給量。
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

    /// @notice owner 專用：增發 AE 給任意地址（例如補充金庫庫存）。
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice owner 專用：強制把任意地址持有的 AE 收回（不受 allowance 限制）。
    /// 用於「AE 歸零」等管理操作：即使持有人從未對 owner 做過 approve，
    /// 平台仍能把 AE 收回金庫，確保下架/歸零時份額一定能被收回。
    function adminReclaim(address from, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "AEToken: zero to");
        _transfer(from, to, amount);
    }
}
