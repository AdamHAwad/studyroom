import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const label = 'local.studyroom.app';
const logs = path.join(root, 'data', 'logs');
fs.mkdirSync(logs, { recursive: true });
fs.mkdirSync(path.join(root, 'data'), { recursive: true });

if (process.platform === 'darwin') {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', label + '.plist');
  const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  const node = fs.existsSync('/opt/homebrew/bin/node')
    ? '/opt/homebrew/bin/node'
    : process.execPath;
  fs.writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(node)}</string><string>--import</string><string>${escape(path.join(root, 'node_modules/tsx/dist/loader.mjs'))}</string><string>${escape(path.join(root, 'server/index.ts'))}</string></array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>PORT</key><string>3210</string><key>NODE_ENV</key><string>production</string><key>HOME</key><string>${escape(os.homedir())}</string></dict>
<key>StandardOutPath</key><string>${escape(path.join(logs, 'server.log'))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(logs, 'server-error.log'))}</string>
</dict></plist>`,
  );
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  } catch {}
  execFileSync('/bin/launchctl', ['bootstrap', domain, plist]);
  execFileSync('/bin/launchctl', ['kickstart', `${domain}/${label}`]);
  console.log(`Installed ${plist}\nStudyroom starts when you log in: http://localhost:3210`);
} else if (process.platform === 'win32') {
  const startup = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
  fs.mkdirSync(startup, { recursive: true });
  const vbs = path.join(startup, 'studyroom.vbs');
  fs.writeFileSync(
    vbs,
    `Set sh = CreateObject("WScript.Shell")\r\nsh.CurrentDirectory = "${root}"\r\nsh.Run "cmd /c npm start", 0, False\r\n`,
    'utf8',
  );
  console.log(`Installed ${vbs}\nStudyroom starts hidden when you sign in: http://localhost:3210`);
} else {
  console.log(
    `Autostart is not automated here yet. Start Studyroom with 'npm start' in this folder, or add it to your login services (for example a systemd user service) pointing at:\n  cd ${root} && npm start\nThe app is then available at http://localhost:3210.`,
  );
}
