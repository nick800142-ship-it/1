// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * RWAShareToken —— 每個私募標的一顆的 RWA 份額代幣。
 *
 * - decimals 可自訂（對應後台每標的的「Token Decimals」欄位）。
 * - 只有部署它的 Factory 能 mint，且僅在 createRWAToken 當下鑄一次「全額」給 Safe 金庫。
 * - 持有人不能自行 burn，避免鏈上銷毀造成站內 holdings 不一致；下架回收及 Safe 庫存銷毀
 *   均由 Factory 管理，Factory 只能對 Safe 庫存執行 burn。一般移轉仍是標準 ERC20。
 */
contract RWAShareToken is ERC20 {
    address public immutable factory;
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address factory_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
        factory = factory_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == factory, "RWAShareToken: only factory");
        _mint(to, amount);
    }

    /// 下架強制回收：僅 Factory 可呼叫，不需持有人授權，把 from 的份額移到 to（Safe 金庫）。
    function forceTransfer(address from, address to, uint256 amount) external {
        require(msg.sender == factory, "RWAShareToken: only factory");
        _transfer(from, to, amount);
    }

    /// Factory 只能銷毀其指定金庫中的庫存，不能銷毀任意持有人資產。
    function burnVaultInventory(address vault, uint256 amount) external {
        require(msg.sender == factory, "RWAShareToken: only factory");
        _burn(vault, amount);
    }
}

/**
 * RWAFactory —— 一標的一顆代幣的工廠 + 通用結算入口。
 *
 * 份額流向（對齊 JC/AE 的「先鑄進金庫，之後都是轉帳」模式）：
 *  - createRWAToken() 部署新代幣時，一次把該標的「全額」份額鑄給 Safe 金庫
 *    （之後不再 mint；未售庫存可由 Factory owner 從 Safe 金庫銷毀，總供給只會減少）。
 *  - 使用者流程：建立標的後，操作者自行用 Safe{Wallet} 把份額從 Safe 轉到
 *    後端營運熱錢包（ADMIN，即本合約 owner）保管，此步驟完全在 Safe/熱錢包
 *    介面完成，不經過本合約或任何網站。
 *  - 一級認購 subscribe()：買方付款進 Safe 金庫，份額則從「owner（熱錢包）」
 *    transferFrom 給買方 —— 因此 owner 需先對本合約 approve 該標的代幣額度
 *    （比照 JC/AE 讓 Safe 對 ADMIN approve 的模式，這裡改成熱錢包對 Factory approve）。
 *  - 二級成交 trade()：賣方持有的份額 transferFrom 給買方，買方付款 transferFrom
 *    給賣方／手續費收款方 —— 賣方與買方各自 approve 給本工廠，owner 私鑰外洩也
 *    無法動用未授權使用者的份額或資金。
 *
 * 支付貨幣「不」寫死在合約狀態裡：subscribe()/trade() 都把 `currency`
 * （ERC20 合約地址）當成呼叫參數傳入，而不是建構子固定值或需要 onlyOwner
 * 才能改的狀態變數。現在後端傳 JC 地址就是用 JC 結算；未來如果換一顆結算幣
 * （或甚至同時支援多幣），後端只要在呼叫時傳不同的 `currency` 地址即可，
 * 完全不需要重新部署或升級這顆合約。
 *
 * owner = 後端營運熱錢包（ADMIN_PRIVATE_KEY 對應地址）；所有結算入口都是 onlyOwner，
 * 金額、對手方、幣種一律由後端從既有帳本推導後帶入，不信任前端數字。
 */
contract RWAFactory is Ownable, ReentrancyGuard {
    address public safeVault; // 建立標的時份額的首次鑄造去向（庫存金庫）
    address public feeRecipient; // 二級手續費收款

    // placementId（後台私募標的 id 字串）=> 子代幣地址
    mapping(string => address) public tokenByPlacement;
    mapping(address => bool) public isFactoryToken;
    address[] public allTokens;

    event RWATokenCreated(
        string placementId,
        address indexed token,
        string name,
        string symbol,
        uint8 decimals,
        uint256 totalSupply
    );
    event Subscribed(
        address indexed token, address indexed currency, address indexed buyer, uint256 shareAmount, uint256 payment
    );
    event Traded(
        address indexed token,
        address indexed currency,
        address indexed seller,
        address buyer,
        uint256 shareAmount,
        uint256 paymentToSeller,
        uint256 feeAmount
    );

    constructor(address vault, address fee) Ownable(msg.sender) {
        require(vault != address(0) && fee != address(0), "RWAFactory: zero addr");
        safeVault = vault;
        feeRecipient = fee;
    }

    /// 為一個新私募標的部署一顆專屬份額代幣（對應後台的 Token Name/Symbol/Decimals），
    /// 並把該標的「全額」份額（totalSupply）一次鑄給 Safe 金庫（供給量從此固定）。
    function createRWAToken(
        string calldata placementId,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        uint256 totalSupply_
    ) external onlyOwner returns (address token) {
        require(tokenByPlacement[placementId] == address(0), "RWAFactory: placement exists");
        require(totalSupply_ > 0, "RWAFactory: zero supply");
        RWAShareToken deployed = new RWAShareToken(name_, symbol_, decimals_, address(this));
        token = address(deployed);
        tokenByPlacement[placementId] = token;
        isFactoryToken[token] = true;
        allTokens.push(token);
        deployed.mint(safeVault, totalSupply_);
        emit RWATokenCreated(placementId, token, name_, symbol_, decimals_, totalSupply_);
    }

    /// 一級認購：收 `currency`（呼叫時指定的結算幣，例如 JC）進金庫；份額則從
    /// owner（熱錢包，需已持有並 approve 給本工廠）transferFrom 給買方。
    function subscribe(address token, address currency, address buyer, uint256 shareAmount, uint256 payment)
        external
        onlyOwner
        nonReentrant
    {
        require(isFactoryToken[token], "RWAFactory: unknown token");
        require(currency != address(0), "RWAFactory: zero currency");
        require(buyer != address(0), "RWAFactory: zero buyer");
        require(shareAmount > 0, "RWAFactory: zero shares");
        if (payment > 0) {
            require(IERC20(currency).transferFrom(buyer, safeVault, payment), "RWAFactory: currency pull failed");
        }
        require(IERC20(token).transferFrom(owner(), buyer, shareAmount), "RWAFactory: share transfer failed");
        emit Subscribed(token, currency, buyer, shareAmount, payment);
    }

    /// 二級成交：賣方 approve 份額代幣、買方 approve 這次用的 currency，皆給本工廠。
    function trade(
        address token,
        address currency,
        address seller,
        address buyer,
        uint256 shareAmount,
        uint256 paymentToSeller,
        uint256 feeAmount
    ) external onlyOwner nonReentrant {
        require(isFactoryToken[token], "RWAFactory: unknown token");
        require(currency != address(0), "RWAFactory: zero currency");
        require(seller != address(0) && buyer != address(0), "RWAFactory: zero addr");
        require(shareAmount > 0, "RWAFactory: zero shares");
        require(IERC20(token).transferFrom(seller, buyer, shareAmount), "RWAFactory: share move failed");
        if (paymentToSeller > 0) {
            require(
                IERC20(currency).transferFrom(buyer, seller, paymentToSeller), "RWAFactory: currency to seller failed"
            );
        }
        if (feeAmount > 0) {
            require(
                IERC20(currency).transferFrom(buyer, feeRecipient, feeAmount), "RWAFactory: currency fee failed"
            );
        }
        emit Traded(token, currency, seller, buyer, shareAmount, paymentToSeller, feeAmount);
    }

    event SharesBurned(address indexed token, uint256 amount);

    /// 僅銷毀 Safe 金庫中該標的尚未售出的份額；用戶資產不受影響。
    function burnVaultInventory(address token, uint256 amount) external onlyOwner nonReentrant {
        require(isFactoryToken[token], "RWAFactory: unknown token");
        require(amount > 0, "RWAFactory: zero amount");
        RWAShareToken(token).burnVaultInventory(safeVault, amount);
        emit SharesBurned(token, amount);
    }

    event SharesReclaimed(address indexed token, address indexed holder, uint256 amount);

    /// 標的下架時強制把持有人全部份額收回 Safe 金庫（不需持有人 approve）。
    function reclaimShares(address token, address holder) external onlyOwner nonReentrant returns (uint256 amount) {
        require(isFactoryToken[token], "RWAFactory: unknown token");
        require(holder != address(0) && holder != safeVault, "RWAFactory: bad holder");
        amount = IERC20(token).balanceOf(holder);
        if (amount > 0) {
            RWAShareToken(token).forceTransfer(holder, safeVault, amount);
            emit SharesReclaimed(token, holder, amount);
        }
    }

    // ---- views ----
    function totalTokens() external view returns (uint256) {
        return allTokens.length;
    }

    function getTokens(uint256 offset, uint256 limit) external view returns (address[] memory out) {
        uint256 n = allTokens.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        out = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = allTokens[i];
        }
    }

    // ---- admin setters ----
    function setSafeVault(address v) external onlyOwner {
        require(v != address(0), "RWAFactory: zero addr");
        safeVault = v;
    }

    function setFeeRecipient(address v) external onlyOwner {
        require(v != address(0), "RWAFactory: zero addr");
        feeRecipient = v;
    }
}
