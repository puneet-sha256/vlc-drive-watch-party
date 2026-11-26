#ifndef AppVersion
  #define AppVersion "0.1.1"
#endif

[Setup]
AppId={{2A44A9BA-E848-4CB2-B6C6-01C4519BDD14}
AppName=VLC Drive Watch Party
AppVersion={#AppVersion}
AppPublisher=Drive Watch Party
DefaultDirName={localappdata}\Programs\DriveWatchParty
DefaultGroupName=VLC Drive Watch Party
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir=..\artifacts
OutputBaseFilename=VLC-Drive-Watch-Party-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\WatchParty.exe
CloseApplications=no
RestartApplications=no
DisableProgramGroupPage=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\artifacts\payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\VLC Drive Watch Party"; Filename: "{app}\WatchParty.exe"
Name: "{autodesktop}\VLC Drive Watch Party"; Filename: "{app}\WatchParty.exe"; Tasks: desktopicon
Name: "{group}\Uninstall VLC Drive Watch Party"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\WatchParty.exe"; Description: "Launch VLC Drive Watch Party"; Flags: nowait postinstall skipifsilent

[Code]
function StopInstalledApp(): Boolean;
var
  ExitCode: Integer;
begin
  Result := True;
  if FileExists(ExpandConstant('{app}\WatchParty.exe')) then
    Result := Exec(ExpandConstant('{app}\WatchParty.exe'), '--shutdown', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not StopInstalledApp() then
    Result := 'Close Watch Party from its tray icon, then try again.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopInstalledApp();
  if not Result then
    MsgBox('Close Watch Party from its tray icon, then uninstall again.', mbError, MB_OK);
end;
