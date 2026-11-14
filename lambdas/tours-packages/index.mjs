import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SECRET = process.env.SECRET;
const hmac = b => crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
const verify = (h = "") => {
  const [b, s] = h.replace("Bearer ", "").split(".");
  if (!b || s !== hmac(b)) return null;
  const p = JSON.parse(Buffer.from(b, "base64url"));
  return p.exp > Date.now() ? p : null;
};
const res = (c, b) => ({ statusCode: c, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

export const handler = async (e) => {
  try {
    const k = `${e.requestContext.http.method} ${e.rawPath}`;
    const q = e.queryStringParameters || {};
    const b = e.body ? JSON.parse(e.body) : {};

    if (k === "GET /packages") {
      return res(200, (await db.send(new ScanCommand({ TableName: "Packages" }))).Items);
    }
    const au = verify(e.headers.authorization);
    if (au?.role !== "admin") return res(401, { error: "Unauthorized" });

    if (k === "POST /admin/package") {
      await db.send(new PutCommand({ TableName: "Packages", Item: { packageId: "PK" + Date.now(), name: b.name, destination: b.destination, days: Number(b.days), price: Number(b.price), image: b.image || "" } }));
      return res(200, { ok: true });
    }
    if (k === "DELETE /admin/package") {
      await db.send(new DeleteCommand({ TableName: "Packages", Key: { packageId: q.id } }));
      return res(200, { ok: true });
    }
    return res(404, { error: "Not found" });
  } catch (err) { console.error(err); return res(500, { error: "Server error" }); }
};
