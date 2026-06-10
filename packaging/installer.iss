; Inno Setup スクリプト — PdfToSvg
; 事前に `pyinstaller packaging/pdftosvg.spec` で dist/PdfToSvg/ を生成しておく。
; ビルド: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" packaging\installer.iss

#define AppName "PdfToSvg"
#define AppVersion "0.1.0"
#define AppPublisher "社内ツール"

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
OutputDir=..\dist_installer
OutputBaseFilename={#AppName}-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
WizardStyle=modern

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[Files]
; PyInstaller onedir 出力をまるごと
Source: "..\dist\PdfToSvg\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\PdfToSvg.exe"
Name: "{commondesktop}\{#AppName}"; Filename: "{app}\PdfToSvg.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "デスクトップにアイコンを作成"; GroupDescription: "追加タスク:"

[Run]
Filename: "{app}\PdfToSvg.exe"; Description: "起動する"; Flags: nowait postinstall skipifsilent
