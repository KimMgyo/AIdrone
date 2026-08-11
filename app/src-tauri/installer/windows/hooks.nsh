# -*- coding: utf-8 -*-
; ^ Load-bearing, and it must stay on line 1 or 2: makensis decodes a
; BOM-less source file with the build machine's ANSI codepage, which would
; turn every Korean DetailPrint below into mojibake - differently on every
; build machine. This line pins the decoding to the file's actual encoding.

; AIdrone - Windows installer hooks (NSIS), wired in from tauri.conf.json:
;
;   "bundle": { "windows": { "nsis": {
;     "installMode":    "perMachine",
;     "installerHooks": "installer/windows/hooks.nsh"
;   } } }
;
; There is no driver here, and there does not need to be. The node enumerates
; as CDC-NCM under VID_303A/PID_8AD1 and Windows 11 binds the in-box
; usbncm.inf by itself. What Windows will not do is address the HOST end of
; the link, because there is no DHCP server on this side of it - so the
; adapter comes up with an APIPA address on a Public profile and the drone's
; UDP never arrives. README, "Host NIC setup - required once", spells the fix
; out as a manual recipe; these hooks are that recipe, automated.
;
; installMode MUST be "perMachine". Tauri defaults to "currentUser", which
; compiles `RequestExecutionLevel user` into the installer, and every netsh
; and schtasks call below would then fail with "Access is denied."

!define AID_TASK        "AIdrone Link"
!define AID_FW          "AIdrone UDP"
!define AID_LINK_SCRIPT "$INSTDIR\installer\windows\aidrone-link.ps1"
!define AID_TASK_XML    "$PLUGINSDIR\aidrone-link-task.xml"
; Written into the task, not executed here, so no WOW64 redirection applies:
; the 64-bit Task Scheduler service resolves this to the 64-bit PowerShell.
!define AID_PWSH        "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"

; The Net setup class. The only exact-match handle the arrival trigger has;
; see the comment on the event trigger below.
!define AID_NET_CLASS   "{4d36e972-e325-11ce-bfc1-08002be10318}"

; The parameter is NOT named PORT: NSIS implements macro parameters as
; !defines, so a nested insertion sharing its caller's parameter name dies on
; "already defined".
!macro AIdroneFirewallDrop DROPPORT
  ; The exit code is deliberately discarded: on a first install there is no
  ; rule to delete and netsh reports that as a failure. Delete-then-add is how
  ; a reinstall avoids stacking a second identical rule every time.
  nsExec::ExecToLog 'netsh.exe advfirewall firewall delete rule name="${AID_FW} ${DROPPORT}"'
  Pop $0
!macroend

!macro AIdroneFirewallAllow PORT
  !insertmacro AIdroneFirewallDrop "${PORT}"
  nsExec::ExecToLog 'netsh.exe advfirewall firewall add rule name="${AID_FW} ${PORT}" dir=in action=allow enable=yes protocol=UDP localport=${PORT} profile=private description="AIdrone USB-NCM link"'
  Pop $0
  ${If} $0 == 0
    DetailPrint "방화벽 인바운드 허용: UDP ${PORT} (개인 네트워크)"
  ${Else}
    DetailPrint "방화벽 규칙 추가 실패: UDP ${PORT} (netsh $0)"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1

  DetailPrint "AIdrone USB-NCM 링크를 설정하는 중..."

  ; Firewall first: the rules describe ports, not adapters, so they can be
  ; written whether or not a node has ever been plugged into this machine.
  ; 9999 is the receiver/telemetry socket, 11111 the Tello video stream.
  !insertmacro AIdroneFirewallAllow "9999"
  !insertmacro AIdroneFirewallAllow "11111"

  ; The scheduled task carries two triggers.
  ;
  ;   LogonTrigger - no UserId, so it means any user. Covers a node that was
  ;   already plugged in across a reboot.
  ;
  ;   EventTrigger on Kernel-PnP/Configuration event 400 ("device was
  ;   configured"). Chosen over a repeating interval trigger because it reacts
  ;   within seconds of the plug instead of averaging half an interval, and
  ;   because it costs nothing at all while no device arrives - an interval
  ;   trigger would wake PowerShell forever on every machine that never sees a
  ;   drone. The event channel is enabled by default on Windows 11 (verified:
  ;   `wevtutil gl` reports enabled: true, and the channel already held 400
  ;   events).
  ;
  ;   The query filters on ClassGuid, not on our hardware id, and that is
  ;   forced: the Windows event XPath subset has no starts-with() or
  ;   contains() - both are rejected outright as an invalid query (verified via
  ;   Get-WinEvent -FilterXPath, which uses the same engine) - while the node's
  ;   DeviceInstanceId ends in a per-port suffix, so there is no exact string
  ;   to match on. Narrowing to the Net class is the tightest exact predicate
  ;   available. The cost of the remaining false positives is one PowerShell
  ;   start per network-device configuration, and aidrone-link.ps1's very first
  ;   act is the cheap PnP lookup that ends the run when the arrival was not
  ;   ours.
  ;
  ; It runs as SYSTEM (S-1-5-18) because New-NetIPAddress and
  ; Set-NetConnectionProfile require administrator rights - and because the app
  ; itself must never ask for them.
  ;
  ; The script stays in $INSTDIR rather than beside its log in ProgramData:
  ; Program Files is writable only by administrators, and a SYSTEM task must
  ; not execute from a directory a standard user can drop files into.
  InitPluginsDir
  ClearErrors
  FileOpen $1 "${AID_TASK_XML}" w
  ${If} ${Errors}
    DetailPrint "작업 스케줄러 정의를 만들지 못했습니다. README의 수동 절차로 링크를 설정하세요."
  ${Else}
    ; UTF-16LE with a BOM: Task Scheduler XML is canonically Unicode, and
    ; NSIS's plain FileWrite would down-convert to the system ANSI codepage.
    FileWriteUTF16LE /BOM $1 '<?xml version="1.0" encoding="UTF-16"?>$\r$\n'
    FileWriteUTF16LE $1 '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">$\r$\n'
    FileWriteUTF16LE $1 '  <RegistrationInfo>$\r$\n'
    FileWriteUTF16LE $1 '    <Author>AIdrone</Author>$\r$\n'
    FileWriteUTF16LE $1 '    <URI>\${AID_TASK}</URI>$\r$\n'
    FileWriteUTF16LE $1 '    <Description>Assigns 192.168.4.50/24 to the AIdrone USB-NCM adapter and marks the link Private. Harmless and near-instant when no node is attached.</Description>$\r$\n'
    FileWriteUTF16LE $1 '  </RegistrationInfo>$\r$\n'
    FileWriteUTF16LE $1 '  <Triggers>$\r$\n'
    ; The logon delay lets the profile service settle; the arrival delay lets
    ; NDIS surface the miniport, which trails the PnP event by a moment.
    FileWriteUTF16LE $1 '    <LogonTrigger><Enabled>true</Enabled><Delay>PT5S</Delay></LogonTrigger>$\r$\n'
    FileWriteUTF16LE $1 '    <EventTrigger>$\r$\n'
    FileWriteUTF16LE $1 '      <Enabled>true</Enabled>$\r$\n'
    FileWriteUTF16LE $1 '      <Delay>PT3S</Delay>$\r$\n'
    FileWriteUTF16LE $1 `      <Subscription>&lt;QueryList&gt;&lt;Query Id='0' Path='Microsoft-Windows-Kernel-PnP/Configuration'&gt;&lt;Select Path='Microsoft-Windows-Kernel-PnP/Configuration'&gt;*[System[(EventID=400)]] and *[EventData[Data[@Name='ClassGuid']='${AID_NET_CLASS}']]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription>$\r$\n`
    FileWriteUTF16LE $1 '    </EventTrigger>$\r$\n'
    FileWriteUTF16LE $1 '  </Triggers>$\r$\n'
    FileWriteUTF16LE $1 '  <Principals>$\r$\n'
    FileWriteUTF16LE $1 '    <Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal>$\r$\n'
    FileWriteUTF16LE $1 '  </Principals>$\r$\n'
    FileWriteUTF16LE $1 '  <Settings>$\r$\n'
    ; IgnoreNew is load-bearing: a single plug can produce a burst of Net-class
    ; configuration events, and two copies racing on New-NetIPAddress would
    ; fight over the same address.
    FileWriteUTF16LE $1 '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>$\r$\n'
    ; A ground station gets flown off a laptop on battery.
    FileWriteUTF16LE $1 '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>$\r$\n'
    FileWriteUTF16LE $1 '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>$\r$\n'
    FileWriteUTF16LE $1 '    <AllowHardTerminate>true</AllowHardTerminate>$\r$\n'
    ; No catch-up runs: a missed arrival is stale by definition, and the next
    ; logon covers the case that still matters.
    FileWriteUTF16LE $1 '    <StartWhenAvailable>false</StartWhenAvailable>$\r$\n'
    FileWriteUTF16LE $1 '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>$\r$\n'
    FileWriteUTF16LE $1 '    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>$\r$\n'
    ; schtasks /Run below depends on this.
    FileWriteUTF16LE $1 '    <AllowStartOnDemand>true</AllowStartOnDemand>$\r$\n'
    FileWriteUTF16LE $1 '    <Enabled>true</Enabled>$\r$\n'
    FileWriteUTF16LE $1 '    <Hidden>false</Hidden>$\r$\n'
    FileWriteUTF16LE $1 '    <RunOnlyIfIdle>false</RunOnlyIfIdle>$\r$\n'
    FileWriteUTF16LE $1 '    <WakeToRun>false</WakeToRun>$\r$\n'
    ; The script's own waits cap out around 18s. Two minutes only ever fires on
    ; a genuinely wedged run, which must not block IgnoreNew forever.
    FileWriteUTF16LE $1 '    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>$\r$\n'
    FileWriteUTF16LE $1 '    <Priority>7</Priority>$\r$\n'
    FileWriteUTF16LE $1 '  </Settings>$\r$\n'
    FileWriteUTF16LE $1 '  <Actions Context="Author">$\r$\n'
    FileWriteUTF16LE $1 '    <Exec>$\r$\n'
    FileWriteUTF16LE $1 '      <Command>${AID_PWSH}</Command>$\r$\n'
    FileWriteUTF16LE $1 '      <Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${AID_LINK_SCRIPT}"</Arguments>$\r$\n'
    FileWriteUTF16LE $1 '    </Exec>$\r$\n'
    FileWriteUTF16LE $1 '  </Actions>$\r$\n'
    FileWriteUTF16LE $1 '</Task>$\r$\n'
    FileClose $1

    ; /F so that reinstalling over an existing install replaces the definition
    ; instead of failing on the duplicate name.
    nsExec::ExecToLog 'schtasks.exe /Create /TN "${AID_TASK}" /XML "${AID_TASK_XML}" /F'
    Pop $0
    ${If} $0 == 0
      DetailPrint "예약 작업 등록: ${AID_TASK} (로그온 시 + 장치 연결 시)"
      ; A node plugged in during the install has to work without a reboot.
      ; Going through /Run rather than launching PowerShell directly means the
      ; first real exercise of the task happens here, where a broken
      ; registration is still visible, and it runs as the same SYSTEM identity
      ; it will use later.
      nsExec::ExecToLog 'schtasks.exe /Run /TN "${AID_TASK}"'
      Pop $0
      DetailPrint "연결된 노드를 지금 설정합니다. 기록: %ProgramData%\AIdrone\link.log"
    ${Else}
      DetailPrint "예약 작업 등록 실패 (schtasks $0). README의 수동 절차로 링크를 설정하세요."
    ${EndIf}
  ${EndIf}

  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Push $0

  ; /End first: an arrival-triggered run may be in flight, and deleting a
  ; running task leaves its PowerShell orphaned.
  nsExec::ExecToLog 'schtasks.exe /End /TN "${AID_TASK}"'
  Pop $0
  nsExec::ExecToLog 'schtasks.exe /Delete /TN "${AID_TASK}" /F'
  Pop $0

  !insertmacro AIdroneFirewallDrop "9999"
  !insertmacro AIdroneFirewallDrop "11111"

  ; 192.168.4.50 is left where it is. It belongs to an adapter that only exists
  ; while the cable is plugged in, so it leaves with the device; chasing it
  ; here would mean touching a NIC that is probably not even present.
  ; %ProgramData%\AIdrone\link.log stays too - it is quite likely the record of
  ; why someone is uninstalling.
  DetailPrint "AIdrone 예약 작업과 방화벽 규칙을 제거했습니다."

  Pop $0
!macroend
