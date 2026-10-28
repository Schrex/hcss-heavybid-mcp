#!/bin/sh
# Prompts for the connector sign-in password (hidden, typed twice) and stores only its
# PBKDF2 hash as the ACCESS_PASSWORD_HASH Worker secret. The password never leaves this machine.
set -e
cd "$(dirname "$0")/.."
hash=$(python3 -I -c '
import base64, getpass, hashlib, os, sys
p = getpass.getpass("Connector password: ")
if p != getpass.getpass("Again: "): sys.exit("Passwords do not match")
if len(p) < 12: sys.exit("Use at least 12 characters (20+ random recommended)")
s = os.urandom(16)
print("pbkdf2$30000$" + base64.b64encode(s).decode() + "$" + base64.b64encode(hashlib.pbkdf2_hmac("sha256", p.encode(), s, 30000)).decode())
')
printf '%s' "$hash" | npx wrangler secret put ACCESS_PASSWORD_HASH
