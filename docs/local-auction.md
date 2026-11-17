# Funded local surplus auction

This experiment compares ordinary weighted-AMM arbitrage with a local auction
for a protected seven-asset CoW AMM. It uses actual pool contracts, CoW
settlement, ERC-1271 authorization, and finite-inventory external venues on
Anvil. Prices and venue liquidity are synthetic. It is not a production CoW
auction, historical backtest, or proof of universal LVR elimination.

## Run and reproduce

Use the dependencies and Foundry prerequisites in [local-m7.md](local-m7.md).
Start the dedicated chain in one terminal:

```sh
npm run local:chain
```

In another terminal:

```sh
npm run test:local:auction
npm run local:auction:verify
```

`local:auction` and `test:local:auction` run the same checked experiment. Each
invocation deploys a fresh environment on chain 31338, replacing the ignored
local deployment manifest. It does not reuse a previously traded pool. RPC
can be overridden with `LOCAL_RPC_URL`.

The reports are:

- `.local/auction.json`: assumptions, addresses, initial/final balances,
  proposals, rejection/skip reasons, complete settlement calldata, winner
  transactions, and balance snapshots for every executed trade.
- `.local/auction.csv`: one row per executed trade, suitable for plotting
  portfolio value, surplus, trading P&L, drift, and gas costs over rounds.

Restarting Anvil removes the deployment and history. Verification requires the
same running chain and its historical state. Re-run the experiment after a
restart. The auction has its own verification command; the single-settlement
`local:verify` manifest does not describe auction settlements.

## Fixed assumptions

Both portfolios start with M7 weights 20/15/15/15/15/10/10 and balances
800/600/600/600/600/400/400, using 18/6/8 decimal mock assets. Starting reference
prices of $1 are shocked once to `[1.5, 0.8, 1.2, 0.9, 1.1, 0.7, 1.3]` and
held fixed. Each portfolio is worth $4,400 at those marks before trading.

The ordinary pool has a 0.3% swap fee. The protected pool has `MAX_FEE` for
direct swaps, while its CoW orders use the existing zero-fee curve minimum.
Both paths have access to equivalent, separately funded external venues with
fees of 10 and 30 basis points. The venues pay the fixed reference exchange
rate less their fee, subject to finite token inventory; they do not model
order-book depth or price impact. Cloning their inventories prevents one
portfolio from consuming the other's hypothetical external liquidity.

Two route-constrained bidders use separate authorized solver accounts. Bidder
A has the 10-basis-point route, bidder B the 30-basis-point route. Each retains
a conservative gas reserve plus a $0.05 minimum profit and bids the rest to the
pool. The reserve assumes an 800,000-gas transaction at 1 gwei with ETH marked
at $3,000, or $2.40. Actual gas used, actual native-currency debits, and realized
net solver profit are checked and reported separately. Gas is paid by the
solver/arbitrageur; it is not deducted again from LP value.

The ordinary control uses the best available external route and the same gas
reserve/profit threshold. Its pre-funded atomic executor buys a fixed output
from the pool, sells it externally, restores its starting token capital, and
pays only earned profit to the arbitrageur.

All token minting occurs during setup: pools, venues, working capital, and
small disclosed solver inventories. After setup, token supplies must remain
unchanged. The control's working-capital financing cost, deployment costs,
organic order flow, protocol rewards, management fees, and public-network
auction rules are not modeled.

## Proposal evaluation

For each protected-pool round:

1. Ask the helper to select a pair and canonical order against current reserves.
2. Hold its pair, sell quantity, and canonical minimum fixed for all bidders.
3. Obtain each route's executable output from its venue contract.
4. Construct the complete settlement: pool commitment, token approval, external
   venue trade, pool payout, and explicit solver payout.
5. Execute each proposal inside an Anvil snapshot, read actual balance changes,
   check conservation and profitability, and revert the snapshot.
6. Rank valid proposals by the measured incoming value above the fixed curve
   minimum. Break ties deterministically. Submit only the winner permanently
   and require its realized score to match the simulation.

An inflated self-reported score on the more expensive bidder is ignored.
Simulation transactions are reverted and are not canonical transaction history;
only winner and ordinary-control transaction hashes are presented as executed
results. The report retains simulation calldata and measured gas for inspection.

The first round also checks:

- Overpromising more than a route can supply fails actual settlement.
- A proposal that executes by spending the solver's existing tokens is rejected
  as a capital contribution, even though the pool receives more tokens.
- An underfunded venue is skipped without trading.
- A gas/profit reserve exceeding the available opportunity is skipped.

Every accepted proposal accounts for all seven assets across both pools,
venues, solvers, executor, arbitrageur, manager, and settlement. Unrelated
balances cannot move. Settlement cannot start with or retain spare tokens.
LP shares cannot change. The protected pair's weighted invariant must grow,
and solver token proceeds must cover actual gas plus the minimum profit.

This is an explicit local bidding policy, not a strategic-equilibrium model:
it demonstrates executable competing routes and selection, not how production
solvers would bid or whether additional bidders cause a particular capture rate.

## Comparison and metrics

The first trades use identical starting reserves, the same pair, and the same
quantity sold by each pool. Their difference in LP trading P&L is a matched
execution comparison. Afterward the portfolios evolve independently: different
incoming amounts change subsequent orders. Final portfolio-value differences
therefore include differences in their trade paths and cannot all be attributed
to one matched trade or a fixed capture percentage.

Let `S` be outgoing pool tokens, `C` the incoming canonical curve minimum,
`R` actual incoming pool tokens, and `Q` the external route's output. With
fixed reference prices `pSell` and `pBuy`:

```text
Curve surplus delivered to LPs = (R - C) × pBuy
LP trading P&L                 = R × pBuy - S × pSell
Reference opportunity          = S × pSell - C × pBuy
Route cost                     = S × pSell - Q × pBuy
Solver token proceeds          = (Q - R) × pBuy
```

The experiment checks the exact accounting identity before display rounding:

```text
Reference opportunity = LP curve surplus + solver token proceeds + route cost
LP trading P&L        = LP curve surplus - reference opportunity
```

Positive curve surplus can coexist with negative LP trading P&L. The report
calls the remaining negative P&L `residualReferenceLossUsd`, not a fully
estimated historical LVR measure. The ordinary report separately identifies
extra incoming value from the 0.3% fee versus a zero-fee exact-output quote.

NAV is the value of actual reserves at the fixed marks. Drift is half the sum
of absolute differences between current value weights and target weights.
USD fields in JSON and CSV use 18 decimals, drift uses a scale of `1e12`, and
token amounts are raw units with decimals listed under `assets`. Proposal
scores retain unrounded raw-token-times-price products; divide by `1e18` to
obtain USD with 18 decimals. Negative P&L values are preserved.

The checked run requires at least three protected settlements, competing valid
bids in the first round, profitable ordinary arbitrage, better LP execution in
the first matched trade, lower final protected drift, and higher final protected
NAV in this specified scenario. Both paths stop when no order or profitable
valid proposal remains, with a maximum of 32 rounds. It does not force every
opportunity to fill or claim every scenario will outperform.

`local:auction:verify` independently reads each executed transaction's historical
pre/post balances, checks its actual gas debit, recomputes surplus/P&L/drift,
and checks the initial and final historical states against the report. It also replays each recorded
valid bid with historical `eth_call`, reconstructs its allowed calldata and
route quote, and checks that no recorded valid bid beats the chosen winner.
Future historical-market replay can reuse this reporting approach, but would
need market data and a more realistic external execution model.

## Example checked result

With the fixed assumptions above, the checked run produced:

| Metric | Protected CoW AMM | Ordinary AMM |
|---|---:|---:|
| Initial reference value | $4,400.00 | $4,400.00 |
| Executed trades | 5 | 4 |
| Final reference value | $4,387.20 | $4,267.08 |
| Final allocation drift | 0.8968% | 1.2017% |

The protected path delivered $122.55 above its successive canonical curve
minimums. Its first matched execution improved LP proceeds by $76.10 relative
to the ordinary AMM. The final path difference was $120.12. The protected LPs
still lost $12.80 in reference value during trading; recovered surplus is not
the same as positive trading P&L. These values describe this synthetic scenario,
not an expected market return.
