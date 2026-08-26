#!/usr/bin/env ts-node

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import {
  createRuntimeMatrixReceiptV1,
  verifyTarballArtifactReceiptV1,
  type RuntimeMatrixProbeV1,
} from '../../src/runtime/release-receipts';

interface ArgumentsV1 {
  readonly tarball: string;
  readonly artifactReceipt: string;
  readonly output: string;
}

interface CommandOutcomeV1 {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

const SKILL_JOURNEY_SOURCE = String.raw`
const {join}=require('path');
const packageRoot=process.argv[1];
const skills=require(join(packageRoot,'dist','runtime','skills'));
(async()=>{
  const provider=skills.createFilesystemSkillProviderV1({
    roots:[{path:join(packageRoot,'dist','skills','builtin'),sourceScope:'builtin'}],
    watch:false
  });
  const runtime=new skills.LazySkillRuntime({providers:[provider]});
  const catalog=await runtime.observe({id:'release-matrix'});
  if(catalog.descriptors.length!==3)throw new Error('expected 3 built-in Skill descriptors');
  const before=provider.stats();
  if(before.definitionReads!==0||before.resourceReads!==0)throw new Error('Skill body/resource loaded eagerly');
  const selected=await runtime.getDefinition({
    catalog,
    skillId:catalog.descriptors[0].id,
    actor:'user',
    reason:'release_matrix_explicit',
    authority:{authorityId:'release-matrix',digest:'release-matrix-authority',allowedCapabilities:[]}
  });
  if(!selected.definition.body.trim())throw new Error('selected Skill definition is empty');
  const after=provider.stats();
  if(after.definitionReads!==1||after.resourceReads!==0)throw new Error('Skill lazy-load counters drifted');
  await runtime.dispose();
})().catch(error=>{console.error(error);process.exit(1)});
`;

const MCP_SERVER_SOURCE = String.raw`
const readline=require('readline');
const input=readline.createInterface({input:process.stdin});
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
input.on('line',line=>{
  const message=JSON.parse(line);
  if(!message.id)return;
  if(message.method==='initialize')return send(message.id,{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'release-matrix',version:'1'}});
  if(message.method==='tools/list')return send(message.id,{tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]});
  if(message.method==='tools/call')return send(message.id,{content:[{type:'text',text:String(message.params.arguments.text)}]});
});
`;

const MCP_JOURNEY_SOURCE = String.raw`
const {join}=require('path');
const packageRoot=process.argv[1];
const serverSource=process.argv[2];
const mcp=require(join(packageRoot,'dist','runtime','mcp'));
(async()=>{
  const adapter=mcp.createFirstPartyMcpAdapterV1({
    config:{mcpServers:{fixture:{command:process.execPath,args:['-e',serverSource]}}},
    requestTimeoutMs:5000,
    closeGraceMs:100
  });
  const runtime=new mcp.LazyMcpRuntime({descriptors:adapter.descriptors,connector:adapter.connector,idleTimeoutMs:0});
  if(runtime.snapshot().servers[0].state!=='dormant')throw new Error('MCP connected before selection');
  const lease=await runtime.acquire({catalog:runtime.getCatalog(),serverId:'fixture',ownerId:'release-turn',reason:'explicit'});
  const tools=runtime.toolBindingsForOwner('release-turn');
  if(tools.length!==1||tools[0].descriptor.qualifiedName!=='mcp__fixture__echo')throw new Error('MCP binding mismatch');
  const output=await tools[0].invoke({text:'MCP_RELEASE_OK'});
  if(!JSON.stringify(output).includes('MCP_RELEASE_OK'))throw new Error('MCP call result mismatch');
  await lease.release();
  await runtime.dispose('release_matrix_complete');
})().catch(error=>{console.error(error);process.exit(1)});
`;

export function parseRuntimeMatrixArgumentsV1(argv: readonly string[]): ArgumentsV1 {
  const tarball = optionValue(argv, '--tarball');
  const artifactReceipt = optionValue(argv, '--artifact-receipt');
  const output = optionValue(argv, '--out');
  if (!tarball || !artifactReceipt || !output) {
    throw new Error(
      'Usage: runtime-matrix --tarball PACKAGE.tgz --artifact-receipt artifact.json --out receipt.json'
    );
  }
  return {
    tarball: resolve(tarball),
    artifactReceipt: resolve(artifactReceipt),
    output: resolve(output),
  };
}

function main(): void {
  const args = parseRuntimeMatrixArgumentsV1(process.argv.slice(2));
  const artifact = verifyTarballArtifactReceiptV1(
    JSON.parse(readFileSync(args.artifactReceipt, 'utf8')) as unknown
  );
  const actualTarballSha256 = createHash('sha256').update(readFileSync(args.tarball)).digest('hex');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const npmVersion = run('npm', ['--version']).stdout.trim() || 'unavailable';
  const matrixRunnerDigest = digestText(readFileSync(__filename, 'utf8'));
  const temporaryRoot = mkdtempSync(join(tmpdir(), `orion-runtime-node${nodeMajor}-`));
  const installDirectory = join(temporaryRoot, 'install');
  const probes: RuntimeMatrixProbeV1[] = [];

  try {
    const install = run('npm', [
      'install',
      '--prefix',
      installDirectory,
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      args.tarball,
    ]);
    probes.push(
      probe(
        'clean_install',
        install,
        'npm installed the exact tgz into an empty prefix',
        true,
        matrixRunnerDigest,
        actualTarballSha256
      )
    );

    const packageRoot = join(installDirectory, 'node_modules', '@orion-agents', 'orion-code');
    const installedPackagePath = join(packageRoot, 'package.json');
    const binary = join(packageRoot, 'bin', 'orion');
    const distCli = join(packageRoot, 'dist', 'cli.js');
    const installedPackageDigest = digestFile(installedPackagePath);
    const binaryDigest = digestFile(binary);
    const distCliDigest = digestFile(distCli);
    const identity = run(process.execPath, [
      '-e',
      `const p=require(${JSON.stringify(installedPackagePath)});` +
        `if(p.name!==${JSON.stringify(artifact.package.name)}||p.version!==${JSON.stringify(artifact.package.version)})process.exit(2);`,
    ]);
    const hashMatches = actualTarballSha256 === artifact.tarball.sha256;
    probes.push({
      id: 'package_identity',
      status: identity.status === 0 && hashMatches ? 'pass' : 'fail',
      detail:
        identity.status === 0 && hashMatches
          ? `package identity and sha256 ${actualTarballSha256} match`
          : `identityExit=${identity.status} hashMatches=${hashMatches}`,
      durationMs: identity.durationMs,
      runnerDigest: matrixRunnerDigest,
      targetDigest: installedPackageDigest,
    });

    const version = run(process.execPath, [binary, '--version'], installDirectory);
    probes.push(
      probe(
        'version',
        version,
        `reported ${artifact.package.version}`,
        version.stdout.includes(artifact.package.version),
        matrixRunnerDigest,
        binaryDigest
      )
    );
    const help = run(process.execPath, [binary, '--help'], installDirectory);
    probes.push(
      probe(
        'help',
        help,
        /Usage:|Orion Code/u.test(help.stdout) ? 'help rendered' : 'help marker missing',
        /Usage:|Orion Code/u.test(help.stdout),
        matrixRunnerDigest,
        binaryDigest
      )
    );

    const publicExports = run(
      process.execPath,
      [
        '-e',
        `const api=require(${JSON.stringify(packageRoot)});` +
          `const forbidden=['Brain','BaseAgent','Harness','HarnessEngine','AgentRunner','query','simpleQuery','RuntimeServices','ResourceScope','StepSnapshotV1'];` +
          `if(typeof api.createOrionRuntime!=='function'||forbidden.some(k=>Object.prototype.hasOwnProperty.call(api,k)))process.exit(3);`,
      ],
      installDirectory
    );
    probes.push(
      probe(
        'public_exports',
        publicExports,
        'public facade excludes legacy owners',
        true,
        matrixRunnerDigest,
        digestFile(join(packageRoot, 'dist', 'index.js'))
      )
    );

    const builtinSkills = run(
      process.execPath,
      [
        '-e',
        `const{readFileSync}=require('fs');const{join}=require('path');` +
          `for(const id of ['code-review','security-check','test-gen']){` +
          `const p=join(${JSON.stringify(packageRoot)},'dist','skills','builtin',id,'SKILL.md');` +
          `const body=readFileSync(p,'utf8');if(!body.startsWith('---')||!body.includes('name:'))process.exit(5);}`,
      ],
      installDirectory
    );
    probes.push(
      probe(
        'builtin_skill_assets',
        builtinSkills,
        'built-in Skill assets are readable from the installed package',
        true,
        matrixRunnerDigest,
        digestDirectoryFiles(
          ['code-review', 'security-check', 'test-gen'].map(id =>
            join(packageRoot, 'dist', 'skills', 'builtin', id, 'SKILL.md')
          )
        )
      )
    );

    const native = run(
      process.execPath,
      [
        '-e',
        `const{createRequire}=require('module');const r=createRequire(${JSON.stringify(join(installDirectory, 'probe.js'))});` +
          `const L=r('better-sqlite3');const D=L.default||L;const db=new D(':memory:',{allowExtension:true});` +
          `const V=r('sqlite-vec');(V.default||V).load(db);const row=db.prepare('SELECT vec_version() AS version').get();` +
          `if(!row||!row.version)process.exit(4);db.close();`,
      ],
      installDirectory
    );
    probes.push(
      probe(
        'native_sqlite',
        native,
        'better-sqlite3 and sqlite-vec loaded',
        true,
        matrixRunnerDigest,
        installedPackageDigest
      )
    );

    const boundRunnerEnvironment = {
      ORION_BIN: binary,
      ORION_REQUIRE_BOUND_RUNNER: '1',
      ORION_EXPECT_BIN_SHA256: binaryDigest,
      ORION_EXPECT_PACKAGE_JSON_SHA256: installedPackageDigest,
      ORION_EXPECT_DIST_CLI_SHA256: distCliDigest,
      ORION_PTY_NODE: process.execPath,
    };
    const smokeRoot = resolve(__dirname, '../smoke');
    const smoke = (filename: string): CommandOutcomeV1 =>
      run('python3', [join(smokeRoot, filename)], process.cwd(), boundRunnerEnvironment);
    const tui = smoke('tui-ui-pty-smoke.py');
    probes.push(
      probe(
        'tui_journey',
        tui,
        'installed TUI completed the bound PTY journey',
        true,
        digestFile(join(smokeRoot, 'tui-ui-pty-smoke.py')),
        distCliDigest
      )
    );
    const terminal = smoke('terminal-ui-pty-smoke.py');
    probes.push(
      probe(
        'terminal_journey',
        terminal,
        'installed terminal renderer completed the bound PTY journey',
        true,
        digestFile(join(smokeRoot, 'terminal-ui-pty-smoke.py')),
        distCliDigest
      )
    );
    const print = smoke('print-mode-smoke.py');
    probes.push(
      probe(
        'print_journey',
        print,
        'installed print renderer completed text, JSON, stdin, and denial journeys',
        true,
        digestFile(join(smokeRoot, 'print-mode-smoke.py')),
        distCliDigest
      )
    );
    const goal = smoke('goal-lifecycle-pty-smoke.py');
    probes.push(
      probe(
        'goal_journey',
        goal,
        'installed Goal lifecycle completed durable evidence and auto-exit journey',
        true,
        digestFile(join(smokeRoot, 'goal-lifecycle-pty-smoke.py')),
        distCliDigest
      )
    );
    const subagent = smoke('research-renderer-pty-smoke.py');
    probes.push(
      probe(
        'subagent_journey',
        subagent,
        'installed root and child runtimes completed the renderer-parity journey',
        true,
        digestFile(join(smokeRoot, 'research-renderer-pty-smoke.py')),
        distCliDigest
      )
    );

    const skill = run(
      process.execPath,
      ['-e', SKILL_JOURNEY_SOURCE, packageRoot],
      installDirectory
    );
    probes.push(
      probe(
        'skill_journey',
        skill,
        'installed Skill runtime observed descriptors then loaded one selected definition',
        true,
        digestText(SKILL_JOURNEY_SOURCE),
        digestFile(join(packageRoot, 'dist', 'runtime', 'skills', 'index.js'))
      )
    );
    const mcp = run(
      process.execPath,
      ['-e', MCP_JOURNEY_SOURCE, packageRoot, MCP_SERVER_SOURCE],
      installDirectory
    );
    probes.push(
      probe(
        'mcp_journey',
        mcp,
        'installed MCP runtime kept transport dormant until exact selection and call',
        true,
        digestText(`${MCP_JOURNEY_SOURCE}\n${MCP_SERVER_SOURCE}`),
        digestFile(join(packageRoot, 'dist', 'runtime', 'mcp', 'index.js'))
      )
    );
    probes.push(
      probe(
        'compact_resume_journey',
        goal,
        'the bound Goal journey crossed compact, process restart, resume, and completion',
        true,
        digestFile(join(smokeRoot, 'goal-lifecycle-pty-smoke.py')),
        distCliDigest
      )
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const receipt = createRuntimeMatrixReceiptV1({
    version: 1,
    kind: 'orion.runtime-matrix',
    createdAt: new Date().toISOString(),
    artifactReceiptDigest: artifact.receiptDigest,
    tarballSha256: actualTarballSha256,
    package: artifact.package,
    environment: {
      node: process.version,
      nodeMajor,
      npm: npmVersion,
      platform: process.platform,
      arch: process.arch,
    },
    probes,
  });
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.decision !== 'GO') process.exitCode = 1;
}

function probe(
  id: RuntimeMatrixProbeV1['id'],
  outcome: CommandOutcomeV1,
  successDetail: string,
  additionalCondition: boolean,
  runnerDigest: string,
  targetDigest: string
): RuntimeMatrixProbeV1 {
  const passed = outcome.status === 0 && additionalCondition;
  return {
    id,
    status: passed ? 'pass' : 'fail',
    detail: passed
      ? successDetail
      : `exit=${outcome.status} ${sanitize(outcome.stderr || outcome.stdout)}`,
    durationMs: outcome.durationMs,
    runnerDigest,
    targetDigest,
  };
}

function run(
  command: string,
  args: readonly string[],
  cwd = process.cwd(),
  extraEnvironment: Readonly<Record<string, string>> = {}
): CommandOutcomeV1 {
  const startedAt = performance.now();
  const outcome = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ORION_CODE_CONFIG_DIR: join(tmpdir(), 'orion-release-config-unused'),
      ...extraEnvironment,
    },
  });
  return {
    status: outcome.status ?? 1,
    stdout: outcome.stdout ?? '',
    stderr: outcome.error?.message ?? outcome.stderr ?? '',
    durationMs: Math.max(0, performance.now() - startedAt),
  };
}

function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestDirectoryFiles(paths: readonly string[]): string {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) hash.update(readFileSync(path));
  return hash.digest('hex');
}

function sanitize(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(-500) || 'command failed without output';
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ kind: 'orion.runtime-matrix-error', failClosed: true, error: error instanceof Error ? error.message : String(error) })}\n`
    );
    process.exitCode = 1;
  }
}
