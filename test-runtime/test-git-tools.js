/**
 * Test Git tools
 */
const { GIT_TOOLS } = require('../dist/tools/git.js');

console.log('=== Git Tools Test ===');

// Find git_status tool
const gitStatusTool = GIT_TOOLS?.find(t => t.name === 'git_status');
if (!gitStatusTool) {
  console.log('✗ git_status tool not found');
  process.exit(1);
}
console.log('✓ git_status tool found');

// Test 1: git status execution
const result1 = gitStatusTool.execute({});
result1.then(r => {
  console.log('\nTest: git_status execution');
  console.log('  success:', r.success);
  console.log('  output:', r.output?.slice(0, 200));
  if (r.success) {
    console.log('  ✓ PASS');
  } else {
    console.log('  ✗ FAIL -', r.error);
  }
});

// Test 2: check git_status tool properties
console.log('\nTest: git_status tool properties');
console.log('  isReadOnly:', gitStatusTool.isReadOnly?.());
console.log('  has checkPermissions:', !!gitStatusTool.checkPermissions);
if (gitStatusTool.isReadOnly?.() === true) {
  console.log('  ✓ PASS - isReadOnly');
} else {
  console.log('  ✗ FAIL - not marked as read-only');
}

// Test 3: git_push tool exists
const gitPushTool = GIT_TOOLS?.find(t => t.name === 'git_push');
if (gitPushTool) {
  console.log('\n✓ git_push tool found');
  console.log('  isDestructive:', gitPushTool.isDestructive?.({}));
} else {
  console.log('\n⚠ git_push tool not found (may be in different export)');
}

// Wait for async
setTimeout(() => {
  console.log('\n=== Git Tools Test Complete ===');
}, 1000);