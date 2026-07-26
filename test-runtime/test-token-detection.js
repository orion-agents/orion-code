/**
 * Test Token Detection (security-warning.ts)
 */
const { detectSecretsInMessage, hasHighRiskSecret, checkMessageSecurity } = require('../dist/core/security-warning.js');

console.log('=== Token Detection Test ===');

// Test cases
const testCases = [
  {
    input: 'Here is my GitHub token: ghp_1234567890abcdefghijklmnopqrstuvwx',
    expected: { count: 1, type: 'GitHub Personal Access Token' },
  },
  {
    input: 'My OpenAI key is sk-1234567890abcdefghijklmnopqrstuvwx1234567890ABCDEFG',
    expected: { count: 1, type: 'OpenAI API Key' },
  },
  {
    input: 'AWS key: AKIAIOSFODNN7EXAMPLE',
    expected: { count: 1, type: 'AWS Access Key ID' },
  },
  {
    input: 'No secrets here, just regular text',
    expected: { count: 0, type: null },
  },
  {
    input: 'Multiple tokens: ghp_abcd1234efgh5678ijkl9012mnop3456qrst7890uvwx and sk-proj-1234567890abcdefghijklmnopqrstuvwx1234567890ABCDEFGH',
    expected: { count: 2, type: 'multiple' },
  },
];

let passCount = 0;
let failCount = 0;

console.log('\nRunning detection tests:');
for (const tc of testCases) {
  const detected = detectSecretsInMessage(tc.input);
  const result = checkMessageSecurity(tc.input);

  console.log(`\nInput: "${tc.input.slice(0, 50)}..."`);
  console.log('  Detected:', detected.length, 'tokens');
  console.log('  Safe:', result.safe);

  if (tc.expected.count === detected.length) {
    console.log('  ✓ PASS - count matches');
    passCount++;
  } else {
    console.log('  ✗ FAIL - expected', tc.expected.count, 'got', detected.length);
    failCount++;
  }

  if (detected.length > 0) {
    for (const d of detected) {
      console.log('    -', d.name, '| severity:', d.severity);
    }
    console.log('  Warning generated:', result.warning?.slice(0, 100));
  }
}

// Test highRisk detection
const highRiskTest = hasHighRiskSecret('ghp_1234567890abcdefghijklmnopqrstuvwx');
console.log('\nhasHighRiskSecret test:');
console.log('  Result:', highRiskTest);
if (highRiskTest === true) {
  console.log('  ✓ PASS');
  passCount++;
} else {
  console.log('  ✗ FAIL');
  failCount++;
}

console.log('\nResults:');
console.log('  Pass:', passCount);
console.log('  Fail:', failCount);

console.log('\n=== Token Detection Test Complete ===');