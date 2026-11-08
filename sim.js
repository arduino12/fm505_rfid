// Simulated FM-505 behind a fake Web Serial API, for UI work without hardware. Load with index.html?sim.
// Replies follow what a real module (firmware D29B) sent on 2026-11-07: <LF>reply<CR><LF> framing,
// U lists one line per tag then a bare "U", UR appends ",R<data>" or ",<error>", N1/N5 echo the value,
// R errors come back bare ("3", "E"), and single-tag Q/R mostly fail while several tags answer.
// Four tags lie in a row 0.5 m apart under an antenna that moves from one to the next; whether a tag
// answers depends on TX power versus its distance and angle, so Hit % and the power sweep have something to find.
// window.fm505Sim.unplug() / .replug() simulate pulling the USB cable; .hold(x) parks the antenna at x metres.
(() => {
  const enc = new TextEncoder();
  const BAUDS = [4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400];
  const hex = (n, w = 1) => n.toString(16).toUpperCase().padStart(w, '0');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rnd = () => Math.random();
  function crc16(h) {
    let c = 0xFFFF;
    for (let i = 0; i < h.length; i += 2) {
      c ^= parseInt(h.substr(i, 2), 16) << 8;
      for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
    }
    return c ^ 0xFFFF;
  }
  const words = h => h.match(/.{4}/g) || [];
  const t0 = performance.now();
  const clock = () => performance.now() - t0;

  // tags recorded on the real module, laid on the ground in a row 0.5 m apart (x in metres). The antenna
  // hovers 0.3 m above the row and moves from tag to tag, pausing 5 s over each.
  // sens = TX power level (00-1B, dBm + 2) a tag needs when it sits right under the antenna.
  function makeTag({ pc, epc, tid, user = 0, cap, x, sens, p = .96 }) {
    const epcBank = ['0000', pc, ...words(epc)];
    while (epcBank.length < 2 + cap) epcBank.push('0000');
    const tag = { banks: [['0000', '0000', '0000', '0000'], epcBank, words(tid), Array(user).fill('0000')], x, sens, p, present: () => true };
    fixCrc(tag);
    return tag;
  }
  const HEIGHT = 0.3, STOPS = [0, 0.5, 1, 1.5, 1, 0.5], DWELL = 5000, MOVE = 2000;
  let holdX = null;
  function antennaX() {
    if (holdX !== null) return holdX;
    const leg = DWELL + MOVE, t = clock() % (leg * STOPS.length), i = Math.floor(t / leg), dt = t - i * leg;
    const a = STOPS[i], b = STOPS[(i + 1) % STOPS.length];
    if (dt < DWELL) return a;
    return a + (b - a) * (1 - Math.cos(Math.PI * (dt - DWELL) / MOVE)) / 2;
  }
  // power level a tag needs from where the antenna is now: one-way path loss relative to straight below,
  // plus the patch antenna's falloff off-axis (gain ~ cos^1.5 of the angle from vertical)
  function wakeLevel(tag) {
    const d = Math.hypot(antennaX() - tag.x, HEIGHT), cos = HEIGHT / d;
    return tag.sens + 20 * Math.log10(d / HEIGHT) - 15 * Math.log10(Math.max(cos, .02));
  }
  function fixCrc(tag) {
    const b = tag.banks[1], n = parseInt(b[1], 16) >> 11;
    b[0] = hex(crc16(b.slice(1, 2 + n).join('')), 4);
  }
  const epcOf = tag => { const b = tag.banks[1], n = parseInt(b[1], 16) >> 11; return b.slice(2, 2 + n).join(''); };
  const lineOf = tag => { const b = tag.banks[1]; return b[1] + epcOf(tag) + b[0]; };   // PC+EPC+CRC16
  const tags = [
    makeTag({ pc: '3400', epc: '745EA4933044A3C15FCDD542', tid: 'E2801190200094A5375A03A7', user: 2, cap: 8, x: 0, sens: 3 }),     // Impinj M750
    makeTag({ pc: '3400', epc: 'E28011700000021BE1F4AC6F', tid: 'E28011702000046F3E950B7C', user: 4, cap: 6, x: .5, sens: 5 }),    // Impinj Monza R6-P
    makeTag({ pc: '3000', epc: 'E2806894000040316A83745D', tid: 'E2806894200040316A83745D', user: 8, cap: 8, x: 1, sens: 4 }),     // NXP UCODE 8
    makeTag({ pc: '3000', epc: '300833B2DDD9014000000000', tid: 'E2003412013AF80012345678', user: 32, cap: 6, x: 1.5, sens: 6 }),  // Alien Higgs-3
  ];

  const reader = {
    id: '5153494D', power: 'FF', region: '01', dir: 0, lvl: 0, baudIdx: 4,
    select: null, password: null, busy: Promise.resolve(), buf: '',
  };
  // answer probability: ~0 a couple of dB below the tag's wake level, ~1 a couple of dB above it
  function answerP(tag) {
    const n = parseInt(reader.power, 16);
    let level = n <= 0x1B ? n : 0x1C;                                  // factory FF behaves like full power
    if (['04', '05', '0A'].includes(reader.region)) level -= 5;       // antenna is tuned for 902-928 MHz
    else if (reader.region !== '01') level -= 1;
    return tag.p / (1 + Math.exp(-(level - wakeLevel(tag) + .5) * 1.2));
  }
  function matches(tag) {
    const s = reader.select;
    if (!s) return true;
    const bits = tag.banks[s.bank]?.join('') || '';
    if (s.addr % 4 || s.len % 4) return true;                          // nibble-aligned masks only
    return bits.substr(s.addr / 4, s.len / 4) === s.data.slice(0, s.len / 4);
  }
  const responders = () => tags.filter(t => t.present() && matches(t) && rnd() < answerP(t));
  // the real module leaves most inventory rounds empty (about 2 in 3, at full power with tags at the
  // antenna) and the rest list several tags together, as if whole rounds land on dead channels
  const inventoryResponders = () => (rnd() < .6 ? [] : responders());
  function single() {
    const r = responders().sort((a, b) => wakeLevel(a) - wakeLevel(b));
    if (r.length === 1) return r[0];
    if (r.length > 1 && rnd() < .25) return r[0];                      // capture effect: strongest wins sometimes
    return null;
  }
  function readBank(tag, bank, addr, len) {
    const b = tag.banks[bank];
    if (!b || addr + len > b.length) return { err: '3' };
    return { data: b.slice(addr, addr + len).join('') };
  }
  const oneShotDone = () => { reader.select = null; reader.password = null; };

  async function handle(cmd, emit) {
    const reply = s => emit('\n' + s + '\r\n');
    let m;
    if (cmd === 'V') { await wait(12); return reply(`VD29B,${reader.id},CB,${parseInt(reader.region, 16)}`); }
    if (cmd === 'S') { await wait(10); return reply('S' + reader.id); }
    if (cmd === 'N0,00') { await wait(15); return reply('N' + reader.power); }
    if ((m = /^N1,([0-9A-F]{2})$/.exec(cmd))) { await wait(30); reader.power = m[1]; return reply('N' + m[1]); }
    if (cmd === 'N4,00') { await wait(15); return reply('N' + reader.region); }
    if ((m = /^N5,([0-9A-F]{2})$/.exec(cmd))) {
      await wait(30);
      const v = parseInt(m[1], 16);
      if (v < 1 || v > 10) return reply('X');
      reader.region = m[1]; return reply('N' + m[1]);
    }
    if (cmd === 'N6,00') { await wait(12); return reply('N' + reader.dir); }
    if ((m = /^N7,([0-7])([0-7])$/.exec(cmd))) { await wait(12); reader.dir = (reader.dir & ~m[1]) | (m[2] & m[1]); return reply('N' + reader.dir); }
    if (cmd === 'N8,00') {
      await wait(12);
      const inputs = (clock() % 6000 < 3000 ? 1 : 0) & ~reader.dir;     // pin 14 toggles while it is an input
      return reply('N' + ((reader.lvl & reader.dir) | inputs));
    }
    if ((m = /^N9,([0-7])([0-7])$/.exec(cmd))) { await wait(12); reader.lvl = (reader.lvl & ~m[1]) | (m[2] & m[1]); return reply('N' + (reader.lvl & reader.dir)); }
    if ((m = /^NA,([0-7])$/.exec(cmd))) { await wait(15); reply('N' + m[1]); await wait(5); reader.baudIdx = +m[1]; return; }
    if ((m = /^T([0-3]),([0-9A-F]+),([0-9A-F]+),([0-9A-F]+)$/.exec(cmd))) {
      await wait(10);
      reader.select = { bank: +m[1], addr: parseInt(m[2], 16), len: parseInt(m[3], 16), data: m[4] };
      return reply('T');
    }
    if ((m = /^P([0-9A-F]{8})$/.exec(cmd))) { await wait(10); reader.password = m[1]; return reply('P'); }
    if ((m = /^(Q|U(\d+)?)(?:,R([0-3]),([0-9A-F]+),([0-9A-F]+))?$/.exec(cmd))) {
      const extra = m[3] !== undefined ? { bank: +m[3], addr: parseInt(m[4], 16), len: parseInt(m[5], 16) } : null;
      const fmt = tag => {
        let s = lineOf(tag);
        if (extra) { const r = readBank(tag, extra.bank, extra.addr, extra.len); s += r.data ? ',R' + r.data : ',' + r.err; }
        return s;
      };
      if (m[1] === 'Q') {
        await wait(18 + rnd() * 20 + (extra ? 10 : 0));
        const tag = rnd() < .6 ? null : single();
        oneShotDone();
        return reply(tag ? 'Q' + fmt(tag) : 'Q');
      }
      const slots = 2 ** Math.min(15, +(m[2] || 0));
      const r = inventoryResponders(), bySlot = new Map();
      for (const t of r) { const k = Math.floor(rnd() * slots); bySlot.set(k, [...(bySlot.get(k) || []), t]); }
      const found = [...bySlot.values()].filter(v => v.length === 1).map(v => v[0]);
      await wait(12 + slots * 9 + found.length * (extra ? 14 : 5) + rnd() * 10);
      oneShotDone();
      for (const t of found) reply('U' + fmt(t));
      return reply('U');
    }
    if ((m = /^R([0-9A-F]),([0-9A-F]+),([0-9A-F]+)$/.exec(cmd))) {
      await wait(25 + rnd() * 15);
      const bank = parseInt(m[1], 16);
      if (bank > 3) return reply('X');
      const tag = single();
      oneShotDone();
      if (!tag) return reply('R');
      if (rnd() < .08) return reply('E');                               // seen once on real hardware right after T
      const r = readBank(tag, bank, parseInt(m[2], 16), parseInt(m[3], 16));
      return reply(r.data ? 'R' + r.data : r.err);
    }
    if ((m = /^W([0-9A-F]),([0-9A-F]+),([0-9A-F]+),([0-9A-F]*)$/.exec(cmd))) {
      await wait(40 + rnd() * 30);
      const bank = parseInt(m[1], 16), addr = parseInt(m[2], 16), len = parseInt(m[3], 16), data = words(m[4]);
      if (bank > 3 || data.length !== len) return reply('X');
      const tag = single();
      oneShotDone();
      if (!tag) return reply('W');
      if (bank === 2) return reply('4');
      const b = tag.banks[bank];
      if (addr + len > b.length) return reply('3');
      b.splice(addr, len, ...data);
      if (bank === 1) fixCrc(tag);
      return reply('W<OK>');
    }
    if (/^G[012]$/.test(cmd)) { await wait(10); return reply(cmd); }
    if (/^[KL]/.test(cmd)) { await wait(30); oneShotDone(); return reply(cmd[0]); }   // never really kills or locks
    await wait(8);
    return reply('X');
  }

  class SimPort extends EventTarget {
    constructor() { super(); this.readable = null; this.writable = null; this.ctrl = null; this.baud = 0; this.plugged = true; }
    getInfo() { return { usbVendorId: 0x1A86, usbProductId: 0x7523 }; }
    async open({ baudRate }) {
      if (!this.plugged) throw new DOMException('The device has been lost.', 'NetworkError');
      if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError');
      this.baud = baudRate;
      this.readable = new ReadableStream({ start: c => { this.ctrl = c; }, cancel: () => { this.ctrl = null; } });
      this.writable = new WritableStream({ write: chunk => this.receive(chunk) });
    }
    async close() { this.readable = null; this.writable = null; this.ctrl = null; }
    emit(s) {
      if (!this.ctrl) return;
      if (this.baud !== BAUDS[reader.baudIdx]) s = s.replace(/./g, () => '?\0\x1c'[Math.floor(rnd() * 3)]);   // wrong baud: noise
      try { this.ctrl.enqueue(enc.encode(s)); } catch {}
    }
    receive(chunk) {
      if (this.baud !== BAUDS[reader.baudIdx]) return;
      reader.buf += new TextDecoder().decode(chunk);
      let i;
      while ((i = reader.buf.indexOf('\r')) >= 0) {
        const cmd = reader.buf.slice(0, i).replace(/\n/g, '').trim();
        reader.buf = reader.buf.slice(i + 1);
        if (cmd) reader.busy = reader.busy.then(() => handle(cmd, s => this.emit(s))).catch(() => {});
      }
    }
    unplug() {
      this.plugged = false;
      try { this.ctrl?.error(new DOMException('The device has been lost.', 'NetworkError')); } catch {}
      this.readable = null; this.writable = null; this.ctrl = null;
    }
  }

  const port = new SimPort();
  const api = new EventTarget();
  const granted = () => { try { return localStorage.getItem('fm505.simGranted') === '1'; } catch { return false; } };
  api.requestPort = async () => { try { localStorage.setItem('fm505.simGranted', '1'); } catch {} return port; };
  api.getPorts = async () => (granted() ? [port] : []);
  api.unplug = () => port.unplug();
  api.replug = () => {
    port.plugged = true;
    const ev = new Event('connect');
    Object.defineProperty(ev, 'target', { value: port });
    api.dispatchEvent(ev);
  };
  api.reader = reader;
  api.tags = tags;
  api.antennaX = antennaX;
  api.hold = x => { holdX = x ?? null; };                              // park the antenna at x metres; hold() resumes
  api.wakeLevels = () => tags.map(t => +wakeLevel(t).toFixed(1));
  window.fm505Sim = api;
})();
