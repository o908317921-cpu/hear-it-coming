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
  // 推算軌跡位置時，鏡頭轉動用「上次看到它之後實際累積的畫面位移」，不用「現在的轉動速度 × 經過時間」。
  // 走路時手機半步就換一次方向，漏抓一兩幀之後用現在的速度去乘，推算的框會跑到畫面另一邊，配不上就變成新的追蹤編號、
  // TTC 的歷史從零開始（模擬：每秒 4 幀的腳踏車警報晚 0.5～1.3 秒）
  TRACK_GMC_OFFSET: true,
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
  // 語音只在兩個獨立來源（框高針孔公式、深度圖）相差不到這個倍數時才念「約幾公尺」，否則不念數字
  DISTANCE_AGREE_RATIO: 1.3,
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
  STATIC_TEXT: { overhead: "頭部高度障礙", obstacle: "前方障礙物", level: "地面高低差" },
  STATIC_ALERT_TEXT: {
    overhead: "{dir}，頭上有障礙",
    obstacle: "{dir}，有障礙物",
    level: "{dir}，地面有高低差",
  },

  // ---------- 科展版：地面高低差（深度圖，見 js/scene.js）----------
  // 門檻用 54 張真實照片調過：鏡頭水平的照片零誤報、樓梯台階 7 張抓到 3 張（寧可漏報也不誤報），仍要實地測試
  STEP_ENABLED: true,
  STEP_SEARCH_TOP_RATIO: 0.35,    // 只看畫面這個高度以下（再上去大多是天空、建築）
  STEP_SEARCH_BOTTOM_RATIO: 0.95, // 最下緣幾列常有鏡頭邊緣的雜訊
  STEP_WINDOW_RATIO: 0.02,        // 幾列平均一次、往下幾列算一次坡度
  STEP_JUMP_RATIO: 2.5,           // 坡度比平常陡這麼多倍算邊緣（左右兩半都要超過；實測平地最多約 2.3 倍）
  STEP_NEAR_FRAC: 0.3,            // 只看逆深度超過最下面這麼多比例的列（太遠的背景不算）
  STEP_FLAT_RATIO: 0.25,          // 坡度不到平常的這個比例算「立起來的面」
  STEP_FLAT_RUN_RATIO: 0.04,      // 連續這麼多比例的列都是平台才算
  STEP_FLAT_NEAR_FRAC: 0.4,
  STEP_BANDS: 3,                  // 路徑切成幾條；每一條都要看到同一道邊緣（台階橫跨整條路，柱子、植物只佔一部分）
  STEP_SIDE_AGREE_RATIO: 0.2,     // 各條找到的邊緣，高度差不到畫面的這個比例才算同一道
  STEP_MIN_GROUND_GRADIENT: 0.6,  // 地面的坡度至少這麼明顯（整個畫面高度內逆深度變化幾倍），否則不是在看前方地面
  STEP_MAX_TILT: 0.35,            // 手機前後傾斜超過約 20 度（重力在鏡頭方向的分量）就不判斷：仰拍、俯拍時地面判斷不可靠
  STEP_ALERT_DISTANCE_M: 8.0,     // 邊緣比這個遠不報

  // ---------- 相機自體運動補償（陀螺儀＋背景位移比對）----------
  CAMERA_MOTION_MODE: "auto",     // "auto" / "gyro" / "flow" / "none"（實驗三「移除陀螺儀」= "flow"）
  // 實驗三（消融）的開關，平常都是 false；在 tests/video.html 的設定欄打開
  ABLATE_TRACKER: false,          // ByteTrack → 框重疊率貪婪配對
  ABLATE_LANDING: false,          // 不看預測落點
  ABLATE_GMC: false,              // 配對前不扣鏡頭轉動
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
  TRAJECTORY_HISTORY_LEN: 24,     // 最近幾次「真正偵測」（預測幀沒有新的框高資訊，不算樣本）；迫近率只用近 TRAJECTORY_WINDOW_SEC 秒
  TRAJECTORY_WINDOW_SEC: 1.0,
  TRAJECTORY_MIN_FRAMES: 3,
  TTC_MAX_CLAMP_SEC: 10,
  // 三級警示：TTC_DANGER_SEC 內「注意」→ TTC_WARN_SEC 內「危險」→ TTC_URGENT_SEC 內「停」
  TTC_DANGER_SEC: 3.0,
  TTC_WARN_SEC: 2.4,
  TTC_URGENT_SEC: 1.8,            // TTC 降至此值以下：語音改成「停」，警示音變長音。實測從這裡到語音發出約晚 0.3 秒，實際約剩 1.5 秒
  TTC_RELEASE_SEC: 1.0,           // 判定短暫閃斷多久內不算重新靠近，避免同一個人被一直喊「危險」
  // 以預測軌跡為主：外推後不在行走路徑上的物體，距離與速度風險打折，也不發「過近／速度過快」警報
  TRAJECTORY_FIRST: true,
  COURSE_HORIZON_SEC: 3.0,
  OFF_COURSE_RISK_SCALE: 0.5,
  TTC_WARNING_MULTIPLIER: 1.0,
  TTC_HOLD_FRAMES: 6,
  // TTC 暫留是給「這一幀量不到」用的（漏抓、預測幀、成長率剛好低於門檻）。這一幀明明量得到、
  // 而且量到的成長率連暫留倒數的一半都不到（或在變小）就是證據相反：不再暫留。
  // 往前走遠的人換了追蹤編號，前三個框剛好抖成在長大，一個假 TTC 被倒數 6 幀倒數到「停」（模擬：往前走遠誤報）
  TTC_HOLD_RELEASE_ON_CONTRADICTION: true,
  TTC_HOLD_CONTRADICT_RATIO: 0.5,
  // 剛出現的物體（追蹤不到 ZONE_MIN_SPAN_SEC）：「連續判定會撞上 N 次」只算這一幀真的量到 TTC 的（暫留倒數的那幾幀不算新證據）。
  // 剛出現的近距離物體，第三幀量到一個雜訊 TTC、下一幀暫留，原本就湊滿兩次喊「停」（模擬：往前走遠剩下的誤報）
  ZONE_HITS_MEASURED_ONLY: true,
  LOOMING_MIN_GROWTH_PX: 8,       // 回歸的時間窗內框高至少要長大這麼多像素（或下面的比例，取大者）才算靠近：比這個小就是抖動
  LOOMING_MIN_GROWTH_RATIO: 0.05,
  GROWTH_MAX_LOOMING_RATIO: 3.0,  // 面積變化率最多算到「框高成長率」的這麼多倍（真的靠近時是 2 倍）：框高沒在長大、只有面積跳動，是遮擋或框錯，不算「很快」
  LOOMING_MIN_WIDTH_SHARE: 0.25,  // 框寬的成長率連框高的這個比例都不到，不算靠近
  TRUNCATED_NEAR_MIN_HEIGHT: 0.25, // 腳被切掉的物體，框至少有畫面這麼高才算偏近（鏡頭上仰時最下緣露出的一顆頭不算）
  OCCLUDED_OVERLAP_RATIO: 0.2,    // 框有這麼多被「站得更前面的物體」蓋住：看到的大小不可信，不拿來估靠近速度
  SCALE_JUMP_BASE: 0.06,          // 框高的 |ln(新/舊)| 超過 基準 + 每秒 × 間隔：不是真的靠近（追蹤換人、從遮擋後出現），舊軌跡作廢
  SCALE_JUMP_PER_SEC: 1.2,
  WIDTH_JUMP_BASE: 0.3,           // 框寬的容許值比較鬆：走路時雙腿開合，框寬本來就會變
  SCALE_JUMP_CONFIRM: 3,          // 連續這麼多次都跳變才相信是真的變了；之前的跳變樣本直接丟掉
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
  GROUND_CONFIRM_SEC: 0.3,        // 而且要持續這麼久：連續兩幀用的幾乎是同一批樣本，一起抖錯不算確認
  // 錯身而過：預測「最接近時離使用者多遠」，推得愈遠愈不準，對方也還來得及自己閃開。
  // 還有 TTC_DANGER_SEC 秒才到時要落在 HIT_RADIUS_FAR_M 內才算會撞上，剩 TTC_URGENT_SEC 秒時放寬到 GROUND_HIT_RADIUS_M
  HIT_RADIUS_FAR_M: 0.4,
  // 連續判定會撞上至少這麼久才喊「危險」，且至少 ZONE_CONFIRM_MIN_HITS 次真的偵測（單一幀不算）。
  // 以秒計：原本數幀數（3／2／5 幀），每秒 4 幀的手機要等 3 倍久；每秒 10 幀時兩種寫法結果相同
  ZONE_CONFIRM_SEC: 0.2,
  ZONE_CONFIRM_SEC_URGENT: 0.1,   // 已經在「停」的範圍內：只多等一下
  ZONE_CONFIRM_MIN_HITS: 2,
  // 遠處的小框：框高差兩三個像素，算出來的 TTC 就差一倍，要連續更多次才算（機車在 20 公尺外不會因為雜訊就喊「停」）
  ZONE_FAR_HEIGHT_RATIO: 0.2,     // 框高不到畫面高度的這個比例算小框
  ZONE_CONFIRM_SEC_FAR: 0.4,
  ZONE_MIN_SPAN_SEC: 0.6,         // 剛看到的物體只有兩三個樣本，算出來的 TTC 是雜訊：至少追蹤這麼久才喊
  ZONE_MIN_SPAN_NEAR_SEC: 0.3,    // 已經很近的大框（突然從轉角出現的人）等不起，雜訊相對也小：只等這麼久
  ZONE_NEAR_HEIGHT_RATIO: 0.4,    // 框高超過畫面高度的這個比例算「很近」
  HIT_RADIUS_BODY_M: 0.3,         // 半徑裡已經算進去的半個身寬；比這個寬的物體（汽車）再往外加
  HIT_RELEASE_SCALE: 1.3,         // 已經判定會撞上之後，落點要超出半徑的這個倍數才解除，判定才不會在邊緣一閃一閃
  MIN_DH_DT_FOR_TTC: 15.0,
  // 實驗開關（預設關）：固定 15 px/s 會讓「很遠但很快」的小框（TTC ≤ h/15）永遠算不出 TTC。
  // 開啟後改用相對門檻：(dh/dt)/h ≥ TTC_FLOOR_REL（即 TTC ≤ 1/TTC_FLOOR_REL 秒），再加一個很小的絕對下限擋抖動
  // 模擬（其他修正都做完後）：一般 94→95%、加倍雜訊 71→73%、每秒 3 幀 68→70%，錯身、路邊等誤報不變，所以改成預設開
  TTC_FLOOR_NORMALIZED: true,
  TTC_FLOOR_REL: 0.125,
  TTC_FLOOR_ABS_MIN: 3.0,
  // 實驗開關（預設關，議會「minimal-core」）：TTC 改用 1/h 擬合斜率的單邊信賴下界（Sen 法），
  // 只有「連最樂觀的估計都說會在 N 秒內撞上」才算；取代 15 px/s 門檻與「長大幾像素」檢查
  TTC_LOWER_BOUND: false,
  TTC_LB_Z: 1.645,                // 單邊 95%
  // 實驗開關（預設關）：腳底向量只用來取消「錯身而過」的警報，不再自己產生 TTC
  GROUND_VETO_ONLY: false,
  // 實驗開關（預設關）：拿掉「連續判定一段時間才喊」的確認等待
  ZONE_CONFIRM_OFF: false,
  // 議會二（模擬：斜向切入 2→10/12、前方橫越誤報 3→0/12、沒調過的右側 20° 斜向 8→11/12）：
  // 落點改用「橫向位置 ÷ 框高」= 物體實際橫向距離 ÷ 物體實際高度，與距離、手機俯仰無關。
  // 會撞上的人方位固定、框越來越大，這個比值外推到撞上那一刻會接近 0；錯身 0.9 m 的人一直停在 0.9 ÷ 1.7 ≈ 0.53。
  // 算不出來（框被側邊切、上下都切）時退回原本的畫面像素外推。設成 false 就是舊版
  LANDING_SCALE_INVARIANT: true,
  // x/h 的橫向變化在等速時是嚴格的直線（X 隨時間線性變化），時間窗拉長不會有偏差、雜訊卻小很多（斜率雜訊約 ∝ 時間窗^1.5）。
  // 迫近率（1/h）也是直線但要跟著加速減速，所以維持 1 秒；落點的橫向擬合另外用這個較長的時間窗
  // 模擬：錯身 0.9 m 誤報 21→8/48（1.0 秒時外推的落點在 0.5～1.2 m 之間亂跳，半徑只有 0.6 m），斜向、腳踏車也略好
  SI_WINDOW_SEC: 1.5,
  // 框只被畫面左或右邊切到時，另一邊是真的：中心改用「真的那邊 − 半個身寬」（身寬用這條軌跡沒被切時的寬高比），
  // 這樣的樣本也能算落點。斜向切入的人常常就在畫面邊緣（方位約 22°，手機半視角約 25°）
  SI_SIDE_CUT_CORRECT: true,
  SI_DEFAULT_ASPECT: 0.35,        // 還沒看過完整的框時用的寬高比
  // 框貼著左/右邊、而且沒被切的那一邊正往畫面外移（方位角一直往外變）：是要走出畫面的錯身，不是撞上。
  // 真的會撞上的斜向來人方位角幾乎不變，框只會變大、內側邊往中間長（模擬：路邊站著的人 1.3 m 的誤報多半是這樣）
  SI_EXIT_VETO: true,
  SI_EXIT_WINDOW_SEC: 0.6,
  SI_EXIT_EDGE_PX_S: 15,           // 內側邊往外移超過這個速度（像素/秒，已扣掉手機轉動）才算在走出畫面
  // x/h 落點算得出來而且說「會錯開」時，腳底向量不能把它推翻成「會撞上」（腳底向量的錯身距離受手機俯仰影響大）。
  // x/h 算不出來（框被切掉等）時腳底向量照舊（模擬：錯身 0.9 m 剩下的誤報多半是這樣來的）
  SI_VETOES_GROUND: true,
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
  ALARM_MIN_TRACK_AGE_SEC: 0.4,   // 物體至少被追蹤這麼久才報「很近／很快」（「危險／停」另有自己的確認）
  ALARM_VOICE_MAX_SAYS: 2,        // 同一個近物沒有更靠近時最多念這麼多次（第一次＋提醒一次）；又靠近或換了物體會重新算
  ALARM_SETTLED_SEC: 8.0,         // 同一個近物持續這麼久都沒有更靠近，就停掉警示音（語音仍會偶爾提醒）
  ALARM_PROGRESS_M: 0.3,          // 比這次警報中的最近距離再近這麼多，才算「又靠近了」，警示立刻恢復
  CLEAR_AFTER_SEC: 3.0,           // 警報結束這麼久才念「警報解除」，判定閃爍時不會一直解除又警報
  ALARM_VOICE_MIN_GAP_SEC: 2.0,
  SAME_TEXT_GAP_SEC: 4.0,         // 一模一樣的句子至少隔這麼久才再念（一串人陸續經過時不會一直重複同一句）；「停」不受限
  BEEP_OFF_HOLD_SEC: 0.3,         // 前方已經沒有東西：這麼久之後警示音就停、念到一半的警報也切掉（只容許漏抓一兩幀）
  CLEAR_MIN_ALARM_SEC: 1.0,       // 危險至少持續這麼久，結束時才念「警報解除」；一閃而過的不用特地解除
  BEEP_DOWN_HOLD_SEC: 0.6,        // 警示音變急馬上變，要變緩或停下來得先穩定這麼久，判定在邊緣時才不會快慢快慢亂跳
  ALARM_VOICE_GLOBAL_GAP_SEC: 1.5, // 不同類語音之間至少隔多久，誤報與嘮叨都會讓使用者不再信任警示
  SPEED_ALERT_MAX_TTC_SEC: 3.0,   // 朝使用者靠近的物體要 TTC 也認為快到了才報：遠處小目標的面積雜訊很大
  TOP_SCALE_MIN_PX: 30.0,         // 頭頂高於地平線至少這麼多像素，才用它當截斷時的尺度
  SPEED_ALERT_MAX_M: 8.0,         // 橫越的物體距離超過這個值不報（遠處橫越的車不會撞到人）
  SPEECH_RATE: 1.1,               // 瀏覽器語音速度（1 為正常）
  TTC_NOTICE_TEXT: "注意，{dir}{obj}",
  TTC_ALERT_TEXT: "危險，{dir}{obj}",
  TTC_ALERT_SHORT_TEXT: "危險",       // 已經念過「注意，某方向某物」之後升級，只念一個詞
  TTC_URGENT_SHORT_TEXT: "停",
  TTC_ESCALATE_MIN_GAP_SEC: 0.8,  // 「注意」念出後至少隔這麼久才升級成「危險」；「停」不受限
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
  // ---------- 科展版：紅綠燈與斑馬線（見 js/scene.js）----------
  // 只說看到什麼燈，不說「可以過」：分不出行人號誌和車輛號誌，也看不到來車有沒有停
  SIGNAL_ENABLED: true,
  SIGNAL_MIN_CONF: 0.5,           // 實測：信心 0.45 的「燈」是紅色的救生圈箱；寧可漏掉也不要念錯
  SIGNAL_MAX_OFFSET_RATIO: 0.35,  // 燈的中心離行走路徑中線超過畫面寬度的這個比例不算（旁邊路口的燈）
  SIGNAL_MIN_HEIGHT_RATIO: 0.025, // 太小的燈顏色分不準
  // 真實照片：亮燈（尤其行人號誌的小人）只佔燈框 1～3%，中心還常常過曝成白色
  SIGNAL_MIN_VALUE: 0.35,         // 夠亮才算亮著的燈
  // 綠色要更亮才算：台灣號誌的燈殼漆成綠色（亮度約 0.4～0.5），會被當成綠燈（台灣照片 ped-070：小紅人被說成綠燈）。
  // 紅、黃不跟著提高：過曝的紅燈中心偏橘，邊緣暗紅的像素少掉就會被說成黃燈（red-114）
  SIGNAL_GREEN_MIN_VALUE: 0.5,
  SIGNAL_MIN_SAT: 0.35,
  SIGNAL_MIN_LIT_SHARE: 0.008,    // 亮燈的顏色至少佔框的這個比例（而且要是第二多顏色的 2 倍）
  // 行人號誌（LED 小綠人／小紅人，YOLO 認不得，見 scene.js pedestrianSignals）
  FIELDLOG_PERF_SEC: 10,          // 實測紀錄每幾秒記一次效能（實驗四）
  PED_ENABLED: true,
  PED_EVERY_N_FRAMES: 2,          // 每幾幀掃描一次（中間幀沿用上次結果）
  PED_TOP_RATIO: 1.0,             // 整個畫面都看（近看時號誌可能在畫面下半）
  PED_CELL: 4,                    // 每 4×4 像素算一格
  PED_GAP: 2,                     // LED 點之間的空隙：相隔 2 格以內算同一團
  PED_MIN_VALUE: 0.45,            // LED 很亮
  PED_MIN_SAT: 0.35,              // 而且很鮮豔
  PED_MIN_CELLS: 8,
  PED_MIN_ASPECT: 0.9,            // 小人比寬還高（倒數數字兩位數比較寬，下限 0.4）
  PED_MAX_ASPECT: 3.0,
  PED_MIN_FILL: 0.02,             // LED 是一顆顆的點：亮的像素只佔框的一小部分（整塊亮的是招牌）
  PED_MAX_FILL: 0.35,
  PED_MAX_DARK: 0.5,              // 點和點之間是黑色面板
  SIGNAL_CONFIRM_WINDOW: 6,
  SIGNAL_CONFIRM_HITS: 4,         // 最近 6 幀至少 4 幀同一個顏色才說
  SIGNAL_REPEAT_SEC: 20.0,        // 同一個燈號隔這麼久才再提醒（燈號改變時馬上說）
  SIGNAL_FORGET_SEC: 10.0,
  SIGNAL_TEXT: { red: "前方紅燈", yellow: "前方黃燈", green: "前方綠燈", ped_green: "前方行人綠燈", ped_red: "前方行人紅燈" },
  CROSSWALK_ENABLED: true,
  // 門檻用真實照片調過：標註的 13 張 11 張對，不是斑馬線的路面零誤報
  CROSSWALK_TOP_RATIO: 0.45,      // 只看畫面下面這一段地面
  CROSSWALK_WIDTH_RATIO: 0.6,
  CROSSWALK_MIN_CONTRAST: 45,     // 亮處與暗處的亮度差
  CROSSWALK_MAX_SAT: 0.25,        // 白漆不鮮豔
  CROSSWALK_LOCAL: true,          // 白漆要比同一欄上下附近的路面亮（見 scene.js crosswalkStripes）
  CROSSWALK_LOCAL_RADIUS: 0.15,   // 上下各看「看的範圍高度 × 這個比例」
  CROSSWALK_LOCAL_MARGIN: 0.2,    // 至少比附近平均亮這麼多（× 整塊的亮暗差）
  CROSSWALK_LOCAL_FLOOR: 0.4,     // 而且本身不能太暗（× 整塊的亮暗差）
  CROSSWALK_MIN_WIDTH_RATIO: 0.15, // 一條白漆至少有看的範圍這麼寬（改用上下比較亮度後從 0.2 放寬，真實照片多認出 1 張、誤報不變）
  CROSSWALK_MAX_ASPECT: 0.35,     // 而且要扁（高不到寬的這個比例）
  CROSSWALK_MIN_STRIPES: 3,       // 而且這幾條要符合透視：由上往下每條都比上一條粗、寬度差不到 2 倍
  CROSSWALK_GROW_MIN: 1.05,
  // 只在深度圖確認前方是平地時才判斷（樓梯的踏面看起來就像白色橫條）；沒有深度模型的手機不報斑馬線
  CROSSWALK_CONFIRM_WINDOW: 15,
  CROSSWALK_CONFIRM_HITS: 10,
  CROSSWALK_REPEAT_SEC: 30.0,
  CROSSWALK_TEXT: "前方有斑馬線",

  SPEECH_PRIORITY: { scene: 0.5, info: 0, speed: 1, proximity: 2, static: 2, notice: 2.5, ttc: 3, urgent: 4 },

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
  // 畫面上的框：綠＝安全，黃＝注意，橙＝危險（或擋在路上很近），紅＝停
  ALERT_COLORS: { SAFE: "#3CC850", NOTICE: "#FFD400", DANGER: "#FF8C00", STOP: "#E53935" },
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
    if (name in C.TARGET_CLASSES || name in C.ANIMAL_CLASSES || C.OBSTACLE_CLASSES.includes(name)
        || (name === "traffic light" && C.SIGNAL_ENABLED)) ids.set(id, name);
  });
  return ids;
}
export const classLabel = rawLabel => C.TARGET_CLASSES[rawLabel] ?? C.ANIMAL_CLASSES[rawLabel] ?? "障礙物";

// ============================================================
// 2. 套用 settings.json
// ============================================================
// 用 settings.json 覆寫上面的大寫設定。名稱打錯或型別不符時略過並警告，不會讓程式當掉。
// 威脅模型 R02：settings.json 是遠端檔案，改了就悄悄生效。安全相關的門檻只接受合理範圍內的值，
// 模型網址只接受同一個網站，消融實驗開關不能從這裡打開；實際改到的設定記在 SETTINGS_OVERRIDES，開始偵測時念出來
export const SAFE_RANGES = {
  TTC_DANGER_SEC: [2, 5], TTC_WARN_SEC: [1.5, 4], TTC_URGENT_SEC: [1, 3], COLLISION_ZONE_RATIO: [0.2, 0.6],
  GROUND_HIT_RADIUS_M: [0.4, 1.0], HIT_RADIUS_FAR_M: [0.3, 0.8], MIN_DH_DT_FOR_TTC: [5, 30],
  ZONE_CONFIRM_SEC: [0, 0.5], ZONE_CONFIRM_SEC_URGENT: [0, 0.3], ZONE_CONFIRM_SEC_FAR: [0, 0.8], ZONE_CONFIRM_MIN_HITS: [1, 4],
  TTC_HOLD_FRAMES: [0, 10], SPEECH_RATE: [0.7, 1.6], ALARM_VOICE_REPEAT_SEC: [2, 10], CAMERA_HEIGHT_CM: [60, 180],
  CAMERA_FOCAL_LENGTH_PX: [300, 2000], STATIC_NEAR_RATIO: [1.02, 1.5], PROXIMITY_ORANGE_RATIO: [0.03, 0.3], PROXIMITY_RED_RATIO: [0.1, 0.6],
};
export const SETTINGS_OVERRIDES = [];
function sameOriginUrl(value) {
  try {
    const base = globalThis.location?.href;
    return !base || new URL(value, base).origin === new URL(base).origin;
  } catch (e) {
    return false;
  }
}

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
    if (key.startsWith("ABLATE_") && value) {
      warnings.push(`settings.json：「${key}」是離線實驗用的開關，不能從這裡打開，已略過`);
      continue;
    }
    if (key.endsWith("_URL") && !sameOriginUrl(value)) {
      warnings.push(`settings.json：「${key}」只能指向這個網站上的檔案，已略過`);
      continue;
    }
    const range = SAFE_RANGES[key];
    if (range && !(value >= range[0] && value <= range[1])) {
      warnings.push(`settings.json：「${key}」要在 ${range[0]}～${range[1]} 之間，已略過`);
      continue;
    }
    if (target === C && value !== old) SETTINGS_OVERRIDES.push(key);
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
