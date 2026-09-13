#!/usr/bin/env bash
# Approved primary-only additive TLS enablement. Never prints private keys.
set -euo pipefail
umask 077
test "$(hostname)" = ubuntu-32gb-fsn1-1
K=(kubectl -n kimibuilt)
test "$("${K[@]}" exec deployment/postgres -- psql -U kimibuilt -d kimibuilt -Atc 'SHOW ssl;')" = off
work=$(mktemp -d /root/lilly-postgres-tls.XXXXXX)
printf 'Private certificate directory: %s\n' "$work"
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 -subj '/CN=Lilly PostgreSQL CA' -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null
openssl req -new -newkey rsa:3072 -nodes -subj '/CN=postgres.kimibuilt.svc.cluster.local' -keyout "$work/server.key" -out "$work/server.csr" 2>/dev/null
printf '%s\n' 'subjectAltName=DNS:postgres,DNS:postgres.kimibuilt,DNS:postgres.kimibuilt.svc,DNS:postgres.kimibuilt.svc.cluster.local,IP:10.43.84.112' 'extendedKeyUsage=serverAuth' > "$work/server.ext"
test "$("${K[@]}" get svc postgres -o jsonpath='{.spec.clusterIP}')" = 10.43.84.112
openssl x509 -req -in "$work/server.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial -days 365 -sha256 -extfile "$work/server.ext" -out "$work/server.crt" 2>/dev/null
"${K[@]}" exec deployment/postgres -- test ! -e /var/lib/postgresql/data/lilly-tls
"${K[@]}" exec deployment/postgres -- mkdir -m 700 /var/lib/postgresql/data/lilly-tls
for name in server.key server.crt ca.crt; do
  "${K[@]}" exec -i deployment/postgres -- sh -c "umask 077; cat > /var/lib/postgresql/data/lilly-tls/$name" < "$work/$name"
done
"${K[@]}" exec deployment/postgres -- chown -R 999:999 /var/lib/postgresql/data/lilly-tls
"${K[@]}" exec deployment/postgres -- psql -U kimibuilt -d kimibuilt -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/data/lilly-tls/server.crt';"
"${K[@]}" exec deployment/postgres -- psql -U kimibuilt -d kimibuilt -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/data/lilly-tls/server.key';"
"${K[@]}" exec deployment/postgres -- psql -U kimibuilt -d kimibuilt -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET ssl = 'on';"
"${K[@]}" exec deployment/postgres -- psql -U kimibuilt -d kimibuilt -v ON_ERROR_STOP=1 -c 'SELECT pg_reload_conf();'
sleep 2
test "$("${K[@]}" exec deployment/postgres -- psql -U kimibuilt -d kimibuilt -Atc 'SHOW ssl;')" = on
openssl s_client -starttls postgres -connect 10.43.84.112:5432 -CAfile "$work/ca.crt" -verify_ip 10.43.84.112 -verify_return_error </dev/null > "$work/tls-verification.txt" 2>&1
grep 'Verify return code: 0' "$work/tls-verification.txt"
printf 'TLS enabled and verified. No Pod restart. CA: %s/ca.crt\n' "$work"
