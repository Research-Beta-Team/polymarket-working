import { keccak256, getCreate2Address, encodePacked, type Address } from "viem";

// Polymarket Polygon Proxy Contract Addresses
export const PROXY_FACTORY = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052" as Address;
export const RELAY_HUB = "0xD216153c06E857cD7f72665E0aF1d7D82172F494" as Address;
export const PROXY_INIT_CODE_HASH = "0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b" as `0x${string}`;

/**
 * Derive Polymarket Non-Safe Proxy Wallet address from EOA address
 * Uses CREATE2 deterministic address generation
 */
export function deriveProxyAddress(eoaAddress: string): string {
  return getCreate2Address({
    bytecodeHash: PROXY_INIT_CODE_HASH,
    from: PROXY_FACTORY,
    salt: keccak256(encodePacked(["address"], [eoaAddress.toLowerCase() as Address])),
  });
}
