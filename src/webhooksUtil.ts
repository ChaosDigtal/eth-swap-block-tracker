import { NextFunction } from "express";
import { Request, Response } from "express-serve-static-core";
import axios from 'axios';
import * as crypto from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { Web3 } from 'web3'
import Decimal from 'decimal.js'
import { Client } from 'pg';
import Moralis from 'moralis';

export interface AlchemyRequest extends Request {
  alchemy: {
    rawBody: string;
    signature: string;
  };
}

export function isValidSignatureForAlchemyRequest(
  request: AlchemyRequest,
  signingKey: string
): boolean {
  return isValidSignatureForStringBody(
    request.alchemy.rawBody,
    request.alchemy.signature,
    signingKey
  );
}

export function isValidSignatureForStringBody(
  body: string,
  signature: string,
  signingKey: string
): boolean {
  const hmac = crypto.createHmac("sha256", signingKey); // Create a HMAC SHA256 hash using the signing key
  hmac.update(body, "utf8"); // Update the token hash with the request body using utf8
  const digest = hmac.digest("hex");
  return signature === digest;
}

export function addAlchemyContextToRequest(
  req: IncomingMessage,
  _res: ServerResponse,
  buf: Buffer,
  encoding: BufferEncoding
): void {
  const signature = req.headers["x-alchemy-signature"];
  // Signature must be validated against the raw string
  var body = buf.toString(encoding || "utf8");
  (req as AlchemyRequest).alchemy = {
    rawBody: body,
    signature: signature as string,
  };
}

export function validateAlchemySignature(signingKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isValidSignatureForAlchemyRequest(req as AlchemyRequest, signingKey)) {
      const errMessage = "Signature validation failed, unauthorized!";
      res.status(403).send(errMessage);
      throw new Error(errMessage);
    } else {
      next();
    }
  };
}

var tokenIDMap = new Map<string, string>();

export const getTokenIDMap = async (token_address: string) => {
  if (tokenIDMap.has(token_address))
    return tokenIDMap.get(token_address);
  const response = JSON.stringify((await axios.get('https://s3.coinmarketcap.com/generated/core/crypto/cryptos.json')).data).toLowerCase();
  var pattern = new RegExp(`\\[([^\\[]*?),([^\\[]*?)\\[([^\\[]*?)${token_address.toLowerCase()}`);
  var ID = response.match(pattern);
  if (ID == null) {
    return null;
  }
  tokenIDMap.set(token_address, ID[1]);
  return ID[1];
}

export const getEthereumTokenUSD = async (token_address: string, block_timestamp: string) => {
  try {
    const ID = await getTokenIDMap(token_address);
    if (ID == null) {
      return null;
    }
    var response = ((await axios.get(`https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail/chart?id=${ID}&range=ALL`))).data.data.points;
    var timestamps = Object.keys(response).map(Number);
    timestamps.sort((a, b) => b - a);
    var nearestTimestamp = timestamps.find(ts => ts <= parseInt(block_timestamp));
    if (nearestTimestamp !== undefined) {
      return new Decimal(response[nearestTimestamp]['v'][0]); // USD price at 'v'[0]
    } else {
      return new Decimal(response[timestamps[timestamps.length - 1]]['v'][0]);
    }
  } catch (e) {
    console.error(e);
    return null;
  }
}

function addEdge(graph: Map<string, string[]>, A: string, B: string, ratio: Decimal) {
  if (graph.has(A)) {
    graph.get(A)!.push({ symbol: B, ratio: ratio });
  } else {
    graph.set(A, [{ symbol: B, ratio: ratio }]);
  }
}

export async function fillUSDAmounts(swapEvents: {}[], client: Client, web3: Web3) {
  if (swapEvents.length == 0) return;

  const block_timestamp = (await web3.eth.getBlock(swapEvents[0].blockNumber)).timestamp;
  const block_creation_time = (new Date(parseInt(block_timestamp) * 1000)).toISOString();

  var graph = new Map<string, { symbol: string, ratio: Decimal }[]>()

  for (var se of swapEvents) {
    if (se.token0.symbol && se.token1.symbol) {
      addEdge(graph, se.token0.symbol, se.token1.symbol, se.token0.amount.dividedBy(se.token1.amount));
      addEdge(graph, se.token1.symbol, se.token0.symbol, se.token1.amount.dividedBy(se.token0.amount));
    }
  }

  const stack: string[] = ["GHO", "GRAI", "SEUR", "aUSDC", "BUSD", "GUSD", "CRVUSD", "EUSD", "aUSDT", "USDP", "TUSD", "MIM", "EURA", "TAI", "XAI", "USDD", "BOB", "PUSd", "EUSD", "DAI", "VEUR", "DOLA", "FRAX", "anyCRU", "anyETH", "MXNt", "LUSD", "SUSD", "USDC", "USDT", "WETH"];

  var symbol2USD = new Map<string, Decimal>();

  const ETH2USD = await getEthereumTokenUSD('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', block_timestamp);
  if (ETH2USD == null) {
    stack.pop();
  } else {
    symbol2USD.set("WETH", ETH2USD);
  }
  for (var i = 0; i < stack.length - 1; ++i) {
    symbol2USD.set(stack[i], new Decimal(1.0));
  }

  while (stack.length > 0) {
    const symbol = stack.pop();

    if (!graph.has(symbol)) continue;
    for (var right of graph.get(symbol)) {
      if (!symbol2USD.has(right.symbol)) {
        symbol2USD.set(right.symbol, symbol2USD.get(symbol).times(right.ratio));
        stack.push(right.symbol);
      }
    }
  }
  for (var i = 0; i < swapEvents.length; ++i) {
    if (symbol2USD.has(swapEvents[i].token0.symbol)) {
      swapEvents[i].token0.value_in_usd = symbol2USD.get(swapEvents[i].token0.symbol);
      swapEvents[i].token0.total_exchanged_usd = swapEvents[i].token0.value_in_usd.times(swapEvents[i].token0.amount);
      if (symbol2USD.has(swapEvents[i].token1.symbol)) {
        swapEvents[i].token1.value_in_usd = symbol2USD.get(swapEvents[i].token1.symbol);
        swapEvents[i].token1.total_exchanged_usd = swapEvents[i].token1.value_in_usd.times(swapEvents[i].token1.amount);
      }
    } else {
      stack.push(swapEvents[i].token0.symbol);
      const usdPrice = await getEthereumTokenUSD(swapEvents[i].token0.id, block_timestamp);
      if (usdPrice == null) {
        stack.pop();
        continue;
      }
      symbol2USD.set(swapEvents[i].token0.symbol, usdPrice);
      while (stack.length > 0) {
        const symbol = stack.pop();

        if (!graph.has(symbol)) continue;
        for (var right of graph.get(symbol)) {
          if (!symbol2USD.has(right.symbol)) {
            symbol2USD.set(right.symbol, symbol2USD.get(symbol).times(right.ratio));
            stack.push(right.symbol);
          }
        }
      }
    }
    if (symbol2USD.has(swapEvents[i].token0.symbol)) {
      swapEvents[i].token0.value_in_usd = symbol2USD.get(swapEvents[i].token0.symbol);
      swapEvents[i].token0.total_exchanged_usd = swapEvents[i].token0.value_in_usd.times(swapEvents[i].token0.amount);
      if (symbol2USD.has(swapEvents[i].token1.symbol)) {
        swapEvents[i].token1.value_in_usd = symbol2USD.get(swapEvents[i].token1.symbol);
        swapEvents[i].token1.total_exchanged_usd = swapEvents[i].token1.value_in_usd.times(swapEvents[i].token1.amount);
      }
    }
  }

  // Writing to DB
  for (const event of swapEvents) {
    const {
      blockNumber,
      blockHash,
      transactionHash,
      token0: { id: token0_id, symbol: token0_symbol, amount: token0_amount, value_in_usd: token0_value_in_usd, total_exchanged_usd: token0_total_exchanged_usd },
      token1: { id: token1_id, symbol: token1_symbol, amount: token1_amount, value_in_usd: token1_value_in_usd, total_exchanged_usd: token1_total_exchanged_usd },
    } = event;

    const query = `
      INSERT INTO swap_events (
        block_number,
        block_hash,
        transaction_hash,
        wallet_address,
        token0_id,
        token0_symbol,
        token0_amount,
        token0_value_in_usd,
        token0_total_exchanged_usd,
        token1_id,
        token1_symbol,
        token1_amount,
        token1_value_in_usd,
        token1_total_exchanged_usd,
        eth_price_usd,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `;

    const values = [
      blockNumber,
      blockHash,
      transactionHash,
      event.fromAddress,
      token0_id,
      token0_symbol,
      (token0_amount ?? 0).toString(),
      (token0_value_in_usd ?? 0).toString(),
      (token0_total_exchanged_usd ?? 0).toString(),
      token1_id,
      token1_symbol,
      (token1_amount ?? 0).toString(),
      (token1_value_in_usd ?? 0).toString(),
      (token1_total_exchanged_usd ?? 0).toString(),
      (ETH2USD ?? 0).toString(),
      block_creation_time
    ];

    try {
      await client.query(query, values);
    } catch (err) {
      console.error('Error saving event', err);
    }
  }

}

// Function to get the token addresses
export async function getPairTokenSymbols(web3: Web3, pairAddress: string) {
  const pairABI = [
    {
      "constant": true,
      "inputs": [],
      "name": "token0",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    },
    {
      "constant": true,
      "inputs": [],
      "name": "token1",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    }
  ];
  // Create a new contract instance with the pair address and ABI
  const pairContract = new web3.eth.Contract(pairABI, pairAddress);
  try {
    const token0 = await pairContract.methods.token0().call();
    const token1 = await pairContract.methods.token1().call();
    return { token0, token1 };
  } catch (error) {
    console.error("Error fetching pair tokens:", error);
    return null;
  }
}

export interface AlchemyWebhookEvent {
  webhookId: string;
  id: string;
  createdAt: Date;
  type: AlchemyWebhookType;
  event: Record<any, any>;
}

export function getCurrentTimeISOString(): string {
  const now = new Date();
  return now.toISOString();
}

export interface Token {
  id: string;
  symbol: string;
  decimal: number;
}

export interface PairToken {
  //pool_version: string;
  token0: Token;
  token1: Token;
}

export interface Row {
  From: string;
  To: string;
  Wallet_addresses: string[];
}

export type AlchemyWebhookType =
  | "MINED_TRANSACTION"
  | "DROPPED_TRANSACTION"
  | "ADDRESS_ACTIVITY";

