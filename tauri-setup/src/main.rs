#![windows_subsystem = "windows"]

//! TeleProxyBridge native setup (Tauri 2 / WebView2).
//! Replaces the WinForms installer: native window, Rust backend, same payload zip.

use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const PAYLOAD: &[u8] = include_bytes!("../payload.zip");

/* ----------------------------- helpers ----------------------------- */

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

fn run_capture(program: &str, args: &[&str]) -> (bool, String) {
    run_capture_in(None, program, args)
}

fn run_capture_in(cwd: Option<&Path>, program: &str, args: &[&str]) -> (bool, String) {
    let mut c = Command::new(program);
    c.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    hide_console(&mut c);
    match c.output() {
        Ok(out) => {
            let mut s = String::from_utf8_lossy(&out.stdout).to_string();
            s.push_str(&String::from_utf8_lossy(&out.stderr));
            (out.status.success(), s.trim().to_string())
        }
        Err(e) => (false, e.to_string()),
    }
}

fn run_ps(script: &str) -> (bool, String) {
    let tmp = std::env::temp_dir().join(format!("tpb-{}.ps1", std::process::id()));
    // Windows PowerShell 5.1 reads .ps1 as ANSI unless there is a UTF-8 BOM —
    // without it any Chinese path in the script fails to parse.
    let mut bytes = Vec::with_capacity(script.len() + 3);
    bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    bytes.extend_from_slice(script.as_bytes());
    let _ = fs::write(&tmp, bytes);
    let r = run_capture(
        "powershell.exe",
        &[
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            &tmp.to_string_lossy(),
        ],
    );
    let _ = fs::remove_file(&tmp);
    r
}

fn local_appdata() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Users\\Public"))
}

fn default_dir() -> PathBuf {
    local_appdata().join("TeleProxyBridge")
}

fn bridge_up(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    match addr.parse() {
        Ok(a) => {
            let mut s = match TcpStream::connect_timeout(&a, Duration::from_millis(700)) {
                Ok(s) => s,
                Err(_) => return false,
            };
            let _ = s.set_read_timeout(Some(Duration::from_millis(900)));
            let req = format!("GET /health HTTP/1.0\r\nHost: 127.0.0.1:{}\r\n\r\n", port);
            if s.write_all(req.as_bytes()).is_err() {
                return false;
            }
            let mut buf = [0u8; 64];
            match s.read(&mut buf) {
                Ok(n) if n > 0 => String::from_utf8_lossy(&buf[..n]).contains("200"),
                _ => false,
            }
        }
        Err(_) => false,
    }
}

/// TeleAgent.exe 的候选位置：环境变量 -> 注册表卸载项 -> 常见安装目录。
/// 不写死任何个人路径，别的电脑装到哪儿都能认出来。
fn teleagent_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if !out.iter().any(|x| x.to_string_lossy().eq_ignore_ascii_case(&p.to_string_lossy())) {
            out.push(p);
        }
    };

    if let Ok(v) = std::env::var("TELEAGENT_EXE") {
        add(PathBuf::from(v));
    }

    for root in [
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ] {
        let mut c = Command::new("reg");
        c.args(["query", root, "/s", "/f", "TeleAgent", "/t", "REG_SZ"]);
        hide_console(&mut c);
        if let Ok(o) = c.output() {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            for line in text.lines() {
                let t = line.trim();
                let rest = match t.strip_prefix("DisplayIcon").or_else(|| t.strip_prefix("InstallLocation")) {
                    Some(r) => r.trim(),
                    None => continue,
                };
                let value = match rest.split_once("REG_SZ") {
                    Some((_, v)) => v.trim().trim_matches('"'),
                    None => continue,
                };
                let p = value.split(',').next().unwrap_or(value).trim();
                if p.is_empty() {
                    continue;
                }
                let path = PathBuf::from(p);
                add(if p.to_lowercase().ends_with(".exe") { path } else { path.join("TeleAgent.exe") });
            }
        }
    }

    for base in [local_appdata().join("Programs"), local_appdata()] {
        add(base.join("TeleAgent").join("TeleAgent.exe"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        add(PathBuf::from(pf).join("TeleAgent").join("TeleAgent.exe"));
    }
    add(PathBuf::from("C:\\Program Files\\TeleAgent\\TeleAgent.exe"));
    add(PathBuf::from("C:\\Program Files (x86)\\TeleAgent\\TeleAgent.exe"));
    out
}

fn find_teleagent() -> Option<PathBuf> {
    teleagent_candidates().into_iter().find(|p| p.exists())
}

fn node_version(exe: &Path) -> String {
    let mut c = Command::new(exe);
    c.arg("--version");
    hide_console(&mut c);
    match c.output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => String::new(),
    }
}

/// node.exe shipped inside the payload, else the one already installed, else PATH.
fn resolve_node(dir: &Path) -> Option<PathBuf> {
    let candidates = [
        dir.join("node.exe"),
        default_dir().join("node.exe"),
        PathBuf::from("node.exe"),
    ];
    for c in candidates {
        if c.exists() || c == Path::new("node.exe") {
            let v = node_version(&c);
            if !v.is_empty() && v.starts_with('v') {
                return Some(c);
            }
        }
    }
    None
}

/* ----------------------------- state ----------------------------- */

#[derive(Serialize)]
struct EnvInfo {
    node: Option<String>,
    node_version: Option<String>,
    teleagent: Option<String>,
    default_dir: String,
    existing: Option<String>,
    installed_dir: Option<String>,
    bridge_up: bool,
}

fn uninstall_key_value(name: &str) -> Option<String> {
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let k = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TeleProxyBridge")
        .ok()?;
    k.get_value::<String, _>(name).ok()
}

#[derive(Serialize, Clone)]
struct LogLine {
    level: String,
    msg: String,
}

fn emit(app: &AppHandle, level: &str, msg: impl Into<String>) {
    let _ = app.emit(
        "install-log",
        LogLine {
            level: level.to_string(),
            msg: msg.into(),
        },
    );
}

#[tauri::command]
fn probe(dir: Option<String>) -> EnvInfo {
    let d = dir
        .map(PathBuf::from)
        .unwrap_or_else(|| default_dir())
        .clone();
    let node = if d.join("node.exe").exists() {
        Some(d.join("node.exe"))
    } else {
        resolve_node(&d)
    };
    EnvInfo {
        node: node.as_ref().map(|p| p.to_string_lossy().to_string()),
        node_version: node.as_ref().map(|p| node_version(p)),
        teleagent: find_teleagent().map(|p| p.to_string_lossy().to_string()),
        default_dir: default_dir().to_string_lossy().to_string(),
        existing: uninstall_key_value("InstallLocation"),
        installed_dir: {
            let p = d.join("src").join("cli.mjs");
            if p.exists() {
                Some(d.to_string_lossy().to_string())
            } else {
                None
            }
        },
        bridge_up: bridge_up(8787),
    }
}

#[tauri::command]
fn browse_dir(current: Option<String>) -> Option<String> {
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null\n\
         $d = New-Object System.Windows.Forms.FolderBrowserDialog\n\
         $d.Description = '选择安装目录'\n\
         $d.ShowNewFolderButton = $true\n\
         if ($d.SelectedPath -eq '') {{ $d.SelectedPath = '{}' }}\n\
         if ($d.ShowDialog() -eq 'OK') {{ Write-Output $d.SelectedPath }}\n",
        (current.unwrap_or_else(|| default_dir().to_string_lossy().to_string())).replace('\'', "''")
    );
    let (ok, out) = run_ps(&script);
    if ok && !out.trim().is_empty() {
        Some(out.trim().lines().last().unwrap_or("").to_string())
    } else {
        None
    }
}

#[derive(serde::Deserialize)]
struct InstallOpts {
    dir: String,
    autostart: bool,
    shortcut: bool,
    launch: bool,
}

fn kill_running_bridge(dir: &Path) {
    let pid_file = dir.join(".tpb.pid");
    if let Ok(txt) = fs::read_to_string(&pid_file) {
        if let Ok(pid) = txt.trim().parse::<u32>() {
            let mut c = Command::new("taskkill");
            c.args(["/PID", &pid.to_string(), "/T", "/F"]);
            hide_console(&mut c);
            let _ = c.output();
        }
    }
}

fn extract_payload(dir: &Path) -> Result<usize, String> {
    let reader = std::io::Cursor::new(PAYLOAD);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("payload 损坏: {}", e))?;
    fs::create_dir_all(dir).map_err(|e| format!("无法创建目录: {}", e))?;
    let mut n = 0usize;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        if name.ends_with('/') {
            continue;
        }
        let rel = name.replace('\\', "/");
        let rel = rel.trim_start_matches("./");
        let target = dir.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&target).map_err(|e| format!("写入失败 {}: {}", rel, e))?;
        std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}

fn write_launcher(dir: &Path) -> Result<(), String> {
    let vbs = format!(
        "Set sh = CreateObject(\"WScript.Shell\")\r\n\
         sh.Run Chr(34) & \"{}\" & Chr(34) & \" \" & Chr(34) & \"{}\" & Chr(34) & \" ui\", 0, False\r\n",
        dir.join("node.exe").to_string_lossy(),
        dir.join("src").join("cli.mjs").to_string_lossy()
    );
    fs::write(dir.join("launch.vbs"), vbs).map_err(|e| e.to_string())
}

fn create_shortcut(
    lnk: &Path,
    target: &Path,
    workdir: &Path,
    icon: &Path,
) -> Result<(), String> {
    let script = format!(
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{}')\n\
         $s.TargetPath = '{}'\n\
         $s.WorkingDirectory = '{}'\n\
         $s.IconLocation = '{}'\n\
         $s.Description = 'TeleProxyBridge 控制台'\n\
         $s.Save()\n",
        lnk.to_string_lossy().replace('\'', "''"),
        target.to_string_lossy().replace('\'', "''"),
        workdir.to_string_lossy().replace('\'', "''"),
        icon.to_string_lossy().replace('\'', "''"),
    );
    let (ok, out) = run_ps(&script);
    if ok {
        Ok(())
    } else {
        Err(format!("创建快捷方式失败: {}", out))
    }
}

fn write_uninstall_entry(dir: &Path) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TeleProxyBridge")
        .map_err(|e| e.to_string())?;
    let node = dir.join("node.exe");
    let cli = dir.join("src").join("cli.mjs");
    let uninstall = format!("\"{}\" \"{}\" uninstall --yes", node.display(), cli.display());
    let put = |name: &str, value: &str| -> Result<(), String> {
        key.set_value(name, &value).map_err(|e| format!("写注册表失败: {}", e))
    };
    put("DisplayName", "TeleProxyBridge")?;
    put("DisplayVersion", "1.0.0")?;
    put("Publisher", "TeleProxyBridge")?;
    put("InstallLocation", &dir.to_string_lossy())?;
    put("DisplayIcon", &node.to_string_lossy())?;
    put("UninstallString", &uninstall)?;
    put("QuietUninstallString", &uninstall)?;
    let _ = key.set_value("NoModify", &1u32);
    let _ = key.set_value("NoRepair", &1u32);
    Ok(())
}

fn remove_uninstall_entry() {
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let _ = hkcu.delete_subkey_all("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TeleProxyBridge");
}

type Log<'a> = &'a dyn Fn(&str, String);

fn perform_install(dir: &Path, opts: &InstallOpts, log: Log) -> Result<String, String> {
    log("step", "准备目录".into());
    fs::create_dir_all(dir).map_err(|e| format!("无法创建目录: {}", e))?;

    log("step", "停止正在运行的桥".into());
    kill_running_bridge(dir);
    std::thread::sleep(Duration::from_millis(400));

    log("step", "解压程序文件".into());
    let files = extract_payload(dir)?;
    log("ok", format!("已释放 {} 个文件", files));

    let node = resolve_node(dir).ok_or_else(|| "找不到可用的 node.exe".to_string())?;
    log("ok", format!("Node {}", node_version(&node)));

    let cli = dir.join("src").join("cli.mjs");
    log("step", "启动桥并接管 TeleAgent".into());
    let cli_s = cli.to_string_lossy().to_string();
    let mut up_args: Vec<&str> = vec![&cli_s, "up", "--quiet", "--no-restart"];
    if !opts.autostart {
        up_args.push("--no-autostart");
    }
    let (ok, out) = run_capture_in(Some(dir), &node.to_string_lossy(), &up_args);
    for line in out.lines().filter(|l| !l.trim().is_empty()) {
        log("info", line.to_string());
    }
    if !ok {
        log("warn", "启动时出现非零退出码，请查看日志".into());
    }

    log("step", "写启动器".into());
    write_launcher(dir)?;

    if opts.autostart {
        log("step", "注册开机自启".into());
        let _ = run_capture_in(
            Some(dir),
            &node.to_string_lossy(),
            &[&cli.to_string_lossy(), "autostart", "on"],
        );
    }

    if opts.shortcut {
        log("step", "创建快捷方式".into());
        let launcher = dir.join("launch.vbs");
        let icon = if dir.join("icon.ico").exists() { dir.join("icon.ico") } else { dir.join("node.exe") };
        let mut made = 0;
        if let Some(desk) = dirs_desktop() {
            if create_shortcut(&desk.join("TeleProxyBridge 控制台.lnk"), &launcher, dir, &icon).is_ok() {
                made += 1;
            }
        }
        if let Some(menu) = dirs_startmenu() {
            let _ = fs::create_dir_all(&menu);
            if create_shortcut(&menu.join("TeleProxyBridge 控制台.lnk"), &launcher, dir, &icon).is_ok() {
                made += 1;
            }
        }
        log("ok", format!("已创建 {} 个快捷方式", made));
    }

    log("step", "写入卸载信息".into());
    write_uninstall_entry(dir)?;

    if bridge_up(8787) {
        log("ok", "桥已在 127.0.0.1:8787 运行".into());
    } else {
        log("warn", "桥没有起来".into());
        return Err("桥没能启动，请检查日志排查".to_string());
    }

    if opts.launch {
        log("step", "打开控制台".into());
        let mut c = Command::new("wscript.exe");
        c.current_dir(dir);
        c.arg(dir.join("launch.vbs"));
        hide_console(&mut c);
        let _ = c.spawn();
    }

    log("done", "安装完成".into());
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn install(app: AppHandle, opts: InstallOpts) -> Result<String, String> {
    let dir = PathBuf::from(&opts.dir);
    let h = app.clone();
    perform_install(&dir, &opts, &move |level: &str, msg: String| emit(&h, level, msg))
}

fn dirs_desktop() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("USERPROFILE") {
        let d = PathBuf::from(p).join("Desktop");
        if d.exists() {
            return Some(d);
        }
    }
    Some(PathBuf::from("C:\\Users\\Public\\Desktop"))
}

fn dirs_startmenu() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(
        PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs"),
    )
}

#[tauri::command]
fn open_panel(dir: String) -> Result<(), String> {
    let d = PathBuf::from(dir);
    let node = resolve_node(&d).ok_or("找不到 node.exe")?;
    let cli = d.join("src").join("cli.mjs");
    let mut c = Command::new(node);
    c.current_dir(&d);
    c.arg(cli).arg("ui");
    hide_console(&mut c);
    c.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn uninstall(dir: String) -> Result<(), String> {
    let d = PathBuf::from(dir);
    remove_uninstall_entry();
    let mut c = Command::new("cmd.exe");
    c.args(["/c", "start", "", "cmd.exe", "/c", &format!(
        "timeout /t 2 >nul & rmdir /s /q \"{}\"",
        d.display()
    )]);
    hide_console(&mut c);
    let _ = c.spawn();
    Ok(())
}

#[tauri::command]
fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

fn silent_log_path() -> PathBuf {
    std::env::temp_dir().join("tpb-setup-silent.log")
}

fn append_log(line: &str) {
    if let Ok(mut f) = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(silent_log_path())
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// `setup.exe --silent [--dir <path>] [--no-autostart] [--no-shortcut] [--launch]`
/// Writes progress to %TEMP%\tpb-setup-silent.log; exit code 0 = ok.
fn run_silent(args: &[String]) -> i32 {
    let mut dir = default_dir();
    let mut autostart = true;
    let mut shortcut = true;
    let mut launch = false;
    let mut i = 1usize;
    while i < args.len() {
        match args[i].as_str() {
            "--dir" => {
                if i + 1 < args.len() {
                    dir = PathBuf::from(&args[i + 1]);
                    i += 1;
                }
            }
            "--no-autostart" => autostart = false,
            "--no-shortcut" => shortcut = false,
            "--launch" => launch = true,
            _ => {}
        }
        i += 1;
    }
    let _ = fs::write(silent_log_path(), "");
    append_log(&format!("install dir: {}\n", dir.display()));
    let opts = InstallOpts {
        dir: dir.to_string_lossy().to_string(),
        autostart,
        shortcut,
        launch,
    };
    let res = perform_install(&dir, &opts, &|level: &str, msg: String| {
        append_log(&format!("[{}] {}\n", level, msg));
    });
    match res {
        Ok(p) => {
            append_log(&format!("OK {}\n", p));
            0
        }
        Err(e) => {
            append_log(&format!("ERROR {}\n", e));
            1
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--silent") {
        let code = run_silent(&args);
        std::process::exit(code);
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            probe,
            browse_dir,
            install,
            open_panel,
            uninstall,
            close_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
