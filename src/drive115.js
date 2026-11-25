import { ApiError } from "./subsonic.js";

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

  async api(path, query) {
    const url = new URL(path, "https://webapi.115.com");
    url.search = new URLSearchParams(query);
    let response;
    try {
      response = await this.fetcher(url, {
        headers: { cookie: this.cookie, referer, "user-agent": userAgent },
        redirect: "manual"
      });
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
      const code = String(data.errno ?? data.errNo ?? data.errcode ?? data.code ?? "");
      throw upstream(`115 rejected ${path}${/^\d+$/.test(code) ? " (" + code + ")" : ""}. Check the Cookie and file access.`);
    }
    return { data, headers: response.headers };
  }

  async page(cid, offset, limit) {
    const { data } = await this.api("/files", {
      cid, aid: "1", cur: "1", show_dir: "1", count_folders: "1", record_open_time: "0",
      offset, limit, o: "file_name", asc: "1", custom_order: "2"
    });
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
    const { data } = await this.api("/files/get_info", { file_id: fid });
    const row = data.data?.[0];
    if (!row || String(row.fid) !== fid || (row.aid != null && String(row.aid) !== "1") ||
        !numericId.test(String(row.cid))) throw notFound();
    const item = entry(row);
    if (!item || item.isDir || !row.pc) throw notFound();
    await this.page(String(row.cid), 0, 1);
    return { item, pickcode: row.pc };
  }

  async stream(song, request) {
    const query = { pickcode: song.pickcode };
    try {
      const { data, headers } = await this.api("/files/music", { ...query, play_origin: "1" });
      const info = data.data ?? data;
      const source = typeof info === "string" ? info : info.file_url ?? info.url ?? info.audio_url;
      return await this.serveMedia(mediaUrl(source), headers, song.item, request);
    } catch (musicError) {
      if (request.signal.aborted || !(musicError instanceof ApiError)) throw musicError;
      try {
        const { data, headers } = await this.api("/files/download", query);
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
