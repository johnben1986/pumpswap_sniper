import dotenv from "dotenv"
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  TransactionMessage,
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionInstruction,
} from "@solana/web3.js"
import BN from 'bn.js';
import { PumpFunSDK} from "pumpdotfun-sdk"
import { AnchorProvider, Wallet } from "@coral-xyz/anchor"
import bs58 from "bs58"
import {
  getTokenAccounts,
} from './liquidity';
import { MintLayout } from "./types";
import {
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import {ErrorEvent, WebSocket} from "ws";
import { PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import pino from 'pino';
  const transport = pino.transport({
    targets: [
      {
        level: 'trace',
        target: 'pino-pretty',
        options: {},
      },
    ],
  });
  
  export const logger = pino(
    {
      redact: ['poolKeys'],
      serializers: {
        error: pino.stdSerializers.err,
      },
      base: undefined,
    },
    transport,
  );

dotenv.config();
// config area
const SLIPPAGE_BASIS_POINTS = BigInt(process.env.SLIPPAGE_BASIS_POINTS)
const TAKE_PROFIT_PERCENTAGE =  Number(process.env.TAKE_PROFIT_PERCENTAGE || "")
const RPC_URL = process.env.RPC_ENDPOINT;
const RPC_WEBSOCKET_ENDPOINT = process.env.RPC_WEBSOCKET_ENDPOINT;
const UNIT_PRICE_LAMPORTS = Number(process.env.UNIT_PRICE_LAMPORTS || "")
const UNIT_LIMIT_LAMPORTS = Number(process.env.UNIT_LIMIT_LAMPORTS || "")
const PRIVATE_KEY = process.env.PRIVATE_KEY || ""
const QUOTE_AMOUNT = process.env.QUOTE_AMOUNT;
let usd_sol_res=127.14;

if (!PRIVATE_KEY) {
  throw new Error("Please set PRIVATE_KEY in .env file")
}

const getProvider = wallet => {
  if (!RPC_URL) {
    throw new Error("Please set RPC_URL in .env file")
  }

  const connection = new Connection(RPC_URL, "confirmed")
  return new AnchorProvider(connection, wallet, { commitment: "finalized" })
}

let wallet: Keypair;
wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

const privateKey = bs58.decode(PRIVATE_KEY)
const buyerKeypair = Keypair.fromSecretKey(privateKey)
const provider = getProvider(new Wallet(wallet))
const connection = provider.connection
const ws = new WebSocket(RPC_WEBSOCKET_ENDPOINT);
const PUMPSWAP_PUBLIC_KEY = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";//Pump.fun mint address
const pumpAmmSdk = new PumpAmmSdk(connection);

async function fetchRaydiumAccounts(txId) {

    const tx = await connection.getParsedTransaction(
        txId,
        {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });
try{
  const account =  tx?.transaction.message.instructions.find((ix) => ix.programId.toBase58() == PUMPSWAP_PUBLIC_KEY);
  const json = JSON.stringify(account, null, 2);
  const accounts = JSON.parse(json);
  let wsol = accounts.accounts[4];
  const mint = accounts.accounts[3];
  const qoutevault = accounts.accounts[9];
  const basevault = accounts.accounts[10];
  const marketid = accounts.accounts[0];

  const isfreezable = await checkFreezable(new PublicKey(mint));

  if (wsol.includes('So11111111111111111111111111111111111111112') && isfreezable==false){
    const displayData = [
      { "Token": "Base", "Public Key": wsol },
      { "Token": "Mint", "Public Key": mint },
      { "Token": "Market ID", "Public Key": marketid },
      { "Token": "Quote", "Public Key": qoutevault },
      { "Token": "Base", "Public Key": basevault },
      {
        Token: "Link",
        "Public Key": "https://photon-sol.tinyastro.io/en/lp/" + marketid,
      },
      {
        Token: "Link",
        "Public Key": "https://dexscreener.com/solana/" + marketid +'?maker='+ wallet.publicKey.toString(),
      },
    ];

    console.table(displayData);
    logger.warn('Found New Pumpfun Migration :  https://solscan.io/tx/' + txId);

            let buy_price = await buy(mint, qoutevault, basevault, marketid);
            let counter: number = 0;

            var takeP3 = TAKE_PROFIT_PERCENTAGE / 100;
            var profit_per3 = buy_price.price * takeP3;
            var trake_profit = buy_price.price + profit_per3;

            while (buy_price.price > 0) {
                
                const liquiditys = await connection.getBalance(new PublicKey(basevault), 'confirmed');
                const bbb = await connection.getTokenAccountBalance(new PublicKey(qoutevault), 'confirmed');
                const pool_supplyc = bbb.value?.uiAmount || 0;
                const pool_usdb = (liquiditys / LAMPORTS_PER_SOL) * usd_sol_res;
                let current_price = pool_usdb / pool_supplyc;

                counter++;
                //Take Profit
                if (current_price >= trake_profit) {
                    logger.info('Take Profit Sold ' + 'Buy Price: ' + buy_price.price + ' | Current Price : ' + current_price + ' https://pump.fun/' + mint);
                    await sell(mint, marketid);
                    break;
                }
            }    
  }  
}catch(error){
  console.log(error);
}

}

  ws.on("open",() => {
    console.log('new connection');
    subscribeToLogs(ws,PUMPSWAP_PUBLIC_KEY);
  });

  ws.on("error",(ev: ErrorEvent) => {
    console.log('Error: '+ ev.message);
  });

  async function subscribeToLogs(ws: WebSocket, account: string ){
    const requestData = {
        
        "jsonrpc": "2.0",
        "id": 1,
        "method": "logsSubscribe",
        "params": [
          {
            "mentions": [ "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" ]
          },
          {
            "commitment": "confirmed"
          }
        ]
          
      }

      ws.send(JSON.stringify(requestData));
  }

  ws.on("message",(message: string) => {

    if (message.includes("Instruction: CreatePool")) {
      const accounts = JSON.parse(message);
      const signature = accounts.params.result.value.signature;
      fetchRaydiumAccounts(signature);
    }
  });

async function getTokenBalanceSpl(mint, dev) {
  const Mint = new PublicKey(dev);
  const tokenAccounts = await getTokenAccounts(connection, Mint , 'confirmed');

  for (const ta of tokenAccounts) {
    if (ta.accountInfo.mint.toString()==mint.toString()){
      const amount = ta.accountInfo.amount;
      return amount;
    }
  }
}

async function buy(currentTokenCA, qoutevault, basevault, marketid) {

  const quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);

  const MarketID = new PublicKey(marketid);
  const innerTransaction: TransactionInstruction[] = await pumpAmmSdk.swapQuoteInstructions(
    MarketID,
    quoteAmount.raw,
    Number(SLIPPAGE_BASIS_POINTS),
    'quoteToBase',
    wallet.publicKey,
  );

  const latestBlockhash = await connection.getLatestBlockhash({
    commitment: 'confirmed',
  });
  
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: UNIT_LIMIT_LAMPORTS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: UNIT_PRICE_LAMPORTS }),
      ...innerTransaction,
    ],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([wallet]);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      maxRetries: 20,
      preflightCommitment: 'confirmed',
    },
  );
  logger.info('BUY: '+ `https://solscan.io/tx/${signature}`);

      const bls: number = 2;
    let balanceSpl;
    while (bls > 0) {
      const balanceSplB = await getTokenBalanceSpl(currentTokenCA, buyerKeypair.publicKey.toString());
      if (Number(balanceSplB) > 0) { 
        balanceSpl=balanceSplB;
        break;
      }
  }
  
      const liquiditys = await connection.getBalance(new PublicKey(basevault), 'confirmed');
      const bbb = await connection.getTokenAccountBalance(new PublicKey(qoutevault), 'confirmed');
      const pool_supplyc = bbb.value?.uiAmount || 0;
      const pool_usdb = (liquiditys / LAMPORTS_PER_SOL) * usd_sol_res;
      let buy_price = pool_usdb / pool_supplyc;

      return { price: buy_price, amount: balanceSpl}
}

async function sell(currentTokenCA, marketid) {

    const bls: number = 2;
    let balanceSpl;
    while (bls > 0) {
      const balanceSplB = await getTokenBalanceSpl(currentTokenCA, buyerKeypair.publicKey.toString());
      if (Number(balanceSplB) > 0) { 
        balanceSpl=balanceSplB;
        break;
      }
  }

  const MarketID = new PublicKey(marketid);
  const innerTransaction: TransactionInstruction[] = await pumpAmmSdk.swapBaseInstructions( //pumpAmmSdk.swapQuoteInstructions
    MarketID,
    new BN(balanceSpl),
    Number(SLIPPAGE_BASIS_POINTS),
    'baseToQuote',
    wallet.publicKey,
  );

  const latestBlockhash = await connection.getLatestBlockhash({
    commitment: 'confirmed',
  });
  
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: UNIT_LIMIT_LAMPORTS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: UNIT_PRICE_LAMPORTS }),
      ...innerTransaction,
    ],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([wallet]);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      maxRetries: 20,
      preflightCommitment: 'confirmed',
    },
  );
  logger.error('SELL: '+ `https://solscan.io/tx/${signature}`
  );
}

async function checkFreezable(vault: PublicKey) {
  try {
    let { data } = (await connection.getAccountInfo(vault)) || {};
    if (!data) {
      return;
    }
        // Deserialize Data.
    const deserialize = MintLayout.decode(data)
    const freezeoption  = deserialize.freezeAuthorityOption

    if (freezeoption === 0) {
      return false;
    } else {
      return true;
    }

  } catch {
    return null;
  }
}