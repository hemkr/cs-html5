#!/usr/bin/env node
'use strict';
/*
 * COUNTER-OP // 1v1 네트워크 아레나 — 서버
 * ------------------------------------------------------------------
 * 제로-의존성 Node.js 서버. HTTP(클라이언트 HTML 서빙) + WebSocket(게임 프로토콜).
 * 실행:  node cs-server.js          (기본 포트 3000)
 * 환경변수: PORT=3000, FAST=1 (빠른 테스트 모드)
 *
 * 서버 권위 모델: 모든 물리/데미지/경제/라운드 판정은 서버에서.
 * 클라이언트는 입력(키/조준/발사/구매)만 전송.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const FAST = process.env.FAST === '1';

// ────────────────────────── 설정 ──────────────────────────
const CFG = {
  W: 2200, H: 1400,               // 월드 크기
  speed: 240, walkSpeed: 90,      // 달리기/걷기 속도 (u/s)
  radius: 16,                     // 플레이어 몸 반지름
  headRadius: 5.5,                // 헤드샷 판정 반지름
  roundToWin: FAST ? 3 : 8,
  startMoney: 800,
  killReward: 300,                // 킬 보상
  winReward: 3250,                // 라운드 승리
  lossBase: 1400,                 // 라운드 패배 기본
  lossStep: 500, lossCap: 3400,   // 연패 보상 증가 & 상한
  buyTime: FAST ? 2 : 15,         // 준비(구매) 시간
  liveTime: FAST ? 6 : 45,        // 교전 시간
  endTime: FAST ? 1 : 4,          // 결과 표시 시간
  velocityLeg: 12,                // 이동 반응 계수
  // 맵 (x=1100 축 대칭)
  walls: [
    { x: 1000, y: 520, w: 200, h: 360 },  // 중앙 구조물
    { x: 700,  y: 240, w: 150, h: 150 },  // 좌상단 크레이트
    { x: 1350, y: 240, w: 150, h: 150 },  // 우상단 크레이트
    { x: 580,  y: 980, w: 220, h: 160 },  // 좌하단 컨테이너
    { x: 1400, y: 980, w: 220, h: 160 },  // 우하단 컨테이너
    { x: 460,  y: 700, w: 150, h: 130 },  // 좌 미드 커버
    { x: 1590, y: 700, w: 150, h: 130 },  // 우 미드 커버
    { x: 260,  y: 620, w: 160, h: 160 },  // T 스폰 커버
    { x: 1780, y: 620, w: 160, h: 160 },  // CT 스폰 커버
  ],
  spawns: { T: { x: 420, y: 700 }, CT: { x: 1780, y: 700 } },
  buyZones: {
    T:  { x: 0, y: 0, w: 620, h: 1400 },
    CT: { x: 1580, y: 0, w: 620, h: 1400 },
  },
};

// ── 무기 테이블 ──
// spread: 정지 시 최대 조준 오차(도). 이동/연사 시 선형 증가.
// team: 'T'|'CT'|'B'(공용). auto: 연사 여부
const WEAPONS = {
  glock:  { name: 'Glock-18',      price: 0,     dmg: 28,  rpm: 400, mag: 20, reserve: 120, spread: 8,  auto: false, pellets: 1, team: 'T',  color: '#ffd166' },
  usp:    { name: 'USP-S',         price: 0,     dmg: 34,  rpm: 352, mag: 12, reserve: 48,  spread: 4,  auto: false, pellets: 1, team: 'CT', color: '#7fc8ff' },
  p250:   { name: 'P250',          price: 300,   dmg: 40,  rpm: 400, mag: 13, reserve: 52,  spread: 5,  auto: false, pellets: 1, team: 'B',  color: '#cfcfcf' },
  deagle: { name: 'Desert Eagle',  price: 700,   dmg: 68,  rpm: 267, mag: 7,  reserve: 35,  spread: 4.5,auto: false, pellets: 1, team: 'B',  color: '#ffe08a' },
  mp9:    { name: 'MP9',           price: 1250,  dmg: 24,  rpm: 857, mag: 30, reserve: 120, spread: 8,  auto: true,  pellets: 1, team: 'B',  color: '#7ddcdc' },
  ak47:   { name: 'AK-47',         price: 2700,  dmg: 52,  rpm: 600, mag: 30, reserve: 90,  spread: 5.5,auto: true,  pellets: 1, team: 'T',  color: '#ff8a5c' },
  m4a4:   { name: 'M4A4',          price: 3100,  dmg: 47,  rpm: 666, mag: 30, reserve: 90,  spread: 6,  auto: true,  pellets: 1, team: 'CT', color: '#7fe0a0' },
  awp:    { name: 'AWP',           price: 4750,  dmg: 120, rpm: 41,  mag: 10, reserve: 30,  spread: 1,  auto: false, pellets: 1, team: 'B',  color: '#9be4ff' },
  nova:   { name: 'Nova',          price: 1050,  dmg: 32,  rpm: 68,  mag: 8,  reserve: 32,  spread: 12, auto: false, pellets: 8, team: 'B',  color: '#ff9e5c' },
};
const RELOAD = { glock: 1.9, usp: 2.2, p250: 2.0, deagle: 2.2, mp9: 2.5, ak47: 2.4, m4a4: 3.1, awp: 3.7, nova: 3.2 };
const WEAPON_RANGE = 2400;      // 총알 사거리
const MAX_CONSEC_SUPPRESS = 6;

// 서버 → 브라우저에 내려줄 설정(무기 스탯, 맵 등 단일 소스)
function clientCfg() {
  return {
    ...CFG,
    weapons: Object.fromEntries(Object.entries(WEAPONS).map(([k, v]) => [k, { ...v }])),
    reload: { ...RELOAD },
  };
}
const CFG_MSG = JSON.stringify({ t: 'cfg', cfg: clientCfg() });

// ────────────────────────── WebSocket (제로 의존성) ──────────────────────────
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(str) {
  const data = Buffer.from(str, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[0] = 0x81; header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, data]);
}
function encodePing() {
  const out = Buffer.alloc(2);
  out[0] = 0x89; out[1] = 0;
  return out;
}
function encodePong(payload) {
  const out = Buffer.alloc(2 + payload.length);
  out[0] = 0x8a; out[1] = payload.length;
  payload.copy(out, 2);
  return out;
}
function encodeClose(code, reason) {
  const r = Buffer.from(reason || '', 'utf8');
  const out = Buffer.alloc(2 + 2 + r.length);
  out[0] = 0x88; out[1] = 2 + r.length;
  out.writeUInt16BE(code || 1000, 2);
  r.copy(out, 4);
  return out;
}

class WsClient {
  constructor(socket, onMsg, onClose) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    this.onMsg = onMsg;
    this.onClose = onClose;
    socket.on('data', d => this._feed(d));
    socket.on('error', () => this._close());
    socket.on('close', () => this._close());
    this.pingTimer = setInterval(() => {
      if (!this.alive) { this._close(); return; }
      this.alive = false;
      try { socket.write(encodePing()); } catch { this._close(); }
    }, 15000);
  }
  _feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let offset = 0;
    while (this.buffer.length - offset >= 2) {
      const b0 = this.buffer[offset], b1 = this.buffer[offset + 1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
      let len = b1 & 0x7f, idx = offset + 2;
      if (len === 126) {
        if (this.buffer.length - idx < 2) break;
        len = this.buffer.readUInt16BE(idx); idx += 2;
      } else if (len === 127) {
        if (this.buffer.length - idx < 8) break;
        len = Number(this.buffer.readBigUInt64BE(idx)); idx += 8;
      }
      const masked = (b1 & 0x80) !== 0;
      let mask = null;
      if (masked) {
        if (this.buffer.length - idx < 4) break;
        mask = this.buffer.slice(idx, idx + 4); idx += 4;
      }
      if (this.buffer.length - idx < len) break; // 조각 대기
      let payload = this.buffer.slice(idx, idx + len);
      if (masked) {
        const out = Buffer.from(payload);
        for (let i = 0; i < len; i++) out[i] ^= mask[i & 3];
        payload = out;
      }
      offset = idx + len;
      this.alive = true;
      if (opcode === 1) { // text
        let msg = null;
        try { msg = JSON.parse(payload.toString('utf8')); } catch { /* ignore */ }
        if (msg) this.onMsg(msg);
      } else if (opcode === 8) { this._close(); return; }
      else if (opcode === 9) { try { this.socket.write(encodePong(Buffer.alloc(0))); } catch { /* */ } }
      // 9(핑)/10(퐁) 무시 — 핑은 퐁 프레임으로 대체 운용
    }
    if (offset > 0) this.buffer = this.buffer.slice(offset);
  }
  send(obj) {
    if (!this.alive) return;
    try {
      if (Buffer.isBuffer(obj)) this.socket.write(obj);
      else this.socket.write(encodeFrame(JSON.stringify(obj)));
    } catch { this._close(); }
  }
  _close() {
    if (!this.alive) return;
    clearInterval(this.pingTimer);
    this.alive = false;
    try { this.socket.end(); } catch { /* */ }
    this.onClose();
  }
}

// ────────────────────────── 게임 상태 ──────────────────────────
const game = {
  phase: 'wait',          // wait | buy | live | end | matchover
  timer: 0,
  round: 1,
  scores: { T: 0, CT: 0 },
  players: [],            // 최대 2
  bullets: [],
  feed: [],
  logs: [],
};

function mkPlayer(id, socket) {
  const team = id === 0 ? 'T' : 'CT';
  const startPistol = team === 'T' ? 'glock' : 'usp';
  const p = {
    id, team, name: team === 'T' ? 'T-OPERATOR' : 'CT-OPERATOR',
    socket,
    x: CFG.spawns[team].x, y: CFG.spawns[team].y,
    vx: 0, vy: 0,
    angle: team === 'T' ? 0 : Math.PI,
    hp: 100, armor: 0, money: CFG.startMoney,
    alive: true,
    slot: team === 'T' ? 1 : 1,       // 0=주무기 1=보조
    slots: [
      { k: null, am: 0, rs: 0 },
      { k: startPistol, am: WEAPONS[startPistol].mag, rs: WEAPONS[startPistol].reserve },
    ],
    cd: 0, rec: 0, recTotal: 0,        // 재장전
    prevShoot: false,                  // 반자동 삼각(rising edge)
    accSpray: 0,
    consecutiveLosses: 0,
    wins: 0,
  };
  return p;
}

function isInBuyZone(p) {
  const z = CFG.buyZones[p.team];
  return p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h;
}

function buyableWeapons(team) {
  // [key, 장착 슬롯]
  const list = [];
  for (const [key, w] of Object.entries(WEAPONS)) {
    if (w.team !== 'B' && w.team !== team) continue;
    if (key === 'usp' || key === 'glock') continue; // 시작 권총은 구매 불가
    list.push(key);
  }
  return list;
}

function weaponForTeam(key, team) {
  if (key === 'ak47' && team === 'CT') key = 'm4a4';
  if (key === 'm4a4' && team === 'T') key = 'ak47';
  return key;
}

// 구매 처리 (클라이언트 요청 → 검증 → 적용)
function handleBuy(p, item) {
  if (item === 'kevlar') {
    if (game.phase !== 'buy') return sendMsg(p, '구매는 준비 시간에만 가능합니다', '#ffaa44');
    if (!isInBuyZone(p)) return sendMsg(p, '구매 구역(ZONE) 안에서만 구매 가능', '#ffaa44');
    if (p.armor >= 100) return sendMsg(p, '방탄복이 이미 완비되어 있습니다', '#ffaa44');
    const PRICE = 650;
    if (p.money < PRICE) return sendMsg(p, `돈이 부족합니다 ($${PRICE.toLocaleString()} 필요)`, '#ff5544');
    p.armor = 100;
    p.money -= PRICE;
    return sendMsg(p, '방탄복 착용 완료  (-$650)', '#66ff88');
  }
  const w = WEAPONS[item];
  if (!w || (w.team !== 'B' && w.team !== p.team)) return sendMsg(p, '구매할 수 없는 아이템입니다', '#ff5544');
  item = weaponForTeam(item, p.team);
  const w2 = WEAPONS[item];
  if (game.phase !== 'buy') return sendMsg(p, '구매는 준비 시간에만 가능합니다', '#ffaa44');
  if (!isInBuyZone(p)) return sendMsg(p, '구매 구역(ZONE) 안에서만 구매 가능', '#ffaa44');
  if (p.money < w2.price) return sendMsg(p, `돈이 부족합니다 ($${w2.price.toLocaleString()} 필요)`, '#ff5544');

  // 슬롯 결정: 주무기(ak/m4/awp/mp9/nova) vs 보조(p250/deagle)
  const isPrimary = ['ak47', 'm4a4', 'awp', 'mp9', 'nova'].includes(item);
  const slotIdx = isPrimary ? 0 : 1;
  p.slots[slotIdx] = { k: item, am: w2.mag, rs: w2.reserve };
  p.money -= w2.price;
  p.slot = slotIdx;
  p.rec = 0; p.recTotal = 0;
  sendMsg(p, `${w2.name} 구매 완료  (-$${w2.price.toLocaleString()})`, '#66ff88');
}

// ── 전투 ──
function fireWeapon(p, dt) {
  const w = p.slots[p.slot];
  if (!w.k) return;
  const W = WEAPONS[w.k];
  if (p.cd > 0 || p.rec > 0) return;
  if (w.am <= 0) {
    // 빈 탄창: 자동으로 재장전 유도
    p.rec = RELOAD[w.k] || 2;
    p.recTotal = p.rec;
    p.socket?.send({ t: 'dry' });
    return;
  }
  // 사거리 내 초기 조준 방향
  const baseAngle = p.angle;
  const speed = Math.hypot(p.vx || 0, p.vy || 0);
  const movePenalty = speed > 40 ? 1 + 0.6 * Math.min(1, speed / CFG.speed) : 1;
  p.accSpray = Math.min(p.accSpray + 1.2, MAX_CONSEC_SUPPRESS);
  const pellets = W.pellets || 1;
  const shot = { x: p.x, y: p.y, a: baseAngle, wp: w.k, pellets };
  for (let i = 0; i < pellets; i++) {
    const spreadTotal = W.spread * movePenalty + p.accSpray;
    const spreadRad = (spreadTotal * (Math.random() * 2 - 1) * 0.5) * Math.PI / 180;
    const ang = baseAngle + spreadRad;
    game.bullets.push({
      x: p.x + Math.cos(ang) * (CFG.radius + 6),
      y: p.y + Math.sin(ang) * (CFG.radius + 6),
      px: p.x, py: p.y,
      vx: Math.cos(ang), vy: Math.sin(ang),
      speed: 1500,
      dist: 0, maxDist: WEAPON_RANGE,
      dmg: W.dmg, owner: p.id, wp: w.k,
    });
  }
  w.am--;
  p.cd = 60 / W.rpm; // 초 단위 → 60fps 기준 소수
  p.socket?.send({ t: 'shot', x: shot.x, y: shot.y, a: shot.a, wp: shot.wp, pellets: shot.pellets });
  // 상대에게도 총성 전파
  const other = game.players.find(o => o && o.id !== p.id && o.socket);
  if (other) other.socket.send({ t: 'shot', x: shot.x, y: shot.y, a: shot.a, wp: shot.wp, pellets: shot.pellets, priv: false });
}

function circleRectCollide(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx, dy = cy - ny;
  const d2 = dx * dx + dy * dy;
  return d2 < r * r ? { hit: true, d: Math.sqrt(d2), nx: dx, ny: dy } : { hit: false };
}

function resolvePlayerWall(p, dt) {
  const r = CFG.radius;
  // 경계
  p.x = Math.max(r, Math.min(CFG.W - r, p.x));
  p.y = Math.max(r, Math.min(CFG.H - r, p.y));
  for (const wall of CFG.walls) {
    const c = circleRectCollide(p.x, p.y, r, wall);
    if (c.hit) {
      // 가장 짧은 축으로 밀어내기
      const left = p.x - (wall.x - r), right = (wall.x + wall.w + r) - p.x;
      const top = p.y - (wall.y - r), bottom = (wall.y + wall.h + r) - p.y;
      const m = Math.min(left, right, top, bottom);
      if (m === left) p.x = wall.x - r;
      else if (m === right) p.x = wall.x + wall.w + r;
      else if (m === top) p.y = wall.y - r;
      else p.y = wall.y + wall.h + r;
    }
  }
}

function bulletWallHit(b) {
  if (b.x < 0 || b.x > CFG.W || b.y < 0 || b.y > CFG.H) return true;
  for (const wall of CFG.walls) {
    // 세그먼트(px,py)→(x,y)와 AABB 교차검사(서브스텝으로 세분화)
    const steps = 4;
    for (let s = 0; s < steps; s++) {
      const sx = b.px + (b.x - b.px) * (s / steps);
      const sy = b.py + (b.y - b.py) * (s / steps);
      const nx = Math.max(wall.x, Math.min(sx, wall.x + wall.w));
      const ny = Math.max(wall.y, Math.min(sy, wall.y + wall.h));
      const d = Math.hypot(sx - nx, sy - ny);
      if (d < 2) {
        b.px = sx; b.py = sy;
        return true;
      }
    }
  }
  return false;
}

function pointSegDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby + 1e-9)));
  return Math.hypot(ax + abx * t - px, ay + aby * t - py);
}

function applyDamage(target, dmg, attacker, headshot, wx, wy) {
  if (!target.alive) return;
  const absorbed = Math.min(target.armor, dmg * 0.5);
  target.armor -= absorbed;
  const hpDmg = dmg - absorbed;
  target.hp = Math.max(0, target.hp - hpDmg);
  target.socket.send({ t: 'dmg', x: wx, y: wy, hp: target.hp, hs: headshot });
  if (attacker) attacker.socket.send({ t: 'hit', hs: headshot, dmg: dmg, kill: target.hp <= 0 });
  if (target.hp <= 0) {
    target.alive = false;
    const killer = attacker;
    killer.money += CFG.killReward;
    killer.accSpray = 0;
    killer.kills = (killer.kills || 0) + 1;
    game.feed.unshift({ a: killer.name, b: target.name, wp: WEAPONS[killer.slots[killer.slot].k]?.name || '주먹', killer: killer.team, victim: target.team, f: tickCount++ });
    game.feed = game.feed.slice(0, 5);
    broadcast({ t: 'msg', text: `💀 ${killer.name} ▶ ${target.name} (${WEAPONS[killer.slots[killer.slot].k]?.name || ''})`, c: '#ff8855' });
    killer.socket.send({ t: 'kill', hs: headshot });
  }
}

// ────────────────────────── 시뮬레이션 ──────────────────────────
function simulate(dt) {
  if (game.phase === 'wait' || game.phase === 'matchover') { game.timer = 0; return; }
  game.timer -= dt;

  const [a, b] = game.players;
  for (const p of game.players) {
    if (!p || !p.socket) continue;
    const inp = p.input || { k: [false, false, false, false, false], a: p.angle, s: false, r: false };
    if (p.angle === Infinity || isNaN(p.angle)) p.angle = 0;
    p.angle = inp.a != null && !isNaN(inp.a) ? inp.a : p.angle;

    if (game.phase === 'buy' || game.phase === 'live') {
      if (!p.dead) {
        const dirX = (inp.k[3] ? 1 : 0) - (inp.k[2] ? 1 : 0);
        const dirY = (inp.k[1] ? 1 : 0) - (inp.k[0] ? 1 : 0);
        const walking = inp.k[4];
        const spd = walking ? CFG.walkSpeed : CFG.speed;
        const len = Math.hypot(dirX, dirY) || 1;
        const tx = (dirX / len) * spd, ty = (dirY / len) * spd;
        const leg = Math.min(1, dt * CFG.velocityLeg);
        p.vx = p.vx + (tx - p.vx) * leg;
        p.vy = p.vy + (ty - p.vy) * leg;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        resolvePlayerWall(p, dt);
      }
    }

    // 재장전 타이머
    if (p.rec > 0) {
      p.rec -= dt;
      if (p.rec <= 0) {
        p.rec = 0;
        const w = p.slots[p.slot];
        if (w && w.k) {
          const need = WEAPONS[w.k].mag - w.am;
          const take = Math.min(need, w.rs);
          w.am += take; w.rs -= take;
        }
      }
    }
    if (p.cd > 0) p.cd -= dt;

    // 발사 (live 페이즈만)
    if (game.phase === 'live' && p.alive) {
      const w = WEAPONS[p.slots[p.slot]?.k];
      const holding = inp.s === true;
      const rising = holding && !p.prevShoot;
      p.prevShoot = holding;
      if (holding && (w ? w.auto : false) || rising) {
        fireWeapon(p, dt);
      }
      if (!holding) { p.prevShoot = false; p.accSpray = Math.max(0, p.accSpray - dt * 8); }
    } else {
      p.prevShoot = false;
      p.accSpray = Math.max(0, p.accSpray - dt * 8);
    }

    // 재장전 입력
    if (inp.r === true && p.rec <= 0) {
      const w = p.slots[p.slot];
      if (w && w.k && w.am < WEAPONS[w.k].mag && w.rs > 0) {
        p.rec = RELOAD[w.k]; p.recTotal = p.rec;
      }
    }
  }

  // 총알 진행
  const newBullets = [];
  for (const b of game.bullets) {
    const step = b.speed * dt;
    b.px = b.x; b.py = b.y;
    b.x += b.vx * step;
    b.y += b.vy * step;
    b.dist += step;
    let dead = b.dist >= b.maxDist;
    if (!dead && bulletWallHit(b)) dead = true;
    if (!dead) {
      // 플레이어 히트 (본인 제외)
      for (const p of game.players) {
        if (!p || !p.socket) continue;
        if (p.id === b.owner || !p.alive) continue;
        const d = pointSegDist(p.x, p.y, b.px, b.py, b.x, b.y);
        const hs = d < CFG.headRadius;
        if (d < (hs ? CFG.headRadius : CFG.radius)) {
          const falloff = 1 - 0.5 * Math.min(1, b.dist / WEAPON_RANGE);
          let dmg = b.dmg * falloff * (hs ? 4 : 1);
          applyDamage(p, dmg, game.players.find(o => o && o.id === b.owner), hs, b.x, b.y);
          dead = true;
          break;
        }
      }
    }
    if (!dead) newBullets.push(b);
  }
  game.bullets = newBullets;

  // 라운드 종료 판정
  if (game.phase === 'live') {
    const alive = game.players.filter(p => p && p.alive);
    if (alive.length === 1) roundEnd(alive[0].team, 'kill');
    else if (alive.length === 0) roundEnd(null, 'draw');
    else if (game.timer <= 0) {
      const [pa, pb] = game.players;
      if (!pa || !pb) return;
      if (pa.hp === pb.hp) roundEnd(null, 'draw');
      else roundEnd(pa.hp > pb.hp ? pa.team : pb.team, 'time');
    }
  }
  if (game.phase === 'buy' && game.timer <= 0) {
    game.phase = 'live';
    game.timer = CFG.liveTime;
    broadcast({ t: 'msg', text: '🔥 전투 시작!', c: '#ff6644' });
  }
  if (game.phase === 'end' && game.timer <= 0) {
    nextRound();
  }
}

function roundEnd(winTeam, reason) {
  game.phase = 'end';
  game.timer = CFG.endTime;
  for (const p of game.players) {
    if (!p || !p.socket) continue;
    let res, bonus = 0;
    const enemy = game.players.find(o => o && o.id !== p.id);
    if (winTeam === null) { res = 'draw'; bonus = 0; }
    else if (p.team === winTeam) { res = 'win'; bonus = CFG.winReward; }
    else { res = 'lose'; }
    if (res === 'win') { p.money += CFG.winReward; p.wins++; game.scores[p.team]++; }
    if (res === 'lose') {
      bonus = Math.min(CFG.lossCap, CFG.lossBase + CFG.lossStep * Math.max(0, p.consecutiveLosses));
      p.money += bonus; p.consecutiveLosses++;
    }
    if (res === 'win' || res === 'draw') p.consecutiveLosses = 0;
    p.socket.send({ t: 'round', res, bonus, reason, kills: p.kills || 0 });
    p.kills = 0;
    // 라운드 결과 로그
    if (res === 'win') p.socket.send({ t: 'msg', text: `🏆 라운드 승리! (+$${CFG.winReward.toLocaleString()})`, c: '#66ff88' });
    if (res === 'lose') p.socket.send({ t: 'msg', text: `패배 (+$${bonus.toLocaleString()})`, c: '#ff7766' });
  }
  // 경기 종료 판정
  if (game.scores[winTeam] >= CFG.roundToWin) {
    game.phase = 'matchover';
    broadcast({ t: 'over', winner: winTeam, score: { ...game.scores } });
    broadcast({ t: 'msg', text: `🏁 경기 종료 — ${winTeam === 'T' ? 'T' : 'CT'} 팀 승리!`, c: '#ffcc44' });
  }
}

function nextRound() {
  game.round++;
  for (const p of game.players) {
    if (!p || !p.socket) continue;
    p.alive = true;
    p.hp = 100;
    p.x = CFG.spawns[p.team].x; p.y = CFG.spawns[p.team].y;
    p.vx = 0; p.vy = 0;
    p.cd = 0; p.rec = 0; p.accSpray = 0;
    // 탄약 재보급 (보유 무기만)
    for (const s of p.slots) {
      if (s.k) { s.am = WEAPONS[s.k].mag; s.rs = WEAPONS[s.k].reserve; }
    }
  }
  game.bullets = [];
  game.phase = 'buy';
  game.timer = CFG.buyTime;
  broadcast({ t: 'msg', text: `ROUND ${game.round} — 준비 시간 (구매 ZONE에서 B)` , c: '#aaccff'});
}

// ────────────────────────── 네트워크 핸들러 ──────────────────────────
function broadcast(obj) {
  for (const p of game.players) if (p && p.socket) p.socket.send(obj);
}

function sendMsg(p, text, c = '#ffaa44') { p.socket?.send({ t: 'msg', text, c }); }

function isFree() { return game.phase === 'wait'; }

function handleConnect(sock) {
  if (!isFree()) {
    sock.send({ t: 'msg', text: '서버가 꽉 찼습니다. 잠시 후 재접속하세요.', c: '#ff5544' });
    sock.send(encodeClose(4000, 'full'));
    return;
  }
  const id = game.players.length;
  const p = mkPlayer(id, sock);
  game.players.push(p);
  console.log(`[+] 접속 #${id} (${p.team}) — 총 ${game.players.length}/2`);

  sock.send({ t: 'welcome', id, team: p.team, cfg: clientCfg() });

  if (game.players.length === 2) {
    startMatch();
  } else {
    broadcast({ t: 'msg', text: '상대방 대기 중… (2번째 플레이어 연결 대기)', c: '#aaffaa' });
  }

  sock.onMsgFn = (msg) => handleMsg(p, msg);
  sock.onCloseFn = () => handleDisconnect(p);
}

function handleMsg(p, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (p.dissed) return;
  switch (msg.t) {
    case 'join':
      if (typeof msg.name === 'string' && msg.name.trim()) {
        p.name = msg.name.trim().slice(0, 14);
        broadcast({ t: 'msg', text: `${p.name} (${p.team}) 입장`, c: '#88ffaa' });
      }
      break;
    case 'in': { // 입력
      const k = Array.isArray(msg.k) && msg.k.length === 5 ? msg.k.map(Boolean) : [false, false, false, false, false];
      const a = typeof msg.a === 'number' && isFinite(msg.a) ? msg.a : p.angle;
      p.input = { k, a, s: msg.s === true, r: msg.r === true };
      break;
    }
    case 'slot': // 무기 전환 (0=주무기, 1=보조)
      if (msg.n === 0 || msg.n === 1) {
        const s = p.slots[msg.n];
        if (s && s.k) {
          p.slot = msg.n;
          p.rec = 0;          // 전환 시 재장전 취소 (CS 스타일)
          p.accSpray = 0;     // 반동 초기화
        }
      }
      break;
    case 'buy':
      if (typeof msg.item === 'string') handleBuy(p, msg.item);
      break;
    case 'ready': // 매치 재시작 동의
      p.ready = true;
      if (game.phase === 'matchover' && game.players.every(q => q && q.ready)) {
        resetMatch();
      }
      break;
  }
}

function handleDisconnect(p) {
  if (p.dissed) return;
  p.dissed = true;
  console.log(`[!] 접속 종료 #${p.id} (${p.team})`);

  clearInterval(p.socket?.pingTimer);
  game.players = game.players.filter(q => q && q !== p);
  if (game.players.length > 0) {
    game.players.forEach(q => { q.ready = false; });
  }
  // 매치 리셋 → 대기 상태
  game.phase = 'wait';
  game.timer = 0;
  game.round = 1;
  game.scores = { T: 0, CT: 0 };
  game.bullets = [];
  broadcast({ t: 'msg', text: '상대방이 연결을 끊었습니다. 매치 리셋 → 재대기', c: '#ff5544' });
}

function startMatch() {
  // 신규 매치는 모든 플레이어 상태 초기화(이름 유지)
  game.round = 1;
  game.scores = { T: 0, CT: 0 };
  game.bullets = [];
  game.phase = 'buy';
  game.timer = CFG.buyTime;
  game.players.forEach(p => {
    p.alive = true; p.hp = 100; p.armor = 0; p.money = CFG.startMoney;
    p.slots = [
      { k: null, am: 0, rs: 0 },
      { k: p.team === 'T' ? 'glock' : 'usp', am: WEAPONS[p.team === 'T' ? 'glock' : 'usp'].mag, rs: WEAPONS[p.team === 'T' ? 'glock' : 'usp'].reserve },
    ];
    p.slot = 1; p.kills = 0; p.x = CFG.spawns[p.team].x; p.y = CFG.spawns[p.team].y;
    p.consecutiveLosses = 0; p.wins = 0; p.ready = false;
  });
  broadcast({ t: 'msg', text: `⚔️ 매치 시작! ${game.players[0].name} (T) vs ${game.players[1].name} (CT) — 선착 ${CFG.roundToWin} 라운드`, c: '#ffcc44' });
  broadcast({ t: 'msg', text: 'ROUND 1 — 준비 시간 (구매 ZONE에서 B)', c: '#aaccff' });
  console.log(`[GAME] 매치 시작: ${game.players[0].name} vs ${game.players[1].name}`);
}

function resetMatch() {
  startMatch();
}

// ────────────────────────── 스냅샷 & 틱 ──────────────────────────
function buildSnapshot(tick) {
  return {
    t: 'state',
    f: tick,
    ph: game.phase,
    tmr: Math.max(0, game.timer),
    r: game.round,
    sc: { T: game.scores.T, CT: game.scores.CT },
    p: game.players.filter(p => p && p.socket).map(p => ({
      i: p.id, n: p.name, te: p.team,
      x: p.x, y: p.y, a: p.angle, vx: p.vx || 0, vy: p.vy || 0,
      hp: Math.max(0, Math.round(p.hp)), ar: Math.round(p.armor),
      al: p.alive, sl: p.slot, mn: p.money,
      slo: p.slots.map(s => ({ k: s.k, am: s.am, rs: s.rs })),
      rec: p.rec, rt: p.recTotal, cd: p.cd,
    })),
    b: game.bullets.map(b => ({ x: b.x, y: b.y, px: b.px, py: b.py, wp: b.wp, owner: b.owner })),
    fl: game.feed[0],
  };
}

let tickCount = 0;
setInterval(() => {
  tickCount++;
  const dt = 1 / 60;
  simulate(dt);
  if (tickCount % 2 === 0 && game.players.length > 0) {
    const snap = buildSnapshot(tickCount);
    for (const p of game.players) if (p && p.socket) p.socket.send(snap);
  }
}, 1000 / 60);

// ────────────────────────── HTTP (클라이언트 서빙) ──────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'cs-client.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('client html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url === '/favicon.ico') {
    res.writeHead(204); res.end();
  } else {
    res.writeHead(404); res.end('not found');
  }
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const ws = new WsClient(socket, (msg) => ws.onMsgFn?.(msg), () => ws.onCloseFn?.());
  // WS 라이프사이클 연결
  socket.on('close', () => {});
  handleConnect(ws);
});

server.listen(PORT, () => {
  console.log('  ____ ___ _   _ _____ _____ ____ ___ _   _ ____  _____ ____');
  console.log(' / ___|_ _| \\ | |_   _| ____/ ___|_ _| \\ | |  _ \\| ____|  _ \\');
  console.log('| |    | ||  \\| | | | |  _|| |  _ | ||  \\| | |_) |  _| | |_) |');
  console.log('| |___ | || |\\  | | | | |__| |_| || || |\\  |  _ <| |___|  _ <');
  console.log(' \\____|___|_| \\_| |_| |_____\\____|___|_| \\_|_| \\_\\_____|_| \\_\\');
  console.log('');
  console.log(`[COUNTER-OP] 1v1 네트워크 아레나 서버 시작  (포트 ${PORT})`);
  console.log(`[COUNTER-OP] http://localhost:${PORT}  ← 두 개의 브라우저 탭에서 접속`);
  console.log(`[COUNTER-OP] FAST 모드: ${FAST ? 'ON' : 'OFF'}`);
});