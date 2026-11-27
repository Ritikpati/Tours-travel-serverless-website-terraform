import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
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
const all = async T => {
  let items = [], key;
  do {
    const r = await db.send(new ScanCommand({ TableName: T, ExclusiveStartKey: key }));
    items = items.concat(r.Items || []); key = r.LastEvaluatedKey;
  } while (key);
  return items;
};
const refundDone = x => x.payStatus === "REFUNDED" ? (x.refund || 0) : 0; // only admin-approved refunds count as paid out
const byTimeDesc = f => (a, b) => String(f(b) || "").localeCompare(String(f(a) || ""));

export const handler = async (e) => {
  try {
    const k = `${e.requestContext.http.method} ${e.rawPath}`;
    const q = e.queryStringParameters || {};
    const b = e.body ? JSON.parse(e.body) : {};
    const au = verify(e.headers.authorization);
    if (au?.role !== "admin") return res(401, { error: "Unauthorized" });

    if (k === "GET /admin/summary") {
      // Read the 3 data tables and join them, so the dashboard always shows one consistent picture
      const [users, packages, items] = await Promise.all(["Users", "Packages", "Payments"].map(all));
      const uMap = Object.fromEntries(users.map(u => [u.email, u]));
      const bks = items.filter(x => x.bookingId !== "-");
      const paid = items.filter(x => ["PAID", "REFUNDED", "NO_REFUND", "REFUND_PENDING", "REFUND_REJECTED"].includes(x.payStatus));

      const bookings = bks
        .map(x => ({ ...x, name: uMap[x.email]?.name || "", phone: uMap[x.email]?.phone || "" }))
        .sort(byTimeDesc(x => x.createdAt));

      const payments = paid
        .map(x => ({
          paymentId: x.paymentId, bookingId: x.bookingId, email: x.email, name: uMap[x.email]?.name || "",
          destination: x.destination || "-", amount: x.amount, status: x.payStatus, refund: refundDone(x),
          paidAt: x.paidAt || x.createdAt
        }))
        .sort(byTimeDesc(x => x.paidAt));

      const usersOut = users
        .map(({ passwordHash, ...u }) => ({
          ...u,
          bookings: bks.filter(x => x.email === u.email).length,
          spent: paid.filter(x => x.email === u.email).reduce((s, x) => s + (x.amount || 0) - refundDone(x), 0)
        }))
        .sort(byTimeDesc(x => x.createdAt));

      const packageStats = packages.map(p => {
        const mine = paid.filter(x => x.packageId === p.packageId);
        return {
          packageId: p.packageId, name: p.name, destination: p.destination,
          bookings: mine.length,
          revenue: mine.reduce((s, x) => s + (x.amount || 0) - refundDone(x), 0)
        };
      });

      return res(200, {
        users: usersOut, packages, bookings, payments, packageStats,
        refunds: bookings.filter(x => x.cancelledAt && x.refund > 0 || x.payStatus === "REFUND_REJECTED")
          .sort(byTimeDesc(x => x.cancelledAt)),
        totals: {
          confirmed: bks.filter(x => x.status === "CONFIRMED").length,
          cancelled: bks.filter(x => ["CANCELLED", "REFUND_PROCESSING", "REFUNDED"].includes(x.status)).length,
          pendingRefunds: bks.filter(x => x.payStatus === "REFUND_PENDING").length,
          pending: bks.filter(x => x.status === "PENDING_PAYMENT").length
        },
        totalCollected: paid.reduce((s, x) => s + (x.amount || 0), 0),
        totalRefunded: paid.reduce((s, x) => s + refundDone(x), 0)
      });
    }
    if (k === "POST /admin/payment") {
      await db.send(new PutCommand({ TableName: "Payments", Item: {
        paymentId: "PAY" + Date.now(), bookingId: "-", email: b.email, amount: Number(b.amount),
        status: "MANUAL", payStatus: "PAID", refund: 0, createdAt: new Date().toISOString()
      } }));
      return res(200, { ok: true });
    }
    if (k === "POST /admin/refund/approve" || k === "POST /admin/refund/reject") {
      const bk = (await db.send(new GetCommand({ TableName: "Payments", Key: { paymentId: String(b.bookingId || "") } }))).Item;
      if (!bk || bk.payStatus !== "REFUND_PENDING") return res(400, { error: "No pending refund for this booking" });
      const ok = k.endsWith("approve");
      await db.send(new PutCommand({ TableName: "Payments", Item: ok
        ? { ...bk, status: "REFUNDED", payStatus: "REFUNDED", refundApprovedAt: new Date().toISOString(), refundApprovedBy: au.username }
        : { ...bk, status: "CANCELLED", payStatus: "REFUND_REJECTED", refundRejectedAt: new Date().toISOString(), refundRejectedBy: au.username } }));
      return res(200, { ok: true });
    }
    if (k === "DELETE /admin/payment") {
      await db.send(new DeleteCommand({ TableName: "Payments", Key: { paymentId: q.id } }));
      return res(200, { ok: true });
    }
    return res(404, { error: "Not found" });
  } catch (err) { console.error(err); return res(500, { error: "Server error" }); }
};
