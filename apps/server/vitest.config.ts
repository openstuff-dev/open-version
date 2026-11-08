import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The database tests each reset the same schema, so they run one file at a time.
    fileParallelism: false,
  },
});
