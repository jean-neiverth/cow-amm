// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

/// @notice Finite-inventory, fixed-price venue for local auction experiments only.
contract LocalAuctionVenue {
  using SafeERC20 for IERC20;

  address public immutable OWNER;
  uint256 public immutable FEE_BPS;
  mapping(address => uint256) public prices;

  error Unauthorized();
  error InvalidQuote();
  error InsufficientInventory();
  error MinimumOutput();

  constructor(
    uint256 feeBps_
  ) {
    if (feeBps_ > 10_000) revert InvalidQuote();
    OWNER = msg.sender;
    FEE_BPS = feeBps_;
  }

  /// @notice Set reference values per raw token unit; only the experiment manager can update them.
  function setPrices(
    address[] calldata tokens,
    uint256[] calldata values
  ) external {
    if (msg.sender != OWNER) revert Unauthorized();
    if (tokens.length != values.length) revert InvalidQuote();
    for (uint256 i; i < tokens.length; ++i) {
      if (values[i] == 0) revert InvalidQuote();
      prices[tokens[i]] = values[i];
    }
  }

  function swap(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint256 minOut
  ) external returns (uint256 amountOut) {
    amountOut = quote(tokenIn, tokenOut, amountIn);
    if (amountOut < minOut) revert MinimumOutput();
    IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
    IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
  }

  function quote(
    address tokenIn,
    address tokenOut,
    uint256 amountIn
  ) public view returns (uint256 amountOut) {
    if (tokenIn == tokenOut || amountIn == 0 || prices[tokenIn] == 0 || prices[tokenOut] == 0) revert InvalidQuote();
    uint256 gross = Math.mulDiv(amountIn, prices[tokenIn], prices[tokenOut]);
    amountOut = Math.mulDiv(gross, 10_000 - FEE_BPS, 10_000);
    if (amountOut == 0) revert InvalidQuote();
    if (amountOut > IERC20(tokenOut).balanceOf(address(this))) revert InsufficientInventory();
  }
}
