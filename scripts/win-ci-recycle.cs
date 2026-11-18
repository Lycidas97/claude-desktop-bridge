using System;
using System.Runtime.InteropServices;

public static class WindowsCiRecycle {
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        [return: MarshalAs(UnmanagedType.Interface)]
        ITransferSource BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid);
        IShellItem GetParent();
    }

    [ComImport, Guid("00ADB003-BDE9-45C6-8E29-D09F9353E108"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ITransferSource {
        // Preserve the COM vtable order up to RecycleItem.
        void Advise();
        void Unadvise();
        void SetProperties();
        void OpenItem();
        void MoveItem();
        IShellItem RecycleItem(IShellItem source, IShellItem recycleBin, uint flags);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr bindContext, ref Guid iid, out IShellItem item);

    [DllImport("shell32.dll", PreserveSig = false)]
    static extern void SHGetKnownFolderItem(ref Guid folder, uint flags, IntPtr token, ref Guid iid, out IShellItem item);

    public static void Recycle(string path) {
        var shellItem = typeof(IShellItem).GUID;
        var transferSource = typeof(ITransferSource).GUID;
        var transferHandler = new Guid("D5E346A1-F753-4932-B403-4574800E2498"); // BHID_Transfer
        var recycleBin = new Guid("B7534046-3ECB-4C18-BE4E-64CD4CB7D6AC"); // FOLDERID_RecycleBinFolder
        IShellItem item, bin;
        SHCreateItemFromParsingName(path, IntPtr.Zero, ref shellItem, out item);
        SHGetKnownFolderItem(ref recycleBin, 0, IntPtr.Zero, ref shellItem, out bin);
        var recycled = item.GetParent().BindToHandler(IntPtr.Zero, ref transferHandler, ref transferSource)
            .RecycleItem(item, bin, 0);
        if (recycled == null) {
            throw new InvalidOperationException("Recycle Bin did not accept " + path);
        }
    }
}
