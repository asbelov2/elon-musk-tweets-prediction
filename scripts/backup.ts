import { backup, DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = resolve(process.env.TWEET_DB ?? 'data/tweets.sqlite3');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = resolve(
  process.argv[2] ?? `${dirname(source)}/backups/tweets-${stamp}.sqlite3`,
);
if (source === destination) throw new Error('Backup destination must differ from the database');
mkdirSync(dirname(destination), { recursive: true });
// Exclusive creation prevents accidentally overwriting a database or an old backup.
closeSync(openSync(destination, 'wx', 0o600));
let database: DatabaseSync | undefined;
try {
  database = new DatabaseSync(source, { readOnly: true });
  await backup(database, destination);
  console.log(`Backup saved: ${destination}`);
} catch (error) {
  rmSync(destination, { force: true });
  throw error;
} finally {
  database?.close();
}
