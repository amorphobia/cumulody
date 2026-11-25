import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { handle } from "../src/worker.js";

const env = {
  DRIVE115_ROOT_CID: "42", DRIVE115_COOKIE: "UID=test-session",
  SUBSONIC_USER: "listener", SUBSONIC_PASSWORD: "test-password"
};
const params = { u: "listener", s: "demo-salt", v: "1.16.1", c: "test", f: "json",
  t: createHash("md5").update("test-passworddemo-salt").digest("hex") };
const top = { cid: "42", pid: "0", name: "Music" };
const album = { cid: "83", pid: "42", name: "Album & Friends" };
const file = { fid: "90071992547409939", cid: "83", n: 'A & B.flac', pc: "demo-track", s: "10", aid: "1" };
const ticket = "a".repeat(32) + "=" + "b".repeat(32);

function request(endpoint, extra = {}, init = {}) {
  return new Request("https://worker.example/rest/" + endpoint + "?" + new URLSearchParams({ ...params, ...extra }), init);
}
async function json(response) { return (await response.json())["subsonic-response"]; }
function page(path, rows, offset = 0, count = rows.length) {
  return Response.json({ state: true, path, data: rows, offset, count });
}

function fixture(mediaStatus = 206) {
  const calls = [];
  const fetcher = async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url, headers, init });
    if (url.hostname === "webapi.115.com") {
      assert.equal(headers.get("cookie"), env.DRIVE115_COOKIE);
      assert.equal(init.redirect, "manual");
      if (url.pathname === "/files/get_info") return Response.json({ state: true, data: [file] });
      if (url.pathname === "/files/download") return Response.json({ state: true, file_url: "https://cdn.115.com/audio" },
        { headers: [["set-cookie", "UID=session-must-stay-private; Path=/"], ["set-cookie", ticket + "; Path=/"]] });
      const cid = url.searchParams.get("cid");
      if (cid === "83") return page([top, album], [file]);
      if (cid === "42") {
        if (url.searchParams.get("offset") === "0") return page([top], [{ ...album, n: album.name }], 0, 2);
        return page([top], [{ ...file, cid: "42", n: "notes.txt" }], 1, 2);
      }
      return page([{ cid: "0", name: "Drive" }], []);
    }
    if (url.hostname === "cdn.115.com") return Response.redirect("https://media.115cdn.com/audio");
    assert.equal(url.hostname, "media.115cdn.com");
    if (mediaStatus === 403) return new Response("private upstream details", { status: 403 });
    const headersOut = { "accept-ranges": "bytes", "set-cookie": "private=x", "content-type": "application/octet-stream" };
    if (mediaStatus === 416) return new Response("discard", { status: 416, headers: { ...headersOut, "content-range": "bytes */10" } });
    const partial = mediaStatus === 206;
    const bytes = partial ? "345" : "0123456789";
    if (partial) headersOut["content-range"] = "bytes 3-5/10";
    return new Response(init.method === "HEAD" ? null : bytes, {
      status: mediaStatus, headers: { ...headersOut, "content-length": String(bytes.length) }
    });
  };
  return { calls, fetcher };
}

test("public extension discovery and authenticated GET / form POST", async () => {
  const extensions = await handle(new Request("https://worker.example/rest/getOpenSubsonicExtensions?f=json"), {});
  assert.equal((await json(extensions)).openSubsonicExtensions[0].name, "formPost");
  const f = fixture();
  const body = new URLSearchParams(params);
  assert.equal((await json(await handle(new Request("https://worker.example/rest/ping.view", { method: "POST", body }), env))).status, "ok");
  assert.equal((await json(await handle(request("getMusicFolders"), env))).musicFolders.musicFolder[0].id, 1);
  assert.equal((await json(await handle(request("getIndexes", { t: "wrong" }), env, f.fetcher))).error.code, 40);
  const unconfigured = await handle(request("getIndexes"), { ...env, DRIVE115_ROOT_CID: "" }, f.fetcher);
  assert.equal(unconfigured.status, 503);
  assert.equal(f.calls.length, 0);
});

test("directory pages are fully consumed, only directories and music are listed", async () => {
  const { calls, fetcher } = fixture();
  const result = await json(await handle(request("getIndexes.view"), env, fetcher));
  assert.deepEqual(result.indexes.index[0].artist, [{ id: "d-83", name: "Album & Friends" }]);
  assert.equal(result.indexes.child.length, 0);
  assert.deepEqual(calls.map(({ url }) => url.searchParams.get("offset")), ["0", "1"]);
  const xml = await handle(request("getMusicDirectory", { id: "d-83", f: "xml" }), env, fetcher);
  assert.match(await xml.text(), /title="A &amp; B"/);
});

test("the Worker entry point calls native fetch with its required receiver", async t => {
  const { fetcher } = fixture();
  t.mock.method(globalThis, "fetch", function (url, init) {
    assert.equal(this, globalThis);
    return fetcher(url, init);
  });
  const result = await json(await worker.fetch(request("getIndexes"), env));
  assert.equal(result.indexes.index[0].artist[0].id, "d-83");
  const response = await worker.fetch(request("stream", { id: "s-" + file.fid }, {
    headers: { range: "bytes=3-5" }
  }), env);
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "345");
});

test("numeric 115 IDs survive beyond 53 bits", async () => {
  const raw = '{"state":true,"path":[{"cid":42,"name":"Music"}],"count":1,"offset":0,"data":[{"fid":90071992547409939,"cid":42,"n":"L.m4a","s":3}]}';
  const r = await json(await handle(request("getMusicDirectory", { id: "d-42" }), env, async () => new Response(raw)));
  assert.equal(r.directory.child[0].id, "s-90071992547409939");
});

test("a folder outside the selected root or an upstream fallback to root is inaccessible", async () => {
  for (const path of [[{ cid: "0" }], [{ cid: "0" }, { cid: "8" }]]) {
    const r = await json(await handle(request("getMusicDirectory", { id: "d-8" }), env, async () => page(path, [])));
    assert.equal(r.error.code, 70);
  }
});

test("a moved song is checked against its current parent before the URL lookup", async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url.pathname);
    return url.pathname === "/files/get_info" ? Response.json({ state: true, data: [{ ...file, cid: "99" }] })
      : page([{ cid: "0" }, { cid: "99" }], []);
  };
  const r = await json(await handle(request("stream", { id: "s-" + file.fid }), env, fetcher));
  assert.equal(r.error.code, 70);
  assert.deepEqual(calls, ["/files/get_info", "/files"]);
});

test("upstream errors omit session and response content", async () => {
  const r = await handle(request("getIndexes"), env, async () => Response.json({ state: false, errno: 99, message: env.DRIVE115_COOKIE }));
  assert.equal(r.status, 502);
  assert.match((await json(r)).error.message, /^115 rejected \/files \(99\)\. Check the Cookie and file access\.$/);
});

test("directory errors identify the failing stage without returning upstream data", async () => {
  const privateText = "private-upstream-detail";
  const broken = () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(privateText)); }
  }));
  for (const [fetcher, message] of [
    [() => { throw new Error(privateText); }, "No HTTP response from 115 /files."],
    [broken, "Could not read the body of 115 /files (HTTP 200)."],
    [() => new Response("<html>" + privateText), "115 /files returned invalid JSON (HTTP 200)."],
    [() => Response.json(null), "115 /files returned an unexpected JSON value (HTTP 200)."]
  ]) {
    const response = await handle(request("getIndexes"), env, fetcher);
    assert.equal(response.status, 502);
    assert.equal((await json(response)).error.message, message);
  }
});

test("Range and If-Range reach the media host; only the ticket reaches the first CDN", async () => {
  const { calls, fetcher } = fixture();
  const r = await handle(request("stream.view", { id: "s-" + file.fid }, {
    headers: { range: "bytes=3-5", "if-range": '"v1"', authorization: "client-secret" }
  }), env, fetcher);
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 3-5/10");
  assert.equal(r.headers.get("content-type"), "audio/flac");
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal(await r.text(), "345");
  assert.equal(calls.at(-2).headers.get("cookie"), ticket);
  assert.equal(calls.at(-1).headers.get("cookie"), null);
  assert.equal(calls.at(-1).headers.get("authorization"), null);
  assert.equal(calls.at(-1).headers.get("range"), "bytes=3-5");
  assert.equal(calls.at(-1).headers.get("if-range"), '"v1"');
  assert.equal(calls[0].headers.get("user-agent"), calls.at(-1).headers.get("user-agent"));
});

test("full GET, HEAD and unsatisfiable ranges preserve the media response semantics", async () => {
  for (const [method, status] of [["GET", 200], ["HEAD", 200], ["GET", 416], ["GET", 403]]) {
    const { fetcher, calls } = fixture(status);
    const r = await handle(request("stream", { id: "s-" + file.fid }, { method }), env, fetcher);
    assert.equal(calls.at(-1).init.method, method);
    assert.equal(r.status, status === 403 ? 502 : status);
    if (status === 416) assert.equal(r.headers.get("content-range"), "bytes */10");
    if (method === "HEAD" || status === 416) assert.equal(r.body, null);
    if (method === "GET" && status === 200) assert.equal(await r.text(), "0123456789");
  }
});
