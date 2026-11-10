# Signs one Windows file with an SSL.com code-signing certificate through eSigner (cloud key, no USB token).
# Tauri runs it for every file it signs (the app .exe, the NSIS setup .exe and the .msi) through bundle.windows.signCommand,
# which .github/workflows/release-desktop.yml sets only when the ES_* secrets exist. Only the file's hash is sent to SSL.com.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File sign-windows.ps1 <file>
#
# Environment: CODE_SIGN_TOOL_PATH (unzipped CodeSignTool), ES_USERNAME, ES_PASSWORD, ES_CREDENTIAL_ID, ES_TOTP_SECRET.
# SPDX-License-Identifier: MIT
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = "Stop"

foreach ($name in "CODE_SIGN_TOOL_PATH", "ES_USERNAME", "ES_PASSWORD", "ES_CREDENTIAL_ID", "ES_TOTP_SECRET") {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "sign-windows.ps1: $name is not set" }
}
$tool = $env:CODE_SIGN_TOOL_PATH
$java = Join-Path $tool "jdk-11.0.2\bin\java.exe"
$jar = Get-ChildItem (Join-Path $tool "jar") -Filter "code_sign_tool-*.jar" | Select-Object -First 1
$target = (Resolve-Path $File).Path

Write-Host "Signing $target"
# CodeSignTool reads conf\code_sign_tool.properties from the working directory.
Push-Location $tool
try {
  $out = & $java -jar $jar.FullName sign `
    "-username=$env:ES_USERNAME" "-password=$env:ES_PASSWORD" `
    "-credential_id=$env:ES_CREDENTIAL_ID" "-totp_secret=$env:ES_TOTP_SECRET" `
    "-input_file_path=$target" -override 2>&1 | Out-String
} finally {
  Pop-Location
}
Write-Host $out
# CodeSignTool can exit with 0 after an error, so check what it printed too.
if ($LASTEXITCODE -ne 0 -or $out -notmatch "Code signed successfully") { throw "sign-windows.ps1: signing $target failed" }

$sig = Get-AuthenticodeSignature $target
if ($sig.Status -ne "Valid") { throw "sign-windows.ps1: signature on $target is $($sig.Status)" }
Write-Host "Signed by $($sig.SignerCertificate.Subject)"
