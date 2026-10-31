# Generates the extension's PNG icons (green circle + white "recording" dot).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot '..\extension\icons'
New-Item -ItemType Directory -Force $dir | Out-Null

foreach ($size in 16, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # green circle background
  $green = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 22, 163, 74))
  $inset = [float]($size * 0.05)
  $g.FillEllipse($green, $inset, $inset, ($size - 2 * $inset), ($size - 2 * $inset))

  # white dot in the center
  $white = [System.Drawing.Brushes]::White
  $d = [float]($size * 0.34)
  $c = [float]($size / 2 - $d / 2)
  $g.FillEllipse($white, $c, $c, $d, $d)

  $path = Join-Path $dir ("icon{0}.png" -f $size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "wrote $path"
}
