// npm test: starts a throwaway local Postgres (embedded-postgres binaries) in a temp dir on a free port,
// applies prisma/schema.prisma to it, runs the integration tests, then stops it and deletes the data.
// It never uses DATABASE_URL from .env — the tests only ever talk to this local instance.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function postgresBinaries() {
  const platform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
  const pkg = `@embedded-postgres/${platform}-${process.arch}`;
  try {
    return await import(pkg); // ESM package exporting { initdb, pg_ctl, postgres } paths
  } catch (e) {
    throw new Error(`Postgres binaries for ${process.platform}/${process.arch} not found (${pkg}). Run npm install.`);
  }
}

(async () => {
  const { initdb, pg_ctl } = await postgresBinaries();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biddex-test-'));
  const dataDir = path.join(dir, 'data');
  const pwFile = path.join(dir, 'pw.txt');
  fs.writeFileSync(pwFile, 'test');
  const dbPort = await freePort();
  const appPort = await freePort();
  let started = false;
  let code = 1;

  try {
    execFileSync(initdb, ['-D', dataDir, '-U', 'test', `--pwfile=${pwFile}`, '-A', 'md5', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' });
    execFileSync(pg_ctl, ['start', '-D', dataDir, '-o', `-p ${dbPort} -c listen_addresses=127.0.0.1`, '-l', path.join(dir, 'pg.log'), '-w', '-t', '30'], { stdio: 'ignore' });
    started = true;

    const env = {
      ...process.env,
      DATABASE_URL: `postgresql://test:test@127.0.0.1:${dbPort}/biddex_test`,
      TEST_APP_PORT: String(appPort),
    };
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], { cwd: root, env, stdio: 'ignore' });

    const run = spawnSync(process.execPath, [path.join(__dirname, 'integration.test.js')], { cwd: root, env, stdio: 'inherit' });
    code = run.status === null ? 1 : run.status;
  } catch (e) {
    console.error('Test harness failed:', e.message);
    const log = path.join(dir, 'pg.log');
    if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').split('\n').slice(-10).join('\n'));
  } finally {
    if (started) spawnSync(pg_ctl, ['stop', '-D', dataDir, '-m', 'fast'], { stdio: 'ignore' });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(code);
})();
