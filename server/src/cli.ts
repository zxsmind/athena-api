#!/usr/bin/env node
/**
 * Athena CLI. Every command is English and every output goes through the UI
 * kit, so piped output stays readable and interactive output stays animated.
 */
import { input, select } from '@inquirer/prompts';
import { runAbout, runAdminKey, runKeys, runLogs, runRepair, runStats, runStatus, checkKeyName, KEY_NAME_RULE, type KeysCommand, type LogsOptions, type StatsOptions } from './cli/admin.js';
import { runConfig } from './cli/config.js';
import { runSetup } from './cli/setup.js';
import {
  runTrace,
  followTrace,
  traceSummary,
  clearTrace,
  listTraceFiles,
  rawTrace,
  type TraceOptions,
} from './cli/trace.js';
import * as ui from './cli/ui.js';
import { failure, info, line } from './cli/ui.js';

const PLANS = ['free', 'paid', 'enterprise'] as const;

const KEY_ACTIONS = ['list', 'create', 'rename', 'revoke', 'plan'] as const;
type KeyAction = (typeof KEY_ACTIONS)[number];

interface Parsed {
  command: string;
  /** True when no command word was given, so `athena` alone means "help". */
  bare: boolean;
  /** Positional words after the command, e.g. `keys create`. */
  words: string[];
  flags: Map<string, string>;
  booleans: Set<string>;
}

function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const words: string[] = [];
  const [command = 'setup', ...rest] = argv;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      words.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split('=', 2);
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else {
      booleans.add(name);
    }
  }
  return { command, bare: argv.length === 0, words, flags, booleans };
}

function usage(): void {
  line(`${ui.color.bold('athena')} — evidence-based web research API`);
  line();
  line(`${ui.color.bold('Usage')}  athena <command> [options]`);
  line();
  line(`${ui.color.bold('Commands')}`);
  const rows: Array<[string, string]> = [
    ['config', 'Manage configuration at any time: providers, keys, models, search backends.'],
    ['setup', 'First-run wizard. Saves once at the end.'],
    ['status', 'Configured providers, backends, and server liveness.'],
    ['keys list', 'Show API keys with plan, usage, and last use.'],
    ['keys create --name <n> --plan <p>', 'Create a key. The secret is printed once.'],
    ['keys rename --id <id> --name <n>', 'Change what a key is called.'],
    ['keys revoke --id <id>', 'Revoke a key immediately.'],
    ['keys plan --id <id> --plan <p>', 'Move a key to another plan.'],
    ['admin-key show', 'Show the admin key for /v1/keys and /v1/analytics.'],
    ['admin-key rotate', 'Replace the admin key. The old one stops working immediately.'],
    ['stats', 'Tokens, tool calls, traffic, database, CPU and memory.'],
    ['logs', 'Tail the log file. --lines <n> --level <lvl>'],
    ['trace <jobId>', 'Show a job execution trace. --kind <k> --full --chars <n>'],
    ['trace list', 'List recorded traces with event counts.'],
    ['trace raw <jobId>', 'Print the trace file as JSON Lines.'],
    ['trace clear <jobId>', 'Delete one trace file.'],
    ['repair', 'SQLite integrity check and stale state cleanup.'],
    ['about', 'Version, runtime, and configuration paths.'],
  ];
  for (const [name, description] of rows) {
    line(`  ${ui.color.cyan(name.padEnd(38))} ${ui.color.dim(description)}`);
  }
  line();
  line(`${ui.color.bold('Options')}`);
  line(`  ${ui.color.cyan('--days <n>'.padEnd(38))} ${ui.color.dim('stats window in days (default 7)')}`);
  line(`  ${ui.color.cyan('--lines <n>'.padEnd(38))} ${ui.color.dim('log lines to show (default 80)')}`);
  line(`  ${ui.color.cyan('--level <lvl>'.padEnd(38))} ${ui.color.dim('filter logs: debug, info, warn, error')}`);
  line(`  ${ui.color.cyan('--kind <kind>'.padEnd(38))} ${ui.color.dim('filter trace events, e.g. llm.attempt, tool.call')}`);
  line(`  ${ui.color.cyan('--full'.padEnd(38))} ${ui.color.dim('do not trim trace values')}`);
  line(`  ${ui.color.cyan('--chars <n>'.padEnd(38))} ${ui.color.dim('characters per trace field (default 160)')}`);
  line();
  info(`Settings live in settings.yaml and config.yaml inside the data directory.`);
  line();
}

function requireFlag(parsed: Parsed, name: string): string {
  const value = parsed.flags.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function parsePlan(value: string): 'free' | 'paid' | 'enterprise' {
  if (!PLANS.includes(value as (typeof PLANS)[number])) {
    throw new Error(`--plan must be one of: ${PLANS.join(', ')}`);
  }
  return value as (typeof PLANS)[number];
}

async function runKeysCommand(action: string, parsed: Parsed): Promise<void> {
  const command: KeysCommand = { action: action as KeysCommand['action'] };
  if (action === 'create') {
    /* The name is mandatory. A flag is used as given; otherwise we ask. */
    const name = parsed.flags.get('name') ?? await input({
      message: 'Key name',
      validate: (value) => checkKeyName(value) ?? true,
    });
    if (checkKeyName(name)) throw new Error(`Invalid key name. A name is required: ${KEY_NAME_RULE}.`);
    command.name = name;
    command.plan = parsed.flags.has('plan')
      ? parsePlan(requireFlag(parsed, 'plan'))
      : await select({ message: 'Plan', choices: PLANS.map((plan) => ({ value: plan })), default: 'free' });
  }
  if (action === 'rename') {
    command.id = requireFlag(parsed, 'id');
    command.name = parsed.flags.get('name') ?? await input({
      message: `New name for key ${command.id}`,
      validate: (value) => checkKeyName(value) ?? true,
    });
  }
  if (action === 'revoke' || action === 'plan') command.id = requireFlag(parsed, 'id');
  if (action === 'plan') command.plan = parsePlan(requireFlag(parsed, 'plan'));
  await runKeys(command);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === '--help' || parsed.command === '-h' || parsed.command === 'help') {
    usage();
    return;
  }

  /* A bare `athena` has no terminal to prompt in, so showing usage is more
     useful than failing with a TTY complaint. */
  if (parsed.bare && !process.stdin.isTTY) {
    usage();
    return;
  }

  if (parsed.command === 'setup' && !process.stdin.isTTY) {
    throw new Error('setup needs an interactive terminal. Run it from a real terminal, or edit settings.yaml directly.');
  }
  if (parsed.command === 'keys' && parsed.words[0] === 'create' && !parsed.flags.has('name') && !process.stdin.isTTY) {
    throw new Error('keys create needs --name in a non-interactive terminal');
  }

  switch (parsed.command) {
    case '':
    case 'setup': {
      ui.banner('configuration wizard');
      await runSetup();
      return;
    }
    case 'status':
      ui.banner('status');
      await runStatus();
      return;
    case 'keys': {
      const action = parsed.words[0] ?? parsed.flags.get('action') ?? 'list';
      if (!KEY_ACTIONS.includes(action as KeyAction)) {
        throw new Error(`Unknown keys action "${action}". Use: ${KEY_ACTIONS.join(', ')}.`);
      }
      ui.banner(`keys — ${action}`);
      await runKeysCommand(action, parsed);
      return;
    }
    case 'config': {
      if (!process.stdin.isTTY) throw new Error('config needs an interactive terminal');
      ui.banner('configuration');
      await runConfig();
      return;
    }
    case 'admin-key': {
      const action = parsed.words[0] ?? 'show';
      if (action !== 'show' && action !== 'rotate') {
        throw new Error(`Unknown admin-key action "${action}". Use: show, rotate.`);
      }
      ui.banner(`admin-key — ${action}`);
      runAdminKey(action);
      return;
    }
    case 'stats': {
      const options: StatsOptions = {};
      if (parsed.flags.has('days')) options.days = Number(parsed.flags.get('days'));
      if (parsed.flags.has('recent')) options.recent = Number(parsed.flags.get('recent'));
      ui.banner('stats');
      await runStats(options);
      return;
    }
    case 'logs': {
      const options: LogsOptions = {};
      if (parsed.flags.has('lines')) options.lines = Number(parsed.flags.get('lines'));
      if (parsed.flags.has('level')) options.level = parsed.flags.get('level') as LogsOptions['level'];
      if (parsed.booleans.has('follow')) options.follow = true;
      ui.banner('logs');
      runLogs(options);
      return;
    }
    case 'trace': {
      const knownActions = new Set(['show', 'list', 'raw', 'clear', 'summary', 'follow']);
      const first = parsed.words[0];
      /* `athena trace <jobId>` means show; anything else names the action. */
      const action = first && knownActions.has(first) ? first : 'show';
      const jobId = action === 'show' && first && !knownActions.has(first) ? first : parsed.words[1];
      const options: TraceOptions = {};
      if (parsed.flags.has('kind')) options.kind = String(parsed.flags.get('kind')).split(',');
      if (parsed.flags.has('chars')) options.chars = Number(parsed.flags.get('chars'));
      if (parsed.booleans.has('full')) options.full = true;
      ui.banner(`trace — ${action}`);
      if (action === 'list') {
        line(listTraceFiles());
        return;
      }
      if (!jobId) throw new Error(`trace ${action} needs a job id. Use "athena trace list" to see them.`);
      if (action === 'raw') {
        process.stdout.write(rawTrace(jobId));
        return;
      }
      if (action === 'clear') {
        line(clearTrace(jobId));
        return;
      }
      if (action === 'summary') {
        line(traceSummary(jobId));
        return;
      }
      if (action === 'follow') {
        followTrace(jobId);
        info('Following. Press Ctrl+C to stop.');
        return;
      }
      runTrace([jobId], options);
      return;
    }
    case 'repair':
      ui.banner('repair');
      runRepair();
      return;
    case 'about':
      await runAbout();
      return;
    default:
      failure(`Unknown command "${parsed.command}".`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error && (error.name === 'ExitPromptError' || error.name === 'AbortPromptError')) {
    line();
    info('Cancelled. Nothing was written.');
    process.exitCode = 1;
    return;
  }
  failure(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
