using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

static class Program
{
    const string AppName = "TeleProxyBridge";
    const string DisplayTitle = "TeleProxyBridge";
    const string PayloadResource = "payload.zip";
    const string AppVersion = "1.0.0";

    static StreamWriter logFile;

    [STAThread]
    static int Main(string[] args)
    {
        string dir = ArgValue(args, "--dir");
        if (dir == null)
            dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName);

        bool silent = Has(args, "--silent");
        bool autostart = !Has(args, "--no-autostart");
        bool shortcut = !Has(args, "--no-shortcut");
        bool launch = !Has(args, "--no-launch");

        if (silent)
        {
            string logPath = Path.Combine(Path.GetTempPath(), "tpb-setup.log");
            logFile = new StreamWriter(logPath, false, new UTF8Encoding(false));
            try
            {
                Log("silent install -> " + dir);
                Install(dir, autostart, shortcut, launch);
                Log("install ok");
                return 0;
            }
            catch (Exception ex)
            {
                Log("FAILED: " + ex);
                return 1;
            }
            finally
            {
                logFile.Flush();
                logFile.Close();
            }
        }

        HideConsole();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm(dir));
        return 0;
    }

    [DllImport("kernel32.dll")]
    static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    /** Built as a console exe (Kaspersky blocks the same binary as a winexe); hide the console on start. */
    static void HideConsole()
    {
        try
        {
            IntPtr h = GetConsoleWindow();
            if (h != IntPtr.Zero) ShowWindow(h, 0);
        }
        catch { }
    }

    static bool Has(string[] args, string name)
    {
        return Array.IndexOf(args, name) >= 0;
    }

    static string ArgValue(string[] args, string name)
    {
        int i = Array.IndexOf(args, name);
        if (i >= 0 && i + 1 < args.Length) return args[i + 1];
        return null;
    }

    static void Log(string msg)
    {
        if (logFile != null)
        {
            logFile.WriteLine(DateTime.Now.ToString("HH:mm:ss") + "  " + msg);
        }
        Console.WriteLine(msg);
    }

    // ------------------------------------------------------------------ install

    public static void Install(string dir, bool autostart, bool shortcut, bool launch, Action<string> log = null)
    {
        Directory.CreateDirectory(dir);
        Report(log, "安装目录: " + dir);
        StopRunningBridge(dir, log);
        ExtractPayload(dir, log);

        string node = FindNode(dir);
        string cli = Path.Combine(dir, "src", "cli.mjs");
        if (node == null) throw new Exception("找不到 node.exe（安装包内应自带）");
        Report(log, "node: " + node);

        int up = RunProcess(node, "\"" + cli + "\" up --quiet --no-restart", dir, log, 180000);
        if (up != 0) Report(log, "警告: 一键启动返回 " + up + "，可稍后在控制台点「接管 TeleAgent」重试");
        if (!autostart) RunProcess(node, "\"" + cli + "\" autostart off", dir, log, 30000);

        WriteLauncher(dir);
        if (shortcut) CreateShortcuts(dir, log);
        WriteUninstallEntry(dir, node);
        Report(log, "安装完成");
        if (launch) StartPanel(dir, log);
    }

    static void Report(Action<string> log, string msg)
    {
        Log(msg);
        if (log != null) log(msg);
    }

    static void StopRunningBridge(string dir, Action<string> log)
    {
        try
        {
            string pidFile = Path.Combine(dir, ".tpb.pid");
            if (File.Exists(pidFile))
            {
                string text = File.ReadAllText(pidFile).Trim();
                int pid;
                if (int.TryParse(text, out pid) && pid > 0)
                {
                    Report(log, "停止正在运行的中继 (pid " + pid + ")");
                    RunProcess("taskkill", "/PID " + pid + " /T /F", dir, null, 15000);
                }
            }
        }
        catch { }
    }

    static void ExtractPayload(string dir, Action<string> log)
    {
        Assembly asm = Assembly.GetExecutingAssembly();
        using (Stream s = asm.GetManifestResourceStream(PayloadResource))
        {
            if (s == null) throw new Exception("安装包损坏: 缺少 payload");
            using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                int count = 0;
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string rel = entry.FullName.Replace('/', '\\');
                    string target = Path.Combine(dir, rel);
                    if (entry.Name.Length == 0)
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream input = entry.Open())
                    using (FileStream output = File.Create(target))
                    {
                        input.CopyTo(output);
                    }
                    count++;
                }
                Report(log, "解压 " + count + " 个文件");
            }
        }
    }

    static string FindNode(string dir)
    {
        string bundled = Path.Combine(dir, "node.exe");
        if (File.Exists(bundled)) return bundled;
        string pathVar = Environment.GetEnvironmentVariable("PATH");
        if (pathVar != null)
        {
            foreach (string part in pathVar.Split(';'))
            {
                try
                {
                    string candidate = Path.Combine(part.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
        }
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string tele = Path.Combine(local, ".local", "share", "TeleAgent", "runtimes", "node", "node.exe");
        if (File.Exists(tele)) return tele;
        return null;
    }

    static int RunProcess(string exe, string args, string cwd, Action<string> log, int timeoutMs)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(exe, args);
            psi.WorkingDirectory = cwd;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            using (Process p = Process.Start(psi))
            {
                StringBuilder sb = new StringBuilder();
                p.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) sb.AppendLine(e.Data); };
                p.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) sb.AppendLine(e.Data); };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                if (!p.WaitForExit(timeoutMs))
                {
                    try { p.Kill(); } catch { }
                    Report(log, "超时: " + Path.GetFileName(exe));
                    return -1;
                }
                string text = sb.ToString().Trim();
                if (text.Length > 0)
                {
                    foreach (string line in text.Split('\n'))
                    {
                        string t = line.TrimEnd();
                        if (t.Length > 0) Report(log, "  " + t);
                    }
                }
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Report(log, "执行失败 " + ex.Message);
            return -1;
        }
    }

    static void WriteLauncher(string dir)
    {
        string vbs =
            "' TeleProxyBridge launcher (created by the installer)\r\n" +
            "Set sh = CreateObject(\"WScript.Shell\")\r\n" +
            "sh.CurrentDirectory = \"" + dir + "\"\r\n" +
            "sh.Run Chr(34) & \"" + Path.Combine(dir, "node.exe") + "\" & Chr(34) & \" \" & Chr(34) & \"" + Path.Combine(dir, "src", "cli.mjs") + "\" & Chr(34) & \" ui\", 0, False\r\n";
        File.WriteAllText(Path.Combine(dir, "launch.vbs"), vbs, new UTF8Encoding(false));
    }

    static void CreateShortcuts(string dir, Action<string> log)
    {
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName);
        Directory.CreateDirectory(startMenu);

        List<string> links = new List<string>();
        links.Add(Path.Combine(desktop, AppName + ".lnk"));
        links.Add(Path.Combine(startMenu, AppName + ".lnk"));

        string vbs = Path.Combine(dir, "launch.vbs");
        string ps1 = Path.Combine(Path.GetTempPath(), "tpb-shortcut.ps1");
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("$ErrorActionPreference='Stop'");
        sb.AppendLine("$sh = New-Object -ComObject WScript.Shell");
        foreach (string lnk in links)
        {
            sb.AppendLine("$s = $sh.CreateShortcut('" + lnk.Replace("'", "''") + "')");
            sb.AppendLine("$s.TargetPath = '" + Path.Combine(Environment.SystemDirectory, "wscript.exe") + "'");
            sb.AppendLine("$s.Arguments = '\"" + vbs.Replace("'", "''") + "\"'");
            sb.AppendLine("$s.WorkingDirectory = '" + dir.Replace("'", "''") + "'");
            sb.AppendLine("$s.IconLocation = '" + Path.Combine(dir, "node.exe").Replace("'", "''") + ",0'");
            sb.AppendLine("$s.Description = '" + DisplayTitle + " 控制台'");
            sb.AppendLine("$s.Save()");
        }
        File.WriteAllText(ps1, sb.ToString(), new UTF8Encoding(true));
        int code = RunProcess("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + ps1 + "\"", dir, null, 60000);
        try { File.Delete(ps1); } catch { }
        Report(log, code == 0 ? "快捷方式已创建: 桌面 + 开始菜单" : "快捷方式创建失败 (code " + code + ")");
    }

    static void WriteUninstallEntry(string dir, string node)
    {
        string key = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppName;
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(key))
        {
            string cli = Path.Combine(dir, "src", "cli.mjs");
            k.SetValue("DisplayName", DisplayTitle + " 控制台");
            k.SetValue("DisplayVersion", AppVersion);
            k.SetValue("Publisher", "tele-proxy-bridge");
            k.SetValue("InstallLocation", dir);
            k.SetValue("DisplayIcon", node);
            k.SetValue("UninstallString", "\"" + node + "\" \"" + cli + "\" uninstall --yes");
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    static void StartPanel(string dir, Action<string> log)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "wscript.exe"),
                "\"" + Path.Combine(dir, "launch.vbs") + "\"");
            psi.WorkingDirectory = dir;
            psi.UseShellExecute = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);
            Report(log, "控制台已打开");
        }
        catch (Exception ex)
        {
            Report(log, "打开控制台失败: " + ex.Message);
        }
    }
}

class SetupForm : Form
{
    TextBox dirBox;
    CheckBox autostartBox;
    CheckBox shortcutBox;
    CheckBox launchBox;
    TextBox logBox;
    Button installButton;
    Button closeButton;
    Label hint;

    public SetupForm(string defaultDir)
    {
        Text = "TeleProxyBridge 安装程序";
        ClientSize = new Size(680, 520);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = Color.FromArgb(15, 23, 32);
        ForeColor = Color.FromArgb(230, 237, 245);
        Font = new Font("Microsoft YaHei UI", 9f);

        Label title = new Label();
        title.Text = "TeleProxyBridge";
        title.Font = new Font("Microsoft YaHei UI", 17f, FontStyle.Bold);
        title.ForeColor = Color.FromArgb(94, 234, 212);
        title.SetBounds(24, 18, 400, 36);

        Label sub = new Label();
        sub.Text = "TeleAgent 本地中继 + 每日签到 + 控制台，全部在本机运行";
        sub.ForeColor = Color.FromArgb(139, 155, 176);
        sub.SetBounds(26, 56, 600, 20);

        Label version = new Label();
        version.Text = "版本 " + "1.0.0" + " · 无需管理员权限 · 安装到当前用户目录";
        version.ForeColor = Color.FromArgb(93, 109, 128);
        version.SetBounds(26, 78, 600, 20);

        Label dirLabel = new Label();
        dirLabel.Text = "安装目录";
        dirLabel.SetBounds(26, 116, 80, 20);

        dirBox = new TextBox();
        dirBox.Text = defaultDir;
        dirBox.SetBounds(26, 138, 520, 24);
        dirBox.BackColor = Color.FromArgb(19, 28, 38);
        dirBox.ForeColor = Color.FromArgb(230, 237, 245);
        dirBox.BorderStyle = BorderStyle.FixedSingle;

        Button browse = new Button();
        browse.Text = "浏览…";
        browse.SetBounds(556, 137, 98, 26);
        browse.FlatStyle = FlatStyle.Flat;
        browse.FlatAppearance.BorderColor = Color.FromArgb(38, 55, 74);
        browse.BackColor = Color.FromArgb(19, 28, 38);
        browse.Click += delegate
        {
            FolderBrowserDialog dlg = new FolderBrowserDialog();
            dlg.SelectedPath = dirBox.Text;
            if (dlg.ShowDialog(this) == DialogResult.OK) dirBox.Text = dlg.SelectedPath;
        };

        autostartBox = new CheckBox();
        autostartBox.Text = "开机自动运行中继与签到守护";
        autostartBox.Checked = true;
        autostartBox.SetBounds(26, 178, 320, 22);

        shortcutBox = new CheckBox();
        shortcutBox.Text = "创建桌面快捷方式";
        shortcutBox.Checked = true;
        shortcutBox.SetBounds(26, 204, 240, 22);

        launchBox = new CheckBox();
        launchBox.Text = "安装完成后打开控制台";
        launchBox.Checked = true;
        launchBox.SetBounds(26, 230, 260, 22);

        hint = new Label();
        hint.Text = "安装过程中会自动接管 TeleAgent 的模型请求（可随时在控制台还原）。";
        hint.ForeColor = Color.FromArgb(139, 155, 176);
        hint.SetBounds(26, 264, 620, 20);

        logBox = new TextBox();
        logBox.Multiline = true;
        logBox.ReadOnly = true;
        logBox.ScrollBars = ScrollBars.Vertical;
        logBox.SetBounds(26, 292, 628, 156);
        logBox.BackColor = Color.FromArgb(7, 11, 15);
        logBox.ForeColor = Color.FromArgb(184, 200, 217);
        logBox.BorderStyle = BorderStyle.FixedSingle;
        logBox.Font = new Font("Consolas", 8.5f);

        installButton = new Button();
        installButton.Text = "开始安装";
        installButton.SetBounds(26, 464, 130, 36);
        installButton.FlatStyle = FlatStyle.Flat;
        installButton.BackColor = Color.FromArgb(94, 234, 212);
        installButton.ForeColor = Color.FromArgb(5, 46, 43);
        installButton.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
        installButton.FlatAppearance.BorderSize = 0;
        installButton.Click += delegate { StartInstall(); };

        closeButton = new Button();
        closeButton.Text = "取消";
        closeButton.SetBounds(524, 464, 130, 36);
        closeButton.FlatStyle = FlatStyle.Flat;
        closeButton.BackColor = Color.FromArgb(19, 28, 38);
        closeButton.FlatAppearance.BorderColor = Color.FromArgb(38, 55, 74);
        closeButton.Click += delegate { Close(); };

        Controls.Add(title);
        Controls.Add(sub);
        Controls.Add(version);
        Controls.Add(dirLabel);
        Controls.Add(dirBox);
        Controls.Add(browse);
        Controls.Add(autostartBox);
        Controls.Add(shortcutBox);
        Controls.Add(launchBox);
        Controls.Add(hint);
        Controls.Add(logBox);
        Controls.Add(installButton);
        Controls.Add(closeButton);
    }

    void Append(string msg)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action<string>(Append), msg);
            return;
        }
        logBox.AppendText(msg + "\r\n");
    }

    void StartInstall()
    {
        string dir = dirBox.Text.Trim();
        if (dir.Length == 0)
        {
            MessageBox.Show(this, "请填写安装目录", "提示");
            return;
        }
        installButton.Enabled = false;
        closeButton.Enabled = false;
        dirBox.Enabled = false;
        autostartBox.Enabled = false;
        shortcutBox.Enabled = false;
        launchBox.Enabled = false;
        logBox.Text = "";
        bool autostart = autostartBox.Checked;
        bool shortcut = shortcutBox.Checked;
        bool launch = launchBox.Checked;

        System.Threading.Thread t = new System.Threading.Thread(delegate()
        {
            try
            {
                Program.Install(dir, autostart, shortcut, launch, Append);
                BeginInvoke(new Action(delegate
                {
                    hint.Text = "安装完成。桌面快捷方式可随时打开控制台。";
                    hint.ForeColor = Color.FromArgb(52, 211, 153);
                    installButton.Text = "完成";
                    installButton.Enabled = true;
                    installButton.Click -= delegate { StartInstall(); };
                    installButton.Click += delegate { Close(); };
                    closeButton.Enabled = true;
                }));
            }
            catch (Exception ex)
            {
                Append("安装失败: " + ex.Message);
                BeginInvoke(new Action(delegate
                {
                    hint.Text = "安装失败，详见上方日志。";
                    hint.ForeColor = Color.FromArgb(248, 113, 113);
                    installButton.Enabled = true;
                    closeButton.Enabled = true;
                }));
            }
        });
        t.IsBackground = true;
        t.Start();
    }
}
