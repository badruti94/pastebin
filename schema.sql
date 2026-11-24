-- ============================================================
--  schema.sql — skema database projek "pastebin" (PostgreSQL)
--
--  Jalankan manual:
--     createdb -U postgres pastebin          # sekali saja
--     psql -U postgres -d pastebin -f schema.sql
--
--  Atau biarkan otomatis: database.js memanggil initSchema()
--  saat server start (AUTO_MIGRATE=true). Semua statement di
--  bawah ini idempotent, jadi aman dijalankan berulang.
-- ============================================================

CREATE TABLE IF NOT EXISTS pastes (
    id          BIGSERIAL     PRIMARY KEY,
    slug        VARCHAR(16)   NOT NULL,                       -- id pendek untuk akses paste
    title       VARCHAR(200)  NOT NULL DEFAULT 'Untitled',
    language    VARCHAR(40)   NOT NULL DEFAULT 'plaintext',
    content     TEXT          NOT NULL,                       -- isi paste
    views       INTEGER       NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,                                  -- NULL = tidak pernah kedaluwarsa

    CONSTRAINT pastes_slug_key    UNIQUE (slug),
    CONSTRAINT pastes_slug_format CHECK (slug ~ '^[A-Za-z0-9_-]{3,16}$'),
    CONSTRAINT pastes_title_len   CHECK (char_length(title) <= 200),
    CONSTRAINT pastes_lang_len    CHECK (char_length(language) <= 40),
    CONSTRAINT pastes_content_len CHECK (octet_length(content) <= 1048576), -- maks 1 MB
    CONSTRAINT pastes_views_check CHECK (views >= 0)
);

-- index bantu untuk "get all" (urut terbaru) dan pembersihan paste kedaluwarsa
CREATE INDEX IF NOT EXISTS pastes_created_at_idx ON pastes (created_at DESC);
CREATE INDEX IF NOT EXISTS pastes_expires_at_idx ON pastes (expires_at);

-- ------------------------------------------------------------
--  Trigger: updated_at otomatis ikut berubah saat baris di-UPDATE
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pastes_set_updated_at ON pastes;
CREATE TRIGGER pastes_set_updated_at
    BEFORE UPDATE ON pastes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
--  QUERY REFERENSI (dipakai query.js)
-- ------------------------------------------------------------
-- INSERT ... RETURNING * ;
-- SELECT * FROM pastes WHERE slug = $1 AND (expires_at IS NULL OR expires_at > now());
-- SELECT id, slug, title, language, views, octet_length(content) AS size_bytes,
--        created_at, updated_at, expires_at FROM pastes ORDER BY created_at DESC;   -- tanpa content
-- DELETE FROM pastes WHERE slug = $1 RETURNING id;
-- DELETE FROM pastes WHERE expires_at IS NOT NULL AND expires_at <= now();
