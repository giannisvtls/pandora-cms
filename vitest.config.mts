import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    // Local API tests run Payload against Postgres and MinIO; there is no DOM code to test.
    environment: 'node',
    // Creates a throwaway database + bucket for the run, migrates it and drops both afterwards.
    globalSetup: ['./tests/int/setup.ts'],
    // Applies that run's environment in every worker before a test file imports the config.
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/int/**/*.int.spec.ts'],
  },
})
