# Bounce the NCM adapter and restore the static host IP. Needed because the
# Windows NCM datapath can go Disconnected (LinkSpeed 0) while the ESP32 still
# reports `usb=up` and keeps accepting frames -- see README "link_up() lies".
# Self-elevates: Restart-NetAdapter and New-NetIPAddress both require admin.
$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'NOT ELEVATED - re-launching via UAC'
  Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath
  )
  Write-Output 'elevated child returned'
  exit 0
}

$ad = Get-NetAdapter | Where-Object { $_.InterfaceDescription -match 'AIdrone' }
if (-not $ad) { Write-Output 'no AIdrone adapter present'; exit 1 }

Write-Output "before: $($ad.Name) idx=$($ad.InterfaceIndex) $($ad.Status) $($ad.LinkSpeed)"
Restart-NetAdapter -InterfaceIndex $ad.InterfaceIndex
Start-Sleep -Seconds 4

$ad = Get-NetAdapter -InterfaceIndex $ad.InterfaceIndex
Write-Output "after : $($ad.Name) idx=$($ad.InterfaceIndex) $($ad.Status) $($ad.LinkSpeed)"

# The ESP32 runs no DHCP server, so the host address is static (see nic-setup.ps1).
$have = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $ad.InterfaceIndex |
  Where-Object { $_.IPAddress -eq '192.168.4.50' }
if (-not $have) {
  New-NetIPAddress -InterfaceIndex $ad.InterfaceIndex -IPAddress 192.168.4.50 -PrefixLength 24 | Out-Null
  Write-Output 're-added 192.168.4.50/24'
} else {
  Write-Output '192.168.4.50/24 still present'
}

Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $ad.InterfaceIndex |
  Format-Table IPAddress, PrefixLength, AddressState -AutoSize | Out-String -Width 120 | Write-Output
