using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Drawing;

internal static class Program
{
    internal static string PipeName;
    [STAThread]
    private static void Main(string[] args)
    {
        string data = Environment.GetEnvironmentVariable("WATCH_PARTY_DATA_DIR") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DriveWatchParty");
        string identity = WindowsIdentity.GetCurrent().User.Value + "|" + Path.GetFullPath(data).ToUpperInvariant();
        using (SHA256 hash = SHA256.Create())
            PipeName = "DriveWatchParty." + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-", "").Substring(0, 24);
        bool created;
        using (Mutex mutex = new Mutex(true, @"Local\" + PipeName, out created))
        {
            bool quit = Array.IndexOf(args, "--shutdown") >= 0;
            if (!created)
            {
                try
                {
                    using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut))
                    {
                        pipe.Connect(10000);
                        using (StreamWriter writer = new StreamWriter(pipe))
                        {
                            writer.WriteLine(quit ? "quit" : "open");
                            writer.Flush();
                            if (new StreamReader(pipe).ReadLine() != "ok") throw new IOException();
                        }
                    }
                    if (quit)
                    {
                        if (!mutex.WaitOne(15000)) Environment.ExitCode = 1;
                        else mutex.ReleaseMutex();
                    }
                }
                catch
                {
                    Environment.ExitCode = 1;
                    if (!quit) MessageBox.Show("Watch Party is starting or shutting down. Try again shortly.", "Watch Party");
                }
                return;
            }
            try
            {
                if (quit) return;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new DesktopContext());
            }
            catch
            {
                Environment.ExitCode = 1;
                MessageBox.Show("Watch Party could not start. Repair or reinstall the application.", "Watch Party");
            }
            finally { mutex.ReleaseMutex(); }
        }
    }
}

internal sealed class DesktopContext : ApplicationContext
{
    private readonly Control dispatcher = new Control();
    private readonly NotifyIcon tray;
    private readonly Process child;
    private readonly OwnedProcesses owned = new OwnedProcesses();
    private readonly Thread pipeThread;
    private bool closing;
    private string launchUrl;

    public DesktopContext()
    {
        dispatcher.CreateControl();
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Open Watch Party", null, delegate { Open(); });
        menu.Items.Add("Quit", null, delegate { Quit(); });
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "VLC Drive Watch Party", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { Open(); };
        pipeThread = new Thread(Listen) { IsBackground = true };
        pipeThread.Start();
        string root = AppDomain.CurrentDomain.BaseDirectory;
        ProcessStartInfo start = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"),
            Quote(Path.Combine(root, "app", "dist", "desktop.js")))
        {
            WorkingDirectory = Path.Combine(root, "app"), UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.EnvironmentVariables.Remove("NODE_OPTIONS");
        start.EnvironmentVariables.Remove("NODE_PATH");
        child = new Process { StartInfo = start, EnableRaisingEvents = true };
        child.OutputDataReceived += Output;
        child.ErrorDataReceived += delegate { /* Never persist runtime diagnostics containing user data. */ };
        child.Exited += delegate { child.WaitForExit(); Dispatch(delegate {
            if (!closing)
            {
                MessageBox.Show("Watch Party stopped. Launch it again to reconnect.", "Watch Party");
                Quit();
            }
        }); };
        try
        {
            child.Start();
            owned.Attach(child);
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
        }
        catch
        {
            tray.Dispose();
            owned.Dispose();
            try { if (!child.HasExited) child.Kill(); } catch {}
            throw;
        }
    }
    private static string Quote(string value) { return "\"" + value.Replace("\"", "") + "\""; }
    private void Dispatch(Action action)
    {
        try { if (!dispatcher.IsDisposed) dispatcher.BeginInvoke(action); } catch (InvalidOperationException) {}
    }
    private void Output(object sender, DataReceivedEventArgs args)
    {
        if (String.IsNullOrEmpty(args.Data)) return;
        try
        {
            Dictionary<string, object> message = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(args.Data);
            object type;
            if (!message.TryGetValue("type", out type)) return;
            if ((string)type == "ready")
            {
                string url = (string)message["url"];
                Uri parsed;
                if (!Uri.TryCreate(url, UriKind.Absolute, out parsed) || parsed.Scheme != "http" || parsed.Host != "127.0.0.1") return;
                Dispatch(delegate { launchUrl = url; Open(); });
            }
            else if ((string)type == "error")
                Dispatch(delegate { if (!closing) { MessageBox.Show((string)message["message"], "Watch Party"); Quit(); } });
            else if ((string)type == "closing") Dispatch(Quit);
        }
        catch { }
    }
    private void Open()
    {
        if (closing || launchUrl == null || Environment.GetEnvironmentVariable("WATCH_PARTY_NO_BROWSER") == "1") return;
        try
        {
            string browser = Environment.GetEnvironmentVariable("WATCH_PARTY_BROWSER");
            if (String.IsNullOrEmpty(browser)) Process.Start(new ProcessStartInfo(launchUrl) { UseShellExecute = true });
            else Process.Start(new ProcessStartInfo(browser, Quote(launchUrl)) { UseShellExecute = false });
        }
        catch { MessageBox.Show("Could not open your browser. Set a default web browser in Windows and reopen Watch Party.", "Watch Party"); }
    }
    private void Listen()
    {
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        while (!closing)
        {
            try
            {
                using (NamedPipeServerStream pipe = new NamedPipeServerStream(Program.PipeName, PipeDirection.InOut,
                    1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security))
                {
                    pipe.WaitForConnection();
                    StringBuilder request = new StringBuilder();
                    for (int i = 0; i < 16; i++)
                    {
                        int value = pipe.ReadByte();
                        if (value < 0 || value == '\n') break;
                        if (value != '\r') request.Append((char)value);
                    }
                    string command = request.ToString();
                    byte[] response = Encoding.UTF8.GetBytes("ok\n");
                    pipe.Write(response, 0, response.Length);
                    pipe.Flush();
                    if (command == "quit") Dispatch(Quit);
                    else if (command == "open") Dispatch(Open);
                }
            }
            catch { if (!closing) Thread.Sleep(100); }
        }
    }
    private void Quit()
    {
        if (closing) return;
        closing = true;
        tray.Visible = false;
        try { if (!child.HasExited) { child.StandardInput.WriteLine("quit"); child.StandardInput.Flush(); } } catch {}
        Thread waiter = new Thread(delegate()
        {
            try { child.WaitForExit(6000); } catch {}
            owned.Dispose();
            Dispatch(delegate { tray.Dispose(); child.Dispose(); dispatcher.Dispose(); ExitThread(); });
        }) { IsBackground = true };
        waiter.Start();
    }
}

internal sealed class OwnedProcesses : IDisposable
{
    private IntPtr handle;
    public OwnedProcesses()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        JobLimits limits = new JobLimits();
        limits.Basic.Flags = 0x2000; // Kill only this launcher's descendant processes if the launcher exits.
        int size = Marshal.SizeOf(typeof(JobLimits));
        IntPtr memory = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, memory, false);
            if (handle == IntPtr.Zero || !SetInformationJobObject(handle, 9, memory, (uint)size))
                throw new InvalidOperationException();
        }
        finally { Marshal.FreeHGlobal(memory); }
    }
    public void Attach(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle)) throw new InvalidOperationException();
    }
    public void Dispose()
    {
        if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
