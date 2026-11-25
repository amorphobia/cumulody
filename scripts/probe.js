import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

async function main() {
  const base = new URL(process.argv[2] || "http://127.0.0.1:8787");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) {
    throw new Error("Use HTTPS or a local Worker.");
  }
  const { SUBSONIC_USER: user, SUBSONIC_PASSWORD: password } = process.env;
  if (!user || !password) throw new Error("Set SUBSONIC_USER and SUBSONIC_PASSWORD first.");

  function call(endpoint, params = {}, headers = {}) {
    const salt = randomBytes(16).toString("hex");
    const token = createHash("md5").update(password + salt).digest("hex");
    const body = new URLSearchParams({ u: user, t: token, s: salt, c: "cumulody-probe", v: "1.16.1", f: "json", ...params });
    return fetch(new URL("/rest/" + endpoint, base), { method: "POST", body, headers, redirect: "error" });
  }
  async function api(endpoint, params) {
    const response = await call(endpoint, params);
    const result = (await response.json())["subsonic-response"];
    if (!response.ok || result?.status !== "ok") {
      throw new Error(`${endpoint}: ${result?.error?.message || response.status}`);
    }
    return result;
  }

  await api("ping");
  const { indexes } = await api("getIndexes", { musicFolderId: "1" });
  const dirs = indexes.index.flatMap(group => group.artist);
  console.log(`Music root: ${dirs.length} folders, ${indexes.child.length} tracks`);
  let track = process.argv[3] ? (await api("getSong", { id: process.argv[3] })).song : indexes.child[0];
  const seen = new Set();
  while (!track && dirs.length) {
    const { id } = dirs.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const { directory } = await api("getMusicDirectory", { id });
    track = directory.child.find(item => !item.isDir);
    dirs.push(...directory.child.filter(item => item.isDir));
  }
  if (!track || !(track.size > 1)) throw new Error("Select a test folder with a nonempty audio file, or pass a song ID.");
  console.log(`Track: ${track.id}  ${track.title}  (${track.size} bytes)`);
  for (const offset of [0, Math.floor(track.size / 2)]) {
    const range = `bytes=${offset}-${offset}`;
    const response = await call("stream", { id: track.id, format: "raw" }, { range });
    if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${offset}-${offset}/${track.size}`) {
      const detail = response.headers.get("content-type")?.includes("application/json")
        ? (await response.json())["subsonic-response"]?.error?.message : "";
      await response.body?.cancel().catch(() => {});
      throw new Error(`${range}: expected HTTP 206 and a matching Content-Range; got ${response.status}. ${detail || ""}`);
    }
    assert.equal((await response.arrayBuffer()).byteLength, 1);
    console.log(`HTTP 206  ${response.headers.get("content-range")}`);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
