# SPL Governance Multisig SDK

```
import { MultiSig } from "spl-governance-multisig";
import { Connection, Keypair } from "@solana/web3.js";
import { airdrop, sendSolToMultiSigWallet } from "./airdrop";

// local validator
const clusterUrl = "http://127.0.0.1:8899";

const connection = new Connection(clusterUrl, {
  commitment: "confirmed",
});

// Signers
const payer = Keypair.generate();
const signerOne = Keypair.generate();
const signerTwo = Keypair.generate();
const signerThree = Keypair.generate();

// Payer's instance of Multisig (Payer will instantiate the multisig)
const payerInstance = new MultiSig(connection, payer);

// Signer One's instance of Multisig (Signer One will create the SOL Transfer Tx and sign it)
const signerOneInstance = new MultiSig(connection, signerOne);

// Signer Two's instance of Multisig (Signer Two will be the second signer of the tx)
const signerTwoInstance = new MultiSig(connection, signerTwo);

// Signer Three's instance of Multisig (Signer Two will be the third signer of the tx)
const signerThreeInstance = new MultiSig(connection, signerThree);

(async() => {
  await airdrop(payer, connection);
  await airdrop(signerOne, connection);
  await airdrop(signerTwo, connection);
  await airdrop(signerThree, connection);

  // Create 2-of-3 Multi Sig Wallet (by Payer)
  const {
    txSignature:createMultisigSignature, 
    multiSigKey, 
    multiSigWallet
  } = await payerInstance.createMultisig(
    2,
    [
      signerOne.publicKey, 
      signerTwo.publicKey, 
      signerThree.publicKey
    ]
  );

  console.log("Tx Signature for the Multi Sig Creation:", createMultisigSignature)
  console.log("Multisig Key:", multiSigKey.toBase58())

  await sendSolToMultiSigWallet(payer, multiSigWallet, connection);

  // Internal instruction for the multisig transaction
  const getSolTrfIx = signerOneInstance.getSolTransferInstruction(multiSigKey, 0.12, payer.publicKey)
  
  // Create and Sign Multi Sig Transaction (by Signer One)
  const {
    txSignature: createTransactionSignature,
    transactionKey
  } = await signerOneInstance.createTransaction(
    multiSigKey,
    "Transfer 0.12 SOL to Payer's Wallet",
    [getSolTrfIx]
  )

  console.log("Tx Signature for the Transaction Creation: ", createTransactionSignature)
  console.log("Transaction Key", transactionKey.toBase58())
  
  const firstTxStatus = await payerInstance.getTransaction(transactionKey)
  console.log(firstTxStatus)

  try {
    // We are trying to execute the transaction after the first vote, it should fail
    const tryExecuteSig = await signerTwoInstance.executeTransaction(transactionKey)
    console.log(tryExecuteSig)
  } catch(e) {
    console.log("Execution Error: ", e)
  }

  // Reject the tx from Signer Two's wallet
  const rejectTxSignature = await signerTwoInstance.rejectTransaction(multiSigKey, transactionKey)
  console.log("Tx Signature for the Rejected Transaction: ", rejectTxSignature)
  
  const secondTxStatus = await payerInstance.getTransaction(transactionKey)
  console.log(secondTxStatus)

  // Approve the tx from Signer Three's wallet
  const approveTxSignature = await signerThreeInstance.approveTransaction(multiSigKey, transactionKey)
  console.log("Tx Signature for the Approved Transaction: ", approveTxSignature)

  // Add some delay before execution
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Since the Tx has received 2-of-3 votes, it should execute now
  const tryExecuteSig = await signerThreeInstance.executeTransaction(transactionKey)
  console.log("Tx Signature for the Transaction Execution: ", tryExecuteSig)

  // Fetch all the transactions for the multisig
  const transactions = await signerThreeInstance.getTransactionsForMultisig(multiSigKey)
  console.log(transactions)
})()
```
