const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
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

// ── 內建法規索引 ──────────────────────────────────────────────────
const BUILTIN_LAWS = [
  { LawName: "中華民國刑法", PCode: "C0000001", LawCategory: "刑事", LawLevel: "法律" },
  { LawName: "刑事訴訟法", PCode: "C0010001", LawCategory: "刑事", LawLevel: "法律" },
  { LawName: "民法", PCode: "B0000001", LawCategory: "民事", LawLevel: "法律" },
  { LawName: "民事訴訟法", PCode: "B0010001", LawCategory: "民事", LawLevel: "法律" },
  { LawName: "中華民國憲法", PCode: "A0000001", LawCategory: "憲法", LawLevel: "憲法" },
  { LawName: "行政程序法", PCode: "A0150056", LawCategory: "行政", LawLevel: "法律" },
  { LawName: "行政訴訟法", PCode: "A0030055", LawCategory: "行政", LawLevel: "法律" },
  { LawName: "行政罰法", PCode: "A0150061", LawCategory: "行政", LawLevel: "法律" },
  { LawName: "國家賠償法", PCode: "A0020056", LawCategory: "行政", LawLevel: "法律" },
  { LawName: "公司法", PCode: "J0080022", LawCategory: "商事", LawLevel: "法律" },
  { LawName: "票據法", PCode: "J0080003", LawCategory: "商事", LawLevel: "法律" },
  { LawName: "保險法", PCode: "J0040003", LawCategory: "商事", LawLevel: "法律" },
  { LawName: "勞動基準法", PCode: "N0030001", LawCategory: "勞工", LawLevel: "法律" },
  { LawName: "著作權法", PCode: "J0070017", LawCategory: "智財", LawLevel: "法律" },
  { LawName: "消費者保護法", PCode: "J0170001", LawCategory: "民事", LawLevel: "法律" },
  { LawName: "土地法", PCode: "D0060001", LawCategory: "地政", LawLevel: "法律" },
  { LawName: "家事事件法", PCode: "B0010013", LawCategory: "民事", LawLevel: "法律" },
  { LawName: "少年事件處理法", PCode: "C0010013", LawCategory: "刑事", LawLevel: "法律" },
  { LawName: "毒品危害防制條例", PCode: "C0000008", LawCategory: "刑事", LawLevel: "法律" },
  { LawName: "道路交通管理處罰條例", PCode: "D0080022", LawCategory: "行政", LawLevel: "法律" },
];

// 快取
const articleCache = {};

app.get("/api/law/search", async (req, res) => {
  try {
    const { kw } = req.query;
    if (!kw) return res.status(400).json({ error: "缺少關鍵字參數 kw" });
    const matched = BUILTIN_LAWS.filter(law => law.LawName.includes(kw));
    res.json({ Laws: matched });
  } catch (err) {
    res.status(502).json({ error: "搜尋失敗", detail: err.message });
  }
});

// ── 條文查詢（使用 jsdelivr CDN 取得 mojLawSplitJSON 資料）────────
app.get("/api/law/articles", async (req, res) => {
  try {
    const { pcode } = req.query;
    if (!pcode) return res.status(400).json({ error: "缺少 pcode 參數" });

    // 使用快取
    if (articleCache[pcode]) {
      return res.json({ Articles: articleCache[pcode] });
    }

    // jsdelivr 可以直接存取 GitHub 上的檔案，不受 CORS 限制
    const urls = [
      `https://cdn.jsdelivr.net/gh/kong0107/mojLawSplitJSON@main/FalVMingLing/${pcode}.json`,
      `https://cdn.jsdelivr.net/gh/kong0107/mojLawSplitJSON@arranged/FalVMingLing/${pcode}.json`,
    ];

    let data = null;
    for (const url of urls) {
      try {
        const r = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          timeout: 10000,
        });
        if (r.ok) { data = await r.json(); break; }
      } catch {}
    }

    if (!data) return res.status(404).json({ error: "找不到該法規條文" });

    // 解析條文（支援多種格式）
    let articles = [];

    if (Array.isArray(data.法規內容)) {
      for (const item of data.法規內容) {
        if (item.條號 && item.條文內容) {
          articles.push({
            ArticleNo: String(item.條號),
            ArticleContent: item.條文內容,
          });
        }
      }
    } else if (Array.isArray(data.articles)) {
      articles = data.articles.map(a => ({
        ArticleNo: String(a.number || a.ArticleNo || ""),
        ArticleContent: a.content || a.ArticleContent || "",
      }));
    } else if (Array.isArray(data)) {
      articles = data
        .filter(a => a.ArticleNo || a.條號)
        .map(a => ({
          ArticleNo: String(a.ArticleNo || a.條號 || ""),
          ArticleContent: a.ArticleContent || a.條文內容 || "",
        }));
    }

    if (articles.length === 0) {
      return res.status(404).json({ error: "無法解析條文格式" });
    }

    // 存入快取
    articleCache[pcode] = articles;
    res.json({ Articles: articles });

  } catch (err) {
    res.status(502).json({ error: "無法取得條文", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✓ Legal Proxy running on port ${PORT}`);
  console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
