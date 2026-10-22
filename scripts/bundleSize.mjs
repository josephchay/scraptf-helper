// 0.7.4 (F55): the build's own line per bundle ("dist/main.cjs     1.03 MB"). esbuild's summary marks any bundle
// of 1 MiB or more with a warning sign, which read as a failed build; build.mjs keeps esbuild at 'warning' and
// prints these instead. Binary units, as esbuild counts them.

const KIB = 1024;
const MIB = 1024 * 1024;

/** @param {number} bytes */
export function formatBundleSize(bytes) {
  const n = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  if (n >= MIB) return `${(n / MIB).toFixed(2)} MB`;
  if (n >= KIB) return `${(n / KIB).toFixed(1)} kB`;
  return `${n} B`;
}

/**
 * @param {string} file the outfile as build.mjs names it (forward slashes)
 * @param {number} bytes
 * @param {number} [width] pads the name so the sizes line up
 */
export function bundleSizeLine(file, bytes, width = 0) {
  return `  ${file.padEnd(width)}  ${formatBundleSize(bytes)}`;
}
