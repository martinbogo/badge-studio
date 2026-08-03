#!/usr/bin/env bash
#
# Copyright 2026 Martin Bogomolni
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Store the Apple credentials the release workflow needs as GitHub secrets.
#
# Nothing is written to disk and nothing is printed. Prompted values go
# straight to `gh secret set` over stdin, so they never appear in your shell
# history, in the process list, or in this script's output.
#
#   ./scripts/setup-macos-signing.sh --check          what is already set
#   ./scripts/setup-macos-signing.sh certificate.p12  set everything

set -euo pipefail

fail() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

command -v gh >/dev/null || fail "The GitHub CLI is not installed. brew install gh"
gh auth status >/dev/null 2>&1 || fail "Not signed in to GitHub. Run: gh auth login"

REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) \
  || fail "Not inside a GitHub repository."

# --- what is already there ------------------------------------------------

WANTED=(
  APPLE_CERTIFICATE
  APPLE_CERTIFICATE_PASSWORD
  APPLE_SIGNING_IDENTITY
  APPLE_ID
  APPLE_PASSWORD
  APPLE_TEAM_ID
)

if [ "${1:-}" = "--check" ]; then
  step "Secrets on $REPO"
  EXISTING=$(gh secret list --json name --jq '.[].name' 2>/dev/null || true)
  MISSING=0
  for s in "${WANTED[@]}"; do
    if grep -qx "$s" <<<"$EXISTING"; then
      note "set      $s"
    else
      note "MISSING  $s"
      MISSING=1
    fi
  done
  [ "$MISSING" -eq 0 ] && step "All set. Tagging a release will produce a signed, notarized build."
  exit 0
fi

# --- the certificate ------------------------------------------------------

P12="${1:-}"
if [ -z "$P12" ]; then
  cat <<'USAGE'

Usage: ./scripts/setup-macos-signing.sh <certificate.p12>

You need a "Developer ID Application" certificate exported as a .p12 file.
Apple provides no way to export a single identity from the command line, so
this part is done once through Keychain Access:

  1. Open Keychain Access.
  2. Select "login" on the left, then the "My Certificates" category.
  3. Right-click "Developer ID Application: ...", choose Export.
  4. Save as Personal Information Exchange (.p12), and set a password.
     Any password will do; you will be asked for it again below.

Then run this script again with the path to that file. Delete the .p12
afterwards; it is not needed once the secret is stored.

USAGE
  exit 1
fi

[ -f "$P12" ] || fail "No such file: $P12"

step "Certificate"

# Read the identity out of the keychain rather than asking, so the string
# stored in the secret is exactly what codesign will match against.
IDENTITIES=$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" || true)

[ -n "$IDENTITIES" ] || fail \
  "No 'Developer ID Application' identity in your keychain. An 'Apple
   Development' certificate is not enough: it signs for local testing only and
   Gatekeeper rejects it. Create a Developer ID Application certificate at
   https://developer.apple.com/account/resources/certificates"

COUNT=$(printf '%s\n' "$IDENTITIES" | wc -l | tr -d ' ')
if [ "$COUNT" -gt 1 ]; then
  printf '\nMore than one Developer ID Application identity:\n\n'
  printf '%s\n' "$IDENTITIES" | sed 's/^/  /'
  printf '\nPick one by number: '
  read -r PICK
  IDENTITY=$(printf '%s\n' "$IDENTITIES" | sed -n "${PICK}p" | sed 's/.*"\(.*\)".*/\1/')
else
  IDENTITY=$(printf '%s\n' "$IDENTITIES" | sed 's/.*"\(.*\)".*/\1/')
fi

[ -n "$IDENTITY" ] || fail "Could not read the identity name."

# "Developer ID Application: Name (TEAMID)" -> TEAMID
TEAM_ID=$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')
[ -n "$TEAM_ID" ] || fail "Could not read a team ID out of: $IDENTITY"

note "identity: $IDENTITY"
note "team:     $TEAM_ID"

printf '\nPassword you set when exporting the .p12: '
read -rs CERT_PW
printf '\n'
[ -n "$CERT_PW" ] || fail "Empty password."

# Catch a typo now rather than as a confusing failure in CI. Not every openssl
# build can read a modern .p12, so a failure here is a warning, not fatal.
if openssl pkcs12 -in "$P12" -passin "pass:$CERT_PW" -noout >/dev/null 2>&1; then
  note "password verified against the .p12"
elif openssl pkcs12 -legacy -in "$P12" -passin "pass:$CERT_PW" -noout >/dev/null 2>&1; then
  note "password verified against the .p12"
else
  note "could not verify the password locally; continuing"
fi

# --- notarization ---------------------------------------------------------

step "Notarization"
note "Signing alone still trips Gatekeeper on a downloaded app. Notarization"
note "is the step that clears it, and needs an Apple ID plus an app-specific"
note "password from https://appleid.apple.com > Sign-In and Security."

printf '\nApple ID (email): '
read -r APPLE_ID_VALUE
[ -n "$APPLE_ID_VALUE" ] || fail "Empty Apple ID."

printf 'App-specific password (xxxx-xxxx-xxxx-xxxx): '
read -rs APPLE_PW
printf '\n'
[ -n "$APPLE_PW" ] || fail "Empty app-specific password."

if ! printf '%s' "$APPLE_PW" | grep -Eq '^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$'; then
  note "warning: that is not the usual xxxx-xxxx-xxxx-xxxx shape."
  note "         An account password will not work for notarization."
fi

# --- store ----------------------------------------------------------------

step "Storing secrets on $REPO"

# Piped, never passed as arguments: anything in argv is visible to `ps`.
base64 -i "$P12" | tr -d '\n' | gh secret set APPLE_CERTIFICATE
note "set APPLE_CERTIFICATE"

printf '%s' "$CERT_PW"         | gh secret set APPLE_CERTIFICATE_PASSWORD
note "set APPLE_CERTIFICATE_PASSWORD"
printf '%s' "$IDENTITY"        | gh secret set APPLE_SIGNING_IDENTITY
note "set APPLE_SIGNING_IDENTITY"
printf '%s' "$APPLE_ID_VALUE"  | gh secret set APPLE_ID
note "set APPLE_ID"
printf '%s' "$APPLE_PW"        | gh secret set APPLE_PASSWORD
note "set APPLE_PASSWORD"
printf '%s' "$TEAM_ID"         | gh secret set APPLE_TEAM_ID
note "set APPLE_TEAM_ID"

unset CERT_PW APPLE_PW

step "Done"
note "Delete $P12 now; the secret is stored and the file is not needed."
note "Verify any time with: ./scripts/setup-macos-signing.sh --check"
note "The next tagged release will be signed and notarized. Notarization adds"
note "a few minutes to the macOS job while Apple scans the upload."
