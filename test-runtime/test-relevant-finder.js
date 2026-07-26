/**
 * Test relevant-finder (memory/relevant-finder.ts)
 */
const { findRelevantMemories, extractKeywords, calculateKeywordMatch } = require('../dist/memory/relevant-finder.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('=== relevant-finder Test ===');

// Test 1: extractKeywords
console.log('\nTest 1: extractKeywords');
const keywords = extractKeywords('Hello world, this is a test about database and testing patterns');
console.log('  Keywords:', keywords);
if (keywords.includes('database') && keywords.includes('testing') && keywords.includes('patterns')) {
  console.log('  ✓ PASS');
} else {
  console.log('  ✗ FAIL');
}

// Test 2: findRelevantMemories with mock data
// First create test memory entries
const tempProjectPath = path.join(os.tmpdir(), 'orion-code-relevant-test-' + Date.now());
fs.mkdirSync(tempProjectPath, { recursive: true });

const { saveMemory, ensureMemoryDir } = require('../dist/memory/storage.js');
ensureMemoryDir(tempProjectPath);

// Create test memories
saveMemory({
  id: 'test-1',
  type: 'feedback',
  name: 'database-feedback',
  description: 'Database testing feedback',
  content: 'Always use real database in tests, not mocks',
  createdAt: Date.now(),
  updatedAt: Date.now(),
}, tempProjectPath);

saveMemory({
  id: 'test-2',
  type: 'user',
  name: 'user-preference',
  description: 'User likes short responses',
  content: 'User prefers terse, concise answers without preamble',
  createdAt: Date.now(),
  updatedAt: Date.now(),
}, tempProjectPath);

saveMemory({
  id: 'test-3',
  type: 'project',
  name: 'project-info',
  description: 'Project uses TypeScript',
  content: 'This is a TypeScript project with React frontend',
  createdAt: Date.now(),
  updatedAt: Date.now(),
}, tempProjectPath);

console.log('\nTest 2: findRelevantMemories');
const results = findRelevantMemories('database testing', tempProjectPath, { maxResults: 5 });
console.log('  Query: "database testing"');
console.log('  Results:', results.length);

if (results.length > 0) {
  console.log('  Top result:', results[0]?.memory?.name, 'score:', results[0]?.score);
  if (results[0]?.memory?.name === 'database-feedback') {
    console.log('  ✓ PASS - correct result ranked first');
  } else {
    console.log('  ⚠ WARNING - expected database-feedback first');
  }
} else {
  console.log('  ✗ FAIL - no results returned');
}

// Test 3: sorting
console.log('\nTest 3: result sorting');
const sortedResults = findRelevantMemories('typescript react', tempProjectPath, { maxResults: 5 });
console.log('  Query: "typescript react"');
console.log('  Results:', sortedResults.length);
if (sortedResults.length > 0) {
  // Check if results are sorted by score descending
  const scores = sortedResults.map(r => r.score);
  const isSorted = scores.every((s, i) => i === 0 || s <= scores[i - 1]);
  console.log('  Scores:', scores);
  if (isSorted) {
    console.log('  ✓ PASS - results sorted by score descending');
  } else {
    console.log('  ✗ FAIL - results not sorted');
  }
}

// Cleanup
fs.rmSync(tempProjectPath, { recursive: true, force: true });

console.log('\n=== relevant-finder Test Complete ===');