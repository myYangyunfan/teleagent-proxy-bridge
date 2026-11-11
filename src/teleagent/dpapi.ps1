# Unwraps the Chromium/Electron os_crypt key with Windows DPAPI (CurrentUser scope).
# Reads the "Local State" path from $env:TPB_LOCAL_STATE and prints the AES key as hex.
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
public class TpbDpapi {
  [DllImport("Crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, string szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);
  [StructLayout(LayoutKind.Sequential)]
  public struct DATA_BLOB { public int cbData; public IntPtr pbData; }
  public static byte[] Unprotect(byte[] data) {
    DATA_BLOB inBlob = new DATA_BLOB(); DATA_BLOB outBlob = new DATA_BLOB();
    IntPtr p = Marshal.AllocHGlobal(data.Length);
    Marshal.Copy(data, 0, p, data.Length);
    inBlob.cbData = data.Length; inBlob.pbData = p;
    if (!CryptUnprotectData(ref inBlob, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref outBlob)) throw new Exception("DPAPI failed " + Marshal.GetLastWin32Error());
    byte[] outData = new byte[outBlob.cbData];
    Marshal.Copy(outBlob.pbData, outData, 0, outBlob.cbData);
    return outData;
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
$ls = Get-Content -Raw $env:TPB_LOCAL_STATE | ConvertFrom-Json
$enc = [Convert]::FromBase64String($ls.os_crypt.encrypted_key)
$blob = $enc[5..($enc.Length-1)]
$key = [TpbDpapi]::Unprotect($blob)
Write-Output (($key | ForEach-Object { $_.ToString('x2') }) -join '')
