# 下載真實照片測試用的街景照片（Wikimedia Commons，可自由使用的授權）到 tests/field-photos/，
# 作者與授權記在 sources.json。照片不放進 git。用法：python tests/fetch_field_photos.py tests/field-photos
# 之後開 tests/field.html 用真實模型跑；搜尋結果會隨時間改變，檔名對應的照片可能不同，field.js 的人工標註要跟著檢查。
import json, sys, urllib.error, urllib.request, urllib.parse, os, re, time
out = sys.argv[1]
queries = {
 "light": ["pedestrian signal Taiwan", "pedestrian signal red man", "pedestrian signal green man", "traffic light intersection street", "Taipei traffic light", "pedestrian traffic light countdown"],
 "ground": ["curb sidewalk street", "stairs down outdoor steps", "outdoor staircase descending", "steps up sidewalk", "sidewalk curb edge road", "flat sidewalk pavement"],
 "cross": ["zebra crossing", "Taiwan zebra crossing", "crosswalk street view"],
}
UA = {"User-Agent": "test-image-fetch/1.0"}
def get(url):
  for k in range(6):
    try:
      return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
    except urllib.error.HTTPError as e:
      if e.code != 429: raise
      time.sleep(8 * (k + 1))
  raise RuntimeError("429 retries exhausted")
meta = []
seen = set()
for group, qs in queries.items():
  for q in qs:
    params = {"action":"query","format":"json","generator":"search","gsrnamespace":"6","gsrlimit":"6",
      "gsrsearch": q + " filetype:bitmap","prop":"imageinfo","iiprop":"url|size|extmetadata",
      "iiextmetadatafilter":"LicenseShortName|Artist","iiurlwidth":"640"}
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params)
    d = json.loads(get(url))
    for p in d.get("query", {}).get("pages", {}).values():
      ii = p["imageinfo"][0]; t = p["title"]
      if t in seen or ii["width"] < ii["height"] * 0.9 or not t.lower().endswith((".jpg", ".jpeg")): continue
      seen.add(t)
      name = f"{group}-{len(meta):02d}.jpg"
      try:
        data = get(ii.get("thumburl") or ii["url"])
      except Exception as e:
        print("skip", t, e); continue
      open(os.path.join(out, name), "wb").write(data)
      em = ii.get("extmetadata", {})
      meta.append({"file": name, "title": t, "license": em.get("LicenseShortName", {}).get("value", ""),
                   "artist": re.sub("<[^>]+>", "", em.get("Artist", {}).get("value", ""))[:80],
                   "source": ii.get("descriptionurl", ""), "query": q, "bytes": len(data)})
      time.sleep(1.5)
json.dump(meta, open(os.path.join(out, "sources.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(meta), "images,", sum(m["bytes"] for m in meta)//1024, "KB")
