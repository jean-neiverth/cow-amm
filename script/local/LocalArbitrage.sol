// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {LocalAuctionVenue} from './LocalAuctionVenue.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IBPool} from 'interfaces/IBPool.sol';

/// @notice Pre-funded atomic arbitrage executor for the ordinary-AMM control, local use only.
contract LocalArbitrage {
  using SafeERC20 for IERC20;

  address public immutable OWNER;
  error Unauthorized();
  error Unprofitable();

  constructor(
    address owner_
  ) {
    OWNER = owner_;
  }

  function execute(
    IBPool pool,
    LocalAuctionVenue venue,
    address sellToken,
    address buyToken,
    uint256 sellAmount,
    uint256 maxInput,
    uint256 minProfit
  ) external {
    if (msg.sender != OWNER) revert Unauthorized();
    IERC20 incoming = IERC20(buyToken);
    IERC20 outgoing = IERC20(sellToken);
    uint256 beforeBalance = incoming.balanceOf(address(this));
    uint256 outgoingBefore = outgoing.balanceOf(address(this));
    incoming.forceApprove(address(pool), maxInput);
    pool.swapExactAmountOut(buyToken, maxInput, sellToken, sellAmount, type(uint256).max);
    outgoing.forceApprove(address(venue), sellAmount);
    venue.swap(sellToken, buyToken, sellAmount, 0);
    uint256 afterBalance = incoming.balanceOf(address(this));
    if (afterBalance < beforeBalance || afterBalance - beforeBalance < minProfit) revert Unprofitable();
    incoming.safeTransfer(OWNER, afterBalance - beforeBalance);
    assert(outgoing.balanceOf(address(this)) == outgoingBefore);
  }
}
