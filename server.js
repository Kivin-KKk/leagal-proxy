const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
}));

app.use(express.json());

// ── 健康檢查 ─────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({ status: "ok", service: "Taiwan Legal API Proxy" }));

// ════════════════════════════════════════════════════════════════
// 司法院裁判書 FJUD API
// ════════════════════════════════════════════════════════════════
const FJUD_BASE = "https://judgment.judicial.gov.tw/FJUD/api";

app.get("/api/judgment/search", async (req, res) => {
  try {
    const { q, court, jtype, page = 1 } = req.query;
    if (!q) return res.status(400).json({ error: "缺少關鍵字參數 q" });

    const params = new URLSearchParams({ q, page });
    if (court) params.set("court", court);
    if (jtype) params.set("jtype", jtype);

    const upstream = await fetch(`${FJUD_BASE}/search?${params}`, {
      headers: { "User-Agent": "Mozilla/5.0 (legal-proxy/1.0)" },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "司法院 API 回應錯誤" });
    }

    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    console.error("[FJUD search]", err.message);
    res.status(502).json({ error: "無法連接司法院 API", detail: err.message });
  }
});

app.get("/api/judgment/detail", async (req, res) => {
  try {
    const { jid } = req.query;
    if (!jid) return res.status(400).json({ error: "缺少 jid 參數" });

    const upstream = await fetch(`${FJUD_BASE}/getjud?jid=${encodeURIComponent(jid)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (legal-proxy/1.0)" },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "司法院 API 回應錯誤" });
    }

    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    console.error("[FJUD detail]", err.message);
    res.status(502).json({ error: "無法取得裁判書全文", detail: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 全國法規資料庫（使用 GitHub mojLawSplitJSON 開放資料）
// ════════════════════════════════════════════════════════════════
const LAW_RAW = "https://raw.githubusercontent.com/kong0107/mojLawSplitJSON/arranged";

app.get("/api/law/search", async (req, res) => {
  try {
    const { kw } = req.query;
    if (!kw) return res.status(400).json({ error: "缺少關鍵字參數 kw" });

    const upstream = await fetch(`${LAW_RAW}/index.json`, {
      headers: { "User-Agent": "Mozilla/5.0 (legal-proxy/1.0)" },
    });

    if (!upstream.ok) return res.status(502).json({ error: "法規資料庫回應錯誤" });

    const list = await upstream.json();
    const keyword = kw.toLowerCase();

    const matched = list
      .filter(law => law.name && law.name.includes(keyword))
      .slice(0, 20)
      .map(law => ({
        LawName: law.name,
        PCode: law.pcode,
        LawCategory: law.category || "",
        LawLevel: law.level || "",
        LawModifiedDate: law.date || "",
      }));

    res.json({ Laws: matched });
  } catch (err) {
    console.error("[LAW search]", err.message);
    res.status(502).json({ error: "無法連接法規資料庫", detail: err.message });
  }
});

app.get("/api/law/articles", async (req, res) => {
  try {
    const { pcode } = req.query;
    if (!pcode) return res.status(400).json({ error: "缺少 pcode 參數" });

    const upstream = await fetch(
      `${LAW_RAW}/FalVMingLing/${encodeURIComponent(pcode)}.json`,
      { headers: { "User-Agent": "Mozilla/5.0 (legal-proxy/1.0)" } }
    );

    if (!upstream.ok) return res.status(upstream.status).json({ error: "法規資料庫回應錯誤" });

    const data = await upstream.json();

    const articles = (data?.法規內容 || [])
      .filter(item => item.條號)
      .map(item => ({
        ArticleNo: item.條號,
        ArticleContent: item.條文內容 || "",
      }));

    res.json({ Articles: articles });
  } catch (err) {
    console.error("[LAW articles]", err.message);
    res.status(502).json({ error: "無法取得條文", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✓ Legal Proxy running on port ${PORT}`);
  console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
