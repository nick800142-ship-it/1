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
 * - 只有部署它的 Factory 能 mint（一級認購時鑄給買方）。
 * - 其餘就是標準 ERC20：二級市場成交時買賣雙方用標準 transfer/transferFrom 移轉。
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
}

/**
 * RWAFactory —— 一標的一顆代幣的工廠 + JC 結算入口。
 *
 * 設計對齊本專案既有的鏈上模型：
 *  - owner = 後端營運熱錢包（ADMIN_PRIVATE_KEY 對應地址）；所有結算入口都是 onlyOwner，
 *    金額與對手方一律由後端從既有帳本推導後帶入，不信任前端數字。
 *  - 一級認購 subscribe()：買方先 approve JC 給本工廠（一次即可，所有標的共用），
 *    合約把 JC 收進 Safe 金庫並鑄出對應份額代幣給買方。
 *  - 二級成交 trade()：賣方掛單時 approve「該標的份額代幣」給本工廠、買方 approve JC 給本工廠。
 *    用 transferFrom 搬份額 + JC，因此即使 owner 私鑰外洩，也「無法」搬走任何未授權使用者
 *    的份額或 JC —— 只能動到已授權額度內的資產。
 */
contract RWAFactory is Ownable, ReentrancyGuard {
    IERC20 public jcToken; // 結算幣（JC）
    address public safeVault; // 一級認購 JC 收款金庫
    address public feeRecipient; // 二級手續費 JC 收款

    // placementId（後台私募標的 id 字串）=> 子代幣地址
    mapping(string => address) public tokenByPlacement;
    mapping(address => bool) public isFactoryToken;
    address[] public allTokens;

    event RWATokenCreated(
        string placementId, address indexed token, string name, string symbol, uint8 decimals
    );
    event Subscribed(address indexed token, address indexed buyer, uint256 shareAmount, uint256 jcPayment);
    event Traded(
        address indexed token,
        address indexed seller,
        address indexed buyer,
        uint256 shareAmount,
        uint256 jcToSeller,
        uint256 feeAmount
    );

    constructor(address jc, address vault, address fee) Ownable(msg.sender) {
        require(jc != address(0) && vault != address(0) && fee != address(0), "RWAFactory: zero addr");
        jcToken = IERC20(jc);
        safeVault = vault;
        feeRecipient = fee;
    }

    /// 為一個新私募標的部署一顆專屬份額代幣（對應後台的 Token Name/Symbol/Decimals）。
    function createRWAToken(
        string calldata placementId,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_
    ) external onlyOwner returns (address token) {
        require(tokenByPlacement[placementId] == address(0), "RWAFactory: placement exists");
        token = address(new RWAShareToken(name_, symbol_, decimals_, address(this)));
        tokenByPlacement[placementId] = token;
        isFactoryToken[token] = true;
        allTokens.push(token);
        emit RWATokenCreated(placementId, token, name_, symbol_, decimals_);
    }

    /// 一級認購：收 JC 進金庫並鑄份額給買方。買方需先 approve JC 給本工廠。
    function subscribe(address token, address buyer, uint256 shareAmount, uint256 jcPayment)
        external
        onlyOwner
        nonReentrant
    {
        require(isFactoryToken[token], "RWAFactory: unknown token");
        require(buyer != address(0), "RWAFactory: zero buyer");
        require(shareAmount > 0, "RWAFactory: zero shares");
        if (jcPayment > 0) {
            require(jcToken.transferFrom(buyer, safeVault, jcPayment), "RWAFactory: JC pull failed");
        }
        RWAShareToken(token).mint(buyer, shareAmount);
        emit Subscribed(token, buyer, shareAmount, jcPayment);
    }

    /// 二級成交：賣方 approve 份額代幣、買方 approve JC，皆給本工廠。
    function trade(
        address token,
        address seller,
        address buyer,
        uint256 shareAmount,
        uint256 jcToSeller,
        uint256 feeAmount
    ) external onlyOwner nonReentrant {
        require(isFactoryToken[token], "RWAFactory: unknown token");
        require(seller != address(0) && buyer != address(0), "RWAFactory: zero addr");
        require(shareAmount > 0, "RWAFactory: zero shares");
        require(IERC20(token).transferFrom(seller, buyer, shareAmount), "RWAFactory: share move failed");
        if (jcToSeller > 0) {
            require(jcToken.transferFrom(buyer, seller, jcToSeller), "RWAFactory: JC to seller failed");
        }
        if (feeAmount > 0) {
            require(jcToken.transferFrom(buyer, feeRecipient, feeAmount), "RWAFactory: JC fee failed");
        }
        emit Traded(token, seller, buyer, shareAmount, jcToSeller, feeAmount);
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
    function setJcToken(address v) external onlyOwner {
        require(v != address(0), "RWAFactory: zero addr");
        jcToken = IERC20(v);
    }

    function setSafeVault(address v) external onlyOwner {
        require(v != address(0), "RWAFactory: zero addr");
        safeVault = v;
    }

    function setFeeRecipient(address v) external onlyOwner {
        require(v != address(0), "RWAFactory: zero addr");
        feeRecipient = v;
    }
}
