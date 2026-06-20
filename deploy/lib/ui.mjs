import { C, ESC, BOX, repeat, pad, spinnerFrame, formatBytes, formatDuration } from './utils.mjs';
import { createInterface } from 'readline';
import EventEmitter from 'events';

const TERM_WIDTH = process.stdout.columns || 80;

export class TerminalUI extends EventEmitter {
  constructor() {
    super();
    this.spinnerInterval = null;
    this.spinnerIdx = 0;
    this.rawMode = false;
  }

  clear() {
    process.stdout.write(ESC.clear);
  }

  // ── Colored helpers ──

  status(label, type = 'info') {
    const color = { info: C.blue, success: C.green, warn: C.yellow, error: C.red, dim: C.gray }[type] || C.white;
    const icon = { info: 'ℹ', success: '✓', warn: '⚠', error: '✘', dim: '∙' }[type] || ' ';
    process.stdout.write(` ${color}${icon}${C.reset}  ${label}\n`);
  }

  detail(label) {
    process.stdout.write(`   ${C.gray}${label}${C.reset}\n`);
  }

  section(title) {
    process.stdout.write(`\n ${C.bold}${C.cyan}══ ${title} ══${C.reset}\n\n`);
  }

  header(title, subtitle = '') {
    const w = Math.min(TERM_WIDTH - 4, 60);
    const t = ` ⎇  ${title} `;
    const s = subtitle ? `\n ${C.gray}${subtitle}${C.reset}` : '';
    process.stdout.write(
      ` ${BOX.tl2}${BOX.hd.repeat(w)}${BOX.tr2}\n` +
      ` ${BOX.vd}${C.bold}${C.magenta}${t}${' '.repeat(Math.max(0, w - t.length + 4))}${C.reset}${BOX.vd}\n` +
      ` ${BOX.vd}${C.gray}${repeat('─', w)}${C.reset}${BOX.vd}\n` +
      ` ${BOX.vd}${s}${' '.repeat(Math.max(0, w))}${BOX.vd}\n` +
      ` ${BOX.bl2}${BOX.hd.repeat(w)}${BOX.br2}\n`
    );
  }

  // ── Box drawing ──

  box(title, contentLines, width) {
    const w = Math.min(width || (TERM_WIDTH - 4), TERM_WIDTH - 4, 72);
    const titleStr = title ? ` ${C.bold}${title}${C.reset} ` : '';
    process.stdout.write(` ${BOX.tl}${BOX.hd.repeat(w)}${BOX.tr}\n`);
    if (titleStr) {
      process.stdout.write(` ${BOX.v} ${titleStr}${' '.repeat(Math.max(0, w - title.replace(/\x1b\[\d+m/g, '').length - 1))}${BOX.v}\n`);
      process.stdout.write(` ${BOX.v}${C.gray}${repeat('─', w)}${C.reset}${BOX.v}\n`);
    }
    for (const line of contentLines) {
      const visible = line.replace(/\x1b\[\d+m/g, '').length;
      const padding = Math.max(0, w - visible);
      process.stdout.write(` ${BOX.v} ${line}${' '.repeat(padding)} ${BOX.v}\n`);
    }
    process.stdout.write(` ${BOX.bl}${BOX.hd.repeat(w)}${BOX.br}\n`);
  }

  // ── Menu ──

  menu(items) {
    const w = Math.min(TERM_WIDTH - 4, 64);
    process.stdout.write(` ${BOX.tl}${BOX.hd.repeat(w)}${BOX.tr}\n`);
    for (const [i, item] of items.entries()) {
      const [icon, label] = typeof item === 'string' ? ['', item] : [item.icon || '', item.label];
      const num = item.key !== undefined ? item.key : i;
      const line = ` ${num > 0 && num <= 9 ? `${num}.` : '  '} ${icon ? `${icon} ` : ''}${C.bold}${label}${C.reset}`;
      const visible = line.replace(/\x1b\[\d+m/g, '').length;
      process.stdout.write(` ${BOX.v} ${line}${' '.repeat(Math.max(0, w - visible))} ${BOX.v}\n`);
    }
    if (items.length > 0) {
      const sep = ` ${BOX.v}${C.gray}${repeat('─', w)}${C.reset}${BOX.v}\n`;
      process.stdout.write(sep);
    }
    const exit = ` 0. ❌ ${C.dim}Exit${C.reset}`;
    const exitV = exit.replace(/\x1b\[\d+m/g, '').length;
    process.stdout.write(` ${BOX.v} ${exit}${' '.repeat(Math.max(0, w - exitV))} ${BOX.v}\n`);
    process.stdout.write(` ${BOX.bl}${BOX.hd.repeat(w)}${BOX.br}\n\n`);
  }

  // ── Prompt (text input) ──

  async prompt(question, defaultValue) {
    return new Promise(resolve => {
      const def = defaultValue ? ` ${C.gray}[${defaultValue}]${C.reset}` : '';
      process.stdout.write(` ${C.cyan}?${C.reset} ${question}${def}: `);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question('', answer => {
        rl.close();
        resolve(answer.trim() || defaultValue || '');
      });
    });
  }

  async confirm(question) {
    return new Promise(resolve => {
      process.stdout.write(` ${C.yellow}?${C.reset} ${question} ${C.gray}[y/N]${C.reset}: `);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question('', answer => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
      });
    });
  }

  // ── Password prompt ──

  async password(question) {
    return new Promise(resolve => {
      process.stdout.write(` ${C.cyan}?${C.reset} ${question}: `);
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      // Hide input
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      rl.question('', answer => {
        process.stdout.write = orig;
        rl.close();
        resolve(answer);
      });
    });
  }

  // ── Arrow-key select ──

  async select(items) {
    let idx = 0;
    const render = () => {
      for (let i = 0; i < items.length; i++) {
        const prefix = i === idx ? `${C.cyan}›${C.reset} ` : '  ';
        const style = i === idx ? C.bold : C.dim;
        process.stdout.write(`${ESC.clearLine}\r${prefix}${style}${items[i]}${C.reset}\n`);
      }
      process.stdout.write(ESC.up(items.length));
    };

    this._enableRaw();
    render();
    const result = await new Promise(resolve => {
      const handler = (buf) => {
        const key = buf.toString();
        if (key === '\x1b[A' || key === 'k') {
          idx = (idx - 1 + items.length) % items.length;
          render();
        } else if (key === '\x1b[B' || key === 'j') {
          idx = (idx + 1) % items.length;
          render();
        } else if (key === '\r' || key === '\n' || key === ' ') {
          cleanup();
          resolve(idx);
        } else if (key === '\x03' || key === 'q') {
          cleanup();
          resolve(-1);
        }
      };
      const cleanup = () => {
        this._disableRaw();
        process.stdin.removeListener('data', handler);
      };
      process.stdin.on('data', handler);
    });
    process.stdout.write(ESC.down(items.length));
    process.stdout.write(ESC.clearLine + '\r');
    return result;
  }

  // ── Progress bar ──

  progress(percent, label = '') {
    const w = Math.min(TERM_WIDTH - 12, 48);
    const filled = Math.round((percent / 100) * w);
    const bar = `${C.bgGreen}${repeat(' ', filled)}${C.reset}${C.bgGray}${repeat(' ', w - filled)}${C.reset}`;
    const pct = `${String(Math.round(percent)).padStart(3)}%`;
    process.stdout.write(`\r${ESC.clearLine} ${bar} ${C.bold}${pct}${C.reset} ${C.gray}${label}${C.reset}`);
    if (percent >= 100) process.stdout.write('\n');
  }

  // ── Spinner ──

  startSpinner(label) {
    this.spinnerIdx = 0;
    process.stdout.write(` ${C.cyan}${spinnerFrame(0)}${C.reset} ${label}`);
    this.spinnerInterval = setInterval(() => {
      this.spinnerIdx++;
      process.stdout.write(`\r${ESC.clearLine} ${C.cyan}${spinnerFrame(this.spinnerIdx)}${C.reset} ${label}`);
    }, 100);
  }

  stopSpinner(success = true, msg = '') {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
    const icon = success ? `${C.green}✓${C.reset}` : `${C.red}✘${C.reset}`;
    const status = msg ? ` ${C.gray}${msg}${C.reset}` : '';
    process.stdout.write(`\r${ESC.clearLine} ${icon}${status}\n`);
  }

  // ── Table ──

  table(headers, rows) {
    const colW = headers.map((h, ci) => {
      const maxData = rows.reduce((m, r) => Math.max(m, String(r[ci] || '').replace(/\x1b\[\d+m/g, '').length), 0);
      return Math.max(h.replace(/\x1b\[\d+m/g, '').length, maxData) + 2;
    });
    const sep = ` ${BOX.h}${colW.map(w => BOX.h.repeat(w)).join(`${BOX.h}${BOX.h}${BOX.h}`)}${BOX.h}`;
    process.stdout.write(` ${BOX.tl}${sep}${BOX.tr}\n`);
    process.stdout.write(` ${BOX.v} ${headers.map((h, i) => pad(h, colW[i])).join(` ${BOX.v} `)} ${BOX.v}\n`);
    process.stdout.write(` ${BOX.v}${colW.map(w => BOX.h.repeat(w)).join(`${BOX.h}${BOX.h}${BOX.h}`)}${BOX.v}\n`);
    for (const row of rows) {
      const cells = row.map((c, i) => pad(String(c), colW[i]));
      process.stdout.write(` ${BOX.v} ${cells.join(` ${BOX.v} `)} ${BOX.v}\n`);
    }
    process.stdout.write(` ${BOX.bl}${sep}${BOX.br}\n`);
  }

  // ── Wait for key ──

  async waitKey(msg = 'Press any key to continue...') {
    process.stdout.write(` ${C.gray}${msg}${C.reset}`);
    return new Promise(resolve => {
      this._enableRaw();
      const handler = () => {
        this._disableRaw();
        process.stdin.removeListener('data', handler);
        resolve();
      };
      process.stdin.on('data', handler);
    });
  }

  // ── Raw mode helpers ──

  _enableRaw() {
    if (!this.rawMode && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      this.rawMode = true;
    }
  }

  _disableRaw() {
    if (this.rawMode && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      this.rawMode = false;
    }
  }

  destroy() {
    this._disableRaw();
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
    process.stdout.write(ESC.showCursor);
  }
}
