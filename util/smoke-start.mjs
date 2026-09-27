// Starts each production entry point from the built dist/ output and checks
// that it answers. Run `npm run build` first. Uses NODE_ENV=test unless
// NODE_ENV is already set, so it targets the test database by default.
// Set SMOKE_VERBOSE=1 to print each process's output on success too.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
const POLL_INTERVAL_MS = 250;
const WEB_URL = 'http://127.0.0.1:3000/';
const MCP_HTTP_URL = 'http://127.0.0.1:3333/mcp';
const DB_INIT_FAILURE = 'Failed to initialize PostgreSQL DAL';

const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'test',
  DEBUG: process.env.DEBUG ?? 'agpwiki:*',
};

class SmokeFailure extends Error {}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function start(name, entry, { stdin = 'ignore' } = {}) {
  const file = path.join(root, entry);
  if (!existsSync(file)) {
    throw new SmokeFailure(`${name}: ${entry} not found; run \`npm run build\` first.`);
  }
  const child = spawn(process.execPath, [file], {
    cwd: root,
    env,
    stdio: [stdin, 'pipe', 'pipe'],
  });
  const proc = { name, child, output: '', exit: null };
  child.stdout.on('data', chunk => {
    proc.output += chunk;
  });
  child.stderr.on('data', chunk => {
    proc.output += chunk;
  });
  proc.exited = new Promise(resolve => {
    child.on('close', (code, signal) => {
      proc.exit = { code, signal };
      resolve();
    });
    child.on('error', error => {
      proc.output += `\n[spawn error] ${error.message}\n`;
      proc.exit ??= { code: null, signal: null };
      resolve();
    });
  });
  return proc;
}

function assertAlive(proc) {
  if (proc.exit) {
    const { code, signal } = proc.exit;
    throw new SmokeFailure(
      `${proc.name} exited early (code ${code}, signal ${signal}) before answering.`
    );
  }
  if (proc.output.includes(DB_INIT_FAILURE)) {
    throw new SmokeFailure(`${proc.name} failed to initialize the database.`);
  }
}

async function pollHttp(proc, url, init, accept) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    assertAlive(proc);
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
      const body = await res.text();
      assertAlive(proc);
      if (accept(res)) {
        return `${res.status} ${res.statusText}`;
      }
      lastError = `unexpected response ${res.status}: ${body.slice(0, 200)}`;
    } catch (error) {
      if (error instanceof SmokeFailure) throw error;
      lastError = error.cause?.code ?? error.message;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new SmokeFailure(
    `${proc.name} did not answer ${url} within ${TIMEOUT_MS} ms (last: ${lastError}).`
  );
}

async function checkWeb(proc) {
  const status = await pollHttp(proc, WEB_URL, {}, res => res.status < 500);
  return `GET / → ${status}`;
}

// An invalid bearer token makes the auth middleware initialize the database
// before rejecting the request, so this server takes part in migrations
// alongside the web server without needing a real token.
async function checkMcpHttp(proc) {
  const status = await pollHttp(
    proc,
    MCP_HTTP_URL,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer smoke-test-invalid-token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{}',
    },
    () => true
  );
  // The auth failure is only logged after database initialization settles.
  await sleep(POLL_INTERVAL_MS);
  assertAlive(proc);
  return `POST /mcp → ${status}`;
}

async function checkMcpStdio(proc) {
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agpwiki-smoke-start', version: '1.0.0' },
    },
  };
  let stdout = '';
  const response = new Promise((resolve, reject) => {
    proc.child.stdout.on('data', chunk => {
      stdout += chunk;
      for (const line of stdout.split('\n').slice(0, -1)) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== request.id) continue;
        if (message.error || !message.result?.serverInfo || !message.result?.protocolVersion) {
          reject(new SmokeFailure(`${proc.name} returned an invalid initialize response: ${line}`));
        } else {
          resolve(message.result);
        }
      }
    });
  });
  proc.child.stdin.write(`${JSON.stringify(request)}\n`);

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new SmokeFailure(
            `${proc.name} did not answer initialize within ${TIMEOUT_MS} ms.`
          )
        ),
      TIMEOUT_MS
    );
  });
  const earlyExit = proc.exited.then(() => assertAlive(proc));
  try {
    const result = await Promise.race([response, timeout, earlyExit]);
    const { name, version } = result.serverInfo;
    return `initialize → ${name} ${version} (protocol ${result.protocolVersion})`;
  } finally {
    clearTimeout(timer);
  }
}

async function stop(proc) {
  if (proc.exit) return;
  proc.child.kill('SIGTERM');
  const killed = await Promise.race([proc.exited.then(() => true), sleep(5_000)]);
  if (!killed) {
    proc.child.kill('SIGKILL');
    await proc.exited;
  }
}

const checks = [
  { name: 'web', entry: 'dist/src/index.js', check: checkWeb },
  { name: 'mcp-http', entry: 'dist/src/mcp/http.js', check: checkMcpHttp },
  { name: 'mcp-stdio', entry: 'dist/src/mcp/stdio.js', check: checkMcpStdio, stdin: 'pipe' },
];

const procs = [];
const stopAll = () => Promise.all(procs.map(stop));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopAll().finally(() => process.exit(1));
  });
}

let failed = false;
try {
  // Web and MCP HTTP start together so that, against a fresh database, both
  // race to run migrations and exercise the migration advisory lock.
  for (const { name, entry, stdin } of checks) {
    procs.push(start(name, entry, { stdin }));
  }
  const results = await Promise.allSettled(
    checks.map(({ check }, index) => check(procs[index]))
  );
  results.forEach((result, index) => {
    const { name } = procs[index];
    if (result.status === 'fulfilled') {
      console.log(`ok   ${name}: ${result.value}`);
    } else {
      failed = true;
      const reason = result.reason;
      const message = reason instanceof SmokeFailure ? reason.message : reason?.stack;
      console.error(`FAIL ${name}: ${message}`);
    }
  });
} catch (error) {
  failed = true;
  console.error(`FAIL ${error instanceof SmokeFailure ? error.message : error?.stack}`);
} finally {
  await stopAll();
}

if (failed || process.env.SMOKE_VERBOSE === '1') {
  for (const { name, output } of procs) {
    console.error(`\n----- ${name} output -----\n${output.trimEnd() || '(no output)'}`);
  }
}
if (failed) {
  process.exit(1);
}
console.log('All production entry points started.');
