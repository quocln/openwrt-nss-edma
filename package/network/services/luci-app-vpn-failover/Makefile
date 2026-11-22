# SPDX-License-Identifier: GPL-2.0-only
#
# VPN -> House VPN: the whole house through one WireGuard VPN out of several,
# on the ISP connection by itself while that VPN does not answer. The page
# keeps the client files of VPN providers, puts the chosen one to use, lists
# the devices that skip the VPN and shows which way the house is routed now.
# /usr/sbin/vpn-failover does the work (the VPNs, the watchdog and the state
# the page reads); its header says how.
#
# In the image rather than installed afterwards: it needs kmod-wireguard, and a
# kernel module has to come from the build that made the kernel.

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI page for a whole-house WireGuard VPN with fallback to the ISP connection
LUCI_DESCRIPTION:=VPN -> House VPN: keeps several WireGuard client files and sends the LAN \
 through the chosen one while it answers pings, and over the ISP connection while it does \
 not. Devices on a list always use the ISP connection.
LUCI_DEPENDS:=+luci-base +luci-proto-wireguard +kmod-wireguard +wireguard-tools +ip-full +firewall4
LUCI_PKGARCH:=all

PKG_LICENSE:=GPL-2.0-only

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
