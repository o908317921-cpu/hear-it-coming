// 集中設定：所有門檻、顏色、文字都在這裡（對應 Python 版 blindnav/config.py）。
//
// 不想改程式時，可以編輯 webapp/settings.json 覆寫這裡任何一個「大寫設定」，
// 例如 {"PROXIMITY_RED_RATIO": 0.3}。載入順序：這裡的預設值 → settings.json。

export const C = {
  // ============================================================
  // 1. 影像與模型
  // ============================================================
  // 有顯示晶片時也用只偵測、輸入 320 的輕量模型。實測（同一台電腦、同一段畫面）：
  // 每秒 7.6 → 12.1 幀，最慢時 YOLO 225 → 95 ms；正面走來的人提早 0.4 秒看到、提早 0.5 秒念出警報。
  // 代價是畫面上不畫人形輪廓，只畫框。要換回分割模型：MODEL_URL 改回 yolo11n-seg.onnx、INFERENCE_SIZE 改回 448
  MODEL_URL: new URL("../models/yolo11n-det-320.onnx", import.meta.url).href,
  INFERENCE_SIZE: 320,
  // 沒有顯示晶片加速的手機用小一號的輸入：速度比遠處的小物體重要，來不及警告就沒有意義
  MODEL_URL_WASM: new URL("../models/yolo11n-det-320.onnx", import.meta.url).href,   // 只偵測、不算輪廓，實測快 1.66 倍，命中率沒有變差
  INFERENCE_SIZE_WASM: 320,
  WEBGPU_START_TIMEOUT_SEC: 60,   // 顯示晶片第一次運算超過這麼久視為卡死，改用 CPU（第一次要編譯，慢手機確實會等很久）
  LOW_MEMORY_GB: 2,               // 瀏覽器回報的記憶體不超過這個值：直接用省記憶體模式，不要等到分頁被關掉
  // 沒有輪廓的輕量模型估面積用：實測 109 張真實街景，輪廓面積佔框的比例（中位數）
  BOX_AREA_FILL: { person: 0.64, bicycle: 0.56, car: 0.79, motorcycle: 0.61, bus: 0.87, truck: 0.73 },
  BOX_AREA_FILL_DEFAULT: 0.7,
  OVERLAY_MAX_EXTRAPOLATE_SEC: 0.5, // 框最多往後推算這麼久：辨識卡住時不能讓框一路飄走
  OVERLAY_MIN_FRAME_MS: 30,       // 畫框最快每秒約 30 次，螢幕更新再快也不多畫
  OVERLAY_HIDE_TURN_DEG_S: 120,   // 手機轉得比這個快（度／秒）時先不畫框：畫面是即時的，框來自剛才那一幀，對不上
  WASM_MAX_THREADS: 4,            // WASM 最多用幾個執行緒（網頁要有跨來源隔離才能多執行緒）
  USE_WEBGPU: true,               // 有 WebGPU 的瀏覽器用顯示晶片加速；遇到相容問題可設為 false
  DEBUG_PANEL: false,             // true 時在畫面下方顯示每個物體的追蹤編號與除錯數值
  FRAME_WIDTH: 640,               // 焦距以這個寬度的畫面為準
  MAX_FRAME_SIDE: 640,            // 鏡頭畫面縮到長邊這麼大再分析
  MAX_FPS: 15,                    // 分析迴圈最快每秒幾幀
  DETECTION_INTERVAL: 1,          // 每幀都真的辨識。用速度推算中間幀的話，手機一轉，框就留在沒有東西的地方（天空裡的腳踏車）
  DETECTION_MAX_GAP_SEC: 0.2,    // 兩次 YOLO 最多間隔幾秒；只有 WASM 的慢手機每秒僅 4 幀，3 幀才偵測一次 TTC 樣本不夠
  BLANK_FRAME_STD: 3.0,           // 畫面亮度標準差低於此值（鏡頭被遮住、掉幀）不送進 YOLO，物體由預測位置暫留
  DEPTH_ON_WASM: false,           // 沒有 WebGPU 的手機不跑深度模型：每秒只有 4 幀，要把運算留給碰撞偵測
  MOTION_ARROW_LENGTH: 70,
  CAMERA_VELOCITY_X_PX_S: 0.0,
  CAMERA_VELOCITY_Y_PX_S: 0.0,
  NMS_IOU: 0.7,                   // 與 Ultralytics 預設相同

  // 偵測類別：COCO 類別編號 → [英文名, 中文]
  TARGET_CLASSES: {
    person: "行人",
    bicycle: "腳踏車",
    car: "汽車",
    motorcycle: "機車",
    bus: "公車",
    truck: "卡車",
  },
  // 路上會擋路的東西一律說「障礙物」：使用者要知道的是有東西擋路，不是它叫什麼；類別認錯時也不會念出奇怪的話。
  // 馬桶、床、飛機這類路上不合理的類別完全不偵測（模型認錯時也不會出現）。
  OBSTACLE_CLASSES: ["chair", "bench", "dining table", "potted plant", "fire hydrant", "suitcase", "parking meter"],
  ANIMAL_CLASSES: { dog: "狗", cat: "貓" },
  // 建立新物體要達到的信心（已經在追蹤的物體信心低一點仍可延續）。太低的話手機上會滿畫面都是認錯的東西
  CLASS_CONF_THRESHOLDS: {
    person: 0.40,
    bicycle: 0.45,
    car: 0.45,
    motorcycle: 0.35,   // 機車速度快，要早一點認出來，門檻比其他車輛低
    bus: 0.50,
    truck: 0.50,
  },
  TRACK_INSTANT_CONF: 0.70,       // 信心這麼高才第一次看到就算數
  TRACK_CONFIRM_HITS: 3,          // 否則要連續看到這麼多次才算（一閃而過的雜訊不會變成物體）
  MIN_BOX_HEIGHT_RATIO: 0.05,     // 比畫面高度的這個比例還矮的框不算：太遠用不到，而且大多是誤判
  GROUND_MIN_FOOT_RATIO: 0.35,    // 地面上的東西，底邊不會在畫面最上面這個比例內（天空裡的腳踏車）

  // ---------- 追蹤（ByteTrack 精簡版）----------
  TRACK_NEW_CONF: 0.60,           // 上面沒有列出的類別（椅子、狗等）：要這麼高的信心才建立新物體
  TRACK_LOW_CONF: 0.10,           // 已追蹤的物體信心度低到此值仍可延續（第二階段配對）
  TRACK_BUFFER_FRAMES: 30,        // 遺失的軌跡保留幾次偵測
  TRACK_MATCH_THRESH: 0.8,
  TRACK_LOST_HOLD_SEC: 0.5,       // YOLO 沒回傳某物體時，用預測位置在畫面上暫留多久

  // ---------- 單眼相機距離估算 ----------
  CAMERA_HEIGHT_CM: 120.0,
  PERSON_REAL_HEIGHT_CM: 170.0,
  CAMERA_FOCAL_LENGTH_PX: 700.0,
  APPROACH_SPEED_THRESHOLD_CM_S: 3.0,
  DISTANCE_SMOOTH_ALPHA: 0.25,

  // ---------- 多線索距離估測 ----------
  RATIO_REFERENCE_DISTANCE_M: 2.0,
  CLASS_REAL_HEIGHT_CM: {
    person: 170.0,
    bicycle: 110.0,
    motorcycle: 120.0,
    car: 150.0,
    bus: 320.0,
    truck: 300.0,
  },
  FULL_VIEW_MASK_FILL: {
    person: 0.55,
    bicycle: 0.35,
    motorcycle: 0.45,
    car: 0.75,
    bus: 0.85,
    truck: 0.80,
  },
  OCCLUSION_RATIO: 0.6,
  TRUNCATION_MARGIN_PX: 12,
  TRUNCATED_BOTTOM_MIN_ORANGE: true,
  FUSION_WEIGHT_RATIO: 1.0,
  FUSION_WEIGHT_PINHOLE: 1.0,
  FUSION_WEIGHT_DEPTH: 0.4,       // 深度圖換算的公尺數近處偏遠，只當參考
 
  FUSION_UNRELIABLE_WEIGHT: 0.2,

  // ---------- 單眼深度估計（Depth Anything V2 Small，q4f16 版約 19 MB）----------
  // 不要用 model_quantized：在 WebGPU 上一次要好幾秒，結果都超過 DEPTH_MAX_AGE_SEC 被丟掉，等於沒有偵測
  DEPTH_ENABLED: true,
  DEPTH_MODEL_URL: new URL("../models/depth-anything-v2-small-q4f16.onnx", import.meta.url).href,
  DEPTH_INPUT_SIZE: 266,          // 送進深度模型的短邊（14 的倍數）；越小越快
  DEPTH_INPUT_SIZE_SLOW: 196,     // 手機算不及時改用這個大小
  DEPTH_INTERVAL: 3,
  DEPTH_MIN_INTERVAL_SEC: 0.7,    // 障礙物不會動，不必每幀都算；顯示晶片要留給碰撞偵測
  DEPTH_WARMUP_WAIT_SEC: 30,      // 開始偵測前最多等深度模型這麼久：第一次運算會佔住顯示晶片好幾秒，走到一半才發生就是沒有保護
  DEPTH_MAX_AGE_SEC: 2.5,         // 太短的話較慢的手機算完就已經過期，等於永遠沒有結果
 
  GROUND_STRIP_RATIO: 0.08,
  OVERHEAD_BAND_RATIO: 0.5,
  STATIC_NEAR_RATIO: 1.12,        // 逆深度比地面基準大幾倍算「夠近」；少量影像校準，請以實地測試調整
  STATIC_ALERT_DISTANCE_M: 2.0,
  STATIC_MIN_AREA_RATIO: 0.04,
  STATIC_CONFIRM_COUNT: 2,
  STATIC_RELEASE_SEC: 1.0,
  STATIC_TEXT: { overhead: "頭部高度障礙", obstacle: "前方障礙物" },
  STATIC_ALERT_TEXT: {
    overhead: "{dir}，頭上有障礙",
    obstacle: "{dir}，有障礙物",
  },

  // ---------- 相機自體運動補償（陀螺儀＋背景位移比對）----------
  CAMERA_MOTION_MODE: "auto",     // "auto" / "gyro" / "flow" / "none"
  GYRO_GAIN: 1.0,
  FLOW_WIDTH: 160,                // 背景位移在縮小的畫面上計算，節省運算
  FLOW_MAX_SHIFT: 12,             // 最多比對幾個（縮小後的）像素位移
  FLOW_MIN_BACKGROUND: 0.5,       // 背景（物體以外）佔畫面比例低於此值時不信任
  FLOW_MIN_CONTRAST: 1.5,         // 最佳位移的誤差要比平均誤差小這麼多倍才可信
  FLOW_DEADBAND_PX_S: 8.0,
  MOTION_AGREE_PX_S: 40.0,
  PATH_ADAPTIVE: true,
  PATH_ADAPT_SEC: 2.0,

  // ---------- 動態模糊判定 ----------
  BLUR_VAR_THRESHOLD: 120.0,
  ELONGATION_THRESHOLD: 1.6,
  MASK_STABILITY_JUMP_RATIO: 0.5,
  MASK_MAX_REJECTS: 2,            // 連續幾次都不信任之後就接受：面積是真的變了，不能永遠沿用舊值
  ANALYSIS_TIMEOUT_MS: 20000,     // 一幀分析超過這個時間視為卡住（例如顯示晶片當掉），要告訴使用者
  MASK_MIN_CONTOUR_AREA: 90,
  MASK_QUALITY_MIN_RATIO: 0.25,
  RELEVANCE_MIN_OCCUPANCY_RATIO: 0.0015,
  GLOBAL_BLUR_SHARPEN_THRESHOLD: 150.0,
  SHARPEN_AMOUNT: 1.3,
  SHARPEN_SIGMA: 2.0,
  DEDUP_IOU_THRESHOLD: 0.5,

  // ---------- 危險狀態機（TTC）----------
  WARNING_OCCUPANCY_RATIO: 0.18,
  DEBOUNCE_ON_THRESHOLD: 2.0,
  EMA_ALPHA: 0.3,

  // ---------- 軌跡碰撞預測 ----------
  TRAJECTORY_HISTORY_LEN: 8,      // 最近幾次「真正偵測」（預測幀沒有新的框高資訊，不算樣本）
  TRAJECTORY_WINDOW_SEC: 1.0,
  TRAJECTORY_MIN_FRAMES: 3,
  TTC_MAX_CLAMP_SEC: 10,
  TTC_DANGER_SEC: 3.0,
  TTC_URGENT_SEC: 1.8,            // TTC 降至此值以下：語音改成「停」，警示音變長音。實測從這裡到語音發出約晚 0.3 秒，實際約剩 1.5 秒
  TTC_RELEASE_SEC: 1.0,           // 判定短暫閃斷多久內不算重新靠近，避免同一個人被一直喊「危險」
  // 以預測軌跡為主：外推後不在行走路徑上的物體，距離與速度風險打折，也不發「過近／速度過快」警報
  TRAJECTORY_FIRST: true,
  COURSE_HORIZON_SEC: 3.0,
  OFF_COURSE_RISK_SCALE: 0.5,
  TTC_WARNING_MULTIPLIER: 1.0,
  TTC_HOLD_FRAMES: 6,
  LOOMING_MIN_WIDTH_SHARE: 0.25,  // 框寬的成長率連框高的這個比例都不到，不算靠近
  TRUNCATED_NEAR_MIN_HEIGHT: 0.25, // 腳被切掉的物體，框至少有畫面這麼高才算偏近（鏡頭上仰時最下緣露出的一顆頭不算）
  OCCLUDED_OVERLAP_RATIO: 0.2,    // 框有這麼多被「站得更前面的物體」蓋住：看到的大小不可信，不拿來估靠近速度
  SCALE_JUMP_BASE: 0.15,          // 框高的 |ln(新/舊)| 超過 基準 + 每秒 × 間隔：不是真的靠近（追蹤換人、從遮擋後出現），舊軌跡作廢
  SCALE_JUMP_PER_SEC: 1.2,
  TTC_CLIPPED_HOLD_SEC: 3.0,      // 物體大到上下都超出畫面時已經量不到靠近速度：照最後的 TTC 倒數最多這麼久
  COLLISION_ZONE_RATIO: 0.35,
  // 腳底向量：落地點換算到地面，用地面上的相對速度向量判斷會不會撞上（斜向走來、交錯而來的人）
  GROUND_VECTOR_ENABLED: true,
  GROUND_HIT_RADIUS_M: 0.6,       // 預測最接近時離使用者不到這麼遠：算會撞上（兩個人的半個身寬加一點餘裕）
  GROUND_MIN_SPEED_M_S: 0.4,      // 相對速度比這個慢：分不出是在動還是框在抖，不算
  GROUND_MAX_RANGE_M: 12.0,       // 比這個遠的落地點不用：離地平線太近，差幾個像素就差好幾公尺
  GROUND_MIN_BELOW_PX: 20.0,      // 落地點至少在地平線下這麼多像素才換算
  GROUND_MIN_SAMPLES: 4,          // 至少幾次看得到腳的偵測
  GROUND_MIN_SPAN_SEC: 0.3,       // 這些偵測至少橫跨這麼久
  GROUND_MAX_STALE_SEC: 0.5,      // 最後一次看到腳已經是這麼久以前：不再用這些樣本推算
  GROUND_CONFIRM_HITS: 2,        // 連續幾次都判定會撞上才算，單一幀的抖動不算
  MIN_DH_DT_FOR_TTC: 15.0,
  RECEDING_MIN_RATE: 0.15,        // 框高每秒縮小超過這個比例才算遠離；用比例，近處的大框才不會因為抖動被當成遠離
  ATTENTION_GROWTH_PCT_S: 8.0,

  // ---------- 速度分級 ----------
  GROWTH_WALK_MAX_PCT_S: 15.0,
  GROWTH_RUN_MIN_PCT_S: 60.0,
  GROWTH_GAUGE_MAX_PCT_S: 150.0,
  LATERAL_MEDIUM_RATE: 1.5,
  LATERAL_FAST_RATE: 3.0,
  SPEED_LEVEL_TEXT: { slow: "慢速", medium: "中速", fast: "快速" },
  PERSON_SPEED_LEVEL_TEXT: { slow: "走路", medium: "小跑", fast: "跑步" },

  // ---------- 距離分級：綠（遠）→ 橙（偏近）→ 紅（過近）----------
  PROXIMITY_ORANGE_RATIO: 0.10,
  PROXIMITY_RED_RATIO: 0.25,
  PROXIMITY_CLASS_SCALE: {
    person: 1.0,
    bicycle: 1.1,
    motorcycle: 1.2,
    car: 1.8,
    truck: 2.5,
    bus: 2.5,
  },
  PROXIMITY_MAX_RATIO: 0.95,
  PROXIMITY_HYSTERESIS: 0.85,
  SPEED_HYSTERESIS: 0.8,

  // ---------- 過近／速度過快警報 ----------
  ALARM_RELEASE_HOLD_SEC: 1.5,
  ALARM_VOICE_REPEAT_SEC: 5.0,    // 物體持續紅色時，第一次重複提醒的間隔；之後每次加倍
  ALARM_VOICE_REPEAT_MAX_SEC: 60.0, // 重複提醒的間隔上限：站著排隊、跟人說話時不能一直念
  ALARM_SETTLED_SEC: 8.0,         // 同一個近物持續這麼久都沒有更靠近，就停掉警示音（語音仍會偶爾提醒）
  ALARM_PROGRESS_M: 0.3,          // 比這次警報中的最近距離再近這麼多，才算「又靠近了」，警示立刻恢復
  CLEAR_AFTER_SEC: 3.0,           // 警報結束這麼久才念「警報解除」，判定閃爍時不會一直解除又警報
  ALARM_VOICE_MIN_GAP_SEC: 2.0,
  ALARM_VOICE_GLOBAL_GAP_SEC: 1.5, // 不同類語音之間至少隔多久，誤報與嘮叨都會讓使用者不再信任警示
  SPEED_ALERT_MAX_TTC_SEC: 3.0,   // 朝使用者靠近的物體要 TTC 也認為快到了才報：遠處小目標的面積雜訊很大
  TOP_SCALE_MIN_PX: 30.0,         // 頭頂高於地平線至少這麼多像素，才用它當截斷時的尺度
  SPEED_ALERT_MAX_M: 8.0,         // 橫越的物體距離超過這個值不報（遠處橫越的車不會撞到人）
  SPEECH_RATE: 1.1,               // 瀏覽器語音速度（1 為正常）
  TTC_ALERT_TEXT: "危險，{dir}{obj}",
  PROXIMITY_ALERT_TEXT: "{obj}很近",
  SPEED_ALERT_TEXT: "{obj}很快",
  LATERAL_ALERT_TEXT: "{obj}橫越",
  TTC_URGENT_ALERT_TEXT: "停，{dir}{obj}",
  CLEAR_TEXT: "警報解除",
  STATIC_UNAVAILABLE_TEXT: "頭部高度障礙偵測無法使用，只會提醒行人與車輛",
  SCENE_EMPTY_TEXT: "目前沒有偵測到物體",
  SCENE_MAX_ITEMS: 3,             // 「目前狀況」最多念幾個物體

  // ---------- 警示音：倒車雷達模式 ----------
  BEEP_FREQ_HZ: 1000,
  BEEP_NEAR_M: 2.0,
  BEEP_CLOSE_M: 1.0,
  BEEP_RHYTHM: {                  // [響聲毫秒, 間隔毫秒]
    far: [120, 650],
    near: [120, 200],
    close: [450, 30],
  },
  SPEECH_PRIORITY: { info: 0, speed: 1, proximity: 2, static: 2, ttc: 3, urgent: 4 },

  // ---------- 低幀率提醒 ----------
  MIN_SAFE_FPS: 3.0,
  LOW_FPS_HOLD_SEC: 3.0,
  LOW_FPS_VOICE_AFTER_SEC: 10.0,  // 持續慢這麼久才開口：短暫卡頓不打擾使用者
  LOW_FPS_REPEAT_SEC: 300.0,      // 語音最多這麼久講一次
  LOW_FPS_TEXT: "偵測變慢，警報可能較晚",   // 只說明狀況：變慢是系統的事，不要求使用者改變走路方式

  // ---------- 狀態提示音 ----------
  STATUS_TONE_ENABLED: true,
  STATUS_TONE_SEC: 10.0,
  RESUME_TEXT: "偵測已恢復",

  // ---------- 光線不足提醒 ----------
  LOW_LIGHT_MEAN: 45.0,
  LOW_LIGHT_HOLD_SEC: 2.0,
  LOW_LIGHT_REPEAT_SEC: 300.0,    // 光線不是使用者能改變的：夜間外出時最多每 5 分鐘說一次
  LOW_LIGHT_TEXT: "光線不足，偵測可能不準",
  // 看不到的人不會知道手指或包包擋住鏡頭：這跟天色暗不同，是使用者能處理的事，要明確說出來
  CAMERA_BLOCKED_MEAN: 12.0,      // 畫面平均亮度低於此值，視為鏡頭可能被擋住
  CAMERA_BLOCKED_REPEAT_SEC: 60.0, // 第一次重複的間隔，之後每次加倍，最多 5 分鐘
  CAMERA_BLOCKED_TEXT: "畫面全黑，鏡頭可能被擋住",

  // ---------- 碰撞風險 / 行人距離進度條 ----------
  PROBABILITY_ORANGE_PCT: 35.0,
  PROBABILITY_RED_PCT: 60.0,
  PROXIMITY_FULL_RATIO: 0.50,

  // ---------- 顏色 ----------
  LEVEL_COLORS: { GREEN: "#3CC850", ORANGE: "#FF8C00", RED: "#E53935" },
  STATIC_HAZARD_COLOR: "#9C5CD6",

  DIRECTION_TEXT: { left: "左前方", center: "正前方", right: "右前方" },
  PROXIMITY_TEXT: { GREEN: "較遠", ORANGE: "偏近", RED: "過近" },
  APPROACH_TEXT: { approaching: "靠近", receding: "遠離", stable: "穩定" },
};

// YOLO（COCO）類別，模型輸出的第幾個分數對應哪個類別
export const COCO_NAMES = ["person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
  "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis",
  "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange", "broccoli",
  "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv",
  "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book",
  "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"];

// 目前要偵測的類別：編號 → 英文名（看 settings.json 套用後的設定，所以每次都重新算）
export function targetClassIds() {
  const ids = new Map();
  COCO_NAMES.forEach((name, id) => {
    if (name in C.TARGET_CLASSES || name in C.ANIMAL_CLASSES || C.OBSTACLE_CLASSES.includes(name)) ids.set(id, name);
  });
  return ids;
}
export const classLabel = rawLabel => C.TARGET_CLASSES[rawLabel] ?? C.ANIMAL_CLASSES[rawLabel] ?? "障礙物";

// ============================================================
// 2. 套用 settings.json
// ============================================================
// 用 settings.json 覆寫上面的大寫設定。名稱打錯或型別不符時略過並警告，不會讓程式當掉。
export function applyUserSettings(data, target = C) {
  const warnings = [];
  for (const [key, value] of Object.entries(data || {})) {
    if (key.startsWith("_")) continue;            // 以底線開頭的欄位當作註解
    if (key !== key.toUpperCase() || !(key in target)) {
      warnings.push(`settings.json：不認得的設定「${key}」，已略過`);
      continue;
    }
    const old = target[key];
    const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
    if (isObj(old)) {
      if (!isObj(value)) {
        warnings.push(`settings.json：「${key}」應為物件，已略過`);
        continue;
      }
      target[key] = { ...old, ...value };
      continue;
    }
    if (typeof value !== typeof old || Array.isArray(value) !== Array.isArray(old)) {
      warnings.push(`settings.json：「${key}」型別應為 ${typeof old}，已略過`);
      continue;
    }
    target[key] = value;
  }
  return warnings;
}

export async function loadSettings(url = "settings.json") {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    return applyUserSettings(await res.json());
  } catch (e) {
    return [`settings.json 讀取失敗，改用預設值：${e.message || e}`];
  }
}

// 範本字串，例如 fmt("{dir}，{obj}很近", {dir: "左前方", obj: "行人"})
export function fmt(template, values) {
  return template.replace(/\{(\w+)\}/g, (_m, k) => (k in values ? values[k] : `{${k}}`));
}
