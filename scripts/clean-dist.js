const { rmSync } = require('fs');
const { relative, resolve } = require('path');

const projectRoot = resolve(__dirname, '..');
const distDir = resolve(projectRoot, 'dist');

if (relative(projectRoot, distDir) !== 'dist') {
  throw new Error(`Refusing to clean unexpected output directory: ${distDir}`);
}

rmSync(distDir, { recursive: true, force: true });
