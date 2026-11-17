import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ethers } from 'ethers';
import { root, provider, manager, solver, trader, chainId, contract, deploy, deployM7,
  load, asOrder, trade, orderTuple, pairInvariant, allocationDrift, isNoOrder } from './m7.mjs';

const reportPath = resolve(root, '.local/auction.json');
const unit = 10n ** 18n;
const gasPrice = 1_000_000_000n;
const gasLimit = 800_000n;
const ethUsd = 3000n * unit;
const minProfitUsd = unit / 20n;
const gasBudgetUsd = gasLimit * gasPrice * ethUsd / unit;
const ordinaryFee = 3n * unit / 1000n;
const stringify = (value) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const ceilDiv = (a, b) => (a + b - 1n) / b;
const txOptions = { type: 0, gasLimit: ethers.BigNumber.from(gasLimit.toString()),
  gasPrice: ethers.BigNumber.from(gasPrice.toString()) };
const bidderB = ethers.Wallet.fromMnemonic('test test test test test test test test test test test junk',
  "m/44'/60'/0'/0/3").connect(provider);
const value = (balances, prices) => balances.reduce((sum, amount, i) => sum + BigInt(amount) * BigInt(prices[i]), 0n);

// Snapshot reverts can reuse block heights. ethers' block-event-based wait()
// can then miss an already-mined receipt; query receipts directly instead.
async function mined(pending) {
  const transaction = await pending;
  for (let attempt = 0; attempt < 100; ++attempt) {
    const raw = await provider.send('eth_getTransactionReceipt', [transaction.hash]);
    if (raw) {
      const receipt = provider.formatter.receipt(raw);
      if (receipt.status !== 1) throw Object.assign(new Error('Settlement reverted'), { code: 'CALL_EXCEPTION', receipt });
      return receipt;
    }
    await delay(100);
  }
  throw new Error(`Receipt not mined within 10 seconds: ${transaction.hash}`);
}

async function setup() {
  await deployM7();
  const state = await load();
  const tokens = await Promise.all(state.tokens.map((token) => contract('LocalStockToken', token.address)));
  const addresses = state.tokens.map((token) => token.address);
  const shock = [150n, 80n, 120n, 90n, 110n, 70n, 130n];
  const prices = state.tokens.map((token, i) => 10n ** BigInt(36 - token.decimals) * shock[i] / 100n);
  const settlement = await contract('GPv2Settlement', state.settlement);
  const authentication = await contract('GPv2AllowListAuthentication', state.authentication);
  await (await authentication.addSolver(bidderB.address)).wait();
  const factory = await contract('BCoWFactory', state.factory);
  const receipt = await (await factory.newBPool('Ordinary M7 control', 'M7C')).wait();
  const ordinary = await contract('BCoWPool', receipt.events.find((event) => event.event === 'LOG_NEW_POOL').args.bPool);
  for (let i = 0; i < tokens.length; ++i) {
    const amount = (await tokens[i].balanceOf(state.pool)).toString();
    await (await tokens[i].mint(manager.address, amount)).wait();
    await (await tokens[i].approve(ordinary.address, amount)).wait();
    await (await ordinary.bind(tokens[i].address, amount, ethers.utils.parseEther(String(state.tokens[i].weight)))).wait();
  }
  await (await ordinary.setSwapFee(ordinaryFee.toString())).wait();
  await (await ordinary.finalize()).wait();
  const venues = [];
  for (const fee of [10, 30, 10, 30, 10]) {
    const venue = await deploy('LocalAuctionVenue', [fee]);
    await (await venue.setPrices(addresses, prices.map(String))).wait();
    venues.push(venue);
  }
  const executor = await deploy('LocalArbitrage', [trader.address]);
  // All minting is confined to setup. The scarce venue and bidder inventories
  // also make unfillable and executable-but-subsidized proposals testable.
  for (let i = 0; i < tokens.length; ++i) {
    const scale = 10n ** BigInt(state.tokens[i].decimals);
    for (let j = 0; j < venues.length; ++j) {
      await (await tokens[i].mint(venues[j].address, (scale * (j === 4 ? 1n : 100_000n)).toString())).wait();
    }
    await (await tokens[i].mint(executor.address, (scale * 100_000n).toString())).wait();
    for (const signer of [solver, bidderB]) {
      await (await tokens[i].mint(signer.address, scale.toString())).wait();
      await (await tokens[i].connect(signer).approve(settlement.address, ethers.constants.MaxUint256)).wait();
    }
  }
  const actors = { protected: state.pool, ordinary: ordinary.address, settlement: settlement.address,
    solverA: solver.address, solverB: bidderB.address, arbitrageur: trader.address,
    executor: executor.address, manager: manager.address,
    venueA: venues[0].address, venueB: venues[1].address,
    controlVenueA: venues[2].address, controlVenueB: venues[3].address, scarceVenue: venues[4].address };
  return { state, tokens, addresses, prices, settlement, ordinary, executor, venues, actors,
    helper: await contract('BCoWHelper', state.helper), pool: await contract('BCoWPool', state.pool) };
}

async function snapshot(ctx, blockTag = 'latest') {
  const accounts = Object.fromEntries(await Promise.all(Object.entries(ctx.actors).map(async ([name, address]) =>
    [name, await Promise.all(ctx.tokens.map(async (token) => (await token.balanceOf(address, { blockTag })).toString()))])));
  const supply = await Promise.all(ctx.tokens.map(async (token) => (await token.totalSupply({ blockTag })).toString()));
  const shares = {};
  for (const name of ['protected', 'ordinary']) {
    const pool = name === 'protected' ? ctx.pool : ctx.ordinary;
    shares[name] = [(await pool.totalSupply({ blockTag })).toString(),
      (await pool.balanceOf(ctx.state.manager, { blockTag })).toString()];
  }
  const native = Object.fromEntries(await Promise.all(['solverA', 'solverB', 'arbitrageur'].map(async (name) =>
    [name, (await provider.getBalance(ctx.actors[name], blockTag)).toString()])));
  return { accounts, supply, shares, native };
}

function conservation(ctx, before, after) {
  assert.deepEqual(after.supply, ctx.initial.supply, 'Minting or burning occurred after setup');
  assert.deepEqual(after.shares, before.shares, 'LP shares changed');
  for (let i = 0; i < ctx.tokens.length; ++i) {
    const total = (s) => Object.values(s.accounts).reduce((sum, amounts) => sum + BigInt(amounts[i]), 0n);
    assert.equal(total(before), total(after), 'Tokens entered or left the accounted actors');
    assert.equal(after.accounts.settlement[i], '0', 'Unaccounted settlement balance');
    assert.equal(before.accounts.settlement[i], '0', 'Pre-existing settlement subsidy');
  }
}

function gasAccounting(before, after, sender, receipt) {
  const gasWei = BigInt(receipt.gasUsed.toString()) * BigInt(receipt.effectiveGasPrice.toString());
  for (const name of Object.keys(before.native)) {
    assert.equal(BigInt(before.native[name]) - BigInt(after.native[name]), name === sender ? gasWei : 0n,
      'Unexpected native currency contribution');
  }
  return gasWei;
}

async function orderFor(ctx, pool) {
  const result = await ctx.helper.order(pool, ctx.prices.map(String));
  const order = asOrder(result[0]);
  const sell = ctx.addresses.findIndex((address) => address.toLowerCase() === order.sellToken.toLowerCase());
  const buy = ctx.addresses.findIndex((address) => address.toLowerCase() === order.buyToken.toLowerCase());
  assert.ok(sell >= 0 && buy >= 0 && sell !== buy);
  return { order, pre: result[1].map(({ target, value: amount, callData }) => ({ target, value: amount, callData })),
    sell, buy, sold: BigInt(order.sellAmount.toString()), minimum: BigInt(order.buyAmount.toString()) };
}

async function routeQuote(ctx, selected, venueIndex) {
  const venue = ctx.venues[venueIndex];
  try {
    const gross = BigInt((await venue.quote(selected.order.sellToken, selected.order.buyToken,
      selected.sold.toString())).toString());
    return { status: 'quoted', venueIndex, venue: venue.address, gross };
  } catch (error) {
    if (error.errorName !== 'InsufficientInventory' && !JSON.stringify(error).includes(ethers.utils.id('InsufficientInventory()').slice(0, 10))) throw error;
    return { status: 'skipped', reason: 'insufficient-inventory', venueIndex, venue: venue.address };
  }
}

async function bidFor(ctx, selected, venueIndex, signerName, reserveUsd = gasBudgetUsd + minProfitUsd) {
  const quote = await routeQuote(ctx, selected, venueIndex);
  if (quote.status === 'skipped') return { ...quote, signerName };
  const { gross, venue } = quote;
  const retained = ceilDiv(reserveUsd * unit, ctx.prices[selected.buy]);
  if (gross <= selected.minimum + retained) return { status: 'skipped', reason: 'costs-exceed-opportunity',
    venue, signerName, gross, retained, minimum: selected.minimum };
  return { status: 'proposed', venueIndex, venue, signerName,
    gross, receive: gross - retained, retained };
}

function settlementData(ctx, selected, bid) {
  const signerAddress = ctx.actors[bid.signerName];
  const venue = ctx.venues[bid.venueIndex];
  const incoming = ctx.tokens[selected.buy];
  const outgoing = ctx.tokens[selected.sell];
  const interaction = (target, callData) => ({ target, value: 0, callData });
  const intra = [
    interaction(outgoing.address, outgoing.interface.encodeFunctionData('approve', [venue.address, selected.sold.toString()])),
    interaction(venue.address, venue.interface.encodeFunctionData('swap', [outgoing.address, incoming.address,
      selected.sold.toString(), bid.gross.toString()])),
  ];
  if (bid.subsidy) intra.push(interaction(incoming.address, incoming.interface.encodeFunctionData('transferFrom',
    [signerAddress, ctx.settlement.address, bid.subsidy.toString()])));
  const profit = bid.gross + (bid.subsidy ?? 0n) - bid.receive;
  const post = profit > 0n ? [interaction(incoming.address, incoming.interface.encodeFunctionData('transfer',
    [signerAddress, profit.toString()]))] : [];
  const clearingPrices = ctx.prices.map(String);
  clearingPrices[selected.sell] = bid.receive.toString();
  clearingPrices[selected.buy] = selected.sold.toString();
  const signature = ethers.utils.hexConcat([ctx.state.pool,
    ethers.utils.defaultAbiCoder.encode([orderTuple], [selected.order])]);
  return ctx.settlement.interface.encodeFunctionData('settle', [ctx.addresses, clearingPrices,
    [trade(selected.order, selected.sell, selected.buy, signature, 0x40)], [selected.pre, intra, post]]);
}

function verifyTrade(ctx, selected, bid, before, after, receipt) {
  conservation(ctx, before, after);
  for (const name of ['solverA', 'solverB']) {
    for (let i = 0; i < ctx.tokens.length; ++i) {
      assert.ok(BigInt(after.accounts[name][i]) >= BigInt(before.accounts[name][i]), 'solver-capital-contribution');
    }
  }
  const venueName = bid.venueIndex === 0 ? 'venueA' : 'venueB';
  for (const [name, amounts] of Object.entries(before.accounts)) {
    for (let i = 0; i < ctx.tokens.length; ++i) {
      let delta = 0n;
      if (name === 'protected' && i === selected.sell) delta = -selected.sold;
      if (name === 'protected' && i === selected.buy) delta = bid.receive;
      if (name === venueName && i === selected.sell) delta = selected.sold;
      if (name === venueName && i === selected.buy) delta = -bid.gross;
      if (name === bid.signerName && i === selected.buy) delta = bid.gross - bid.receive;
      assert.equal(BigInt(after.accounts[name][i]) - BigInt(amounts[i]), delta, `${name} token ${i} unexpected movement`);
    }
  }
  assert.ok(bid.receive >= selected.minimum);
  assert.ok(pairInvariant(ctx.state, after.accounts.protected, selected.sell, selected.buy) >
    pairInvariant(ctx.state, before.accounts.protected, selected.sell, selected.buy), 'Invariant did not grow');
  const gasWei = gasAccounting(before, after, bid.signerName, receipt);
  const solverValue = (bid.gross - bid.receive) * ctx.prices[selected.buy];
  assert.ok(solverValue / unit - gasWei * ethUsd / unit >= minProfitUsd, 'insufficient-net-solver-profit');
  // Score only the measured incoming delta above the fixed canonical minimum.
  const received = BigInt(after.accounts.protected[selected.buy]) - BigInt(before.accounts.protected[selected.buy]);
  return { score: (received - selected.minimum) * ctx.prices[selected.buy], gasWei,
    gasUsd: gasWei * ethUsd / unit, solverGrossUsd: solverValue / unit,
    solverNetUsd: solverValue / unit - gasWei * ethUsd / unit };
}

async function simulate(ctx, selected, bid) {
  const calldata = settlementData(ctx, selected, bid);
  const checkpoint = await provider.send('evm_snapshot', []);
  const before = await snapshot(ctx);
  let result;
  try {
    const signer = bid.signerName === 'solverA' ? solver : bidderB;
    const receipt = await mined(signer.sendTransaction({ to: ctx.settlement.address, data: calldata, ...txOptions }));
    const after = await snapshot(ctx);
    const measured = verifyTrade(ctx, selected, bid, before, after, receipt);
    result = { ...bid, status: 'valid', ...measured, calldata, simulatedGasUsed: receipt.gasUsed.toString() };
  } catch (error) {
    result = { ...bid, calldata, status: 'rejected', reason: error.code === 'CALL_EXCEPTION' ? 'settlement-reverted' : error.message };
  } finally {
    assert.equal(await provider.send('evm_revert', [checkpoint]), true);
  }
  assert.deepEqual(await snapshot(ctx), before, 'Proposal simulation leaked token state');
  return result;
}

function metrics(ctx, name, selected, before, after) {
  assert.equal(BigInt(selected.order.sellAmount.hex ?? selected.order.sellAmount.toString()), selected.sold);
  assert.equal(BigInt(selected.order.buyAmount.hex ?? selected.order.buyAmount.toString()), selected.minimum);
  assert.equal(BigInt(before.accounts[name][selected.sell]) - BigInt(after.accounts[name][selected.sell]), selected.sold);
  for (let i = 0; i < ctx.tokens.length; ++i) {
    if (i !== selected.sell && i !== selected.buy) assert.equal(before.accounts[name][i], after.accounts[name][i]);
  }
  const beforeValue = value(before.accounts[name], ctx.prices);
  const afterValue = value(after.accounts[name], ctx.prices);
  const received = BigInt(after.accounts[name][selected.buy]) - BigInt(before.accounts[name][selected.buy]);
  const opportunity = selected.sold * ctx.prices[selected.sell] - selected.minimum * ctx.prices[selected.buy];
  const surplus = (received - selected.minimum) * ctx.prices[selected.buy];
  assert.equal(afterValue - beforeValue, surplus - opportunity);
  return { navBeforeUsd: beforeValue / unit, navAfterUsd: afterValue / unit,
    tradingPnlUsd: (afterValue - beforeValue) / unit,
    curveSurplusUsd: surplus / unit, referenceOpportunityUsd: opportunity / unit,
    residualReferenceLossUsd: afterValue < beforeValue ? (beforeValue - afterValue) / unit : 0n,
    driftBefore: allocationDrift(ctx.state, before.accounts[name], ctx.prices),
    driftAfter: allocationDrift(ctx.state, after.accounts[name], ctx.prices) };
}

async function protectedRound(ctx, index) {
  let selected;
  try { selected = await orderFor(ctx, ctx.state.pool); }
  catch (error) { if (!isNoOrder(error)) throw error; return { status: 'stopped', reason: 'no-order' }; }
  const proposals = [];
  // Deliberately enumerate the expensive route first. Its self-reported score
  // is dishonest; only state changes from execution are used by the evaluator.
  for (const [venueIndex, signerName] of [[1, 'solverB'], [0, 'solverA']]) {
    const bid = await bidFor(ctx, selected, venueIndex, signerName);
    if (venueIndex === 1) bid.declaredScore = '999999999999999999999999999999999999';
    proposals.push(bid.status === 'proposed' ? await simulate(ctx, selected, bid) : bid);
  }
  if (index === 0) {
    const honest = proposals.find((proposal) => proposal.status === 'valid' && proposal.signerName === 'solverA');
    assert.ok(honest, `Expected an executable honest bid: ${stringify(proposals.map(({ status, reason }) => ({ status, reason })))}`);
    const base = { venueIndex: honest.venueIndex, venue: honest.venue, signerName: honest.signerName, gross: honest.gross };
    const overpromise = await simulate(ctx, selected, { ...base, receive: honest.gross + 1n, subsidy: 0n });
    assert.equal(overpromise.status, 'rejected');
    assert.equal(overpromise.reason, 'settlement-reverted');
    proposals.push(overpromise);
    const subsidy = 10n ** BigInt(ctx.state.tokens[selected.buy].decimals);
    const subsidized = await simulate(ctx, selected, { ...base, receive: honest.gross + subsidy, subsidy });
    assert.equal(subsidized.status, 'rejected');
    assert.match(subsidized.reason, /solver-capital-contribution/);
    proposals.push(subsidized);
    const unfillable = await bidFor(ctx, selected, 4, 'solverA');
    assert.equal(unfillable.reason, 'insufficient-inventory');
    proposals.push(unfillable);
    const tooCostly = await bidFor(ctx, selected, 0, 'solverA', 1_000_000n * unit);
    assert.equal(tooCostly.reason, 'costs-exceed-opportunity');
    proposals.push(tooCostly);
  }
  const valid = proposals.filter((proposal) => proposal.status === 'valid')
    .sort((a, b) => a.score === b.score ? a.signerName.localeCompare(b.signerName) : a.score > b.score ? -1 : 1);
  if (!valid.length) return { status: 'stopped', reason: 'no-profitable-valid-bid', selected, proposals };
  if (index === 0) {
    assert.equal(valid.length, 2, 'Expected competing executable bids');
    assert.ok(valid[0].score > valid[1].score);
    assert.equal(valid[0].signerName, 'solverA', 'Must ignore the inflated self-reported score');
  }
  const winner = valid[0];
  const before = await snapshot(ctx);
  const signer = winner.signerName === 'solverA' ? solver : bidderB;
  const receipt = await mined(signer.sendTransaction({ to: ctx.settlement.address, data: winner.calldata, ...txOptions }));
  const after = await snapshot(ctx);
  const measured = verifyTrade(ctx, selected, winner, before, after, receipt);
  assert.equal(measured.score, winner.score, 'Winner did not realize its simulated score');
  const routeCost = selected.sold * ctx.prices[selected.sell] - winner.gross * ctx.prices[selected.buy];
  const opportunity = selected.sold * ctx.prices[selected.sell] - selected.minimum * ctx.prices[selected.buy];
  assert.equal(opportunity, measured.score + (winner.gross - winner.receive) * ctx.prices[selected.buy] + routeCost);
  return { status: 'executed', selected, proposals, winner: winner.signerName,
    venueIndex: winner.venueIndex, receive: winner.receive, gross: winner.gross,
    calldata: winner.calldata, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(), ...measured, routeCostUsd: routeCost / unit,
    ...metrics(ctx, 'protected', selected, before, after), before, after };
}

async function ordinaryRound(ctx) {
  let selected;
  try { selected = await orderFor(ctx, ctx.ordinary.address); }
  catch (error) { if (!isNoOrder(error)) throw error; return { status: 'stopped', reason: 'no-order' }; }
  const p = ctx.ordinary;
  const reserves = [await p.getBalance(selected.order.buyToken), await p.getDenormalizedWeight(selected.order.buyToken),
    await p.getBalance(selected.order.sellToken), await p.getDenormalizedWeight(selected.order.sellToken)];
  const quote = async (fee) => BigInt((await p.calcInGivenOut(...reserves, selected.sold.toString(), fee.toString())).toString());
  const cost = await quote(ordinaryFee);
  const zeroFeeCost = await quote(0n);
  const quotes = await Promise.all([2, 3].map((venueIndex) => routeQuote(ctx, selected, venueIndex)));
  const fillable = quotes.filter((quote) => quote.status === 'quoted')
    .sort((a, b) => a.gross > b.gross ? -1 : a.gross < b.gross ? 1 : 0);
  if (!fillable.length) return { status: 'stopped', reason: 'insufficient-inventory', selected, quotes };
  const best = fillable[0];
  const minProfit = ceilDiv((gasBudgetUsd + minProfitUsd) * unit, ctx.prices[selected.buy]);
  if (best.gross < cost + minProfit) return { status: 'stopped', reason: 'costs-exceed-opportunity', selected, cost, quotes };
  const before = await snapshot(ctx);
  const receipt = await mined(ctx.executor.connect(trader).execute(ctx.ordinary.address, ctx.venues[best.venueIndex].address,
    selected.order.sellToken, selected.order.buyToken, selected.sold.toString(), cost.toString(), minProfit.toString(), txOptions));
  const after = await snapshot(ctx);
  conservation(ctx, before, after);
  const venueName = best.venueIndex === 2 ? 'controlVenueA' : 'controlVenueB';
  for (const [name, amounts] of Object.entries(before.accounts)) {
    for (let i = 0; i < ctx.tokens.length; ++i) {
      let delta = 0n;
      if (name === 'ordinary' && i === selected.sell) delta = -selected.sold;
      if (name === 'ordinary' && i === selected.buy) delta = cost;
      if (name === venueName && i === selected.sell) delta = selected.sold;
      if (name === venueName && i === selected.buy) delta = -best.gross;
      if (name === 'arbitrageur' && i === selected.buy) delta = best.gross - cost;
      assert.equal(BigInt(after.accounts[name][i]) - BigInt(amounts[i]), delta, `${name} unexpected ordinary movement`);
    }
  }
  const gasWei = gasAccounting(before, after, 'arbitrageur', receipt);
  const profitUsd = (best.gross - cost) * ctx.prices[selected.buy] / unit;
  assert.ok(profitUsd - gasWei * ethUsd / unit >= minProfitUsd);
  assert.ok(cost >= zeroFeeCost);
  return { status: 'executed', selected, cost, gross: best.gross, venueIndex: best.venueIndex,
    transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(), gasWei, gasUsd: gasWei * ethUsd / unit,
    arbitrageGrossUsd: profitUsd, arbitrageNetUsd: profitUsd - gasWei * ethUsd / unit,
    ordinaryFeeIncomeUsd: (cost - zeroFeeCost) * ctx.prices[selected.buy] / unit,
    ...metrics(ctx, 'ordinary', selected, before, after), before, after };
}

async function run() {
  const ctx = await setup();
  ctx.initial = await snapshot(ctx);
  const initialBlockNumber = Number(await provider.send('eth_blockNumber', []));
  const report = { initialBlockNumber, version: 1, chainId, assets: ctx.state.tokens, actors: ctx.actors,
    helper: ctx.helper.address, authentication: ctx.state.authentication,
    assumptions: { prices: ctx.prices, ordinaryFee, venueFeeBps: [10, 30], gasPriceWei: gasPrice,
      gasLimit, ethUsd, minProfitUsd, gasBudgetUsd, maxRounds: 32,
      priceValueScale: 'raw token units × price / 1e18 = USD with 18 decimals',
      scope: 'Deterministic local route-constrained bidders; synthetic finite external venues. Not production CoW scoring or a historical LVR backtest.' },
    initial: ctx.initial, protected: [], ordinary: [] };
  let protectedStopped = false;
  let ordinaryStopped = false;
  for (let i = 0; i < 32; ++i) {
    if (!protectedStopped) {
      const round = await protectedRound(ctx, i);
      report.protected.push(round);
      protectedStopped = round.status !== 'executed';
      console.log(`CoW round ${i + 1}: ${round.status}${round.winner ? `, winner ${round.winner}, LP surplus $${ethers.utils.formatEther(round.curveSurplusUsd)}` : `, ${round.reason}`}`);
    }
    if (!ordinaryStopped) {
      const round = await ordinaryRound(ctx);
      report.ordinary.push(round);
      ordinaryStopped = round.status !== 'executed';
      console.log(`Ordinary round ${i + 1}: ${round.status}${round.status === 'executed' ? `, arbitrageur net $${ethers.utils.formatEther(round.arbitrageNetUsd)}` : `, ${round.reason}`}`);
    }
    if (protectedStopped && ordinaryStopped) break;
  }
  report.final = await snapshot(ctx);
  report.finalBlockNumber = Number(await provider.send('eth_blockNumber', []));
  conservation(ctx, ctx.initial, report.final);
  assert.ok(protectedStopped && ordinaryStopped, 'Iteration limit reached');
  const cow = report.protected.filter((round) => round.status === 'executed');
  const ordinary = report.ordinary.filter((round) => round.status === 'executed');
  assert.ok(cow.length >= 3 && ordinary.length >= 1);
  assert.equal(cow[0].selected.sold, ordinary[0].selected.sold);
  assert.equal(cow[0].selected.sell, ordinary[0].selected.sell);
  assert.equal(cow[0].selected.buy, ordinary[0].selected.buy);
  assert.ok(cow[0].tradingPnlUsd > ordinary[0].tradingPnlUsd);
  const initialDrift = allocationDrift(ctx.state, ctx.initial.accounts.protected, ctx.prices);
  const finalDrift = allocationDrift(ctx.state, report.final.accounts.protected, ctx.prices);
  assert.ok(finalDrift < initialDrift);
  const protectedValue = value(report.final.accounts.protected, ctx.prices) / unit;
  const ordinaryValue = value(report.final.accounts.ordinary, ctx.prices) / unit;
  assert.ok(protectedValue > ordinaryValue);
  report.summary = { protectedTrades: cow.length, ordinaryTrades: ordinary.length, initialDrift, finalDrift,
    protectedValueUsd: protectedValue, ordinaryValueUsd: ordinaryValue,
    finalPathDifferenceUsd: protectedValue - ordinaryValue,
    firstMatchedImprovementUsd: cow[0].tradingPnlUsd - ordinary[0].tradingPnlUsd,
    realizedCurveSurplusUsd: cow.reduce((sum, round) => sum + round.curveSurplusUsd, 0n) };
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(reportPath, `${stringify(report)}\n`);
  const columns = ['portfolio', 'round', 'transactionHash', 'sell', 'buy', 'soldRaw', 'receivedRaw',
    'navBeforeUsd18', 'navAfterUsd18', 'curveSurplusUsd18', 'tradingPnlUsd18', 'driftAfter1e12', 'gasUsd18'];
  const rows = [columns.join(',')];
  for (const name of ['protected', 'ordinary']) report[name].forEach((round, i) => {
    if (round.status !== 'executed') return;
    rows.push([name, i + 1, round.transactionHash, ctx.state.tokens[round.selected.sell].symbol,
      ctx.state.tokens[round.selected.buy].symbol, round.selected.sold, name === 'protected' ? round.receive : round.cost,
      round.navBeforeUsd, round.navAfterUsd, round.curveSurplusUsd, round.tradingPnlUsd, round.driftAfter, round.gasUsd].join(','));
  });
  await writeFile(resolve(root, '.local/auction.csv'), `${rows.join('\n')}\n`);
  console.table([
    { portfolio: 'CoW AMM', trades: cow.length, finalValueUsd: ethers.utils.formatEther(protectedValue),
      allocationDriftPercent: (Number(finalDrift) / 1e10).toFixed(4) },
    { portfolio: 'Ordinary AMM', trades: ordinary.length, finalValueUsd: ethers.utils.formatEther(ordinaryValue),
      allocationDriftPercent: (Number(allocationDrift(ctx.state, report.final.accounts.ordinary, ctx.prices)) / 1e10).toFixed(4) },
  ]);
  console.log(`LP curve surplus: $${ethers.utils.formatEther(report.summary.realizedCurveSurplusUsd)}; first matched execution improvement: $${ethers.utils.formatEther(report.summary.firstMatchedImprovementUsd)}.`);
  console.log(`Full proposals, calldata, accounting, and assumptions: ${reportPath}`);
  await verify();
}

async function verify() {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.chainId, (await provider.getNetwork()).chainId);
  const ctx = { state: { tokens: report.assets, manager: report.actors.manager, pool: report.actors.protected },
    addresses: report.assets.map((token) => token.address),
    settlement: await contract('GPv2Settlement', report.actors.settlement),
    venues: await Promise.all([report.actors.venueA, report.actors.venueB].map((address) => contract('LocalAuctionVenue', address))),
    tokens: await Promise.all(report.assets.map((token) => contract('LocalStockToken', token.address))),
    actors: report.actors, prices: report.assumptions.prices.map(BigInt), initial: report.initial,
    pool: await contract('BCoWPool', report.actors.protected),
    ordinary: await contract('BCoWPool', report.actors.ordinary) };
  assert.ok((await ctx.pool.getSwapFee()).eq(await ctx.pool.MAX_FEE()));
  assert.equal((await ctx.ordinary.getSwapFee()).toString(), report.assumptions.ordinaryFee);
  assert.deepEqual(await snapshot(ctx, report.initialBlockNumber), report.initial, 'Initial state differs from the report');
  assert.deepEqual(await snapshot(ctx, report.finalBlockNumber), report.final, 'Final state differs from the report');
  for (const name of ['protected', 'ordinary']) {
    for (const round of report[name]) {
      if (round.status !== 'executed') continue;
      const receipt = await provider.getTransactionReceipt(round.transactionHash);
      assert.equal(receipt?.status, 1);
      const before = await snapshot(ctx, receipt.blockNumber - 1);
      const after = await snapshot(ctx, receipt.blockNumber);
      assert.deepEqual(before, round.before, 'Historical pre-state differs');
      assert.deepEqual(after, round.after, 'Historical post-state differs');
      conservation(ctx, before, after);
      const selected = { ...round.selected, sold: BigInt(round.selected.sold), minimum: BigInt(round.selected.minimum) };
      const measured = metrics(ctx, name, selected, before, after);
      for (const [key, amount] of Object.entries(measured)) assert.equal(amount.toString(), round[key], key);
      if (name === 'protected') {
        const valid = round.proposals.filter((proposal) => proposal.status === 'valid');
        for (const proposal of valid) {
          const bid = { ...proposal, gross: BigInt(proposal.gross), receive: BigInt(proposal.receive) };
          assert.ok(!bid.subsidy && bid.gross >= bid.receive && bid.receive >= selected.minimum);
          const historicalQuote = await ctx.venues[bid.venueIndex].quote(selected.order.sellToken,
            selected.order.buyToken, selected.sold.toString(), { blockTag: receipt.blockNumber - 1 });
          assert.equal(historicalQuote.toString(), proposal.gross);
          const calldata = settlementData(ctx, selected, bid);
          assert.equal(calldata, proposal.calldata);
          // eth_call executes the entire settlement against the historical
          // state without changing the running chain or consuming balances.
          await provider.call({ from: ctx.actors[bid.signerName], to: ctx.actors.settlement,
            data: calldata, ...txOptions }, receipt.blockNumber - 1);
          assert.equal(((bid.receive - selected.minimum) * ctx.prices[selected.buy]).toString(), proposal.score);
          assert.ok(BigInt(proposal.score) <= BigInt(round.score), 'A higher measured bid was not selected');
        }
        assert.equal(receipt.from.toLowerCase(), report.actors[round.winner].toLowerCase());
        const transaction = await provider.getTransaction(round.transactionHash);
        assert.equal(transaction.data, round.calldata);
        const bid = { venueIndex: round.venueIndex, signerName: round.winner,
          receive: BigInt(round.receive), gross: BigInt(round.gross) };
        const checked = verifyTrade(ctx, selected, bid, before, after, receipt);
        assert.equal(checked.score.toString(), round.score);
      } else {
        assert.equal(receipt.from.toLowerCase(), report.actors.arbitrageur.toLowerCase());
        gasAccounting(before, after, 'arbitrageur', receipt);
      }
    }
  }
  const cow = report.protected.filter((round) => round.status === 'executed');
  const ordinary = report.ordinary.filter((round) => round.status === 'executed');
  assert.equal(cow.length, report.summary.protectedTrades);
  assert.equal(ordinary.length, report.summary.ordinaryTrades);
  assert.equal(cow[0].selected.sold, ordinary[0].selected.sold);
  assert.equal(cow[0].selected.sell, ordinary[0].selected.sell);
  assert.equal(cow[0].selected.buy, ordinary[0].selected.buy);
  const protectedValue = value(report.final.accounts.protected, ctx.prices) / unit;
  const ordinaryValue = value(report.final.accounts.ordinary, ctx.prices) / unit;
  const summary = { protectedValueUsd: protectedValue, ordinaryValueUsd: ordinaryValue,
    finalPathDifferenceUsd: protectedValue - ordinaryValue,
    initialDrift: allocationDrift(ctx.state, report.initial.accounts.protected, ctx.prices),
    finalDrift: allocationDrift(ctx.state, report.final.accounts.protected, ctx.prices),
    firstMatchedImprovementUsd: BigInt(cow[0].tradingPnlUsd) - BigInt(ordinary[0].tradingPnlUsd),
    realizedCurveSurplusUsd: cow.reduce((sum, round) => sum + BigInt(round.curveSurplusUsd), 0n) };
  for (const [key, amount] of Object.entries(summary)) assert.equal(amount.toString(), report.summary[key], key);
  console.log('Independent verification passed: historical balances, conserved supplies, LP shares, surplus, P&L, drift, and winner execution.');
}

try {
  assert.equal((await provider.getNetwork()).chainId, chainId);
  if (process.argv[2] === 'run') await run();
  else if (process.argv[2] === 'verify') await verify();
  else throw new Error('Usage: node script/local/auction.mjs run|verify');
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
