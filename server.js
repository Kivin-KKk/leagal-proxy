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
const FJUD_BASE = "https://judgment.judicial.gov.tw/FJUD/api";

app.get("/api/judgment/search", async (req, res) => {
  try {
    const { q, court, jtype, page = 1 } = req.query;
    if (!q) return res.status(400).json({ error: "缺少關鍵字參數 q" });
    const params = new URLSearchParams({ q, page });
    if (court) params.set("court", court);
    if (jtype) params.set("jtype", jtype);
    const upstream = await fetch(`${FJUD_BASE}/search?${params}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: "司法院 API 回應錯誤" });
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: "無法連接司法院 API", detail: err.message });
  }
});

// ── 全國法規資料庫 Open API（官方新版）────────────────────────────
// 文件：https://law.moj.gov.tw/api/swagger/ui/index
const LAW_OPEN = "https://law.moj.gov.tw/api/swagger/docs/v1/laws";

// 搜尋法律
app.get("/api/law/search", async (req, res) => {
  try {
    const { kw } = req.query;
    if (!kw) return res.status(400).json({ error: "缺少關鍵字參數 kw" });

    const url = `https://law.moj.gov.tw/api/swagger/docs/v1/laws?Keyword=${encodeURIComponent(kw)}&PageSize=20&PageIndex=1`;
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
      },
    });

    if (!upstream.ok) return res.status(upstream.status).json({ error: "法規資料庫回應錯誤", code: upstream.status });

    const data = await upstream.json();

    // 轉換為前端需要的格式
    const laws = (data?.Laws || data?.laws || data || []);
    const mapped = Array.isArray(laws) ? laws.map(law => ({
      LawName: law.LawName || law.lawName || law.name || "",
      PCode: law.PCode || law.pCode || law.pcode || "",
      LawCategory: law.LawCategory || law.category || "",
      LawLevel: law.LawLevel || law.level || "",
      LawModifiedDate: law.LawModifiedDate || law.date || "",
    })) : [];

    res.json({ Laws: mapped });
  } catch (err) {
    res.status(502).json({ error: "無法連接法規資料庫", detail: err.message });
  }
});

// 取得法律條文
app.get("/api/law/articles", async (req, res) => {
  try {
    const { pcode } = req.query;
    if (!pcode) return res.status(400).json({ error: "缺少 pcode 參數" });

    const url = `https://law.moj.gov.tw/api/swagger/docs/v1/laws/${encodeURIComponent(pcode)}/articles`;
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
      },
    });

    if (!upstream.ok) return res.status(upstream.status).json({ error: "法規資料庫回應錯誤" });

    const data = await upstream.json();
    const articles = (data?.Articles || data?.articles || []).map(a => ({
      ArticleNo: a.ArticleNo || a.articleNo || a.number || "",
      ArticleContent: a.ArticleContent || a.articleContent || a.content || "",
    }));

    res.json({ Articles: articles });
  } catch (err) {
    res.status(502).json({ error: "無法取得條文", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✓ Legal Proxy running on port ${PORT}`);
  console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
