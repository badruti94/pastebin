# Pastebin — Express + PostgreSQL

Pastebin sederhana: simpan teks/kode, akses lewat slug pendek.

## Struktur

```
pastebin/
├── .gitignore        # node_modules, .env, log, dll
├── .env              # kredensial DB + port server (tidak di-commit)
├── .env.example      # contoh isi .env
├── schema.sql        # skema tabel `pastes` + index + trigger updated_at
├── database.js       # konfigurasi & connection pool PostgreSQL (+ initSchema)
├── query.js          # semua SQL (insert/select/delete) + helper slug & expiry
├── app.js            # endpoint Express
├── package.json
└── public/
    └── index.html    # UI (buat, jelajah, lihat, hapus) — 1 file, tanpa build
```

## Setup

```bash
cd ~/pastebin
npm install

# buat database (sekali saja)
createdb -U postgres pastebin          # atau: psql -U postgres -c 'CREATE DATABASE pastebin;'

npm start                              # http://localhost:4000
```

`app.js` otomatis menjalankan `schema.sql` saat start (idempotent), jadi tabel dibuat sendiri.
Mau manual: `psql -U postgres -d pastebin -f schema.sql`.

## Endpoint

| Method | Path | Keterangan |
|---|---|---|
| POST | `/api/pastes` | **create** — body `{content*, title?, language?, expires_in?, slug?}` |
| GET | `/api/pastes/:slug` | **get by** — isi lengkap, `views` bertambah 1 |
| GET | `/api/pastes` | **get all** — metadata saja, **tanpa content** (`?limit&offset&order=newest\|oldest\|popular\|az`) |
| DELETE | `/api/pastes/:slug` | **delete by** |
| GET | `/api/health` | cek server + DB |
| GET | `/p/:slug` | halaman HTML untuk melihat paste |

`expires_in` menerima `30` (menit), `10m`, `2h`, `7d`, `2w`, atau tanggal ISO.

## Contoh curl

```bash
# create
curl -sX POST localhost:4000/api/pastes -H 'Content-Type: application/json' \
  -d '{"title":"contoh","language":"bash","content":"echo halo","expires_in":"1d"}'

# get by
curl -s localhost:4000/api/pastes/<slug>

# get all (tanpa content)
curl -s 'localhost:4000/api/pastes?limit=20&order=newest'

# delete by
curl -sX DELETE localhost:4000/api/pastes/<slug>
```

## Bentuk respons

```json
// create → 201
{ "success": true, "data": { "slug": "Ab3xY9zQ", "url": "/p/Ab3xY9zQ", "api_url": "/api/pastes/Ab3xY9zQ", "...": "..." } }

// get by → 200
{ "success": true, "data": { "slug": "Ab3xY9zQ", "title": "contoh", "content": "echo halo", "views": 3, "...": "..." } }

// get all → 200 (tidak ada field content)
{ "success": true, "data": [ { "slug": "Ab3xY9zQ", "title": "contoh", "size_bytes": 9, "views": 3 } ],
  "meta": { "total": 1, "count": 1, "limit": 50, "offset": 0, "order": "newest", "has_more": false } }

// error → 4xx/5xx
{ "success": false, "error": "Paste dengan slug \"xxx\" tidak ditemukan" }
```

Potongan teks di preview/daftar **tidak** ikut dikirim; hanya `size_bytes`.
