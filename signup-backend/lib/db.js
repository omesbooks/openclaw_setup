// lib/db.js — SQLite store for token ↔ container mappings.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbPath =
  process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tokens.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    token           TEXT PRIMARY KEY,
    domain          TEXT NOT NULL,
    container_ip    TEXT NOT NULL,
    container_user  TEXT NOT NULL DEFAULT 'root',
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending | provisioning | ready | failed
    customer_email  TEXT,
    customer_url    TEXT,
    ssh_password    TEXT,
    gateway_token   TEXT,
    provider        TEXT,
    error_message   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT
  );
`);

function createToken({ domain, containerIp, containerUser = 'root' }) {
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO tokens (token, domain, container_ip, container_user)
     VALUES (?, ?, ?, ?)`
  ).run(token, domain, containerIp, containerUser);
  return token;
}

function getToken(token) {
  return db.prepare('SELECT * FROM tokens WHERE token = ?').get(token);
}

function updateToken(token, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  db.prepare(
    `UPDATE tokens SET ${sets}, updated_at = datetime('now') WHERE token = ?`
  ).run(...values, token);
}

function listTokens() {
  return db
    .prepare('SELECT * FROM tokens ORDER BY created_at DESC')
    .all();
}

function deleteToken(token) {
  return db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
}

module.exports = {
  db,
  createToken,
  getToken,
  updateToken,
  listTokens,
  deleteToken,
};
