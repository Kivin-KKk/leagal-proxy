const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

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

// ── 讀取內建法規 JSON 檔案 ────────────────────────────────────────
const lawsDir = path.join(__dirname, "laws");
const lawCache = {};

function loadLaw(pcode) {
  if (lawCache[pcode]) return lawCache[pcode];
  const filePath = path.join(lawsDir, `${pcode}.json`);
  if (!fs.existsSync(filePath)) return null;
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  lawCache[pcode] = data;
  return data;
}

// ── 內建法規索引 ──────────────────────────────────────────────────
const BUILTIN_LAWS = [
  { LawName: "民法", PCode: "B0000001", LawCategory: "民事", LawLevel: "法律", LawVersion: "民國110年1月19日修正" },
  { LawName: "中華民國刑法", PCode: "C0000001", LawCategory: "刑事", LawLevel: "法律" },
  { LawName: "刑事訴訟法", PCode: "C0010001", LawCategory: "刑事", LawLevel: "法律" },
  { LawName: "民事訴訟法", PCode: "B0010001", LawCategory: "民事", LawLevel: "法律" },
  { LawName: "中華民國憲法", PCode: "A0000001", LawCategory: "憲法", LawLevel: "憲法" },
  { LawName: "行政程序法", PCode: "A0150056", LawCategory: "行政", LawLevel: "法律" },
  { LawName: "行政訴訟法", PCode: "A0030055", LawCategory: "行政", LawLevel: "法律" },
  { LawName: "行政罰法", PCode: "A0150061", LawCategory: "行政", LawLevel: "法律" },
  { LawName: "國家賠償法", PCode: "A0020056", LawCategory: "行政", LawLevel: "法律" },
  { LawName: "公司法", PCode: "J0080022", LawCategory: "商事", LawLevel: "法律" },
  { LawName: "勞動基準法", PCode: "N0030001", LawCategory: "勞工", LawLevel: "法律" },
  { LawName: "著作權法", PCode: "J0070017", LawCategory: "智財", LawLevel: "法律" },
  { LawName: "消費者保護法", PCode: "J0170001", LawCategory: "民事", LawLevel: "法律" },
];

app.get("/api/law/search", (req, res) => {
  const { kw } = req.query;
  if (!kw) return res.status(400).json({ error: "缺少關鍵字參數 kw" });
  const matched = BUILTIN_LAWS.filter(law => law.LawName.includes(kw));
  res.json({ Laws: matched });
});

// ── 條文查詢（優先讀本地 JSON，否則提示）────────────────────────
app.get("/api/law/articles", (req, res) => {
  const { pcode } = req.query;
  if (!pcode) return res.status(400).json({ error: "缺少 pcode 參數" });

  const data = loadLaw(pcode);

  if (!data) {
    return res.status(404).json({
      error: "此法規尚未收錄，請使用 AI 問答功能查詢",
      LawVersion: null,
      Articles: []
    });
  }

  res.json({
    LawName: data.LawName,
    LawVersion: data.LawVersion || "",
    Articles: data.Articles || []
  });
});

// ── 司法院裁判書 ──────────────────────────────────────────────────
const fetch = require("node-fetch");

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

app.listen(PORT, () => {
  console.log(`✓ Legal Proxy running on port ${PORT}`);
  console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
