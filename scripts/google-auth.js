// One-time Google Calendar authorization from the console (opens the browser, listens on localhost).
// The settings UI does the same with a button; this stays for source installs and extra instances.
import { exec } from 'node:child_process';
import { paths, loadConfig, INSTANCE } from '../src/config.js';
import { startGoogleAuth } from '../src/googleAuth.js';

loadConfig(); // creates the instance config and copies the shared OAuth client if needed
console.log(`Instance: ${INSTANCE}`);
const { url, done } = await startGoogleAuth();
console.log('\nפותח דפדפן לאישור גישה ליומן. אם לא נפתח, העתק את הקישור:\n');
console.log(url, '\n');
const opener = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
exec(opener, () => {});
try {
  const { calendars } = await done;
  console.log('✅ נשמר:', paths.googleToken);
  console.log('יומנים זמינים (אפשר לשים id ב-calendarId בקונפיג):');
  for (const c of calendars) console.log(`  ${c.summary}  →  ${c.primary ? 'primary' : c.id}`);
  process.exit(0);
} catch (e) {
  console.error('❌', e.message);
  process.exit(1);
}
