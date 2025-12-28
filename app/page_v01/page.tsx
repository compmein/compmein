import Link from "next/link";

export default function HomePage() {
  return (
    <div className="space-y-10">
      <section className="rounded-3xl border bg-white p-8 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight">
          把你放进 Honolulu 的照片里
        </h1>

        <p className="mt-3 max-w-2xl text-neutral-600">
          选一个 Honolulu 的真实场景，上传你的照片，
          简单拖一拖，就能合成一张“你在夏威夷”的照片。
          不用真的飞过去，也能先看看你在那里会是什么样子。
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/create"
            className="rounded-xl bg-neutral-900 px-5 py-3 text-white hover:opacity-90"
          >
            开始合成照片
          </Link>

          <Link
            href="/gifts"
            className="rounded-xl border px-5 py-3 hover:bg-neutral-50"
          >
            看 Honolulu 礼品
          </Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <div className="font-semibold">🌴 真实 Honolulu 场景</div>
          <p className="mt-2 text-sm text-neutral-600">
            精选 Waikiki、Diamond Head 等经典地点，
            更像真的站在那里。
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <div className="font-semibold">📸 你就是主角</div>
          <p className="mt-2 text-sm text-neutral-600">
            不是 AI 捏人，而是把“你本人”放进场景里。
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <div className="font-semibold">🎁 带走一点 Honolulu</div>
          <p className="mt-2 text-sm text-neutral-600">
            不只是照片，还有来自 Honolulu 的纪念礼品。
          </p>
        </div>
      </section>
    </div>
  );
}
