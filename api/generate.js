const https = require("https");
const crypto = require("crypto");

// ========== 腾讯混元 API ==========
function getHmacSHA256(key, msg) { return crypto.createHmac("sha256", key).update(msg).digest(); }
function sha256Hex(msg) { return crypto.createHash("sha256").update(msg).digest("hex"); }

function signV3(secretId, secretKey, service, action, payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().split("T")[0];
  const contentType = "application/json; charset=utf-8";
  const canonicalHeaders = `content-type:${contentType}\nhost:hunyuan.tencentcloudapi.com\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256Hex(payload)}`;
  const algorithm = "TC3-HMAC-SHA256";
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const secretDate = getHmacSHA256(`TC3${secretKey}`, date);
  const secretService = getHmacSHA256(secretDate, service);
  const secretSigning = getHmacSHA256(secretService, "tc3_request");
  const signature = getHmacSHA256(secretSigning, stringToSign).toString("hex");
  return {
    authorization: `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    timestamp,
  };
}

function callHunyuan(prompt) {
  return new Promise((resolve, reject) => {
    const secretId = process.env.HUNYUAN_SECRET_ID;
    const secretKey = process.env.HUNYUAN_SECRET_KEY;
    if (!secretId || !secretKey) return reject(new Error("API key not configured"));
    const action = "ChatCompletions";
    const body = JSON.stringify({
      Model: "hunyuan-lite",
      Messages: [
        { Role: "system", Content: "You are a senior e-commerce customer service expert. Output ONLY plain text, no markdown." },
        { Role: "user", Content: prompt },
      ],
      Temperature: 0.8, TopP: 0.9, Stream: false,
    });
    const { authorization, timestamp } = signV3(secretId, secretKey, "hunyuan", action, body);
    const req = https.request({
      hostname: "hunyuan.tencentcloudapi.com", path: "/", method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: authorization,
        "X-TC-Action": action, "X-TC-Version": "2023-09-01",
        "X-TC-Timestamp": String(timestamp), "X-TC-Region": "ap-guangzhou",
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.Response?.Choices?.length > 0) resolve(json.Response.Choices[0].Message.Content);
          else if (json.Response?.Error) reject(new Error(json.Response.Error.Message));
          else reject(new Error("API error"));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function cleanText(str) {
  return str
    .replace(/^#{1,4}\s*.*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^\s*[-*]\s*/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseResponse(text) {
  const result = { professional: "", friendly: "", brand: "" };
  const patterns = [
    { p: /\[Professional\][：:\s]*([\s\S]*?)(?=\[Friendly\])/i, f: /\[Friendly\][：:\s]*([\s\S]*?)(?=\[Brand Voice\])/i, b: /\[Brand Voice\][：:\s]*([\s\S]*?)$/i },
    { p: /\*?\*?Professional\*?\*?[：:\s]*([\s\S]*?)(?=\*?\*?Friendly)/i, f: /\*?\*?Friendly\*?\*?[：:\s]*([\s\S]*?)(?=\*?\*?Brand)/i, b: /\*?\*?Brand\s*Voice?\*?\*?[：:\s]*([\s\S]*?)$/i },
    { p: /#{1,4}\s*Professional[：:\s]*([\s\S]*?)(?=#{1,4}\s*Friendly)/i, f: /#{1,4}\s*Friendly[：:\s]*([\s\S]*?)(?=#{1,4}\s*Brand)/i, b: /#{1,4}\s*Brand\s*Voice?[：:\s]*([\s\S]*?)$/i },
  ];
  for (const pat of patterns) {
    const pm = text.match(pat.p), fm = text.match(pat.f), bm = text.match(pat.b);
    if (pm && fm && bm) {
      result.professional = cleanText(pm[1]);
      result.friendly = cleanText(fm[1]);
      result.brand = cleanText(bm[1]);
      break;
    }
  }
  if (!result.professional) {
    const paragraphs = text.split(/\n\s*\n/).map(p => cleanText(p)).filter(p => p.length > 20);
    if (paragraphs.length >= 3) {
      result.professional = paragraphs[0];
      result.friendly = paragraphs[1];
      result.brand = paragraphs[2];
    } else {
      result.professional = result.friendly = result.brand = cleanText(text);
    }
  }
  return result;
}

// ========== Credits 管理（简单内存存储，重启清零）==========
// 生产环境应该用 Redis 或数据库
const creditsDB = new Map();
const FREE_CREDITS = 3;

function getCredits(userId) {
  if (!creditsDB.has(userId)) {
    creditsDB.set(userId, { credits: FREE_CREDITS, unlimited: false, unlimitedExpiry: null });
  }
  return creditsDB.get(userId);
}

function deductCredit(userId) {
  const user = getCredits(userId);
  if (user.unlimited && user.unlimitedExpiry > Date.now()) return true;
  if (user.credits > 0) {
    user.credits--;
    return true;
  }
  return false;
}

function addCredits(userId, amount, unlimited = false, days = 0) {
  const user = getCredits(userId);
  if (unlimited) {
    user.unlimited = true;
    user.unlimitedExpiry = Date.now() + days * 86400000;
  } else {
    user.credits += amount;
  }
  return user;
}

// ========== API 路由 ==========
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const path = req.url;

  // 1. 检查 credits
  if (path === "/api/check-credits" && req.method === "POST") {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "Missing userId" });
    const user = getCredits(userId);
    const hasUnlimited = user.unlimited && user.unlimitedExpiry > Date.now();
    return res.json({ 
      success: true, 
      credits: user.credits, 
      unlimited: hasUnlimited,
      unlimitedExpiry: hasUnlimited ? user.unlimitedExpiry : null
    });
  }

  // 2. 生成回复（扣 credits）
  if (path === "/api/generate" && req.method === "POST") {
    const { review, productType, rating, lang, userId } = req.body || {};
    if (!review || !review.trim()) return res.status(400).json({ error: "Please paste the review" });
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    // 检查 credits
    const user = getCredits(userId);
    const hasUnlimited = user.unlimited && user.unlimitedExpiry > Date.now();
    if (!hasUnlimited && user.credits <= 0) {
      return res.status(403).json({ 
        error: "No credits left", 
        code: "NO_CREDITS",
        credits: 0 
      });
    }

    // 扣 credits
    deductCredit(userId);

    const outputLang = (lang && lang.startsWith('zh')) ? 'Chinese' : 'English';
    const langInstruction = outputLang === 'Chinese' ? '用中文输出回复。' : 'Write all replies in English.';

    const prompt = `A customer left the following negative review for a${productType ? ` ${productType}` : ""} product${rating ? ` (${rating})` : ""}:

"${review.trim()}"

Generate 3 different reply styles. ${langInstruction}

IMPORTANT: Output ONLY plain text. No markdown.

[Professional]
{reply}

[Friendly]
{reply}

[Brand Voice]
{reply}`;

    try {
      const aiText = await callHunyuan(prompt);
      const result = parseResponse(aiText);
      const remaining = getCredits(userId);
      res.status(200).json({ 
        success: true, 
        data: result,
        credits: remaining.credits,
        unlimited: remaining.unlimited && remaining.unlimitedExpiry > Date.now()
      });
    } catch (err) {
      console.error("Generation failed:", err);
      res.status(500).json({ error: err.message || "Generation failed" });
    }
  }

  // 3. Lemon Squeezy 支付回调
  if (path === "/api/webhook/lemonsqueezy" && req.method === "POST") {
    const signature = req.headers["x-signature"];
    const body = JSON.stringify(req.body);
    
    // 验证签名（生产环境需要）
    // const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    
    const { meta, data } = req.body || {};
    if (!data) return res.status(400).json({ error: "Invalid payload" });

    const orderId = data.id;
    const status = data.attributes?.status;
    const customData = data.attributes?.checkout_data?.custom || {};
    const userId = customData.userId;
    const variant = customData.variant; // '20', '100', 'unlimited'

    if (status === "paid" && userId) {
      // 根据套餐添加 credits
      if (variant === "20") {
        addCredits(userId, 20);
      } else if (variant === "100") {
        addCredits(userId, 100);
      } else if (variant === "unlimited") {
        addCredits(userId, 0, true, 7); // 7天无限
      }
      console.log(`Payment success: ${userId}, variant: ${variant}`);
    }

    return res.json({ received: true });
  }

  // 4. 404
  return res.status(404).json({ error: "Not found" });
};
