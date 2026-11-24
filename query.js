'use strict';
/**
 * query.js — semua akses database (INSERT / SELECT / DELETE / UPDATE).
 *
 * Tidak ada SQL di file lain. app.js hanya memanggil fungsi di sini.
 * Semua parameter selalu dikirim lewat placeholder $1, $2, ... (anti SQL injection).
 */

const crypto = require('crypto');
const { query } = require('./database');

/* ============================================================
 *  Slug (id pendek untuk akses paste)
 * ============================================================ */

const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SLUG_LENGTH = 8;          // 62^8 ~ 2.18e14 kombinasi
const SLUG_PATTERN = /^[A-Za-z0-9_-]{3,16}$/;
const UNIQUE_VIOLATION = '23505';

/** Generate slug acak (base62), minimal 3 karakter. */
function generateSlug(length = SLUG_LENGTH) {
  const len = Math.min(Math.max(Number(length) || SLUG_LENGTH, 3), 16);
  let out = '';
  // randomBytes + rejection sampling supaya distribusi karakter rata
  while (out.length < len) {
    for (const byte of crypto.randomBytes(len * 2)) {
      if (out.length >= len) break;
      if (byte < 248) out += SLUG_ALPHABET[byte % 62]; // 248 = 62*4
    }
  }
  return out;
}

/** Cek apakah format slug valid (dipakai app.js untuk validasi parameter URL). */
function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

/* ============================================================
 *  Expiry helper
 * ============================================================ */

/**
 * Terima: 30 (menit), '30m', '12h', '7d', '2w', ISO date string, atau null.
 * @returns {Date|null}
 */
function parseExpiry(value) {
  if (value === undefined || value === null || value === '') return null;

  if (value instanceof Date) return value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(Date.now() + value * 60_000); // angka = menit
  }

  const str = String(value).trim().toLowerCase();
  if (str === '' || str === 'never' || str === 'null' || str === 'none') return null;

  const relative = /^(\d+)\s*(m|min|menit|h|jam|d|hari|w|minggu)$/.exec(str);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = {
      m: 60_000, min: 60_000, menit: 60_000,
      h: 3_600_000, jam: 3_600_000,
      d: 86_400_000, hari: 86_400_000,
      w: 604_800_000, minggu: 604_800_000,
    }[relative[2]];
    return new Date(Date.now() + amount * unitMs);
  }

  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  throw Object.assign(new Error(`Nilai expires_in tidak valid: "${value}"`), { statusCode: 400 });
}

/** Kondisi SQL: baris dianggap hidup kalau belum kedaluwarsa. */
const NOT_EXPIRED = '(expires_at IS NULL OR expires_at > now())';

/* ============================================================
 *  CREATE — INSERT INTO pastes
 * ============================================================ */

/**
 * Simpan paste baru. Slug dibuat di sini, lengkap dengan retry kalau
 * (sangat jarang) slug-nya sudah terpakai.
 *
 * @param {{content:string,title?:string,language?:string,expiresIn?:any,slug?:string}} input
 * @returns {Promise<object>} baris paste yang baru dibuat (termasuk content)
 */
async function createPaste({ content, title, language, expiresIn, slug } = {}) {
  const sql = `
    INSERT INTO pastes (slug, title, language, content, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, slug, title, language, content, views,
              created_at, updated_at, expires_at,
              octet_length(content) AS size_bytes
  `;

  const params = [
    slug || generateSlug(),
    (title ?? '').toString().trim() ? String(title).trim() : 'Untitled',
    (language || 'plaintext').toString().trim().toLowerCase() || 'plaintext',
    String(content),
    parseExpiry(expiresIn),
  ];

  const maxAttempts = slug ? 1 : 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const values = [...params];
    if (attempt > 1) values[0] = generateSlug();
    try {
      const { rows } = await query(sql, values);
      return rows[0];
    } catch (err) {
      const isSlugClash = err.code === UNIQUE_VIOLATION && /slug/i.test(err.constraint || '');
      if (!isSlugClash || attempt === maxAttempts) throw err;
    }
  }
  throw new Error('Gagal membuat slug unik setelah beberapa percobaan');
}

/* ============================================================
 *  GET BY — SELECT berdasarkan slug (+ naikkan counter views)
 * ============================================================ */

/**
 * Ambil satu paste berdasarkan slug.
 * @param {string} slug
 * @param {{countView?:boolean}} [opts] countView=true → views bertambah 1
 * @returns {Promise<object|null>}
 */
async function getPasteBySlug(slug, { countView = true } = {}) {
  const columns = `id, slug, title, language, content, views,
                   created_at, updated_at, expires_at,
                   octet_length(content) AS size_bytes`;

  if (!countView) {
    const { rows } = await query(
      `SELECT ${columns} FROM pastes WHERE slug = $1 AND ${NOT_EXPIRED}`,
      [slug]
    );
    return rows[0] || null;
  }

  const { rows } = await query(
    `UPDATE pastes SET views = views + 1
      WHERE slug = $1 AND ${NOT_EXPIRED}
      RETURNING ${columns}`,
    [slug]
  );
  return rows[0] || null;
}

/* ============================================================
 *  GET ALL — SELECT semua paste TANPA kolom content
 * ============================================================ */

const ORDER_MAP = {
  newest: 'created_at DESC',
  oldest: 'created_at ASC',
  popular: 'views DESC, created_at DESC',
  az: 'title ASC',
};

/**
 * Ambil daftar paste (tanpa content). Hanya metadata + ukuran.
 * @param {{limit?:number,offset?:number,order?:string,includeExpired?:boolean}} [opts]
 * @returns {Promise<{rows:object[],total:number,limit:number,offset:number,order:string}>}
 */
async function getAllPastes({ limit = 50, offset = 0, order = 'newest', includeExpired = false } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeOrder = ORDER_MAP[String(order).toLowerCase()] ? String(order).toLowerCase() : 'newest';
  const where = includeExpired ? 'TRUE' : NOT_EXPIRED;

  const [list, count] = await Promise.all([
    query(
      `SELECT id, slug, title, language, views,
              octet_length(content) AS size_bytes,
              created_at, updated_at, expires_at
         FROM pastes
        WHERE ${where}
        ORDER BY ${ORDER_MAP[safeOrder]}
        LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset]
    ),
    query(`SELECT COUNT(*)::int AS total FROM pastes WHERE ${where}`),
  ]);

  return {
    rows: list.rows,
    total: count.rows[0].total,
    limit: safeLimit,
    offset: safeOffset,
    order: safeOrder,
  };
}

/* ============================================================
 *  DELETE BY — DELETE berdasarkan slug
 * ============================================================ */

/**
 * Hapus paste berdasarkan slug.
 * @returns {Promise<object|null>} baris yang dihapus, atau null kalau tidak ada
 */
async function deletePasteBySlug(slug) {
  const { rows } = await query(
    `DELETE FROM pastes WHERE slug = $1
     RETURNING id, slug, title, language, views, created_at, expires_at`,
    [slug]
  );
  return rows[0] || null;
}

/** Hapus semua paste yang sudah kedaluwarsa. @returns {Promise<number>} jumlah baris */
async function deleteExpiredPastes() {
  const { rowCount } = await query(
    'DELETE FROM pastes WHERE expires_at IS NOT NULL AND expires_at <= now()'
  );
  return rowCount;
}

module.exports = {
  // slug helpers
  generateSlug,
  isValidSlug,
  parseExpiry,
  // queries
  createPaste,
  getPasteBySlug,
  getAllPastes,
  deletePasteBySlug,
  deleteExpiredPastes,
};
