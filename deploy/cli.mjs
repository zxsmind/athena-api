#!/usr/bin/env node
import { render as inkRender, Box, Text, useApp, useInput } from 'ink';
import { Select, TextInput, ConfirmInput, Spinner, StatusMessage, ThemeProvider, defaultTheme } from '@inkjs/ui';
import htm from 'htm';
import { createElement as h, useState, useEffect, useCallback, useRef } from 'react';
import { loadConfig, saveConfig, formatDuration } from './lib/utils.mjs';
import { DeployEngine } from './lib/engine.mjs';
import { program } from 'commander';
import { resolve } from 'path';

const html = htm.bind(h);

// ── Theme ──

const theme = {
  ...defaultTheme,
  colors: {
    ...defaultTheme.colors,
    accent: '#4FC3F7',
    success: '#81C784',
    error: '#E57373',
    warning: '#FFD54F',
  },
};

// ── Simple components ──

function Header({ title }) {
  return html`
    <${Box} flexDirection="column" marginBottom=${1}>
      <${Text} color="#4FC3F7" bold>${title}<//>
      <${Text} color="gray">${'\u2500'.repeat(46)}<//>
    <//>
  `;
}

function KV({ label, value }) {
  return html`
    <${Box}>
      <${Text} color="#4FC3F7">${(label + ''.padEnd(16)).slice(0, 16)}<//>
      <${Text}| <//>
      <${Text} color="gray">${value}<//>
    <//>
  `;
}

function LogLine({ entry }) {
  const symbols = { ok: '\u2713', fail: '\u2717', warn: '\u26A0', info: '\u203A', dim: '\u00B7' };
  const colors = { ok: 'green', fail: 'red', warn: 'yellow', info: 'cyan', dim: 'gray' };
  const sym = symbols[entry.type] || ' ';
  const color = colors[entry.type] || 'white';
  return html`
    <${Box}>
      <${Text} color=${color} bold>${sym}<//>
      <${Text}>  <//>
      <${Text} color=${entry.type === 'dim' ? 'gray' : undefined} dim=${entry.type === 'dim'}>${entry.msg}<//>
    <//>
  `;
}

function LogList({ logs }) {
  return html`
    <${Box} flexDirection="column">
      ${logs.map((entry, i) => html`<${LogLine} key=${i} entry=${entry} />`)}
    <//>
  `;
}

function Steps({ steps, currentIndex }) {
  return html`
    <${Box} flexDirection="column" marginY=${1}>
      ${steps.map((step, i) => {
        const status = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'pending';
        const symbol = status === 'done' ? '\u2713' : status === 'current' ? '\u25CB' : '\u00B7';
        const color = status === 'done' ? 'green' : status === 'current' ? 'cyan' : 'gray';
        return html`<${Box} key=${i}>
          <${Text} color=${color} bold>${symbol}<//>
          <${Text}>  <//>
          <${Text} color=${status === 'pending' ? 'gray' : undefined} dim=${status === 'pending'}>${step}<//>
        <//>`;
      })}
    <//>
  `;
}

// ── Scene: Main Menu ──

function MainMenu({ onSelect }) {
  const options = [
    { label: 'Init Server', value: 'init' },
    { label: 'Deploy', value: 'deploy' },
    { label: 'Status', value: 'status' },
    { label: 'Logs', value: 'logs' },
    { label: 'Rollback', value: 'rollback' },
    { label: 'Doctor', value: 'doctor' },
    { label: 'Config', value: 'config' },
    { label: 'Exit', value: 'exit' },
  ];
  return html`
    <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
      <${Header} title="ATHENA DEPLOY" />
      <${Select} options=${options} onSelect=${(item) => onSelect(item.value)} />
    <//>
  `;
}

// ── Scene: Form (text input steps) ──

function FormScene({ fields, onComplete, onCancel }) {
  const [idx, setIdx] = useState(0);
  const [values, setValues] = useState({});
  useInput(useCallback((input, key) => {
    if (key.escape) onCancel();
  }, [onCancel]));

  if (idx >= fields.length) {
    onComplete(values);
    return null;
  }
  const field = fields[idx];
  return html`
    <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
      <${Header} title=${fields.title || 'INPUT'} />
      <${Box} marginY=${1}>
        <${Text} color="#4FC3F7" bold>${field.label}<//>
        <${Text}>: <//>
        <${TextInput} defaultValue=${values[field.key] || field.default || ''} onSubmit=${(v) => {
          const newValues = { ...values, [field.key]: v };
          setValues(newValues);
          setIdx(idx + 1);
        }} />
      <//>
      <${Text} color="gray" dim>${idx + 1 + '/' + fields.length}<//>
    <//>
  `;
}

// ── Scene: Deploy ──

function DeployScene({ onDone }) {
  const { exit } = useApp();
  const [phase, setPhase] = useState('confirm');
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const addLog = useCallback((e) => setLogs(prev => [...prev, e]), []);
  useInput(useCallback((input, key) => {
    if (key.escape && (phase === 'done' || phase === 'error')) onDone();
  }, [phase, onDone]));

  useEffect(() => {
    if (phase !== 'running') return;
    let cancelled = false;

    async function run() {
      const config = loadConfig();
      const engine = new DeployEngine(config);
      const startTime = Date.now();

      try {
        addLog({ type: 'info', msg: 'Git state' });
        let dirty = false;
        try {
          const { execSync } = await import('child_process');
          const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
          const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
          dirty = !!execSync('git status --porcelain', { encoding: 'utf8' }).trim();
          addLog({ type: 'ok', msg: branch + ' @ ' + commit });
        } catch {
          addLog({ type: 'warn', msg: 'Not a git repo' });
        }
        if (dirty) {
          addLog({ type: 'warn', msg: 'Uncommitted changes – continuing anyway' });
        }

        addLog({ type: 'info', msg: 'SSH connection' });
        if (!(await engine.testConnection())) throw Error('Connection failed');
        addLog({ type: 'ok', msg: 'Connected' });

        addLog({ type: 'info', msg: 'Indexing files' });
        const projectDir = resolve(import.meta.dirname, '..');
        const localMani = engine.createManifest(projectDir);
        addLog({ type: 'ok', msg: Object.keys(localMani.files).length + ' files' });

        const remoteMani = await engine.fetchRemoteManifest();
        const changed = engine.compareManifests(localMani, remoteMani);

        if (changed.length === 0) {
          addLog({ type: 'dim', msg: 'No changes since last deploy' });
        } else {
          addLog({ type: 'info', msg: changed.length + ' file(s) changed' });
        }

        const version = 'v' + startTime;
        const rd = config.remotePath + '/releases/' + version;

        if (changed.length > 0) {
          addLog({ type: 'info', msg: 'Transferring ' + changed.length + ' files' });
          await engine.ssh('', 'mkdir -p "' + rd + '"');
          const tmp = resolve(process.env.TEMP || '/tmp', 'df-' + startTime + '.txt');
          const { writeFileSync: wf, unlinkSync } = await import('fs');
          wf(tmp, changed.join('\n'));
          const { spawn } = await import('child_process');
          const code = await new Promise(r => {
            const tar = spawn('tar', ['czf', '-', '--no-recursion', '--files-from', tmp], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
            const ssh = spawn('ssh', [...engine.sshArgs(), config.host, 'cd "' + rd + '" && tar xzf -'], { stdio: ['pipe', 'inherit', 'inherit'] });
            tar.stdout.pipe(ssh.stdin);
            ssh.on('close', c => { try { unlinkSync(tmp); } catch {} r(c); });
          });
          if (code !== 0) throw Error('Transfer failed');
          addLog({ type: 'ok', msg: 'Transferred' });
        }

        addLog({ type: 'info', msg: 'Build: smart-routing-core' });
        await engine.ssh('', 'cd ' + rd + '/smart-routing-core 2>/dev/null && npm install && npm run build 2>&1 || true');
        addLog({ type: 'ok', msg: 'smart-routing-core' });

        addLog({ type: 'info', msg: 'Build: server' });
        await engine.ssh('', 'cd ' + rd + '/server && npm install && npm run build 2>&1 || true');
        const srvOk = (await engine.ssh('', 'test -f ' + rd + '/server/dist/index.js && echo ok')).trim() === 'ok';
        if (!srvOk) throw Error('Server build failed');
        addLog({ type: 'ok', msg: 'server' });

        addLog({ type: 'info', msg: 'Build: frontend' });
        await engine.ssh('', 'cd ' + rd + ' && npm install && npm run build 2>&1 || true');
        const feOk = (await engine.ssh('', 'test -d ' + rd + '/dist && echo ok')).trim() === 'ok';
        if (!feOk) throw Error('Frontend build failed');
        addLog({ type: 'ok', msg: 'frontend' });

        addLog({ type: 'info', msg: 'Production deps' });
        await engine.ssh('', 'cd ' + rd + '/server && npm install --production 2>&1');
        addLog({ type: 'ok', msg: 'deps installed' });

        addLog({ type: 'info', msg: 'Symlink swap' });
        await engine.swapRelease(version);
        addLog({ type: 'ok', msg: version });

        addLog({ type: 'info', msg: 'PM2 reload' });
        await engine.reloadService();
        await new Promise(r => setTimeout(r, 1500));
        addLog({ type: 'ok', msg: 'PM2 reloaded' });

        const retries = config.healthCheck?.retries || 5;
        addLog({ type: 'info', msg: 'Health check' });
        const health = await engine.healthCheck(config.host, config.appPort, retries);
        if (!health.ok) {
          addLog({ type: 'fail', msg: 'Health check failed' });
          addLog({ type: 'warn', msg: 'Rolling back' });
          await engine.rollback();
          throw Error('Rolled back');
        }
        addLog({ type: 'ok', msg: 'HTTP 200 (attempt ' + health.attempt + ')' });

        addLog({ type: 'info', msg: 'Saving manifest' });
        await engine.uploadManifest(localMani);
        addLog({ type: 'ok', msg: 'manifest saved' });

        setResult({ version, changed: changed.length, duration: Date.now() - startTime });
        setPhase('done');
      } catch (err) {
        addLog({ type: 'fail', msg: err.message || String(err) });
        setPhase('error');
      }
    }

    run();
    return () => { cancelled = true; };
  }, [phase]);

  if (phase === 'confirm') {
    return html`
      <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
        <${Header} title="DEPLOY" />
        <${Box} marginY=${1}>
          <${Text}>Proceed with deployment? <//>
          <${ConfirmInput} defaultValue=${true} onSubmit=${(v) => v ? setPhase('running') : onDone()} />
        <//>
      <//>
    `;
  }

  if (phase === 'done' && result) {
    return html`
      <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
        <${Header} title="RESULT" />
        <${LogList} logs=${logs} />
        <${Box} marginY=${1}>
          <${StatusMessage} variant="success">Deploy complete \u2014 ${formatDuration(result.duration)}<//>
        <//>
        <${KV} label="Version" value=${result.version} />
        <${KV} label="Files" value=${result.changed + ' changed'} />
        <${KV} label="Health" value=${'\u2713 OK'} />
        <${Box} marginY=${1}>
          <${Text} color="gray" dim>Esc to return<//>
        <//>
      <//>
    `;
  }

  return html`
    <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
      <${Header} title="DEPLOY" />
      <${LogList} logs=${logs} />
      ${phase === 'error' ? html`<${Box} marginY=${1}><${StatusMessage} variant="error">Failed<//><//>` : null}
    <//>
  `;
}

// ── Scene: Init ──

function InitScene({ onDone }) {
  const [phase, setPhase] = useState('form');
  const [cfg, setCfg] = useState(loadConfig());
  const [vals, setVals] = useState({});
  const [fieldIdx, setFieldIdx] = useState(0);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const addLog = useCallback((e) => setLogs(prev => [...prev, e]), []);
  useInput(useCallback((input, key) => {
    if (key.escape && (phase === 'done' || phase === 'error')) onDone();
  }, [phase, onDone]));

  const fields = [
    { key: 'host', label: 'Remote host', default: cfg.host || 'ubuntu@' },
    { key: 'port', label: 'SSH port', default: String(cfg.port || 22) },
    { key: 'remotePath', label: 'Remote path', default: cfg.remotePath || '/opt/athena' },
    { key: 'sshKey', label: 'SSH key (empty = default)', default: cfg.sshKey || '' },
  ];

  function handleSubmit(value) {
    const key = fields[fieldIdx].key;
    const newVals = { ...vals, [key]: value };
    setVals(newVals);
    if (fieldIdx < fields.length - 1) {
      setFieldIdx(fieldIdx + 1);
    } else {
      const newCfg = {
        ...cfg,
        host: newVals.host,
        port: parseInt(newVals.port, 10) || 22,
        remotePath: newVals.remotePath,
        sshKey: newVals.sshKey,
      };
      saveConfig(newCfg);
      setPhase('running');
    }
  }

  useEffect(() => {
    if (phase !== 'running') return;
    async function run() {
      const config = loadConfig();
      const engine = new DeployEngine(config);
      try {
        addLog({ type: 'info', msg: 'SSH connection' });
        if (!(await engine.testConnection())) throw Error('Connection failed');
        addLog({ type: 'ok', msg: 'Connected' });

        const info = await engine.gatherRemoteInfo();
        addLog({ type: 'info', msg: info.os + ' \u00B7 ' + info.ram + ' \u00B7 Node ' + info.nodeVersion + ' \u00B7 PM2 ' + info.pm2Version });

        addLog({ type: 'info', msg: 'Node.js ' + config.nodeVersion + '.x' });
        const nr = await engine.setupNode(config.nodeVersion);
        addLog({ type: 'ok', msg: nr.upgraded ? 'Upgraded to ' + nr.version : 'Already at ' + nr.version });

        addLog({ type: 'info', msg: 'PM2' });
        const pr = await engine.setupPM2();
        addLog({ type: 'ok', msg: pr.installed ? 'Installed ' + pr.version : 'Already installed ' + pr.version });

        addLog({ type: 'info', msg: 'Directories' });
        await engine.ensureDirs();
        addLog({ type: 'ok', msg: config.remotePath + '/releases' });

        setPhase('done');
      } catch (err) {
        addLog({ type: 'fail', msg: err.message });
        setError(err.message);
        setPhase('error');
      }
    }
    run();
  }, [phase]);

  if (phase === 'form') {
    const field = fields[fieldIdx];
    return html`
      <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
        <${Header} title="INIT \u2014 Setup" />
        <${Box} marginY=${1}>
          <${Text} color="#4FC3F7" bold>${field.label}<//>
          <${Text}>: <//>
          <${TextInput} defaultValue=${field.default} onSubmit=${handleSubmit} />
        <//>
        <${Text} color="gray" dim>${fieldIdx + 1 + '/' + fields.length}<//>
      <//>
    `;
  }

  if (phase === 'done') {
    return html`
      <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
        <${Header} title="INIT" />
        <${LogList} logs=${logs} />
        <${Box} marginY=${1}>
          <${StatusMessage} variant="success">Init complete<//>
        <//>
        <${Text} color="gray" dim>Esc to return<//>
      <//>
    `;
  }

  return html`
    <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
      <${Header} title="INIT" />
      <${LogList} logs=${logs} />
      ${phase === 'error' ? html`<${Box} marginY=${1}><${StatusMessage} variant="error">${error}<//><//>` : null}
    <//>
  `;
}

// ── Scene: Status ──

function StatusScene({ onDone }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  useInput(useCallback((input, key) => {
    if (key.escape) onDone();
  }, [onDone]));

  useEffect(() => {
    async function run() {
      const config = loadConfig();
      if (!config.host) { setError('No host configured'); setLoading(false); return; }
      const engine = new DeployEngine(config);
      try {
        const pm2 = await engine.ssh('', 'pm2 show athena 2>/dev/null || echo "PM2: not found"');
        let disk = '';
        let relInfo = '';
        try { disk = (await engine.ssh('', 'df -h ' + config.remotePath + ' | tail -1')).trim(); } catch {}
        try {
          const n = (await engine.ssh('', 'ls -1d ' + config.remotePath + '/releases/*/ 2>/dev/null | wc -l')).trim();
          const c = (await engine.ssh('', 'readlink ' + config.remotePath + '/current 2>/dev/null || echo "-"')).trim().split('/').pop();
          relInfo = n + ' \u00B7 current: ' + c;
        } catch {}
        setData({ pm2, disk, relInfo });
      } catch (err) {
        setError(err.message);
      }
      setLoading(false);
    }
    run();
  }, []);

  if (loading) {
    return html`<${Box} paddingX=${2} paddingY=${1}><${Header} title="STATUS" /><${Spinner} label="Fetching..." /><//>`;
  }
  if (error) {
    return html`<${Box} paddingX=${2} paddingY=${1}><${Header} title="STATUS" /><${StatusMessage} variant="error">${error}<//><${Box} marginTop=${1}><${Text} color="gray" dim>Esc to return<//><//><//>`;
  }
  const pm2Lines = (data.pm2 || '').split('\n').filter(l => l.trim());
  return html`
    <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
      <${Header} title="STATUS" />
      <${Box} flexDirection="column" marginTop=${1}>
        ${pm2Lines.map((ln, i) => html`<${Box} key=${i}><${Text} color="gray" dim>${ln.trimRight()}<//><//>`)}
      <//>
      ${data.disk ? html`<${KV} label="Disk" value=${data.disk} />` : null}
      ${data.relInfo ? html`<${KV} label="Releases" value=${data.relInfo} />` : null}
      <${Box} marginTop=${1}><${Text} color="gray" dim>Esc to return<//><//>
    <//>
  `;
}

// ── Scene: Config ──

function ConfigScene({ onDone }) {
  useInput(useCallback((input, key) => {
    if (key.escape) onDone();
  }, [onDone]));
  const config = loadConfig();
  const entries = Object.entries(config);
  return html`
    <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
      <${Header} title="CONFIG" />
      <${Box} flexDirection="column" marginTop=${1}>
        ${entries.map(([k, v]) => {
          const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
          return html`<${Box} key=${k}>
            <${Text} color="#4FC3F7">${(k + '', '').padEnd(18).slice(0, 18)}<//>
            <${Text} color="gray" dim>${val}<//>
          <//>`;
        })}
      <//>
      <${Box} marginTop=${1}><${Text} color="gray" dim>Esc to return<//><//>
    <//>
  `;
}

// ── Scene: Doctor ──

function DoctorScene({ onDone }) {
  const [logs, setLogs] = useState([]);
  const [done, setDone] = useState(false);
  const addLog = useCallback((e) => setLogs(prev => [...prev, e]), []);
  useInput(useCallback((input, key) => {
    if (key.escape && done) onDone();
  }, [done, onDone]));

  useEffect(() => {
    async function run() {
      const config = loadConfig();
      if (!config.host) { addLog({ type: 'fail', msg: 'No host' }); setDone(true); return; }
      const engine = new DeployEngine(config);
      const checks = [
        ['SSH connection', async () => { if (!(await engine.testConnection())) throw Error('Failed'); }],
        ['Remote info', async () => {
          const i = await engine.gatherRemoteInfo();
          return i.os + ' \u00B7 ' + i.ram + ' \u00B7 Node ' + i.nodeVersion + ' \u00B7 PM2 ' + i.pm2Version;
        }],
        ['Remote path', async () => {
          const o = await engine.ssh('', 'test -d ' + config.remotePath + ' && echo ok');
          if (o.trim() !== 'ok') throw Error('Missing');
        }],
        ['PM2 process', async () => {
          const o = await engine.ssh('', 'pm2 list 2>/dev/null | grep -c athena || echo 0');
          if (o.trim() === '0') throw Error('Not running');
        }],
        ['Disk space', async () => { return (await engine.ssh('', 'df -h ' + config.remotePath + ' | tail -1')).trim(); }],
      ];
      for (const [name, fn] of checks) {
        addLog({ type: 'info', msg: name });
        try { const r = await fn(); addLog({ type: 'ok', msg: r || 'OK' }); }
        catch (err) { addLog({ type: 'fail', msg: err.message }); }
      }
      setDone(true);
    }
    run();
  }, []);

  return html`
    <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
      <${Header} title="DIAGNOSTICS" />
      <${LogList} logs=${logs} />
      ${done ? html`<${Box} marginTop=${1}><${Text} color="gray" dim>Esc to return<//><//>` : null}
    <//>
  `;
}

// ── Scene: Logs ──

function LogsScene({ onDone }) {
  const [output, setOutput] = useState([]);
  useInput(useCallback((input, key) => { if (key.escape || input === 'q') onDone(); }, [onDone]));

  useEffect(() => {
    async function run() {
      const config = loadConfig();
      if (!config.host) { setOutput(['No host configured']); return; }
      const engine = new DeployEngine(config);
      try {
        await engine.sshStream('',
          'pm2 logs athena --lines 50 --nostream 2>&1 || journalctl -u athena -n 50 --no-pager 2>&1 || echo "No logs"',
          (d) => {
            const text = d.toString();
            setOutput(prev => [...prev, ...text.split('\n').filter(l => l !== '')]);
          }
        );
      } catch (err) {
        setOutput(prev => [...prev, err.message]);
      }
    }
    run();
  }, []);

  return html`
    <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
      <${Header} title="LOGS" />
      <${Text} color="gray" dim>Q or Esc to return<//>
      <${Box} marginTop=${1} flexDirection="column">
        ${output.slice(-15).map((ln, i) => html`<${Box} key=${i}><${Text} color="gray" dim>${ln}<//><//>`)}
      <//>
    <//>
  `;
}

// ── Scene: Rollback ──

function RollbackScene({ onDone }) {
  const [phase, setPhase] = useState('list');
  const [releases, setReleases] = useState([]);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const addLog = useCallback((e) => setLogs(prev => [...prev, e]), []);
  useInput(useCallback((input, key) => {
    if (key.escape && (phase === 'done' || phase === 'error')) onDone();
  }, [phase, onDone]));

  useEffect(() => {
    if (phase !== 'list') return;
    async function run() {
      const config = loadConfig();
      const engine = new DeployEngine(config);
      try {
        const out = await engine.ssh('', 'ls -1d ' + config.remotePath + '/releases/*/ 2>/dev/null | sort -r');
        const rels = out.trim().split('\n').filter(Boolean).map((r, i) => ({
          label: r.split('/').filter(Boolean).pop() + (i === 0 ? ' (current)' : ''),
          value: r.split('/').filter(Boolean).pop(),
        }));
        if (rels.length < 2) { setError('Not enough releases'); setPhase('error'); return; }
        setReleases(rels);
      } catch (err) { setError(err.message); setPhase('error'); }
    }
    run();
  }, [phase]);

  function onSel(item) {
    setPhase('confirm');
  }

  if (phase === 'list') {
    return html`
      <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
        <${Header} title="ROLLBACK" />
        <${Text} color="gray" dim>Select release to rollback to:<//>
        <${Box} marginTop=${1}>
          <${Select} options=${releases} onSelect=${onSel} />
        <//>
      <//>
    `;
  }

  return html`
    <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
      <${Header} title="ROLLBACK" />
      <${LogList} logs=${logs} />
      ${error ? html`<${StatusMessage} variant="error">${error}<//>` : null}
    <//>
  `;
}

// ── App ──

function App() {
  const { exit } = useApp();
  const [scene, setScene] = useState('menu');

  function go(s) { setScene(s); }
  function back() { setScene('menu'); }

  if (scene === 'menu') {
    return html`<${MainMenu} onSelect=${(v) => v === 'exit' ? exit() : go(v)} />`;
  }
  if (scene === 'init') return html`<${InitScene} onDone=${back} />`;
  if (scene === 'deploy') return html`<${DeployScene} onDone=${back} />`;
  if (scene === 'status') return html`<${StatusScene} onDone=${back} />`;
  if (scene === 'logs') return html`<${LogsScene} onDone=${back} />`;
  if (scene === 'rollback') return html`<${RollbackScene} onDone=${back} />`;
  if (scene === 'doctor') return html`<${DoctorScene} onDone=${back} />`;
  if (scene === 'config') return html`<${ConfigScene} onDone=${back} />`;
  return null;
}

// ── Commander ──

program.name('athena-deploy').description('ATHENA-001 deployment tool').version('1.0.0');

program.command('init').option('--host <host>', 'Remote host').action(async (opts) => {
  const config = loadConfig();
  if (opts.host) config.host = opts.host;
  saveConfig(config);
  const { waitUntilExit } = inkRender(html`<${ThemeProvider} theme=${theme}><${InitScene} onDone=${() => process.exit(0)} /><//>`);
  await waitUntilExit();
});
program.command('deploy').action(async () => {
  const { waitUntilExit } = inkRender(html`<${ThemeProvider} theme=${theme}><${DeployScene} onDone=${() => process.exit(0)} /><//>`);
  await waitUntilExit();
});
program.command('status').action(async () => {
  const { waitUntilExit } = inkRender(html`<${ThemeProvider} theme=${theme}><${StatusScene} onDone=${() => process.exit(0)} /><//>`);
  await waitUntilExit();
});
program.command('logs').option('-n, --lines <count>', 'Line count', '50').option('-f, --follow', 'Follow mode').action(async () => {
  const { waitUntilExit } = inkRender(html`<${ThemeProvider} theme=${theme}><${LogsScene} onDone=${() => process.exit(0)} /><//>`);
  await waitUntilExit();
});
program.command('rollback').argument('[steps]', 'Steps', '1').action(async () => {
  const { waitUntilExit } = inkRender(html`<${ThemeProvider} theme=${theme}><${RollbackScene} onDone=${() => process.exit(0)} /><//>`);
  await waitUntilExit();
});
program.command('doctor').action(async () => {
  const { waitUntilExit } = inkRender(html`<${ThemeProvider} theme=${theme}><${DoctorScene} onDone=${() => process.exit(0)} /><//>`);
  await waitUntilExit();
});
program.command('config').option('--show', 'Show config').option('--set <k=v>', 'Set value').action(async (opts) => {
  if (opts.set) {
    const eq = opts.set.indexOf('=');
    if (eq === -1) { console.error('Use --set key=value'); process.exit(1); }
    const config = loadConfig();
    const k = opts.set.slice(0, eq);
    const v = opts.set.slice(eq + 1);
    config[k] = isNaN(parseFloat(v)) ? v : parseFloat(v);
    saveConfig(config);
    console.log('\u2713 ' + k + ' = ' + config[k]);
    return;
  }
  const { waitUntilExit } = inkRender(html`<${ThemeProvider} theme=${theme}><${ConfigScene} onDone=${() => process.exit(0)} /><//>`);
  await waitUntilExit();
});

// ── Entry ──

if (process.argv.length <= 2 || process.argv[2] === 'tui' || process.argv[2] === '--interactive') {
  const { waitUntilExit } = inkRender(html`<${ThemeProvider} theme=${theme}><${App} /><//>`);
  await waitUntilExit();
} else {
  program.parse();
}
