// One-time Google Calendar authorization (opens the browser, listens on localhost)
import fs from 'node:fs';
import http from 'node:http';
import { exec } from 'node:child_process';
import { google } from 'googleapis';
import { paths } from '../src/config.js';
import { loadOAuthClient, SCOPES } from '../src/calendar.js';

const client = loadOAuthClient();
const server = http.createServer();

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const redirectUri = `http://127.0.0.1:${port}`;
  client.redirectUri = redirectUri;
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, redirect_uri: redirectUri });
  console.log('\nפותח דפדפן לאישור גישה ליומן. אם לא נפתח, העתק את הקישור:\n');
  console.log(url, '\n');
  const opener = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(opener, () => {});

  server.on('request', async (req, res) => {
    const u = new URL(req.url, redirectUri);
    const code = u.searchParams.get('code');
    if (!code) {
      res.end('No code');
      return;
    }
    try {
      const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
      if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.');
      fs.writeFileSync(paths.googleToken, JSON.stringify(tokens, null, 2));
      client.setCredentials(tokens);
      const cal = google.calendar({ version: 'v3', auth: client });
      const list = await cal.calendarList.list();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2 dir="rtl">✅ היומן חובר. אפשר לסגור את החלון.</h2>');
      console.log('✅ נשמר:', paths.googleToken);
      console.log('יומנים זמינים (אפשר לשים id ב-calendarId בקונפיג):');
      for (const c of list.data.items || []) console.log(`  ${c.summary}  →  ${c.primary ? 'primary' : c.id}`);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Error: ${e.message}`);
      console.error('❌', e.message);
    } finally {
      server.close();
      setTimeout(() => process.exit(0), 300);
    }
  });
});
