import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

const encode = (buffer: Buffer) => buffer.toString('base64');
const decode = (value: string) => Buffer.from(value, 'base64');

export const hashPassword = async (password: string) => {
  const salt = randomBytes(16);
  const hash = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derived) => {
        if (err) reject(err);
        else resolve(derived as Buffer);
      }
    );
  });

  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    encode(salt),
    encode(hash),
  ].join('$');
};

export const verifyPassword = async (password: string, stored: string) => {
  const [scheme, n, r, p, saltEncoded, hashEncoded] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  if (!n || !r || !p || !saltEncoded || !hashEncoded) return false;

  const salt = decode(saltEncoded);
  const expected = decode(hashEncoded);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      expected.length,
      { N: Number(n), r: Number(r), p: Number(p) },
      (err, result) => {
        if (err) reject(err);
        else resolve(result as Buffer);
      }
    );
  });

  return timingSafeEqual(expected, derived);
};
