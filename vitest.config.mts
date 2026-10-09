import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves tsconfig's `paths` (`@/*`, `@payload-config`); built into Vite 8.
  resolve: { tsconfigPaths: true },
  test: {
    // Local API tests run Payload against Postgres and MinIO; there is no DOM code to test.
    environment: 'node',
    // Creates a throwaway database + bucket for the run, migrates it and drops both afterwards.
    globalSetup: ['./tests/int/setup.ts'],
    // Applies that run's environment in every worker before a test file imports the config.
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/int/**/*.int.spec.ts'],
  },
});
