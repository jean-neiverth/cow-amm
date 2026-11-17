// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from 'forge-std/Test.sol';
import {LocalAuctionVenue} from 'script/local/LocalAuctionVenue.sol';
import {LocalStockToken} from 'script/local/LocalStockToken.sol';

contract LocalAuctionVenueTest is Test {
  LocalAuctionVenue internal venue;
  LocalStockToken internal stock;
  LocalStockToken internal cash;
  address internal taker = address(0xB1D);

  function setUp() public {
    venue = new LocalAuctionVenue(10);
    stock = new LocalStockToken('Stock', 'S', 18);
    cash = new LocalStockToken('Cash', 'C', 6);
    address[] memory tokens = new address[](2);
    uint256[] memory prices = new uint256[](2);
    tokens[0] = address(stock);
    tokens[1] = address(cash);
    prices[0] = 1.5e18;
    prices[1] = 0.8e30;
    venue.setPrices(tokens, prices);
    cash.mint(address(venue), 100e6);
    stock.mint(taker, 100e18);
    vm.prank(taker);
    stock.approve(address(venue), type(uint256).max);
  }

  function test_MixedDecimalExecutionIsFundedAndConservesSupply() public {
    uint256 stockSupply = stock.totalSupply();
    uint256 cashSupply = cash.totalSupply();
    assertEq(venue.quote(address(stock), address(cash), 1e18), 1_873_125);
    vm.prank(taker);
    uint256 received = venue.swap(address(stock), address(cash), 1e18, 1_873_125);
    assertEq(received, 1_873_125);
    assertEq(stock.balanceOf(taker), 99e18);
    assertEq(stock.balanceOf(address(venue)), 1e18);
    assertEq(cash.balanceOf(taker), received);
    assertEq(cash.balanceOf(address(venue)), 100e6 - received);
    assertEq(stock.totalSupply(), stockSupply);
    assertEq(cash.totalSupply(), cashSupply);
  }

  function test_InventoryAndSlippageFailuresDoNotMoveBalances() public {
    vm.expectRevert(LocalAuctionVenue.InsufficientInventory.selector);
    venue.quote(address(stock), address(cash), 100e18);
    vm.expectRevert(LocalAuctionVenue.InsufficientInventory.selector);
    vm.prank(taker);
    venue.swap(address(stock), address(cash), 100e18, 0);
    vm.expectRevert(LocalAuctionVenue.MinimumOutput.selector);
    vm.prank(taker);
    venue.swap(address(stock), address(cash), 1e18, 2e6);
    assertEq(stock.balanceOf(taker), 100e18);
    assertEq(stock.balanceOf(address(venue)), 0);
    assertEq(cash.balanceOf(address(venue)), 100e6);
    assertEq(cash.balanceOf(taker), 0);
  }

  function test_PriceUpdatesRequireOwnerAndValidValues() public {
    address[] memory tokens = new address[](1);
    uint256[] memory prices = new uint256[](1);
    tokens[0] = address(stock);
    prices[0] = 1e18;
    vm.expectRevert(LocalAuctionVenue.Unauthorized.selector);
    vm.prank(taker);
    venue.setPrices(tokens, prices);
    prices[0] = 0;
    vm.expectRevert(LocalAuctionVenue.InvalidQuote.selector);
    venue.setPrices(tokens, prices);
    vm.expectRevert(LocalAuctionVenue.InvalidQuote.selector);
    venue.setPrices(tokens, new uint256[](0));
    assertEq(venue.prices(address(stock)), 1.5e18);
  }

  function test_InvalidPairsZeroAmountsAndFeesAreRejected() public {
    vm.expectRevert(LocalAuctionVenue.InvalidQuote.selector);
    new LocalAuctionVenue(10_001);
    vm.expectRevert(LocalAuctionVenue.InvalidQuote.selector);
    venue.quote(address(stock), address(stock), 1e18);
    vm.expectRevert(LocalAuctionVenue.InvalidQuote.selector);
    venue.quote(address(stock), address(cash), 0);
    vm.expectRevert(LocalAuctionVenue.InvalidQuote.selector);
    venue.quote(address(stock), address(0), 1e18);
    vm.expectRevert(LocalAuctionVenue.InvalidQuote.selector);
    venue.quote(address(stock), address(cash), 1);
  }

  function testFuzz_InventoryBoundsAndSupplyConservation(
    uint256 amount
  ) public {
    amount = bound(amount, 1e13, 50e18);
    uint256 expected = venue.quote(address(stock), address(cash), amount);
    vm.prank(taker);
    venue.swap(address(stock), address(cash), amount, expected);
    assertEq(stock.balanceOf(taker) + stock.balanceOf(address(venue)), stock.totalSupply());
    assertEq(cash.balanceOf(taker) + cash.balanceOf(address(venue)), cash.totalSupply());
    assertEq(stock.balanceOf(address(venue)), amount);
    assertEq(cash.balanceOf(taker), expected);
  }
}
