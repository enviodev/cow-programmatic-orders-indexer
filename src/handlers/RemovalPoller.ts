import { indexer } from "envio";
import { checkOrdersActive } from "../effects/rpc.js";

// ─── Order Removal/Cancellation Detection ───────────────────────────────────
// ComposableCoW.remove() deletes orders from on-chain storage but emits NO event.
// The only way to detect removals is to poll singleOrders(owner, hash) on-chain.
//
// Only polls when the chain is realtime (caught up to tip). During historical
// sync this would wastefully check current state thousands of times.

// Skip registration in test environment — onBlock handlers interfere with
// integration tests that process pinned block ranges.
const isTest = typeof process !== "undefined" && !!process.env.VITEST;

const POLL_INTERVAL = 100; // ~20 min at 12s/block

if (!isTest) {
  indexer.onBlock(
    {
      name: "RemovalPoller",
      where: () => ({ block: { number: { _every: POLL_INTERVAL } } }),
    },
    async ({ block, context }) => {
      const chainId = context.chain.id;

      // Skip during historical sync — only poll when caught up to chain tip
      if (!context.chain.isRealtime) return;

      try {
        const activeOrders = await context.ConditionalOrder.getWhere({
          status: { _eq: "Active" },
        });

        if (activeOrders.length === 0) return;

        if (!context.isPreload) {
          context.log.info(
            `RemovalPoller: checking ${activeOrders.length} active orders at block ${block.number} (chain=${chainId})`,
          );
        }

        const ordersPayload = activeOrders.map((o) => ({
          owner: o.owner,
          hash: o.hash,
        }));

        const resultsJson = await context.effect(checkOrdersActive, {
          ordersJson: JSON.stringify(ordersPayload),
          chainId,
        });

        const results = JSON.parse(resultsJson) as Array<{
          hash: string;
          owner: string;
          active: boolean;
          error?: string;
        }>;

        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          const order = activeOrders[i]!;

          if (result.error) {
            if (!context.isPreload) {
              context.log.warn(
                `RemovalPoller: check failed for hash=${result.hash} owner=${result.owner}: ${result.error}`,
              );
            }
            continue;
          }

          if (!result.active) {
            context.ConditionalOrder.set({
              ...order,
              status: "Cancelled",
            });

            if (!context.isPreload) {
              context.log.info(
                `RemovalPoller: order cancelled hash=${result.hash} owner=${result.owner} block=${block.number} chain=${chainId}`,
              );
            }
          }
        }
      } catch (err) {
        if (!context.isPreload) {
          context.log.warn(
            `RemovalPoller: error at block ${block.number} chain=${chainId}: ${err}`,
          );
        }
      }
    },
  );
}
