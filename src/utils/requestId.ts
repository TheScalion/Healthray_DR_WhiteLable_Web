import CryptoJS from 'crypto-js';

export const makeRequestId = (): string => {
  const timestamp = Date.now().toString();
  const salt = Math.random().toString(36).substring(2, 15);
  const hash = CryptoJS.SHA256(timestamp + salt);
  return hash.toString(CryptoJS.enc.Hex);
};
