# Rebuild the NCM adapter INSTANCE, for the wedge that nothing softer clears.
#
# Escalation ladder for "device says usb=up, Windows says Disconnected / 0 bps",
# in the order to try it. Everything above this script is already measured (see
# firmware/src/ncm.cpp, kBounceDetachMs):
#
#   50 ms USB bounce        - no
#   ESP.restart()           - no
#   Restart-NetAdapter      - no   (desktop/nic-restart.ps1)
#   3 s / 12 s USB detach   - no
#   reflash (~12 s in ROM)  - no   (it used to work; it stopped)
#   THIS: drop the device node and let PnP build a new one - the one thing that
#         was never tried, and the only remaining suspect: the failure follows
#         the Windows adapter instance, not the device.
#
# Disable/Enable first because it is reversible and keeps the instance's static
# IP. Only if that leaves it Disconnected does it remove the node, which forces
# PnP to create a fresh adapter on the next enumeration - and loses the static
# address, so it is re-added here.
#
# Self-elevates: every verb below needs admin. The elevated child writes to a
# log the parent prints, because a UAC child gets its own console.
param([switch]$Force)
$ErrorActionPreference = 'Stop'

$log = Join-Path $env:TEMP 'aidrone-nic-rebuild.log'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  if (Test-Path $log) { Remove-Item $log -Force }
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($Force) { $argv += '-Force' }
  Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList $argv
  if (Test-Path $log) { Get-Content $log } else { Write-Output 'elevated child produced no log' }
  exit 0
}

function Say([string]$text) {
  Write-Output $text
  Add-Content -Path $log -Value $text
}

function Get-Ncm {
  Get-PnpDevice -Class Net -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -match 'AIdrone' } | Select-Object -First 1
}

function Get-State {
  $ad = Get-NetAdapter -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceDescription -match 'AIdrone' } | Select-Object -First 1
  if (-not $ad) { return $null }
  [pscustomobject]@{
    Index = $ad.InterfaceIndex; Name = $ad.Name
    Status = $ad.Status; Media = $ad.MediaConnectionState; Speed = $ad.LinkSpeed
  }
}

function Restore-Ip([int]$index) {
  # The ESP32 runs no DHCP server on the USB leg, so the host address is static
  # (desktop/nic-setup.ps1). A rebuilt instance comes back without it.
  $have = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $index -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -eq '192.168.4.50' }
  if ($have) { Say '192.168.4.50/24 already present'; return }
  New-NetIPAddress -InterfaceIndex $index -IPAddress 192.168.4.50 -PrefixLength 24 -ErrorAction Stop | Out-Null
  Say 're-added 192.168.4.50/24'
}

$before = Get-State
if (-not $before) { Say 'no AIdrone adapter present - plug the node in first'; exit 1 }
Say "before : $($before.Name) idx=$($before.Index) $($before.Status) $($before.Media) $($before.Speed)"

# --- rung 1: bounce the device node, keeping the instance ---------------------
$dev = Get-Ncm
if (-not $dev) { Say 'no AIdrone NCM PnP device'; exit 1 }
Say "device : $($dev.InstanceId)"

Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false
Start-Sleep -Seconds 2
Enable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false
Start-Sleep -Seconds 6

$mid = Get-State
if ($mid) {
  Say "cycled : $($mid.Status) $($mid.Media) $($mid.Speed)"
  if ($mid.Status -eq 'Up') {
    Restore-Ip $mid.Index
    Say 'RECOVERED by disable/enable'
    exit 0
  }
}

# --- rung 2: drop the instance and let PnP build a new one --------------------
Say 'still down - removing the device node so PnP rebuilds the adapter'
& pnputil /remove-device "$($dev.InstanceId)" 2>&1 | ForEach-Object { Say "  $_" }
Start-Sleep -Seconds 2
& pnputil /scan-devices 2>&1 | ForEach-Object { Say "  $_" }
Start-Sleep -Seconds 8

$after = Get-State
if (-not $after) {
  Say 'adapter gone - unplug the node and plug it back in to let PnP enumerate it fresh'
  exit 2
}
Say "after  : $($after.Name) idx=$($after.Index) $($after.Status) $($after.Media) $($after.Speed)"
if ($after.Status -eq 'Up') {
  Restore-Ip $after.Index
  Say 'RECOVERED by instance rebuild'
  exit 0
}
Restore-Ip $after.Index
Say 'STILL DOWN after a full instance rebuild'
exit 3
