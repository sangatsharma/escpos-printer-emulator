#!/usr/bin/env bash
# Give this machine a printer's IP so the emulator can listen on it.
#
#   scripts/ip-alias.sh add 192.168.1.201     # needs sudo
#   scripts/ip-alias.sh del 192.168.1.201
#   scripts/ip-alias.sh list
#
# Any 127.x.x.x address already works on Linux with no setup. Use this only
# when the printer record must keep a LAN-style IP. QZ Tray connects from this
# same machine, so a loopback alias is enough — nothing on the network sees it.
set -euo pipefail

action="${1:-list}"
ip="${2:-}"

case "$action" in
  add)
    [[ -n "$ip" ]] || { echo "usage: $0 add <ip>"; exit 1; }
    if [[ "$(uname)" == "Darwin" ]]; then
      sudo ifconfig lo0 alias "$ip" up
    else
      sudo ip addr add "$ip/32" dev lo
    fi
    echo "added $ip — put it in printers.json and restart the emulator"
    ;;
  del)
    [[ -n "$ip" ]] || { echo "usage: $0 del <ip>"; exit 1; }
    if [[ "$(uname)" == "Darwin" ]]; then
      sudo ifconfig lo0 -alias "$ip"
    else
      sudo ip addr del "$ip/32" dev lo
    fi
    echo "removed $ip"
    ;;
  list)
    if [[ "$(uname)" == "Darwin" ]]; then ifconfig lo0 | grep inet; else ip -4 addr show dev lo; fi
    ;;
  *)
    echo "usage: $0 add|del|list [ip]"; exit 1
    ;;
esac
