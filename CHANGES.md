# What changed in this version (and what is still missing)

## Changed

| File | Change |
|---|---|
| `lambdas/tours-booking/index.mjs` | Refund policy is now 10+ days = 80%, 5-9 days = configurable (default 10%), 2-4 days = 10%, within 1 day = 0%. Cancelling only *requests* a refund (status `REFUND_PROCESSING`); it is no longer marked refunded automatically. The cancel response now returns booking amount, cancellation date, refund %, refund amount and cancellation fee. Members are capped at 20. `/pay` records `paymentMode` and returns `testPayment: true` in simulation mode. |
| `lambdas/tours-admin/index.mjs` | New `POST /admin/refund/approve` and `POST /admin/refund/reject` (body `{bookingId}`). Only admin-approved refunds are counted in "Refunded" and net revenue. Summary now returns `refunds` and `totals.pendingRefunds`. |
| `terraform/main.tf` | Two new admin routes on `tours-admin`; Lambda env vars `REFUND_5_9_PERCENT` and `PAYMENT_MODE`. |
| `terraform/variables.tf` | New variables `refund_5_9_percent` (default 10) and `payment_mode` (default `simulation`). |
| `admin-site/dashboard.html`, `style.css` | New **Refunds** tab with Approve / Reject buttons and a pending-count badge. |
| `user-site/dashboard.html`, `style.css` | New policy text, "Refund processing" / "Refunded" statuses, and the full refund breakdown after cancelling. |

## You must decide / do
1. **5-9 day refund %**: the spec says "configured policy". It defaults to 10 to match your current behaviour. Change `refund_5_9_percent` if you want another value.
2. **Approve a refund only after the money is really sent back** (UPI/bank). Nothing in AWS sends money.
3. Existing rows already marked `REFUNDED` / `NO_REFUND` keep working. No table changes, so `terraform apply` is safe.

## Not done (needs separate work)
- **Payment is still a simulation**: `/pay` confirms without a real gateway. Before going live, add Razorpay/Stripe (or similar) with a webhook Lambda and keep its secret in SSM/Secrets Manager.
- **Cognito, React/Vite, CloudFront for the user site, SNS notifications, S3 image upload, Bookings/Refunds/Reviews tables, reviews, profile update, admin package edit**: not added. Cognito replaces the custom login in all 4 Lambdas and the Terraform authorizers, so it is best done as its own step.
- Booking form has no adults/children split, return date, pickup location or special requests yet.
- Admin API is still protected only by the signed token plus CORS (no WAF / IP limits). Tokens are in `localStorage`.
