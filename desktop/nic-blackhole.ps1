# Fault injection for the dead-datapath watchdog. Administratively downs the NCM
# adapter for a few seconds: the host stops sending, the device keeps transmitting
# and keeps seeing tud_ready() == true, which is exactly the signature of the
# Windows NCM datapath dying on its own. The firmware should notice the silence
# and bounce USB (look for "[ncm] host silent" and recov=1 on the console).
#
# Usage: nic-blackhole.ps1 [seconds]   (default 12)
# Self-elevates: Disable-NetAdapter requires admin.
$ErrorActionPreference = 'Stop'
$secs = if ($args.Count -ge 1) { [int]$args[0] } else { 12 }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'NOT ELEVATED - re-launching via UAC'
  Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, $secs
  )
  Write-Output 'elevated child returned'
  exit 0
}

$ad = Get-NetAdapter | Where-Object { $_.InterfaceDescription -match 'AIdrone' }
if (-not $ad) { Write-Output 'no AIdrone adapter present'; exit 1 }
$idx = $ad.InterfaceIndex

Write-Output "down: idx=$idx for ${secs}s"
Disable-NetAdapter -InterfaceIndex $idx -Confirm:$false
Start-Sleep -Seconds $secs

Enable-NetAdapter -InterfaceIndex $idx -Confirm:$false
Start-Sleep -Seconds 5

# Disable/enable drops the static address; nic-setup.ps1's value is re-applied.
$have = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $idx -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -eq '192.168.4.50' }
if (-not $have) {
  New-NetIPAddress -InterfaceIndex $idx -IPAddress 192.168.4.50 -PrefixLength 24 | Out-Null
  Write-Output 're-added 192.168.4.50/24'
}

$ad = Get-NetAdapter -InterfaceIndex $idx
Write-Output "up  : $($ad.Status) $($ad.LinkSpeed)"
