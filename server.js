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

// ── 內建法規索引（常用法律）────────────────────────────────────────
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

// 搜尋法律名稱（內建資料）
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

// 取得法律條文（從全國法規資料庫官網抓 HTML 解析）
app.get("/api/law/articles", async (req, res) => {
  try {
    const { pcode } = req.query;
    if (!pcode) return res.status(400).json({ error: "缺少 pcode 參數" });

    // 使用全國法規資料庫的公開 API 格式
    const url = `https://law.moj.gov.tw/api/ch/laws/${pcode}/articles`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });

    if (r.ok) {
      const data = await r.json();
      const articles = (data.Articles || data.articles || []).map(a => ({
        ArticleNo: a.ArticleNo || a.articleNo || "",
        ArticleContent: a.ArticleContent || a.articleContent || "",
      }));
      return res.json({ Articles: articles });
    }

    // 備用：從網頁版解析
    const htmlUrl = `https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=${pcode}`;
    const htmlRes = await fetch(htmlUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!htmlRes.ok) return res.status(404).json({ error: "找不到該法規" });

    const html = await htmlRes.text();

    // 解析 HTML 中的條文
    const articles = [];
    const regex = /第\s*(\S+)\s*條[\s\S]*?(<td[^>]*class="[^"]*law-article[^"]*"[^>]*>[\s\S]*?<\/td>)/gi;
    let match;

    // 簡易解析：找出條號和內容
    const artRegex = /data-no="([^"]+)"[^>]*>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/gi;
    while ((match = artRegex.exec(html)) !== null) {
      articles.push({
        ArticleNo: match[1].trim(),
        ArticleContent: match[2].replace(/<[^>]+>/g, "").trim(),
      });
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
