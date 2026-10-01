#!/usr/bin/env node
// Runs a declarative real-PTY TUI scenario against the SDK's loopback fixture host.
// No shell, model provider, credential, or network proxy is used by this runner.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TuiSession } from '../dist/tuiSession.js';
import { checkTui, observeTui } from '../dist/tuiCheck.js';
import { measureTuiSpacing } from '../dist/tuiSpacing.js';
import { TuiBuffer } from '../dist/tuiBuffer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const sdkDefault = '/Users/nate/Private Repos/harness-sdk';
const evidenceDefault = '/Users/nate/Documents/Codex/2026-09-29-aeltum-tui-reference-study/build-lanes/lane-5-evidence/campaign';

function parseArgs(argv) {
  const opts = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const name = key.slice(2);
    if (['self-test', 'help'].includes(name)) opts[name] = true;
    else {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`${key} requires a value`);
      opts[name] = argv[++index];
    }
  }
  return opts;
}

function sanitizedEnv(extra = {}) {
  return {
    ...process.env,
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    AOA_API_KEY_ENV: '', AOA_ABAC_POLICY: '', AOA_ABAC_REALM: '', AOA_POLICY_FILES: '', AOA_POLICY_DIGEST: '',
    OPENROUTER_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ...extra,
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? sanitizedEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, options.timeoutMs ?? 15000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), signal, timedOut, stdout, stderr });
    });
  });
}

function fileHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(filename) {
  return fileHash(await readFile(filename));
}

async function gitValue(directory, args) {
  const result = await runProcess('git', ['-C', directory, ...args], { timeoutMs: 3000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

function allowedTool(name) {
  return name === 'file_read' || name === 'file_write';
}

function makePolicy(deployment, tools, catalog = {}) {
  const policies = [{
    id: 'lane5-local-run', effect: 'allow', priority: 10,
    scope: {
      'subject.principal': `local-user:${userInfo().uid}`,
      'resource.kind': 'a2a.agent', 'resource.ref': 'aoa', 'resource.owner': 'oe',
      'resource.labels.permission_context': 'AO-TU',
    },
  }];
  if (catalog.allowLoopbackProviderCatalogRead) {
    if (!catalog.deploymentDir) throw new Error('loopback provider catalog authority requires the temporary deployment directory');
    policies.push({
      id: 'lane5-loopback-provider-models-call', effect: 'allow', priority: 10,
      scope: {
        'subject.principal': `aoa.catalog:${catalog.deploymentDir}`,
        'subject.altitude': 'run', 'environment.altitude': 'run',
        'resource.kind': 'mcp.tool', 'resource.owner': 'oe', 'resource.ref': 'provider_models',
        'resource.labels.realm': deployment,
        'action.verb': 'call', 'action.operation': 'tools/call',
      },
    });
  }
  for (const name of tools) for (const verb of ['read', 'call']) policies.push({
    id: `lane5-tool-${name}-${verb}`, effect: 'allow', priority: 10,
    scope: {
      'resource.kind': 'mcp.tool', 'resource.owner': 'oe', 'resource.ref': name,
      'subject.altitude': 'run', 'action.verb': verb, 'action.operation': `tools/${verb}`,
    },
  });
  const settings = {
    'subject.principal': `aoa-tui:${deployment}`, 'resource.kind': 'data',
    'resource.ref': `harness-settings/aoa/${deployment}`, 'resource.owner': 'harness-handoff',
  };
  policies.push({ id: 'lane5-settings-read', effect: 'allow', priority: 10, scope: { ...settings, 'action.verb': 'read', 'action.operation': 'settings.get' } });
  policies.push({ id: 'lane5-settings-write', effect: 'allow', priority: 10, scope: { ...settings, 'action.verb': 'write', 'action.operation': 'settings.set' } });
  return { schema: 'abac.policyfile.v1', realm: deployment, policies };
}

async function mkdirSafe(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function writeWorkspaceFiles(root, files = {}) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.resolve(root, relative);
    if (path.isAbsolute(relative) || target !== root && !target.startsWith(root + path.sep)) throw new Error(`fixture workspace path escapes root: ${relative}`);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, String(content), { mode: 0o600 });
  }
}

async function makeClipboardCapture(runDir) {
  const bin = path.join(runDir, 'clipboard-shims');
  const captured = path.join(runDir, 'clipboard.capture');
  await mkdirSafe(bin);
  const shim = '#!/bin/sh\ncat > "$AELTUM_TUI_CLIPBOARD_CAPTURE"\n';
  for (const name of ['pbcopy', 'wl-copy', 'xclip', 'xsel', 'clip']) {
    const filename = path.join(bin, name);
    await writeFile(filename, shim, { mode: 0o700 });
    await chmod(filename, 0o700);
  }
  return { bin, captured };
}

async function waitForFile(filename, child, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(filename, 'utf8')); } catch { /* ready file is not written yet */ }
    if (child.exitCode !== null) throw new Error(`fixture host exited before ready (exit ${child.exitCode})`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('fixture host did not become ready within 8 seconds');
}

async function fixtureState(origin) {
  const response = await fetch(`${origin}/__fixture/state`);
  if (!response.ok) throw new Error(`fixture state returned HTTP ${response.status}`);
  return response.json();
}

async function waitFixture(origin, predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  let last;
  do {
    last = await fixtureState(origin);
    if (predicate(last)) return { passed: true, state: last };
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < until);
  return { passed: false, state: last };
}

function specFixtureMatches(state, spec) {
  const request = state.requests[spec.index];
  if (!request) return false;
  if (spec.id && request.id !== spec.id) return false;
  if (spec.status && !(Array.isArray(spec.status) ? spec.status : [spec.status]).includes(request.status)) return false;
  return true;
}

async function listFiles(root) {
  const files = [];
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else {
        const info = await stat(filename);
        files.push({ path: filename, bytes: info.size });
      }
    }
  }
  await visit(root);
  return files;
}

async function protocolClipboard(session, screenDir) {
  if (!session) return null;
  let raw;
  try { raw = await readFile(path.join(screenDir, `${session.id}.ansi`), 'utf8'); } catch { return null; }
  const matches = [...raw.matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return null;
  try { return Buffer.from(last, 'base64').toString('utf8'); } catch { return null; }
}

async function selfTest() {
  const results = [];
  const note = (name, passed, detail = '') => results.push({ name, passed, detail });
  let session;
  const open = async code => TuiSession.open({ command: ['python3', '-u', '-c', code], cols: 50, rows: 12, interactionTimeoutMs: 80, outDir: path.join('/tmp', `ui-crawl-scenario-selftest-${process.pid}`), markedScreenshots: false });
  try {
    const defaultPolicy = makePolicy('lane5-self-test', ['file_read']);
    note('default scenario policy does not authorize provider catalog reads', !defaultPolicy.policies.some(policy => policy.scope?.['resource.ref'] === 'provider_models'));
    const catalogDeploymentDir = '/tmp/ui-crawl-scenario-selftest-deployment';
    const optedInPolicy = makePolicy('lane5-self-test', ['file_read'], { allowLoopbackProviderCatalogRead: true, deploymentDir: catalogDeploymentDir });
    const catalogPolicy = optedInPolicy.policies.find(policy => policy.id === 'lane5-loopback-provider-models-call');
    const expectedCatalogScope = {
      'subject.principal': `aoa.catalog:${catalogDeploymentDir}`,
      'subject.altitude': 'run', 'environment.altitude': 'run',
      'resource.kind': 'mcp.tool', 'resource.owner': 'oe', 'resource.ref': 'provider_models',
      'resource.labels.realm': 'lane5-self-test',
      'action.verb': 'call', 'action.operation': 'tools/call',
    };
    note('catalog opt-in grants only the observed OE call attributes', JSON.stringify(catalogPolicy?.scope) === JSON.stringify(expectedCatalogScope));

    const b = new TuiBuffer(40, 12);
    b.write('> question\x1b[6;1Hanswer');
    const tooWide = measureTuiSpacing(b, [{ name: 'reply', bounds: { row: 5, col: 0, rows: 1, cols: 40 }, maxGapBefore: 1 }])[0];
    const tight = new TuiBuffer(40, 12);
    tight.write('> question\x1b[2;1Hanswer');
    const tooTight = measureTuiSpacing(tight, [{ name: 'reply', bounds: { row: 1, col: 0, rows: 1, cols: 40 }, minGapBefore: 1 }])[0];
    note('too much separation fails', !tooWide.passed, tooWide.violations.join('; '));
    note('too little separation fails', !tooTight.passed, tooTight.violations.join('; '));

    session = await open("import os,time\nos.write(1,'Only a spinner: ◐'.encode())\ntime.sleep(2)");
    const spinner = await observeTui(session, { durationMs: 120, intervalMs: 20, sequence: [
      { name: 'partial text', text: 'Partial reasoning' }, { name: 'final text', text: 'Final answer' },
    ] });
    note('spinner-only does not pass streamed content', spinner.passed === false, spinner.violations.join('; '));
    await session.close(); session = undefined;

    session = await open("import os,time\nos.write(1,'Working · draft is visible'.encode())\ntime.sleep(2)");
    const missing = await checkTui(session, { requiredText: ['state: completed', 'next draft'], identities: [{ name: 'OE call', value: 'tui-call-expected' }] });
    note('missing state and preserved draft fail', missing.passed === false && missing.violations.some(value => value.includes('state: completed')) && missing.violations.some(value => value.includes('next draft')), missing.violations.join('; '));
    session.screenBuffer.write('\x1b[2;1HFrame survived exit');
    await session.close(); session = undefined;

    session = await open("import os,sys\nos.write(1,b'Frame before nonzero exit')\nsys.exit(9)");
    const nonzero = await checkTui(session, { requiredText: ['Frame before nonzero exit'] });
    note('nonzero process exit fails', nonzero.passed === false && nonzero.violations.includes('process exited with code 9'), nonzero.violations.join('; '));
    await session.close(); session = undefined;

    session = await open("import os,time\nos.write(1,b'Ready for screenshot')\ntime.sleep(2)");
    session.screenshot = async () => { throw new Error('intentional fixture screenshot failure'); };
    const shot = await checkTui(session, { requiredText: ['Ready for screenshot'] });
    note('screenshot failure fails', shot.passed === false && shot.violations.includes('screenshot failed: intentional fixture screenshot failure'), shot.violations.join('; '));
    await session.close(); session = undefined;
  } catch (error) {
    note('self-test execution', false, error instanceof Error ? error.message : String(error));
  } finally { await session?.close().catch(() => {}); }
  const passed = results.length === 8 && results.every(result => result.passed);
  return { schema: 'ui-crawl.tui-scenario-self-test.v1', passed, results };
}

async function campaign(opts) {
  if (!opts.binary) throw new Error('--binary must name the built aoa CLI executable');
  const sdkRoot = path.resolve(opts.sdk ?? sdkDefault);
  // Node resolves the entry module through symlinks. Match its canonical path
  // so the fixture's CLI entry guard also works for /tmp worktrees on macOS.
  const fixtureHost = await realpath(path.resolve(opts['fixture-host'] ?? path.join(sdkRoot, 'tools/tui-scenarios/provider.mjs')));
  const scenarioPath = path.resolve(opts.scenario ?? path.join(here, 'tui-scenarios/aeltum-smoke.json'));
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
  if (scenario.authorizeLoopbackProviderCatalogRead !== undefined && typeof scenario.authorizeLoopbackProviderCatalogRead !== 'boolean') {
    throw new Error('authorizeLoopbackProviderCatalogRead must be an explicit boolean scenario opt-in');
  }
  if (scenario.launchSettingsOnlyAtStart !== undefined && typeof scenario.launchSettingsOnlyAtStart !== 'boolean') {
    throw new Error('launchSettingsOnlyAtStart must be a boolean scenario setting');
  }
  const launchSettingsOnlyAtStart = scenario.launchSettingsOnlyAtStart === true;
  const catalogOptIn = scenario.authorizeLoopbackProviderCatalogRead === true;
  const fixturePath = path.isAbsolute(scenario.fixture) ? scenario.fixture : path.join(sdkRoot, 'tools/tui-scenarios', scenario.fixture);
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const binary = path.resolve(opts.binary);
  const binaryInfo = await stat(binary);
  if (!binaryInfo.isFile()) throw new Error(`--binary is not a file: ${binary}`);
  const tools = scenario.tools ?? ['file_read', 'file_write'];
  if (!Array.isArray(tools) || !tools.length || tools.some(name => !allowedTool(name))) throw new Error('scenario tools may contain only file_read and file_write');
  const cols = Number(opts.cols ?? scenario.terminal?.cols ?? 100);
  const rows = Number(opts.rows ?? scenario.terminal?.rows ?? 32);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || rows < 4) throw new Error('terminal size must be positive TUI dimensions');
  const outDir = path.resolve(opts.out ?? evidenceDefault);
  await mkdirSafe(outDir);
  const runDir = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  await mkdirSafe(runDir);
  const deployment = `lane5-${process.pid}`;
  const workspace = path.join(runDir, 'workspace');
  const deploymentDir = path.join(runDir, 'deployment');
  const sessionDir = path.join(runDir, 'session');
  const tuiOut = path.join(runDir, 'tui');
  const readyFile = path.join(runDir, 'fixture-ready.json');
  const policyDir = path.join(deploymentDir, 'policies');
  const clipboard = await makeClipboardCapture(runDir);
  for (const dir of [workspace, deploymentDir, policyDir, sessionDir, tuiOut]) await mkdirSafe(dir);
  await writeWorkspaceFiles(workspace, scenario.workspaceFiles);
  const policyFile = path.join(policyDir, 'lane5.json');
  let policy;

  const report = {
    schema: 'aeltum.tui.evidence.v1', name: scenario.name ?? scenario.id ?? path.basename(scenarioPath),
    scenarioPath, fixturePath, startedAt: new Date().toISOString(),
    outputDir: runDir, status: 'running', failures: [], steps: [], observations: [],
    inputs: [], receipts: [], artifacts: [],
    source: {
      uiCrawlHead: await gitValue(repoRoot, ['rev-parse', 'HEAD']),
      uiCrawlStatus: await gitValue(repoRoot, ['status', '--short']),
      sdkHead: await gitValue(sdkRoot, ['rev-parse', 'HEAD']),
      sdkStatus: await gitValue(sdkRoot, ['status', '--short']),
      binary, binarySha256: await sha256File(binary), cols, rows,
      launchSettingsOnlyAtStart,
      uiRunnerSha256: await sha256File(fileURLToPath(import.meta.url)),
      fixtureHostSha256: await sha256File(fixtureHost), fixtureScenarioSha256: await sha256File(fixturePath),
      campaignSha256: await sha256File(scenarioPath),
    },
    safety: { providerTarget: '127.0.0.1 ephemeral port', proxyVariablesCleared: true, credentialsCleared: true, externalClipboardWritesRedirected: true, toolAllowlist: tools, providerModelsCatalogReadOptIn: catalogOptIn, workspaceRoot: workspace, outboundFixtureRequests: 0 },
  };
  if (opts['skills-dir']) {
    const selected = String(opts.skills ?? 'repo-discover').split(',');
    if (!selected.length || selected.some(name => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) throw new Error('select explicit native skill names');
    report.source.skillStore = path.resolve(opts['skills-dir']);
    report.source.skills = await Promise.all(selected.map(async name => {
      const filename = path.join(report.source.skillStore, name, 'SKILL.md');
      return { name, path: filename, sha256: await sha256File(filename) };
    }));
  }
  await writeFile(path.join(runDir, 'scenario.json'), JSON.stringify(scenario, null, 2) + '\n');
  let fixtureChild, fixtureStdout = '', fixtureStderr = '', session;
  let initialProfile;
  const pendingObservations = new Map();
  const sessionDirs = [];
  const sessionInstances = [];
  let sessionNumber = 0;
  let activeScreenDir = '';
  const argsForTui = (fixtureInfo, activeSessionDir) => [
    '-deployment', deployment, '-deployment-dir', deploymentDir,
    '-base-url', fixtureInfo.baseUrl,
    ...(launchSettingsOnlyAtStart ? [] : ['-model', fixture.modelId || 'aeltum-fixture']),
    '-api-key-env', '',
    '-workspace-root', workspace, '-session-dir', activeSessionDir,
    '-tool-allowlist', tools.join(','), '-packages', 'core,work',
    ...(opts['skills-dir'] ? ['-skills-dir', path.resolve(opts['skills-dir']), '-skills', opts.skills ?? 'repo-discover'] : []),
  ];
  const openSession = async fixtureInfo => {
    sessionNumber++;
    const screenDir = path.join(tuiOut, `session-${sessionNumber}`);
    await mkdirSafe(screenDir);
    sessionDirs.push(screenDir);
    activeScreenDir = screenDir;
    session = await TuiSession.open({
    command: [binary, ...argsForTui(fixtureInfo, sessionDir)], cwd: workspace,
      env: sanitizedEnv({
        TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '',
        AOA_DEPLOYMENT: deployment, AOA_DEPLOYMENT_DIR: deploymentDir, AOA_ABAC_REALM: deployment,
        PATH: `${clipboard.bin}${path.delimiter}${process.env.PATH ?? ''}`, AELTUM_TUI_CLIPBOARD_CAPTURE: clipboard.captured,
      }),
      cols, rows, interactionTimeoutMs: Number(scenario.interactionTimeoutMs ?? 100),
      markedScreenshots: false, outDir: screenDir,
    });
    sessionInstances.push(session);
    report.steps.push({ kind: 'open', sessionNumber, cols, rows, text: session.rawText, exitCode: session.exitCode });
    return session;
  };

  try {
    const env = sanitizedEnv({ AOA_DEPLOYMENT: deployment, AOA_DEPLOYMENT_DIR: deploymentDir });
    fixtureChild = spawn(process.execPath, [fixtureHost, '--scenario', fixturePath, '--ready-file', readyFile], { cwd: sdkRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    fixtureChild.stdout.setEncoding('utf8'); fixtureChild.stderr.setEncoding('utf8');
    fixtureChild.stdout.on('data', value => { fixtureStdout += value; });
    fixtureChild.stderr.on('data', value => { fixtureStderr += value; });
    const fixtureInfo = await waitForFile(readyFile, fixtureChild);
    if (fixtureInfo.bindHost !== '127.0.0.1' || !fixtureInfo.baseUrl.startsWith('http://127.0.0.1:')) throw new Error('fixture host did not report an IPv4 loopback endpoint');
    if (catalogOptIn) {
      const expectedFixtureHost = await realpath(path.join(sdkRoot, 'tools/tui-scenarios/provider.mjs'));
      const endpoint = new URL(fixtureInfo.baseUrl);
      if (fixtureHost !== expectedFixtureHost || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== '/v1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error('provider catalog scenario authority requires the SDK loopback fixture and its exact ephemeral /v1 endpoint');
      }
    }
    report.fixture = { ...fixtureInfo, script: fixturePath, modelId: fixture.modelId ?? 'aeltum-fixture' };
    report.safety.providerModelsCatalogEndpoint = catalogOptIn ? fixtureInfo.baseUrl : null;
    await writeFile(path.join(runDir, 'fixture-connection.json'), JSON.stringify(report.fixture, null, 2) + '\n');

    policy = makePolicy(deployment, tools, catalogOptIn ? { allowLoopbackProviderCatalogRead: true, deploymentDir } : {});
    await writeFile(policyFile, JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 });
    await writeFile(path.join(runDir, 'abac-policy.json'), JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 });

    const pin = await runProcess(binary, ['settings', 'pin', '-deployment', deployment, '-deployment-dir', deploymentDir], { cwd: sdkRoot, env, timeoutMs: 15000 });
    if (pin.code !== 0) throw new Error(`could not pin temporary ABAC policy (exit ${pin.code}): ${pin.stderr || pin.stdout}`);
    report.policyDigest = pin.stdout.trim();
    await writeFile(path.join(runDir, 'policy-pin.json'), JSON.stringify({ digest: report.policyDigest, command: [binary, 'settings', 'pin', '-deployment', deployment, '-deployment-dir', deploymentDir], stdout: pin.stdout, stderr: pin.stderr }, null, 2) + '\n');
    initialProfile = { models: launchSettingsOnlyAtStart ? [] : [fixture.modelId ?? 'aeltum-fixture'], base_url: fixtureInfo.baseUrl, packages: ['core', 'work'], session_root: sessionDir };
    report.initialProfile = initialProfile;
    await writeFile(path.join(deploymentDir, 'settings.json'), JSON.stringify(initialProfile, null, 2) + '\n', { mode: 0o600 });

    await openSession(fixtureInfo);
    for (let index = 0; index < (scenario.steps ?? []).length; index++) {
      const step = scenario.steps[index];
      const stepResult = { index, name: step.name ?? `step-${index + 1}`, input: null, result: null, passed: true };
      report.steps.push(stepResult);
      try {
        if (step.action) {
          report.inputs.push({ at: new Date().toISOString(), action: step.action });
          stepResult.input = step.action;
          if (!session) throw new Error('action requires an open TUI session');
          const result = await session.act(step.action, { snapshot: step.snapshot ?? 'full' });
          stepResult.result = result;
          if (result.screenshot) stepResult.screenshotFullPath = session.screenshotPath(result.screenshot);
          if (result.error || !result.ok) { stepResult.passed = false; report.failures.push({ step: stepResult.name, error: result.error ?? 'TUI action failed' }); }
        } else if (step.check) {
          if (!session) throw new Error('check requires an open TUI session');
          const result = await checkTui(session, step.check.options);
          const ordered = step.check.orderedText ?? [];
          let previous = -1;
          for (const text of ordered) {
            const index = String(result.text ?? '').indexOf(text, previous + 1);
            if (index < 0) { result.passed = false; result.violations.push(`ordered transcript text missing or misplaced: ${text}`); break; }
            previous = index;
          }
          stepResult.result = result;
          if (result.screenshot) stepResult.screenshotFullPath = session.screenshotPath(result.screenshot);
          if (!result.passed) { stepResult.passed = false; report.failures.push({ step: step.check.name ?? stepResult.name, violations: result.violations }); }
        } else if (step.observe) {
          if (!session) throw new Error('observe requires an open TUI session');
          if (pendingObservations.has(step.observe.name)) throw new Error(`duplicate observation name ${step.observe.name}`);
          const promise = observeTui(session, step.observe.options);
          pendingObservations.set(step.observe.name, { promise, record: { name: step.observe.name, startedAt: new Date().toISOString() } });
          stepResult.result = { started: true, durationMs: step.observe.options.durationMs };
        } else if (step.awaitObservation) {
          const pending = pendingObservations.get(step.awaitObservation);
          if (!pending) throw new Error(`observation ${step.awaitObservation} was not started`);
          const result = await pending.promise;
          const record = { ...pending.record, completedAt: new Date().toISOString(), result };
          report.observations.push(record);
          pendingObservations.delete(step.awaitObservation);
          stepResult.result = result;
          if (result.passed !== true) { stepResult.passed = false; report.failures.push({ step: step.awaitObservation, violations: result.violations, passed: result.passed }); }
        } else if (step.waitMs !== undefined) {
          await new Promise(resolve => setTimeout(resolve, Math.min(Number(step.waitMs), 30000)));
          stepResult.result = { elapsedMs: Number(step.waitMs) };
        } else if (step.waitForFixture) {
          const result = await waitFixture(fixtureInfo.origin, state => specFixtureMatches(state, step.waitForFixture), step.waitForFixture.timeoutMs ?? 5000);
          stepResult.result = result;
          if (!result.passed) { stepResult.passed = false; report.failures.push({ step: stepResult.name, error: `fixture request did not reach expected state: ${JSON.stringify(step.waitForFixture)}` }); }
        } else if (step.ensureFixtureRequest) {
          const spec = step.ensureFixtureRequest;
          let result = await waitFixture(fixtureInfo.origin, state => state.requests.length > spec.index, spec.waitMs ?? 350);
          if (result.passed) stepResult.result = { alreadySent: true, request: result.state.requests[spec.index] };
          else {
            stepResult.result = { alreadySent: false, fallbackActions: spec.fallback ?? [] };
            for (const action of spec.fallback ?? []) {
              report.inputs.push({ at: new Date().toISOString(), action, reason: 'ensureFixtureRequest fallback' });
              const actionResult = await session.act(action, { snapshot: 'full' });
              stepResult.result.lastAction = actionResult;
              if (actionResult.error || !actionResult.ok) throw new Error(actionResult.error ?? 'fallback action failed');
            }
          }
        } else if (step.fixtureAssert) {
          const state = await fixtureState(fixtureInfo.origin);
          const failures = [];
          if (step.fixtureAssert.requestCount !== undefined && state.requests.length !== step.fixtureAssert.requestCount) failures.push(`requestCount=${state.requests.length}, expected ${step.fixtureAssert.requestCount}`);
          if (step.fixtureAssert.catalogRequestsAtLeast !== undefined && state.catalogRequests < step.fixtureAssert.catalogRequestsAtLeast) failures.push(`catalogRequests=${state.catalogRequests}, expected at least ${step.fixtureAssert.catalogRequestsAtLeast}`);
          if (step.fixtureAssert.catalogRequestsExactly !== undefined && state.catalogRequests !== step.fixtureAssert.catalogRequestsExactly) failures.push(`catalogRequests=${state.catalogRequests}, expected ${step.fixtureAssert.catalogRequestsExactly}`);
          if (step.fixtureAssert.noViolations && state.violations.length) failures.push(`fixture violations: ${state.violations.join('; ')}`);
          for (const expected of step.fixtureAssert.requests ?? []) if (!specFixtureMatches(state, expected)) failures.push(`request assertion did not match: ${JSON.stringify(expected)}`);
          stepResult.result = state;
          if (failures.length) { stepResult.passed = false; report.failures.push({ step: stepResult.name, violations: failures }); }
        } else if (step.releaseFixture) {
          const response = await fetch(`${fixtureInfo.origin}/__fixture/release?id=${encodeURIComponent(step.releaseFixture.id)}`, { method: 'POST' });
          const result = await response.json();
          stepResult.result = result;
          if (!response.ok) { stepResult.passed = false; report.failures.push({ step: stepResult.name, error: result.error?.message ?? `release returned HTTP ${response.status}` }); }
        } else if (step.reopen) {
          if (session) await session.close();
          session = null;
          await openSession(fixtureInfo);
          stepResult.result = { reopened: true, sameSessionDir: true, sessionNumber };
        } else if (step.close) {
          if (session) await session.close();
          session = null;
          stepResult.result = { closed: true };
        } else if (step.workspaceAssert || step.sessionAssert) {
          const results = [];
          const assertion = step.sessionAssert ?? step.workspaceAssert;
          const files = assertion.files ?? (assertion.path ? { [assertion.path]: assertion } : {});
          if (!Object.keys(files).length) throw new Error('file assertion must select at least one file');
          for (const [relative, expected] of Object.entries(files)) {
            const assertionRoot = step.sessionAssert ? sessionDir : workspace;
            const filename = path.resolve(assertionRoot, relative);
            if (!filename.startsWith(assertionRoot + path.sep)) throw new Error(`workspace assertion path escapes fixture root: ${relative}`);
            let contents;
            try { contents = await readFile(filename, 'utf8'); } catch { contents = null; }
            const passed = expected.exists === false ? contents === null : contents !== null &&
              (expected.contains === undefined || contents.includes(expected.contains)) &&
              (expected.equals === undefined || contents === String(expected.equals)) &&
              (expected.containsAll === undefined || expected.containsAll.every(value => contents.includes(value)));
            results.push({ path: filename, passed, expected, contents });
            if (!passed) { stepResult.passed = false; report.failures.push({ step: stepResult.name, error: `artifact file assertion failed: ${relative}` }); }
          }
          stepResult.result = results;
        } else if (step.clipboardAssert) {
          let actual;
          let source;
          const deadline = Date.now() + Math.min(5000, Number(step.clipboardAssert.timeoutMs ?? 2000));
          do {
            try { actual = await readFile(clipboard.captured, 'utf8'); source = 'redirected clipboard utility'; }
            catch { actual = await protocolClipboard(session, activeScreenDir); source = actual === null ? 'no captured clipboard operation' : 'OSC 52 terminal output'; }
            if (actual === String(step.clipboardAssert.equals ?? '') || Date.now() >= deadline) break;
            await new Promise(resolve => setTimeout(resolve, 25));
          } while (true);
          const expected = String(step.clipboardAssert.equals ?? '');
          const passed = actual === expected;
          stepResult.result = { path: clipboard.captured, source, passed, expected, actual, nativeClipboardVerified: false };
          if (!passed) { stepResult.passed = false; report.failures.push({ step: stepResult.name, error: 'captured clipboard text did not equal the exact expected source text' }); }
        } else if (step.deploymentAssert) {
          const profilePath = path.join(deploymentDir, 'settings.json');
          const profileValue = JSON.parse(await readFile(profilePath, 'utf8'));
          const differences = [];
          for (const [key, expected] of Object.entries(step.deploymentAssert.equals ?? {})) {
            if (JSON.stringify(profileValue[key]) !== JSON.stringify(expected)) differences.push(`${key}=${JSON.stringify(profileValue[key])}; expected ${JSON.stringify(expected)}`);
          }
          for (const key of step.deploymentAssert.unchanged ?? []) {
            if (JSON.stringify(profileValue[key]) !== JSON.stringify(initialProfile?.[key])) differences.push(`${key} changed from ${JSON.stringify(initialProfile?.[key])} to ${JSON.stringify(profileValue[key])}`);
          }
          for (const key of step.deploymentAssert.absent ?? []) if (Object.hasOwn(profileValue, key)) differences.push(`${key} unexpectedly persisted as ${JSON.stringify(profileValue[key])}`);
          stepResult.result = { path: profilePath, profile: profileValue, differences };
          if (differences.length) { stepResult.passed = false; report.failures.push({ step: stepResult.name, violations: differences }); }
        } else {
          throw new Error('step requires action, check, observe, awaitObservation, waitMs, waitForFixture, ensureFixtureRequest, fixtureAssert, releaseFixture, close, reopen, workspaceAssert, clipboardAssert, or deploymentAssert');
        }
      } catch (error) {
        stepResult.passed = false;
        stepResult.error = error instanceof Error ? error.message : String(error);
        report.failures.push({ step: stepResult.name, error: stepResult.error });
      }
      await writeFile(path.join(runDir, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
    }

    for (const [name, pending] of pendingObservations) {
      try {
        const result = await pending.promise;
        report.observations.push({ ...pending.record, completedAt: new Date().toISOString(), result });
        if (result.passed !== true) report.failures.push({ step: name, violations: result.violations, passed: result.passed });
      } catch (error) {
        report.failures.push({ step: name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    pendingObservations.clear();
    for (const instance of sessionInstances) await instance.close().catch(error => report.failures.push({ step: 'session-close', error: error instanceof Error ? error.message : String(error) }));
    session = null;
    try { report.fixtureState = await fixtureState(report.fixture.origin); }
    catch (error) { report.failures.push({ step: 'fixture-state', error: error instanceof Error ? error.message : String(error) }); }
    report.safety.outboundFixtureRequests = report.fixtureState?.outboundRequests ?? null;
    if (!catalogOptIn && (report.fixtureState?.catalogRequests ?? 0) !== 0) report.failures.push({ step: 'catalog-authority-safety', error: `default scenario policy reached provider catalog ${report.fixtureState.catalogRequests} time(s)` });
    for (const skill of report.source.skills ?? []) if (await sha256File(skill.path) !== skill.sha256) report.failures.push({ step: 'source-freshness', error: `bound skill changed during campaign: ${skill.name}` });
    report.workspaceFiles = await listFiles(workspace);
    const sessionFiles = await listFiles(sessionDir);
    const sessionFileInventory = path.join(runDir, 'session-files.json');
    await writeFile(sessionFileInventory, JSON.stringify(sessionFiles, null, 2) + '\n');
    report.sessionFiles = { count: sessionFiles.length, inventory: sessionFileInventory };
    report.receipts = sessionFiles.filter(item => item.path.includes('/receipts/'));
    const catalogReceiptRoot = path.join(deploymentDir, 'oe-catalog');
    const catalogReceiptFiles = await listFiles(catalogReceiptRoot);
    report.catalogReceipts = catalogReceiptFiles.filter(item => item.path.includes('/receipts/'));
    const catalogReceiptInventory = path.join(runDir, 'catalog-receipts.json');
    await writeFile(catalogReceiptInventory, JSON.stringify(catalogReceiptFiles, null, 2) + '\n');
    const tuiFiles = await listFiles(tuiOut);
    report.artifacts = [
      { kind: 'policy', path: policyFile }, { kind: 'workspace', path: workspace }, { kind: 'session', path: sessionDir },
      { kind: 'session file inventory', path: sessionFileInventory },
      { kind: 'OE provider catalog receipts', path: catalogReceiptRoot, files: report.catalogReceipts.length, inventory: catalogReceiptInventory },
      { kind: 'TUI screenshots and cell states', path: tuiOut, screenshots: tuiFiles.filter(item => item.path.endsWith('.png')).length },
      { kind: 'fixture state', path: path.join(runDir, 'fixture-state.json') }, { kind: 'fixture logs', path: path.join(runDir, 'fixture.log') },
    ];
    report.completedAt = new Date().toISOString();
    report.status = report.failures.length ? 'failed' : 'passed';
    await writeFile(path.join(runDir, 'fixture-state.json'), JSON.stringify(report.fixtureState ?? {}, null, 2) + '\n');
    await writeFile(path.join(runDir, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    report.status = 'setup-failed';
    report.failures.push({ step: 'setup', error: error instanceof Error ? error.message : String(error) });
    report.completedAt = new Date().toISOString();
    await writeFile(path.join(runDir, 'evidence.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
  } finally {
    for (const instance of sessionInstances) await instance.close().catch(() => {});
    if (fixtureChild && fixtureChild.exitCode === null) {
      fixtureChild.kill('SIGTERM');
      await new Promise(resolve => fixtureChild.once('close', resolve));
    }
    await writeFile(path.join(runDir, 'fixture.log'), JSON.stringify({ stdout: fixtureStdout, stderr: fixtureStderr }, null, 2) + '\n').catch(() => {});
  }
  process.stdout.write(JSON.stringify({
    schema: 'aeltum.tui.evidence-summary.v1', status: report.status,
    evidenceFile: path.join(runDir, 'evidence.json'), outputDir: runDir,
    binary: report.source.binary, binarySha256: report.source.binarySha256,
    sdkHead: report.source.sdkHead, uiCrawlHead: report.source.uiCrawlHead,
    fixtureRequests: report.fixtureState?.requests?.map(request => ({ id: request.id, status: request.status })) ?? [],
    outboundFixtureRequests: report.fixtureState?.outboundRequests ?? null,
    screenshotCount: report.artifacts.find(artifact => artifact.kind === 'TUI screenshots and cell states')?.screenshots ?? 0,
    receiptCount: report.receipts.length,
    failureCount: report.failures.length,
    failures: report.failures.slice(0, 30),
  }, null, 2) + '\n');
  return report.status === 'passed' ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('Usage: node tools/tui-scenario-runner.mjs --binary /path/to/aoa [--sdk /path/to/harness-sdk] [--scenario file.json] [--out dir]\n       node tools/tui-scenario-runner.mjs --self-test\n');
    return 0;
  }
  if (opts['self-test']) {
    const result = await selfTest();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.passed ? 0 : 1;
  }
  return campaign(opts);
}

main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`TUI scenario runner: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 2;
});
