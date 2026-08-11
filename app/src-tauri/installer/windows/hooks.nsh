; Installer hooks for the AIdrone NSIS bundle.
;
; These exist for one reason: the ESP32-S3 node is plug-and-play as far as the
; DRIVER goes - Windows 11 binds its in-box usbncm.inf by compatible id and no
; download is involved - but not as far as the LINK goes. There is no DHCP
; server on the host's side of the cable, so without help the adapter comes up
; with an APIPA address and the drone is unreachable. README's "Host NIC setup
; - required once" is the manual version of what happens below; the point of
; shipping it is that the operator never has to run it.
;
; Two things are set up here, and they are split by what they need:
;   - the firewall rules need no adapter, so they are made once, now;
;   - the address does need one, so it is delegated to a scheduled task that
;     runs whenever a device arrives or a user logs on.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "AIdrone: 링크 방화벽 규칙 등록 중..."

  ; Inbound UDP on a freshly created adapter is dropped by default, and the
  ; symptom - a link that is up, addressed, and silent - is indistinguishable
  ; from dead hardware. 9999 is the node's telemetry/command port and 11111 the
  ; Tello video relay.
  ;
  ; Deleted first because NSIS reinstalls over the top of an existing install
  ; and netsh will otherwise stack a duplicate rule on every upgrade.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AIdrone UDP"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="AIdrone UDP" dir=in action=allow protocol=UDP localport=9999,11111 profile=private'
  Pop $0
  ${If} $0 != 0
    DetailPrint "AIdrone: 방화벽 규칙 등록 실패 ($0) - 수동 등록이 필요할 수 있습니다."
  ${EndIf}

  DetailPrint "AIdrone: 링크 자동 설정 작업 등록 중..."

  ; Why a scheduled task and not a service: assigning the address is a
  ; sub-second job that only makes sense when the cable is present, and a task
  ; can be triggered by the very event that makes it relevant.
  ;
  ; Why two triggers: ONLOGON covers the node that was already plugged in
  ; before the machine started, and the Kernel-PnP event covers hot-plug. The
  ; event trigger is the one that matters day to day, so it is registered
  ; through an XML definition - schtasks' /SC options cannot express an event
  ; subscription, and the alternative (a /SC MINUTE poll) would run this
  ; hundreds of times a day to catch a cable that changes twice.
  ;
  ; The two subscriptions are the two halves of "the cable is now usable", and
  ; both channels were checked to be present and enabled by default on Windows
  ; 11 - the obvious-looking `Kernel-PnP/Device Configuration` does not exist
  ; and makes schtasks reject the whole XML:
  ;   Kernel-PnP/Configuration 400  - a device finished configuring
  ;   NetworkProfile/Operational 10000 - a network connected
  ; PnP fires first but reports the USB function slightly ahead of the NDIS
  ; miniport, which is why the script polls for the adapter rather than
  ; assuming the trigger implies one. NetworkProfile is the backstop for the
  ; case where the miniport takes long enough that the first run gives up.

  ; $PLUGINSDIR is empty until this call. Without it FileOpen below attempts
  ; to write `\aidrone-task.xml`; firewall setup still succeeds, but schtasks
  ; receives no XML and the install quietly leaves no link task behind.
  InitPluginsDir
  SetOutPath "$INSTDIR"
  FileOpen $0 "$PLUGINSDIR\aidrone-task.xml" w
  FileWriteUTF16LE /BOM $0 '<?xml version="1.0" encoding="UTF-16"?>$\r$\n'
  FileWriteUTF16LE $0 '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">$\r$\n'
  FileWriteUTF16LE $0 '<RegistrationInfo><Description>AIdrone USB-NCM 링크에 고정 IP를 할당합니다.</Description></RegistrationInfo>$\r$\n'
  FileWriteUTF16LE $0 '<Triggers>$\r$\n'
  FileWriteUTF16LE $0 '<LogonTrigger><Enabled>true</Enabled></LogonTrigger>$\r$\n'
  FileWriteUTF16LE $0 '<EventTrigger><Enabled>true</Enabled><Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="Microsoft-Windows-Kernel-PnP/Configuration"&gt;&lt;Select Path="Microsoft-Windows-Kernel-PnP/Configuration"&gt;*[System[EventID=400]]&lt;/Select&gt;&lt;/Query&gt;&lt;Query Id="1" Path="Microsoft-Windows-NetworkProfile/Operational"&gt;&lt;Select Path="Microsoft-Windows-NetworkProfile/Operational"&gt;*[System[EventID=10000]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription>$\r$\n'
  ; A device-arrival storm at boot would otherwise start one instance per
  ; device; a short delay collapses them into the single run that IgnoreNew
  ; then keeps.
  FileWriteUTF16LE $0 '<Delay>PT5S</Delay></EventTrigger>$\r$\n'
  FileWriteUTF16LE $0 '</Triggers>$\r$\n'
  ; SYSTEM because New-NetIPAddress needs administrator rights and the app
  ; itself deliberately runs unelevated.
  FileWriteUTF16LE $0 '<Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>$\r$\n'
  FileWriteUTF16LE $0 '<Settings>$\r$\n'
  FileWriteUTF16LE $0 '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>$\r$\n'
  FileWriteUTF16LE $0 '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>$\r$\n'
  FileWriteUTF16LE $0 '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>$\r$\n'
  FileWriteUTF16LE $0 '<StartWhenAvailable>true</StartWhenAvailable>$\r$\n'
  ; The script polls for the adapter for a bounded ~18 s; a minute is a
  ; generous ceiling that still guarantees no instance is ever left hanging.
  FileWriteUTF16LE $0 '<ExecutionTimeLimit>PT1M</ExecutionTimeLimit>$\r$\n'
  FileWriteUTF16LE $0 '<Enabled>true</Enabled>$\r$\n'
  FileWriteUTF16LE $0 '</Settings>$\r$\n'
  FileWriteUTF16LE $0 '<Actions Context="Author"><Exec>$\r$\n'
  FileWriteUTF16LE $0 '<Command>powershell.exe</Command>$\r$\n'
  ; Tauri lays bundle.resources out directly under $INSTDIR, mirroring their
  ; source paths - so this is $INSTDIR\installer\windows\, with no `resources`
  ; component. Getting that wrong costs nothing at build time and silently
  ; breaks every scheduled run, so it is read back from the generated
  ; installer.nsi by the check in README's "Verifying the installers".
  FileWriteUTF16LE $0 '<Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\installer\windows\aidrone-link.ps1"</Arguments>$\r$\n'
  FileWriteUTF16LE $0 '</Exec></Actions>$\r$\n'
  FileWriteUTF16LE $0 '</Task>$\r$\n'
  FileClose $0

  nsExec::ExecToLog 'schtasks /Create /TN "AIdrone Link" /XML "$PLUGINSDIR\aidrone-task.xml" /F'
  Pop $0
  ${If} $0 != 0
    DetailPrint "AIdrone: 작업 등록 실패 ($0) - 케이블 연결 후 IP를 수동 설정해야 합니다."
  ${EndIf}

  ; Run it once now, so a node that is already plugged in during installation
  ; works without waiting for a reboot or a re-plug. It exits 0 and silently
  ; when nothing is attached, which is the normal case.
  nsExec::ExecToLog 'schtasks /Run /TN "AIdrone Link"'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The assigned address is deliberately left alone: it lives on an adapter
  ; that disappears with the cable, so there is nothing persistent to clean.
  nsExec::ExecToLog 'schtasks /Delete /TN "AIdrone Link" /F'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="AIdrone UDP"'
  Pop $0
!macroend
