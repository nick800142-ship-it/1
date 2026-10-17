// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title RWAShareToken
/// @notice One share token per RWA placement. The full supply is minted once, to the factory
///         owner (the Safe), at creation; there is no further minting.
///         Its manager is the factory that created it, and the factory can hand that role to a
///         new factory so the platform can change RWA rules without touching existing shares.
contract RWAShareToken is ERC20 {
    address public factory;
    uint8 private immutable _decimals;

    error OnlyFactory();
    error ZeroAddress();

    event FactoryUpdated(address indexed previousFactory, address indexed newFactory);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address initialHolder, uint256 supply)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
        factory = msg.sender;
        _mint(initialHolder, supply);
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert OnlyFactory();
        _;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Delisting: the factory moves a holder's shares back to the factory owner (the Safe).
    function forceTransfer(address from, address to, uint256 amount) external onlyFactory {
        _transfer(from, to, amount);
    }

    /// @notice The factory burns unsold inventory; it only ever passes the factory owner's address.
    function factoryBurn(address from, uint256 amount) external onlyFactory {
        _burn(from, amount);
    }

    /// @notice Hand management of this token to a new factory.
    function setFactory(address newFactory) external onlyFactory {
        if (newFactory == address(0)) revert ZeroAddress();
        emit FactoryUpdated(factory, newFactory);
        factory = newFactory;
    }
}

/// @title RWAFactory
/// @notice Base mainnet RWA factory. Owner = platform Safe; there is no operator and no stored
///         vault or payment-token address. Shares are minted to the owner, recalled only to the
///         owner, and only the owner's own inventory can be burned. Settlement happens outside
///         this contract (hot-wallet transfers and the P2P escrow), so the factory can be replaced:
///         deploy a new one, `migrateToken` each share token to it, then `importToken` there.
contract RWAFactory is Ownable2Step {
    mapping(string placementId => address token) public tokenByPlacement;
    mapping(address token => bool managed) public isFactoryToken;
    address[] public allTokens;

    error ZeroAddress();
    error ZeroAmount();
    error PlacementExists();
    error UnknownToken();
    error NotManagedHere();
    error BadHolder();
    error RenounceDisabled();

    event RWATokenCreated(
        string placementId, address indexed token, string name, string symbol, uint8 decimals, uint256 totalSupply
    );
    event SharesBurned(address indexed token, uint256 amount);
    event SharesReclaimed(address indexed token, address indexed holder, uint256 amount);
    event TokenMigrated(address indexed token, address indexed newFactory);
    event TokenImported(string placementId, address indexed token);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Deploy a share token for a placement and mint its full supply to the owner (Safe).
    function createRWAToken(
        string calldata placementId,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        uint256 totalSupply_
    ) external onlyOwner returns (address token) {
        if (tokenByPlacement[placementId] != address(0)) revert PlacementExists();
        if (totalSupply_ == 0) revert ZeroAmount();
        token = address(new RWAShareToken(name_, symbol_, decimals_, owner(), totalSupply_));
        _register(placementId, token);
        emit RWATokenCreated(placementId, token, name_, symbol_, decimals_, totalSupply_);
    }

    /// @notice Burn unsold shares held by the owner (Safe). User holdings cannot be burned.
    function burnVaultInventory(address token, uint256 amount) external onlyOwner {
        if (!isFactoryToken[token]) revert UnknownToken();
        if (amount == 0) revert ZeroAmount();
        RWAShareToken(token).factoryBurn(owner(), amount);
        emit SharesBurned(token, amount);
    }

    /// @notice Delisting: recall every share a holder has back to the owner (Safe).
    function reclaimShares(address token, address holder) external onlyOwner returns (uint256 amount) {
        if (!isFactoryToken[token]) revert UnknownToken();
        address safe = owner();
        if (holder == address(0) || holder == safe) revert BadHolder();
        amount = RWAShareToken(token).balanceOf(holder);
        if (amount > 0) {
            RWAShareToken(token).forceTransfer(holder, safe, amount);
            emit SharesReclaimed(token, holder, amount);
        }
    }

    /// @notice Hand a share token over to a new factory. This factory stops managing it.
    function migrateToken(address token, address newFactory) external onlyOwner {
        if (!isFactoryToken[token]) revert UnknownToken();
        if (newFactory == address(0)) revert ZeroAddress();
        isFactoryToken[token] = false;
        RWAShareToken(token).setFactory(newFactory);
        emit TokenMigrated(token, newFactory);
    }

    /// @notice Adopt a share token that an older factory migrated to this one.
    function importToken(string calldata placementId, address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (RWAShareToken(token).factory() != address(this)) revert NotManagedHere();
        if (isFactoryToken[token]) revert PlacementExists();
        address existing = tokenByPlacement[placementId];
        if (existing != address(0) && existing != token) revert PlacementExists();
        _register(placementId, token);
        emit TokenImported(placementId, token);
    }

    function totalTokens() external view returns (uint256) {
        return allTokens.length;
    }

    function getTokens(uint256 offset, uint256 limit) external view returns (address[] memory out) {
        uint256 n = allTokens.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit > n ? n : offset + limit;
        out = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = allTokens[i];
        }
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function _register(string calldata placementId, address token) private {
        tokenByPlacement[placementId] = token;
        isFactoryToken[token] = true;
        allTokens.push(token);
    }
}
