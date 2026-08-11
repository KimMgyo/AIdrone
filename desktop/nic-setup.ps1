# Configure the host end of the USB-NCM link. Requires elevation.
#
# Design decision (see README): the ESP32 runs NO DHCP server. The host side is
# a fixed address on the same /24 the soft-AP uses, so the Tello (192.168.4.x,
# leased by the ESP32's AP) and the laptop share one flat subnet and the ESP32
# just shuttles frames between the two L2 segments.
#
#   ESP32 soft-AP  192.168.4.1
#   Tello          192.168.4.x   (DHCP lease from the ESP32 AP)
#   laptop (USB)   192.168.4.50  <- this script
$ErrorActionPreference = 'Stop'

$HostIp   = '192.168.4.50'
$Prefix   = 24
$DescMatch = 'AIdrone NCM'

$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Output 'NOT ELEVATED - rerun this script from an administrator shell:'
  Write-Output '  powershell -NoProfile -ExecutionPolicy Bypass -File desktop\nic-setup.ps1'
  exit 2
}

$nic = Get-NetAdapter | Where-Object { $_.InterfaceDescription -match $DescMatch } | Select-Object -First 1
if (-not $nic) { Write-Output "no adapter matching '$DescMatch' - is the native USB cable plugged in?"; exit 1 }
Write-Output ("adapter: {0}  ifIndex={1}  mac={2}  status={3}" -f $nic.InterfaceDescription, $nic.ifIndex, $nic.MacAddress, $nic.Status)

# A plain /24 with no gateway. No gateway is deliberate: this link must never
# become a default route or Windows will try to send internet traffic at it.
Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
Remove-NetRoute -InterfaceIndex $nic.ifIndex -Confirm:$false -ErrorAction SilentlyContinue
Set-NetIPInterface -InterfaceIndex $nic.ifIndex -Dhcp Disabled
New-NetIPAddress -InterfaceIndex $nic.ifIndex -IPAddress $HostIp -PrefixLength $Prefix | Out-Null
Write-Output "ip: $HostIp/$Prefix (no gateway)"

# Windows files a brand-new unidentified network as Public, which drops inbound
# UDP. The measurement receiver and the Tello video stream are both inbound.
try {
  Set-NetConnectionProfile -InterfaceIndex $nic.ifIndex -NetworkCategory Private -ErrorAction Stop
  Write-Output 'network category: Private'
} catch {
  Write-Output "network category: could not set Private yet ($($_.Exception.Message.Split([char]10)[0]))"
}

foreach ($p in 9999, 11111, 8889) {
  $name = "AIdrone UDP $p"
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow `
    -Protocol UDP -LocalPort $p -Profile Any | Out-Null
  Write-Output "firewall: inbound UDP $p allowed"
}

Write-Output ''
Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 |
  Format-Table IPAddress, PrefixLength, InterfaceAlias -AutoSize | Out-String -Width 120
