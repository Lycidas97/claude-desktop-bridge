using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct SHFILEOPSTRUCT {
    public IntPtr hwnd;
    public uint wFunc;
    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
    public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
}

static class Program {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHFileOperation(ref SHFILEOPSTRUCT lpFileOp);

    [STAThread]
    static int Main(string[] args) {
        string p = args.Length > 0 ? args[0] : Environment.GetEnvironmentVariable("BRIDGE_RECYCLE_PATH");
        if (string.IsNullOrEmpty(p)) {
            Console.Error.WriteLine("Missing recycle target path");
            return 2;
        }
        if (p.Length > 3) p = p.TrimEnd('\\', '/');
        var op = new SHFILEOPSTRUCT {
            wFunc = 3, // FO_DELETE
            pFrom = p + "\0\0",
            fFlags = 0x0454 // FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
        };
        int rc = SHFileOperation(ref op);
        if (rc != 0 || op.fAnyOperationsAborted) {
            Console.Error.WriteLine("Recycle-bin SHFileOperation failed for {0} (code={1}, aborted={2})", p, rc, op.fAnyOperationsAborted);
            return rc != 0 ? rc : 1;
        }
        return 0;
    }
}
