import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The GraphQL client throws at import-use time without a key; tests never
    // reach the network (fetch is stubbed), so any value works.
    env: { LINEAR_API_KEY: "lin_api_test_dummy" },
  },
});
