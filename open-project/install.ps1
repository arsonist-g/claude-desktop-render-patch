#Requires -Version 5.1
<#
.SYNOPSIS
    给 Windows 资源管理器加上“Open project in Claude Desktop”右键菜单。

.DESCRIPTION
    写入文件夹的 shell 动词，右键时用 claude://code/new?folder=... 深链把该文件夹作为项目打开。
    默认只写当前用户（HKCU，不需要管理员）；-Scope Machine 写整机（会自己弹 UAC 提权）。
#>
[CmdletBinding()]
param(
    [string]$Label = 'Open project in Claude Desktop',
    [ValidateSet('User', 'Machine')]
    [string]$Scope = 'User'
)

$ErrorActionPreference = 'Stop'

$ClassesRoot = if ($Scope -eq 'Machine') { 'HKLM:\Software\Classes' } else { 'HKCU:\Software\Classes' }
$VerbRoots = @(
    'Directory\shell\OpenProjectInClaudeDesktop'
    'Directory\Background\shell\OpenProjectInClaudeDesktop'
    'Drive\shell\OpenProjectInClaudeDesktop'
)

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ClaudeTarget {
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\claude-desktop.exe'

    $package = Get-AppxPackage -Name Claude -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending | Select-Object -First 1
    if ($package) {
        $exe = Join-Path $package.InstallLocation 'app\claude.exe'
        if (-not (Test-Path -LiteralPath $exe)) { $exe = Join-Path $package.InstallLocation 'Claude.exe' }
        $commandExe = if (Test-Path -LiteralPath $alias) { $alias } else { $exe }
        if (-not (Test-Path -LiteralPath $commandExe)) { return $null }
        # 命令用执行别名（跨版本稳定），图标从真实 exe 里抽。
        return [pscustomobject]@{ Kind = 'msix'; CommandExe = $commandExe; IconExe = $exe }
    }

    $candidates = @()
    $squirrel = Join-Path $env:LOCALAPPDATA 'AnthropicClaude'
    if (Test-Path -LiteralPath $squirrel) {
        $candidates += Get-ChildItem -LiteralPath $squirrel -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'Claude.exe' }
    }
    $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Claude\Claude.exe'
    $candidates += Join-Path $env:ProgramFiles 'Claude\Claude.exe'

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return [pscustomobject]@{ Kind = 'unpackaged'; CommandExe = $candidate; IconExe = $candidate }
        }
    }
    return $null
}

function ConvertTo-IconDib {
    # 32 位 BGRA 的 DIB：BITMAPINFOHEADER + 自下而上的像素 + 全 0 的 AND 掩码。
    param([System.Drawing.Bitmap]$Bitmap)

    $w = $Bitmap.Width
    $h = $Bitmap.Height
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $locked = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = $locked.Stride
        $pixels = New-Object byte[] ($stride * $h)
        [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $pixels, 0, $pixels.Length)
    } finally {
        $Bitmap.UnlockBits($locked)
    }

    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    try {
        $writer.Write([UInt32]40)
        $writer.Write([Int32]$w)
        $writer.Write([Int32]($h * 2))
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]0)
        $writer.Write([UInt32]($w * 4 * $h))
        $writer.Write([Int32]0)
        $writer.Write([Int32]0)
        $writer.Write([UInt32]0)
        $writer.Write([UInt32]0)
        for ($y = $h - 1; $y -ge 0; $y--) { $writer.Write($pixels, $y * $stride, $w * 4) }
        $andRow = ([Math]::Floor(($w + 31) / 32)) * 4
        $and = New-Object byte[] ($andRow * $h)
        $writer.Write($and, 0, $and.Length)
        $writer.Flush()
        return $stream.ToArray()
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

function New-MultiSizeIcon {
    # 系统只给 16x16 的菜单取图，必须自己拼多尺寸 32 位 ICO，否则会被降成灰白。
    param([System.Drawing.Bitmap]$Source, [string]$Path)

    $entries = New-Object System.Collections.ArrayList
    foreach ($size in @(16, 20, 24, 32, 48)) {
        $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($Source, 0, 0, $size, $size)
        } finally {
            $graphics.Dispose()
        }
        [void]$entries.Add(@{ Size = $size; Data = (ConvertTo-IconDib -Bitmap $bitmap) })
        $bitmap.Dispose()
    }

    $pngStream = New-Object System.IO.MemoryStream
    try {
        $Source.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
        [void]$entries.Add(@{ Size = 256; Data = $pngStream.ToArray() })
    } finally {
        $pngStream.Dispose()
    }

    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    try {
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]$entries.Count)
        $offset = 6 + 16 * $entries.Count
        foreach ($entry in $entries) {
            $dimension = if ($entry.Size -ge 256) { 0 } else { $entry.Size }
            $writer.Write([byte]$dimension)
            $writer.Write([byte]$dimension)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([UInt16]1)
            $writer.Write([UInt16]32)
            $writer.Write([UInt32]$entry.Data.Length)
            $writer.Write([UInt32]$offset)
            $offset += $entry.Data.Length
        }
        foreach ($entry in $entries) { $writer.Write($entry.Data, 0, $entry.Data.Length) }
        $writer.Flush()
        [System.IO.File]::WriteAllBytes($Path, $stream.ToArray())
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

function Get-VerbIcon {
    # 从真实 exe 里抽 256x256 全彩图标，拼成多尺寸 ico 放到固定目录。
    # 文件名带内容哈希，既避免资源管理器用旧图标缓存，也方便清掉历史文件。
    param([string]$SourceExe)

    $base = if ($Scope -eq 'Machine') { $env:ProgramData } else { $env:LOCALAPPDATA }
    if (-not $base) { return $null }
    $directory = Join-Path $base 'ClaudeOpenProject'

    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        Add-Type -Namespace ClaudeOpenProject -Name IconNative -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern int PrivateExtractIcons(string lpszFile, int nIconIndex, int cxIcon, int cyIcon, IntPtr[] phicon, int[] piconid, int nIcons, int flags);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(IntPtr hIcon);
'@ -ErrorAction Stop
    } catch {
        # 类型已加载过会抛错，忽略。
    }

    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $handles = New-Object IntPtr[] 1
    $ids = New-Object int[] 1
    $count = 0
    try {
        $count = [ClaudeOpenProject.IconNative]::PrivateExtractIcons($SourceExe, 0, 256, 256, $handles, $ids, 1, 0)
        if ($count -le 0 -or $handles[0] -eq [IntPtr]::Zero) { return $null }

        $icon = [System.Drawing.Icon]::FromHandle($handles[0])
        try {
            $bitmap = $icon.ToBitmap()
            try {
                $temporary = Join-Path $directory 'claude.tmp.ico'
                New-MultiSizeIcon -Source $bitmap -Path $temporary
                $hash = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.Substring(0, 8).ToLowerInvariant()
                $final = Join-Path $directory ("claude-" + $hash + ".ico")
                Move-Item -LiteralPath $temporary -Destination $final -Force
                Get-ChildItem -LiteralPath $directory -Filter 'claude*.ico' -ErrorAction SilentlyContinue |
                    Where-Object { $_.FullName -ne $final } |
                    Remove-Item -Force -ErrorAction SilentlyContinue
                return $final
            } finally {
                $bitmap.Dispose()
            }
        } finally {
            $icon.Dispose()
        }
    } catch {
        Write-Warning ("生成菜单图标失败，回退成直接用可执行文件当图标：{0}" -f $_.Exception.Message)
        return $null
    } finally {
        if ($count -gt 0 -and $handles[0] -ne [IntPtr]::Zero) {
            [void][ClaudeOpenProject.IconNative]::DestroyIcon($handles[0])
        }
    }
}

function Update-ShellAssociations {
    try {
        Add-Type -Namespace ClaudeOpenProject -Name ShellNotify -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Auto, SetLastError = true)]
public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
'@ -ErrorAction Stop
    } catch {
        # 类型已经加载过就会抛错，可以忽略。
    }
    try {
        [ClaudeOpenProject.ShellNotify]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
    } catch {
        Write-Warning ("通知 shell 刷新失败：{0}" -f $_.Exception.Message)
    }
}

if ($Scope -eq 'Machine' -and -not (Test-Elevated)) {
    # 没提权就自己弹 UAC 重新跑一遍，省得手动开管理员窗口。
    Write-Host '需要管理员权限，正在请求提权…' -ForegroundColor Yellow
    $arguments = @(
        '-NoProfile'
        '-ExecutionPolicy', 'Bypass'
        '-File', ('"{0}"' -f $PSCommandPath)
        '-Scope', 'Machine'
        '-Label', ('"{0}"' -f $Label)
    ) -join ' '
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments
    return
}

$target = Get-ClaudeTarget
if (-not $target) {
    throw '没有找到 Claude Desktop 安装（MSIX 或常规安装都没有）。请先安装 Claude Desktop，再运行本脚本。'
}

# MSIX 版收不到 --os-entry，改用深链打开 Claude Code 项目。
$command = '"{0}" "{1}"' -f $target.CommandExe, 'claude://code/new?folder=%V'

$iconFile = Get-VerbIcon -SourceExe $target.IconExe
$icon = if ($iconFile) { '"{0}",0' -f $iconFile } else { '"{0}",0' -f $target.IconExe }

foreach ($root in $VerbRoots) {
    $path = Join-Path $ClassesRoot $root
    New-Item -Path $path -Force | Out-Null
    Set-Item -Path $path -Value $Label
    New-ItemProperty -Path $path -Name 'Icon' -Value $icon -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $path -Name 'Position' -Value 'Top' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $path -Name 'MultiSelectModel' -Value 'Single' -PropertyType String -Force | Out-Null
    New-Item -Path (Join-Path $path 'command') -Force | Out-Null
    Set-Item -Path (Join-Path $path 'command') -Value $command
}

Update-ShellAssociations

Write-Host '已添加右键菜单：' -NoNewline
Write-Host $Label -ForegroundColor Green
Write-Host ("  作用域   : {0} ({1})" -f $Scope, $ClassesRoot)
Write-Host ("  目标安装 : {0}" -f $target.Kind)
Write-Host ("  启动命令 : {0}" -f $command)
Write-Host ("  图标     : {0}" -f $icon)
Write-Host '  排序     : Position=Top'
Write-Host '  生效位置 : 文件夹、文件夹空白处、磁盘根目录（Win11 可能要点“显示更多选项”）'
