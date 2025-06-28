Add-Type -AssemblyName System.Drawing

function Create-QNetIcon {
    param([int]$Size)
    
    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    
    # Background gradient
    $rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
    $startColor = [System.Drawing.Color]::FromArgb(255, 102, 126, 234)  # #667eea
    $endColor = [System.Drawing.Color]::FromArgb(255, 118, 75, 162)     # #764ba2
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $startColor, $endColor, 45)
    
    # Draw background circle
    $graphics.FillEllipse($brush, 1, 1, $Size-2, $Size-2)
    
    # Draw border
    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 1)
    $graphics.DrawEllipse($borderPen, 1, 1, $Size-2, $Size-2)
    
    # Draw Q letter
    $qPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [Math]::Max(1, $Size/15))
    $centerX = $Size / 2
    $centerY = $Size / 2
    $radius = $Size / 4
    $qRect = New-Object System.Drawing.Rectangle($centerX - $radius, $centerY - $radius, $radius * 2, $radius * 2)
    $graphics.DrawEllipse($qPen, $qRect)
    
    # Draw Q tail
    $tailStart = New-Object System.Drawing.Point($centerX + $radius * 0.6, $centerY + $radius * 0.6)
    $tailEnd = New-Object System.Drawing.Point($centerX + $radius, $centerY + $radius)
    $graphics.DrawLine($qPen, $tailStart, $tailEnd)
    
    # Save icon
    $bitmap.Save("icons/icon-$Size.png", [System.Drawing.Imaging.ImageFormat]::Png)
    
    # Cleanup
    $graphics.Dispose()
    $bitmap.Dispose()
    $brush.Dispose()
    $borderPen.Dispose()
    $qPen.Dispose()
    
    Write-Host "Created icon-$Size.png"
}

# Create all icon sizes
@(16, 32, 48, 128) | ForEach-Object {
    Create-QNetIcon -Size $_
}

Write-Host "All icons created successfully!" 