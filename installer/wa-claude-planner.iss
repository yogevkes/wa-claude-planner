; WA-Claude Planner installer (Inno Setup 6). Built by .github/workflows/build.yml from dist\app.
; Per-user install, no admin rights. User data lives in %LOCALAPPDATA%\WA-Claude Planner and is kept on uninstall.
#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#define AppName "WA-Claude Planner"

[Setup]
AppId={{6C1F5E0B-2B7A-4C63-9F3E-7E1A4A8D2C51}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=yogevkes
AppPublisherURL=https://github.com/yogevkes/wa-claude-planner
AppSupportURL=https://github.com/yogevkes/wa-claude-planner/issues
DefaultDirName={localappdata}\Programs\WA-Claude Planner
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=WA-Claude-Planner-Setup-{#AppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\assets\icon.ico
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
CloseApplications=no
ShowLanguageDialog=no

[Languages]
Name: "he"; MessagesFile: "compiler:Languages\Hebrew.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
he.AutoStart=הפעל אוטומטית כשנכנסים ל-Windows
en.AutoStart=Start automatically when I sign in to Windows
he.LaunchApp=פתח את WA-Claude Planner
en.LaunchApp=Open WA-Claude Planner

[Tasks]
Name: "autostart"; Description: "{cm:AutoStart}"

[InstallDelete]
; upgrades: replace the code folders completely so removed files don't linger
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\ui"
Type: filesandordirs; Name: "{app}\node_modules"

[Files]
Source: "..\dist\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\windows\start-app.vbs"" -Open"; WorkingDir: "{app}"; IconFilename: "{app}\assets\icon.ico"
Name: "{userstartup}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\windows\start-app.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\icon.ico"; Tasks: autostart

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\windows\start-app.vbs"" -Open"; Description: "{cm:LaunchApp}"; Flags: postinstall nowait skipifsilent
; silent upgrade (/SILENT): start it again quietly
Filename: "{sys}\wscript.exe"; Parameters: """{app}\windows\start-app.vbs"""; Flags: nowait; Check: WizardSilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\stop.ps1"" -All -IncludeTray"; Flags: runhidden; RunOnceId: "StopApp"

[Code]
// Stop a running copy (tray + background app) before files are replaced
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  StopScript: String;
begin
  Result := '';
  StopScript := ExpandConstant('{app}\windows\stop.ps1');
  if FileExists(StopScript) then
    Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + StopScript + '" -All -IncludeTray', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
