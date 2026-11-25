import { Drive115 } from "./drive115.js";
import { ApiError, authenticate, reply } from "./subsonic.js";

function itemId(params, prefix) {
  const id = params.get("id");
  if (!id) throw new ApiError(10, "Supply an item ID.");
  if (!id.startsWith(prefix) || !/^[1-9]\d*$/.test(id.slice(2))) throw new ApiError(70, "Music item not found.");
  return id.slice(2);
}

function indexes(root) {
  const groups = new Map();
  const child = [];
  for (const item of root.child) {
    if (!item.isDir) {
      child.push(item);
      continue;
    }
    const letter = Array.from(item.title)[0]?.toUpperCase() || "#";
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push({ id: item.id, name: item.title });
  }
  const index = Array.from(groups, ([name, artist]) => ({ name, artist }));
  return { lastModified: Date.now(), ignoredArticles: "", index, child };
}

export async function handle(request, env, fetcher = globalThis.fetch.bind(globalThis)) {
  const url = new URL(request.url);
  const match = /^\/rest\/([A-Za-z0-9]+)(?:\.view)?$/.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });
  const endpoint = match[1];
  const params = url.searchParams;
  if (request.method !== "GET" && request.method !== "POST" &&
      !(endpoint === "stream" && request.method === "HEAD")) {
    return new Response(null, { status: 405, headers: { allow: endpoint === "stream" ? "GET, HEAD, POST" : "GET, POST" } });
  }
  try {
    if (request.method === "POST" && request.headers.get("content-type")?.split(";")[0] === "application/x-www-form-urlencoded") {
      for (const [key, value] of new URLSearchParams(await request.text())) params.set(key, value);
    }
    const format = params.get("f");
    if (endpoint === "getOpenSubsonicExtensions") {
      return reply(format, { openSubsonicExtensions: [{ name: "formPost", versions: [1] }] });
    }
    authenticate(params, env);
    if (endpoint === "ping") return reply(format);
    if (endpoint === "getMusicFolders") {
      return reply(format, { musicFolders: { musicFolder: [{ id: 1, name: "Music" }] } });
    }
    const drive = new Drive115(env, fetcher);
    switch (endpoint) {
      case "getIndexes": {
        if (params.has("musicFolderId") && params.get("musicFolderId") !== "1") throw new ApiError(70, "Music folder not found.");
        return reply(format, { indexes: indexes(await drive.directory(drive.root)) });
      }
      case "getMusicDirectory":
        return reply(format, { directory: await drive.directory(itemId(params, "d-")) });
      case "getSong": {
        const { item } = await drive.song(itemId(params, "s-"));
        return reply(format, { song: item });
      }
      case "stream":
        return await drive.stream(await drive.song(itemId(params, "s-")), request);
      default:
        throw new ApiError(0, "Endpoint not implemented.");
    }
  } catch (error) {
    const failure = error instanceof ApiError ? error : new ApiError(0, "Could not read the 115 response.", 502);
    return reply(params.get("f"), { error: { code: failure.code, message: failure.message } }, failure.httpStatus);
  }
}

export default { fetch: (request, env) => handle(request, env) };
