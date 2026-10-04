import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /* Runs before each test file's imports, so it can set ATHENA_DATA_DIR. */
    setupFiles: ['tests/setup.ts'],
  },
});
