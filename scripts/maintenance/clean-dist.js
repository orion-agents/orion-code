const { rmSync } = require('fs');
const { relative, resolve } = require('path');

const projectRoot = resolve(__dirname, '../..');
const distDir = resolve(projectRoot, 'dist');

if (relative(projectRoot, distDir) !== 'dist') {
  throw new Error(`Refusing to clean unexpected output directory: ${distDir}`);
}

try {
  rmSync(distDir, { recursive: true, force: true });
} catch (err) {
  // Best-effort: in sandboxed environments a safe-delete guard may refuse to
  // remove the directory. tsc overwrites outputs file-by-file, so a blocked
  // clean does not break the build — warn and continue rather than hard-fail.
  console.warn(`[clean-dist] skipped dist removal: ${err.code || err.message}`);
}
