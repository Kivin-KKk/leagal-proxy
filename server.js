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

// ── 條文查詢（使用全國法規資料庫 XML API 解析）────────────────────
app.get("/api/law/articles", async (req, res) => {
  try {
    const { pcode } = req.query;
    if (!pcode) return res.status(400).json({ error: "缺少 pcode 參數" });

    // 使用官方 XML API 下載整部法規
    const xmlUrl = `https://law.moj.gov.tw/api/Ch/Law/XML`;
    // 改用直接下載單一法規 XML
    const singleUrl = `https://law.moj.gov.tw/LawClass/LawGetFile.ashx?FileType=XML&FLNO=&Pcode=${pcode}`;
    
    const r = await fetch(singleUrl, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "application/xml, text/xml, */*",
        "Referer": "https://law.moj.gov.tw/"
      }
    });

    if (!r.ok) return res.status(r.status).json({ error: `法規下載失敗 ${r.status}` });

    const xml = await r.text();
    const articles = [];

    // 解析 XML 中的條文
    // 格式：<Article><ArticleNo>1</ArticleNo><ArticleContent>...</ArticleContent></Article>
    const artRegex = /<Article>([\s\S]*?)<\/Article>/gi;
    let match;
    while ((match = artRegex.exec(xml)) !== null) {
      const block = match[1];
      const noMatch = block.match(/<ArticleNo>([\s\S]*?)<\/ArticleNo>/i);
      const contentMatch = block.match(/<ArticleContent>([\s\S]*?)<\/ArticleContent>/i);
      if (noMatch && contentMatch) {
        const content = contentMatch[1]
          .replace(/<!\[CDATA\[|\]\]>/g, "")
          .replace(/<[^>]+>/g, "")
          .trim();
        articles.push({
          ArticleNo: noMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
          ArticleContent: content,
        });
      }
    }

    if (articles.length > 0) return res.json({ Articles: articles });

    return res.status(404).json({ error: "無法解析條文，請直接前往 law.moj.gov.tw 查詢" });

  } catch (err) {
    res.status(502).json({ error: "無法取得條文", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✓ Legal Proxy running on port ${PORT}`);
  console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
