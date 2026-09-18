' DroneRoute dev launcher (Windows).
' Starts the backend or frontend dev server with NO visible console window.
'
' Usage:
'   wscript.exe start-dev-hidden.vbs backend
'   wscript.exe start-dev-hidden.vbs frontend
'
' Logs go to %LOCALAPPDATA%\Temp\opencode\backend.log and frontend.log.
' The backend uses the project's ./data/droneroute.db database file.
Option Explicit

Dim args, mode
Set args = WScript.Arguments
If args.Count <> 1 Then WScript.Quit 1
mode = LCase(args(0))

Dim fso, sh, root, logDir, cmd, dbPath, logFile
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' scripts/ sits directly under the repo root.
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

logDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Temp\opencode"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)

If mode = "backend" Then
  dbPath = root & "\data\droneroute.db"
  logFile = logDir & "\backend.log"
  cmd = "cmd /c cd /d """ & root & """ && set DB_PATH=" & dbPath & " && npm run dev -w packages/backend > """ & logFile & """ 2>&1"
ElseIf mode = "frontend" Then
  logFile = logDir & "\frontend.log"
  cmd = "cmd /c cd /d """ & root & """ && npm run dev -w packages/frontend > """ & logFile & """ 2>&1"
Else
  WScript.Quit 1
End If

' 0 = hidden window, False = do not wait for exit.
sh.Run cmd, 0, False
