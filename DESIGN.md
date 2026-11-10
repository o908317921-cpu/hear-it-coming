---
name: 盲人尋道
description: 簡約暗色的操作說明式介面，只有「會撞上」時畫面才大聲
colors:
  bg: "#0F1113"
  surface: "#171A1D"
  surface-2: "#1F2327"
  line: "#2B3035"
  track: "#262B30"
  text: "#ECEEF0"
  text-2: "#C5CBD1"
  muted: "#98A1A9"
  primary: "#2D6CD2"
  primary-strong: "#255BB3"
  focus: "#8DB4F2"
  on-primary: "#FFFFFF"
  green: "#3CC850"
  orange: "#FF8C00"
  red: "#E53935"
  static: "#9C5CD6"
  green-text: "#8BE39A"
  orange-text: "#FFC37A"
  red-text: "#FFB4A8"
  green-wash: "rgba(60,200,80,.1)"
  orange-wash: "rgba(255,140,0,.12)"
  red-wash: "rgba(229,57,53,.12)"
typography:
  display:
    fontFamily: "system-ui, -apple-system, \"PingFang TC\", \"Noto Sans TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: "2.2rem"
    fontWeight: 700
    letterSpacing: ".06em"
  headline:
    fontFamily: "system-ui, -apple-system, \"PingFang TC\", \"Noto Sans TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: "1.6rem"
    fontWeight: 700
  title:
    fontFamily: "system-ui, -apple-system, \"PingFang TC\", \"Noto Sans TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: "1.35rem"
    fontWeight: 700
    letterSpacing: ".04em"
  value:
    fontFamily: "system-ui, -apple-system, \"PingFang TC\", \"Noto Sans TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: "1.2rem"
    fontWeight: 700
    lineHeight: 1.1
    fontFeature: "tnum"
  control:
    fontFamily: "system-ui, -apple-system, \"PingFang TC\", \"Noto Sans TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: "1rem"
    fontWeight: 600
  body:
    fontFamily: "system-ui, -apple-system, \"PingFang TC\", \"Noto Sans TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: "1.05rem"
    fontWeight: 400
    lineHeight: 1.7
  body-sm:
    fontFamily: "system-ui, -apple-system, \"PingFang TC\", \"Noto Sans TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: ".92rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "system-ui, -apple-system, \"PingFang TC\", \"Noto Sans TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: ".85rem"
    fontWeight: 400
  caption:
    fontFamily: "system-ui, -apple-system, \"PingFang TC\", \"Noto Sans TC\", \"Microsoft JhengHei\", sans-serif"
    fontSize: ".78rem"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  md: "12px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "10px"
  md: "12px"
  row: "14px"
  lg: "16px"
  edge-intro: "20px"
  stack-intro: "22px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.display}"
    rounded: "{rounded.md}"
    height: "36vh"
  button-primary-active:
    backgroundColor: "{colors.primary-strong}"
  button-scene:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.headline}"
    rounded: "{rounded.md}"
    height: "96px"
  button-scene-alert:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
  button-neutral:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: "64px"
  button-neutral-hover:
    backgroundColor: "{colors.track}"
  button-neutral-off:
    textColor: "{colors.muted}"
  status-pill:
    backgroundColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  banner-safe:
    backgroundColor: "{colors.green-wash}"
    textColor: "{colors.green-text}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "14px 16px"
  banner-warn:
    backgroundColor: "{colors.orange-wash}"
    textColor: "{colors.orange-text}"
  banner-red:
    backgroundColor: "{colors.red}"
    textColor: "{colors.on-primary}"
  banner-lost:
    backgroundColor: "{colors.red-wash}"
    textColor: "{colors.red-text}"
  banner-idle:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
  gauge-card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "0 14px"
  gauge-bar:
    backgroundColor: "{colors.track}"
    rounded: "{rounded.pill}"
    height: "8px"
---

# Design System: 盲人尋道

## Overview

**Creative North Star: "安靜的操作說明"**

畫面安靜得像一份操作說明，只有「會撞上」時才大聲。中性偏冷的近黑底、兩階深灰面、1px 細線分隔；沒有漸層、沒有發光、沒有投影。整個介面只有一個強調色（沉穩藍），給主要按鈕；紅、橘、綠、紫是安全語意，只在狀態上出現。

畫面是給評審與明眼協助者的輔助，聲音才是主介面，所以視覺從不搶戲：大按鈕位置固定、資訊以細線條列，唯一會動的是警報時紅色橫幅的亮度脈動。警報時「目前狀況」主按鈕自動退成描邊，讓紅色成為畫面上唯一的實心色塊。

**Key Characteristics:**
- 近黑底＋兩階深灰面，1px 細線分隔，平面無投影
- 單一強調色，只給主要按鈕
- 狀態色專用，不做裝飾
- 系統黑體，粗細只用 600／700
- 一種圓角（12px）貫穿所有區塊

## Colors

中性偏冷的灰階骨架，一抹沉穩藍，加上四個只屬於狀態的安全色。

### Primary
- **沉穩藍** (primary)：「開始偵測」與「目前狀況」的實心底色；按下與 hover 時轉為 **深沉穩藍** (primary-strong)。也用於文字選取底色與警報時主按鈕的 2px 內描邊。
- **淡藍焦點** (focus)：所有按鈕 `:focus-visible` 的 3px 外框（偏移 3px），只做焦點，不做填色。

### Neutral
- **近黑** (bg)：頁面底、頂部狀態列、底部固定按鈕列的底。
- **深灰面** (surface)：儀表卡、狀態膠囊、待機橫幅、QR 區塊。
- **次深灰面** (surface-2)：中性按鈕底。
- **細線灰** (line)：所有 1px 邊框與分隔線。
- **軌道灰** (track)：儀表條軌道，兼中性按鈕 hover 底。
- **主文字** (text)／**次文字** (text-2)／**弱化文字** (muted)：標題、內文、說明與關閉狀態的三階文字。

### 狀態色（安全語意）
- **安全綠** (green)、**提醒橘** (orange)、**危險紅** (red)：與 `js/config.js` 的 LEVEL_COLORS 同值，用於儀表填充、數值文字、狀態膠囊圓點與橫幅。
- **靜態障礙紫** (static)：與 STATIC_HAZARD_COLOR 同值，頭部高度障礙。
- **淡綠／淡橘／淡紅文字** (green-text / orange-text / red-text) 搭配 10–12% 的同色淡底 (\*-wash)：非實心狀態的橫幅與錯誤、提示文字。

### Named Rules
**The One Blue Rule.** 沉穩藍只出現在主要動作上（開始偵測、目前狀況）。其他按鈕一律是深灰面加細線。

**The Status-Only Rule.** 紅、橘、綠、紫只表示狀態，不得用於裝飾、品牌或控制項，包括「停止」按鈕。

**The Only Solid Red Rule.** 警報時畫面上只能有一個實心色塊：紅色橫幅。主按鈕同時退成深灰面＋2px 藍色內描邊，大小與位置不變。

## Typography

**Display / Body Font:** 系統黑體（system-ui → PingFang TC → Noto Sans TC → Microsoft JhengHei）

**Character:** 單一系統字族，離線 PWA 不載入字型；層次靠字級與 600／700 兩種粗細，不靠換字族。

### Hierarchy
- **Display**（700，2.2rem，字距 .06em）：只給「開始偵測」大按鈕。
- **Headline**（700，1.6rem）：「目前狀況」主按鈕。
- **Title**（700，1.35rem，字距 .04em）：狀態橫幅；品牌名稱同字級、字距 .02em。
- **Value**（700，1.2rem，行高 1.1，等寬數字）：儀表數值；19.2px 粗體屬大字，狀態色在深灰面上達 3:1 即可。
- **Control**（600，1–1.05rem）：中性按鈕、條列標題、QR 標題。
- **Body**（400，1.05rem，行高 1.7）：開場說明；**Body-sm**（.92rem，行高 1.6）：功能條列內文。
- **Label**（.85rem）：狀態膠囊、儀表標題、副標；**Caption**（.78–.8rem）：儀表細節、統計、限制聲明。

### Named Rules
**The 700 Ceiling Rule.** 粗細只用 600 與 700，不用 800 以上。

**The Tabular Numbers Rule.** 會跳動的數字（統計、碰撞風險）一律 `tabular-nums`，避免畫面抖動。

## Layout

單欄、手機直向優先。開始畫面置中最寬 520px，左右 20px、區塊間距 22px，順序固定：品牌、開始偵測（36vh）、錯誤訊息、語音試聽、兩欄設定、說明、細線條列、限制聲明。電腦（hover＋精確指標）上才顯示 QR 區塊，並以 `order` 移到品牌下方，只改視覺順序、不改讀螢幕順序。

偵測畫面：頂部 sticky 狀態列；內容左右 16px、間距 12px；4:3 影像（最高 58vh）、狀態橫幅、單卡三列儀表；底部固定按鈕列（三欄格、間距 10px，主按鈕跨滿一列），內容底部留 190px＋安全區避免被遮。橫向且寬 ≥700px 時改為 1.6fr／1fr 兩欄。所有固定元素都加上 `safe-area-inset`。

**The Fixed Controls Rule.** 大按鈕的大小、位置與順序是安全設計；任何改版不得移動它們。

## Elevation & Depth

完全平面。深度只靠底色階（bg → surface → surface-2）與 1px 細線表達，沒有投影、沒有漸層、沒有發光。`inset` box-shadow 只當作「第二條線」使用：失去保護的橫幅用雙線紅框，警報時主按鈕用 2px 藍色內描邊。

**The Flat Rule.** 不用外投影、光暈或漸層；需要強調時加一條線或換一階底色。

## Shapes

一種圓角：所有區塊、按鈕、影像框、橫幅、卡片都是 12px。完全圓角（999px）只給狀態膠囊與儀表條。分隔一律 1px 細線；條列是上下細線，不是卡片。

**The One Radius Rule.** 區塊一律 12px；不得混用其他圓角。

## Components

### Buttons
- **主要（開始偵測）：** 實心沉穩藍、白字、Display 字級、最小高度 36vh、無邊框；按下時縮至 .99 並轉深沉穩藍。停用時透明度 .6。
- **主要（目前狀況）：** 實心沉穩藍、Headline 字級、高 96px、跨滿底部列。警報時退成深灰面＋2px 藍色內描邊（見 The Only Solid Red Rule）。
- **中性：** 次深灰面、1px 細線、600 字重、高 56–64px；hover 轉軌道灰。`aria-pressed="false"` 時文字轉弱化灰。「停止」也是中性按鈕，防誤觸靠按兩次，不靠紅色。
- **焦點：** 3px 淡藍外框、偏移 3px。

### 狀態膠囊
深灰面、1px 細線、完全圓角，左側 8px 圓點以綠／橘／紅表示就緒、等待、錯誤；錯誤時邊框轉 60% 紅、文字轉淡紅。

### 狀態橫幅（招牌元件）
12px 圓角、Title 字級置中，五種狀態：安全（淡綠底＋淡綠字＋35% 綠框）、提醒（淡橘）、危險（實心紅、白字、1 秒亮度脈動 1.15）、失去保護（淡紅底＋雙線紅框，不閃爍）、待機（深灰面＋弱化字）。顏色以 .2s 過渡。

### 儀表卡
一張深灰面卡、左右 14px，三列以 1px 細線分隔。每列：Label 標題＋Value 數值（狀態色）、8px 完全圓角軌道條（填充色隨狀態，寬度與色 .3s 過渡）、Caption 細節。

### 細線條列
上下 1px 細線、每列 14px 上下內距；600 字重標題獨立一行，下接次文字內文。用於功能說明，取代卡片牆。

## Do's and Don'ts

### Do:
- **Do** 讓沉穩藍只出現在主要動作；其他控制項用深灰面＋1px 細線。
- **Do** 警報時讓紅色橫幅成為唯一實心色塊，主按鈕退成描邊。
- **Do** 所有區塊用 12px 圓角，分隔用 1px 細線。
- **Do** 字重只用 600／700；跳動數字用等寬數字。
- **Do** 在 `prefers-reduced-motion` 下關閉所有過渡與脈動。

### Don't:
- **Don't** 用放射漸層、發光按鈕或外投影。
- **Don't** 用彩色圓點卡片牆；功能說明用細線條列。
- **Don't** 把紅、橘、綠、紫用在狀態以外，包括「停止」按鈕。
- **Don't** 加入第二個強調色。
- **Don't** 用 800 以上的字重。
