# Cài công cụ trong dự án, không thay đổi Python hay Node của hệ thống.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$pythonRuntime = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (!(Test-Path -LiteralPath $pythonRuntime)) {
    $pythonRuntime = (Get-Command python -ErrorAction Stop).Source
}
New-Item -ItemType Directory -Force '.tools/python' | Out-Null
& $pythonRuntime -m pip install --disable-pip-version-check --upgrade --target .tools/python -r analysis/requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Không cài được công cụ phân tích. Kiểm tra kết nối mạng rồi chạy lại.' }
Write-Host 'Đã chuẩn bị công cụ. Chạy Start-Game.cmd để mở game.'
