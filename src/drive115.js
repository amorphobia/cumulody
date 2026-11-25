import { ApiError } from "./subsonic.js";
import { createHmac } from "node:crypto";

const types = new Map(Object.entries({
  flac: "audio/flac", mp3: "audio/mpeg", m4a: "audio/mp4", m4b: "audio/mp4",
  aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav",
  aif: "audio/aiff", aiff: "audio/aiff", ape: "audio/ape", alac: "audio/mp4",
  wv: "audio/wavpack", wma: "audio/x-ms-wma"
}));
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const referer = "https://115.com/";
const redirects = new Set([301, 302, 303, 307, 308]);
const numericId = /^[1-9]\d*$/;
const notFound = () => new ApiError(70, "Music item not found.");
const upstream = message => new ApiError(0, message, 502);

// Keep human-readable Chinese and common English status words. Never echo arbitrary
// ASCII tokens (account identifiers, tickets and URL parameters can look like words).
const diagnosticWords = new Set(("115 app vip svip ip api http https web pc browser client url " +
  "account access address authentication authorization bad blocked busy cannot check code denied " +
  "download error expired failed file forbidden format from get illegal in invalid is it limit link login " +
  "mismatch missing network no not of on only or parameter permission play please region request required restricted " +
  "retry server service session sign source temporarily the time timeout to too unavailable " +
  "unknown unsupported user valid verification wrong your").split(" "));

function playbackReason(text, cookie, pickcode) {
  const secrets = cookie.split(";").map(pair => pair.slice(pair.indexOf("=") + 1).trim());
  for (const value of [pickcode, ...secrets]) {
    if (value) text = text.replaceAll(value, "…");
  }
  const excerpt = text.replace(/<[^>]*>/g, " ")
    .replace(/(?:https?:)?\/\/[^\s<>"'，。；！？]+/gi, "…")
    .replace(/[^\p{Script=Han}\s，。！？：；、（）…]+/gu, token => {
      const word = token.replace(/[.,!?:;]+$/, "");
      return diagnosticWords.has(word.toLowerCase()) ? word : "…";
    })
    .replace(/…(?:\s*…)+/g, "…").replace(/\s+/g, " ").trim();
  return excerpt.length > 160 ? excerpt.slice(0, 159) + "…" : excerpt;
}

function rejectionDetails(data, diagnostic) {
  // 115 uses several spellings and may return errno=0 alongside a nonzero code.
  const fields = [];
  for (const key of ["errno", "errNo", "errcode", "errCode", "code", "msg_code"]) {
    const value = data[key];
    if ((typeof value === "number" || typeof value === "string") && /^-?\d{1,9}$/.test(value)) {
      fields.push(key + "=" + value);
    }
  }
  let state = "unrecognized";
  if (!Object.hasOwn(data, "state")) state = "missing";
  else if ([false, 0, "0", "false"].includes(data.state)) state = "false";
  fields.unshift("state=" + state);

  const messages = [data.error, data.msg, data.error_msg, data.message]
    .filter(value => typeof value === "string" && value.trim());
  const text = [...new Set(messages)].join(" ");
  const reasons = [
    [/重新登[录陆]|未登[录陆]|登[录陆].{0,6}(过期|超时)/, "115 requested login."],
    [/验证(码|账号|身份)|安全验证/, "115 requested verification."],
    [/(使用|打开|升级|前往|请在).{0,20}(客户端|浏览器|115生活|115APP)/i, "115 requested its client."],
    [/暂不支持播放|不支持.{0,8}(格式|播放)|不支持的.{0,8}格式/, "115 reported unsupported playback."],
    [/文件不存在|文件已删除/, "115 reported that the file is unavailable."],
    [/参数错误|无效参数/, "115 reported invalid parameters."],
    [/操作太频繁|请求过于频繁/, "115 reported a rate limit."]
  ];
  const reason = reasons.find(([pattern]) => pattern.test(text))?.[1];
  if (!reason && text && diagnostic) {
    const excerpt = playbackReason(text, diagnostic.cookie, diagnostic.pickcode);
    return "(" + fields.join(", ") + "). 115 message: " + (excerpt || "…");
  }
  return "(" + fields.join(", ") + "). " +
    (reason ?? (text ? "115 supplied an unrecognized reason." : "115 supplied no reason text."));
}

function entry(row) {
  const isDir = row.fc == null ? !row.fid || row.fid === "0" : String(row.fc) === "0";
  const id = String(isDir ? row.cid : row.fid);
  const name = row.n ?? row.fn ?? row.file_name;
  if (!numericId.test(id) || typeof name !== "string") return null;
  if (isDir) return { id: "d-" + id, parent: "d-" + row.pid, isDir, title: name };
  const dot = name.lastIndexOf(".");
  const suffix = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  const contentType = types.get(suffix);
  if (!contentType) return null;
  const size = Number(row.s);
  return {
    id: "s-" + id, parent: "d-" + row.cid, isDir, title: name.slice(0, dot),
    suffix, contentType, type: "music",
    ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {})
  };
}

function mediaUrl(value, base) {
  if (typeof value !== "string" || !value) throw upstream("115 returned an empty media URL.");
  if (!URL.canParse(value, base)) throw upstream("115 returned an invalid media URL.");
  const url = new URL(value, base);
  if (!/^(https?:)$/.test(url.protocol) || url.username || url.password || url.port ||
      !/(^|\.)(115\.com|115cdn\.com|115cdn\.net|anxia\.com)$/.test(url.hostname)) {
    throw upstream("115 returned an unrecognized media host.");
  }
  url.protocol = "https:";
  return url;
}

export class Drive115 {
  constructor(env, fetcher) {
    if (!env.DRIVE115_COOKIE || !numericId.test(env.DRIVE115_ROOT_CID ?? "")) {
      throw new ApiError(0, "Configure the 115 Cookie and music folder CID.", 503);
    }
    this.cookie = env.DRIVE115_COOKIE;
    this.root = String(env.DRIVE115_ROOT_CID);
    this.fetcher = fetcher;
  }

  webRequest(path, query) {
    const url = new URL(path, "https://webapi.115.com");
    url.search = new URLSearchParams(query);
    return { url, init: {
      method: "GET", headers: { cookie: this.cookie, referer, "user-agent": userAgent }, redirect: "manual"
    } };
  }

  musicRequest(pickcode) {
    return this.webRequest("/files/music", {
      pick_code: pickcode, play_origin: "1", platform: "weixin", format: "json"
    });
  }

  playbackProofs(salt, pickcode) {
    const { url, init } = this.musicRequest(pickcode);
    const headers = new Headers(init.headers);
    const cookie = headers.get("cookie");
    headers.delete("cookie");
    const sign = (...fields) => createHmac("sha256", cookie)
      .update(JSON.stringify(["cumulody-playback-check-v1", salt, ...fields])).digest("hex");
    return {
      cookieProof: sign("cookie"),
      musicProof: sign("music", init.method, url.href, [...headers], init.redirect)
    };
  }

  async api({ url, init }, diagnostic) {
    const path = url.pathname;
    let response;
    try {
      response = await this.fetcher(url, init);
    } catch {
      throw upstream(`No HTTP response from 115 ${path}.`);
    }
    // The web music player can receive a redirect in place of a JSON playback URL.
    if (path === "/files/music" && redirects.has(response.status)) {
      await response.body?.cancel();
      const target = mediaUrl(response.headers.get("location"), url);
      return { data: { file_url: target.href }, headers: response.headers };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw upstream(`115 ${path} returned HTTP ${response.status}.`);
    }
    const body = await response.text().catch(() => {
      throw upstream(`Could not read the body of 115 ${path} (HTTP ${response.status}).`);
    });
    let data;
    try {
      // Some 115 responses encode IDs as bare integers beyond JS's safe range.
      data = JSON.parse(body, (key, value, context) => {
        if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source) return context.source;
        return value;
      });
    } catch {
      throw upstream(`115 ${path} returned invalid JSON (HTTP ${response.status}).`);
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw upstream(`115 ${path} returned an unexpected JSON value (HTTP ${response.status}).`);
    }
    if (![true, 1, "1"].includes(data.state)) {
      throw upstream(`115 did not confirm success for ${path} ${rejectionDetails(data, diagnostic)}`);
    }
    return { data, headers: response.headers };
  }

  async page(cid, offset, limit) {
    const { data } = await this.api(this.webRequest("/files", {
      cid, aid: "1", cur: "1", show_dir: "1", count_folders: "1", record_open_time: "0",
      offset, limit, o: "file_name", asc: "1", custom_order: "2"
    }));
    // An invalid CID may silently list the drive root. Verify the actual path on every page.
    const path = data.path;
    if (!Array.isArray(path) || String(path.at(-1)?.cid) !== cid ||
        !path.some(folder => String(folder.cid) === this.root)) throw notFound();
    if (!Array.isArray(data.data) || Number(data.offset) !== offset ||
        !Number.isSafeInteger(Number(data.count)) || Number(data.count) < 0) {
      throw upstream("Unexpected 115 directory page.");
    }
    return { path, rows: data.data, count: Number(data.count) };
  }

  async directory(cid) {
    const child = [];
    let offset = 0;
    for (;;) {
      const { path, rows, count } = await this.page(cid, offset, 500);
      for (const row of rows) {
        const item = entry(row);
        if (item?.parent === "d-" + cid) child.push(item);
      }
      offset += rows.length;
      if (offset >= count) {
        return { id: "d-" + cid, name: path.at(-1).name, child,
          ...(cid === this.root ? {} : { parent: "d-" + path.at(-2).cid }) };
      }
      if (!rows.length) throw upstream("The 115 directory changed during pagination. Retry browsing.");
    }
  }

  async song(fid) {
    const { data } = await this.api(this.webRequest("/files/get_info", { file_id: fid }));
    const row = data.data?.[0];
    if (!row || String(row.fid) !== fid || (row.aid != null && String(row.aid) !== "1") ||
        !numericId.test(String(row.cid))) throw notFound();
    const item = entry(row);
    if (!item || item.isDir || !row.pc) throw notFound();
    await this.page(String(row.cid), 0, 1);
    return { item, pickcode: row.pc };
  }

  async stream(song, request, explainRejection = false) {
    const diagnostic = explainRejection ? { cookie: this.cookie, pickcode: song.pickcode } : undefined;
    try {
      // Parameters used by the 115 web audio player for a personal drive track.
      const { data, headers } = await this.api(this.musicRequest(song.pickcode), diagnostic);
      const info = data.data ?? data;
      const source = [data.url, data.audio_url, info.file_url, info.url, info.audio_url, info]
        .find(value => typeof value === "string" && value.length > 0);
      return await this.serveMedia(mediaUrl(source), headers, song.item, request);
    } catch (musicError) {
      if (request.signal.aborted || !(musicError instanceof ApiError)) throw musicError;
      try {
        const { data, headers } = await this.api(this.webRequest("/files/download", { pickcode: song.pickcode }), diagnostic);
        return await this.serveMedia(mediaUrl((data.data ?? data).file_url), headers, song.item, request);
      } catch (downloadError) {
        if (!(downloadError instanceof ApiError)) throw downloadError;
        throw upstream(`Music playback: ${musicError.message} File download: ${downloadError.message}`);
      }
    }
  }

  async serveMedia(url, lookupHeaders, item, request) {
    const origin = url.origin;
    const cookies = typeof lookupHeaders.getSetCookie === "function"
      ? lookupHeaders.getSetCookie() : lookupHeaders.getAll("Set-Cookie");
    // 115 may issue a short-lived download cookie in addition to the signed URL.
    const ticket = cookies.map(cookie => cookie.split(";")[0].trim())
      .find(cookie => /^[a-f0-9]{32}=[a-f0-9]{32}$/i.test(cookie));
    for (let hop = 0; hop <= 5; hop++) {
      const headers = new Headers({ "user-agent": userAgent, referer, "accept-encoding": "identity" });
      if (ticket && url.origin === origin) headers.set("cookie", ticket);
      for (const key of ["range", "if-range"]) {
        if (request.headers.has(key)) headers.set(key, request.headers.get(key));
      }
      let response;
      try {
        response = await this.fetcher(url, {
          headers, redirect: "manual", method: request.method === "HEAD" ? "HEAD" : "GET", signal: request.signal
        });
      } catch {
        throw upstream("No HTTP response from the 115 media host.");
      }
      if (redirects.has(response.status)) {
        await response.body?.cancel();
        url = mediaUrl(response.headers.get("location"), url);
        continue;
      }
      if (![200, 206, 416].includes(response.status) ||
          (response.status !== 416 && /text\/html|application\/json/i.test(response.headers.get("content-type") ?? ""))) {
        await response.body?.cancel();
        throw upstream(`115 media request failed (HTTP ${response.status}).`);
      }
      const output = new Headers({ "cache-control": "private, no-store" });
      for (const key of ["accept-ranges", "content-range", "etag", "last-modified"]) {
        if (response.headers.has(key)) output.set(key, response.headers.get(key));
      }
      if (response.status === 416) {
        await response.body?.cancel();
        return new Response(null, { status: 416, headers: output });
      }
      const length = response.headers.get("content-length");
      const total = response.status === 200 ? length :
        /^bytes \d+-\d+\/(\d+)$/i.exec(output.get("content-range"))?.[1];
      if (total != null && item.size != null && Number(total) !== item.size) {
        await response.body?.cancel();
        throw upstream("115 returned media with a different size from the original file.");
      }
      if (length !== null) output.set("content-length", length);
      output.set("content-type", item.contentType);
      return new Response(response.body, { status: response.status, headers: output });
    }
    throw upstream("Too many media redirects.");
  }
}
