# Times how long the app takes to exit after the titlebar X (WM_CLOSE).
#
# The number matters because `RunEvent::Exit` drops the session there, and that
# drop sends `streamoff` and joins the receive threads. Anything that kills the
# process before it finishes - an impatient supervisor, a user clicking X twice -
# strands the drone exactly the way a hard kill does, and the next launch pays
# `ensure_stream_flowing`'s recovery for it.
param([Parameter(Mandatory = $true)][int]$Id)

$p = Get-Process -Id $Id -ErrorAction Stop
$sw = [Diagnostics.Stopwatch]::StartNew()
$null = $p.CloseMainWindow()
while ($sw.ElapsedMilliseconds -lt 30000) {
  if (-not (Get-Process -Id $Id -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 25
}
$alive = [bool](Get-Process -Id $Id -ErrorAction SilentlyContinue)
"exit_ms=$($sw.ElapsedMilliseconds) alive=$alive"
