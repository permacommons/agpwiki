import { createChallenge, verifySolution } from 'altcha-lib';
import config from 'config';

const getHmacKey = (): string => {
  return config.get<string>('altcha.hmacKey');
};

const isEnabled = (): boolean => {
  return config.get<boolean>('altcha.enabled');
};

export async function createAltchaChallenge(): Promise<{
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}> {
  const hmacKey = getHmacKey();
  const challenge = await createChallenge({
    hmacKey,
    maxNumber: 100000,
  });
  return {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    signature: challenge.signature,
    maxnumber: challenge.maxnumber,
  };
}

export async function verifyAltchaSolution(payload: string): Promise<boolean> {
  if (!isEnabled()) {
    return true;
  }
  if (!payload) {
    return false;
  }
  const hmacKey = getHmacKey();
  return verifySolution(payload, hmacKey);
}

export { isEnabled as isAltchaEnabled };
