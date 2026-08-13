const { existsSync } = require('fs');

const [, , configDir, barrierPath, key, value] = process.argv;
process.env.ORION_CODE_CONFIG_DIR = configDir;

function waitForBarrier() {
  if (!existsSync(barrierPath)) {
    setTimeout(waitForBarrier, 5);
    return;
  }
  const { updateGlobalConfig } = require('../../src/services/global-config');
  updateGlobalConfig({ [key]: value });
}

waitForBarrier();
