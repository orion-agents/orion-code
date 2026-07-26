/**
 * Test Memory Storage module (file-based, storage.ts)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('=== Memory Storage Test ===');

// Import storage functions (file-based)
let storage;
try {
  storage = require('../dist/memory/storage.js');
  console.log('✓ Memory storage module imported');
} catch (err) {
  console.log('✗ Memory storage import failed:', err.message);
  process.exit(1);
}

const {
  getMemoryDir,
  ensureMemoryDir,
  getEntrypointPath,
  saveMemory,
  searchMemories,
  updateMemoryIndex,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
} = storage;

// 1. Create temp directory for memory
const tempProjectPath = path.join(os.tmpdir(), 'orion-code-memory-test-' + Date.now());
fs.mkdirSync(tempProjectPath, { recursive: true });
console.log('Temp project path:', tempProjectPath);

const memoryDir = ensureMemoryDir(tempProjectPath);
console.log('Memory dir:', memoryDir);
console.log('✓ Memory directory created');

// 2. Test saveMemory
const entry1 = {
  id: 'user-test-preference',
  type: 'user',
  name: 'test-user-preference',
  description: 'User prefers terse responses',
  content: 'User likes short, concise answers without preamble.',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
saveMemory(entry1, tempProjectPath);
console.log('✓ saveMemory entry1:', entry1.name);

const entry2 = {
  id: 'feedback-test-1',
  type: 'feedback',
  name: 'test-feedback-1',
  description: 'Always use real database in tests',
  content: 'Don\'t mock the database in tests - we got burned last quarter.',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
saveMemory(entry2, tempProjectPath);
console.log('✓ saveMemory entry2:', entry2.name);

// 3. Test searchMemories (signature: query string, projectPath)
const results = searchMemories('database tests', tempProjectPath);
console.log('✓ searchMemories results:', results.length);

// 4. Test updateMemoryIndex (MEMORY.md truncation)
const entrypointPath = getEntrypointPath(tempProjectPath);

// Create many entries to test truncation
for (let i = 0; i < 250; i++) {
  const entry = {
    id: `project-test-${i}`,
    type: 'project',
    name: `test-entry-${i}`,
    description: `Test entry ${i} for truncation test`,
    content: `This is test content for entry ${i}.`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveMemory(entry, tempProjectPath);
}
console.log('✓ Created 250 test entries');

// Call updateMemoryIndex
updateMemoryIndex(tempProjectPath);
console.log('updateMemoryIndex called');

// Check if MEMORY.md was truncated (should be ≤200 lines)
if (fs.existsSync(entrypointPath)) {
  const content = fs.readFileSync(entrypointPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim()).length;
  const bytes = Buffer.byteLength(content, 'utf-8');

  console.log('MEMORY.md stats:', lines, 'lines,', bytes, 'bytes');
  console.log('MAX lines:', MAX_ENTRYPOINT_LINES, 'MAX bytes:', MAX_ENTRYPOINT_BYTES);

  if (lines <= MAX_ENTRYPOINT_LINES && bytes <= MAX_ENTRYPOINT_BYTES) {
    console.log('✓ MEMORY.md truncation working');
  } else {
    console.log('✗ MEMORY.md truncation NOT working');
  }
} else {
  console.log('⚠ MEMORY.md not created');
}

// Cleanup
setTimeout(() => {
  try {
    fs.rmSync(tempProjectPath, { recursive: true, force: true });
  } catch {}
  console.log('\n=== Memory Storage Test Complete ===');
}, 200);