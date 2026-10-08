#!/bin/sh
# Netzschutz fuer Kais Aussen-Container: nur oeffentliches Web, das GANZE
# Heimnetz gesperrt - ohne Ausnahme. Auch ein eigener ntfy-Server muss deshalb
# ueber eine oeffentliche Adresse erreichbar sein, nicht ueber eine LAN-IP.
# Kai teilt sich den Netz-Namespace dieses Containers.
iptables -P OUTPUT ACCEPT 2>/dev/null
iptables -F OUTPUT 2>/dev/null
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  iptables -A OUTPUT -d "$net" -j REJECT --reject-with icmp-admin-prohibited
done

# IPv6: alles Private/Lokale sperren (WhatsApp laeuft ueber IPv4).
ip6tables -F OUTPUT 2>/dev/null
ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null
for n6 in fc00::/7 fe80::/10; do
  ip6tables -A OUTPUT -d "$n6" -j REJECT 2>/dev/null
done

echo "[firewall] aktiv: GESAMTES Heimnetz gesperrt, nur oeffentliches Web erlaubt"
iptables -S OUTPUT
exec sleep infinity
