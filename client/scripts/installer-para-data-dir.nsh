; Para Desktop - NSIS custom: data directory + silent flag
;
; Goals:
; - Add a dedicated "data directory" (Electron userData root) page for UI installs.
; - Support silent install argument: /DATA_DIR=... (used together with /S).
; - Persist stable config: %APPDATA%\Para Desktop\para.config.json
; - Create data dir subfolders: logs/cache/plugins (CI can assert by filesystem).

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

; This include is injected for both installer and uninstaller builds.
; Guard installer-only functions/macros to avoid makensis warning 6010
; (warnings are treated as errors in our release pipeline).
!ifndef BUILD_UNINSTALLER

Var ParaDataDir
Var ParaDataDirInput
Var ParaDataDirWasExplicit

!define PARA_CONFIG_DIR "$APPDATA\Para Desktop"
!define PARA_CONFIG_FILE "${PARA_CONFIG_DIR}\para.config.json"

Function ParaTrimQuotes
  Exch $0
  ; Trim surrounding double-quotes (accept /DATA_DIR="C:\path with spaces").
  StrCpy $1 $0 1
  ${If} $1 == "$\""
    StrCpy $0 $0 "" 1
    StrCpy $1 $0 1 -1
    ${If} $1 == "$\""
      StrCpy $0 $0 -1
    ${EndIf}
  ${EndIf}
  Push $0
FunctionEnd

Function ParaNormalizeForFs
  Exch $0
  ; Normalize path for filesystem operations:
  ; - convert '/' to '\\' so we don't end up with mixed separators when appending "\\logs".
  StrCpy $1 ""
  StrLen $2 $0
  StrCpy $3 0
  ${While} $3 < $2
    StrCpy $4 $0 1 $3
    ${If} $4 == "/"
      StrCpy $1 "$1\\"
    ${Else}
      StrCpy $1 "$1$4"
    ${EndIf}
    IntOp $3 $3 + 1
  ${EndWhile}
  Push $1
FunctionEnd

Function ParaPathToJsonString
  Exch $0
  ; Convert a Windows path into a JSON-safe string:
  ; - Replace '\\' with '/' to avoid JSON backslash escaping.
  ; - Escape '"' as '\\"' (paths should not contain quotes, but be defensive).
  StrCpy $1 ""
  StrLen $2 $0
  StrCpy $3 0
  ${While} $3 < $2
    StrCpy $4 $0 1 $3
    ${If} $4 == "\\"
      StrCpy $1 "$1/"
    ${ElseIf} $4 == "$\""
      ; In NSIS strings, writing \" directly can confuse the parser.
      ; To produce JSON \" (two chars: \\ + "), append a literal '\\' plus $\".
      StrCpy $1 "$1\$\""
    ${Else}
      StrCpy $1 "$1$4"
    ${EndIf}
    IntOp $3 $3 + 1
  ${EndWhile}
  Push $1
FunctionEnd

!macro preInit
  ; Default: Electron userData default (%APPDATA%\Para Desktop)
  StrCpy $ParaDataDir "$APPDATA\Para Desktop"
  StrCpy $ParaDataDirWasExplicit "0"

  ; Parse optional argument: /DATA_DIR=...
  ${GetParameters} $R0
  ${GetOptions} $R0 "/DATA_DIR=" $R1
  ${IfNot} ${Errors}
    StrCpy $ParaDataDir $R1
    Push $ParaDataDir
    Call ParaTrimQuotes
    Pop $ParaDataDir

    Push $ParaDataDir
    Call ParaNormalizeForFs
    Pop $ParaDataDir

    StrCpy $ParaDataDirWasExplicit "1"
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  ; In silent mode (/S) there is no UI. In interactive mode, add the data dir page.
  PageEx custom
    PageCallbacks ParaDataDirPageCreate ParaDataDirPageLeave
  PageExEnd

  Function ParaDataDirPageCreate
    IfSilent 0 +2
      Abort

    ${if} ${isUpdated}
      Abort
    ${endIf}

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0u 0u 100% 20u "Data directory (app data / userData root)"
    Pop $0

    ${NSD_CreateDirRequest} 0u 22u 100% 12u "$ParaDataDir"
    Pop $ParaDataDirInput

    nsDialogs::Show
  FunctionEnd

  Function ParaDataDirPageLeave
    ${NSD_GetText} $ParaDataDirInput $ParaDataDir

    Push $ParaDataDir
    Call ParaTrimQuotes
    Pop $ParaDataDir

    Push $ParaDataDir
    Call ParaNormalizeForFs
    Pop $ParaDataDir

    ${If} $ParaDataDir == ""
      MessageBox MB_ICONSTOP|MB_TOPMOST "Please choose a data directory, or use /DATA_DIR=... for silent installs."
      Abort
    ${EndIf}

    StrCpy $ParaDataDirWasExplicit "1"
  FunctionEnd
!macroend

!macro customInstall
  ; For updates, avoid overriding an existing config unless user explicitly opted in.
  ${if} ${isUpdated}
    ${If} $ParaDataDirWasExplicit != "1"
      ; no-op
    ${Else}
      ; 1) Ensure data dir structure exists (CI asserts on-disk).
      CreateDirectory "$ParaDataDir"
      CreateDirectory "$ParaDataDir\logs"
      CreateDirectory "$ParaDataDir\cache"
      CreateDirectory "$ParaDataDir\plugins"

      ; 2) Write stable installer config (read before app.setPath('userData')).
      CreateDirectory "${PARA_CONFIG_DIR}"

      Push $ParaDataDir
      Call ParaPathToJsonString
      Pop $R0

      StrCpy $R1 "${PARA_CONFIG_FILE}"
      StrCpy $R2 "$R1.tmp"
      FileOpen $0 "$R2" w
      FileWrite $0 "{\"userDataDir\":\"$R0\",\"source\":\"nsis\",\"version\":1}\r\n"
      FileClose $0

      Delete "$R1"
      Rename "$R2" "$R1"
    ${EndIf}
  ${else}
    ; 1) Ensure data dir structure exists (CI asserts on-disk).
    CreateDirectory "$ParaDataDir"
    CreateDirectory "$ParaDataDir\logs"
    CreateDirectory "$ParaDataDir\cache"
    CreateDirectory "$ParaDataDir\plugins"

    ; 2) Write stable installer config (read before app.setPath('userData')).
    CreateDirectory "${PARA_CONFIG_DIR}"

    Push $ParaDataDir
    Call ParaPathToJsonString
    Pop $R0

    StrCpy $R1 "${PARA_CONFIG_FILE}"
    StrCpy $R2 "$R1.tmp"
    FileOpen $0 "$R2" w
    FileWrite $0 "{\"userDataDir\":\"$R0\",\"source\":\"nsis\",\"version\":1}\r\n"
    FileClose $0

    Delete "$R1"
    Rename "$R2" "$R1"
  ${endIf}
!macroend

!endif
