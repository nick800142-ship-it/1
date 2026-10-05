// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title P2PEscrow
/// @notice Per-order escrow for the platform's 18-decimal AE/RWA tokens and quote token.
///         The quote token is supplied for each order; no payment token is fixed in this contract.
contract P2PEscrow is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;

    uint256 public constant TOKEN_SCALE = 1e18;
    uint256 public constant LISTING_FEE = 1e18;
    uint256 public constant FEE_BPS = 100;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MIN_TRADE = 2e18;
    uint256 private constant DISPLAY_SCALE = 1e12;

    struct Order {
        address maker;
        address assetToken;
        address currencyToken;
        bool isSell;
        bool cancelled;
        uint256 price;
        uint256 originalQuantity;
        uint256 remaining;
        uint256 lockedCurrency;
    }

    struct Fill {
        uint256 orderId;
        address buyer;
        address seller;
        uint256 quantity;
        uint256 gross;
        uint256 fee;
    }

    address public immutable feeRecipient;
    uint256 public nextOrderId = 1;
    mapping(uint256 orderId => Order) public orders;
    mapping(bytes32 clientOrderId => uint256 orderId) public orderIdByClientId;
    mapping(bytes32 fillKey => Fill fill) public fills;
    mapping(address token => uint256 amount) public totalLocked;

    error ZeroAddress();
    error InvalidOrder();
    error InvalidAmount();
    error InvalidTokenDecimals();
    error DuplicateClientOrder();
    error DuplicateFillKey();
    error UnauthorizedMaker();
    error CannotFillOwnOrder();
    error InsufficientRemaining();
    error TransferAmountMismatch();
    error TradeBelowMinimum();

    event OrderCreated(
        uint256 indexed orderId,
        bytes32 indexed clientOrderId,
        address indexed maker,
        bool isSell,
        address assetToken,
        address currencyToken,
        uint256 price,
        uint256 quantity,
        uint256 listingFee
    );
    event OrderFilled(
        bytes32 indexed fillKey,
        uint256 indexed orderId,
        address indexed buyer,
        address seller,
        address assetToken,
        address currencyToken,
        uint256 quantity,
        uint256 price,
        uint256 gross,
        uint256 fee,
        uint256 currencyReleased
    );
    event OrderCancelled(uint256 indexed orderId, address indexed maker, uint256 refundedAmount);

    constructor(address feeRecipient_) Ownable(msg.sender) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
    }

    /// @notice Lock shares for a sell order or quote tokens for a buy order.
    /// @dev A seller pays the one-time 1-token listing fee directly to feeRecipient.
    ///      All supported platform tokens currently use 18 decimals.
    function createOrder(
        bytes32 clientOrderId,
        bool isSell,
        address assetToken,
        address currencyToken,
        uint256 price,
        uint256 quantity
    ) external nonReentrant whenNotPaused returns (uint256 orderId) {
        if (clientOrderId == bytes32(0) || assetToken == address(0) || currencyToken == address(0) || assetToken == currencyToken) {
            revert InvalidOrder();
        }
        if (price == 0 || quantity == 0) revert InvalidAmount();
        _require18Decimals(assetToken);
        _require18Decimals(currencyToken);

        uint256 gross = _roundedGross(price, quantity);
        if (gross < MIN_TRADE) revert TradeBelowMinimum();

        uint256 existingId = orderIdByClientId[clientOrderId];
        if (existingId != 0) {
            Order storage existing = orders[existingId];
            if (
                existing.maker != msg.sender || existing.isSell != isSell ||
                existing.assetToken != assetToken || existing.currencyToken != currencyToken ||
                existing.price != price || existing.originalQuantity != quantity
            ) revert DuplicateClientOrder();
            emit OrderCreated(existingId, clientOrderId, existing.maker, existing.isSell, existing.assetToken,
                existing.currencyToken, existing.price, existing.originalQuantity, existing.isSell ? LISTING_FEE : 0);
            return existingId;
        }

        if (isSell) {
            _transferExactIn(IERC20Metadata(assetToken), msg.sender, quantity);
            _transferExactIn(IERC20Metadata(currencyToken), msg.sender, LISTING_FEE);
            IERC20Metadata(currencyToken).safeTransfer(feeRecipient, LISTING_FEE);
            totalLocked[assetToken] += quantity;
        } else {
            _transferExactIn(IERC20Metadata(currencyToken), msg.sender, gross);
            totalLocked[currencyToken] += gross;
        }

        orderId = nextOrderId++;
        orders[orderId] = Order({
            maker: msg.sender,
            assetToken: assetToken,
            currencyToken: currencyToken,
            isSell: isSell,
            cancelled: false,
            price: price,
            originalQuantity: quantity,
            remaining: quantity,
            lockedCurrency: isSell ? 0 : gross
        });
        orderIdByClientId[clientOrderId] = orderId;
        emit OrderCreated(orderId, clientOrderId, msg.sender, isSell, assetToken, currencyToken, price, quantity, isSell ? LISTING_FEE : 0);
    }

    /// @notice Take part or all of an existing escrowed order. Payment, fee and asset delivery
    ///         all settle in this transaction; any transfer failure reverts the entire fill.
    function fillOrder(uint256 orderId, uint256 quantity, bytes32 fillKey)
        external
        nonReentrant
        whenNotPaused
        returns (Fill memory result, bool duplicate)
    {
        if (fillKey == bytes32(0)) revert InvalidOrder();
        Fill memory prior = fills[fillKey];
        if (prior.orderId != 0) return (prior, true);
        if (quantity == 0) revert InvalidAmount();

        Order storage order = orders[orderId];
        if (order.maker == address(0) || order.cancelled || order.remaining == 0) revert InvalidOrder();
        if (order.maker == msg.sender) revert CannotFillOwnOrder();
        if (quantity > order.remaining) revert InsufficientRemaining();

        uint256 gross = _roundedGross(order.price, quantity);
        if (gross < MIN_TRADE) revert TradeBelowMinimum();
        uint256 fee = _roundedFee(gross);
        uint256 sellerNet = gross - fee;
        address buyer = order.isSell ? msg.sender : order.maker;
        address seller = order.isSell ? order.maker : msg.sender;

        uint256 currencyReleased;
        if (order.isSell) {
            _transferExactIn(IERC20Metadata(order.currencyToken), buyer, gross);
            IERC20Metadata(order.currencyToken).safeTransfer(seller, sellerNet);
            IERC20Metadata(order.currencyToken).safeTransfer(feeRecipient, fee);
            order.remaining -= quantity;
            totalLocked[order.assetToken] -= quantity;
            IERC20Metadata(order.assetToken).safeTransfer(buyer, quantity);
        } else {
            if (gross > order.lockedCurrency) revert InsufficientRemaining();
            _transferExactIn(IERC20Metadata(order.assetToken), seller, quantity);
            currencyReleased = quantity == order.remaining ? order.lockedCurrency : gross;
            if (currencyReleased < gross) revert InsufficientRemaining();
            order.remaining -= quantity;
            order.lockedCurrency -= currencyReleased;
            totalLocked[order.currencyToken] -= currencyReleased;
            IERC20Metadata(order.currencyToken).safeTransfer(seller, sellerNet);
            IERC20Metadata(order.currencyToken).safeTransfer(feeRecipient, fee);
            if (currencyReleased > gross) {
                IERC20Metadata(order.currencyToken).safeTransfer(order.maker, currencyReleased - gross);
            }
            IERC20Metadata(order.assetToken).safeTransfer(buyer, quantity);
        }

        result = Fill({orderId: orderId, buyer: buyer, seller: seller, quantity: quantity, gross: gross, fee: fee});
        fills[fillKey] = result;
        emit OrderFilled(fillKey, orderId, buyer, seller, order.assetToken, order.currencyToken, quantity, order.price, gross, fee, currencyReleased);
    }

    /// @notice Return unfilled escrow to the maker. The one-time listing fee is not refundable.
    function cancelOrder(uint256 orderId) external nonReentrant returns (uint256 refundedAmount) {
        Order storage order = orders[orderId];
        if (order.maker == address(0)) revert InvalidOrder();
        if (order.maker != msg.sender) revert UnauthorizedMaker();
        if (order.cancelled || order.remaining == 0) {
            emit OrderCancelled(orderId, msg.sender, 0);
            return 0;
        }

        uint256 remaining = order.remaining;
        order.remaining = 0;
        order.cancelled = true;
        if (order.isSell) {
            refundedAmount = remaining;
            totalLocked[order.assetToken] -= remaining;
            IERC20Metadata(order.assetToken).safeTransfer(order.maker, remaining);
        } else {
            refundedAmount = order.lockedCurrency;
            order.lockedCurrency = 0;
            totalLocked[order.currencyToken] -= refundedAmount;
            IERC20Metadata(order.currencyToken).safeTransfer(order.maker, refundedAmount);
        }
        emit OrderCancelled(orderId, msg.sender, refundedAmount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _require18Decimals(address token) private view {
        try IERC20Metadata(token).decimals() returns (uint8 tokenDecimals) {
            if (tokenDecimals != 18) revert InvalidTokenDecimals();
        } catch {
            revert InvalidTokenDecimals();
        }
    }

    function _transferExactIn(IERC20Metadata token, address from, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert TransferAmountMismatch();
    }

    function _roundedGross(uint256 price, uint256 quantity) private pure returns (uint256) {
        uint256 raw = Math.mulDiv(price, quantity, TOKEN_SCALE);
        return ((raw + DISPLAY_SCALE / 2) / DISPLAY_SCALE) * DISPLAY_SCALE;
    }

    function _roundedFee(uint256 gross) private pure returns (uint256) {
        uint256 raw = Math.mulDiv(gross, FEE_BPS, BPS_DENOMINATOR);
        return ((raw + DISPLAY_SCALE / 2) / DISPLAY_SCALE) * DISPLAY_SCALE;
    }
}
