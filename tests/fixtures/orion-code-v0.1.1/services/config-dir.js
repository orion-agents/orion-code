'use strict';

const path = require('path');

/**
 * Test-only path adapter for the byte-pinned published v0.1.1 Goal reader.
 * The production 0.1.1 package uses the same function name; the fixture keeps
 * its schema reader byte-for-byte intact while directing storage into Jest's
 * isolated project directory.
 */
exports.getProjectSessionsDir = projectPath =>
  process.env.ORION_V011_FIXTURE_SESSIONS_DIR || path.join(projectPath, 'sessions');
