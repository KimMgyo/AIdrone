# Sends one console command to the bridge and prints what comes back.
#
# The console's own `h` lists the verbs; `i` is the one worth reaching for when
# the host sees nothing - it reports the soft-AP and the link from the side the
# host cannot observe.
#
# COM10 (CH343). Never COM18 - see console.ps1.
param([string]$Cmd = "i", [string]$Port = "COM10", [int]$Seconds = 4)

$sp = New-Object System.IO.Ports.SerialPort $Port, 115200, "None", 8, "One"
$sp.ReadTimeout = 400
$sp.DtrEnable = $false
$sp.RtsEnable = $false
try {
  $sp.Open()
  Start-Sleep -Milliseconds 200
  $sp.DiscardInBuffer()
  $sp.Write("$Cmd`r`n")
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
    try { $line = $sp.ReadLine(); if ($line) { $line.TrimEnd() } }
    catch [TimeoutException] { }
  }
} finally { if ($sp.IsOpen) { $sp.Close() } }
