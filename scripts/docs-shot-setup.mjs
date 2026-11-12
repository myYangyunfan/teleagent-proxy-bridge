import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const src = fs.readFileSync(path.join(ROOT, 'tauri-setup/ui/index.html'), 'utf8');
const stub = "<script>\nwindow.__TAURI__ = {\n  core: {\n    invoke: async (cmd) => {\n      if (cmd === 'probe') return {\n        node_version: 'v22.14.0',\n        teleagent: true,\n        bridge_up: false,\n        installed_dir: null,\n        default_dir: 'C:\\\\Users\\\\demo\\\\AppData\\\\Local\\\\TeleProxyBridge'\n      };\n      return null;\n    }\n  },\n  event: { listen: async () => null }\n};\n</script>\n";
const out = src.replace('<script>', stub + '<script>');
const file = path.join(ROOT, 'build/docs-setup.html');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out, 'utf8');

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const target = path.join(ROOT, 'docs/setup-tauri.png');
const url = 'file:///' + file.replace(/\\/g, '/');
const p = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=4000', '--window-size=760,640', '--screenshot=' + target, url], { stdio: 'ignore' });
p.on('exit', (code) => { console.log('edge exit ' + code); });
