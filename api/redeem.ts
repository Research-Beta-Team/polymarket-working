import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, providers, Contract } from 'ethers';
import { keccak256, getCreate2Address, encodePacked } from 'viem';

const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052' as const;
const PROXY_INIT_CODE_HASH = '0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b' as const;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const PARENT_COLLECTION_ID = '0x' + '0'.repeat(64);

function deriveProxyAddress(eoaAddress: string): string {
  return getCreate2Address({
    bytecodeHash: PROXY_INIT_CODE_HASH,
    from: PROXY_FACTORY,
    salt: keccak256(encodePacked(['address'], [eoaAddress.toLowerCase() as `0x${string}`])),
  });
}

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];

const PROXY_ABI = [
  'function execute(address destination, uint256 value, bytes memory data)',
];

function normalizeConditionId(conditionId: string): string {
  const hex = conditionId.startsWith('0x') ? conditionId.slice(2) : conditionId;
  return '0x' + hex.padStart(64, '0').slice(-64);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const privateKey = process.env.POLYMARKET_MAGIC_PK;
  if (!privateKey) {
    return res.status(500).json({ error: 'Wallet not configured. Set POLYMARKET_MAGIC_PK.' });
  }

  const body = req.body as { conditionId?: string; indexSet?: number };
  const conditionId = body?.conditionId;
  const indexSet = body?.indexSet;
  if (typeof conditionId !== 'string' || conditionId.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid conditionId' });
  }
  if (typeof indexSet !== 'number' || (indexSet !== 1 && indexSet !== 2)) {
    return res.status(400).json({ error: 'indexSet must be 1 (YES) or 2 (NO)' });
  }

  try {
    const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL);
    const wallet = new Wallet(privateKey, provider);
    const proxyAddress = deriveProxyAddress(wallet.address.toLowerCase());

    const conditionIdBytes32 = normalizeConditionId(conditionId);
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, provider);
    const redeemCalldata = ctf.interface.encodeFunctionData('redeemPositions', [
      USDC_E_ADDRESS,
      PARENT_COLLECTION_ID,
      conditionIdBytes32,
      [indexSet],
    ]);

    const proxy = new Contract(proxyAddress, PROXY_ABI, wallet);
    const tx = await proxy.execute(CTF_ADDRESS, 0, redeemCalldata);
    const receipt = await tx.wait();

    const success = receipt?.status === 1;
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      success,
      transactionHash: receipt?.transactionHash,
      amount: undefined,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Redeem API] Error:', message);
    return res.status(500).json({
      error: 'Redeem failed',
      message: message,
    });
  }
}
