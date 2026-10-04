#Requires -Version 5.1
<#
.SYNOPSIS
    移除“Open project in Claude Desktop”右键菜单。
.DESCRIPTION
    同时清理 HKCU 和 HKLM 两处，并删除抽出来的图标文件；清理 HKLM 和 ProgramData 需要管理员。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$VerbRoots = @(
    'Directory\shell\OpenProjectInClaudeDesktop'
    'Directory\Background\shell\OpenProjectInClaudeDesktop'
    'Drive\shell\OpenProjectInClaudeDesktop'
)

foreach ($classesRoot in @('HKCU:\Software\Classes', 'HKLM:\Software\Classes')) {
    foreach ($root in $VerbRoots) {
        $path = Join-Path $classesRoot $root
        if (Test-Path -LiteralPath $path) {
            try {
                Remove-Item -LiteralPath $path -Recurse -Force
                Write-Host ("已移除 {0}\{1}" -f $classesRoot, $root)
            } catch {
                Write-Warning ("无法移除 {0}\{1}：{2}" -f $classesRoot, $root, $_.Exception.Message)
            }
        }
    }
}

# 清掉抽出来的图标，只在目录里确实只剩我们自己的文件时才删目录。
foreach ($base in @($env:LOCALAPPDATA, $env:ProgramData)) {
    if (-not $base) { continue }
    $dir = Join-Path $base 'ClaudeOpenProject'
    $ico = Join-Path $dir 'claude.ico'
    try {
        if (Test-Path -LiteralPath $ico) {
            Remove-Item -LiteralPath $ico -Force
            Write-Host ("已删除图标 {0}" -f $ico)
        }
        if ((Test-Path -LiteralPath $dir) -and -not (Get-ChildItem -LiteralPath $dir -Force)) {
            Remove-Item -LiteralPath $dir -Force
        }
    } catch {
        Write-Warning ("清理 {0} 失败：{1}" -f $dir, $_.Exception.Message)
    }
}

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
