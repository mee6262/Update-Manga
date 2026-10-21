# สำรองข้อมูลผู้ใช้ (webapp\data + .env) เป็น zip — ตั้งใน Task Scheduler ให้รันวันละครั้ง หรือรันมือก่อนแก้ข้อมูล
# ไม่รวม chapters\ (cache รูปตอน ดึงใหม่ได้) และ logs\
# ปลายทางอยู่ดิสก์เดียวกับเว็บ: กันพลาดจากคำสั่ง/โค้ด ไม่กันดิสก์เสีย — ควรก๊อป zip ออกนอกเครื่องเป็นครั้งคราว
param(
    [string]$Dest = "C:\Backups\Update-Manga",
    [int]$Keep = 14
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "webapp\data"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tmp = Join-Path $env:TEMP "manga-backup-$stamp"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# robocopy อ่านไฟล์ที่แอปเปิดเขียนอยู่ได้ (Copy-Item บางครั้งล้ม) — exit code < 8 = สำเร็จ
robocopy $src $tmp /E /XD chapters logs /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy ล้ม (exit $LASTEXITCODE)" }
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) { Copy-Item $envFile (Join-Path $tmp ".env") }

$zip = Join-Path $Dest "data-$stamp.zip"
Compress-Archive -Path (Join-Path $tmp "*") -DestinationPath $zip
Remove-Item $tmp -Recurse -Force

Get-ChildItem $Dest -Filter "data-*.zip" | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Force
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Output "สำรองแล้ว: $zip ($size MB) เก็บล่าสุด $Keep ชุด"
