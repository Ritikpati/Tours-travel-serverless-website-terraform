import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SECRET = process.env.SECRET, UPI = process.env.UPI_ID || "yourupi@bank";
const TR = { Flight: 5000, Bus: 1500, Transport: 2500 };
const PAY_MODE = process.env.PAYMENT_MODE || "simulation"; // "simulation" = test payment, no real gateway
const PCT_5_9 = Math.min(100, Math.max(0, Number(process.env.REFUND_5_9_PERCENT ?? 10))) / 100; // configurable tier
// Refund policy (calculated here on the backend, never trusted from the browser):
// 10+ days 80% | 5-9 days configurable (default 10%) | 2-4 days 10% | 0-1 days 0%
const refundPct = days => days >= 10 ? 0.8 : days >= 5 ? PCT_5_9 : days >= 2 ? 0.1 : 0;
const hmac = b => crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
const verify = (h = "") => {
  const [b, s] = h.replace("Bearer ", "").split(".");
  if (!b || s !== hmac(b)) return null;
  const p = JSON.parse(Buffer.from(b, "base64url"));
  return p.exp > Date.now() ? p : null;
};
const res = (c, b) => ({ statusCode: c, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const get = (T, Key) => db.send(new GetCommand({ TableName: T, Key })).then(r => r.Item);
const put = (T, Item) => db.send(new PutCommand({ TableName: T, Item }));

export const handler = async (e) => {
  try {
    const k = `${e.requestContext.http.method} ${e.rawPath}`;
    const b = e.body ? JSON.parse(e.body) : {};
    const au = verify(e.headers.authorization);
    if (au?.role !== "user") return res(401, { error: "Please login" });

    if (k === "POST /book") {
      const pk = await get("Packages", { packageId: b.packageId });
      const members = Math.min(20, Math.max(1, parseInt(b.members) || 1));
      if (!pk || !TR[b.transport] || !b.date || new Date(b.date) <= new Date()) return res(400, { error: "Invalid booking details" });
      const amount = (pk.price + TR[b.transport]) * members;
      const id = "BK" + Date.now();
      await put("Payments", {
        paymentId: id, bookingId: id, email: au.email, packageId: pk.packageId, packageName: pk.name,
        destination: pk.destination, transport: b.transport, date: b.date, members, amount,
        status: "PENDING_PAYMENT", payStatus: "PENDING", refund: 0, createdAt: new Date().toISOString()
      });
      return res(200, { bookingId: id, amount, upi: `upi://pay?pa=${UPI}&pn=ToursTravels&am=${amount}&cu=INR&tn=${id}` });
    }
    if (k === "POST /pay") {
      const bk = await get("Payments", { paymentId: b.bookingId });
      if (!bk || bk.email !== au.email || bk.status !== "PENDING_PAYMENT") return res(400, { error: "Invalid booking" });
      // NOTE: simulation mode - no real gateway verifies this. Replace with a gateway webhook before going live.
      await put("Payments", { ...bk, status: "CONFIRMED", payStatus: "PAID", paymentMode: PAY_MODE, paidAt: new Date().toISOString() });
      return res(200, { ok: true, testPayment: PAY_MODE === "simulation" });
    }
    if (k === "GET /mybookings") {
      const items = (await db.send(new ScanCommand({ TableName: "Payments" }))).Items;
      return res(200, items.filter(x => x.email === au.email && x.bookingId !== "-").sort((a, c) => c.createdAt.localeCompare(a.createdAt)));
    }
    if (k === "POST /cancel") {
      const bk = await get("Payments", { paymentId: b.bookingId });
      if (!bk || bk.email !== au.email || bk.status !== "CONFIRMED") return res(400, { error: "Cannot cancel this booking" });
      const days = Math.ceil((new Date(bk.date) - Date.now()) / 864e5);
      const pct = refundPct(days);
      const refund = Math.round(bk.amount * pct);
      const fee = bk.amount - refund;
      const now = new Date().toISOString();
      // A refund is only REQUESTED here. It becomes REFUNDED when an admin approves it.
      await put("Payments", { ...bk,
        status: refund ? "REFUND_PROCESSING" : "CANCELLED", payStatus: refund ? "REFUND_PENDING" : "NO_REFUND",
        refund, refundPercent: pct * 100, cancellationFee: fee, cancelledAt: now, refundRequestedAt: refund ? now : "" });
      return res(200, { bookingAmount: bk.amount, cancelledAt: now, percent: pct * 100, refund, cancellationFee: fee, refundStatus: refund ? "PENDING_ADMIN_APPROVAL" : "NONE" });
    }
    return res(404, { error: "Not found" });
  } catch (err) { console.error(err); return res(500, { error: "Server error" }); }
};
