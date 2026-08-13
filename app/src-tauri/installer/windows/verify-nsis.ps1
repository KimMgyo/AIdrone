<#
  Verifies that a generated NSIS package contains its native runtime assets.
  Windows 11 selects WinUSB from the node's Microsoft OS 2.0 descriptor; no
  host-side installer configuration is required.

  Run after `tauri build --bundles nsis`.
#>
[CmdletBinding()]
param(
  [string] $Nsi
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath
if (-not $Nsi) { $Nsi = Join-Path $here '..\..\target\release\nsis\x64\installer.nsi' }
if (-not (Test-Path $Nsi)) { Write-Error "generated installer script not found: $Nsi" }
$text = Get-Content -Raw $Nsi
$fail = $false

function Check {
  param([string] $What, [bool] $Ok, [string] $Detail = '')
  if ($Ok) { "  ok      $What" }
  else { $script:fail = $true; "  FAILED  $What$(if ($Detail) { " - $Detail" })" }
}

<#
  Every DLL app.exe imports and Windows does not provide has to be inside the
  installer, or the app dies at launch on a machine without the build host's
  FFmpeg/ONNX staging tree.
#>
function Get-NonSystemImports {
  param([string] $Exe)
  $b = [IO.File]::ReadAllBytes($Exe)
  $pe = [BitConverter]::ToInt32($b, 0x3c)
  $sectionCount = [BitConverter]::ToUInt16($b, $pe + 6)
  $optSize = [BitConverter]::ToUInt16($b, $pe + 20)
  $opt = $pe + 24
  $dir = $opt + $(if ([BitConverter]::ToUInt16($b, $opt) -eq 0x20b) { 112 } else { 96 })
  $importRva = [BitConverter]::ToUInt32($b, $dir + 8)

  $sections = for ($i = 0; $i -lt $sectionCount; $i++) {
    $s = $opt + $optSize + $i * 40
    [pscustomobject]@{
      Va = [BitConverter]::ToUInt32($b, $s + 12)
      Size = [BitConverter]::ToUInt32($b, $s + 8)
      Raw = [BitConverter]::ToUInt32($b, $s + 20)
    }
  }
  function ToOffset([uint32] $rva) {
    foreach ($s in $sections) {
      if ($rva -ge $s.Va -and $rva -lt $s.Va + [Math]::Max($s.Size, 1)) { return $rva - $s.Va + $s.Raw }
    }
    return -1
  }

  $names = @()
  for ($o = ToOffset $importRva; ; $o += 20) {
    $nameRva = [BitConverter]::ToUInt32($b, $o + 12)
    if ($nameRva -eq 0) { break }
    $start = ToOffset $nameRva
    $end = $start
    while ($b[$end] -ne 0) { $end++ }
    $names += [Text.Encoding]::ASCII.GetString($b, $start, $end - $start)
  }

  # WINUSB is in this list, not in the installer. It looks like a driver DLL
  # worth shipping - the USB bulk transport imports it through `nusb` - but it
  # is part of Windows itself and has been since Vista SP1. Redistributing it
  # would put a frozen copy next to app.exe that shadows the OS one, on a
  # machine whose kernel-mode WinUSB half was updated without it.
  $system = '^(KERNEL32|USER32|GDI32|ADVAPI32|SHELL32|OLE32|OLEAUT32|WS2_32|CRYPT32|SECUR32|BCRYPT|NCRYPT|NTDLL|SHLWAPI|COMDLG32|COMCTL32|IPHLPAPI|USERENV|POWRPROF|PROPSYS|DWMAPI|UXTHEME|WINMM|VERSION|IMM32|MSIMG32|SETUPAPI|CFGMGR32|WINUSB|RPCRT4|DBGHELP|PSAPI|api-ms-|VCRUNTIME|MSVCP|ucrtbase|WINHTTP|urlmon|wintrust|OLEACC|d3d|dxgi|opengl|WLDAP32|NETAPI32|AUTHZ|SSPICLI|WTSAPI32|CRYPTBASE|windows\.)'
  return $names | Where-Object { $_ -notmatch $system }
}

# `ort` loads these rather than importing them in app.exe, so the PE import
# pass below cannot prove they are present.
$resources = [regex]::Matches($text, 'File /a "/oname=([^"]+)"') |
             ForEach-Object { $_.Groups[1].Value }
foreach ($runtime in @(
  'onnxruntime\windows-x64\onnxruntime.dll',
  'onnxruntime\windows-x64\onnxruntime_providers_shared.dll'
)) {
  Check "ships dynamic ONNX Runtime: $runtime" ($resources -contains $runtime) `
    'the person detector loads this library at startup'
}

Check 'ships DirectML redistributable' ($resources -contains 'DirectML.dll') `
  'the Windows package requires this non-system inference dependency'

foreach ($notice in @(
  'onnxruntime\LICENSE',
  'onnxruntime\ThirdPartyNotices.txt'
)) {
  Check "ships ONNX Runtime notice: $notice" ($resources -contains $notice) `
    'redistributed runtime licensing must remain available to the operator'
}

foreach ($notice in @(
  'directml\LICENSE.txt',
  'directml\ThirdPartyNotices.txt'
)) {
  Check "ships DirectML notice: $notice" ($resources -contains $notice) `
    'redistributed DirectML licensing must remain available to the operator'
}

# installer.nsi sits at target/<profile>/nsis/<arch>/, so the binary it bundles
# is three levels up.
$exe = Join-Path (Split-Path (Split-Path (Split-Path -Parent $Nsi))) 'app.exe'
if (Test-Path $exe) {
  $shipped = [regex]::Matches($text, 'File /a "/oname=([^"\\]+\.dll)"') |
             ForEach-Object { $_.Groups[1].Value }
  foreach ($dll in Get-NonSystemImports $exe) {
    Check "ships imported DLL: $dll" ($shipped -contains $dll) `
      'app.exe imports it and Windows does not provide it'
  }
} else {
  Check 'app.exe is present to inspect' $false "looked for $exe"
}

if ($fail) { Write-Error 'NSIS installer contents are wrong'; exit 1 }
'NSIS installer contents verified'
