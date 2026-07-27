import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders controlled-device mode by default", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>被控端 · SYNCWALL<\/title>/i);
  assert.match(html, /点击启用声音/);
  assert.match(html, /跨屏进度/);
  assert.doesNotMatch(html, /主机同步毫秒时钟/);
  assert.doesNotMatch(html, /固定设备码/);
  assert.doesNotMatch(html, /上传新视频/);
  assert.doesNotMatch(html, /当前时间码/);
});

test("non-admin paths also render controlled-device mode", async () => {
  const response = await render("/screen-27");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>被控端 · SYNCWALL<\/title>/i);
  assert.match(html, /跨屏进度/);
  assert.doesNotMatch(html, /上传新视频/);
});

test("server-renders the control surface only at /admin666", async () => {
  const response = await render("/admin666");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>控制端 · SYNCWALL<\/title>/i);
  assert.match(html, /0<!-- --> 屏同步控制台/);
  assert.match(html, /尚无被控端在线/);
  assert.match(html, /2000/);
  assert.match(html, /3000/);
  assert.match(html, /在线设备/);
  assert.match(html, /双重毫秒时间校准/);
  assert.match(html, /开始校准/);
  assert.match(html, /显示时间码/);
  assert.match(html, /静止时间/);
  assert.match(html, /自动校准/);
  assert.match(html, /手动校准/);
  assert.match(html, /不会改动播放延迟/);
  assert.match(html, /播放与设备输出/);
  assert.match(html, /向设备 <!-- -->—<!-- --> 播放校准叮声/);
  assert.match(html, /min="-3000"/);
  assert.match(html, /max="3000"/);
  assert.match(html, /网络延迟和设备播放延迟均不参与播放目标时刻/);
  assert.match(html, /同步播放/);
  assert.match(html, /循环[\s\S]*关闭/);
  assert.match(html, /当前时间码/);
  assert.match(html, /00:00:00:00/);
  assert.match(html, /25 fps/);
  assert.match(html, /aria-label="后退一帧"/);
  assert.match(html, /aria-label="前进一帧"/);
  assert.match(html, /aria-label="时间码定位滑块"/);
  assert.doesNotMatch(html, /codex-preview/);
});
