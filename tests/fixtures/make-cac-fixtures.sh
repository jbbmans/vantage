#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
DAYS=7300

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/ca.key" -out cac-ca.pem -days "$DAYS" \
  -subj "/C=US/O=U.S. Government/OU=DoD/CN=Test DoD CA-99" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

issue() { # name cn upn policies
  local name=$1 cn=$2 upn=$3 policies=$4
  cat > "$work/$name.ext" <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
subjectAltName=otherName:1.3.6.1.4.1.311.20.2.3;UTF8:${upn}
${policies:+certificatePolicies=${policies}}
EXT
  openssl req -newkey rsa:2048 -nodes -keyout "$work/$name.key" -out "$work/$name.csr" \
    -subj "/C=US/O=U.S. Government/OU=DoD/CN=${cn}" 2>/dev/null
  openssl x509 -req -in "$work/$name.csr" -CA cac-ca.pem -CAkey "$work/ca.key" -CAcreateserial \
    -CAserial "$work/ca.srl" -out "$name.pem" -days "$DAYS" -extfile "$work/$name.ext" 2>/dev/null
}

issue cac-user "AVERY.JORDAN.Q.1234567890" "1234567890@mil" "2.16.840.1.101.3.2.1.3.13,2.16.840.1.101.3.2.1.3.39"
issue other    "RIVERA.ANA.9998887770"     "9998887770@mil" ""
issue mismatch "AVERY.JORDAN.Q.1234567890" "1111111111@mil" ""
echo "Regenerated cac-ca.pem, cac-user.pem, other.pem, mismatch.pem (valid ${DAYS} days)."
