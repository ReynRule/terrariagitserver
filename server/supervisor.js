'use strict';
/**
 * Terraria(바닐라) 서버 감독자
 * - 서버 실행/크래시 재시작, 마지막 활성 월드 이어서 열기
 * - 주기적 save + 백업(data 브랜치 덮어쓰기)
 * - approved 라벨이 붙은 이슈(월드 요청)를 폴링해서 처리
 * - 종료 5분 전부터 1분마다 인게임 영어 공지, 종료 시 save → 백업 → 다음 실행 dispatch
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const SERVER_DIR = path.join(ROOT, 'server-bin'); // setup.sh가 만든 바닐라 서버(Linux) 폴더 링크
const SAVE_DIR = path.join(ROOT, 'tml-data');
const WORLD_DIR = path.join(SAVE_DIR, 'Worlds');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const SERVER_CFG = path.join(ROOT, 'serverconfig.txt');

const REPO = process.env.GITHUB_REPOSITORY;
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 349);
const JOB_START_S = Number(process.env.JOB_START_S || Math.floor(Date.now() / 1000));
const END_AT = JOB_START_S * 1000 + RUN_MINUTES * 60000;
const AUTOBACKUP_MS = Number(process.env.AUTOBACKUP_MIN || 10) * 60000;
const ALLOWED = (process.env.ALLOWED_ASSOCIATIONS || 'OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR').split(',');
const POLL_MS = 30000;

const SIZE = { small: 1, medium: 2, large: 3 };
const DIFF = { classic: 0, expert: 1, master: 2, journey: 3 };
const EVIL = ['random', 'corruption', 'crimson'];

const DEFAULTS = {
  activeWorld: 'World1',
  maxPlayers: 16,
  motd: 'Welcome!',
  pendingCreate: { size: 'medium', difficulty: 'classic', evil: 'random', seed: '' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), '[sup]', ...a);

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// ---------------- config ----------------
function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}
function saveConfig(c) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}
function listWorlds() {
  try {
    return fs.readdirSync(WORLD_DIR).filter((f) => f.endsWith('.wld')).map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
}

function writeServerConfig(cfg) {
  const worldFile = path.join(WORLD_DIR, cfg.activeWorld + '.wld');
  const lines = [
    `worldpath=${WORLD_DIR}`,
    `world=${worldFile}`,
    `maxplayers=${cfg.maxPlayers}`,
    'port=7777',
    `motd=${cfg.motd}`,
    'secure=1',
    'language=en-US',
    'upnp=0',
  ];
  if (process.env.SERVER_PASSWORD) lines.push(`password=${process.env.SERVER_PASSWORD}`);
  if (!fs.existsSync(worldFile)) {
    const p = cfg.pendingCreate || DEFAULTS.pendingCreate;
    lines.push(
      `autocreate=${SIZE[p.size] || 2}`,
      `worldname=${cfg.activeWorld}`,
      `difficulty=${DIFF[p.difficulty] ?? 0}`
    );
    if (p.seed) lines.push(`seed=${p.seed}`);
    log('world file missing -> autocreate', cfg.activeWorld, JSON.stringify(p));
  }
  fs.writeFileSync(SERVER_CFG, lines.join('\n') + '\n');
}

// ---------------- processes ----------------
function cleanEnv() {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/TOKEN|SECRET|PASSWORD|^ACTIONS_/i.test(k)) delete e[k];
  return e;
}

let server = null;
let playit = null;
const outListeners = new Set();
let busy = false;
let shuttingDown = false;

function startPlayit() {
  if (!process.env.PLAYIT_SECRET) {
    log('PLAYIT_SECRET not set -> no public tunnel, players cannot connect');
    return;
  }
  playit = spawn(path.join(ROOT, 'bin', 'playit'), [], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SECRET_KEY: process.env.PLAYIT_SECRET },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  playit.on('exit', (c) => log('playit exited', c));
}

function startServer(cfg) {
  writeServerConfig(cfg);
  log('starting Terraria server, world =', cfg.activeWorld);
  const child = spawn('./TerrariaServer.bin.x86_64', ['-config', SERVER_CFG], {
    cwd: SERVER_DIR,
    env: cleanEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const onData = (d) => {
    const s = d.toString();
    process.stdout.write(s);
    for (const l of [...outListeners]) l(s);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.stdin.on('error', () => {});
  child.on('exit', (code) => {
    log('server exited', code);
    if (server === child) server = null;
  });
  server = child;
}

function cmd(c) {
  if (server && server.stdin.writable) server.stdin.write(c + '\n');
}

function waitOutput(re, ms) {
  return new Promise((res) => {
    let buf = '';
    const t = setTimeout(() => {
      outListeners.delete(l);
      res(false);
    }, ms);
    const l = (s) => {
      buf = (buf + s).slice(-4000);
      if (re.test(buf)) {
        outListeners.delete(l);
        clearTimeout(t);
        res(true);
      }
    };
    outListeners.add(l);
  });
}

function waitExit(ms) {
  return new Promise((res) => {
    const s = server;
    if (!s) return res(true);
    const t = setTimeout(() => res(false), ms);
    s.once('exit', () => {
      clearTimeout(t);
      res(true);
    });
  });
}

async function waitStarted(ms) {
  const ok = await Promise.race([waitOutput(/Server started/i, ms), waitExit(ms).then(() => false)]);
  return ok;
}

async function saveWorld() {
  if (!server) return;
  const p = waitOutput(/World saved/i, 20000);
  cmd('save');
  await p;
}

async function stopServer() {
  if (!server) return;
  const s = server;
  cmd('exit');
  if (!(await waitExit(90000))) {
    log('server did not exit, killing');
    s.kill('SIGKILL');
    await sleep(2000);
  }
  server = null;
}

function backup() {
  try {
    sh('bash', ['scripts/backup.sh'], { env: process.env });
    log('backup ok');
  } catch (e) {
    log('backup FAILED:', String(e.stderr || e.message).slice(0, 500));
  }
}

// ---------------- issues ----------------
function parseForm(body) {
  const out = {};
  for (const part of String(body || '').split(/^### /m).slice(1)) {
    const nl = part.indexOf('\n');
    if (nl < 0) continue;
    const key = part.slice(0, nl).trim();
    let val = part.slice(nl + 1).trim();
    if (val === '_No response_') val = '';
    out[key] = val;
  }
  return out;
}

function buildChange(form, cfg) {
  const next = JSON.parse(JSON.stringify(cfg));
  const action = form['Action'];
  const name = form['World name'] || '';
  const existing = listWorlds();

  const maxp = form['Max players'];
  if (maxp) {
    if (!/^\d{1,3}$/.test(maxp) || +maxp < 1 || +maxp > 255) throw new Error('Max players must be 1-255.');
    next.maxPlayers = +maxp;
  }
  const motd = form['MOTD'];
  if (motd) {
    if (!/^[A-Za-z0-9 .,!?'_-]{1,60}$/.test(motd)) throw new Error('MOTD has invalid characters or is too long.');
    next.motd = motd;
  }

  if (action === 'Update server settings') return next;

  if (!/^[A-Za-z0-9_-]{1,24}$/.test(name)) {
    throw new Error('World name must be 1-24 characters: letters, numbers, _ or -.');
  }

  if (action === 'Create new world') {
    if (existing.includes(name)) throw new Error(`World "${name}" already exists. Use "Switch to existing world".`);
    const size = (form['World size'] || 'Medium').toLowerCase();
    const difficulty = (form['Difficulty'] || 'Classic').toLowerCase();
    const evil = (form['World evil'] || 'Random').toLowerCase();
    const seed = form['Seed'] || '';
    if (!(size in SIZE)) throw new Error('Invalid world size.');
    if (!(difficulty in DIFF)) throw new Error('Invalid difficulty.');
    if (!EVIL.includes(evil)) throw new Error('Invalid world evil.');
    if (!/^[A-Za-z0-9 _-]{0,32}$/.test(seed)) throw new Error('Seed has invalid characters or is too long.');
    next.activeWorld = name;
    next.pendingCreate = { size, difficulty, evil, seed };
    return next;
  }
  if (action === 'Switch to existing world') {
    if (!existing.includes(name)) {
      throw new Error(`World "${name}" not found. Existing worlds: ${existing.join(', ') || '(none)'}`);
    }
    next.activeWorld = name;
    return next;
  }
  throw new Error('Unknown action.');
}

function listApprovedIssues() {
  // gh issue list는 author_association을 못 주므로 REST API를 직접 호출 (오래된 이슈부터)
  const out = sh('gh', [
    'api',
    `repos/${REPO}/issues?labels=approved&state=open&sort=created&direction=asc&per_page=20`,
  ]);
  return JSON.parse(out)
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body,
      authorAssociation: i.author_association,
    }));
}

function finishIssue(n, label, msg) {
  const run = (args) => {
    try {
      sh('gh', args);
    } catch (e) {
      log('gh failed:', args.slice(0, 3).join(' '), String(e.stderr || e.message).slice(0, 200));
    }
  };
  run(['issue', 'edit', String(n), '--repo', REPO, '--add-label', label]);
  run(['issue', 'comment', String(n), '--repo', REPO, '--body', msg]);
  run(['issue', 'close', String(n), '--repo', REPO]);
}

async function handleIssue(issue) {
  const n = issue.number;
  log('handling issue #' + n);
  if (!ALLOWED.includes(issue.authorAssociation)) {
    finishIssue(n, 'failed', '⛔ Author is not an allowed contributor.');
    return;
  }
  const cfg = loadConfig();
  let next;
  try {
    next = buildChange(parseForm(issue.body), cfg);
  } catch (e) {
    finishIssue(n, 'failed', `❌ Rejected: ${e.message}`);
    return;
  }

  busy = true;
  try {
    cmd(`say [World Change] Request #${n} accepted. Server restarts in 30 seconds.`);
    await sleep(30000);
    // 변경 전 백업
    await saveWorld();
    backup();

    await stopServer();
    saveConfig(next);
    startServer(next);
    const ok = await waitStarted(300000);
    if (!ok) {
      log('new config failed to start, rolling back');
      await stopServer();
      saveConfig(cfg);
      startServer(cfg);
      await waitStarted(300000);
      await saveWorld();
      backup();
      finishIssue(n, 'failed', '❌ Server failed to start with the new settings. Rolled back to the previous world/settings.');
      return;
    }
    await saveWorld();
    backup(); // 새로 만든 월드 포함 백업
    cmd('say [World Change] Done. Welcome!');
    finishIssue(n, 'done', `✅ Applied. Active world: \`${next.activeWorld}\`, max players: ${next.maxPlayers}.`);
  } finally {
    busy = false;
  }
}

// ---------------- shutdown ----------------
async function shutdown(dispatchNext) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down, dispatchNext =', dispatchNext);
  cmd('say [Server] Shutting down now. Saving world...');
  await saveWorld();
  await stopServer();
  backup();
  if (dispatchNext) {
    try {
      sh('gh', ['workflow', 'run', 'server.yml', '--repo', REPO]);
      log('next run dispatched');
    } catch (e) {
      log('dispatch FAILED (watchdog will restart):', String(e.stderr || e.message).slice(0, 300));
    }
  }
  if (playit) playit.kill();
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('got', sig);
    shutdown(false);
  });
}

// ---------------- main ----------------
(async () => {
  fs.mkdirSync(WORLD_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  startPlayit();

  const cfg = loadConfig();
  saveConfig(cfg);
  startServer(cfg);
  log('end of this run at', new Date(END_AT).toISOString());

  const sentMinutes = new Set();
  let lastPoll = 0;
  let lastBackup = Date.now();
  let crashes = 0;

  while (!shuttingDown) {
    const remaining = END_AT - Date.now();

    // 종료 5분 전부터 1분마다 공지
    const m = Math.ceil(remaining / 60000);
    if (m >= 1 && m <= 5 && !sentMinutes.has(m)) {
      sentMinutes.add(m);
      cmd(`say [Auto Restart] Server restarts in ${m} minute${m === 1 ? '' : 's'}. The world will be saved automatically. Please rejoin in about 2-3 minutes.`);
    }

    if (remaining <= 0) {
      await shutdown(true);
      return;
    }

    if (!busy) {
      // 서버가 죽었으면 재시작
      if (!server) {
        crashes++;
        log('server not running, restart attempt', crashes);
        if (crashes > 10) {
          log('too many crashes, exiting (watchdog will relaunch)');
          await shutdown(false);
          return;
        }
        await sleep(10000);
        startServer(loadConfig());
      }

      // 이슈 폴링 (종료 10분 전부터는 중단)
      if (remaining > 10 * 60000 && Date.now() - lastPoll > POLL_MS) {
        lastPoll = Date.now();
        try {
          const issues = listApprovedIssues();
          if (issues.length) await handleIssue(issues[0]);
        } catch (e) {
          log('issue poll failed:', String(e.stderr || e.message).slice(0, 200));
        }
      }

      // 주기적 저장 + 백업 (종료 7분 전부터는 중단)
      if (remaining > 7 * 60000 && Date.now() - lastBackup > AUTOBACKUP_MS) {
        lastBackup = Date.now();
        await saveWorld();
        backup();
      }
    }

    await sleep(1000);
  }
})();
