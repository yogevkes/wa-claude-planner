import { spawn } from 'node:child_process';
import { paths } from './config.js';

/**
 * Run Claude Code in print mode. The whole prompt goes through stdin, so no
 * long/Hebrew arguments have to survive Windows cmd quoting.
 */
export function runClaudeCli(prompt, cfg, { log } = {}) {
  const isWin = process.platform === 'win32';
  const cmd = isWin && /\s/.test(cfg.claudePath) ? `"${cfg.claudePath}"` : cfg.claudePath;
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', cfg.claudeModel || 'sonnet',
    '--tools', 'Read',            // only file reading (for images / PDFs we saved)
    '--allowedTools', 'Read',
    '--strict-mcp-config',        // don't load the user's other MCP servers
    '--no-session-persistence',
  ];
  return new Promise((resolve, reject) => {
    // On Windows run through the shell (claude.cmd needs it) as one command string;
    // every arg is a plain token, the prompt itself goes through stdin.
    const child = spawn(isWin ? `${cmd} ${args.join(' ')}` : cmd, isWin ? [] : args, {
      cwd: paths.work,
      shell: isWin, // needed for claude.cmd (npm install) on Windows
      windowsHide: true,
      env: process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Claude timed out after ${cfg.claudeTimeoutSec}s`));
    }, (cfg.claudeTimeoutSec || 240) * 1000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Claude CLI (${cfg.claudePath}): ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        return reject(new Error(`Claude CLI exited ${code}. stderr: ${err.slice(0, 500)} stdout: ${out.slice(0, 500)}`));
      }
      if (parsed.is_error) return reject(new Error(`Claude error: ${parsed.result || parsed.subtype}`));
      log?.debug?.({ cost: parsed.total_cost_usd, ms: parsed.duration_ms }, 'claude done');
      resolve(String(parsed.result ?? ''));
    });
    child.stdin.end(prompt, 'utf8');
  });
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences and chatter) */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`No JSON object in Claude reply: ${text.slice(0, 300)}`);
  return JSON.parse(candidate.slice(start, end + 1));
}

export function normalizeDecision(obj) {
  return {
    calendar_actions: Array.isArray(obj.calendar_actions) ? obj.calendar_actions : [],
    task_actions: Array.isArray(obj.task_actions) ? obj.task_actions : [],
    reply: typeof obj.reply === 'string' && obj.reply.trim() ? obj.reply.trim() : null,
  };
}

/** Ask Claude and get a validated decision object; one retry if the JSON is malformed */
export async function askClaude(prompt, cfg, runner = runClaudeCli, log) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = attempt === 0 ? prompt : `${prompt}\n\nIMPORTANT: your previous answer was not valid JSON. Answer with ONLY the JSON object.`;
    try {
      const text = await runner(p, cfg, { log });
      return normalizeDecision(extractJson(text));
    } catch (e) {
      lastErr = e;
      if (!/JSON/.test(e.message)) break; // don't retry crashes/timeouts
    }
  }
  throw lastErr;
}
