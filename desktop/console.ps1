# Reads the ESP32's CDC console for a few seconds.
#
# The device prints a 1 Hz line - `wifi rx host` in against `usb tx` out, plus
# drop/recov/stall - which is the only view of the half of the path the host
# cannot see. When the host reports no video, this says whether the drone's
# packets are reaching the bridge at all: nothing here means the failure is
# radio-side (drone -> ESP32), traffic here with nothing at the host means it
# is the USB side.
#
# 115200 on the CH343 bridge, which is COM10 here and is safe to open: uptime
# runs straight through an open/close, verified 33s -> 52s across one read.
#
# NOT the composite device's own CDC port ("USB serial device", COM18 here).
# Opening that one resets the S3 - the console came back at uptime 2 s, the
# soft-AP restarted, and the Tello dropped off and did not re-associate. That
# cost a live drone session. `ap=` in the output below is how you notice.
param([string]$Port = "COM10", [int]$Seconds = 8)
$sp = New-Object System.IO.Ports.SerialPort $Port, 115200, "None", 8, "One"
$sp.ReadTimeout = 500
$sp.DtrEnable = $false
$sp.RtsEnable = $false
try {
  $sp.Open()
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
    try { $line = $sp.ReadLine(); if ($line) { $line.TrimEnd() } }
    catch [TimeoutException] { }
  }
} finally { if ($sp.IsOpen) { $sp.Close() } }
