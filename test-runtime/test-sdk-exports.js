/**
 * Test SDK exports (sdk/index.ts)
 */
console.log('=== SDK Exports Test ===');

// Import SDK
try {
  const sdk = require('../dist/sdk/index.js');
  console.log('✓ SDK module imported');

  // Check exports
  const exports = Object.keys(sdk);
  console.log('Exports:', exports);

  // Test required exports
  const requiredExports = ['init', 'query', 'listSessions'];
  let passCount = 0;
  let failCount = 0;

  for (const exp of requiredExports) {
    if (sdk[exp]) {
      console.log(`  ✓ ${exp} exported (type: ${typeof sdk[exp]})`);
      passCount++;
    } else {
      console.log(`  ✗ ${exp} NOT exported`);
      failCount++;
    }
  }

  // Check simpleQuery alias
  if (sdk.simpleQuery) {
    console.log('  ✓ simpleQuery exported');
    passCount++;
  } else {
    console.log('  ✗ simpleQuery NOT exported');
    failCount++;
  }

  // Check getSessionInfo
  if (sdk.getSessionInfo) {
    console.log('  ✓ getSessionInfo exported');
    passCount++;
  } else {
    console.log('  ✗ getSessionInfo NOT exported');
    failCount++;
  }

  console.log('\nResults:');
  console.log('  Pass:', passCount);
  console.log('  Fail:', failCount);

} catch (err) {
  console.log('✗ SDK import failed:', err.message);
}

console.log('\n=== SDK Exports Test Complete ===');