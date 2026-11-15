// obs-drive.mjs —— 用 obs-websocket v5 起停录制（零新依赖，Node 24 自带 WebSocket）
//
// 【为什么走 websocket 而不是模拟点 OBS 界面】
// 点界面要靠坐标，OBS 窗口位置一变就点错；websocket 的 StartRecord/StopRecord 是
// 官方 RPC，返回值里带 outputPath，能直接拿到文件真实落点去 ffprobe 验收。
//
// 用法：
//   node obs-drive.mjs ping
//   node obs-drive.mjs status
//   node obs-drive.mjs start
//   node obs-drive.mjs stop
import crypto from 'node:crypto';

const HOST = process.argv[3] ?? '127.0.0.1:4455';
const PASSWORD = process.env.OBS_WS_PASSWORD ?? '4SzYEEqWT9rZhPv6';
const [host, port] = HOST.split(':');

function sha256b64(s) {
  return crypto.createHash('sha256').update(s).digest('base64');
}

class Obs {
  constructor() {
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}`);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('连接超时')), 10000);

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        // op 0 = Hello
        if (msg.op === 0) {
          const auth = msg.d?.authentication;
          let ident = { rpcVersion: 1 };
          if (auth) {
            const secret = sha256b64(PASSWORD + auth.salt);
            ident.authentication = sha256b64(secret + auth.challenge);
          }
          ws.send(JSON.stringify({ op: 1, d: ident }));
          return;
        }
        // op 2 = Identified
        if (msg.op === 2) {
          clearTimeout(timer);
          resolve();
          return;
        }
        // op 7 = RequestResponse
        if (msg.op === 7) {
          const p = this.pending.get(msg.d.requestId);
          if (p) {
            this.pending.delete(msg.d.requestId);
            if (msg.d.requestStatus?.result) p.resolve(msg.d.responseData ?? {});
            else p.reject(new Error(`${msg.d.requestType} 失败：${msg.d.requestStatus?.comment}`));
          }
        }
      });

      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('websocket 连接失败（OBS 是否在跑？插件是否启用？）'));
      });
    });
  }

  request(requestType, requestData = {}) {
    const requestId = String(++this.id);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error(`${requestType} 超时`));
        }
      }, 30000);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

// 【为什么末尾必须强制退出】WebSocket 的 IO 线程与 30s 超时定时器会让 node 进程挂住不退出，
// 命令看起来"跑完了"却一直占着终端（第一次实测就卡在这儿）。
// 所有请求都是 await 完的，这里直接 exit 不会丢输出。
process.on('exit', () => {});

const cmd = process.argv[2] ?? 'ping';

const obs = new Obs();
try {
  await obs.connect();
  console.log('[obs] 已连接 ' + HOST);

  if (cmd === 'ping') {
    const v = await obs.request('GetVersion');
    console.log(`[obs] OBS ${v.obsVersion} · websocket ${v.obsWebSocketVersion}`);
    const scene = await obs.request('GetCurrentProgramScene');
    console.log(`[obs] 当前场景：${scene.currentProgramSceneName}`);
  } else if (cmd === 'status') {
    const rec = await obs.request('GetRecordStatus');
    console.log(`[obs] 录制中=${rec.outputActive} 时长=${rec.outputTimecode ?? '-'} 字节=${rec.outputBytes ?? 0}`);
    const v = await obs.request('GetVideoSettings');
    console.log(`[obs] 基准 ${v.baseWidth}x${v.baseHeight} · 输出 ${v.outputWidth}x${v.outputHeight} · FPS ${v.fpsNumerator}/${v.fpsDenominator}`);
  } else if (cmd === 'start') {
    const rec = await obs.request('GetRecordStatus').catch(() => null);
    if (rec?.outputActive) {
      console.log('[obs] 已在录制中，未重复启动');
    } else {
      await obs.request('StartRecord');
      console.log('[obs] 录制已启动');
    }
    const dir = await obs.request('GetRecordDirectory').catch(() => null);
    if (dir) console.log(`[obs] 输出目录：${dir.recordDirectory}`);
  } else if (cmd === 'stop') {
    const res = await obs.request('StopRecord');
    console.log('[obs] 录制已停止');
    console.log(`[obs] 文件：${res.outputPath ?? '(未返回)'}`);
  } else {
    console.error('未知命令：' + cmd);
    process.exitCode = 1;
  }
} catch (e) {
  console.error('[obs] ' + e.message);
  process.exitCode = 1;
} finally {
  obs.close();
  // 强制退出：WS IO 线程与超时定时器不会自己结束进程
  setTimeout(() => process.exit(process.exitCode ?? 0), 150).unref();
}
