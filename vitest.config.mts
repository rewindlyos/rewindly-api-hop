import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Fake keys. Nothing in the suite reaches Google -- the broker tests
          // exercise selection, and the route tests stop at 401/400/404.
          GEMINI_API_KEYS:
            '[{"id":"key-1","key":"t1"},{"id":"key-2","key":"t2"},{"id":"key-3","key":"t3"},{"id":"key-4","key":"t4"}]',
          INCEPTION_API_KEYS: '[{"id":"a","key":"m1"},{"id":"b","key":"m2"}]',
          HOP_GATEWAY_API_KEY: "test-gateway-key",
        },
      },
    }),
  ],
});
