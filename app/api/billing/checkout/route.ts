import Stripe from "stripe";
import { NextResponse } from "next/server";

// ✅ 把下面 4 个 priceId 换成你 Stripe 的真实 price_...
const PRICE_TO_TOKENS: Record<string, number> = {
  price_1SimQWJXUXYOjGjwUDA8mMC5: 120,
  price_1SimQ1JXUXYOjGjwDyeODYvE: 800,
  price_1SimOtJXUXYOjGjw3uztzGm5: 2800,
  price_1SimLRJXUXYOjGjwEsrXuc2s: 5000,
};

export async function POST(req: Request) {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return NextResponse.json({ error: "Missing STRIPE_SECRET_KEY" }, { status: 500 });
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
    if (!siteUrl) {
      return NextResponse.json({ error: "Missing NEXT_PUBLIC_SITE_URL" }, { status: 500 });
    }

    const stripe = new Stripe(stripeKey);

    const { priceId, userId } = await req.json();

    if (!priceId) return NextResponse.json({ error: "Missing priceId" }, { status: 400 });
    if (!userId) return NextResponse.json({ error: "Missing userId" }, { status: 401 });

    const tokens = PRICE_TO_TOKENS[priceId];
    if (!tokens) {
      return NextResponse.json(
        { error: "Unknown priceId. Please set PRICE_TO_TOKENS mapping." },
        { status: 400 }
      );
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl}/account?success=1`,
      cancel_url: `${siteUrl}/account?canceled=1`,
      metadata: { userId, tokens: String(tokens) },
    });

    return NextResponse.json({ url: session.url });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Checkout error" }, { status: 500 });
  }
}
