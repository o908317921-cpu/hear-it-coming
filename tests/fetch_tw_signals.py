# 下載台灣紅綠燈照片（Wikimedia Commons，可自由使用的授權）到 tests/field-photos-tw/，作者與授權記在 sources.json。
# 照片不放進 git。用法：python tests/fetch_tw_signals.py tests/field-photos-tw
# 依 Commons 分類抓：分類名稱就是粗略的答案（紅燈／綠燈／行人號誌），記在 sources.json 的 category 欄位。
# 分類裡大多是車用號誌，行人號誌要另外人工確認（tests/tw-labels.json）。
import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
CATEGORIES = {   # 分類 → 最多抓幾張
    "Category:Pedestrian signals in Taiwan": 200,
    "Category:Traffic lights at red state in Taiwan": 120,
    "Category:Traffic lights at green state in Taiwan": 120,
}
UA = {"User-Agent": "test-image-fetch/1.0"}

def get(url):
    for k in range(8):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503): raise
            time.sleep(10 * (k + 1))      # 太快會被擋：等久一點再試
    raise RuntimeError("retries exhausted")

def api(**p):
    p.update(action="query", format="json")
    return json.loads(get("https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(p)))

meta_path = os.path.join(out, "sources.json")
meta = json.load(open(meta_path, encoding="utf-8")) if os.path.exists(meta_path) else []
seen = {m["title"] for m in meta}      # 中斷後重跑會接著抓，不重複
for cat, limit in CATEGORIES.items():
    short = "ped" if "Pedestrian" in cat else ("red" if "red" in cat else "green")
    got = sum(1 for m in meta if m["category"] == cat)
    cont = {}
    while got < limit:
        d = api(generator="categorymembers", gcmtitle=cat, gcmtype="file", gcmlimit="50", prop="imageinfo",
                iiprop="url|size|extmetadata", iiextmetadatafilter="LicenseShortName|Artist", iiurlwidth="640", **cont)
        for p in sorted(d.get("query", {}).get("pages", {}).values(), key=lambda p: p["title"]):
            if got >= limit: break
            t = p["title"]; ii = p.get("imageinfo", [{}])[0]
            if t in seen or not t.lower().endswith((".jpg", ".jpeg")) or not ii.get("thumburl"): continue
            seen.add(t)
            try:
                data = get(ii["thumburl"])
            except Exception as e:
                print("skip", t, e); continue
            name = f"{short}-{got:03d}.jpg"
            open(os.path.join(out, name), "wb").write(data)
            em = ii.get("extmetadata", {})
            meta.append({"file": name, "title": t, "category": cat,
                         "license": em.get("LicenseShortName", {}).get("value", ""),
                         "artist": re.sub("<[^>]+>", "", em.get("Artist", {}).get("value", ""))[:80],
                         "source": ii.get("descriptionurl", ""), "bytes": len(data)})
            got += 1
            json.dump(meta, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            time.sleep(2)
        if "continue" not in d: break
        cont = {"gcmcontinue": d["continue"]["gcmcontinue"]}
    print(cat, got, flush=True)
print(len(meta), "images,", sum(m["bytes"] for m in meta) // 1024, "KB")
