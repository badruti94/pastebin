'use strict';
/**
 * app.js — HTTP endpoint (Express).
 *
 *   POST   /api/pastes          → create
 *   GET    /api/pastes/:slug    → get by (beserta content, +1 view)
 *   GET    /api/pastes          → get all (TANPA content)
 *   DELETE /api/pastes/:slug    → delete by
 *   GET    /api/health          → status server + DB
 *   GET    /p/:slug             → halaman HTML untuk lihat paste (permalink)
 *
 * Logika query ada di query.js, konfigurasi DB di database.js.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const db = require('./database');
const store = require('./query');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const MAX_CONTENT_BYTES = Number(process.env.MAX_CONTENT_BYTES || 1048576);
const DEFAULT_EXPIRES_IN = process.env.DEFAULT_EXPIRES_IN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: MAX_CONTENT_BYTES + 1024 }));
app.use(express.urlencoded({ extended: false, limit: MAX_CONTENT_BYTES + 1024 }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

/* ------------------------------------------------------------
 *  Helper respons
 * ------------------------------------------------------------ */

function ok(res, data, status = 200, extra = {}) {
  return res.status(status).json({ success: true, data, ...extra });
}

function fail(res, status, message, details) {
  return res.status(status).json({ success: false, error: message, ...(details ? { details } : {}) });
}

/** 404 untuk data yang tidak ada. */
const notFound = (res, slug) => fail(res, 404, `Paste dengan slug "${slug}" tidak ditemukan`);

/** Permalink + URL API untuk sebuah slug. */
const linksFor = (slug) => ({ url: `/p/${slug}`, api_url: `/api/pastes/${slug}` });

/* ------------------------------------------------------------
 *  POST /api/pastes  → CREATE
 *  body: { content, title?, language?, expires_in? | expires_at? }
 * ------------------------------------------------------------ */

app.post('/api/pastes', async (req, res, next) => {
  try {
    const body = req.body || {};
    const content = body.content;

    if (typeof content !== 'string' || content.trim() === '') {
      return fail(res, 400, 'Field "content" wajib diisi dan berupa teks');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      return fail(res, 413, `Isi paste melebihi batas ${MAX_CONTENT_BYTES} byte`);
    }
    if (body.title !== undefined && typeof body.title !== 'string') {
      return fail(res, 400, 'Field "title" harus berupa teks');
    }
    if (body.title && body.title.trim().length > 200) {
      return fail(res, 400, 'Field "title" maksimal 200 karakter');
    }
    if (body.slug !== undefined && !store.isValidSlug(body.slug)) {
      return fail(res, 400, 'Field "slug" harus 3-16 karakter (huruf, angka, "-", "_")');
    }

    const expiresIn = body.expires_in ?? body.expires_at ?? DEFAULT_EXPIRES_IN;
    const paste = await store.createPaste({
      content,
      title: body.title,
      language: body.language,
      expiresIn,
      slug: body.slug,
    });

    return ok(
      res,
      {
        id: paste.id,
        slug: paste.slug,
        title: paste.title,
        language: paste.language,
        size_bytes: Number(paste.size_bytes),
        views: paste.views,
        created_at: paste.created_at,
        expires_at: paste.expires_at,
        ...linksFor(paste.slug),
      },
      201
    );
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------
 *  GET /api/pastes  → GET ALL (tanpa content)
 *  query: ?limit=50 &offset=0 &order=newest|oldest|popular|az
 * ------------------------------------------------------------ */

app.get('/api/pastes', async (req, res, next) => {
  try {
    const { rows, total, limit, offset, order } = await store.getAllPastes({
      limit: req.query.limit,
      offset: req.query.offset,
      order: req.query.order,
      includeExpired: req.query.include_expired === 'true',
    });

    return ok(res, rows, 200, {
      meta: {
        total,
        count: rows.length,
        limit,
        offset,
        order,
        has_more: offset + rows.length < total,
      },
    });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------
 *  GET /api/pastes/:slug  → GET BY (dengan content)
 * ------------------------------------------------------------ */

app.get('/api/pastes/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!store.isValidSlug(slug)) return fail(res, 400, 'Format slug tidak valid');

    const paste = await store.getPasteBySlug(slug, { countView: req.query.count !== 'false' });
    if (!paste) return notFound(res, slug);

    return ok(res, {
      id: paste.id,
      slug: paste.slug,
      title: paste.title,
      language: paste.language,
      content: paste.content,
      size_bytes: Number(paste.size_bytes),
      views: paste.views,
      created_at: paste.created_at,
      updated_at: paste.updated_at,
      expires_at: paste.expires_at,
      ...linksFor(paste.slug),
    });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------
 *  DELETE /api/pastes/:slug  → DELETE BY
 * ------------------------------------------------------------ */

app.delete('/api/pastes/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!store.isValidSlug(slug)) return fail(res, 400, 'Format slug tidak valid');

    const deleted = await store.deletePasteBySlug(slug);
    if (!deleted) return notFound(res, slug);

    return ok(res, { deleted: true, slug: deleted.slug, title: deleted.title, created_at: deleted.created_at });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------
 *  Health + permalink halaman HTML
 * ------------------------------------------------------------ */

app.get('/api/health', async (req, res) => {
  try {
    const info = await db.testConnection();
    return ok(res, { status: 'up', database: { connected: true, ...info, version: undefined } });
  } catch (err) {
    return fail(res, 503, 'Database tidak bisa diakses', { reason: err.message });
  }
});

// /p/xxxx → halaman viewer (public/index.html yang membaca slug dari URL)
app.get('/p/:slug', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

/* ------------------------------------------------------------
 *  Fallback 404 & error handler
 * ------------------------------------------------------------ */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return fail(res, 404, `Endpoint ${req.method} ${req.path} tidak ada`);
  return res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, _next) => {
  // JSON body rusak / terlalu besar dari express.json()
  if (err.type === 'entity.too.large') return fail(res, 413, 'Body request terlalu besar');
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'Body JSON tidak valid');
  if (err.code === '23514') return fail(res, 400, 'Data melanggar aturan validasi database', { constraint: err.constraint });
  if (err.code === '23505') return fail(res, 409, 'Data sudah ada (duplikat)', { constraint: err.constraint });
  if (err.code === '22P02') return fail(res, 400, 'Format data tidak sesuai tipe kolom');

  const status = err.statusCode || err.status || 500;
  if (status >= 500) console.error('[error]', err);
  return fail(res, status, status >= 500 ? 'Internal server error' : err.message);
});

/* ------------------------------------------------------------
 *  Start
 * ------------------------------------------------------------ */

async function start() {
  const t0 = Date.now();
  try {
    const info = await db.testConnection();
    console.log(`[db] terhubung ke ${db.config.user}@${db.config.host}:${db.config.port}/${db.config.database} (PostgreSQL ${String(info.version).split(' ')[1]}) — ${Date.now() - t0}ms`);

    if (process.env.AUTO_MIGRATE !== 'false') {
      await db.initSchema();
      console.log(`[db] schema.sql dijalankan (idempotent) — ${Date.now() - t0}ms`);
    }

    const purged = await store.deleteExpiredPastes();
    if (purged) console.log(`[db] ${purged} paste kedaluwarsa dibersihkan`);

    return app.listen(PORT, () => {
      console.log(`[web] pastebin jalan di http://localhost:${PORT}  (UI: / , permalink: /p/<slug>)`);
    });
  } catch (err) {
    console.error('[fatal] gagal start:', err.message);
    if (err.code === 'ECONNREFUSED') console.error('        → pastikan PostgreSQL jalan & DB_HOST/DB_PORT di .env benar');
    if (err.code === '3D000') console.error(`        → database "${db.config.database}" belum ada. Buat dulu: createdb -U ${db.config.user} ${db.config.database}`);
    if (err.code === '28P01') console.error('        → password DB salah (cek DB_PASSWORD di .env)');
    process.exitCode = 1;
    return null;
  }
}

if (require.main === module) start();

module.exports = { app, start };
