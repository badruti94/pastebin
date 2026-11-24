'use strict';
/**
 * database.js — konfigurasi database & connection pool PostgreSQL.
 *
 * Semua nilai koneksi dibaca dari .env (lihat .env.example).
 * Modul ini juga bertanggung jawab menjalankan schema.sql saat server
 * start (initSchema), sehingga tabel siap dipakai tanpa langkah manual.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const {
  DB_HOST = '127.0.0.1',
  DB_PORT = '5432',
  DB_USER = 'postgres',
  DB_PASSWORD = '',
  DB_NAME = 'pastebin',
  DB_POOL_MAX = '10',
  DB_IDLE_TIMEOUT_MS = '30000',
  DB_CONN_TIMEOUT_MS = '5000',
  DB_SSL = 'false',
} = process.env;

const pool = new Pool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  max: Number(DB_POOL_MAX),
  idleTimeoutMillis: Number(DB_IDLE_TIMEOUT_MS),
  connectionTimeoutMillis: Number(DB_CONN_TIMEOUT_MS),
  ssl: DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Kalau koneksi nganggur mati (server DB restart, jaringan putus), jangan
// bikin proses crash — cukup dicatat, pool akan membuat koneksi baru.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

/** Jalankan satu query. */
async function query(text, params) {
  return pool.query(text, params);
}

/** Ambil satu client (untuk transaksi manual: BEGIN/COMMIT/ROLLBACK). */
async function getClient() {
  return pool.connect();
}

/** Cek koneksi ke DB; melempar error kalau tidak bisa connect. */
async function testConnection() {
  const { rows } = await pool.query(
    'SELECT current_user AS user, current_database() AS database, version() AS version'
  );
  return rows[0];
}

/**
 * Jalankan schema.sql (idempotent: CREATE TABLE/INDEX IF NOT EXISTS,
 * CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE TRIGGER).
 */
async function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  return schemaPath;
}

/** Tutup semua koneksi (dipakai saat shutdown / test). */
async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  getClient,
  testConnection,
  initSchema,
  closePool,
  config: { host: DB_HOST, port: Number(DB_PORT), user: DB_USER, database: DB_NAME },
};
