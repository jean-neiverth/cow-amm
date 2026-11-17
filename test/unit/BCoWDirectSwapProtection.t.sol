// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {BCoWHelperValidationFixture} from './BCoWHelperValidation.t.sol';
import {BCoWPool} from 'contracts/BCoWPool.sol';
import {BNum} from 'contracts/BNum.sol';
import {IBPool} from 'interfaces/IBPool.sol';
import {LocalStockToken} from 'script/local/LocalStockToken.sol';

/// @notice Economic checks at supplied prices, excluding gas and external trading costs.
contract BCoWDirectSwapProtectionTest is BCoWHelperValidationFixture {
  address internal constant ARBITRAGEUR = address(0xA4B);

  struct SwapBalances {
    uint256 reserveIn;
    uint256 reserveOut;
    uint256 beforeIn;
    uint256 beforeOut;
    uint256 amountIn;
    uint256 amountOut;
  }

  function _portfolio(
    bool protected,
    uint256 seed
  ) internal returns (BCoWPool pool) {
    pool = BCoWPool(address(factory.newBPool('M7', 'M7')));
    uint8[7] memory decimals = [uint8(18), 6, 8, 18, 6, 18, 8];
    uint256[7] memory units = [uint256(8), 6, 6, 6, 6, 4, 4];
    for (uint256 i; i < 7; ++i) {
      LocalStockToken token = new LocalStockToken('Stock', 'STOCK', decimals[i]);
      // Each reserve independently spans 0.5x to 2x its initial M7 amount.
      uint256 reserveBps = seed == 0 ? 10_000 : 5000 + uint256(keccak256(abi.encode(seed, i))) % 15_001;
      uint256 balance = units[i] * 100 * 10 ** decimals[i] * reserveBps / 10_000;
      token.mint(address(this), balance);
      token.approve(address(pool), balance);
      pool.bind(address(token), balance, units[i] * 1e18);
    }
    if (protected) pool.setSwapFee(pool.MAX_FEE());
    assertEq(pool.getSwapFee(), protected ? pool.MAX_FEE() : pool.MIN_FEE());
    pool.finalize();
    assertEq(pool.getSwapFee(), protected ? pool.MAX_FEE() : pool.MIN_FEE());
  }

  // All 42 directions, both entrypoints, and four sizes. Each swap starts
  // from the same reserves; the input/output price ratio is the worst case
  // within independently chosen external prices of $0.01 through $100.
  function test_AllProtectedPairsAreUneconomicAtRepresentativeSizes() public {
    BCoWPool pool = _portfolio(true, 0);
    address[] memory tokens = pool.getFinalTokens();
    uint256[4] memory sizeBps = [uint256(1), 100, 1000, 3333];
    for (uint256 i; i < 7; ++i) {
      for (uint256 j; j < 7; ++j) {
        if (i == j) continue;
        uint256[2] memory successes;
        for (uint256 k; k < sizeBps.length; ++k) {
          for (uint256 mode; mode < 2; ++mode) {
            uint256 snapshot = vm.snapshot();
            (uint256 spent, uint256 received) = _swap(pool, tokens[i], tokens[j], sizeBps[k], mode == 1);
            if (spent > 0) ++successes[mode];
            assertLe(received * 10_000, spent, 'Profitable protected swap at worst-case reference prices');
            assertTrue(vm.revertToAndDelete(snapshot));
          }
        }
        assertGt(successes[0], 0, 'No successful exact-input coverage for this pair');
        assertGt(successes[1], 0, 'No successful exact-output coverage for this pair');
      }
    }
  }

  function testFuzz_ProtectedSwapsAcrossReserveImbalances(
    uint256 seed,
    uint256 input,
    uint256 offset,
    uint256 sizeBps,
    bool exactOut
  ) public {
    seed = bound(seed, 1, type(uint128).max);
    input = bound(input, 0, 6);
    uint256 output = (input + bound(offset, 1, 6)) % 7;
    sizeBps = bound(sizeBps, 1, exactOut ? 3333 : 5000);
    BCoWPool pool = _portfolio(true, seed);
    address[] memory tokens = pool.getFinalTokens();
    // Fee-adjusted marginal cost already exceeds the maximum external
    // output/input price ratio; finite curve trades only worsen that rate.
    assertGt(
      pool.getSpotPrice(tokens[input], tokens[output]) * 10 ** LocalStockToken(tokens[output]).decimals(),
      10_000 * 10 ** LocalStockToken(tokens[input]).decimals() * 1e18
    );
    (uint256 spent, uint256 received) = _swap(pool, tokens[input], tokens[output], sizeBps, exactOut);
    assertLe(received * 10_000, spent);
  }

  function _swap(
    BCoWPool pool,
    address input,
    address output,
    uint256 sizeBps,
    bool exactOut
  ) internal returns (uint256 spent, uint256 received) {
    LocalStockToken tokenIn = LocalStockToken(input);
    LocalStockToken tokenOut = LocalStockToken(output);
    SwapBalances memory b;
    b.reserveIn = tokenIn.balanceOf(address(pool));
    b.reserveOut = tokenOut.balanceOf(address(pool));
    b.amountOut = b.reserveOut * sizeBps / 10_000;
    b.amountIn = exactOut ? _quoteInput(pool, input, output, b.amountOut) : b.reserveIn * sizeBps / 10_000;
    tokenIn.mint(ARBITRAGEUR, b.amountIn);
    b.beforeIn = tokenIn.balanceOf(ARBITRAGEUR);
    b.beforeOut = tokenOut.balanceOf(ARBITRAGEUR);
    vm.startPrank(ARBITRAGEUR);
    tokenIn.approve(address(pool), type(uint256).max);
    bool success = _executeSwap(pool, input, output, b, exactOut);
    vm.stopPrank();
    if (!success) {
      assertEq(tokenIn.balanceOf(ARBITRAGEUR), b.beforeIn);
      assertEq(tokenOut.balanceOf(ARBITRAGEUR), b.beforeOut);
      assertEq(tokenIn.balanceOf(address(pool)), b.reserveIn);
      assertEq(tokenOut.balanceOf(address(pool)), b.reserveOut);
      return (0, 0);
    }
    uint256 spentRaw = b.beforeIn - tokenIn.balanceOf(ARBITRAGEUR);
    uint256 receivedRaw = tokenOut.balanceOf(ARBITRAGEUR) - b.beforeOut;
    assertGt(spentRaw, 0);
    assertGt(receivedRaw, 0);
    assertEq(tokenIn.balanceOf(address(pool)), b.reserveIn + spentRaw);
    assertEq(tokenOut.balanceOf(address(pool)), b.reserveOut - receivedRaw);
    spent = spentRaw * 1e18 / 10 ** tokenIn.decimals();
    received = receivedRaw * 1e18 / 10 ** tokenOut.decimals();
  }

  function _executeSwap(
    BCoWPool pool,
    address input,
    address output,
    SwapBalances memory b,
    bool exactOut
  ) internal returns (bool success) {
    // Permissive caller limits: never count a caller slippage limit as protection.
    bytes memory callData = exactOut
      ? abi.encodeCall(IBPool.swapExactAmountOut, (input, type(uint256).max, output, b.amountOut, type(uint256).max))
      : abi.encodeCall(IBPool.swapExactAmountIn, (input, b.amountIn, output, 0, type(uint256).max));
    bytes memory reason;
    (success, reason) = address(pool).call(callData);
    if (!success) {
      // High fees and raw-unit rounding can produce zero output or violate
      // the pool's rounded spot/average-price consistency check. Verify these
      // exact numerical rejections; every pair must also execute successfully.
      assertEq(reason.length, 4, 'Unexpected swap rejection');
      uint256 quotedOut = exactOut ? b.amountOut : _quoteOutput(pool, input, output, b.amountIn);
      if (bytes4(reason) == BNum.BNum_DivZero.selector) {
        assertEq(quotedOut, 0, 'Division failure was not caused by zero output');
      } else {
        assertEq(bytes4(reason), IBPool.BPool_SpotPriceBeforeAboveTokenRatio.selector);
        assertGt(quotedOut, 0);
        uint256 averagePrice = (b.amountIn * 1e18 + quotedOut / 2) / quotedOut;
        assertGt(pool.getSpotPrice(input, output), averagePrice, 'Unexpected price-consistency failure');
      }
    }
  }

  function _quoteInput(
    BCoWPool pool,
    address input,
    address output,
    uint256 amountOut
  ) internal view returns (uint256) {
    return pool.calcInGivenOut(
      pool.getBalance(input),
      pool.getDenormalizedWeight(input),
      pool.getBalance(output),
      pool.getDenormalizedWeight(output),
      amountOut,
      pool.getSwapFee()
    );
  }

  function _quoteOutput(
    BCoWPool pool,
    address input,
    address output,
    uint256 amountIn
  ) internal view returns (uint256) {
    return pool.calcOutGivenIn(
      pool.getBalance(input),
      pool.getDenormalizedWeight(input),
      pool.getBalance(output),
      pool.getDenormalizedWeight(output),
      amountIn,
      pool.getSwapFee()
    );
  }

  function test_LowFeeControlAllowsProfitableArbitrageThroughBothMethods() public {
    BCoWPool ordinary = _portfolio(false, 0);
    BCoWPool protected = _portfolio(true, 0);
    address[] memory low = ordinary.getFinalTokens();
    address[] memory high = protected.getFinalTokens();
    for (uint256 mode; mode < 2; ++mode) {
      uint256 snapshot = vm.snapshot();
      // NVDA doubles to $2, while the incoming MSFT stays at $1.
      (uint256 spent, uint256 received) = _swap(ordinary, low[1], low[0], 100, mode == 1);
      assertGt(received * 2, spent, 'Low-fee control must be profitable');
      (spent, received) = _swap(protected, high[1], high[0], 100, mode == 1);
      assertLt(received * 2, spent, 'Protected version must lose money');
      assertTrue(vm.revertToAndDelete(snapshot));
    }
  }

  function test_ProtectedFeeIsImmutableAndTradeLimitsStillApply() public {
    BCoWPool pool = _portfolio(true, 0);
    uint256 lowFee = pool.MIN_FEE();
    vm.expectRevert(IBPool.BPool_PoolIsFinalized.selector);
    pool.setSwapFee(lowFee);
    address[] memory tokens = pool.getFinalTokens();
    uint256 maxIn = pool.getBalance(tokens[0]) / 2;
    vm.expectRevert(IBPool.BPool_TokenAmountInAboveMaxRatio.selector);
    pool.swapExactAmountIn(tokens[0], maxIn + 1, tokens[1], 0, type(uint256).max);
    uint256 maxOut = (pool.getBalance(tokens[1]) * pool.MAX_OUT_RATIO() + 5e17) / 1e18;
    vm.expectRevert(IBPool.BPool_TokenAmountOutAboveMaxOut.selector);
    pool.swapExactAmountOut(tokens[0], type(uint256).max, tokens[1], maxOut + 1, type(uint256).max);
  }
}
