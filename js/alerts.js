// 警報規則（對應 blindnav/alerts.py）：把每一幀的偵測結果轉成語音、警示音與橫幅。
import { C, fmt } from "./config.js";
import { BEEP_LEVELS, beepLevel, beepPattern, speedLevelText, ttcIsMeaningful } from "./analysis.js";

// 速度的文字描述，例如「跑步」「快速（橫越）」
export function speedDescription(tr) {
  const text = speedLevelText(tr.label, tr.speedLevel);
  if (tr.speedSource === "lateral" && tr.speedLevel !== "slow") return `${text}（橫越）`;
  return text;
}

// 說明碰撞風險主要是被什麼拉高的，顯示在進度條下方
export function riskReasonText(tr) {
  const reasons = [];
  if (tr.proximityLevel !== "GREEN") reasons.push(`距離${C.PROXIMITY_TEXT[tr.proximityLevel]}`);
  if (tr.speedLevel !== "slow") reasons.push(speedDescription(tr));
  if (Number.isFinite(tr.ttcSec) && tr.ttcSec <= C.TTC_DANGER_SEC && tr.inCollisionZone) reasons.push("即將撞上");
  return reasons.join("、");
}

// 畫面中最近（佔畫面比例最大）的行人，供「行人距離」進度條使用
export function nearestPersonInfo(tracks) {
  const persons = tracks.filter(tr => tr.rawLabel === "person");
  if (!persons.length) return null;
  const tr = persons.reduce((a, b) => (b.occupancyRatio > a.occupancyRatio ? b : a));
  return { level: tr.proximityLevel, occupancy: tr.occupancyRatio, distanceM: tr.distanceM,
           direction: tr.horizontalPosition };
}

// 「值得注意」的物體：行人、狀態非安全、正在移動，或有 TTC 量測
export function isTrackOfInterest(tr) {
  return tr.rawLabel === "person" || tr.state !== "GREEN" || tr.proximityLevel !== "GREEN"
    || tr.speedLevel !== "slow" || tr.speedPctS > C.ATTENTION_GROWTH_PCT_S || ttcIsMeaningful(tr.ttcSec);
}

// 物體在畫面上的水平位置換算成 -1（最左）~ 1（最右），給左右聲道提示
export function horizontalPan(item, frameWidth) {
  const cx = (item.box[0] + item.box[2]) / 2;
  return Math.max(-1, Math.min(1, cx / Math.max(frameWidth, 1) * 2 - 1));
}

// 例如「正前方，頭上有障礙」。距離不念，交給警示音的節奏。
export function staticAlertText(hazard) {
  const template = C.STATIC_ALERT_TEXT[hazard.kind] || "{dir}，有{label}";
  return fmt(template, { dir: C.DIRECTION_TEXT[hazard.horizontalPosition], label: hazard.label });
}

function staticLogText(hazard) {
  return Number.isFinite(hazard.distanceM) ? `${hazard.label}（約 ${hazard.distanceM.toFixed(1)} 公尺）` : hazard.label;
}

const maxBy = (items, key) => items.reduce((a, b) => (key(b) > key(a) ? b : a));
const minBy = (items, key) => items.reduce((a, b) => (key(b) < key(a) ? b : a));

// 五種警報：
//   ① 即將撞上（TTC）：「不危險 → 危險」時念「危險」，TTC 降到 TTC_URGENT_SEC 內再念一次「停」。
//   ② 過近 / 速度過快：只算預測軌跡會進入行走路徑的物體（從旁邊經過的不報，這是報告的核心），
//      變紅時播報，持續紅色時提醒間隔由 ALARM_VOICE_REPEAT_SEC 逐次加倍到 ALARM_VOICE_REPEAT_MAX_SEC；
//      警示音一直響到物體離開紅色、語音念完後再過 ALARM_RELEASE_HOLD_SEC 才停。
//      同一個近物持續 ALARM_SETTLED_SEC 都沒有更靠近（排隊、跟人說話、站在牆前）就停掉警示音；
//      又靠近、出現新物體或即將撞上時立刻恢復。
//   ③ 靜態障礙（頭部高度障礙、柱子）：規則同 ②。
//   ④ 光線不足　⑤ 幀率過低
// 聲音只有一種（倒車雷達），語音一次也只念最緊急的一句；危險結束時念一次「警報解除」。
export class AlertEngine {
  static KINDS = ["proximity", "speed", "static"];

  constructor(minSafeFps = C.MIN_SAFE_FPS) {
    this.minSafeFps = minSafeFps;     // 0 代表不檢查幀率
    const each = v => Object.fromEntries(AlertEngine.KINDS.map(k => [k, v]));
    this.alarmLastSeen = each(-Infinity);
    this.lastAlarmVoice = each(-Infinity);
    this.alarmPan = each(0);
    this.alarmLevel = each("far");
    this.alarmSince = each(null);     // 這次警報（或上次又靠近）的時間
    this.alarmSeen = Object.fromEntries(AlertEngine.KINDS.map(k => [k, new Set()]));  // 這次警報看過的物體
    this.alarmClosest = each(Infinity);
    this.alarmRepeats = each(0);
    this.lastAlarmOn = -Infinity;
    this.ttcLastHit = new Map();      // 追蹤編號 → 最後一次判定即將撞上的時間
    this.ttcLastUrgent = new Map();
    this.lastTtcSeen = -Infinity;
    this.lastTtcVoice = -Infinity;
    this.lastAnyVoice = -Infinity;
    this.alarmSpoken = false;         // 這次危險念過警報，結束時才需要念「警報解除」
    this.darkSince = null;
    this.lastLowLightVoice = -Infinity;
    this.lastBlockedVoice = -Infinity;
    this.blockedGap = C.CAMERA_BLOCKED_REPEAT_SEC;
    this.frameTimes = [];
    this.longGaps = 0;
    this.started = null;
    this.lastLowFpsVoice = -Infinity;
    this.lowFpsSince = null;
  }

  // 記下這次警報的進展：出現新物體或又靠近了，就回到最警覺的狀態
  noteAlarm(kind, items, ts) {
    const keys = items.map(item => item.trackId ?? `${item.label}|${item.horizontalPosition}`);
    const closest = Math.min(...items.map(item => item.distanceM));
    const changed = keys.some(k => !this.alarmSeen[kind].has(k))
      || closest < this.alarmClosest[kind] - C.ALARM_PROGRESS_M;
    keys.forEach(k => this.alarmSeen[kind].add(k));
    this.alarmClosest[kind] = Math.min(this.alarmClosest[kind], closest);
    if (changed || this.alarmSince[kind] == null) {
      this.alarmSince[kind] = ts;
      this.alarmRepeats[kind] = 0;
    }
  }

  endAlarm(kind) {
    this.alarmSince[kind] = null;
    this.alarmSeen[kind] = new Set();
    this.alarmClosest[kind] = Infinity;
    this.alarmRepeats[kind] = 0;
  }

  // 近物一直待在原處：使用者多半是停著，或正在跟對方說話。距離不明時不能判斷，繼續警示
  settled(kind, ts) {
    return kind !== "speed" && this.alarmSince[kind] != null
      && ts - this.alarmSince[kind] >= C.ALARM_SETTLED_SEC
      && Number.isFinite(this.alarmClosest[kind]);
  }

  // 近 LOW_FPS_HOLD_SEC 秒的實際處理幀率
  frameRate(ts) {
    this.frameTimes.push(ts);
    while (ts - this.frameTimes[0] > C.LOW_FPS_HOLD_SEC) this.frameTimes.shift();
    const span = ts - this.frameTimes[0];
    if (span > 0) {
      this.longGaps = 0;
      return (this.frameTimes.length - 1) / span;
    }
    // 窗內只剩這一幀，代表上一幀已經是很久以前：一次多半是暫停，不算慢；連續兩次才是真的慢
    if (ts !== this.started) this.longGaps++;
    return this.longGaps >= 2 ? 0 : Infinity;
  }

  // 分兩級：危險 → 停。判定短暫閃斷（TTC_RELEASE_SEC 內）不算重新靠近，否則同一個人會被一直喊「危險」
  ttcSpeech(ttcHits, ts, out) {
    // 記憶裡的是「念過」的物體：還在危險就延長；沒念過的（被語音間隔擋下）下一幀還要再試，不能吃掉
    const fresh = (hits, memory) => {
      for (const [id, t] of memory) if (ts - t > C.TTC_RELEASE_SEC) memory.delete(id);
      for (const tr of hits) if (memory.has(tr.trackId)) memory.set(tr.trackId, ts);
      return hits.filter(tr => !memory.has(tr.trackId));
    };
    const newHits = fresh(ttcHits, this.ttcLastHit);
    const newUrgent = fresh(ttcHits.filter(tr => tr.ttcSec <= C.TTC_URGENT_SEC), this.ttcLastUrgent);
    let template, priority, worst;
    if (newUrgent.length) {
      [template, priority, worst] = [C.TTC_URGENT_ALERT_TEXT, C.SPEECH_PRIORITY.urgent, minBy(newUrgent, tr => tr.ttcSec)];
      this.ttcLastUrgent.set(worst.trackId, ts);
    } else if (newHits.length && ts - this.lastTtcVoice >= C.ALARM_VOICE_MIN_GAP_SEC) {
      [template, priority, worst] = [C.TTC_ALERT_TEXT, C.SPEECH_PRIORITY.ttc, minBy(newHits, tr => tr.ttcSec)];
    } else {
      return;
    }
    this.ttcLastHit.set(worst.trackId, ts);
    this.lastTtcVoice = ts;
    out.alerts.push([`${worst.label}即將撞上`, worst.horizontalPosition]);
    out.speech.push([fmt(template, { dir: C.DIRECTION_TEXT[worst.horizontalPosition], obj: worst.label }), priority]);
  }

  // ts 單位為秒
  update(allTracks, ts, speaking, { brightness = null, frameWidth = C.FRAME_WIDTH, staticHazards = [] } = {}) {
    // 這一幀沒有真的看到的物體（暫留）不能發出警報：可能只是鏡頭轉走了
    const tracks = allTracks.filter(tr => !tr.isPredicted);
    const out = { alerts: [], speech: [], alarmOn: {}, beep: null, beepPan: 0,
                  lowLight: false, cameraBlocked: false, lowFps: false, fps: 0 };

    // ① 即將撞上
    const ttcHits = tracks.filter(tr => Number.isFinite(tr.ttcSec) && tr.ttcSec <= C.TTC_DANGER_SEC
                                        && tr.inCollisionZone);
    if (ttcHits.length) this.lastTtcSeen = ts;
    this.ttcSpeech(ttcHits, ts, out);

    // ② 過近 / 速度過快、③ 靜態障礙
    const trackLog = template => tr => fmt(template(tr), { obj: tr.label });
    const trackSay = template => tr => `${C.DIRECTION_TEXT[tr.horizontalPosition]}，${fmt(template(tr), { obj: tr.label })}`;
    const proximityText = () => C.PROXIMITY_ALERT_TEXT;
    const speedText = tr => (tr.speedSource === "lateral" ? C.LATERAL_ALERT_TEXT : C.SPEED_ALERT_TEXT);
    const levelIndex = l => BEEP_LEVELS.indexOf(l);
    // 以預測軌跡為主：軌跡不會進入行走路徑的物體，再近、再快也不發警報（沒有這個欄位時視為在路徑上）
    const onCourse = tracks.filter(tr => tr.onCourse !== false || !C.TRAJECTORY_FIRST);
    // 橫越：遠處的車不會撞到人，距離不明時寧可提醒。
    // 靠近：面積變化率對遠處的小目標雜訊很大，要 TTC 也認為快到了才算，否則 6 秒外就會喊「很快」。
    const speedMatters = tr => (tr.speedSource === "lateral"
      ? !Number.isFinite(tr.distanceM) || tr.distanceM <= C.SPEED_ALERT_MAX_M
      : tr.ttcSec <= C.SPEED_ALERT_MAX_TTC_SEC);
    const alarmSources = {
      // 已經判定「過近」的物體，距離不明時至少用「近」的節奏
      // 最近的最危險；只看佔畫面比例的話，遠處的公車會蓋過被切到一半的近人
      proximity: [onCourse.filter(tr => tr.proximityLevel === "RED"),
                  tr => (Number.isFinite(tr.distanceM) ? -tr.distanceM : -1e6) + tr.occupancyRatio * 1e-3,
                  trackLog(proximityText), trackSay(proximityText),
                  tr => BEEP_LEVELS[Math.max(levelIndex(beepLevel(tr.distanceM)), levelIndex("near"))]],
      speed: [onCourse.filter(tr => tr.speedLevel === "fast" && speedMatters(tr)), tr => tr.speedPctS,
              trackLog(speedText), trackSay(speedText), tr => beepLevel(tr.distanceM)],
      static: [[...staticHazards], h => -h.distanceM, staticLogText, staticAlertText, h => beepLevel(h.distanceM)],
    };
    const waiting = [];               // 這一幀想念的句子，最後只念最緊急的一句
    const hitIds = new Set(ttcHits.filter(tr => this.ttcLastHit.has(tr.trackId)).map(tr => tr.trackId));
    for (const [kind, [redItems, severity, logText, sayText, level]] of Object.entries(alarmSources)) {
      const wasOn = ts - this.alarmLastSeen[kind] <= C.ALARM_RELEASE_HOLD_SEC;
      // 語音播放時警示音會暫停；念完前不算解除，否則短暫的紅色狀態只聽得到一聲
      if (redItems.length || (wasOn && speaking)) this.alarmLastSeen[kind] = ts;
      if (redItems.length) {
        const worst = maxBy(redItems, severity);
        this.alarmPan[kind] = horizontalPan(worst, frameWidth);
        this.alarmLevel[kind] = level(worst);
        this.noteAlarm(kind, redItems, ts);
        const sinceVoice = ts - this.lastAlarmVoice[kind];
        const repeatGap = Math.min(C.ALARM_VOICE_REPEAT_SEC * 2 ** Math.max(0, this.alarmRepeats[kind] - 1),
                                   C.ALARM_VOICE_REPEAT_MAX_SEC);
        // 已經在喊「危險／停」的物體不用再說一次「很近／很快」，警示音會持續響
        const unannounced = redItems.filter(item => !hitIds.has(item.trackId));
        if (unannounced.length && sinceVoice >= C.ALARM_VOICE_MIN_GAP_SEC
            && (!wasOn || sinceVoice >= repeatGap)) {
          const speak = maxBy(unannounced, severity);
          waiting.push({ priority: C.SPEECH_PRIORITY[kind], kind, text: sayText(speak), log: logText(speak),
                         dir: speak.horizontalPosition });
        }
      }
      out.alarmOn[kind] = ts - this.alarmLastSeen[kind] <= C.ALARM_RELEASE_HOLD_SEC;
      if (!out.alarmOn[kind]) this.endAlarm(kind);
    }
    out.alarmOn.ttc = ts - this.lastTtcSeen <= C.ALARM_RELEASE_HOLD_SEC;
    if (Object.values(out.alarmOn).some(Boolean)) this.lastAlarmOn = ts;

    // 唯一的警示音：在所有響著的警報中挑最急的節奏（同節奏時依語音優先順序）
    const candidates = AlertEngine.KINDS.filter(k => out.alarmOn[k] && !this.settled(k, ts))
      .map(k => [this.alarmLevel[k], C.SPEECH_PRIORITY[k], this.alarmPan[k]]);
    if (ttcHits.length) {
      const nearest = minBy(ttcHits, tr => tr.ttcSec);
      candidates.push([nearest.ttcSec <= C.TTC_URGENT_SEC ? "close" : "near", C.SPEECH_PRIORITY.ttc,
                       horizontalPan(nearest, frameWidth)]);
    }
    if (candidates.length) {
      const best = maxBy(candidates, c => levelIndex(c[0]) * 100 + c[1]);
      out.beep = beepPattern(best[0]);
      out.beepPan = best[2];
    }

    // 一次只念最緊急的一句；剛念過警報就先等一下，沒念到的下一幀還有機會，不會被吃掉
    if (out.speech.length) {
      this.lastAnyVoice = ts;
    } else if (waiting.length && ts - this.lastAnyVoice >= C.ALARM_VOICE_GLOBAL_GAP_SEC) {
      const pick = maxBy(waiting, item => item.priority);
      this.lastAlarmVoice[pick.kind] = this.lastAnyVoice = ts;
      this.alarmRepeats[pick.kind]++;
      out.alerts.push([pick.log, pick.dir]);
      out.speech.push([pick.text, pick.priority]);
    }

    // 危險結束：只有真的念過警報才說解除
    if (out.speech.length) {
      this.alarmSpoken = true;
    } else if (this.alarmSpoken && !speaking && ts - this.lastAlarmOn >= C.CLEAR_AFTER_SEC) {
      this.alarmSpoken = false;
      out.speech.push([C.CLEAR_TEXT, C.SPEECH_PRIORITY.info]);
    }

    // ④ 光線不足
    if (brightness != null && brightness < C.LOW_LIGHT_MEAN) {
      if (this.darkSince == null) this.darkSince = ts;
      out.lowLight = ts - this.darkSince >= C.LOW_LIGHT_HOLD_SEC;
      out.cameraBlocked = out.lowLight && brightness < C.CAMERA_BLOCKED_MEAN;
      if (out.cameraBlocked) {
        if (ts - this.lastBlockedVoice >= this.blockedGap) {
          if (Number.isFinite(this.lastBlockedVoice)) this.blockedGap = Math.min(this.blockedGap * 2, 300);
          this.lastBlockedVoice = ts;
          out.alerts.push([C.CAMERA_BLOCKED_TEXT, null]);
          out.speech.push([C.CAMERA_BLOCKED_TEXT, C.SPEECH_PRIORITY.info]);
        }
      } else if (out.lowLight && ts - this.lastLowLightVoice >= C.LOW_LIGHT_REPEAT_SEC) {
        this.lastLowLightVoice = ts;
        out.alerts.push([C.LOW_LIGHT_TEXT, null]);
        out.speech.push([C.LOW_LIGHT_TEXT, C.SPEECH_PRIORITY.info]);
      }
    } else {
      this.darkSince = null;
      if (ts - this.lastBlockedVoice >= C.CAMERA_BLOCKED_REPEAT_SEC) this.blockedGap = C.CAMERA_BLOCKED_REPEAT_SEC;
    }

    // ⑤ 幀率過低：啟動滿 LOW_FPS_HOLD_SEC 秒後才判斷
    if (this.started == null) this.started = ts;
    out.fps = this.frameRate(ts);
    out.lowFps = ts - this.started >= C.LOW_FPS_HOLD_SEC && out.fps < this.minSafeFps;
    if (!out.lowFps) this.lowFpsSince = null;
    else if (this.lowFpsSince == null) this.lowFpsSince = ts;
    if (out.lowFps && ts - this.lowFpsSince >= C.LOW_FPS_VOICE_AFTER_SEC
        && ts - this.lastLowFpsVoice >= C.LOW_FPS_REPEAT_SEC) {
      this.lastLowFpsVoice = ts;
      out.alerts.push([C.LOW_FPS_TEXT, null]);
      out.speech.push([C.LOW_FPS_TEXT, C.SPEECH_PRIORITY.info]);
    }
    return out;
  }
}

// 語音用的距離：單眼估計本來就不精準，念到整數公尺就好
export function spokenDistance(distanceM) {
  if (!Number.isFinite(distanceM)) return "";
  return distanceM < 1 ? "不到 1 公尺" : `約 ${Math.round(distanceM)} 公尺`;
}

// 使用者主動詢問「目前狀況」時念的一句話：靜態障礙優先，其餘依碰撞風險排序
export function sceneSummary(tracks, staticHazards = [], limit = C.SCENE_MAX_ITEMS) {
  const join = items => items.filter(Boolean).join("，");
  const parts = [...staticHazards].sort((a, b) => a.distanceM - b.distanceM)
    .map(h => join([`${C.DIRECTION_TEXT[h.horizontalPosition]}${h.label}`, spokenDistance(h.distanceM)]));
  const ranked = [...tracks].sort((a, b) => (b.collisionProbability - a.collisionProbability) || (a.distanceM - b.distanceM));
  for (const tr of ranked) {
    const hit = Number.isFinite(tr.ttcSec) && tr.ttcSec <= C.TTC_DANGER_SEC && tr.inCollisionZone;
    const motion = hit ? "可能撞上" : (tr.approachState === "approaching" ? "正在靠近" : "");
    parts.push(join([`${C.DIRECTION_TEXT[tr.horizontalPosition]}${tr.label}`, spokenDistance(tr.distanceM), motion]));
  }
  if (!parts.length) return C.SCENE_EMPTY_TEXT;
  const more = parts.length > limit ? `另外還有 ${parts.length - limit} 個。` : "";
  return `偵測到 ${parts.length} 個物體。${parts.slice(0, limit).join("；")}。${more}`;
}

// 面板要顯示的摘要：最快物體、最高碰撞風險、最近的行人
export function frameSummary(tracks) {
  if (!tracks.length) return { fastest: null, highest: null, person: null };
  const fastest = maxBy(tracks, tr => tr.speedPctS);
  const highest = maxBy(tracks, tr => tr.collisionProbability);
  return {
    fastest: { label: fastest.label, pct: fastest.speedPctS, level: fastest.speedLevel,
               text: speedDescription(fastest) },
    highest: { label: highest.label, probability: highest.collisionProbability,
               ttc: ttcIsMeaningful(highest.ttcSec) ? highest.ttcSec : null,
               reason: riskReasonText(highest) },
    person: nearestPersonInfo(tracks),
  };
}
