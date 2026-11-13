// 語音、警示音與震動（對應 blindnav/audio.py 與原本手機網頁裡的聲音部分）。
import { C } from "./config.js";

export class AudioOutput {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.speakingPri = -1;
    this._beep = null;           // [頻率, 響聲 ms, 間隔 ms] 或 null（用 this.beep 讀寫）
    this.voiceStarted = false;   // 語音引擎真的開始出聲了（送出到出聲之間，有些手機要等半秒以上）
    this.beepPan = 0;
    this.rate = C.SPEECH_RATE;
    this.speechDeadline = 0;
    this.loopId = 0;             // 每次 start() 換一個編號，舊的警示音迴圈自動結束
    this.paused = false;         // 目前沒有在看（鏡頭中斷、畫面全黑）時 true：狀態提示音不響，它代表「系統真的在看」
    this.running = false;
    this.lastStatusTone = 0;
    this.statusTimer = null;
    this.currentUtterance = null;
    this.stepsToken = 0;
  }

  get beep() { return this._beep; }
  // 節奏變急（或從無到有）時馬上響：迴圈還在等上一個節奏的間隔，慢節奏要等將近 0.8 秒，快撞上時等不起
  set beep(pattern) {
    const old = this._beep;
    this._beep = pattern;
    if (pattern && this.running && this.ctx && (!old || pattern[2] < old[2])) this.beepLoop(++this.loopId);
  }

  // iPhone 規定聲音必須在使用者點擊後才能開始，所以要在「開始偵測」按下時呼叫
  unlock() {
    try {
      // iPhone 的靜音鍵預設會讓網頁聲音消失；警示音不能因為這樣就不見
      if (navigator.audioSession) navigator.audioSession.type = "playback";
    } catch (e) { /* 不支援時略過 */ }
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      // 剛講完電話時聲音引擎可能一直等不到；聲音出不來不該擋住偵測，語音與震動還是有用
      return Promise.race([this.ctx.resume().catch(() => {}), new Promise(ok => setTimeout(ok, 1500))]);
    } catch (e) {
      return Promise.resolve();
    }
  }

  start() {
    this.running = true;
    this.beepLoop(++this.loopId);
    // 狀態提示音：系統真的在看的時候才響，約每 10 秒一聲；戶外也要聽得到
    clearInterval(this.statusTimer);
    this.statusTimer = setInterval(() => {
      if (!this.running || !this.enabled || !this.ctx || !C.STATUS_TONE_ENABLED || document.hidden || this.paused) return;
      if (this.beep || this.speaking()) return;
      const now = performance.now();
      if (now - this.lastStatusTone < C.STATUS_TONE_SEC * 1000) return;
      this.lastStatusTone = now;
      this.statusTone();
    }, 250);
  }

  stop() {
    this.running = false;
    this.beep = null;
    clearInterval(this.statusTimer);
    this.stopSteps();
    this.hush();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) { this.stopSteps(); this.hush(); }
  }

  // 先放掉目前這句再取消：取消事件不論同步或非同步觸發，都不會讓一串說明接著念下一句
  hush() {
    this.currentUtterance = null;
    this.speakingPri = -1;
    this.voiceStarted = false;
    window.speechSynthesis?.cancel();
  }

  // 有些手機的語音引擎會卡住，speaking 永遠是 true；不處理的話警示音會跟著永遠暫停
  speaking() {
    const s = window.speechSynthesis;
    if (!s || !s.speaking) return false;
    if (performance.now() > this.speechDeadline) {
      this.hush();
      return false;
    }
    return true;
  }

  // 只有念警報才算：念操作說明時不能讓警報規則以為警報還沒解除
  alarmSpeaking() {
    return this.speaking() && this.speakingPri > 0;
  }

  // 依優先順序念語音：更緊急的可以打斷正在念的，排隊中已有一句時不再疊加過時警報。
  // force：使用者主動要求的（例如「目前狀況」），聲音關閉時也念；「停」攸關安全，聲音關閉時也要念
  say(text, pri = 0, force = false, onDone = null) {
    const s = window.speechSynthesis;
    if ((!this.enabled && !force && pri < 4) || !s) return;
    let queued = false;
    if (s.speaking || s.pending) {
      if (pri > this.speakingPri) this.hush();
      else if (s.pending) return;
      else queued = true;
    } else {
      this.speakingPri = -1;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-TW";
    u.rate = this.rate;
    const voices = s.getVoices();
    const voice = voices.find(v => /zh[-_]TW/i.test(v.lang)) || voices.find(v => /^zh/i.test(v.lang));
    if (voice) u.voice = voice;
    // 優先順序要立刻記下：語音引擎開始念之前還有一段延遲，等 onstart 的話，
    // 同一幀念第二句（例如光線不足）時會以為沒在念，反而把「停」打斷
    this.speakingPri = Math.max(this.speakingPri, pri);
    this.currentUtterance = u;
    // 前一句念完、輪到排隊的這句時，才換成它的優先順序（低優先的句子要能被打斷）
    u.onstart = () => { if (u === this.currentUtterance) { this.speakingPri = pri; this.voiceStarted = true; } };
    // 被打斷時 currentUtterance 已經換人，不會接著念下一步（有些瀏覽器取消時也會觸發 onend）
    u.onend = u.onerror = () => {
      if (u === this.currentUtterance) {
        this.speakingPri = -1;
        this.voiceStarted = false;
        this.currentUtterance = null;
        if (onDone) onDone();
      }
    };
    // 排在別句後面時，期限要接在那句後面，不能把正在念的長句截斷
    this.speechDeadline = (queued ? this.speechDeadline : performance.now()) + 4000 + text.length * 400;
    s.speak(u);
  }

  // 依序念好幾句（中間可以穿插提示音）；開始新的一串或被警報打斷時，舊的就不再繼續
  speakSteps(steps) {
    const token = ++this.stepsToken;
    const next = i => {
      if (token !== this.stepsToken || i >= steps.length) return;
      const step = steps[i];
      if (typeof step === "function") setTimeout(() => next(i + 1), step());
      else this.say(step, 0, true, () => next(i + 1));
    };
    next(0);
  }

  stopSteps() { this.stepsToken++; }

  // 一聲短音；pan 為 -1（左）~ 1（右），戴耳機時聲音從物體所在的那一側傳來
  tone(freq, ms, at, pan, vol = 0.16, type = "square") {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.01);
    g.gain.setValueAtTime(vol, at + ms / 1000 - 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
    let node = o.connect(g);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      node = node.connect(p);
    }
    node.connect(ctx.destination);
    o.start(at);
    o.stop(at + ms / 1000 + 0.02);
  }

  statusTone() {
    if (this.ctx) this.tone(440, 90, this.ctx.currentTime + 0.02, 0, 0.07, "sine");
  }

  // 「暫時沒有偵測」：兩聲往下的低音，跟警示音、狀態提示音都不一樣
  lostTone() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.02;
    this.tone(392, 130, t, 0, 0.14, "sine");
    this.tone(262, 180, t + 0.18, 0, 0.14, "sine");
  }

  // 操作說明裡示範警示音：由慢變急
  demoAlarm() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.02;
    [0, 0.77, 1.1, 1.42].forEach(d => this.tone(C.BEEP_FREQ_HZ, 120, t + d, 0));
  }

  // 倒車雷達：只有一種聲音，越近越急促，很近時變長音；語音播放時聲音暫停，震動不停（聲音關閉時也是）
  beepLoop(id) {
    if (!this.running || id !== this.loopId) return;
    // 來電等中斷之後，聲音引擎不一定會自己恢復（iPhone）
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    if (!this.ctx || !this.beep) {
      setTimeout(() => this.beepLoop(id), 100);
      return;
    }
    const [freq, on, off] = this.beep;
    // 念警報時先讓路；念操作說明、目前狀況時照響，不能因為在聽說明就沒有警示音。
    // 語音送出後到真的出聲之前也照響：這段空檔完全沒聲音的話，等於撞上了才有反應
    if (this.enabled && (!this.speaking() || this.speakingPri <= 0 || !this.voiceStarted)) this.tone(freq, on, this.ctx.currentTime + 0.02, this.beepPan);
    if (navigator.vibrate) navigator.vibrate(on);
    setTimeout(() => this.beepLoop(id), on + off);
  }
}
