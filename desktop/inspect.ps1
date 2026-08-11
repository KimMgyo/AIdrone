# Bring-up helper: dump what Windows made of the ESP32's composite device.
# The question it answers is always the same one - did UsbNcm.sys bind to the
# NCM function, and if not, which compatible ID did the device actually offer?
$ErrorActionPreference = 'SilentlyContinue'

$keys = @(
  'DEVPKEY_Device_HardwareIds',
  'DEVPKEY_Device_CompatibleIds',
  'DEVPKEY_Device_ProblemCode',
  'DEVPKEY_Device_DriverInfPath',
  'DEVPKEY_Device_Service',
  'DEVPKEY_Device_Class'
)

Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_303A' } | ForEach-Object {
  $id = $_.InstanceId
  Write-Output "=============================================================="
  Write-Output ("{0}  [{1}]  status={2}" -f $_.FriendlyName, $id, $_.Status)
  foreach ($k in $keys) {
    $v = (Get-PnpDeviceProperty -InstanceId $id -KeyName $k).Data
    if ($null -ne $v) { Write-Output ("  {0,-32} {1}" -f $k.Replace('DEVPKEY_Device_', ''), ($v -join ' | ')) }
  }
}

Write-Output ""
Write-Output "=== in-box NCM driver present? ==="
Get-WindowsDriver -Online -All |
  Where-Object { $_.OriginalFileName -match 'usbncm|ncm' } |
  Select-Object Driver, OriginalFileName, ClassName |
  Format-Table -AutoSize | Out-String -Width 200
Test-Path "$env:SystemRoot\System32\drivers\UsbNcm.sys" |
  ForEach-Object { Write-Output "UsbNcm.sys on disk: $_" }
Test-Path "$env:SystemRoot\INF\usbncm.inf" |
  ForEach-Object { Write-Output "usbncm.inf on disk: $_" }
