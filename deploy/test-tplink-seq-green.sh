#!/usr/bin/env bash
# Sequence-number sweep: sends "light 1 GREEN" with every sequence number 0-255
# from the TP-Link adapter (~30 s), printing each. If the light turns red,
# note the number shown at that moment: the lights only accept newer numbers.
#   sudo bash ~/christmas-lights/deploy/test-tplink-seq.sh
set -u
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo:  sudo bash $0"; exit 1; }
ENC="node $(dirname "$0")/../tools/fastcon.js"
ADDR=58:D8:12:36:D0:B5
HCI=$(hciconfig | awk -v a="$ADDR" '/^hci/{h=$1} $0~a{sub(":","",h); print h}')
[ -n "$HCI" ] || { echo "TP-Link adapter ($ADDR) not found"; exit 1; }
hciconfig "$HCI" up; hciconfig "$HCI" reset; sleep 1
# Show whether the controller accepts the legacy advertising commands at all.
st() { hcitool -i "$HCI" cmd 0x08 "$@" | awk '/^> HCI Event/{e=1} e && /^  /{print $NF; exit}'; }
echo "params: $(st 0x0006 20 00 20 00 03 00 00 00 00 00 00 00 00 07 00)  (last byte 00 = accepted)"
for seq in $(seq 0 255); do
  hcitool -i "$HCI" cmd 0x08 0x000A 00 >/dev/null
  hcitool -i "$HCI" cmd 0x08 0x0008 1f $($ENC 1 ff0000ff0000 "$seq") >/dev/null
  r=$(st 0x000A 01)
  printf '   seq %3d   (status %s)\n' "$seq" "$r"
  sleep 0.2
done
hcitool -i "$HCI" cmd 0x08 0x000A 00 >/dev/null
echo; echo "Done. What seq number was on screen when light 1 turned GREEN?"
