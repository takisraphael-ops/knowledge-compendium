// AES-GCM with a PBKDF2-SHA-256 key. The same module runs in the browser
// (global crypto) and in Node 20+ so ciphertext written by tools/encrypt
// decrypts with Web Crypto and nothing else.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const DEFAULT_ITERATIONS = 600_000;
export const EDITS_AAD = "kc-edits-v1";

export function bytesToB64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== "undefined" && typeof window === "undefined") {
    return Buffer.from(u).toString("base64");
  }
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < u.length; i += step) {
    s += String.fromCharCode(...u.subarray(i, i + step));
  }
  return btoa(s);
}

export function b64ToBytes(b64) {
  if (typeof Buffer !== "undefined" && typeof window === "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export async function deriveKey(passphrase, salt, iterations, extractable = true) {
  const material = await subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"]
  );
}

export async function importRawKey(raw) {
  const bytes = raw instanceof Uint8Array ? raw : b64ToBytes(raw);
  return subtle.importKey("raw", bytes, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportRawKey(key) {
  const raw = await subtle.exportKey("raw", key);
  return bytesToB64(raw);
}

async function transformBytes(stream, bytes) {
  // Start reading before writing so a large payload cannot deadlock on backpressure.
  const dest = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return new Uint8Array(await dest);
}

async function deflateBytes(bytes) {
  return transformBytes(new CompressionStream("deflate"), bytes);
}

async function inflateBytes(bytes) {
  return transformBytes(new DecompressionStream("deflate"), bytes);
}

export async function encryptJson(key, value, aad, opts = {}) {
  const iv = randomBytes(12);
  let plain = encoder.encode(JSON.stringify(value));
  const compress = Boolean(opts.compress);
  if (compress) plain = await deflateBytes(plain);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    plain
  );
  const out = { v: 1, alg: "AES-GCM", iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(ct)) };
  if (compress) out.comp = "deflate";
  return out;
}

export async function decryptJson(key, payload, aad) {
  const iv = b64ToBytes(payload.iv);
  const ct = b64ToBytes(payload.ciphertext);
  let plain = await subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    ct
  );
  if (payload.comp === "deflate") {
    plain = await inflateBytes(new Uint8Array(plain));
  } else if (payload.comp) {
    throw new Error(`Unsupported ciphertext compression: ${payload.comp}`);
  }
  return JSON.parse(decoder.decode(plain));
}

export async function encryptUtf8(key, text, aad) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(text)
  );
  return { v: 1, iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(ct)) };
}

export async function decryptUtf8(key, payload, aad) {
  const plain = await subtle.decrypt(
    {
      name: "AES-GCM",
      iv: b64ToBytes(payload.iv),
      additionalData: encoder.encode(aad),
    },
    key,
    b64ToBytes(payload.ciphertext)
  );
  return decoder.decode(plain);
}
