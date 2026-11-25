const HEX_64 = /^[0-9a-f]{64}$/i;

export function pubkeyToBase36(pubkey: string): string {
  const clean = pubkey.trim().toLowerCase();
  if (!HEX_64.test(clean)) return "";
  return BigInt(`0x${clean}`).toString(36).padStart(50, "0");
}

export function buildCommunityNsiteUrl(
  ownerPubkey: string,
  name: "call" | "stream",
  gateway = "nsite.run",
): string {
  const b36 = pubkeyToBase36(ownerPubkey);
  if (!b36) return "";
  return `https://${b36}${name}.${gateway}/`;
}
