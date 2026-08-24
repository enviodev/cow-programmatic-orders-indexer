/**
 * Parity check: cowprotocol's deployed ponder indexer vs our envio indexer.
 *
 * THEIRS (ponder):  https://programmatic-orders.cow.fi/graphql
 * OURS   (envio):   https://indexer.us.hyperindex.xyz/c63fb37/v1/graphql
 *
 * Theirs is mid-backfill (mainnet ~18.85M, gnosis ~29.4M) while ours is at the
 * tip, so:
 *  - Generators join on `hash` (chain-scoped params hash — stable across both).
 *  - Discrete orders join on `orderUid`.
 *  - Identity fields (owner, salt, staticInput, orderType, decodedParams,
 *    amounts, validTo) must match exactly.
 *  - Lifecycle fields (status, executed amounts, historyBackfilled) are
 *    reported as "drift" — ours has processed 2.5+ years more chain and ran
 *    the tip drains, so differences there are expected, not bugs.
 */

const THEIRS = process.env.THEIRS_URL ?? "https://programmatic-orders.cow.fi/graphql";
const OURS = process.env.OURS_URL ?? "https://indexer.us.hyperindex.xyz/0b7a2d6/v1/graphql";
const SAMPLE = Number(process.env.SAMPLE ?? 50);

async function gql(url, query, variables) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`${url}: ${JSON.stringify(body.errors).slice(0, 500)}`);
  return body.data;
}

const norm = (s) => (s == null ? null : String(s).toLowerCase());
const normStatus = (s) => norm(s); // ours is capitalized, theirs lowercase
const normJson = (o) => (o == null ? null : JSON.stringify(Object.fromEntries(Object.entries(o).sort())));

function diffRows(label, pairs, fields, driftFields) {
  let exact = 0;
  const mismatches = [];
  const drifts = [];
  for (const [theirs, ours] of pairs) {
    const bad = fields.filter(([name, ft, fo]) => ft(theirs) !== fo(ours));
    const drift = driftFields.filter(([name, ft, fo]) => ft(theirs) !== fo(ours));
    if (bad.length === 0) exact++;
    else mismatches.push({ key: theirs.hash ?? theirs.orderUid, fields: bad.map(([n, ft, fo]) => `${n}: theirs=${ft(theirs)} ours=${fo(ours)}`) });
    if (drift.length > 0) drifts.push({ key: theirs.hash ?? theirs.orderUid, fields: drift.map(([n, ft, fo]) => `${n}: theirs=${ft(theirs)} ours=${fo(ours)}`) });
  }
  console.log(`\n── ${label}: ${pairs.length} joined, ${exact} identity-exact, ${mismatches.length} MISMATCHED, ${drifts.length} with lifecycle drift`);
  for (const m of mismatches.slice(0, 10)) console.log(`  ✗ ${m.key}\n      ${m.fields.join("\n      ")}`);
  for (const d of drifts.slice(0, 5)) console.log(`  ~ drift ${d.key}: ${d.fields.join("; ")}`);
  return mismatches.length;
}

let failures = 0;

for (const chainId of [1, 100]) {
  // ── Generators ────────────────────────────────────────────────────────────
  const t = await gql(THEIRS, `query($n: Int!, $c: Int!) {
    conditionalOrderGenerators(where: { chainId: $c }, orderBy: "hash", orderDirection: "asc", limit: $n) {
      items { hash owner resolvedOwner handler salt staticInput orderType status decodedParams decodeError txHash historyBackfilled }
    }
  }`, { n: SAMPLE, c: chainId });
  const theirGens = t.conditionalOrderGenerators.items;

  const o = await gql(OURS, `query($hashes: [String!]!, $c: Int!) {
    ConditionalOrderGenerator(where: { hash: { _in: $hashes }, chainId: { _eq: $c } }) {
      hash owner resolvedOwner handler salt staticInput orderType status decodedParams decodeError txHash historyBackfilled chainId
    }
  }`, { hashes: theirGens.map((g) => g.hash), c: chainId });
  // The same params hash can be created on-chain multiple times (one generator
  // row per creation event on both sides) — join on (hash, txHash).
  const genKey = (g) => g.hash + "|" + norm(g.txHash);
  const oursByKey = new Map(o.ConditionalOrderGenerator.map((g) => [genKey(g), g]));

  const missing = theirGens.filter((g) => !oursByKey.has(genKey(g)));
  console.log(`\n═══ chain ${chainId} generators: theirs sample ${theirGens.length}, found in ours ${theirGens.length - missing.length}, MISSING in ours ${missing.length}`);
  for (const m of missing.slice(0, 5)) console.log(`  missing hash=${m.hash} owner=${m.owner} type=${m.orderType} tx=${m.txHash}`);
  failures += missing.length;

  failures += diffRows(
    `chain ${chainId} generator identity`,
    theirGens.filter((g) => oursByKey.has(genKey(g))).map((g) => [g, oursByKey.get(genKey(g))]),
    [
      ["owner", (x) => norm(x.owner), (x) => norm(x.owner)],
      ["handler", (x) => norm(x.handler), (x) => norm(x.handler)],
      ["salt", (x) => norm(x.salt), (x) => norm(x.salt)],
      ["staticInput", (x) => norm(x.staticInput), (x) => norm(x.staticInput)],
      ["orderType", (x) => x.orderType, (x) => x.orderType],
      ["decodedParams", (x) => normJson(x.decodedParams), (x) => normJson(x.decodedParams)],
      ["decodeError", (x) => x.decodeError ?? null, (x) => x.decodeError ?? null],
      ["txHash", (x) => norm(x.txHash), (x) => norm(x.txHash)],
    ],
    [
      ["status", (x) => normStatus(x.status), (x) => normStatus(x.status)],
      ["resolvedOwner", (x) => norm(x.resolvedOwner), (x) => norm(x.resolvedOwner)],
      ["historyBackfilled", (x) => x.historyBackfilled, (x) => x.historyBackfilled],
    ],
  );

  // ── Discrete orders ───────────────────────────────────────────────────────
  const td = await gql(THEIRS, `query($n: Int!, $c: Int!) {
    discreteOrders(where: { chainId: $c }, orderBy: "orderUid", orderDirection: "asc", limit: $n) {
      items { orderUid status sellAmount buyAmount feeAmount validTo creationDate executedSellAmount executedBuyAmount executedFee }
    }
  }`, { n: SAMPLE, c: chainId });
  const theirOrders = td.discreteOrders.items;

  const od = await gql(OURS, `query($uids: [String!]!, $c: Int!) {
    DiscreteOrder(where: { orderUid: { _in: $uids }, chainId: { _eq: $c } }) {
      orderUid status sellAmount buyAmount feeAmount validTo creationDate executedSellAmount executedBuyAmount executedFee chainId
    }
  }`, { uids: theirOrders.map((d) => d.orderUid), c: chainId });
  const oursByUid = new Map(od.DiscreteOrder.map((d) => [d.orderUid, d]));

  const missingOrders = theirOrders.filter((d) => !oursByUid.has(d.orderUid));
  console.log(`\n═══ chain ${chainId} discreteOrders: theirs sample ${theirOrders.length}, found in ours ${theirOrders.length - missingOrders.length}, MISSING in ours ${missingOrders.length}`);
  for (const m of missingOrders.slice(0, 5)) console.log(`  missing uid=${m.orderUid} status=${m.status}`);
  failures += missingOrders.length;

  failures += diffRows(
    `chain ${chainId} discreteOrder identity`,
    theirOrders.filter((d) => oursByUid.has(d.orderUid)).map((d) => [d, oursByUid.get(d.orderUid)]),
    [
      ["sellAmount", (x) => String(x.sellAmount), (x) => String(x.sellAmount)],
      ["buyAmount", (x) => String(x.buyAmount), (x) => String(x.buyAmount)],
      ["feeAmount", (x) => String(x.feeAmount), (x) => String(x.feeAmount)],
      ["validTo", (x) => (x.validTo == null ? null : String(x.validTo)), (x) => (x.validTo == null ? null : String(x.validTo))],
    ],
    [
      ["status", (x) => normStatus(x.status), (x) => normStatus(x.status)],
      ["creationDate", (x) => String(x.creationDate), (x) => String(x.creationDate)],
      ["executedSellAmount", (x) => (x.executedSellAmount == null ? null : String(x.executedSellAmount)), (x) => (x.executedSellAmount == null ? null : String(x.executedSellAmount))],
      ["executedBuyAmount", (x) => (x.executedBuyAmount == null ? null : String(x.executedBuyAmount)), (x) => (x.executedBuyAmount == null ? null : String(x.executedBuyAmount))],
      ["executedFee", (x) => (x.executedFee == null ? null : String(x.executedFee)), (x) => (x.executedFee == null ? null : String(x.executedFee))],
    ],
  );
}

console.log(`\n${failures === 0 ? "✅ PARITY OK (identity fields)" : `❌ ${failures} identity mismatches/missing rows`}`);
