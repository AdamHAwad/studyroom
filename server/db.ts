import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA = path.resolve(process.env.STUDYROOM_DATA || path.join(ROOT, 'data'));
for (const dir of ['', 'uploads', 'jobs', 'exports', 'backups', 'assets'])
  fs.mkdirSync(path.join(DATA, dir), { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(path.join(DATA, 'studyroom.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS courses(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sets(id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, setId TEXT NOT NULL REFERENCES sets(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, setId TEXT NOT NULL REFERENCES sets(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, cardId TEXT NOT NULL REFERENCES cards(id), sessionId TEXT NOT NULL REFERENCES sessions(id), createdAt TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_card ON attempts(cardId,createdAt);
CREATE INDEX IF NOT EXISTS attempts_session ON attempts(sessionId);
CREATE INDEX IF NOT EXISTS cards_set ON cards(setId);
CREATE TABLE IF NOT EXISTS progress(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS crops(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id), data TEXT NOT NULL);
PRAGMA user_version=1;`);
const tables = new Set([
  'courses',
  'sets',
  'cards',
  'sources',
  'sessions',
  'attempts',
  'progress',
  'jobs',
  'conversations',
  'messages',
  'settings',
  'assets',
  'crops',
  'documents',
]);
function table(name: string) {
  if (!tables.has(name)) throw Error('Unknown table');
  return name;
}
export function all<T = any>(name: string): T[] {
  return (db.prepare(`SELECT data FROM ${table(name)} ORDER BY rowid`).all() as any[]).map((r) =>
    JSON.parse(r.data),
  );
}
export function get<T = any>(name: string, id: string): T | undefined {
  const r = db.prepare(`SELECT data FROM ${table(name)} WHERE id=?`).get(id) as any;
  return r ? JSON.parse(r.data) : undefined;
}
export function put(name: string, obj: any) {
  const refs: Record<string, string[]> = {
    sets: ['courseId'],
    cards: ['setId'],
    sources: ['courseId'],
    sessions: ['setId'],
    attempts: ['cardId', 'sessionId', 'createdAt'],
    messages: ['conversationId'],
    documents: ['courseId'],
  };
  const cols = ['id', ...(refs[name] || []), 'data'];
  const values = cols.map((k) => (k === 'data' ? JSON.stringify(obj) : obj[k]));
  db.prepare(
    `INSERT INTO ${table(name)} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${cols
      .filter((k) => k !== 'id')
      .map((k) => `${k}=excluded.${k}`)
      .join(',')}`,
  ).run(...values);
  return obj;
}
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function backup() {
  const date = new Date().toISOString().slice(0, 10);
  const dest = path.join(DATA, 'backups', `${date}.sqlite`);
  if (!fs.existsSync(dest)) db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
}
