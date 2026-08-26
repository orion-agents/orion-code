'use strict';

const { cpSync, existsSync, mkdirSync, readdirSync, statSync } = require('fs');
const { join, resolve } = require('path');

const projectRoot = resolve(__dirname, '../..');
const sourceRoot = join(projectRoot, 'src', 'skills', 'builtin');
const destinationRoot = join(projectRoot, 'dist', 'skills', 'builtin');

function copyRuntimeAssets() {
  if (!existsSync(sourceRoot)) {
    throw new Error(`Missing built-in Skill asset directory: ${sourceRoot}`);
  }
  const skillFiles = listFiles(sourceRoot).filter(path => path.endsWith('/SKILL.md'));
  if (skillFiles.length === 0) {
    throw new Error(`No built-in SKILL.md assets found under ${sourceRoot}`);
  }
  mkdirSync(destinationRoot, { recursive: true });
  cpSync(sourceRoot, destinationRoot, { recursive: true, force: true });
  for (const relativePath of skillFiles) {
    if (!existsSync(join(destinationRoot, relativePath))) {
      throw new Error(`Failed to copy built-in Skill asset: ${relativePath}`);
    }
  }
  return skillFiles;
}

function listFiles(root, prefix = '') {
  const result = [];
  for (const name of readdirSync(root).sort()) {
    const absolute = join(root, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(absolute).isDirectory()) result.push(...listFiles(absolute, relative));
    else result.push(relative);
  }
  return result;
}

if (require.main === module) {
  const copied = copyRuntimeAssets();
  process.stdout.write(`Copied ${copied.length} built-in Skill assets.\n`);
}

module.exports = { copyRuntimeAssets };
