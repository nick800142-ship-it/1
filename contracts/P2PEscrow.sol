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
///         Trade fee, listing fee and fee recipient are owner-adjustable within hard caps; each
///         order snapshots the trade fee rate at creation so later changes only affect new orders.
contract P2PEscrow is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;

    uint256 public constant TOKEN_SCALE = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant MAX_LISTING_FEE = 10e18;
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
        uint256 feeBps;
        uint256 listingFeePaid;
    }

    struct Fill {
        uint256 orderId;
        address buyer;
        address seller;
        uint256 quantity;
        uint256 gross;
        uint256 fee;
    }

    address public feeRecipient;
    uint256 public feeBps = 100;
    uint256 public listingFee = 1e18;
    address public immutable aeToken;
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
    error FeeAboveMaximum();

    event FeesUpdated(uint256 feeBps, uint256 listingFee);
    event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);

    event OrderCreated(
        uint256 indexed orderId,
        bytes32 indexed clientOrderId,
        address indexed maker,
        bool isSell,
        address assetToken,
        address currencyToken,
        uint256 price,
        uint256 quantity,
        uint256 listingFee,
        uint256 feeBps
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
    event AutoOrderMatched(
        bytes32 indexed fillKey,
        uint256 indexed orderId,
        address indexed buyer,
        uint256 counterOrderId,
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
    event OrderForceCancelled(uint256 indexed orderId, address indexed maker, address indexed operator, uint256 refundedAmount);

    constructor(address feeRecipient_, address aeToken_) Ownable(msg.sender) {
        emit FeesUpdated(feeBps, listingFee);
        if (feeRecipient_ == address(0) || aeToken_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        aeToken = aeToken_;
    }

    /// @notice Update the trade fee (basis points) and the one-time seller listing fee.
    /// @dev Existing orders keep the trade fee rate they were created with.
    function setFees(uint256 newFeeBps, uint256 newListingFee) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS || newListingFee > MAX_LISTING_FEE) revert FeeAboveMaximum();
        if (newListingFee % DISPLAY_SCALE != 0) revert InvalidAmount();
        feeBps = newFeeBps;
        listingFee = newListingFee;
        emit FeesUpdated(newFeeBps, newListingFee);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /// @notice Lock shares for a sell order or quote tokens for a buy order.
    /// @dev A seller pays the current one-time listing fee directly to feeRecipient.
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
        _validateQuantity(assetToken, quantity);
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
                existing.currencyToken, existing.price, existing.originalQuantity, existing.listingFeePaid, existing.feeBps);
            return existingId;
        }

        uint256 chargedListingFee = isSell ? listingFee : 0;
        if (isSell) {
            _transferExactIn(IERC20Metadata(assetToken), msg.sender, quantity);
            if (chargedListingFee > 0) {
                _transferExactIn(IERC20Metadata(currencyToken), msg.sender, chargedListingFee);
                IERC20Metadata(currencyToken).safeTransfer(feeRecipient, chargedListingFee);
            }
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
            lockedCurrency: isSell ? 0 : gross,
            feeBps: feeBps,
            listingFeePaid: chargedListingFee
        });
        orderIdByClientId[clientOrderId] = orderId;
        emit OrderCreated(orderId, clientOrderId, msg.sender, isSell, assetToken, currencyToken, price, quantity, chargedListingFee, feeBps);
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
        _validateQuantity(order.assetToken, quantity);

        uint256 gross = _roundedGross(order.price, quantity);
        if (gross < MIN_TRADE) revert TradeBelowMinimum();
        uint256 fee = _roundedFee(gross, order.feeBps);
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

    /// @notice Match two previously escrowed crossing limit orders without either maker signing again.
    /// @dev Only the owner-operated server may choose order pairs; both orders must be live and
    ///      their escrowed assets are settled atomically. The earlier chain order sets the price.
    function matchEscrowOrders(uint256 buyOrderId, uint256 sellOrderId, uint256 quantity, bytes32 fillKey)
        external
        onlyOwner
        nonReentrant
        whenNotPaused
        returns (Fill memory result, bool duplicate)
    {
        if (fillKey == bytes32(0)) revert InvalidOrder();
        Fill memory prior = fills[fillKey];
        if (prior.orderId != 0) return (prior, true);
        if (quantity == 0) revert InvalidAmount();

        Order storage buyOrder = orders[buyOrderId];
        Order storage sellOrder = orders[sellOrderId];
        if (
            buyOrder.maker == address(0) || sellOrder.maker == address(0) ||
            buyOrder.cancelled || sellOrder.cancelled ||
            buyOrder.remaining == 0 || sellOrder.remaining == 0 ||
            buyOrder.isSell || !sellOrder.isSell
        ) revert InvalidOrder();
        if (buyOrder.maker == sellOrder.maker) revert CannotFillOwnOrder();
        if (
            buyOrder.assetToken != sellOrder.assetToken ||
            buyOrder.currencyToken != sellOrder.currencyToken ||
            buyOrder.price < sellOrder.price
        ) revert InvalidOrder();
        if (quantity > buyOrder.remaining || quantity > sellOrder.remaining) revert InsufficientRemaining();
        _validateQuantity(buyOrder.assetToken, quantity);

        uint256 executionPrice = buyOrderId < sellOrderId ? buyOrder.price : sellOrder.price;
        uint256 gross = _roundedGross(executionPrice, quantity);
        if (gross < MIN_TRADE) revert TradeBelowMinimum();
        uint256 fee = _roundedFee(gross, sellOrder.feeBps);
        uint256 currencyReleased = quantity == buyOrder.remaining ? buyOrder.lockedCurrency : gross;
        if (gross > buyOrder.lockedCurrency || currencyReleased < gross) revert InsufficientRemaining();

        address buyer = buyOrder.maker;
        address seller = sellOrder.maker;
        buyOrder.remaining -= quantity;
        buyOrder.lockedCurrency -= currencyReleased;
        sellOrder.remaining -= quantity;
        totalLocked[buyOrder.assetToken] -= quantity;
        totalLocked[buyOrder.currencyToken] -= currencyReleased;

        if (buyOrder.remaining == 0) buyOrder.cancelled = true;
        if (sellOrder.remaining == 0) sellOrder.cancelled = true;

        IERC20Metadata(buyOrder.currencyToken).safeTransfer(seller, gross - fee);
        IERC20Metadata(buyOrder.currencyToken).safeTransfer(feeRecipient, fee);
        if (currencyReleased > gross) {
            IERC20Metadata(buyOrder.currencyToken).safeTransfer(buyer, currencyReleased - gross);
        }
        IERC20Metadata(buyOrder.assetToken).safeTransfer(buyer, quantity);

        result = Fill({orderId: sellOrderId, buyer: buyer, seller: seller, quantity: quantity, gross: gross, fee: fee});
        fills[fillKey] = result;
        emit AutoOrderMatched(fillKey, sellOrderId, buyer, buyOrderId, seller, sellOrder.assetToken, sellOrder.currencyToken,
            quantity, executionPrice, gross, fee, currencyReleased);
    }

    /// @notice Return unfilled escrow to the maker. The one-time listing fee is not refundable.
    function cancelOrder(uint256 orderId) external nonReentrant returns (uint256 refundedAmount) {
        Order storage order = orders[orderId];
        if (order.maker == address(0)) revert InvalidOrder();
        if (order.maker != msg.sender) revert UnauthorizedMaker();
        if (order.cancelled) {
            emit OrderCancelled(orderId, msg.sender, 0);
            return 0;
        }
        if (order.remaining == 0) revert InvalidOrder();
        refundedAmount = _closeAndRefund(orderId, order);
    }

    /// @notice Owner cancels an open order on the maker's behalf (delisting, contract migration,
    ///         emergencies). Locked assets can only go back to the original maker.
    function forceCancel(uint256 orderId) external onlyOwner nonReentrant returns (uint256 refundedAmount) {
        Order storage order = orders[orderId];
        if (order.maker == address(0) || order.cancelled || order.remaining == 0) revert InvalidOrder();
        refundedAmount = _closeAndRefund(orderId, order);
        emit OrderForceCancelled(orderId, order.maker, msg.sender, refundedAmount);
    }

    function _closeAndRefund(uint256 orderId, Order storage order) private returns (uint256 refundedAmount) {
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
        emit OrderCancelled(orderId, order.maker, refundedAmount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _validateQuantity(address assetToken, uint256 quantity) private view {
        uint256 unit = assetToken == aeToken ? DISPLAY_SCALE : TOKEN_SCALE;
        if (quantity % unit != 0) revert InvalidAmount();
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

    function _roundedFee(uint256 gross, uint256 rateBps) private pure returns (uint256) {
        uint256 raw = Math.mulDiv(gross, rateBps, BPS_DENOMINATOR);
        return ((raw + DISPLAY_SCALE / 2) / DISPLAY_SCALE) * DISPLAY_SCALE;
    }
}
