import { PublicKey } from "@solana/web3.js"

export enum TransactionStatus {
  Active,
  Succeeded,
  Failed
}

export type CreateMultisigReturnType = {
  txSignature: string,
  multiSigKey: PublicKey,
  multiSigWallet: PublicKey
}

export type CreateTransactionReturnType = {
  txSignature: string,
  transactionKey: PublicKey
}

export type Transaction = {
  key: PublicKey,
  yesVote: number,
  noVote: number,
  status: TransactionStatus,
  executed: boolean,
  multiSigKey: PublicKey
}