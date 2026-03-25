const https = require("https");
const crypto = require("crypto");

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
        { Role: "system", Content: "You are a senior e-commerce customer service expert. You help Shopify sellers craft professional, empathetic replies to negative reviews. Output ONLY the reply text for each style, no markdown, no headers, no formatting marks." },
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

// 清理markdown和多余标记
function cleanText(str) {
  return str
    .replace(/^#{1,4}\s*.*/gm, '')       // 移除 ### 标题行
    .replace(/\*\*(.*?)\*\*/g, '$1')     // 移除 **粗体**
    .replace(/^\s*[-*]\s*/gm, '')        // 移除列表标记
    .replace(/```[\s\S]*?```/g, '')      // 移除代码块
    .replace(/^\s*>\s*/gm, '')           // 移除引用
    .replace(/\n{3,}/g, '\n\n')          // 合并多余空行
    .trim();
}

function parseResponse(text) {
  const result = { professional: "", friendly: "", brand: "" };
  
  // 尝试多种分隔模式
  const patterns = [
    // [Professional] ... [Friendly] ... [Brand Voice]
    { p: /\[Professional\][：:\s]*([\s\S]*?)(?=\[Friendly\])/i, f: /\[Friendly\][：:\s]*([\s\S]*?)(?=\[Brand Voice\])/i, b: /\[Brand Voice\][：:\s]*([\s\S]*?)$/i },
    // **Professional** / **Friendly** / **Brand Voice**
    { p: /\*?\*?Professional\*?\*?[：:\s]*([\s\S]*?)(?=\*?\*?Friendly)/i, f: /\*?\*?Friendly\*?\*?[：:\s]*([\s\S]*?)(?=\*?\*?Brand)/i, b: /\*?\*?Brand\s*Voice?\*?\*?[：:\s]*([\s\S]*?)$/i },
    // ### Professional / ### Friendly / ### Brand Voice
    { p: /#{1,4}\s*Professional[：:\s]*([\s\S]*?)(?=#{1,4}\s*Friendly)/i, f: /#{1,4}\s*Friendly[：:\s]*([\s\S]*?)(?=#{1,4}\s*Brand)/i, b: /#{1,4}\s*Brand\s*Voice?[：:\s]*([\s\S]*?)$/i },
    // 1. Professional / 2. Friendly / 3. Brand
    { p: /1[\.\)]\s*Professional[：:\s]*([\s\S]*?)(?=2[\.\)])/i, f: /2[\.\)]\s*Friendly[：:\s]*([\s\S]*?)(?=3[\.\)])/i, b: /3[\.\)]\s*Brand[：:\s]*([\s\S]*?)$/i },
  ];

  for (const pat of patterns) {
    const pm = text.match(pat.p);
    const fm = text.match(pat.f);
    const bm = text.match(pat.b);
    if (pm && fm && bm) {
      result.professional = cleanText(pm[1]);
      result.friendly = cleanText(fm[1]);
      result.brand = cleanText(bm[1]);
      break;
    }
  }

  // 如果所有模式都没匹配到，按段落分割
  if (!result.professional && !result.friendly && !result.brand) {
    // 按双换行分割段落
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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { review, productType, rating, lang } = req.body || {};
  if (!review || !review.trim()) return res.status(400).json({ error: "Please paste the review" });

  // 根据语言决定输出语言
  const outputLang = (lang && lang.startsWith('zh')) ? 'Chinese' : 'English';
  const langInstruction = outputLang === 'Chinese'
    ? '用中文输出回复。'
    : 'Write all replies in English.';

  const prompt = `A customer left the following negative review for a${productType ? ` ${productType}` : ""} product${rating ? ` (${rating})` : ""}:

"${review.trim()}"

Generate 3 different reply styles. ${langInstruction}

IMPORTANT: Output ONLY the reply text under each label. No markdown formatting (no ###, no **, no bullet points). Just plain text.

[Professional]
(Standard customer service tone — empathetic, solution-oriented, 3-5 sentences. Write the reply directly, no label repeat.)

[Friendly]
(Warm, conversational, human — like a real person who cares, 3-5 sentences. Write the reply directly.)

[Brand Voice]
(Premium brand tone — confident, polished, shows brand values, 3-5 sentences. Write the reply directly.)

Requirements:
- Show empathy first, then offer a solution
- Never admit legal liability
- Subtly encourage the customer to reconsider or update their review
- Sound human, not robotic
- Include a call to action (contact support, DM us, etc.)
- Do NOT use any markdown formatting`;

  try {
    const aiText = await callHunyuan(prompt);
    res.status(200).json({ success: true, data: parseResponse(aiText) });
  } catch (err) {
    console.error("Generation failed:", err);
    res.status(500).json({ error: err.message || "Generation failed" });
  }
};
