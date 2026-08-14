const { existsSync } = require('fs');

const [, , configDir, barrierPath, content] = process.argv;
process.env.ORION_CODE_CONFIG_DIR = configDir;

function waitForBarrier() {
  if (!existsSync(barrierPath)) {
    setTimeout(waitForBarrier, 5);
    return;
  }
  const { addToInputHistory } = require('../../src/services/global-config');
  addToInputHistory(content);
}

waitForBarrier();
