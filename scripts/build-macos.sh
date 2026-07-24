#!/usr/bin/env bash
#
# build-macos.sh — YEREL TEST İÇİN tek komut: build + sabit imza + kurulum.
#
# Neden: normalde uygulama ad-hoc imzalı derleniyor; her build'de kod imzası
# (cdhash) değişiyor. macOS, Accessibility iznini imzaya bağladığından her yeni
# kurulumda izni düşürüyor -> Settings'ten remove/add derdi.
#
# Bu script SABİT bir self-signed sertifika oluşturur (bir kez) ve her build'i
# onunla imzalar. Designated Requirement sabit kaldığından izni BİR KEZ verirsin,
# sonraki tüm build'lerde korunur.
#
# Kullanım:
#   ./scripts/build-macos.sh            # build + imzala + /Applications'a kur
#   ./scripts/build-macos.sh --no-install   # sadece build + imzala (kurma)
#
# CI/GitHub'a dokunmaz; sadece senin makinende çalışır.
#
set -euo pipefail

CERT_NAME="MKYADA Dev"
BUNDLE_ID="com.mkyada.app"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
APP_BUNDLE="$APP_DIR/src-tauri/target/release/bundle/macos/MKYADA.app"
INSTALL_DIR="/Applications"

DO_INSTALL=1
[[ "${1:-}" == "--no-install" ]] && DO_INSTALL=0

log()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
err()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

[[ "$(uname)" == "Darwin" ]] || { err "Bu script yalnızca macOS içindir."; exit 1; }

# --- 0. Gereksinimler -----------------------------------------------------
for tool in cargo npm openssl security codesign; do
  command -v "$tool" >/dev/null 2>&1 || { err "'$tool' bulunamadı. Kur ve tekrar dene."; exit 1; }
done

# --- 1. Sabit imza sertifikası (idempotent — varsa atlar) -----------------
if security find-identity -v -p codesigning | grep -q "$CERT_NAME"; then
  log "İmza sertifikası hazır: \"$CERT_NAME\""
else
  log "İlk kez: kalıcı self-signed code-signing sertifikası oluşturuluyor: \"$CERT_NAME\""
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
  PW="mkyada-dev-$$"   # geçici; sadece p12 taşımak için, hiçbir yere kaydedilmez
  cat > "$WORK/ext.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $CERT_NAME
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/ext.cnf" 2>/dev/null
  # macOS `security` yalnızca legacy PKCS12'yi (3DES + SHA1 MAC) okuyabiliyor;
  # OpenSSL 3.x'in AES/SHA-256 varsayılanında private key sessizce düşer.
  openssl pkcs12 -export -legacy -macalg sha1 \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES \
    -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -name "$CERT_NAME" -passout "pass:$PW" -out "$WORK/cert.p12" 2>/dev/null
  security import "$WORK/cert.p12" -k "$LOGIN_KEYCHAIN" -P "$PW" -T /usr/bin/codesign >/dev/null
  security add-trusted-cert -r trustRoot -p codeSign -k "$LOGIN_KEYCHAIN" "$WORK/cert.pem" >/dev/null
  security find-identity -v -p codesigning | grep -q "$CERT_NAME" \
    || { err "Sertifika oluşturuldu ama identity olarak görünmüyor."; exit 1; }
  ok "Sertifika oluşturuldu (10 yıl geçerli, Keychain > login içinde)."
fi

# --- 2. Build (yalnızca .app, native arm64 — hızlı) -----------------------
log "Uygulama derleniyor (npm run tauri build --bundles app)..."
if [[ ! -d "$APP_DIR/node_modules" ]]; then
  log "node_modules yok; 'npm ci' çalıştırılıyor..."
  ( cd "$APP_DIR" && npm ci )
fi
( cd "$APP_DIR" && npm run tauri build -- --bundles app )

[[ -d "$APP_BUNDLE" ]] || { err "Build çıktısı bulunamadı: $APP_BUNDLE"; exit 1; }
ok "Build tamam: $APP_BUNDLE"

# --- 3. İmzala ------------------------------------------------------------
log "Sabit sertifikayla imzalanıyor..."
# İlk seferde Keychain, private key erişimi için sorabilir -> \"Always Allow\".
codesign --force --options runtime --identifier "$BUNDLE_ID" --sign "$CERT_NAME" "$APP_BUNDLE"
DR="$(codesign -d --requirements - "$APP_BUNDLE" 2>&1 | grep -i designated | sed 's/^designated => //')"
codesign --verify --strict "$APP_BUNDLE"
ok "İmza geçerli. Designated Requirement: $DR"

# --- 4. Kur (/Applications) -----------------------------------------------
if [[ "$DO_INSTALL" == "1" ]]; then
  log "Çalışan MKYADA kapatılıyor (varsa)..."
  osascript -e 'quit app "MKYADA"' >/dev/null 2>&1 || true
  sleep 1
  log "$INSTALL_DIR/MKYADA.app güncelleniyor..."
  rm -rf "$INSTALL_DIR/MKYADA.app"
  cp -R "$APP_BUNDLE" "$INSTALL_DIR/MKYADA.app"
  xattr -cr "$INSTALL_DIR/MKYADA.app" 2>/dev/null || true
  ok "Kuruldu: $INSTALL_DIR/MKYADA.app"
fi

cat <<EOF

$(printf '\033[1;32mHazır.\033[0m')
  • İlk kez: System Settings > Privacy & Security > Accessibility'de MKYADA'ya izni BİR KEZ ver.
  • Bundan sonra bu scripti her çalıştırdığında aynı imza kullanılır -> izin KORUNUR.
    (Artık her seferinde remove/add yok.)

  Çalıştır: open "$INSTALL_DIR/MKYADA.app"
EOF
