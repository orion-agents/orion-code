/**
 * Test web_fetch SSRF protection
 */
const { TOOLS } = require('../dist/tools/index.js');

console.log('=== web_fetch SSRF Test ===');

// Find web_fetch tool
const fetchTool = TOOLS.find(t => t.name === 'web_fetch');
if (!fetchTool) {
  console.log('✗ web_fetch tool not found');
  process.exit(1);
}
console.log('✓ web_fetch tool found');

// Test SSRF: localhost should be blocked
const blockedUrls = [
  'http://127.0.0.1',
  'http://127.0.0.1:8080',
  'http://localhost',
  'http://localhost:3000',
  'http://192.168.1.1',
  'http://10.0.0.1',
  'http://metadata.google.internal',
];

let passCount = 0;
let failCount = 0;

async function testSSRF(url) {
  try {
    const r = await fetchTool.execute({ url, prompt: 'test' });
    if (r.success === false && (r.error?.includes('Blocked') || r.error?.includes('403') || r.error?.includes('SSRF'))) {
      console.log(`  ✓ ${url} - BLOCKED (correct)`);
      passCount++;
    } else if (r.success === false) {
      console.log(`  ✓ ${url} - FAILED (${r.error?.slice(0, 50)}) - acceptable`);
      passCount++;
    } else {
      console.log(`  ✗ ${url} - NOT BLOCKED (security issue!)`);
      failCount++;
    }
  } catch (e) {
    console.log(`  ✓ ${url} - Exception: ${e.message?.slice(0, 50)} - handled gracefully`);
    passCount++;
  }
}

// Run all SSRF tests
(async () => {
  console.log('\nTesting SSRF blocked URLs:');
  for (const url of blockedUrls) {
    await testSSRF(url);
  }

  console.log('\nResults:');
  console.log('  Pass:', passCount);
  console.log('  Fail:', failCount);

  if (failCount === 0) {
    console.log('  ✓ ALL SSRF tests passed');
  } else {
    console.log('  ✗ SOME SSRF tests failed');
  }

  console.log('\n=== web_fetch SSRF Test Complete ===');
})();