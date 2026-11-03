param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$allowed = [IO.Path]::GetFullPath((Join-Path $workspace 'data\cloud-platform')) + [IO.Path]::DirectorySeparatorChar
$actual = [IO.Path]::GetFullPath($Path)
if (-not $actual.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $actual -PathType Leaf)) {
  throw 'Refusing to change permissions outside the owned cloud credential directory.'
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
# provision.mjs explicitly invokes Windows PowerShell. Its inherited PSModulePath
# can include PowerShell 7 modules; avoid autoloading an incompatible Security
# module just to inspect this existing credential's ACL. Never read its contents.
$current = [IO.File]::GetAccessControl($actual)
$rules = @($current.Access)
if ($current.AreAccessRulesProtected -and $rules.Count -eq 1 -and
    $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and
    $rules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    ($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) {
  Write-Output 'Owner key ACL already verified; no permission rewrite required.'
  exit 0
}
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
[IO.File]::SetAccessControl($actual, $acl)
$saved = [IO.File]::GetAccessControl($actual)
if (-not $saved.AreAccessRulesProtected -or @($saved.Access).Count -ne 1) { throw 'Credential ACL could not be verified.' }
Write-Output 'Owner key restricted to the current Windows user.'
