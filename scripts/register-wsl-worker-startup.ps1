#Requires -Version 5.1
#Requires -Modules ScheduledTasks
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$')]
    [string]$Distribution,

    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z_][a-z0-9_-]{0,31}$')]
    [string]$LinuxUser,

    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,39}$')]
    [string]$Name,

    [ValidatePattern('^/[a-zA-Z0-9._/-]+$')]
    [string]$LinuxHome,

    [switch]$Start
)

$ErrorActionPreference = 'Stop'
if (-not $LinuxHome) { $LinuxHome = "/home/$LinuxUser" }
$wsl = (Get-Command wsl.exe -CommandType Application | Select-Object -First 1).Source
$runner = "$($LinuxHome.TrimEnd('/'))/.local/share/ado-workers/$Name/run"
& $wsl --distribution $Distribution --user $LinuxUser --exec /usr/bin/test -x $runner
if ($LASTEXITCODE -ne 0) { throw "Install the Worker launcher first at $runner." }

$taskName = "ADO Worker $Distribution $LinuxUser $Name"
$windowsUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $wsl `
    -Argument "--distribution $Distribution --user $LinuxUser --exec $runner start"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $windowsUser
$principal = New-ScheduledTaskPrincipal -UserId $windowsUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
    throw "Stop the existing scheduled task before replacing its configuration: $taskName"
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'Start the ADO Worker in WSL at Windows sign-in.' -Force | Out-Null
if ($Start) { Start-ScheduledTask -TaskName $taskName }
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
