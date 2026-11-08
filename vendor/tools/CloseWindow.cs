using System;
using System.Runtime.InteropServices;

internal static class CloseWindow
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    private const uint WM_CLOSE = 0x0010;

    private static int Main(string[] args)
    {
        int pid;
        if (args.Length < 1 || !int.TryParse(args[0], out pid))
        {
            return 2;
        }

        // 优先按窗口标题精确查找，避免向同进程的其他隐藏窗口发送关闭消息
        if (args.Length > 1 && !string.IsNullOrEmpty(args[1]))
        {
            IntPtr byTitle = FindWindow(null, args[1]);
            if (byTitle != IntPtr.Zero)
            {
                PostMessage(byTitle, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                return 0;
            }
        }

        int count = 0;
        EnumWindows((hWnd, lParam) =>
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == (uint)pid && IsWindowVisible(hWnd))
            {
                PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                count++;
            }
            return true;
        }, IntPtr.Zero);

        return count > 0 ? 0 : 1;
    }
}
