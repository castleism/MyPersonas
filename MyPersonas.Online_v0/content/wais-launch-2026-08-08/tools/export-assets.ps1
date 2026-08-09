[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$campaignRoot = Split-Path -Parent $PSScriptRoot
$assetsRoot = Join-Path $campaignRoot 'assets'
$sourceRoot = Join-Path $assetsRoot 'sources'
$qaRoot = Join-Path $assetsRoot 'qa'
New-Item -ItemType Directory -Force -Path $qaRoot | Out-Null

$platforms = @(
    [pscustomobject]@{ Name = 'instagram'; Width = 1080; Height = 1350; ContactWidth = 360; ContactHeight = 450 },
    [pscustomobject]@{ Name = 'facebook'; Width = 1200; Height = 1500; ContactWidth = 360; ContactHeight = 450 },
    [pscustomobject]@{ Name = 'x'; Width = 1600; Height = 900; ContactWidth = 480; ContactHeight = 270 }
)

function Get-JpegCodec {
    [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object MimeType -eq 'image/jpeg' |
        Select-Object -First 1
}

function Save-Jpeg {
    param(
        [Parameter(Mandatory)] [System.Drawing.Image] $Image,
        [Parameter(Mandatory)] [string] $Path,
        [int] $Quality = 94
    )

    $codec = Get-JpegCodec
    $parameters = [System.Drawing.Imaging.EncoderParameters]::new(1)
    $parameters.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new(
        [System.Drawing.Imaging.Encoder]::Quality,
        [long]$Quality
    )
    try {
        $Image.Save($Path, $codec, $parameters)
    }
    finally {
        $parameters.Dispose()
    }
}

function Export-CroppedImage {
    param(
        [Parameter(Mandatory)] [string] $Source,
        [Parameter(Mandatory)] [string] $Destination,
        [Parameter(Mandatory)] [int] $Width,
        [Parameter(Mandatory)] [int] $Height,
        [double] $Zoom = 1.0,
        [double] $OffsetX = 0.0,
        [double] $OffsetY = 0.0
    )

    $input = [System.Drawing.Image]::FromFile($Source)
    try {
        $sourceAspect = $input.Width / $input.Height
        $targetAspect = $Width / $Height

        if ($sourceAspect -gt $targetAspect) {
            $cropHeight = $input.Height
            $cropWidth = [int][Math]::Round($cropHeight * $targetAspect)
            $cropX = [int][Math]::Floor(($input.Width - $cropWidth) / 2)
            $cropY = 0
        }
        else {
            $cropWidth = $input.Width
            $cropHeight = [int][Math]::Round($cropWidth / $targetAspect)
            $cropX = 0
            $cropY = [int][Math]::Floor(($input.Height - $cropHeight) / 2)
        }

        if ($Zoom -gt 1.0) {
            $cropWidth = [int][Math]::Round($cropWidth / $Zoom)
            $cropHeight = [int][Math]::Round($cropHeight / $Zoom)
        }

        $centerX = ($input.Width - $cropWidth) / 2
        $centerY = ($input.Height - $cropHeight) / 2
        $cropX = [int][Math]::Round($centerX + ($centerX * $OffsetX))
        $cropY = [int][Math]::Round($centerY + ($centerY * $OffsetY))
        $cropX = [Math]::Max(0, [Math]::Min($cropX, $input.Width - $cropWidth))
        $cropY = [Math]::Max(0, [Math]::Min($cropY, $input.Height - $cropHeight))

        $output = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        try {
            $output.SetResolution(96, 96)
            $graphics = [System.Drawing.Graphics]::FromImage($output)
            try {
                $graphics.Clear([System.Drawing.Color]::Black)
                $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
                $sourceRect = [System.Drawing.Rectangle]::new($cropX, $cropY, $cropWidth, $cropHeight)
                $destinationRect = [System.Drawing.Rectangle]::new(0, 0, $Width, $Height)
                $graphics.DrawImage($input, $destinationRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
            }
            finally {
                $graphics.Dispose()
            }
            Save-Jpeg -Image $output -Path $Destination -Quality 94
        }
        finally {
            $output.Dispose()
        }
    }
    finally {
        $input.Dispose()
    }
}

function New-ContactSheet {
    param(
        [Parameter(Mandatory)] [pscustomobject] $Platform,
        [Parameter(Mandatory)] [System.IO.FileInfo[]] $Files,
        [Parameter(Mandatory)] [string] $Destination
    )

    $columns = 2
    $rows = [int][Math]::Ceiling($Files.Count / $columns)
    $margin = 24
    $labelHeight = 42
    $cellWidth = $Platform.ContactWidth + ($margin * 2)
    $cellHeight = $Platform.ContactHeight + $labelHeight + ($margin * 2)
    $sheet = [System.Drawing.Bitmap]::new($cellWidth * $columns, $cellHeight * $rows)

    try {
        $sheet.SetResolution(96, 96)
        $graphics = [System.Drawing.Graphics]::FromImage($sheet)
        try {
            $graphics.Clear([System.Drawing.Color]::FromArgb(7, 17, 31))
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $font = [System.Drawing.Font]::new('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
            $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(246, 251, 255))
            try {
                for ($index = 0; $index -lt $Files.Count; $index++) {
                    $column = $index % $columns
                    $row = [int][Math]::Floor($index / $columns)
                    $left = ($column * $cellWidth) + $margin
                    $top = ($row * $cellHeight) + $margin
                    $image = [System.Drawing.Image]::FromFile($Files[$index].FullName)
                    try {
                        $destinationRect = [System.Drawing.Rectangle]::new($left, $top, $Platform.ContactWidth, $Platform.ContactHeight)
                        $graphics.DrawImage($image, $destinationRect)
                    }
                    finally {
                        $image.Dispose()
                    }
                    $label = $Files[$index].BaseName -replace '-\d+x\d+$', ''
                    $graphics.DrawString($label, $font, $brush, $left, $top + $Platform.ContactHeight + 10)
                }
            }
            finally {
                $brush.Dispose()
                $font.Dispose()
            }
        }
        finally {
            $graphics.Dispose()
        }
        Save-Jpeg -Image $sheet -Path $Destination -Quality 90
    }
    finally {
        $sheet.Dispose()
    }
}

$manifest = [System.Collections.Generic.List[object]]::new()

foreach ($platform in $platforms) {
    $sourceDirectory = Join-Path $sourceRoot $platform.Name
    $destinationDirectory = Join-Path $assetsRoot $platform.Name
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null

    $sourceFiles = @(Get-ChildItem -LiteralPath $sourceDirectory -Filter '*.png' -File | Sort-Object Name)
    if ($sourceFiles.Count -ne 10) {
        throw "Expected 10 $($platform.Name) source images, found $($sourceFiles.Count)."
    }

    foreach ($sourceFile in $sourceFiles) {
        $destinationName = '{0}-{1}x{2}.jpg' -f $sourceFile.BaseName, $platform.Width, $platform.Height
        $destinationPath = Join-Path $destinationDirectory $destinationName
        $zoom = 1.0
        $offsetX = 0.0
        $offsetY = 0.0
        if ($sourceFile.BaseName -eq '06-protect-the-web' -and $platform.Name -eq 'facebook') {
            $zoom = 1.08
            $offsetX = 0.18
            $offsetY = -0.08
        }
        elseif ($sourceFile.BaseName -eq '06-protect-the-web' -and $platform.Name -eq 'x') {
            $zoom = 1.03
            $offsetY = -0.12
        }
        elseif ($sourceFile.BaseName -eq '07-the-sky-has-weather' -and $platform.Name -eq 'x') {
            $offsetY = -0.18
        }
        elseif ($sourceFile.BaseName -eq '09-refusal-must-remain-refusal' -and $platform.Name -eq 'instagram') {
            $zoom = 1.06
            $offsetX = -0.18
            $offsetY = 0.16
        }
        elseif ($sourceFile.BaseName -eq '09-refusal-must-remain-refusal' -and $platform.Name -eq 'x') {
            $offsetY = 0.52
        }

        Export-CroppedImage -Source $sourceFile.FullName -Destination $destinationPath -Width $platform.Width -Height $platform.Height -Zoom $zoom -OffsetX $offsetX -OffsetY $offsetY

        $destinationFile = Get-Item -LiteralPath $destinationPath
        $destinationHash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash
        $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
        $manifest.Add([pscustomobject]@{
            platform = $platform.Name
            concept = $sourceFile.BaseName.Substring(0, 2)
            file = $destinationFile.FullName.Substring($campaignRoot.Length + 1)
            width = $platform.Width
            height = $platform.Height
            bytes = $destinationFile.Length
            sha256 = $destinationHash
            source_file = $sourceFile.FullName.Substring($campaignRoot.Length + 1)
            source_sha256 = $sourceHash
            prompt_file = 'VISUAL-PROMPT-MATRIX.md'
            generation_mode = if (
                ($sourceFile.BaseName -eq '06-protect-the-web' -and $platform.Name -ne 'instagram') -or
                ($sourceFile.BaseName -eq '07-the-sky-has-weather' -and $platform.Name -eq 'x') -or
                ($sourceFile.BaseName -eq '09-refusal-must-remain-refusal' -and $platform.Name -in @('instagram', 'x'))
            ) { 'platform crop derived from built-in imagegen sibling source after imagegen OAuth interruption or visual QA correction' } else { 'built-in imagegen' }
            disclosure = 'fictional Castleborn character; AI-assisted visual'
            status = 'awaiting_owner_approval'
        })
    }

    $finalFiles = @(Get-ChildItem -LiteralPath $destinationDirectory -Filter '*.jpg' -File | Sort-Object Name)
    $contactSheetPath = Join-Path $qaRoot ("$($platform.Name)-contact-sheet.jpg")
    New-ContactSheet -Platform $platform -Files $finalFiles -Destination $contactSheetPath
}

$manifestPath = Join-Path $campaignRoot 'ASSET-MANIFEST.csv'
$manifest | Export-Csv -LiteralPath $manifestPath -NoTypeInformation -Encoding UTF8

[pscustomobject]@{
    source_count = (Get-ChildItem -LiteralPath $sourceRoot -Recurse -Filter '*.png' -File).Count
    export_count = (Get-ChildItem -LiteralPath $assetsRoot -Recurse -Filter '*.jpg' -File | Where-Object DirectoryName -NotLike "$qaRoot*").Count
    contact_sheet_count = (Get-ChildItem -LiteralPath $qaRoot -Filter '*-contact-sheet.jpg' -File).Count
    manifest = $manifestPath
}
