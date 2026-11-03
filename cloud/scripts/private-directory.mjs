import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') return;
  const acl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $p=$env:NOVEL_PRIVATE_FOLDER; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[IO.Directory]::GetAccessControl($p); $a.SetAccessRuleProtection($true,$false); foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)}; $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit",[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)); [IO.Directory]::SetAccessControl($p,$a); if(![IO.Directory]::GetAccessControl($p).AreAccessRulesProtected){throw "ACL verification failed"}'],
    { windowsHide: true, env: { ...process.env, NOVEL_PRIVATE_FOLDER: path }, encoding: 'utf8' });
  if (acl.status !== 0) throw new Error('Owner-only directory ACL could not be verified.');
}
