Add-Type -AssemblyName System.Drawing

$IMG    = "c:\Users\Admin\Desktop\Pixelwargame\IMG"
$BACKUP = "c:\Users\Admin\Desktop\Pixelwargame\IMG-backup"
$MIN_DIM    = 500   # skip files where either dim < this
$DOWNSCALE  = 4     # 1/4 = subtle 4x4-px blocks per source pixel
# Directory segments that must NEVER be pixelated. The HUD book art was
# baked at native res; pixelating it mangles the page-flip frames.
$SKIP_DIRS  = @("\HUD\", "/HUD/")

if (-not (Test-Path $BACKUP)) {
  Write-Host "[1/2] Backing up $IMG -> $BACKUP ..."
  Copy-Item -Path $IMG -Destination $BACKUP -Recurse
  Write-Host "[1/2] Backup done."
} else {
  Write-Host "[1/2] Backup already exists at $BACKUP, skipping copy."
}

Write-Host "[2/2] Pixelating images >= ${MIN_DIM}x${MIN_DIM} ..."
$files = Get-ChildItem -Path $IMG -Recurse -Filter *.png
$processed = 0
$skipped   = 0
$failed    = 0

foreach ($file in $files) {
  $skipByDir = $false
  foreach ($seg in $SKIP_DIRS) {
    if ($file.FullName -like "*$seg*") { $skipByDir = $true; break }
  }
  if ($skipByDir) { $skipped++; continue }
  $bmp = $null; $small = $null; $out = $null; $gSmall = $null; $gOut = $null; $stream = $null
  try {
    # Read into memory so we don't hold a file lock on the path we want to overwrite.
    $bytes  = [System.IO.File]::ReadAllBytes($file.FullName)
    $stream = New-Object System.IO.MemoryStream
    $stream.Write($bytes, 0, $bytes.Length)
    $bmp    = [System.Drawing.Image]::FromStream($stream)

    if ($bmp.Width -lt $MIN_DIM -or $bmp.Height -lt $MIN_DIM) {
      $skipped++
      continue
    }

    $smallW = [Math]::Max(1, [Math]::Floor($bmp.Width / $DOWNSCALE))
    $smallH = [Math]::Max(1, [Math]::Floor($bmp.Height / $DOWNSCALE))

    # Step A: downscale to 1/N with nearest neighbor.
    $small  = New-Object System.Drawing.Bitmap $smallW, $smallH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $gSmall = [System.Drawing.Graphics]::FromImage($small)
    $gSmall.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $gSmall.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $gSmall.CompositingMode   = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $gSmall.DrawImage($bmp, 0, 0, $smallW, $smallH)

    # Step B: upscale back to the original dims, also nearest neighbor.
    $out  = New-Object System.Drawing.Bitmap $bmp.Width, $bmp.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $gOut = [System.Drawing.Graphics]::FromImage($out)
    $gOut.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $gOut.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $gOut.CompositingMode   = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $gOut.DrawImage($small, 0, 0, $bmp.Width, $bmp.Height)

    # Release the source bitmap + stream BEFORE we overwrite the file.
    $bmp.Dispose();    $bmp = $null
    $stream.Dispose(); $stream = $null

    $out.Save($file.FullName, [System.Drawing.Imaging.ImageFormat]::Png)
    $processed++
  } catch {
    Write-Host "  ! failed: $($file.FullName) :: $($_.Exception.Message)"
    $failed++
  } finally {
    if ($gSmall) { $gSmall.Dispose() }
    if ($gOut)   { $gOut.Dispose() }
    if ($small)  { $small.Dispose() }
    if ($out)    { $out.Dispose() }
    if ($bmp)    { $bmp.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}

Write-Host ""
Write-Host "Done. Processed: $processed. Skipped (< ${MIN_DIM}x${MIN_DIM}): $skipped. Failed: $failed."
