// Google Calendar authorization over a loopback redirect (works with "Desktop app" OAuth clients).
// Used by scripts/google-auth.js (console) and by the settings UI.
import fs from 'node:fs';
import http from 'node:http';
import { google } from 'googleapis';
import { paths } from './config.js';
import { loadOAuthClient, SCOPES } from './calendar.js';

const page = (title, body) =>
  `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:Segoe UI,system-ui,sans-serif;background:#f6f7f9;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div style="background:#fff;padding:32px 40px;border-radius:16px;box-shadow:0 4px 24px #0001;text-align:center;max-width:420px">${body}</div></body></html>`;

/**
 * Start a one-shot local listener and return the Google consent URL.
 * `done` resolves with the list of calendars once the user approves (token saved to data\google-token.json).
 * @returns {Promise<{url: string, done: Promise<{calendars: {id:string, summary:string, primary:boolean}[]}>, cancel: () => void}>}
 */
export function startGoogleAuth({ timeoutMs = 10 * 60000 } = {}) {
  const client = loadOAuthClient();
  const server = http.createServer();
  let finish;
  const done = new Promise((resolve, reject) => (finish = { resolve, reject }));
  const timer = setTimeout(() => {
    server.close();
    finish.reject(new Error('Google authorization timed out'));
  }, timeoutMs);
  const cancel = () => {
    clearTimeout(timer);
    server.close();
    finish.reject(new Error('cancelled'));
  };
  done.catch(() => {}); // callers that only want the URL must not crash on a timeout

  return new Promise((resolveUrl, rejectUrl) => {
    server.on('error', rejectUrl);
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}`;
      const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, redirect_uri: redirectUri });

      server.on('request', async (req, res) => {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== '/') return res.writeHead(404).end();
        const code = u.searchParams.get('code');
        const err = u.searchParams.get('error');
        if (!code && !err) return res.writeHead(400).end('No code');
        try {
          if (err) throw new Error(`Google returned: ${err}`);
          const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
          if (!tokens.refresh_token) {
            throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.');
          }
          fs.writeFileSync(paths.googleToken, JSON.stringify(tokens, null, 2));
          client.setCredentials(tokens);
          const list = await google.calendar({ version: 'v3', auth: client }).calendarList.list();
          const calendars = (list.data.items || []).map((c) => ({ id: c.id, summary: c.summary, primary: Boolean(c.primary) }));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(page('היומן חובר', '<div style="font-size:48px">✅</div><h2>היומן חובר</h2><p>אפשר לסגור את הלשונית ולחזור להגדרות.</p>'));
          finish.resolve({ calendars });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(page('שגיאה', `<div style="font-size:48px">⚠️</div><h2>החיבור נכשל</h2><p dir="ltr">${String(e.message).replace(/</g, '&lt;')}</p>`));
          finish.reject(e);
        } finally {
          clearTimeout(timer);
          server.close();
        }
      });
      resolveUrl({ url, done, cancel });
    });
  });
}
