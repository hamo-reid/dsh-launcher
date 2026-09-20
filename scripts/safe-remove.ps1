<#
.SYNOPSIS
  Recursively remove a path ONLY when it is provably inside an allowed root.

.DESCRIPTION
  Guards against the class of mistake that deleted a real user data directory:
  a destructive command run against a path built from a variable that silently
  resolved somewhere unexpected (e.g. `$home`, a read-only PowerShell automatic
  variable, so the assignment failed but the script kept going).

  Every caller must name the root it is allowed to delete inside. A target
  outside that root is refused with a hard error. `-WhatIf` shows the plan
  without deleting anything.

.PARAMETER Path
  The file or directory to remove.

.PARAMETER Root
  The allow-list root. `Path` must be a strict descendant of it.

.EXAMPLE
  ./scripts/safe-remove.ps1 -Path "$env:TEMP\verify\home\dsh-launcher" -Root $env:TEMP -WhatIf

.EXAMPLE
  ./scripts/safe-remove.ps1 -Path "$env:TEMP\verify" -Root $env:TEMP
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Root
)

# A failed assignment must stop the script, never fall through to a delete.
$ErrorActionPreference = 'Stop'

$full = [System.IO.Path]::GetFullPath($Path)
$rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char]'\')
$rootPrefix = $rootFull + '\'

if (-not $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "REFUSED: '$full' is not inside the allowed root '$rootFull'"
}
if ($full -eq $rootFull) {
  throw "REFUSED: '$full' is the allowed root itself; pick a child path"
}
if ($full.Length -le $rootPrefix.Length) {
  throw "REFUSED: '$full' is too close to the root '$rootFull'"
}

if (-not (Test-Path -LiteralPath $full)) {
  Write-Verbose "nothing to remove: $full"
  return
}

Write-Verbose "target verified inside '$rootFull': $full"
if ($PSCmdlet.ShouldProcess($full, 'Remove-Item -Recurse -Force')) {
  Remove-Item -LiteralPath $full -Recurse -Force
  Write-Host "removed: $full"
}
