---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: []
---

# 盲人尋道 手機網頁（index.html）

範圍：開始畫面＋偵測畫面，一個檔案。模式：Operate。建置：code-led（Operate 介面；本機也沒有生圖工具）。

觀眾與任務：全盲使用者靠聲音操作，不看畫面；會看畫面的是科展評審（展示時看懂系統在判斷什麼）與明眼協助者（開網頁、調設定、在電腦上掃 QR code）。

限制：說明文字一字不改；按鈕大小、位置、DOM 與讀螢幕順序不變；紅／橘／綠／紫是安全語意色，只能用在狀態上；語音、aria、提示音不動。

使用者指定方向（2026-11-08）：去掉 AI 感、改成簡約暗色；標誌換成聲波圖示；只留一個清楚的強調色給主要按鈕；功能卡片改成細線分隔的列表。

## Direction contract

THESIS：畫面安靜得像一份操作說明，只有「會撞上」時才大聲。拒絕這類 App 的預設：放射漸層、發光按鈕、彩色圓點卡片牆。

OWN-WORLD：中性偏冷的近黑底與兩階深灰面、細線分隔、無陰影無漸層；唯一強調色是無障礙標誌的沉穩藍，只給主要按鈕；紅橘綠紫只在狀態出現。系統黑體，粗細 600／700，不用 800 以上。

STORY：評審一眼看到該按哪裡、現在是否在保護、危險時畫面只剩紅色在說話；協助者在電腦上直接掃 QR code。

FIRST VIEWPORT：開始畫面＝聲波標誌＋名稱一行，下方整塊藍色「開始偵測」（36vh），其下語音試聽與兩個設定，再下面是細線條列的功能說明與限制聲明。偵測畫面＝狀態列、4:3 影像、狀態橫幅、單卡三列儀表、底部固定按鈕列。

FORM：使用者指定的方向（簡約暗色），沒有擲骰。招牌動作：警報時「目前狀況」主按鈕自動退成描邊，讓紅色橫幅成為畫面上唯一的實心色塊。seed: none (direction pinned by user; no roll)

FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
