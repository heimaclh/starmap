#!/usr/bin/env bash
# 一键开启手机访问：
#   1. 自动配置 Windows 端口转发（WSL2 网络需要，会弹一次 UAC 窗口，点"是"）
#   2. 启动局域网管理台并打印手机访问地址 + 访问码
# 用法： ./mobile.sh
set -u
cd "$(dirname "$0")"

WSL_IP=$(hostname -I | awk '{print $1}')
echo "✦ WSL 内网 IP: $WSL_IP"

WIN_IP=""
if command -v powershell.exe >/dev/null 2>&1; then
  WIN_IP=$(powershell.exe -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.InterfaceAlias -notmatch 'Loopback|vEthernet|WSL' -and \$_.IPAddress -notmatch '^169' } | Select-Object -First 1).IPAddress" 2>/dev/null | tr -d '\r\n ')
fi

# 尝试以管理员权限自动配置端口转发 + 防火墙（只弹一次 UAC；先删旧规则保证可重复运行）
if command -v powershell.exe >/dev/null 2>&1; then
  echo "✦ 正在请求管理员权限配置端口转发（Windows 会弹 UAC 窗口，请点「是」）…"
  powershell.exe -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command','netsh interface portproxy delete v4tov4 listenport=8123 2>NUL; netsh interface portproxy delete v4tov4 listenport=8124 2>NUL; netsh interface portproxy add v4tov4 listenport=8123 connectaddress=$WSL_IP connectport=8123; netsh interface portproxy add v4tov4 listenport=8124 connectaddress=$WSL_IP connectport=8124; Remove-NetFirewallRule -DisplayName starmap -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName starmap -Direction Inbound -LocalPort 8123-8124 -Protocol TCP -Action Allow; exit'" 2>/dev/null || true
  sleep 2
fi

echo
if [ -n "$WIN_IP" ]; then
  echo "┌──────────── 手机（同一 Wi-Fi）────────────┐"
  echo "│  管理台:  http://$WIN_IP:8124"
  echo "│  预览:    http://$WIN_IP:8123"
  echo "└───────────────────────────────────────────┘"
else
  echo "⚠ 未能自动获取 Windows IP，请在手机浏览器访问：http://<电脑的局域网IP>:8124"
  echo "  （电脑 IP 可在 Windows 的 设置→网络 里查看）"
fi
echo "  首次打开会要求输入访问码（下方启动时打印的 6 位数字）"
echo

exec python3 -u admin.py --lan
