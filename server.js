const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3001;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",").map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
}));

app.use(express.json());

app.get("/", (_, res) => res.json({ status: "ok", service: "Taiwan Legal API Proxy" }));

// ── 司法院裁判書 ──────────────────────────────────────────────────
app.get("/api/judgment/search", async (req, res) => {
  try {
    const { q, court, jtype, page = 1 } = req.query;
    if (!q) return res.status(400).json({ error: "缺少關鍵字參數 q" });
    const params = new URLSearchParams({ q, page });
    if (court) params.set("court", court);
    if (jtype) params.set("jtype", jtype);
    const upstream = await fetch(
      `https://judgment.judicial.gov.tw/FJUD/api/search?${params}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!upstream.ok) return res.status(upstream.status).json({ error: "司法院 API 回應錯誤" });
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: "無法連接司法院 API", detail: err.message });
  }
});

// ── 全國法規：使用官方 Open API 下載後快取 ────────────────────────
// 官方只提供整包下載，我們在 proxy 做快取與搜尋
let lawCache = null;
let cacheTime = 0;
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 小時更新一次

async function getLawList() {
  if (lawCache && Date.now() - cacheTime < CACHE_TTL) return lawCache;
  try {
    // 使用官方 Open API JSON 格式
    const res = await fetch("https://law.moj.gov.tw/api/Ch/Law/JSON", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.buffer();
    // 回傳的是 ZIP，解壓後是 JSON
    // 改用備用資料源
    throw new Error("需要解壓縮");
  } catch {
    // 備用：使用 GitHub 上的整理版資料
    const res = await fetch(
      "https://raw.githubusercontent.com/kong0107/mojLawSplitJSON/main/index.json",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    lawCache = await res.json();
    cacheTime = Date.now();
    return lawCache;
  }
}

// 搜尋法律名稱
app.get("/api/law/search", async (req, res) => {
  try {
    const { kw } = req.query;
    if (!kw) return res.status(400).json({ error: "缺少關鍵字參數 kw" });

    const list = await getLawList();
    const matched = list
      .filter(law => (law.name || law.LawName || "").includes(kw))
      .slice(0, 20)
      .map(law => ({
        LawName: law.name || law.LawName || "",
        PCode: law.pcode || law.PCode || "",
        LawCategory: law.category || law.LawCategory || "",
        LawLevel: law.level || law.LawLevel || "",
        LawModifiedDate: law.date || law.LawModifiedDate || "",
      }));

    res.json({ Laws: matched });
  } catch (err) {
    res.status(502).json({ error: "無法連接法規資料庫", detail: err.message });
  }
});

// 取得法律條文
app.get("/api/law/articles", async (req, res) => {
  try {
    const { pcode } = req.query;
    if (!pcode) return res.status(400).json({ error: "缺少 pcode 參數" });

    // 嘗試不同的 branch 路徑
    const urls = [
      `https://raw.githubusercontent.com/kong0107/mojLawSplitJSON/main/FalVMingLing/${pcode}.json`,
      `https://raw.githubusercontent.com/kong0107/mojLawSplitJSON/arranged/FalVMingLing/${pcode}.json`,
    ];

    let data = null;
    for (const url of urls) {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (r.ok) { data = await r.json(); break; }
    }

    if (!data) return res.status(404).json({ error: "找不到該法規條文" });

    // 解析不同格式
    let articles = [];
    if (data.法規內容) {
      articles = data.法規內容
        .filter(i => i.條號)
        .map(i => ({ ArticleNo: i.條號, ArticleContent: i.條文內容 || "" }));
    } else if (data.Articles) {
      articles = data.Articles.map(a => ({
        ArticleNo: a.ArticleNo || "",
        ArticleContent: a.ArticleContent || "",
      }));
    } else if (Array.isArray(data)) {
      articles = data.map(a => ({
        ArticleNo: a.ArticleNo || a.articleNo || a.number || "",
        ArticleContent: a.ArticleContent || a.content || "",
      }));
    }

    res.json({ Articles: articles });
  } catch (err) {
    res.status(502).json({ error: "無法取得條文", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✓ Legal Proxy running on port ${PORT}`);
  console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
