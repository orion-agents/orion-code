/**
 * Test exec_command tool
 */
const { TOOLS } = require('../dist/tools/index.js');

console.log('=== exec_command Tool Test ===');

// Find exec_command tool
const execTool = TOOLS.find(t => t.name === 'exec_command');
if (!execTool) {
  console.log('✗ exec_command tool not found');
  process.exit(1);
}
console.log('✓ exec_command tool found');

// Test 1: Basic execution - echo hello
const result1 = execTool.execute({ command: 'echo hello' });
result1.then(r => {
  console.log('Test 1: echo hello');
  console.log('  success:', r.success);
  console.log('  output:', r.output?.trim());
  console.log('  error:', r.error || 'none');
  if (r.success && r.output?.trim() === 'hello') {
    console.log('  ✓ PASS');
  } else {
    console.log('  ✗ FAIL');
  }
});

// Test 2: Long output truncation
const longCmd = 'echo "' + 'x'.repeat(60000) + '"';
const result2 = execTool.execute({ command: longCmd, maxOutput: 1000 });
result2.then(r => {
  console.log('\nTest 2: long output truncation');
  console.log('  success:', r.success);
  console.log('  output length:', r.output?.length);
  console.log('  maxOutput: 1000');
  if (r.output?.length <= 1000) {
    console.log('  ✓ PASS - output truncated');
  } else {
    console.log('  ✗ FAIL - output not truncated');
  }
});

// Test 3: git status
const result3 = execTool.execute({ command: 'git status --short' });
result3.then(r => {
  console.log('\nTest 3: git status');
  console.log('  success:', r.success);
  console.log('  output:', r.output?.slice(0, 100));
  if (r.success) {
    console.log('  ✓ PASS');
  } else {
    console.log('  ✗ FAIL');
  }
});

// Wait for all tests
setTimeout(() => {
  console.log('\n=== exec_command Tool Test Complete ===');
}, 1000);