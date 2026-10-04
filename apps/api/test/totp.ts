import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("секрет не в base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Код приложения-аутентификатора по RFC 6238: HMAC-SHA1, шаг 30 с, 6 цифр. */
export function totp(secret: string, timeMs = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (hmac.at(-1) ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

/** Секрет из ссылки otpauth://, которую показывают QR-кодом при включении 2FA. */
export function secretFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("в ссылке нет секрета");
  return secret;
}
