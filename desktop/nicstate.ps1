# Minimal NCM link/IP check. Separate file because `$_` inside a bash-quoted
# `powershell -Command` string gets eaten by the shell before PowerShell sees it.
$ErrorActionPreference = 'SilentlyContinue'
Get-NetAdapter |
  Where-Object { $_.InterfaceDescription -match 'AIdrone' } |
  Format-Table Name, InterfaceIndex, Status, LinkSpeed -AutoSize |
  Out-String -Width 140 |
  Write-Output

Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.InterfaceAlias -match 'AIdrone' } |
  Format-Table IPAddress, PrefixLength, InterfaceAlias, InterfaceIndex, AddressState -AutoSize |
  Out-String -Width 140 |
  Write-Output
