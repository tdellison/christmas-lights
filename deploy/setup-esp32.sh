#!/usr/bin/env bash
# One-time prep before flashing an ESP32. Run with sudo:
#   sudo bash ~/christmas-lights/deploy/setup-esp32.sh
#
# 1. Copies the Wi-Fi name + password this server has saved (netplan) into
#    deploy/secrets.yaml, without printing the password.
# 2. Makes up an OTA (over-the-air update) password if it's still the example.
# 3. Lets the owner use USB serial ports (dialout group) to flash the ESP32.
set -euo pipefail

OWNER="${SUDO_USER:-tdellison}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SECRETS="$HERE/secrets.yaml"
NETPLAN=/etc/netplan/60-wifi.yaml

[ "$(id -u)" -eq 0 ] || { echo "Run it with sudo:  sudo bash $0"; exit 1; }
[ -f "$SECRETS" ] || cp "$HERE/secrets.example.yaml" "$SECRETS"

# Wi-Fi name + password from netplan (first access point found), written
# straight into secrets.yaml by Python so nothing passes through the shell.
SSID="$(python3 - "$NETPLAN" "$SECRETS" <<'PY'
import sys, re, secrets as rnd
netplan, path = sys.argv[1:3]
txt = open(netplan).read()
ssid = pw = None
try:
    import yaml
    d = yaml.safe_load(txt) or {}
    for iface in ((d.get('network') or {}).get('wifis') or {}).values():
        for name, ap in ((iface or {}).get('access-points') or {}).items():
            ap = ap or {}
            ssid, pw = str(name), str(ap.get('password') or (ap.get('auth') or {}).get('password') or '')
            break
        if ssid: break
except Exception:
    pass
if not ssid:
    sys.exit(0)
q = lambda s: '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
out = open(path).read()
out = re.sub(r'(?m)^wifi_ssid:.*$', lambda m: 'wifi_ssid: ' + q(ssid), out)
out = re.sub(r'(?m)^wifi_password:.*$', lambda m: 'wifi_password: ' + q(pw), out)
if re.search(r'(?m)^ota_password:\s*"pick-something"', out):
    out = re.sub(r'(?m)^ota_password:.*$', lambda m: 'ota_password: ' + q(rnd.token_urlsafe(12)), out)
open(path, 'w').write(out)
print(ssid)
PY
)"
[ -n "$SSID" ] || { echo "Couldn't find a Wi-Fi network in $NETPLAN. Fill in deploy/secrets.yaml by hand."; exit 1; }
chown "$OWNER": "$SECRETS"; chmod 600 "$SECRETS"
echo "Wi-Fi \"$SSID\" written to deploy/secrets.yaml (password hidden)."

# USB serial access for flashing.
if id -nG "$OWNER" | tr ' ' '\n' | grep -qx dialout; then
  echo "$OWNER can already use USB serial ports."
else
  usermod -aG dialout "$OWNER"
  echo "Added $OWNER to dialout (USB serial). Takes effect on next login."
fi
# Right now, without logging out: open any plugged-in ESP32 port to the owner.
# (resets when it's unplugged; the dialout group covers it from next login).
for p in /dev/ttyUSB* /dev/ttyACM*; do [ -e "$p" ] && chmod a+rw "$p" && echo "Opened $p for flashing."; done
echo "Done. Tell Claude it's ready to flash."
