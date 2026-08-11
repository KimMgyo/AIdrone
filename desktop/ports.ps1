# Reusable port/NIC snapshot. Lives in a file because `$_` inside a bash-quoted
# `powershell -Command` string gets eaten by the shell before PowerShell sees it.
$ErrorActionPreference = 'SilentlyContinue'

Write-Output '--- serial ports (present) ---'
Get-PnpDevice -PresentOnly -Class Ports |
  Format-Table Status, FriendlyName, InstanceId -AutoSize | Out-String -Width 220

Write-Output '--- ESP32 (VID_303A) functions ---'
Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_303A' } |
  Format-Table Status, Class, FriendlyName, InstanceId -AutoSize | Out-String -Width 220

Write-Output '--- CH343/CH340 UART bridges (any state) ---'
Get-PnpDevice | Where-Object { $_.InstanceId -match 'VID_1A86' } |
  Format-Table Present, Status, FriendlyName, InstanceId -AutoSize | Out-String -Width 220

Write-Output '--- devices with a problem ---'
Get-PnpDevice -PresentOnly | Where-Object { $_.Status -ne 'OK' } |
  Format-Table Status, Class, FriendlyName, InstanceId -AutoSize | Out-String -Width 220

Write-Output '--- network adapters ---'
Get-NetAdapter | Format-Table Name, InterfaceDescription, Status, MacAddress, LinkSpeed -AutoSize |
  Out-String -Width 220
