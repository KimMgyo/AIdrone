# Bring-up helper: dump what Windows made of the ESP32's composite device.
# It verifies that interface 0 was bound to WinUSB, so the desktop app can
# claim the vendor bulk endpoints.
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
Write-Output "Expected vendor function: MI_00 with Service=WINUSB and ProblemCode=0."
