#!/usr/bin/env bash
# One-shot test: can the server's TP-Link USB Bluetooth adapter drive the
# BRMesh lights directly (no ESP32)? Uses raw legacy advertising (the same
# 31-byte message the ESP32 sends, proven byte-identical to the BRMesh app's).
#   sudo bash ~/christmas-lights/deploy/test-tplink-ble.sh
# Watch the lights: both RED, then GREEN, then OFF, ~4 s each.
set -u
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo:  sudo bash $0"; exit 1; }
ENC="node $(dirname "$0")/../tools/fastcon.js"
ADDR=58:D8:12:36:D0:B5                    # the TP-Link UB500
HCI=$(hciconfig | awk -v a="$ADDR" '/^hci/{h=$1} $0~a{sub(":","",h); print h}')
[ -n "$HCI" ] || { echo "TP-Link adapter ($ADDR) not found"; exit 1; }
echo "Using $HCI"
hciconfig "$HCI" up
hciconfig "$HCI" reset                     # clear any extended-advertising state so legacy commands are allowed
sleep 1
cmd() { hcitool -i "$HCI" cmd 0x08 "$@" >/dev/null; }
seq=$(( (RANDOM % 150) + 60 ))
send() {   # light id, light data hex, seconds
  cmd 0x000A 00                                                          # advertising off
  cmd 0x0006 20 00 30 00 03 00 00 00 00 00 00 00 00 07 00                # 20-30 ms, non-connectable, all channels
  cmd 0x0008 1f $($ENC "$1" "$2" "$seq")                                 # the message
  cmd 0x000A 01                                                          # advertising on
  seq=$(( (seq + 1) % 256 )); sleep "$3"
}
for step in "RED ff00ff000000" "GREEN ff0000ff0000" "OFF 00"; do
  set -- $step
  echo "$1..."
  send 1 "$2" 1.5; send 2 "$2" 1.5
  sleep 1
done
cmd 0x000A 00
echo "Done. Did the lights go red, then green, then off?"
