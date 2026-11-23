// Creates the config/data folders for an instance and prints where they are.
import { loadConfig, paths, INSTANCE, IS_DEFAULT } from '../src/config.js';
import fs from 'node:fs';

const cfg = loadConfig();
console.log(`Instance:        ${INSTANCE}`);
console.log(`Config file:     ${paths.config}`);
console.log(`Data folder:     ${paths.logs.replace(/[\\/]logs$/, '')}`);
if (!IS_DEFAULT) console.log(`Claude login in: ${cfg.claudeConfigDir}`);
console.log(`Google client:   ${fs.existsSync(paths.googleCreds) ? 'ready' : 'MISSING - copy google-credentials.json into the data folder'}`);
