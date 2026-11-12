/**
 * Parity check: cowprotocol's deployed ponder indexer vs our envio indexer.
 *
 *   THEIRS_URL  ponder GraphQL   (default https://programmatic-orders.cow.fi/graphql)
 *   OURS_URL    envio Hasura     (default http://localhost:8080/v1/graphql)
 *   OURS_ADMIN_SECRET            optional x-hasura-admin-secret for OURS
 *   CHAINS      comma-separated chain ids (default: all 11)
 *   MAX_ROWS    per-chain cap on rows fetched from each side (default 50000)
 *
 * Usage: node scripts/parity-check.mjs
 *
 * Either side may be mid-sync, so each chain is compared only up to OUR
 * progress block (chain_metadata.latest_processed_block); their rows past it
 * are ignored. Within that range the generator sets are compared in full, so
 * every "missing" row is a real gap, not a sampling artefact.
 *
 *  - Generators join on (hash, txHash): the same params hash can be created
 *    more than once, with one row per creation on both sides.
 *    Identity fields must match; lifecycle fields (status, resolvedOwner) are
 *    reported as drift, since they move while either side polls.
 *  - Precomputed UIDs: for deterministic generators (TWAP, StopLoss,
 *    CirclesBackingOrder) that both sides have precomputed, the set of
 *    discrete + candidate order UIDs must match exactly. Ours defers
 *    historical precompute to the tip (precomputePending), so a chain still
 *    backfilling has few comparable generators.
 *  - Discrete orders present on both sides: amounts and validTo must match.
 *
 * Exits non-zero on any identity mismatch or missing row.
 */

const THEIRS = process.env.THEIRS_URL ?? "https://programmatic-orders.cow.fi/graphql";
const OURS = process.env.OURS_URL ?? "http://localhost:8080/v1/graphql";
const OURS_HEADERS = process.env.OURS_ADMIN_SECRET
  ? { "x-hasura-admin-secret": process.env.OURS_ADMIN_SECRET }
  : {};
const CHAINS = (process.env.CHAINS ?? "1,56,100,137,8453,9745,42161,43114,57073,59144,11155111")
  .split(",").map(Number);
const MAX_ROWS = Number(process.env.MAX_ROWS ?? 50_000);
const DETERMINISTIC = new Set(["TWAP", "StopLoss", "CirclesBackingOrder"]);

async function gql(url, query, variables, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query, variables }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    const body = await res.json();
    if (body.errors) throw new Error(`${url}: ${JSON.stringify(body.errors).slice(0, 500)}`);
    return body.data;
  }
}
const ours = (query, variables) => gql(OURS, query, variables, OURS_HEADERS);

/** Page through a ponder list field (cursor pagination, 1000 per page). */
async function theirsAll(field, where, selection) {
  const rows = [];
  let after = null;
  do {
    const d = await gql(THEIRS, `query($w: ${field}Filter, $after: String) {
      ${field}s(where: $w, limit: 1000, after: $after) {
        pageInfo { hasNextPage endCursor }
        items { ${selection} }
      }
    }`, { w: where, after });
    const page = d[`${field}s`];
    rows.push(...page.items);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after && rows.length < MAX_ROWS);
  return rows;
}

/** Page through a Hasura table (offset pagination, 1000 per page). */
async function oursAll(table, where, selection) {
  const rows = [];
  for (let offset = 0; rows.length < MAX_ROWS; offset += 1000) {
    const d = await ours(`query($w: ${table}_bool_exp, $o: Int!) {
      ${table}(where: $w, limit: 1000, offset: $o, order_by: { id: asc }) { ${selection} }
    }`, { w: where, o: offset });
    rows.push(...d[table]);
    if (d[table].length < 1000) break;
  }
  return rows;
}

const norm = (s) => (s == null ? null : String(s).toLowerCase());
const str = (s) => (s == null ? null : String(s));
const sortedJson = (o) => (o == null ? null : JSON.stringify(Object.fromEntries(Object.entries(o).sort())));
const genKey = (g) => `${g.hash}|${norm(g.txHash)}`;
const show = (rows, n, fmt) => rows.slice(0, n).forEach((r) => console.log(`    ${fmt(r)}`));

const GEN_IDENTITY = [
  ["owner", (x) => norm(x.owner)],
  ["handler", (x) => norm(x.handler)],
  ["salt", (x) => norm(x.salt)],
  ["staticInput", (x) => norm(x.staticInput)],
  ["orderType", (x) => x.orderType],
  ["decodedParams", (x) => sortedJson(x.decodedParams)],
  ["decodeError", (x) => x.decodeError ?? null],
];
const GEN_DRIFT = [
  ["status", (x) => norm(x.status)], // ours is capitalized, theirs lowercase
  ["resolvedOwner", (x) => norm(x.resolvedOwner)],
];
const ORDER_IDENTITY = [
  ["sellAmount", (x) => str(x.sellAmount)],
  ["buyAmount", (x) => str(x.buyAmount)],
  ["feeAmount", (x) => str(x.feeAmount)],
  ["validTo", (x) => str(x.validTo)],
];

function compareFields(pairs, fields) {
  const out = [];
  for (const [t, o, key] of pairs) {
    const diffs = fields.filter(([, f]) => f(t) !== f(o)).map(([n, f]) => `${n}: theirs=${f(t)} ours=${f(o)}`);
    if (diffs.length) out.push({ key, diffs });
  }
  return out;
}

const meta = await ours(`{ chain_metadata { chain_id latest_processed_block } }`);
const progress = new Map(meta.chain_metadata.map((c) => [c.chain_id, c.latest_processed_block]));

let failures = 0;
const summary = [];

for (const chainId of CHAINS) {
  const head = progress.get(chainId) ?? -1;
  if (head < 0) {
    console.log(`\n═══ chain ${chainId}: skipped (ours has not committed any block yet)`);
    summary.push({ chainId, skipped: true });
    continue;
  }

  // ── Generators ──────────────────────────────────────────────────────────
  const GEN_FIELDS = "hash owner resolvedOwner handler salt staticInput orderType status decodedParams decodeError txHash";
  const theirGensAll = await theirsAll("conditionalOrderGenerator", { chainId },
    `eventId ${GEN_FIELDS} transaction { blockNumber }`);
  const theirGens = theirGensAll.filter((g) => Number(g.transaction?.blockNumber) <= head);
  const ourGens = await oursAll("ConditionalOrderGenerator", { chainId: { _eq: chainId } },
    `id ${GEN_FIELDS} allCandidatesKnown precomputePending`);

  const theirByKey = new Map(theirGens.map((g) => [genKey(g), g]));
  const ourByKey = new Map(ourGens.map((g) => [genKey(g), g]));
  const missingOurs = theirGens.filter((g) => !ourByKey.has(genKey(g)));
  const extraOurs = ourGens.filter((g) => !theirByKey.has(genKey(g)));
  const joined = theirGens.filter((g) => ourByKey.has(genKey(g))).map((g) => [g, ourByKey.get(genKey(g)), genKey(g)]);
  const genMismatch = compareFields(joined, GEN_IDENTITY);
  const genDrift = compareFields(joined, GEN_DRIFT);

  console.log(`\n═══ chain ${chainId} (ours at block ${head}) generators: theirs ${theirGens.length} (of ${theirGensAll.length}), ours ${ourGens.length}, joined ${joined.length}`);
  console.log(`  missing in ours ${missingOurs.length}, only in ours ${extraOurs.length}, identity mismatches ${genMismatch.length}, lifecycle drift ${genDrift.length}`);
  show(missingOurs, 5, (g) => `missing ${g.orderType} hash=${g.hash} tx=${g.txHash} block=${g.transaction?.blockNumber}`);
  show(extraOurs, 5, (g) => `only-ours ${g.orderType} id=${g.id} hash=${g.hash} tx=${g.txHash}`);
  show(genMismatch, 5, (m) => `✗ ${m.key}\n        ${m.diffs.join("\n        ")}`);
  failures += missingOurs.length + extraOurs.length + genMismatch.length;

  // ── Precomputed UID sets (deterministic generators) ─────────────────────
  const precomputed = joined.filter(([t, o]) => DETERMINISTIC.has(o.orderType) && o.allCandidatesKnown && !o.precomputePending);
  let uidMismatch = [];
  let orderMismatch = [];
  let ordersCompared = 0;
  if (precomputed.length > 0) {
    // Fetch only the compared generators' orders, 100 generators at a time:
    // whole-chain order tables run to hundreds of thousands of rows.
    const ORDER_FIELDS = "orderUid sellAmount buyAmount feeAmount validTo";
    const tDisc = [], tCand = [], oDisc = [], oCand = [];
    for (let i = 0; i < precomputed.length; i += 100) {
      const chunk = precomputed.slice(i, i + 100);
      const tIds = chunk.map(([t]) => t.eventId);
      const oIds = chunk.map(([, o]) => o.id);
      const [td, tc, od, oc] = await Promise.all([
        theirsAll("discreteOrder", { chainId, conditionalOrderGeneratorId_in: tIds }, `${ORDER_FIELDS} conditionalOrderGeneratorId status`),
        theirsAll("candidateDiscreteOrder", { chainId, conditionalOrderGeneratorId_in: tIds }, `${ORDER_FIELDS} conditionalOrderGeneratorId`),
        oursAll("DiscreteOrder", { chainId: { _eq: chainId }, conditionalOrderGenerator_id: { _in: oIds } }, `id ${ORDER_FIELDS} conditionalOrderGenerator_id status`),
        oursAll("CandidateDiscreteOrder", { chainId: { _eq: chainId }, conditionalOrderGenerator_id: { _in: oIds } }, `id ${ORDER_FIELDS} conditionalOrderGenerator_id`),
      ]);
      tDisc.push(...td); tCand.push(...tc); oDisc.push(...od); oCand.push(...oc);
    }
    const group = (rows, idField) => {
      const m = new Map();
      for (const r of rows) {
        const k = r[idField];
        if (!m.has(k)) m.set(k, new Set());
        m.get(k).add(norm(r.orderUid));
      }
      return m;
    };
    const tUids = group([...tDisc, ...tCand], "conditionalOrderGeneratorId");
    const oUids = group([...oDisc, ...oCand], "conditionalOrderGenerator_id");
    for (const [t, o, key] of precomputed) {
      const a = [...(tUids.get(t.eventId) ?? [])].sort();
      const b = [...(oUids.get(o.id) ?? [])].sort();
      if (a.join() !== b.join()) {
        uidMismatch.push({ key, type: o.orderType, theirs: a.length, ours: b.length, onlyTheirs: a.filter((u) => !b.includes(u)).slice(0, 2), onlyOurs: b.filter((u) => !a.includes(u)).slice(0, 2) });
      }
    }
    const tByUid = new Map(tDisc.map((d) => [norm(d.orderUid), d]));
    const pairs = oDisc.filter((d) => tByUid.has(norm(d.orderUid))).map((d) => [tByUid.get(norm(d.orderUid)), d, d.orderUid]);
    ordersCompared = pairs.length;
    orderMismatch = compareFields(pairs, ORDER_IDENTITY);
  }
  console.log(`  precomputed UID sets compared ${precomputed.length}, mismatched ${uidMismatch.length}; discrete orders compared ${ordersCompared}, mismatched ${orderMismatch.length}`);
  show(uidMismatch, 5, (m) => `✗ ${m.type} ${m.key}: theirs ${m.theirs} uids, ours ${m.ours}; only-theirs ${m.onlyTheirs.join(",")} only-ours ${m.onlyOurs.join(",")}`);
  show(orderMismatch, 5, (m) => `✗ ${m.key}\n        ${m.diffs.join("\n        ")}`);
  failures += uidMismatch.length + orderMismatch.length;

  summary.push({ chainId, head, gens: joined.length, missing: missingOurs.length, extra: extraOurs.length, genMismatch: genMismatch.length, uidSets: precomputed.length, uidMismatch: uidMismatch.length, orders: ordersCompared, orderMismatch: orderMismatch.length });
}

console.log("\n── summary");
console.table(summary);
console.log(failures === 0 ? "✅ PARITY OK (identity fields)" : `❌ ${failures} identity mismatches / missing rows`);
process.exit(failures === 0 ? 0 : 1);
