<#
  Checks the NSIS script Tauri generated actually wires the link setup.

  The installer .exe cannot be inspected directly - NSIS compresses its header,
  so grepping the binary finds nothing whether the hooks ran or not. The
  generated installer.nsi beside it is the honest artefact, and it is what this
  reads.

  The specific bug this exists to catch: bundle.resources are laid out directly
  under $INSTDIR, mirroring their source paths, NOT under a `resources`
  subdirectory. A scheduled task pointed at the wrong one compiles perfectly,
  installs perfectly, and then does nothing on every machine forever. That is
  the failure this turns into a build error.

  Run after `tauri build --bundles nsis`.
#>
[CmdletBinding()]
param(
  [string] $Nsi
)

$ErrorActionPreference = 'Stop'
# Resolved in the body, not as a param default: $PSScriptRoot is not reliably
# populated while defaults are being bound.
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

Check 'hooks.nsh is included'          ($text -match '!include\s+"[^"]*hooks\.nsh"')
Check 'post-install hook is inserted'  ($text -match '!insertmacro\s+NSIS_HOOK_POSTINSTALL')
Check 'post-uninstall hook is inserted' ($text -match '!insertmacro\s+NSIS_HOOK_POSTUNINSTALL')

# Where the installer really puts the script, straight from the File directive.
$installed = $null
if ($text -match 'File /a "/oname=([^"]*aidrone-link\.ps1)"') { $installed = $Matches[1] }
Check 'aidrone-link.ps1 is bundled' ($null -ne $installed)

# And where the scheduled task will look for it.
$hooks = Get-Content -Raw (Join-Path $here 'hooks.nsh')

# $PLUGINSDIR starts empty in an NSIS installer. The hook creates its XML there
# before passing it to schtasks, so verify order rather than accepting an
# installer whose firewall rule succeeds while its scheduled task is absent.
if ($hooks -match '\$PLUGINSDIR') {
  Check 'task XML initializes $PLUGINSDIR first' `
        ($hooks -match '(?s)InitPluginsDir.*FileOpen\s+\$0\s+"\$PLUGINSDIR\\aidrone-task\.xml"') `
        'call InitPluginsDir before FileOpen $PLUGINSDIR\\aidrone-task.xml'
}
$referenced = $null
if ($hooks -match '-File "\$INSTDIR\\([^"]*aidrone-link\.ps1)"') { $referenced = $Matches[1] }
Check 'the task references a path' ($null -ne $referenced)

if ($installed -and $referenced) {
  Check "task path matches install path" ($installed -eq $referenced) `
        "installer writes '$installed', task runs '$referenced'"
}

# The channels the event trigger subscribes to have to be present and enabled,
# or schtasks rejects the whole registration. Require both subscriptions first:
# a deleted/misspelled literal must fail rather than silently skip this check.
foreach ($channel in @('Microsoft-Windows-Kernel-PnP/Configuration',
                       'Microsoft-Windows-NetworkProfile/Operational')) {
  $subscribed = $hooks -match [regex]::Escape($channel)
  Check "event subscription includes: $channel" $subscribed `
        'missing from the task EventTrigger'
  $log = Get-WinEvent -ListLog $channel -ErrorAction SilentlyContinue
  Check "event channel exists: $channel" ($null -ne $log -and $log.IsEnabled) `
        'not present or not enabled on this machine'
}

<#
  The hooks write a machine-wide firewall rule and register a task running as
  SYSTEM. Both need administrator rights. Tauri's generated NSIS source keeps
  both RequestExecutionLevel branches, so checking for the word "admin" alone
  misses a currentUser build exactly as the original regression did.
#>
if ($hooks -match 'netsh|schtasks') {
  Check 'installer selects per-machine mode for its admin-only hooks' `
        ($text -match '(?m)^\s*!define INSTALLMODE "perMachine"\s*$') `
        'set bundle.windows.nsis.installMode to perMachine'
  Check 'selected installer path requests elevation' `
        ($text -match 'RequestExecutionLevel admin') `
        'perMachine NSIS branch must request elevation'
}

<#
  Every DLL app.exe imports and Windows does not provide has to be inside the
  installer, or the app dies at launch on any machine that is not the one that
  built it. The developer box has FFMPEG_DIR on hand and a target directory
  full of staged DLLs, so this failure is invisible locally and total for
  everyone else - exactly the shape of bug worth spending a PE parser on.
#>
function Get-NonSystemImports {
  param([string] $Exe)
  $b = [IO.File]::ReadAllBytes($Exe)
  $pe = [BitConverter]::ToInt32($b, 0x3c)
  $sectionCount = [BitConverter]::ToUInt16($b, $pe + 6)
  $optSize = [BitConverter]::ToUInt16($b, $pe + 20)
  $opt = $pe + 24
  # PE32+ puts the data directories 16 bytes further in than PE32.
  $dir = $opt + $(if ([BitConverter]::ToUInt16($b, $opt) -eq 0x20b) { 112 } else { 96 })
  $importRva = [BitConverter]::ToUInt32($b, $dir + 8)

  $sections = for ($i = 0; $i -lt $sectionCount; $i++) {
    $s = $opt + $optSize + $i * 40
    [pscustomobject]@{
      Va   = [BitConverter]::ToUInt32($b, $s + 12)
      Size = [BitConverter]::ToUInt32($b, $s + 8)
      Raw  = [BitConverter]::ToUInt32($b, $s + 20)
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

  # Anything shipped with Windows is not ours to carry.
  $system = '^(KERNEL32|USER32|GDI32|ADVAPI32|SHELL32|OLE32|OLEAUT32|WS2_32|CRYPT32|SECUR32|BCRYPT|NCRYPT|NTDLL|SHLWAPI|COMDLG32|COMCTL32|IPHLPAPI|USERENV|POWRPROF|PROPSYS|DWMAPI|UXTHEME|WINMM|VERSION|IMM32|MSIMG32|SETUPAPI|CFGMGR32|RPCRT4|DBGHELP|PSAPI|api-ms-|VCRUNTIME|MSVCP|ucrtbase|WINHTTP|urlmon|wintrust|OLEACC|d3d|dxgi|opengl|WLDAP32|NETAPI32|AUTHZ|SSPICLI|WTSAPI32|CRYPTBASE|windows\.)'
  return $names | Where-Object { $_ -notmatch $system }
}

# `ort` loads these rather than importing them in app.exe, so the PE import
# pass below cannot prove they are present. The provider DLL must remain next
# to the core runtime for ONNX Runtime's own loader to find it.
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
  # The bundler rewrites globs into one File line per matched DLL, so the
  # generated script is where to look rather than the config.
  $shipped = [regex]::Matches($text, 'File /a "/oname=([^"\\]+\.dll)"') |
             ForEach-Object { $_.Groups[1].Value }
  foreach ($dll in Get-NonSystemImports $exe) {
    Check "ships imported DLL: $dll" ($shipped -contains $dll) `
          'app.exe imports it and Windows does not provide it'
  }
} else {
  Check 'app.exe is present to inspect' $false "looked for $exe"
}

if ($fail) { Write-Error 'NSIS installer wiring is wrong'; exit 1 }
'NSIS installer wiring verified'
