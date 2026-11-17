// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {BCoWHelperValidationFixture, HelperValidationToken} from './BCoWHelperValidation.t.sol';
import {ICOWAMMPoolHelper} from '@cow-amm/interfaces/ICOWAMMPoolHelper.sol';
import {GPv2Interaction} from '@cowprotocol/libraries/GPv2Interaction.sol';
import {GPv2Order} from '@cowprotocol/libraries/GPv2Order.sol';
import {BCoWHelper} from 'contracts/BCoWHelper.sol';
import {BCoWPool} from 'contracts/BCoWPool.sol';
import {IBPool} from 'interfaces/IBPool.sol';

contract PairValidationToken is HelperValidationToken {
  uint8 internal immutable TOKEN_DECIMALS;

  constructor(
    uint8 decimals_
  ) {
    TOKEN_DECIMALS = decimals_;
  }

  function decimals() public view override returns (uint8) {
    return TOKEN_DECIMALS;
  }
}

contract BCoWHelperPairsTest is BCoWHelperValidationFixture {
  function _mixedM7() internal returns (BCoWPool pool) {
    IBPool created = factory.newBPool('Mixed-decimal M7', 'M7');
    uint8[7] memory decimals = [uint8(18), 6, 8, 18, 6, 18, 8];
    uint256[7] memory units = [uint256(8), 6, 6, 6, 6, 4, 4];
    for (uint256 i; i < 7; ++i) {
      PairValidationToken token = new PairValidationToken(decimals[i]);
      uint256 balance = units[i] * 100 * 10 ** decimals[i];
      token.mint(address(this), balance);
      token.approve(address(created), balance);
      created.bind(address(token), balance, units[i] * 1e18);
    }
    created.setSwapFee(helper.MAX_FEE());
    created.finalize();
    return BCoWPool(address(created));
  }

  function test_AllM7PairDirectionsAndAmountAPIs() public {
    BCoWPool pool = _mixedM7();
    address[] memory tokens = helper.tokens(address(pool));
    for (uint256 buy; buy < 7; ++buy) {
      for (uint256 sell; sell < 7; ++sell) {
        if (buy == sell) continue;
        uint256 amount = _balance(pool, tokens[buy]) / 100;
        (
          GPv2Order.Data memory order,
          GPv2Interaction.Data[] memory pre,
          GPv2Interaction.Data[] memory post,
          bytes memory sig
        ) = helper.orderFromBuyAmount(address(pool), tokens[buy], tokens[sell], amount);
        assertEq(order.buyAmount, amount);
        _check(pool, order, pre, post, sig, tokens[buy], tokens[sell]);
        uint256 tentative = _balance(pool, tokens[sell]) / 100;
        (order, pre, post, sig) = helper.orderFromSellAmount(address(pool), tokens[sell], tokens[buy], tentative);
        assertApproxEqRel(order.sellAmount, tentative, 1e15);
        _check(pool, order, pre, post, sig, tokens[buy], tokens[sell]);
      }
    }
  }

  function testFuzz_MixedM7PairAmounts(
    uint256 buy,
    uint256 sell,
    uint256 fraction
  ) public {
    buy = bound(buy, 0, 6);
    sell = (buy + bound(sell, 1, 6)) % 7;
    fraction = bound(fraction, 1, 5000);
    BCoWPool pool = _mixedM7();
    address[] memory t = helper.tokens(address(pool));
    uint256 amount = _balance(pool, t[buy]) * fraction / 10_000;
    (GPv2Order.Data memory order,,,) = helper.orderFromBuyAmount(address(pool), t[buy], t[sell], amount);
    assertEq(order.buyAmount, amount);
    pool.verify(order);
    // Small tentative outputs are supported for every M7 weight ratio.
    amount = _balance(pool, t[sell]) * bound(fraction, 1, 100) / 10_000;
    (order,,,) = helper.orderFromSellAmount(address(pool), t[sell], t[buy], amount);
    assertApproxEqRel(order.sellAmount, amount, 1e15);
    pool.verify(order);
  }

  function _balance(
    BCoWPool pool,
    address token
  ) internal view returns (uint256) {
    return pool.getBalance(token);
  }

  function _check(
    BCoWPool pool,
    GPv2Order.Data memory order,
    GPv2Interaction.Data[] memory pre,
    GPv2Interaction.Data[] memory post,
    bytes memory sig,
    address buy,
    address sell
  ) internal view {
    assertEq(address(order.buyToken), buy);
    assertEq(address(order.sellToken), sell);
    assertGt(order.buyAmount, 0);
    assertGt(order.sellAmount, 0);
    pool.verify(order);
    assertEq(
      order.sellAmount,
      helper.calcOutGivenIn(
        _balance(pool, buy),
        pool.getDenormalizedWeight(buy),
        _balance(pool, sell),
        pool.getDenormalizedWeight(sell),
        order.buyAmount,
        0
      )
    );
    assertEq(order.appData, factory.APP_DATA());
    assertEq(order.feeAmount, 0);
    assertEq(order.kind, GPv2Order.KIND_SELL);
    assertEq(order.receiver, address(0));
    assertEq(pre.length, 1);
    assertEq(pre[0].target, address(pool));
    assertEq(pre[0].value, 0);
    assertEq(
      pre[0].callData,
      abi.encodeWithSelector(pool.commit.selector, GPv2Order.hash(order, pool.SOLUTION_SETTLER_DOMAIN_SEPARATOR()))
    );
    assertEq(post.length, 0);
    assertEq(sig, abi.encodePacked(address(pool), abi.encode(order)));
  }

  function test_InvalidPairsAndPools() public {
    BCoWPool pool = _mixedM7();
    address[] memory t = helper.tokens(address(pool));
    for (uint256 mode; mode < 2; ++mode) {
      vm.expectRevert(ICOWAMMPoolHelper.PoolDoesNotExist.selector);
      _quote(mode, address(0), t[0], t[1], 1);
      vm.expectRevert(BCoWHelper.InvalidToken.selector);
      _quote(mode, address(pool), t[0], t[0], 1);
      vm.expectRevert(BCoWHelper.InvalidToken.selector);
      _quote(mode, address(pool), address(0), t[1], 1);
      vm.expectRevert(BCoWHelper.InvalidToken.selector);
      _quote(mode, address(pool), t[0], address(0), 1);
      IBPool unfinished = factory.newBPool('Unfinished', 'U');
      vm.expectRevert(IBPool.BPool_PoolNotFinalized.selector);
      _quote(mode, address(unfinished), t[0], t[1], 1);
      vm.expectRevert(BCoWHelper.InvalidAmount.selector);
      _quote(mode, address(pool), t[0], t[1], 0);
    }
    vm.expectRevert(BCoWHelper.InvalidToken.selector);
    helper.orderFromBuyAmount(address(pool), t[0], 1);
    vm.expectRevert(BCoWHelper.InvalidToken.selector);
    helper.orderFromSellAmount(address(pool), t[0], 1);
  }

  function _quote(
    uint256 mode,
    address pool,
    address buy,
    address sell,
    uint256 amount
  ) internal {
    if (mode == 0) helper.orderFromBuyAmount(pool, buy, sell, amount);
    else helper.orderFromSellAmount(pool, sell, buy, amount);
  }

  function test_AmountLimitsAndRoundingToZero() public {
    BCoWPool pool = _mixedM7();
    address[] memory t = helper.tokens(address(pool));
    uint256 maxIn = (_balance(pool, t[0]) * helper.MAX_IN_RATIO() + 5e17) / 1e18;
    (GPv2Order.Data memory order,,,) = helper.orderFromBuyAmount(address(pool), t[0], t[1], maxIn);
    pool.verify(order);
    vm.expectRevert(BCoWHelper.InvalidAmount.selector);
    helper.orderFromBuyAmount(address(pool), t[0], t[1], maxIn + 1);
    vm.expectRevert(BCoWHelper.InvalidAmount.selector);
    helper.orderFromBuyAmount(address(pool), t[0], t[1], 1);
    (order,,,) = helper.orderFromBuyAmount(address(pool), t[0], t[1], maxIn - 1);
    pool.verify(order);
    vm.expectRevert(BCoWHelper.InvalidAmount.selector);
    helper.orderFromSellAmount(address(pool), t[0], t[1], 1);
    uint256 maxOut = (_balance(pool, t[0]) * helper.MAX_OUT_RATIO() + 5e17) / 1e18;
    vm.expectRevert(BCoWHelper.InvalidAmount.selector);
    helper.orderFromSellAmount(address(pool), t[0], t[1], maxOut + 1);
    // Selling a high-weight token for a lower-weight token hits the input cap first.
    vm.expectRevert(BCoWHelper.InvalidAmount.selector);
    helper.orderFromSellAmount(address(pool), t[0], t[5], maxOut);
    // Reversing that weight ratio keeps the inverse quote within the input cap.
    maxOut = (_balance(pool, t[5]) * helper.MAX_OUT_RATIO() + 5e17) / 1e18;
    (order,,,) = helper.orderFromSellAmount(address(pool), t[5], t[0], maxOut);
    pool.verify(order);
    (order,,,) = helper.orderFromSellAmount(address(pool), t[5], t[0], maxOut - 1);
    pool.verify(order);
  }

  function test_LegacyTwoTokenQuotesMatchExplicitPairs() public {
    uint256[] memory weights = new uint256[](2);
    uint256[] memory balances = new uint256[](2);
    weights[0] = 8e18;
    weights[1] = 6e18;
    balances[0] = 800e18;
    balances[1] = 600e18;
    BCoWPool pool = _pool(weights, balances);
    address[] memory t = helper.tokens(address(pool));
    for (uint256 i; i < 2; ++i) {
      (GPv2Order.Data memory legacy,,,) = helper.orderFromBuyAmount(address(pool), t[i], 1e18);
      (GPv2Order.Data memory explicit,,,) = helper.orderFromBuyAmount(address(pool), t[i], t[1 - i], 1e18);
      assertEq(abi.encode(legacy), abi.encode(explicit));
      (legacy,,,) = helper.orderFromSellAmount(address(pool), t[i], 1e18);
      (explicit,,,) = helper.orderFromSellAmount(address(pool), t[i], t[1 - i], 1e18);
      assertEq(abi.encode(legacy), abi.encode(explicit));
    }
  }
}
