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
        { Role: "system", Content: "You are a senior e-commerce customer service expert. You help Shopify sellers craft professional, empathetic replies to negative reviews that protect brand image and encourage customers to update their reviews." },
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

function parseResponse(text) {
  const result = { professional: "", friendly: "", brand: "" };
  const p = text.match(/\[Professional\][：:]*\s*([\s\S]*?)(?=\[Friendly\]|$)/i);
  const f = text.match(/\[Friendly\][：:]*\s*([\s\S]*?)(?=\[Brand Voice\]|$)/i);
  const b = text.match(/\[Brand Voice\][：:]*\s*([\s\S]*?)$/i);
  if (p) result.professional = p[1].trim();
  if (f) result.friendly = f[1].trim();
  if (b) result.brand = b[1].trim();
  if (!result.professional && !result.friendly && !result.brand) {
    const lines = text.split("\n").filter(l => l.trim());
    if (lines.length >= 3) { result.professional = lines[0]; result.friendly = lines[1]; result.brand = lines[2]; }
    else { result.professional = result.friendly = result.brand = text.trim(); }
  }
  return result;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { review, productType, rating } = req.body || {};
  if (!review || !review.trim()) return res.status(400).json({ error: "Please paste the review" });

  const prompt = `A customer left the following negative review for a${productType ? ` ${productType}` : ""} product${rating ? ` (${rating} stars)` : ""}:

"${review.trim()}"

Generate 3 different reply styles. Write in English.

[Professional]
(Standard customer service tone — empathetic, solution-oriented, 3-5 sentences)
{reply}

[Friendly]
(Warm, conversational, human — like a real person who cares, 3-5 sentences)
{reply}

[Brand Voice]
(Premium brand tone — confident, polished, shows brand values, 3-5 sentences)
{reply}

Requirements:
- Show empathy first, then offer a solution
- Never admit legal liability
- Subtly encourage the customer to update their review
- Sound human, not robotic
- Include a call to action (contact support, DM us, etc.)`;

  try {
    const aiText = await callHunyuan(prompt);
    res.status(200).json({ success: true, data: parseResponse(aiText) });
  } catch (err) {
    console.error("Generation failed:", err);
    res.status(500).json({ error: err.message || "Generation failed" });
  }
};
