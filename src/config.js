import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.WA_CLAUDE_DATA || path.join(ROOT, 'data');

export const paths = {
  config: process.env.WA_CLAUDE_CONFIG || path.join(ROOT, 'config.json'),
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

export function loadConfig() {
  if (!fs.existsSync(paths.config)) {
    fs.copyFileSync(paths.example, paths.config);
    console.log(`[config] Created ${paths.config} from the example. Edit it if needed.`);
  }
  const defaults = JSON.parse(fs.readFileSync(paths.example, 'utf8'));
  const user = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  return { ...defaults, ...user };
}
