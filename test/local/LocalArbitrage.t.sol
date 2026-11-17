// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {BCoWHelperValidationFixture} from '../unit/BCoWHelperValidation.t.sol';
import {BCoWPool} from 'contracts/BCoWPool.sol';
import {LocalArbitrage} from 'script/local/LocalArbitrage.sol';
import {LocalAuctionVenue} from 'script/local/LocalAuctionVenue.sol';
import {LocalStockToken} from 'script/local/LocalStockToken.sol';

contract LocalArbitrageTest is BCoWHelperValidationFixture {
  BCoWPool internal pool;
  LocalAuctionVenue internal venue;
  LocalArbitrage internal executor;
  LocalStockToken internal stock;
  LocalStockToken internal cash;

  function _setUpArbitrage(
    bool liquid
  ) internal {
    pool = BCoWPool(address(factory.newBPool('Control', 'C')));
    stock = new LocalStockToken('Stock', 'S', 18);
    cash = new LocalStockToken('Cash', 'C', 6);
    stock.mint(address(this), 800e18);
    cash.mint(address(this), 600e6);
    stock.approve(address(pool), 800e18);
    cash.approve(address(pool), 600e6);
    pool.bind(address(stock), 800e18, 8e18);
    pool.bind(address(cash), 600e6, 6e18);
    pool.setSwapFee(0.003e18);
    pool.finalize();
    venue = new LocalAuctionVenue(10);
    address[] memory tokens = new address[](2);
    uint256[] memory prices = new uint256[](2);
    tokens[0] = address(stock);
    tokens[1] = address(cash);
    prices[0] = 2e18;
    prices[1] = 1e30;
    venue.setPrices(tokens, prices);
    cash.mint(address(venue), liquid ? 1000e6 : 1);
    executor = new LocalArbitrage(address(this));
    cash.mint(address(executor), 1000e6);
  }

  function _execute(
    uint256 minProfit
  ) internal {
    executor.execute(pool, venue, address(stock), address(cash), 10e18, 20e6, minProfit);
  }

  function test_AtomicArbitrageRestoresCapitalAndPaysOnlyEarnedProfit() public {
    _setUpArbitrage(true);
    uint256 supply = cash.totalSupply();
    _execute(1);
    uint256 received = 19_980_000;
    uint256 cost = cash.balanceOf(address(pool)) - 600e6;
    assertGt(received, cost);
    assertEq(cash.balanceOf(address(this)), received - cost);
    assertEq(cash.balanceOf(address(executor)), 1000e6);
    assertEq(stock.balanceOf(address(executor)), 0);
    assertEq(stock.balanceOf(address(pool)), 790e18);
    assertEq(stock.balanceOf(address(venue)), 10e18);
    assertEq(cash.totalSupply(), supply);
  }

  function test_UnprofitableExecutionRollsBackPoolAndVenue() public {
    _setUpArbitrage(true);
    vm.expectRevert(LocalArbitrage.Unprofitable.selector);
    _execute(100e6);
    _assertUnchanged(1000e6);
  }

  function test_InsufficientExternalInventoryRollsBackPoolSwap() public {
    _setUpArbitrage(false);
    vm.expectRevert(LocalAuctionVenue.InsufficientInventory.selector);
    _execute(1);
    _assertUnchanged(1);
  }

  function test_AnotherCallerCannotSpendExecutorCapital() public {
    _setUpArbitrage(true);
    vm.expectRevert(LocalArbitrage.Unauthorized.selector);
    vm.prank(address(0xBAD));
    _execute(1);
    _assertUnchanged(1000e6);
  }

  function _assertUnchanged(
    uint256 inventory
  ) internal view {
    assertEq(stock.balanceOf(address(pool)), 800e18);
    assertEq(cash.balanceOf(address(pool)), 600e6);
    assertEq(cash.balanceOf(address(executor)), 1000e6);
    assertEq(stock.balanceOf(address(executor)), 0);
    assertEq(stock.balanceOf(address(venue)), 0);
    assertEq(cash.balanceOf(address(venue)), inventory);
    assertEq(cash.balanceOf(address(this)), 0);
  }
}
