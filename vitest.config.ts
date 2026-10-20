import { configDefaults, defineConfig } from 'vitest/config';

const ALL = ['test/**/*.test.ts', 'src/**/*.test.ts'];
// Files that assert wall-clock bounds (50k-row sweeps, the market index, the file database,
// the HTML parser on hostile input). They run as a second group once the other ~100 files are
// done, so a saturated CPU does not decide their results; alone each finishes far under its bound.
const TIMED = [
  'test/domain/engine.test.ts',
  'test/domain/marketPerf.test.ts',
  'test/db/perf.test.ts',
  'test/db/bankStockThinPerf.test.ts',
  'test/import/scraptfHtml.slowInput.test.ts',
  'test/import/audit-parser-depth.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20000,
    pool: 'forks',
    projects: [
      { extends: true, test: { name: 'unit', include: ALL, exclude: [...configDefaults.exclude, ...TIMED], sequence: { groupOrder: 0 } } },
      // One file at a time: run side by side, the timed files would decide each other's results.
      { extends: true, test: { name: 'timed', include: TIMED, sequence: { groupOrder: 1 }, fileParallelism: false } },
    ],
  },
});
