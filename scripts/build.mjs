// Builds the three Node-side bundles with esbuild and the dashboard with Vite.
//   dist/main.cjs     Electron main process
//   dist/preload.cjs  sandboxed preload (contextBridge only)
//   dist/service.cjs  utilityProcess: connectors, SQLite, opportunity engine
//   dist/renderer/    React dashboard (loaded through the app:// scheme)
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const skipRenderer = process.argv.includes('--no-renderer');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: 'linked',
  logLevel: 'info',
  absWorkingDir: root,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // ws optionally requires these native helpers inside try/catch; never bundle them.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
};

const targets = [
  { entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs' },
  { entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs' },
  { entryPoints: ['src/service/entry.ts'], outfile: 'dist/service.cjs' },
];

for (const t of targets) {
  await build({ ...common, ...t });
}

if (!skipRenderer && !watch) {
  const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [viteBin, 'build', '--config', 'vite.config.ts'], { cwd: root, stdio: 'inherit' });
}
