import Stripe from "stripe";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

type TopUpMeta = {
  userId?: string;
  priceId?: string;
  tokens?: string;
};

function intOrZero(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export async function POST(req: Request) {
  
  try {
    const sig = req.headers.get("stripe-signature");
    const whsec = process.env.STRIPE_WEBHOOK_SECRET;

    if (!sig || !whsec) {
      console.error("❌ Missing stripe-signature header or STRIPE_WEBHOOK_SECRET");
      return NextResponse.json({ error: "Missing signature/secret" }, { status: 400 });
    }

    const rawBody = await req.text();
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, whsec);
    } catch (err: any) {
      console.error("❌ Webhook signature verify failed:", err?.message || err);
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    // 只处理 checkout.session.completed
    if (event.type !== "checkout.session.completed") {
      return NextResponse.json({ received: true });
    }

    const session = event.data.object as Stripe.Checkout.Session;
    const exists = await supabaseAdmin
  .from("token_ledger")
  .select("id")
  .eq("result_id", session.id)
  .maybeSingle();

if (exists.data) {
  console.log("⚠️ duplicate webhook ignored", session.id);
  return NextResponse.json({ ok: true });
}

    const meta = (session.metadata || {}) as TopUpMeta;

    const userId = meta.userId?.trim();
    const priceId = meta.priceId?.trim() || "";
    const tokens = intOrZero(meta.tokens);

    console.log("✅ TOP_UP webhook:", {
      userId,
      priceId,
      tokens,
      sessionId: session.id,
    });

    if (!userId) {
      console.error("❌ Missing metadata.userId");
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }
    if (!tokens || tokens <= 0) {
      console.error("❌ Missing/invalid metadata.tokens:", meta.tokens);
      return NextResponse.json({ error: "Missing/invalid tokens" }, { status: 400 });
    }

    // 1) 先写 ledger（result_id 用 session.id，是 text）
    // 重要：TOP_UP 不要写负数 cost，避免触发 cost_check
    const led = await supabaseAdmin.from("token_ledger").insert({
  user_id: userId,
  action: "TOP_UP",
  cost: tokens,              // ✅ 必须 > 0
  status: "settled",
  result_id: session.id,
  created_at: new Date().toISOString(),
  settled_at: new Date().toISOString(),
});


    if (led.error) {
      // 如果重复事件（unique result_id），直接当成功处理，避免 500
      const msg = led.error.message || "";
      const isDup =
        msg.includes("duplicate") ||
        msg.includes("already exists") ||
        msg.includes("unique") ||
        msg.includes("token_ledger_result_unique");

      console.error("❌ token_ledger insert failed FULL:", led.error);
      if (isDup) {
        return NextResponse.json({ received: true });
      }
      return NextResponse.json({ error: led.error.message }, { status: 500 });
    }

    // 2) 读当前 balance
    const cur = await supabaseAdmin
      .from("user_tokens")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle();

    if (cur.error) {
      console.error("❌ user_tokens select failed FULL:", cur.error);
      return NextResponse.json({ error: cur.error.message }, { status: 500 });
    }

    const oldBalance = intOrZero(cur.data?.balance);
    const newBalance = oldBalance + tokens;

    // 3) upsert 新 balance
    const up = await supabaseAdmin.from("user_tokens").upsert(
      {
        user_id: userId,
        balance: newBalance,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (up.error) {
      console.error("❌ user_tokens upsert failed FULL:", up.error);
      return NextResponse.json({ error: up.error.message }, { status: 500 });
    }

    console.log("✅ Balance updated:", { userId, oldBalance, newBalance });

    return NextResponse.json({ received: true });
  } catch (err: any) {
    console.error("🔥 Webhook fatal error:", err?.message || err);
    return NextResponse.json({ error: "Webhook fatal error" }, { status: 500 });
  }
}
