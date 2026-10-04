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

function Get-StableIcon {
    # 把图标抽成固定路径的 .ico，Claude 升级换目录后菜单图标不会失效。
    param([string]$SourceExe)

    $base = if ($Scope -eq 'Machine') { $env:ProgramData } else { $env:LOCALAPPDATA }
    if (-not $base) { return $null }

    $dir = Join-Path $base 'ClaudeOpenProject'
    $ico = Join-Path $dir 'claude.ico'
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($SourceExe)
        if ($null -eq $icon) { return $null }
        $stream = [System.IO.File]::Create($ico)
        try { $icon.Save($stream) } finally { $stream.Close(); $icon.Dispose() }
        if ((Get-Item -LiteralPath $ico).Length -gt 0) { return $ico }
    } catch {
        Write-Warning ("提取图标失败，退回直接用可执行文件当图标：{0}" -f $_.Exception.Message)
    }
    return $null
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

$iconFile = Get-StableIcon -SourceExe $target.IconExe
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
