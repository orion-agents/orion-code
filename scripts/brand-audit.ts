/**
 * Orion Code — Brand Audit Script
 *
 * Scans the project for forbidden old-brand tokens (OpenHorse / openhorse / OPENHORSE_ / OH_)
 * outside of explicitly allowed areas (migration implementation, legacy marker readers,
 * historical docs, and migration fixtures).
 *
 * Usage: npx ts-node scripts/brand-audit.ts [--json]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname, resolve } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Match {
  file: string;
  line: number;
  token: string;
  snippet: string;
}

interface BrandAuditResult {
  forbiddenRuntimeMatches: Match[];
  forbiddenActiveDocMatches: Match[];
  allowedHistoricalMatches: Match[];
  migrationMatches: Match[];
  packageIdentity: PackageIdentityCheck;
  passed: boolean;
}

interface PackageIdentityCheck {
  name: string;
  version: string;
  bin: Record<string, string>;
  binContainsOrion: boolean;
  binContainsOpenhorse: boolean;
}

// ── Token patterns ────────────────────────────────────────────────────────────

const FORBIDDEN_PATTERNS = [
  /\bopenhorse\b/i,
  /\bOPENHORSE_\w*/,
  /\bOH_\w+/,
];

// ── Allowlist: files/directories where old brand is explicitly permitted ──────

const ALLOWED_DIRS = new Set([
  resolve('src/migration'),
  resolve('src/product/environment.ts'), // old→new env mapping
  resolve('docs/old'),
]);

const ALLOWED_PATTERNS = [
  /OpenHorseCLIConfig/,    // type alias re-export
  /OpenHorseConfig/,       // type alias re-export
  /OpenHorseRuntime/,      // type alias re-export
  /OpenHorseTool/,         // type alias re-export
  /OpenHorseUiRuntime/,    // type alias re-export
  /OpenHorseInkRuntime/,   // type alias re-export
  /'openhorse'/,           // migration source brand string
  /"openhorse"/,           // migration source brand string
  /sourceBrand.*openhorse/,
  /from.*OpenHorse/,
  /Migrate data from OpenHorse/, // migrate command description
  /argumentHint.*openhorse/,     // migrate command arg hint
];

// ── Scan implementation ───────────────────────────────────────────────────────

function isAllowed(filePath: string): boolean {
  for (const dir of ALLOWED_DIRS) {
    if (filePath.startsWith(dir)) return true;
  }
  return false;
}

function isAllowedPattern(snippet: string): boolean {
  for (const pattern of ALLOWED_PATTERNS) {
    if (pattern.test(snippet)) return true;
  }
  return false;
}

function scanDir(dir: string, ext: string, results: Match[]): void {
  if (!existsSync(dir)) return;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;

    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        scanDir(fullPath, ext, results);
      } else if (stat.isFile() && (ext === '.*' || extname(fullPath) === ext)) {
        scanFile(fullPath, results);
      }
    } catch {
      // skip unreadable
    }
  }
}

function scanFile(filePath: string, results: Match[]): void {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        const match = lines[i].match(pattern);
        if (match && !isAllowedPattern(lines[i])) {
          results.push({
            file: filePath,
            line: i + 1,
            token: match[0],
            snippet: lines[i].trim().slice(0, 120),
          });
        }
      }
    }
  } catch {
    // skip unreadable
  }
}

function checkPackageIdentity(): PackageIdentityCheck {
  const pkgPath = resolve('package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return {
    name: pkg.name,
    version: pkg.version,
    bin: pkg.bin ?? {},
    binContainsOrion: pkg.bin?.orion !== undefined,
    binContainsOpenhorse: pkg.bin?.openhorse !== undefined,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  const srcDir = resolve('src');
  const docsDir = resolve('docs');
  const scriptsDir = resolve('scripts');

  const runtimeMatches: Match[] = [];
  const docMatches: Match[] = [];

  // Scan runtime source (excluding allowed dirs)
  scanDirRecursive(srcDir, runtimeMatches, true);

  // Scan active docs
  scanDirRecursive(docsDir, docMatches, false);

  // Separate migration/allowed matches
  const forbiddenRuntime = runtimeMatches.filter(m => !isAllowed(m.file));
  const migrationMatches = runtimeMatches.filter(m => isAllowed(m.file));

  const packageIdentity = checkPackageIdentity();

  const result: BrandAuditResult = {
    forbiddenRuntimeMatches: forbiddenRuntime,
    forbiddenActiveDocMatches: docMatches.filter(m => !m.file.includes('/old/')),
    allowedHistoricalMatches: docMatches.filter(m => m.file.includes('/old/')),
    migrationMatches,
    packageIdentity,
    passed: forbiddenRuntime.length === 0
      && !packageIdentity.binContainsOpenhorse
      && packageIdentity.binContainsOrion,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('=== Orion Code Brand Audit ===\n');

    console.log(`Package: ${packageIdentity.name}@${packageIdentity.version}`);
    console.log(`Bin: ${JSON.stringify(packageIdentity.bin)}`);
    console.log(`Bin contains 'orion': ${packageIdentity.binContainsOrion}`);
    console.log(`Bin contains 'openhorse': ${packageIdentity.binContainsOpenhorse}\n`);

    if (forbiddenRuntime.length > 0) {
      console.log(`❌ FORBIDDEN runtime matches: ${forbiddenRuntime.length}`);
      for (const m of forbiddenRuntime) {
        console.log(`  ${m.file}:${m.line} — "${m.token}"`);
      }
    } else {
      console.log('✅ No forbidden runtime matches');
    }

    if (migrationMatches.length > 0) {
      console.log(`ℹ️  Migration/allowed matches: ${migrationMatches.length}`);
    }

    if (result.passed) {
      console.log('\n✅ Brand Audit PASSED');
    } else {
      console.log('\n❌ Brand Audit FAILED');
    }
  }

  process.exit(result.passed ? 0 : 1);
}

function scanDirRecursive(dir: string, results: Match[], isRuntime: boolean): void {
  if (!existsSync(dir)) return;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;

    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        // Skip historical docs
        if (entry === 'old' && dir.endsWith('docs')) {
          scanDir(fullPath, '.*', results);
          continue;
        }
        scanDirRecursive(fullPath, results, isRuntime);
      } else if (stat.isFile()) {
        const ext = extname(fullPath);
        if (isRuntime && (ext === '.ts' || ext === '.tsx' || ext === '.js')) {
          scanFile(fullPath, results);
        } else if (!isRuntime && (ext === '.md' || ext === '.json' || ext === '.yml' || ext === '.yaml')) {
          scanFile(fullPath, results);
        }
      }
    } catch {
      // skip unreadable
    }
  }
}

main();