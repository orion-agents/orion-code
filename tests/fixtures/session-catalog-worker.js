const fs = require('fs');
const pathModule = require('path');

const mode = process.argv[2];
const argument = process.argv[3];
const originalReadFileSync = fs.readFileSync;
const originalReaddirSync = fs.readdirSync;
let metaReads = 0;
let projectDirectoryReads = 0;

fs.readFileSync = function countedRead(path, ...args) {
  if (typeof path === 'string' && /projects[/\\].+[/\\]sessions[/\\][^/\\]+\.json$/.test(path)) {
    metaReads += 1;
  }
  return originalReadFileSync.call(this, path, ...args);
};
fs.readdirSync = function countedReaddir(path, ...args) {
  const projectsRoot = pathModule.join(process.env.ORION_CODE_CONFIG_DIR, 'projects');
  if (
    typeof path === 'string' &&
    (path === projectsRoot || path.startsWith(`${projectsRoot}${pathModule.sep}`))
  ) {
    projectDirectoryReads += 1;
  }
  return originalReaddirSync.call(this, path, ...args);
};

const storage = require('../../src/services/session-storage');
metaReads = 0;
projectDirectoryReads = 0;
const result =
  mode === 'lookup' ? storage.loadSessionMeta(argument) : storage.listSessions(Number(argument));

process.stdout.write(
  JSON.stringify({
    found: mode === 'lookup' ? result?.id : undefined,
    count: Array.isArray(result) ? result.length : undefined,
    metaReads,
    projectDirectoryReads,
  })
);
