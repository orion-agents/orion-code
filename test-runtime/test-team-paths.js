/**
 * Test team-paths (memory/team-paths.ts)
 */
const { sanitizePathKey, PathTraversalError } = require('../dist/memory/team-paths.js');

console.log('=== team-paths Security Test ===');

// Test malicious paths
const maliciousPaths = [
  '../../etc/passwd',
  '../../../root/.ssh/id_rsa',
  '..\\..\\..\\windows\\system32',
  'null\x00byte',
  '/etc/passwd',
  'C:\\Windows\\System32',
  '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  '..//..//etc/passwd',
  '\x01\x02\x03control',
];

console.log('\nTesting malicious paths:');
let passCount = 0;
let failCount = 0;

for (const path of maliciousPaths) {
  const result = sanitizePathKey(path);
  const displayPath = path.replace(/\x00/g, '\\0').replace(/\x01-\x03/g, '\\x');

  console.log(`\nPath: "${displayPath}"`);
  console.log('  Safe:', result.safe);
  console.log('  Violations:', result.violations);

  if (!result.safe && result.violations.length > 0) {
    console.log('  ✓ PASS - correctly blocked');
    passCount++;
  } else {
    console.log('  ✗ FAIL - not blocked!');
    failCount++;
  }
}

// Test safe paths
const safePaths = [
  'normal/path/to/file',
  'simple_key',
  'team/memory/entry',
  'valid-name-123',
];

console.log('\n\nTesting safe paths:');
for (const path of safePaths) {
  const result = sanitizePathKey(path);
  console.log(`\nPath: "${path}"`);
  console.log('  Safe:', result.safe);
  console.log('  Sanitized:', result.sanitizedKey);

  if (result.safe && result.violations.length === 0) {
    console.log('  ✓ PASS - correctly allowed');
    passCount++;
  } else {
    console.log('  ✗ FAIL - incorrectly blocked');
    failCount++;
  }
}

console.log('\n\nResults:');
console.log('  Pass:', passCount);
console.log('  Fail:', failCount);

console.log('\n=== team-paths Security Test Complete ===');