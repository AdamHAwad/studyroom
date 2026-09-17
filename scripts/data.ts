import fs from 'node:fs';
import path from 'node:path';
import { all, DATA, db } from '../server/db';
import { agentSnapshot, snapshot } from '../server/snapshot';
const [command = 'summary', scope] = process.argv.slice(2);
if (command === 'summary') {
  const { cards, attempts, ...summary } = snapshot(scope);
  console.log(JSON.stringify({ schemaVersion: 1, ...summary }, null, 2));
} else if (command === 'snapshot') console.log(JSON.stringify(agentSnapshot(scope), null, 2));
else if (command === 'attempts') {
  const rows = all('attempts').filter((a) => !scope || a.courseId === scope);
  console.log(rows.map((a) => JSON.stringify(a)).join('\n'));
} else if (command === 'export') {
  const folder = path.join(DATA, 'exports', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  for (const table of [
    'courses',
    'sets',
    'cards',
    'sources',
    'assets',
    'crops',
    'attempts',
    'sessions',
    'progress',
    'jobs',
    'conversations',
    'messages',
  ])
    fs.writeFileSync(
      path.join(folder, table + '.jsonl'),
      all(table)
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
  fs.writeFileSync(
    path.join(folder, 'snapshot.json'),
    JSON.stringify(agentSnapshot(scope), null, 2),
  );
  console.log(folder);
} else {
  console.error('Use summary, snapshot [courseId], attempts [courseId], or export.');
  process.exitCode = 1;
}
db.close();
