import fs from 'node:fs';

const DEFAULT_STATE = {
  groupJid: '',
  lastSeenTs: 0,          // unix seconds of the newest message we handled
  processedIds: [],       // recent incoming message ids (dedupe)
  sentIds: [],            // ids of messages the bot sent (so we ignore them)
  history: [],            // [{role:'me'|'bot', ts, text}]
  tasks: [],              // [{id, text, due, done, createdTs}]
  nextTaskId: 1,
  undoStack: [],          // [{ts, label, ops:[...inverse ops]}]
  lastBriefs: {},         // {morning:'YYYY-MM-DD', evening:'YYYY-MM-DD'}
  failedBatch: null,      // messages of the last batch that failed
};

const CAPS = { processedIds: 1000, sentIds: 1000, history: 200, undoStack: 15 };

export class State {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(DEFAULT_STATE);
    if (fs.existsSync(file)) {
      try {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (e) {
        const backup = `${file}.corrupt-${Date.now()}`;
        fs.copyFileSync(file, backup);
        console.error(`[state] Could not parse state, backed up to ${backup}`);
      }
    }
  }

  save() {
    for (const [key, cap] of Object.entries(CAPS)) {
      if (this.data[key].length > cap) this.data[key] = this.data[key].slice(-cap);
    }
    // Keep finished tasks for 14 days only
    const cutoff = Date.now() / 1000 - 14 * 86400;
    this.data.tasks = this.data.tasks.filter((t) => !t.done || (t.doneTs || 0) > cutoff);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get d() {
    return this.data;
  }
}
