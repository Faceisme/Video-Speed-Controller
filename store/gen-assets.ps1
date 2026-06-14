# 生成扩展图标与商店宣传图(纯 .NET System.Drawing,无需额外依赖)
# 用法:在扩展根目录运行  powershell -ExecutionPolicy Bypass -File store\gen-assets.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot   # 扩展根目录
$iconDir = Join-Path $root "icons"
$assetDir = Join-Path $PSScriptRoot "assets"
New-Item -ItemType Directory -Force -Path $iconDir  | Out-Null
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# 蓝→靛渐变 + 白色双三角(快进/倍速)图标
function New-Icon([int]$size, [string]$outPath) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [Math]::Max(1, [int]($size * 0.06))
  $r = [single]($size * 0.22)
  $path = New-RoundedPath $pad $pad ([single]($size - 2 * $pad)) ([single]($size - 2 * $pad)) $r
  $c1 = [System.Drawing.Color]::FromArgb(255, 10, 132, 255)
  $c2 = [System.Drawing.Color]::FromArgb(255, 94, 92, 230)
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point($size, $size)), $c1, $c2
  $g.FillPath($bg, $path)

  $S = [single]$size
  $yTop = $S * 0.30; $yBot = $S * 0.70; $yMid = $S * 0.50
  $tw = $S * 0.27
  $x0 = $S * 0.18
  $x1 = $x0 + $tw + $S * 0.05
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $tri1 = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF($x0, $yTop)),
    (New-Object System.Drawing.PointF($x0, $yBot)),
    (New-Object System.Drawing.PointF(($x0 + $tw), $yMid)))
  $tri2 = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF($x1, $yTop)),
    (New-Object System.Drawing.PointF($x1, $yBot)),
    (New-Object System.Drawing.PointF(($x1 + $tw), $yMid)))
  $g.FillPolygon($white, $tri1)
  $g.FillPolygon($white, $tri2)

  $g.Dispose()
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "icon -> $outPath"
}

foreach ($s in 16, 48, 128) { New-Icon $s (Join-Path $iconDir "$s.png") }

# ---------- 商店宣传图 ----------
function Draw-CenteredString($g, $text, $font, $brush, $x, $y, $w) {
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF($x, $y, $w, 200)
  $g.DrawString($text, $font, $brush, $rect, $fmt)
}

function New-Promo([int]$w, [int]$h, [string]$outPath, [bool]$withShortcuts) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  $c1 = [System.Drawing.Color]::FromArgb(255, 17, 24, 39)
  $c2 = [System.Drawing.Color]::FromArgb(255, 30, 41, 82)
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point($w, $h)), $c1, $c2
  $g.FillRectangle($bg, 0, 0, $w, $h)

  $icon = [System.Drawing.Image]::FromFile((Join-Path $iconDir "128.png"))
  $isz = [int]($h * 0.26)
  $g.DrawImage($icon, [int](($w - $isz) / 2), [int]($h * 0.10), $isz, $isz)
  $icon.Dispose()

  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $gray = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 175, 190, 215))
  $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 90, 170, 255))

  $titleFont = New-Object System.Drawing.Font("Microsoft YaHei", [single]($h * 0.072), [System.Drawing.FontStyle]::Bold)
  $subFont = New-Object System.Drawing.Font("Microsoft YaHei", [single]($h * 0.030), [System.Drawing.FontStyle]::Regular)
  Draw-CenteredString $g "视频倍速控制" $titleFont $white 0 ([single]($h * 0.40)) $w
  Draw-CenteredString $g "快捷键控制任意网页视频的播放速度 · 支持 iframe 预览视频" $subFont $gray 0 ([single]($h * 0.40 + $h * 0.115)) $w

  if ($withShortcuts) {
    $kFont = New-Object System.Drawing.Font("Microsoft YaHei", [single]($h * 0.030), [System.Drawing.FontStyle]::Bold)
    Draw-CenteredString $g "D 加速    S 减速    A 一键倍速    R 复位    Z / X 快退 / 快进" $kFont $accent 0 ([single]($h * 0.72)) $w
    $kFont.Dispose()
  }

  $titleFont.Dispose(); $subFont.Dispose()
  $g.Dispose()
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "promo -> $outPath"
}

New-Promo 1280 800 (Join-Path $assetDir "screenshot-1280x800.png") $true
New-Promo 440 280 (Join-Path $assetDir "promo-tile-440x280.png") $false
Write-Host "Done."
