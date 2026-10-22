// 0.7.4 (F55): the build prints one size line per bundle itself and keeps esbuild at 'warning', so `npm start` no
// longer shows esbuild's 1 MiB size marker as if the build had failed. Logging only: the bundling options stay.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundleSizeLine, formatBundleSize } from '../../scripts/bundleSize.mjs';

const BUILD = readFileSync(new URL('../../scripts/build.mjs', import.meta.url), 'utf8');

describe('bundle size line', () => {
  it('uses binary units like esbuild', () => {
    expect(formatBundleSize(1_081_077)).toBe('1.03 MB');
    expect(formatBundleSize(2_267_628)).toBe('2.16 MB');
    expect(formatBundleSize(1024 * 1024)).toBe('1.00 MB');
    expect(formatBundleSize(1024 * 1024 - 1)).toBe('1024.0 kB');
    expect(formatBundleSize(6_140)).toBe('6.0 kB');
    expect(formatBundleSize(1024)).toBe('1.0 kB');
    expect(formatBundleSize(1023)).toBe('1023 B');
    expect(formatBundleSize(0)).toBe('0 B');
    expect(formatBundleSize(Number.NaN)).toBe('0 B');
    expect(formatBundleSize(-5)).toBe('0 B');
  });

  it('is one plain line with the name padded so the sizes line up, and no marker', () => {
    const width = 'dist/service.cjs'.length;
    expect(bundleSizeLine('dist/main.cjs', 1_081_077, width)).toBe('  dist/main.cjs     1.03 MB');
    expect(bundleSizeLine('dist/service.cjs', 2_267_628, width)).toBe('  dist/service.cjs  2.16 MB');
    expect(bundleSizeLine('dist/preload.cjs', 6_140)).toBe('  dist/preload.cjs  6.0 kB');
    expect(bundleSizeLine('dist/main.cjs', 50 * 1024 * 1024, width)).not.toMatch(/[^\x20-\x7e]/);
  });
});

describe('build.mjs', () => {
  it("keeps esbuild's warnings and errors and prints a size line after each bundle", () => {
    expect(BUILD).toContain("logLevel: 'warning',");
    expect(BUILD).not.toMatch(/logLevel: '(info|silent|error|verbose|debug)'/);
    expect(BUILD).toContain("import { bundleSizeLine } from './bundleSize.mjs';");
    expect(BUILD).toMatch(/await build\(\{ \.\.\.common, \.\.\.t \}\);\s*console\.log\(bundleSizeLine\(t\.outfile, statSync\(path\.join\(root, t\.outfile\)\)\.size, width\)\);/);
  });

  it('bundles exactly as before (logging is the only change)', () => {
    expect(BUILD).not.toMatch(/\bminify/);
    expect(BUILD).not.toMatch(/\bmetafile/);
    expect(BUILD).toContain("sourcemap: 'linked',");
    expect(BUILD).toContain("external: ['electron', 'bufferutil', 'utf-8-validate'],");
    expect(BUILD).toContain("{ entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs' },");
    expect(BUILD).toContain("{ entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs' },");
    expect(BUILD).toContain("{ entryPoints: ['src/service/entry.ts'], outfile: 'dist/service.cjs' },");
  });
});
