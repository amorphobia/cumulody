import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";

export class ApiError extends Error {
  constructor(code, message, httpStatus = 200) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function authenticate(params, env) {
  if (!env.SUBSONIC_USER || !env.SUBSONIC_PASSWORD) {
    throw new ApiError(0, "Player credentials are not configured.", 503);
  }
  const salt = params.get("s");
  const token = params.get("t");
  if (!salt || !token) throw new ApiError(10, "Supply username, token and salt.");
  const expected = createHash("md5").update(env.SUBSONIC_PASSWORD + salt).digest();
  if (params.get("u") !== env.SUBSONIC_USER || !/^[a-f0-9]{32}$/i.test(token) ||
      !timingSafeEqual(expected, Buffer.from(token, "hex"))) {
    throw new ApiError(40, "Wrong username or password.");
  }
}

function attribute(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xml(name, value) {
  if (Array.isArray(value)) return value.map(item => xml(name, item)).join("");
  if (typeof value !== "object") return `<${name}>${attribute(value)}</${name}>`;
  const attrs = [];
  const children = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "object") children.push(xml(key, item));
    else attrs.push(` ${key}="${attribute(item)}"`);
  }
  return `<${name}${attrs.join("")}>${children.join("")}</${name}>`;
}

export function reply(format, payload = {}, status = 200) {
  const result = {
    status: payload.error ? "failed" : "ok",
    version: "1.16.1", type: "cumulody", serverVersion: "0.1.0", openSubsonic: true,
    ...payload
  };
  const headers = { "cache-control": "private, no-store" };
  if (format === "json") return Response.json({ "subsonic-response": result }, { status, headers });
  headers["content-type"] = "application/xml; charset=utf-8";
  return new Response(xml("subsonic-response", { xmlns: "http://subsonic.org/restapi", ...result }), { status, headers });
}
