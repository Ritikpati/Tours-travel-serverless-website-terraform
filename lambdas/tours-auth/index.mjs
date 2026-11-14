import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SECRET = process.env.SECRET;
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const hmac = b => crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
const sign = p => { const b = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + 864e5 })).toString("base64url"); return b + "." + hmac(b); };
const res = (c, b) => ({ statusCode: c, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const get = (T, Key) => db.send(new GetCommand({ TableName: T, Key })).then(r => r.Item);

export const handler = async (e) => {
  try {
    const k = `${e.requestContext.http.method} ${e.rawPath}`;
    const b = e.body ? JSON.parse(e.body) : {};

    if (k === "POST /register") {
      if (!b.email || !b.password || !b.name) return res(400, { error: "Fill all fields" });
      try {
        await db.send(new PutCommand({
          TableName: "Users",
          Item: { email: b.email.toLowerCase(), name: b.name, phone: b.phone || "", passwordHash: sha(b.password), createdAt: new Date().toISOString() },
          ConditionExpression: "attribute_not_exists(email)"
        }));
      } catch { return res(409, { error: "Email already registered" }); }
      return res(200, { ok: true });
    }
    if (k === "POST /login") {
      const u = await get("Users", { email: (b.email || "").toLowerCase() });
      if (!u || u.passwordHash !== sha(b.password || "")) return res(401, { error: "Invalid email or password" });
      return res(200, { token: sign({ role: "user", email: u.email }), name: u.name });
    }
    if (k === "POST /admin/login") {
      const a = await get("Admins", { username: b.username || "" });
      if (!a || a.passwordHash !== sha(b.password || "")) return res(401, { error: "Invalid admin login" });
      return res(200, { token: sign({ role: "admin", username: a.username }) });
    }
    return res(404, { error: "Not found" });
  } catch (err) { console.error(err); return res(500, { error: "Server error" }); }
};
