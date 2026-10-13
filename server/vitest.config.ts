import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /* Runs before each test file's imports, so it can set ATHENA_DATA_DIR. */
    setupFiles: ['tests/setup.ts'],
    /* The default five seconds measures a loaded machine as well as the code:
       with a build or a second suite running alongside, importing the search
       module tree and doing SQLite I/O overshoots it, and two tests failed only
       under that load while passing alone. The work is bounded — the clock was
       simply too tight. */
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
