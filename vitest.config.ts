import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /* The engine, the sample fixture, and the design-token contrast checks. Deliberately
       in the `node` environment with no DOM: if an engine test ever needs a browser
       global, that is a signal the engine has grown a dependency it should not have, and
       the test will fail rather than quietly pass. */
    include: ['src/engine/**/*.test.ts', 'src/fixtures/**/*.test.ts', 'src/ui/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
