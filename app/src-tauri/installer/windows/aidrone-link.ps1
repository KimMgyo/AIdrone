<#
  Host-side configuration for the AIdrone USB-NCM link.

  README's "Host NIC setup - required once" recipe cannot be shipped verbatim:
  it names the adapter by InterfaceAlias ('Ethernet 2'), and that alias is
  handed out by Windows per machine and per USB port. The one thing that is
  fixed is the node's hardware id, burned into the firmware descriptor, so
  that is what this script keys off.

  The installer wires this to a logon trigger AND a device-arrival trigger, so
  it runs many times per session - almost always with no drone attached. Every
  path is therefore idempotent and the absent-drone path is both silent and
  cheap. It is also the only path that must never look like a failure.

  Addresses (see README, "Why no host DHCP"):
    node (ESP32 soft-AP)  192.168.4.1
    Tello                 192.168.4.2   (DHCP lease from the node's AP)
    this host over USB    192.168.4.50/24, and no default gateway - one here
                          would route the machine's internet traffic into the
                          drone link.
#>
[CmdletBinding()]
param(
  [string] $HostIp  = '192.168.4.50',
  [int]    $Prefix  = 24,
  [string] $LogPath = (Join-Path $env:ProgramData 'AIdrone\link.log')
)

$ErrorActionPreference = 'Stop'

# The custom PID exists so a Zadig/libwdi WinUSB INF cannot steal the NCM
# function from the in-box usbncm.inf; matching on it is exact by construction.
# The trailing wildcard covers the composite parent and its MI_xx functions -
# the NCM one enumerates as ...&MI_02 with class Net.
$HwIdPattern  = 'USB\VID_303A&PID_8AD1*'
# Description fallback is only for an already-confirmed AIdrone PnP function
# whose NDIS adapter has not yet exposed its PnPDeviceID. Its USB descriptor is
# "AIdrone NCM"; Windows may decorate that as "Espressif Systems AIdrone NCM".
$DescPattern  = '*AIdrone NCM*'

# The device-arrival trigger fires for every network device the machine
# configures, not just ours, so this file grows unattended forever if left
# uncapped. Half a megabyte of history is far more than any diagnosis needs.
$LogCapBytes  = 128KB
$LogKeepLines = 400

# PnP announces the function slightly before NDIS surfaces the miniport, and
# the arrival trigger fires on the PnP event. Waiting here is cheaper and more
# reliable than making the scheduler re-fire the whole task.
$AdapterWaitMs = 10000
# NLA identifies a brand-new network asynchronously; until it has, there is no
# connection profile to categorise.
$ProfileWaitMs = 8000
$PollMs        = 500

$lines = New-Object System.Collections.Generic.List[string]

function Write-Log {
  param([Parameter(Mandatory)][string] $Text)
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
  $lines.Add($line)
  # Write-Host, not Write-Output: the caller reads Invoke-LinkSetup's return
  # value as the exit code, and a log line on the success stream would become
  # part of it.
  Write-Host $line
}

function Save-Log {
  if ($lines.Count -eq 0) { return }
  # A log that cannot be written must never fail the setup it is describing.
  try {
    $dir = Split-Path -Parent $LogPath
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Add-Content -LiteralPath $LogPath -Value $lines.ToArray() -Encoding UTF8
    $size = (Get-Item -LiteralPath $LogPath).Length
    if ($size -gt $LogCapBytes) {
      $keep = @(Get-Content -LiteralPath $LogPath -Tail $LogKeepLines)
      Set-Content -LiteralPath $LogPath -Value $keep -Encoding UTF8
    }
  } catch {
    # Nothing left to report it to.
  }
}

$elevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

<#
  Reading adapter state needs no rights; every mutation below does. The check
  is deliberately lazy so that an already-configured link reports success from
  an ordinary shell instead of demanding elevation it does not need.
#>
function Test-CanWrite {
  param([Parameter(Mandatory)][string] $What)
  if ($elevated) { return $true }
  Write-Log "SKIP $What - needs elevation. Run from an administrator shell, or let the 'AIdrone Link' scheduled task run it as SYSTEM."
  return $false
}

<#
  Returns the Net-class PnP function of the node, or $null. -PresentOnly is not
  optional: without it Windows also hands back ghost entries for every port the
  node was ever plugged into, which would make an absent drone look present.
#>
function Get-LinkDevice {
  $present = @(Get-PnpDevice -PresentOnly -InstanceId $HwIdPattern -ErrorAction SilentlyContinue)
  if ($present.Count -eq 0) { return $null }
  $net = $present | Where-Object { $_.Class -eq 'Net' } | Select-Object -First 1
  if ($null -ne $net) { return $net }

  # The cable is in but nothing claimed the NCM function. That is a driver
  # story, not a configuration one, so say which functions did show up.
  $seen = ($present | ForEach-Object { '{0} [{1}/{2}]' -f $_.InstanceId, $_.Class, $_.Status }) -join '; '
  Write-Log "node present but no Net-class function bound: $seen"
  return $null
}

<# Joins a confirmed AIdrone PnP function to its NDIS adapter. #>
function Get-LinkAdapter {
  param($Device)
  if ($null -eq $Device) { return $null }

  $byId = Get-NetAdapter -ErrorAction SilentlyContinue |
    Where-Object { $_.PnPDeviceID -eq $Device.InstanceId } |
    Select-Object -First 1
  if ($null -ne $byId) { return $byId }

  # The device identity remains the authorization boundary. A description is
  # merely the narrow fallback for a confirmed node while Windows finishes the
  # PnP-to-NDIS join; it must never select an arbitrary NCM adapter at logon.
  return Get-NetAdapter -InterfaceDescription $DescPattern -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Invoke-LinkSetup {
  $device = Get-LinkDevice
  $nic    = Get-LinkAdapter -Device $device

  if ($null -eq $device -and $null -eq $nic) {
    Write-Log 'no AIdrone node on USB - nothing to configure'
    return 0
  }

  # Device seen, adapter not yet. Give NDIS a moment before giving up.
  $waited = 0
  while ($null -eq $nic -and $waited -lt $AdapterWaitMs) {
    Start-Sleep -Milliseconds $PollMs
    $waited += $PollMs
    $nic = Get-LinkAdapter -Device (Get-LinkDevice)
  }
  if ($null -eq $nic) {
    Write-Log "node present but no network adapter surfaced after ${AdapterWaitMs} ms"
    return 1
  }

  $ix = $nic.ifIndex
  Write-Log ("adapter '{0}' ifIndex={1} status={2} desc='{3}'" -f $nic.Name, $ix, $nic.Status, $nic.InterfaceDescription)

  $blocked = $false

  # --- address -------------------------------------------------------------
  $v4   = @(Get-NetIPAddress -InterfaceIndex $ix -AddressFamily IPv4 -ErrorAction SilentlyContinue)
  $mine = $v4 | Where-Object { $_.IPAddress -eq $HostIp -and $_.PrefixLength -eq $Prefix }

  if ($null -ne $mine) {
    Write-Log "ip already $HostIp/$Prefix"
  } elseif (Test-CanWrite "assign $HostIp/$Prefix") {
    # Anything else on this interface is a stale static or an APIPA lease that
    # would keep answering ARP for the wrong address.
    foreach ($old in $v4) {
      Write-Log ("dropping stale address {0}/{1}" -f $old.IPAddress, $old.PrefixLength)
      Remove-NetIPAddress -InputObject $old -Confirm:$false -ErrorAction SilentlyContinue
    }
    try {
      # No -DefaultGateway, on purpose. See the header.
      New-NetIPAddress -InterfaceIndex $ix -IPAddress $HostIp -PrefixLength $Prefix -ErrorAction Stop | Out-Null
      Write-Log "ip $HostIp/$Prefix assigned (no gateway)"
    } catch {
      # The usual cause is a ghost adapter from an earlier port still holding
      # the address; that is worth naming rather than retrying blindly.
      Write-Log "FAILED to assign $HostIp/$Prefix - $($_.Exception.Message.Split([char]10)[0])"
      return 1
    }
  } else {
    $blocked = $true
  }

  # --- DHCP ----------------------------------------------------------------
  # There is no DHCP server on the host side of the link, so a client left
  # enabled just re-introduces an APIPA address next time the link bounces.
  $iface = Get-NetIPInterface -InterfaceIndex $ix -AddressFamily IPv4 -ErrorAction SilentlyContinue
  if ($null -ne $iface -and $iface.Dhcp -ne 'Disabled') {
    if (Test-CanWrite 'disable DHCP') {
      Set-NetIPInterface -InterfaceIndex $ix -AddressFamily IPv4 -Dhcp Disabled -ErrorAction SilentlyContinue
      Write-Log 'dhcp disabled'
    } else { $blocked = $true }
  }

  # --- default route -------------------------------------------------------
  $gw = @(Get-NetRoute -InterfaceIndex $ix -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)
  if ($gw.Count -gt 0) {
    if (Test-CanWrite 'remove default route') {
      # Loud, because a default route here silently blackholes the machine's
      # internet traffic into a drone that will never forward it.
      Write-Log 'WARNING default route found on the drone link - removing'
      $gw | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
    } else { $blocked = $true }
  }

  # --- connection profile --------------------------------------------------
  # Windows files a brand-new unidentified network as Public, and a Public
  # profile is what silently drops the inbound UDP the video stream is made of.
  $waited = 0
  $link   = Get-NetConnectionProfile -InterfaceIndex $ix -ErrorAction SilentlyContinue
  while ($null -eq $link -and $waited -lt $ProfileWaitMs) {
    Start-Sleep -Milliseconds $PollMs
    $waited += $PollMs
    $link = Get-NetConnectionProfile -InterfaceIndex $ix -ErrorAction SilentlyContinue
  }
  if ($null -eq $link) {
    Write-Log "no connection profile after ${ProfileWaitMs} ms (adapter $($nic.Status)) - link not ready"
    $blocked = $true
  } elseif ($link.NetworkCategory -eq 'Private') {
    Write-Log 'network category already Private'
  } elseif (Test-CanWrite 'set network category Private') {
    try {
      $before = $link.NetworkCategory
      Set-NetConnectionProfile -InputObject $link -NetworkCategory Private -ErrorAction Stop
      $link = Get-NetConnectionProfile -InterfaceIndex $ix -ErrorAction SilentlyContinue
      if ($null -ne $link -and $link.NetworkCategory -eq 'Private') {
        Write-Log "network category $before -> Private"
      } else {
        Write-Log 'could not confirm network category Private - link not ready'
        $blocked = $true
      }
    } catch {
      Write-Log "could not set Private - $($_.Exception.Message.Split([char]10)[0])"
      $blocked = $true
    }
  } else {
    $blocked = $true
  }

  if ($blocked) { return 2 }
  Write-Log 'link ready'
  return 0
}

$code = 0
try {
  $code = Invoke-LinkSetup
} catch {
  Write-Log "ERROR $($_.Exception.Message.Split([char]10)[0])"
  Write-Log "  at $($_.InvocationInfo.ScriptLineNumber): $($_.InvocationInfo.Line.Trim())"
  $code = 1
} finally {
  Save-Log
}
exit $code
