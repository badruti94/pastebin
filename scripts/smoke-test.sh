#!/usr/bin/env bash
# smoke-test.sh — uji semua endpoint pastebin terhadap server yang sedang jalan.
# Pakai:  bash scripts/smoke-test.sh [BASE_URL]      (default http://localhost:4000)
set -uo pipefail

BASE="${1:-http://localhost:4000}"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
check(){ [ "$2" = "$3" ] && ok "$1 ($2)" || bad "$1 — harap $3, dapat $2"; }

# helper: ambil field JSON pakai python3 (tanpa jq)
jget(){ python3 -c 'import sys,json;d=json.load(sys.stdin);
p=sys.argv[1].split(".");v=d
for k in p:
    v=v[int(k)] if isinstance(v,list) else v.get(k)
print(v if v is not None else "")' "$1"; }

echo "== pastebin smoke test @ $BASE =="

# 1. health
H=$(curl -s -m 5 "$BASE/api/health")
check "GET /api/health success" "$(echo "$H" | jget success)" "True"

# 2. create (auto slug)
C=$(curl -s -m 5 -X POST "$BASE/api/pastes" -H 'Content-Type: application/json' \
  -d '{"title":"uji otomatis","language":"bash","content":"echo \"halo pastebin\"","expires_in":"1h"}')
SLUG=$(echo "$C" | jget data.slug)
echo "     slug dibuat: $SLUG"
[ -n "$SLUG" ] && ok "POST /api/pastes → slug terisi" || bad "POST /api/pastes tidak mengembalikan slug"

# 3. create dengan slug sendiri
CS=$(curl -s -m 5 -X POST "$BASE/api/pastes" -H 'Content-Type: application/json' \
  -d '{"title":"slug tetap","content":"baris satu\nbaris dua","slug":"uji-slug-tetap"}')
check "POST /api/pastes slug kustom" "$(echo "$CS" | jget data.slug)" "uji-slug-tetap"

# 4. get by (ada content)
G=$(curl -s -m 5 "$BASE/api/pastes/$SLUG")
check "GET /api/pastes/:slug title" "$(echo "$G" | jget data.title)" "uji otomatis"
check "GET /api/pastes/:slug content" "$(echo "$G" | jget data.content)" 'echo "halo pastebin"'
V1=$(echo "$G" | jget data.views); V2=$(curl -s -m 5 "$BASE/api/pastes/$SLUG" | jget data.views)
[ "$V2" -gt "$V1" ] && ok "views naik saat diakses ($V1 → $V2)" || bad "views tidak naik ($V1 → $V2)"

# 5. get all (tanpa content)
A=$(curl -s -m 5 "$BASE/api/pastes?limit=5&order=newest")
echo "$A" | grep -q '"content"' && bad "GET /api/pastes memuat field content" || ok "GET /api/pastes tanpa field content"
TOTAL=$(echo "$A" | jget meta.total); COUNT=$(python3 -c 'import sys,json;print(len(json.load(sys.stdin)["data"]))' <<<"$A")
echo "     total=$TOTAL count=$COUNT"
[ "$TOTAL" -ge 2 ] && ok "meta.total terisi ($TOTAL)" || bad "meta.total salah ($TOTAL)"
[ "$COUNT" -ge 2 ] && ok "jumlah data sesuai ($COUNT)" || bad "jumlah data salah ($COUNT)"

# 6. validasi
check "POST content kosong → 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/pastes" -H 'Content-Type: application/json' -d '{"content":"  "}')" "400"
check "POST expires_in ngawur → 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/pastes" -H 'Content-Type: application/json' -d '{"content":"x","expires_in":"5 tahun"}')" "400"
check "GET slug format salah → 400" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/pastes/a")" "400"
check "GET slug tak ada → 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/pastes/zzzz9999")" "404"

# 7. paste kedaluwarsa
EXP=$(curl -s -m 5 -X POST "$BASE/api/pastes" -H 'Content-Type: application/json' \
  -d "{\"content\":\"sudah lewat\",\"expires_at\":\"$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)\"}")
ES=$(echo "$EXP" | jget data.slug)
check "paste kedaluwarsa → 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/pastes/$ES")" "404"

# 8. halaman HTML /p/:slug
check "GET /p/:slug → 200 HTML" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/p/$SLUG")" "200"
check "GET / → 200 HTML" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" "200"

# 9. delete by
check "DELETE /api/pastes/:slug" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/pastes/$SLUG")" "200"
check "GET setelah delete → 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/pastes/$SLUG")" "404"
check "DELETE slug tak ada → 404" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/pastes/zzzz9999")" "404"

# bersihkan sisa
curl -s -o /dev/null -X DELETE "$BASE/api/pastes/uji-slug-tetap"

echo
echo "hasil: $PASS lulus, $FAIL gagal"
[ "$FAIL" -eq 0 ] || exit 1
