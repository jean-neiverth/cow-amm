# Local seven-asset CoW settlement

This demonstration deploys CoW settlement from the repository's pinned `@cowprotocol/contracts` dependency. It runs on a fresh Anvil chain without a mainnet fork, API keys, archive RPC, or impersonation of an existing solver.

## Run it

Requirements: Node 20+, npm, and Foundry (`forge` and `anvil`) on your PATH. Node 22.14.0 and Forge 1.4.4 were used for validation.

Install the locked dependencies:

```sh
npx --yes yarn@1.22.22 install --frozen-lockfile --ignore-scripts
```

Start the chain in one terminal:

```sh
npm run local:chain
```

In another terminal, deploy and execute the demonstration:

```sh
npm run local:demo
```

The demo uses RPC `http://127.0.0.1:8546` and chain ID `31338`, separate from the Folio app's default chain. It uses Anvil's default public test accounts: account 0 manages the deployment and supplies liquidity, account 1 is the registered solver, and account 2 signs the counterparty order. `LOCAL_RPC_URL` can override the RPC address; the chain must still have ID 31338 and the default test accounts must be funded.

The commands can also be run separately:

```sh
npm run local:deploy
npm run local:settle
npm run local:verify
```

`local:verify` independently reads the chain and checks the last recorded settlement. You can repeat `local:settle` to execute another pairwise trade at the same reference prices. This is not a promise that every repeat has a trade available: the helper returns no order once there is no candidate with positive calculated opportunity.

Addresses, transaction hashes, and verification inputs are stored in the ignored file `.local/m7.json`. Restarting Anvil clears contracts and balances; rerun `local:deploy` afterward. Redeploying writes a new deployment manifest and leaves any earlier deployment on the running local chain intact.

## What gets deployed

- Actual `GPv2AllowListAuthentication`, initialized with the local manager and the local solver registered.
- Actual `GPv2Settlement`, which creates its own actual `GPv2VaultRelayer`.
- `BCoWFactory`, `BCoWHelper`, and one finalized `BCoWPool`.
- Seven unrestricted local mock tokens with mixed decimal counts.

| Token | Target weight | Decimals | Initial token amount |
|---|---|---|---|
| NVDA | 20% | 18 | 800 |
| MSFT | 15% | 6 | 600 |
| AAPL | 15% | 8 | 600 |
| AMZN | 15% | 18 | 600 |
| GOOGL | 15% | 6 | 600 |
| META | 10% | 18 | 400 |
| TSLA | 10% | 8 | 400 |

The denormalized weights are `[8,6,6,6,6,4,4]`. Synthetic reference prices start at $1 per whole token, so these balances initially match the weights. They are demonstration prices, not actual stock prices. Before finalization the pool's direct swap fee is set to 99.9999%.

All demo orders use ERC-20 balance markers, for which CoW's vault relayer transfers tokens directly. The Balancer Vault constructor argument is zero because internal Vault balances and Vault batch swaps are outside this demonstration. Those routes are not supported by this local deployment.

## Settlement flow

1. Raise NVDA's synthetic reference price by 10%.
2. Ask the helper for a pairwise pool order and validate it with the pool.
3. Create an opposite counterparty order at the supplied reference price, rounded up by less than one incoming raw token unit.
4. Fund the local trader with the required mock token and approve the actual vault relayer.
5. Sign the counterparty order using EIP-712 and the deployed settlement's domain. Authorize the pool order through its existing ERC-1271 mechanism.
6. Submit both orders and the pool commitment in one settlement transaction, signed by the registered local solver.
7. Read chain state and verify the outcome.

The pair's clearing-price ratio is expressed using the exact matched quantities to avoid requiring a rounding subsidy from pre-existing settlement balances. Untouched token prices do not affect these two matched trades.

The checker verifies:

- The receipt succeeded and the sender is the registered solver.
- Pool and trader token movements match the two orders.
- The other five portfolio reserves are unchanged.
- No mock tokens remain in settlement.
- Total LP share supply and the original LP's shares are unchanged.
- The traded pair's weighted product increases.

For the independent invariant calculation, token balances are normalized to micro-token units and the M7 integer exponents are reduced by their common factor of two. The untouched five terms cancel. This is sufficient for these demonstration balances and tested price movements; it is not a general-purpose arbitrary-weight invariant library.

## Tests

Run the tests with fresh locally deployed CoW contracts, without running Anvil or setting an RPC:

```sh
npm run test:local:settlement
```

The local suite reuses the fork suite's balance, share, invariant, solver-authorization, and commitment checks. It also checks that an unauthorized account cannot register a solver. Cases include both a 10% price move and a fivefold price move with a bounded helper candidate.

Run the existing unit tests:

```sh
npm run test:unit
```

The existing fork integration suite remains available separately and requires an archive-capable `MAINNET_RPC`.

`local:deploy` disables Forge's automatic build-time linter because the installed Forge version reports existing repository-wide warnings under `deny_warnings`. Solidity compilation remains checked, and changed Solidity files are checked separately with Solhint and `forge fmt --check`.

## Scope

This demonstrates real local deployment, signing, authorization, token-moving settlement, and resulting state. It supplies a price and a funded counterparty directly. Solver competition, external liquidity routing, public-network registration, and demonstrated LVR protection remain separate work.

## Explicit token-pair orders

The helper has four-argument overloads for pools with two through eight tokens:

```solidity
helper.orderFromBuyAmount(pool, buyToken, sellToken, buyAmount);
helper.orderFromSellAmount(pool, sellToken, buyToken, sellAmount);
```

Directions are from the pool's perspective: the pool receives `buyToken` and
sends `sellToken`. All amounts use raw token units. The buy amount is exact;
the sell amount is tentative because the helper inverse-quotes the incoming
amount and recomputes output using the forward math checked by the pool.
Callers must use the amounts in the returned order.

Both tokens must be distinct members of a finalized pool registered with the
helper's factory. `InvalidToken` rejects invalid pairs. `InvalidAmount` rejects
zero amounts, output rounded to zero, incoming amounts above `MAX_IN_RATIO`,
and tentative outgoing amounts above `MAX_OUT_RATIO`. Requests are rejected,
not silently capped. The forward-recomputed sell amount can differ slightly
from the tentative output cap because Balancer's power math is approximate.
The pool's verification remains the authority for order validity.

The existing three-argument methods retain their two-token behavior and reject
larger pools because the other token would be ambiguous. Ethers v5 callers
must select overloaded methods by their full signatures, for example:

```js
await helper['orderFromBuyAmount(address,address,address,uint256)'](
  pool, buyToken, sellToken, buyAmount,
);
```

## Progressive rebalancing

With Anvil running, execute a fresh deterministic scenario:

```sh
npm run test:local:rebalance
```

This deploys a fresh pool, applies fixed synthetic price multipliers
`[1.5, 0.8, 1.2, 0.9, 1.1, 0.7, 1.3]`, and repeatedly asks `order()` for a new
pairwise order against current reserves. Each settlement is a separate actual
transaction so the transient commitment clears naturally. It keeps one pool
order per settlement and verifies every settlement against fresh pool and
trader balance snapshots, including unchanged LP shares, five untouched
reserves, and weighted invariant growth.

Allocation drift is half the sum of absolute differences between current value
weights and target weights, calculated at the same fixed reference prices.
It stops at drift at or below 0.1 percentage points, `NoOrder`, or 64 settlements.
The command checks that at least three settlements occurred, more than one
unordered pair was used, final drift is below initial drift, and the iteration
limit was not reached. Exact convergence and optimal pair sequences are not
claimed. The scenario uses a funded counterparty and supplied prices, as the
single-settlement demo does; it does not establish solver competition or LVR
protection.

To rebalance an existing local deployment instead, run `npm run local:rebalance`.
This command uses the same fixed price scenario and bounds but does not assert
a minimum number of trades: an already balanced pool may stop immediately.
The deployment manifest records prices, initial/final drift, tolerance,
stopping reason, and each settlement's transaction hash, pair, and drift under
`rebalance`. `local:verify` continues to verify the most recent settlement.
