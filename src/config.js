import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Instance = one WhatsApp account / one person. The default instance keeps the
 * original layout (config.json + data\ in the project root); any other instance
 * lives in instances\<name>\ with its own config, WhatsApp link, Google token and logs.
 * Choose it with `--instance <name>` (or the WA_CLAUDE_INSTANCE env var).
 */
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

export const INSTANCE = (argValue('--instance') || process.env.WA_CLAUDE_INSTANCE || 'default').trim();
if (!/^[a-z0-9_-]{1,32}$/i.test(INSTANCE)) {
  throw new Error(`Invalid instance name "${INSTANCE}" - use English letters, digits, - or _`);
}
export const IS_DEFAULT = INSTANCE.toLowerCase() === 'default';
const INSTANCE_DIR = IS_DEFAULT ? ROOT : path.join(ROOT, 'instances', INSTANCE);

export const DATA_DIR = process.env.WA_CLAUDE_DATA || path.join(INSTANCE_DIR, 'data');

export const paths = {
  config: process.env.WA_CLAUDE_CONFIG || path.join(INSTANCE_DIR, 'config.json'),
  example: path.join(ROOT, 'config.example.json'),
  state: path.join(DATA_DIR, 'state.json'),
  inbox: path.join(DATA_DIR, 'inbox.json'),
  contacts: path.join(DATA_DIR, 'contacts.json'),
  waAuth: path.join(DATA_DIR, 'wa-auth'),
  googleCreds: path.join(DATA_DIR, 'google-credentials.json'),
  googleToken: path.join(DATA_DIR, 'google-token.json'),
  work: path.join(DATA_DIR, 'work'),
  media: path.join(DATA_DIR, 'work', 'media'),
  logs: path.join(DATA_DIR, 'logs'),
};

for (const dir of [DATA_DIR, paths.work, paths.media, paths.logs]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Settings a brand-new (non-default) instance starts with */
function newInstanceConfig(example) {
  return {
    ...example,
    watchChats: [], // the new person picks their own chats
    claudeConfigDir: path.join(os.homedir(), `.claude-${INSTANCE}`), // their own Claude subscription
    userContext: example.userContext,
  };
}

export function loadConfig() {
  const defaults = JSON.parse(fs.readFileSync(paths.example, 'utf8'));
  if (!fs.existsSync(paths.config)) {
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    const initial = IS_DEFAULT ? defaults : newInstanceConfig(defaults);
    fs.writeFileSync(paths.config, JSON.stringify(initial, null, 2), 'utf8');
    console.log(`[config] Created ${paths.config}. Edit it if needed.`);
  }
  // The Google OAuth client (not the token) can be shared by every instance
  if (!IS_DEFAULT && !fs.existsSync(paths.googleCreds)) {
    const shared = path.join(ROOT, 'data', 'google-credentials.json');
    if (fs.existsSync(shared)) fs.copyFileSync(shared, paths.googleCreds);
  }
  // strip a BOM in case the file was saved by Notepad
  const user = JSON.parse(fs.readFileSync(paths.config, 'utf8').replace(/^\uFEFF/, ''));
  return { ...defaults, ...user };
}
