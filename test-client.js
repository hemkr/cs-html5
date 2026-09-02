// Smoke test: two simulated clients against cs-server.js (FAST mode)
'use strict';
const net = require('net');
const crypto = require('crypto');

const HOST = '127.0.0.1', PORT = parseInt(process.env.PORT || '3000', 10);

function makeWs(handlers) {
  const s = new net.Socket();
  let buf = Buffer.alloc(0), opened = false, frames = 0, errors = 0;
  const key = crypto.randomBytes(16).toString('base64');
  s.connect(PORT, HOST, () => {
    s.write('GET / HTTP/1.1\r\nHost: ' + HOST + ':' + PORT + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  s.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (!opened) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      opened = true;
      buf = buf.slice(idx + 4);
      handlers.open && handlers.open();
    }
    let off = 0;
    while (buf.length - off >= 2) {
      const b0 = buf[off], b1 = buf[off + 1];
      const op = b0 & 0x0f;
      let len = b1 & 0x7f, i = off + 2;
      if (len === 126) { if (buf.length - i < 2) break; len = buf.readUInt16BE(i); i += 2; }
      if (buf.length - i < len) break;
      const payload = buf.slice(i, i + len).toString('utf8');
      off = i + len;
      frames++;
      if (op === 1) {
        try { handlers.msg && handlers.msg(JSON.parse(payload)); }
        catch (e) {
          errors++;
          console.error('[PARSE-ERR]', e.message, 'frame#' + frames, 'op=' + op + ' len=' + len, 'head=' + payload.slice(0, 60).replace(/[^\x20-\x7e]/g, '?'));
        }
      }
      if (op === 9) s.write(Buffer.from([0x8a, 0x00]));
      if (op === 8) handlers.close && handlers.close();
    }
    buf = buf.slice(off);
  });
  s.on('error', e => console.error('sock err', e.message));
  s.frames = () => frames;
  s.errors = () => errors;
  s.send = (obj) => {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const hdr = Buffer.alloc(2);
    hdr[0] = 0x81; hdr[1] = data.length;
    s.write(Buffer.concat([hdr, data]));
  };
  return s;
}

let cfg = null, id0 = null, id1 = null;
let state0 = null, state1 = null;
let roundBanner = 0, matchOver = 0;
let boughtDeagle = false, sawKill = false, sawBuyMsg = false, sawHpDrop = false;
let toggle = false, sawKillMsg = false;

const WAY_T0 = [{ x: 420, y: 440 }, { x: 1100, y: 440 }, { x: 1100, y: 300 }];
const WAY_T1 = [{ x: 1764, y: 440 }, { x: 1100, y: 440 }, { x: 1100, y: 300 }];
const proc0 = { wp: 0 };
let lastPh0 = "", lastR0 = -1;
const proc1 = { wp: 0 };

function moveToward(me, target, shoot, aim) {
  const k = [false, false, false, false, false];
  const dx = target.x - me.x, dy = target.y - me.y;
  if (Math.abs(dx) > 26) { if (dx > 0) k[3] = true; else k[2] = true; }
  if (Math.abs(dy) > 26) { if (dy > 0) k[1] = true; else k[0] = true; }
  const a = aim !== undefined ? aim : Math.atan2(dy, dx);
  return { k, a, s: shoot, r: false };
}

const c0 = makeWs({
  open: () => c0.send({ t: 'join', name: 'TEST-CT' }),
  msg: (m) => {
    if (m.t === 'welcome') { id0 = m.id; cfg = m.cfg; }
    if (m.t === 'msg') { if (/구매 완료/.test(m.text)) sawBuyMsg = true; }
    if (m.t === 'round') { roundBanner++; console.log('[C0] round event:', m.res, '+$' + m.bonus); }
    if (m.t === 'over') { matchOver++; console.log('[C0] MATCH OVER winner=' + m.winner); }
    if (m.t === 'hit') { if (m.kill) sawKill = true; if (m.dmg) sawHpDrop = true; }
    if (m.t === 'kill') { sawKillMsg = true; }
    if (m.t === 'state') {
      state0 = m;
      const me = m.p.find(p => p.i === id0);
      const you = m.p.find(p => p.i !== id0);
      if (m.ph !== lastPh0 || m.r !== lastR0) {
        lastPh0 = m.ph; lastR0 = m.r;
        console.log(`[C0] phase ${m.ph} r${m.r} me=${!!me} you=${!!you} meAl=${me&&me.al} youAl=${you&&you.al}`);
      }
      if (m.ph === 'buy' && !boughtDeagle) {
        c0.send({ t: 'buy', item: 'deagle' });
        boughtDeagle = true;
      }
      if (m.ph === 'live' && me && me.al && you) {
        if (proc0.wp < WAY_T0.length && Math.hypot(me.x - WAY_T0[proc0.wp].x, me.y - WAY_T0[proc0.wp].y) < 30) proc0.wp++;
        let inp;
        if (proc0.wp >= WAY_T0.length && Math.hypot(you.x - me.x, you.y - me.y) <= 420) {
          toggle = !toggle;
          inp = moveToward(me, { x: you.x, y: you.y }, toggle, Math.atan2(you.y - me.y, you.x - me.x));
        } else if (proc0.wp >= WAY_T0.length) {
          inp = moveToward(me, { x: 1100, y: 300 }, false);
        } else {
          inp = moveToward(me, WAY_T0[proc0.wp], false);
        }
        c0.send({ t: 'in', ...inp });
      } else if (m.ph === 'live') {
        c0.send({ t: 'in', k: [false,false,false,false,false], a: 0, s: false, r: false });
      }
    }
  },
});
const c1 = makeWs({
  open: () => c1.send({ t: 'join', name: 'TEST-T' }),
  msg: (m) => {
    if (m.t === 'welcome') { id1 = m.id; }
    if (m.t === 'round') console.log('[C1] round event:', m.res);
    if (m.t === 'over') console.log('[C1] MATCH OVER');
    if (m.t === 'state') {
      state1 = m;
      const me = m.p.find(p => p.i === id1);
      // join the fray: waypoint to the meeting point but stop before enemy line of fire
      if (m.ph === 'live' && me && me.al) {
        if (proc1.wp < WAY_T1.length && Math.hypot(me.x - WAY_T1[proc1.wp].x, me.y - WAY_T1[proc1.wp].y) < 30) proc1.wp++;
        const tgt = proc1.wp < WAY_T1.length ? WAY_T1[proc1.wp] : { x: 1100, y: 300 };
        const inp = moveToward(me, tgt, false);
        c1.send({ t: 'in', ...inp });
      } else if (m.ph === 'live') {
        c1.send({ t: 'in', k: [false,false,false,false,false], a: Math.PI, s: false, r: false });
      } else {
        c1.send({ t: 'in', k: [false,false,false,false,false], a: Math.PI, s: false, r: false });
      }
    }
  },
});

const t0 = Date.now();
let lastStateLog = 0;
const iv = setInterval(() => {
  const now = Date.now();
  if (now - lastStateLog > 1500) {
    lastStateLog = now;
    console.log(`[WATCH] c0=${state0 ? state0.ph + ' r' + state0.r : 'none'} c1=${state1 ? state1.ph + ' r' + state1.r : 'none'} ev=${roundBanner}/${matchOver} fr0=${c0.frames()}|${c0.errors()} fr1=${c1.frames()}|${c1.errors()}`);
  }
  if (matchOver >= 1) {
    clearInterval(iv);
    const passed = sawKill || sawKillMsg || sawHpDrop;
    console.log(passed ? '=== SMOKE TEST PASS ===' : '=== SMOKE TEST FAIL (no kills seen) ===');
    console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s, rounds=${roundBanner}, matchOver=${matchOver}, deagleBought=${sawBuyMsg}, hpDrop=${sawHpDrop}, kill=${sawKill || sawKillMsg}`);
    if (state0) {
      const me = state0.p.find(p => p.i === id0);
      console.log('C0 slo =', JSON.stringify(me && me.slo), 'money =', me && me.mn);
    }
    process.exit(passed ? 0 : 1);
  }
  if (Date.now() - t0 > 90000) {
    clearInterval(iv);
    console.error('=== SMOKE TEST TIMEOUT ===', { roundBanner, matchOver, sawBuyMsg, sawHpDrop, sawKill });
    process.exit(1);
  }
}, 200);