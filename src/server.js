// Local settings server: the setup wizard / dashboard UI and a small JSON API.
// Listens on 127.0.0.1 only. Requests from other websites are refused: the Host header must be
// localhost (blocks DNS rebinding) and every change needs a custom header + JSON body (blocks CSRF).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import QRCode from 'qrcode';
import { ROOT, paths } from './config.js';

const UI_DIR = path.join(ROOT, 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
export const EXIT_RESTART = 75; // the tray / run-forever restarts the app on this code

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Last N lines of app.log, parsed */
export function tailLog(file, n = 150) {
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  const len = Math.min(size, 256 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').filter(Boolean).slice(-n);
  return lines.map((l) => {
    try {
      const { level, time, msg, err } = JSON.parse(l);
      return { level, time, msg: msg || '', err: err?.message };
    } catch {
      return { level: 30, time: null, msg: l.slice(0, 500) };
    }
  });
}

async function readJson(req) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON body required');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1e6) throw new HttpError(413, 'body too large');
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new HttpError(400, 'bad JSON');
  }
}

/**
 * @param {import('./runtime.js').Planner} planner
 * @param {{port?: number, exit?: (code:number)=>void}} [opts]
 */
export function createServer(planner, { port = 3777, exit = (code) => process.exit(code) } = {}) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const later = (fn) => setTimeout(fn, 300); // let the response go out first

  const routes = {
    'GET /api/status': () => planner.status(),
    'GET /api/whatsapp/qr': async () => ({ status: planner.wa?.status, svg: planner.wa?.qr ? await QRCode.toString(planner.wa.qr, { type: 'svg', margin: 1 }) : null }),
    'POST /api/whatsapp/pair': async (b) => ({ code: await planner.wa.requestPairing(b.phone) }),
    'POST /api/whatsapp/relink': async () => {
      await planner.wa.relink();
      return { ok: true };
    },
    'GET /api/chats': async (_b, url) => {
      if (url.searchParams.get('refresh') === '1') await planner.wa?.refreshGroups().catch(() => {});
      return { chats: planner.wa ? planner.wa.listChats({ q: url.searchParams.get('q') || '', type: url.searchParams.get('type') || 'all' }) : [] };
    },
    'PUT /api/config': (b) => {
      planner.updateConfig(b);
      return planner.status();
    },
    'POST /api/pause': (b) => {
      planner.setPaused(Boolean(b.paused));
      return { paused: planner.paused };
    },
    'POST /api/google/auth': async () => ({ url: await planner.beginGoogleAuth() }),
    'POST /api/google/client': (b) => {
      planner.saveGoogleClient(b.client);
      return { ok: true };
    },
    'POST /api/google/recheck': async () => planner.initCalendar(),
    'GET /api/google/calendars': async () => ({ calendars: await planner.listCalendars() }),
    'POST /api/claude/check': async () => planner.checkClaude(),
    'POST /api/claude/install': () => {
      planner.installClaude();
      return { ok: true };
    },
    'POST /api/claude/login': () => {
      planner.openClaudeLogin();
      return { ok: true };
    },
    'POST /api/test-message': async () => {
      await planner.sendTest();
      return { ok: true };
    },
    'GET /api/logs': (_b, url) => ({ lines: tailLog(path.join(paths.logs, 'app.log'), Math.min(500, Number(url.searchParams.get('lines')) || 150)) }),
    'POST /api/import': async (b) => {
      await planner.stop();
      planner.importFrom(b.path);
      later(() => exit(EXIT_RESTART));
      return { ok: true, restarting: true };
    },
    'POST /api/restart': async () => {
      await planner.stop();
      later(() => exit(EXIT_RESTART));
      return { ok: true };
    },
    'POST /api/shutdown': async () => {
      await planner.stop();
      later(() => exit(0));
      return { ok: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      if (!allowedHosts.has(req.headers.host || '')) throw new HttpError(403, 'forbidden host');
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) throw new HttpError(403, 'forbidden origin');
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname.startsWith('/api/')) {
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) throw new HttpError(404, 'not found');
        let body = {};
        if (req.method !== 'GET') {
          if (req.headers['x-wa-planner'] !== '1') throw new HttpError(403, 'missing x-wa-planner header');
          body = await readJson(req);
        }
        return send(200, await handler(body, url));
      }

      // static UI
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(UI_DIR, rel);
      if (!file.startsWith(UI_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'not found');
      return send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    } catch (e) {
      // errors thrown by API handlers are user-facing ("not a valid schedule", "no group chosen yet")
      const status = e.status || 400;
      if (status === 400) planner.log?.warn?.({ err: e, url: req.url }, 'settings API error');
      return send(status, { error: e.message });
    }
  });
  return server;
}

/** Start listening; resolves with the server, rejects with a clear message if the port is taken */
export function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use - is WA-Claude Planner already running?`) : e));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
