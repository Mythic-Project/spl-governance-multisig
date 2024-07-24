import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Signer, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { GovernanceConfig, SplGovernance } from "governance-idl-sdk";
import { AuthorityType, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, createMint, createSetAuthorityInstruction, createTransferCheckedInstruction, createTransferInstruction, getAssociatedTokenAddressSync, getMint, setAuthority } from "@solana/spl-token";
import { DISABLED_VOTER_WEIGHT } from "./constant";
import { CreateMultisigReturnType, CreateTransactionReturnType, Transaction, TransactionStatus } from "./types";

export class MultiSig {
  readonly splGovernance: SplGovernance;
  readonly payer: Signer;
  readonly connection: Connection;

  constructor(
    connection: Connection,
    payer: Signer,
    programId?: PublicKey,
  ) {
    this.splGovernance = new SplGovernance(connection, programId)
    this.payer = payer
    this.connection = connection
  }

  private async createAndConfirmTransaction(ixs: TransactionInstruction[]) {
    const recentBlockhash = await this.connection.getLatestBlockhash({
      commitment: "confirmed"
    })

    const txMessage = new TransactionMessage({
      payerKey: this.payer.publicKey,
      instructions: ixs,
      recentBlockhash: recentBlockhash.blockhash
    }).compileToV0Message()

    const tx = new VersionedTransaction(txMessage)
    tx.sign([this.payer])
    
    const sig = await this.connection.sendRawTransaction(tx.serialize())
    
    await this.connection.confirmTransaction(
      {
        signature: sig,
        blockhash: recentBlockhash.blockhash,
        lastValidBlockHeight: recentBlockhash.lastValidBlockHeight
      }, 
      "confirmed"
    )

    return sig
  }

  /** Create M-of-N multisig
   * 
   * @param threshold The minimum signers needed to execute the proposal
   * @param signers All members of the multisig
   * @param voteDuration (Optional) The duration of the proposal in seconds. Defaults to 86400 sec (1 day)
   * 
   * @returns {txSignature} Signature of the transaction
   * @returns {multiSigKey} Unique Identifier of the MultiSig, 
   * @returns {multiSigWallet} Wallet address of the multisig
   *
  */
  async createMultisig(
    threshold: number,
    signers: PublicKey[],
    voteDuration?: number
  ) : Promise<CreateMultisigReturnType> {
    if (threshold > signers.length) throw new Error("The threshold exceeds the signers' count.")

    // Create community token
    const communityToken = await createMint(
      this.connection, this.payer, this.payer.publicKey, null, 0
    )

    // Create council token
    const councilToken = await createMint(
      this.connection, this.payer, this.payer.publicKey, null, 0
    )
    
    // The instruction Set
    const ixs: TransactionInstruction[] = []

    const realmName = `Multisig ${Date.now()} ${Math.floor(Math.random() * 100000)}`;
    const realmId = this.splGovernance.pda.realmAccount({name: realmName}).publicKey;
    const governanceId = this.splGovernance.pda.governanceAccount({realmAccount: realmId, seed: realmId}).publicKey;
    const nativeTreasuryId = this.splGovernance.pda.nativeTreasuryAccount({governanceAccount: governanceId}).publicKey;

    const createRealmIx = await this.splGovernance.createRealmInstruction(
      realmName,
      communityToken,
      DISABLED_VOTER_WEIGHT,
      this.payer.publicKey,
      undefined,
      councilToken,
      "dormant",
      "membership"
    )
    ixs.push(createRealmIx)

    // Deposit Governing Token for each signer
    for (const signer of signers) {
      const createTokenOwnerRecordIx = await this.splGovernance.createTokenOwnerRecordInstruction(
        realmId,
        signer,
        councilToken,
        this.payer.publicKey
      )

      const depositGovTokenIx = await this.splGovernance.depositGoverningTokensInstruction(
        realmId,
        councilToken,
        councilToken,
        signer,
        this.payer.publicKey,
        this.payer.publicKey,
        1
      )
      depositGovTokenIx.keys[3].isSigner = false
      ixs.push(createTokenOwnerRecordIx, depositGovTokenIx)
    }

    const thresholdPercentage = Math.floor((threshold/signers.length)*100)

    // Governance Config
    const governanceConfig: GovernanceConfig = {
      communityVoteThreshold: { disabled: {} },
      minCommunityWeightToCreateProposal: DISABLED_VOTER_WEIGHT,
      minTransactionHoldUpTime: 0,
      // In seconds == 1 day, max time for approving transactions
      votingBaseTime: voteDuration ?? 86400,
      communityVoteTipping: { disabled: {} },
      // Approval quorum 60% = 2 of 3 to approve transactions
      councilVoteThreshold: { yesVotePercentage: [thresholdPercentage] },
      councilVetoVoteThreshold: { disabled: {} },
      // Anybody from the multisig can propose transactions
      minCouncilWeightToCreateProposal: 1,
      councilVoteTipping: { strict: {} },
      communityVetoVoteThreshold: { disabled: {} },
      votingCoolOffTime: 0,
      depositExemptProposalCount: 254,
    };
  
    const createGovernanceIx = await this.splGovernance.createGovernanceInstruction(
      governanceConfig,
      realmId,
      this.payer.publicKey,
      undefined,
      this.payer.publicKey,
      realmId
    )
    ixs.push(createGovernanceIx)

    const createNativeTreasuryIx = await this.splGovernance.createNativeTreasuryInstruction(
      governanceId,
      this.payer.publicKey
    )
    ixs.push(createNativeTreasuryIx)

    const transferCommunityAuthIx = createSetAuthorityInstruction(
      communityToken, this.payer.publicKey, AuthorityType.MintTokens, nativeTreasuryId 
    )
    const transferCouncilAuthIx = createSetAuthorityInstruction(
      councilToken, this.payer.publicKey, AuthorityType.MintTokens, nativeTreasuryId 
    )

    // Transfer multisig authority
    const transferMultisigAuthIx = await this.splGovernance.setRealmAuthorityInstruction(
      realmId,
      this.payer.publicKey,
      "setChecked",
      governanceId
    )
    ixs.push(transferCommunityAuthIx, transferCouncilAuthIx, transferMultisigAuthIx)

    const sig = await this.createAndConfirmTransaction(ixs)

    return {
      txSignature: sig,
      multiSigKey: realmId,
      multiSigWallet: nativeTreasuryId
    }
  }

  /** Get Token Transfer Instruction
   * 
   * @param multiSigKey The public key of the multisig (ID)
   * @param token The mint account of the token
   * @param amount The amount of tokens to send
   * @param recipientWallet The wallet address of recipient
   * 
   * @returns Instructions to add to the multisig transaction
  */
  async getTokenTransferInstruction(
    multiSigKey: PublicKey,
    token: PublicKey,
    amount: bigint | number,
    recipientWallet: PublicKey
  ): Promise<TransactionInstruction[]> {
    const governanceId = this.splGovernance.pda.governanceAccount({
      realmAccount: multiSigKey, 
      seed: multiSigKey
    }).publicKey;

    const nativeTreasuryId = this.splGovernance.pda.nativeTreasuryAccount({
      governanceAccount: governanceId
    }).publicKey;

    const sourceAccount = getAssociatedTokenAddressSync(token, nativeTreasuryId, true, TOKEN_PROGRAM_ID)
    const recipientAccount = getAssociatedTokenAddressSync(token, recipientWallet, true, TOKEN_PROGRAM_ID)

    const isRecipientExists = await this.connection.getAccountInfo(recipientAccount)
    const tokenDetails = await getMint(this.connection, token)

    const returnIxs: TransactionInstruction[] = []

    if (!isRecipientExists) {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        nativeTreasuryId,
        recipientAccount,
        recipientWallet,
        token,
        TOKEN_PROGRAM_ID
      )

      returnIxs.push(createAtaIx)
    }

    const adjustedAmount = typeof amount === "number" ?
      amount * tokenDetails.decimals :
      amount * BigInt(tokenDetails.decimals)

    const transferIx = createTransferInstruction(
      sourceAccount,
      recipientAccount,
      nativeTreasuryId,
      adjustedAmount,
      undefined,
      TOKEN_PROGRAM_ID
    )

    returnIxs.push(transferIx)
    return returnIxs
  }

  /** Get SOL Transfer Instruction
   * 
   * @param multiSigKey The public key of the multisig (ID)
   * @param amount The amount of SOL to send
   * @param recipientWallet The wallet address of the recipient
   * 
   * @returns Instruction to add to the multisig transaction
  */
  getSolTransferInstruction(
    multiSigKey: PublicKey,
    amount: bigint | number,
    recipientWallet: PublicKey
  ): TransactionInstruction {
    const governanceId = this.splGovernance.pda.governanceAccount({
      realmAccount: multiSigKey, 
      seed: multiSigKey
    }).publicKey;

    const nativeTreasuryId = this.splGovernance.pda.nativeTreasuryAccount({
      governanceAccount: governanceId
    }).publicKey;

    const lamports = typeof amount === "number" ? 
      amount * LAMPORTS_PER_SOL :
      amount * BigInt(LAMPORTS_PER_SOL)

    const solTransferIx = SystemProgram.transfer({
      fromPubkey: nativeTreasuryId,
      toPubkey: recipientWallet,
      lamports 
    })

    return solTransferIx
  }

  /** Create multisig Transaction
   * 
   * @param multiSigKey The public key of the multisig (ID)
   * @param title Title of the propoal
   * @param instructions The internal instructions to execute in the transaction
   * 
   * 
   * @returns {txSignature} Signature of the transaction
   * @returns {transactionKey} The public key of the partially-signed proposal
  */
  async createTransaction(
    multiSigKey: PublicKey,
    title: string,
    instructions: TransactionInstruction[]
  ): Promise<CreateTransactionReturnType> {
    // The instruction Set
    const ixs: TransactionInstruction[] = []

    const governanceId = this.splGovernance.pda.governanceAccount({
      realmAccount: multiSigKey, 
      seed: multiSigKey
    }).publicKey;

    const realmDetails = await this.splGovernance.getRealmByPubkey(multiSigKey)
    const councilMint = realmDetails.config.councilMint!
    
    const tokenOwnerRecordKey = this.splGovernance.pda.tokenOwnerRecordAccount({
      realmAccount: multiSigKey,
      governingTokenMintAccount: councilMint,
      governingTokenOwner: this.payer.publicKey
    }).publicKey

    const proposalSeed = Keypair.generate().publicKey

    const proposalId = this.splGovernance.pda.proposalAccount({
      governanceAccount: governanceId,
      governingTokenMint: councilMint,
      proposalSeed
    }).publicKey

    const createProposalIx = await this.splGovernance.createProposalInstruction(
      title,
      '',
      {choiceType: "single", multiChoiceOptions: null},
      ['Approve'],
      true,
      multiSigKey,
      governanceId,
      tokenOwnerRecordKey,
      councilMint,
      this.payer.publicKey,
      this.payer.publicKey,
      proposalSeed
    )

    const insertTxIx = await this.splGovernance.insertTransactionInstruction(
      instructions,
      0,
      0,
      0,
      governanceId,
      proposalId,
      tokenOwnerRecordKey,
      this.payer.publicKey,
      this.payer.publicKey
    )

    const signOffProposalIx = await this.splGovernance.signOffProposalInstruction(
      multiSigKey,
      governanceId,
      proposalId,
      this.payer.publicKey,
      tokenOwnerRecordKey
    )

    const castVoteIx = await this.splGovernance.castVoteInstruction(
      {approve: [[{rank: 0, weightPercentage: 100}]]},
      multiSigKey,
      governanceId,
      proposalId,
      tokenOwnerRecordKey,
      tokenOwnerRecordKey,
      this.payer.publicKey,
      councilMint,
      this.payer.publicKey
    )

    ixs.push(
      createProposalIx, insertTxIx, signOffProposalIx, castVoteIx
    )

    const sig = await this.createAndConfirmTransaction(ixs)

    return {
      txSignature: sig,
      transactionKey: proposalId
    }
  }

  /** Approve multisig Transaction
   * 
   * @param multiSigKey The public key of the multisig (ID)
   * @param transactionKey The public key of the transaction
   * 
   * 
   * @returns Signature of the transaction
  */
  async approveTransaction(
    multiSigKey: PublicKey,
    transactionKey: PublicKey,
  ) {
    const realmDetails = await this.splGovernance.getRealmByPubkey(multiSigKey)
    const councilMint = realmDetails.config.councilMint!

    const governanceId = this.splGovernance.pda.governanceAccount({
      realmAccount: multiSigKey, 
      seed: multiSigKey
    }).publicKey;

    const tokenOwnerRecordKey = this.splGovernance.pda.tokenOwnerRecordAccount({
      realmAccount: multiSigKey,
      governingTokenMintAccount: councilMint,
      governingTokenOwner: this.payer.publicKey
    }).publicKey

    const proposalInfo = await this.splGovernance.getProposalByPubkey(transactionKey)

    const signTxIx = await this.splGovernance.castVoteInstruction(
      {approve: [[{rank: 0, weightPercentage: 100}]]},
      multiSigKey,
      governanceId,
      transactionKey,
      proposalInfo.tokenOwnerRecord,
      tokenOwnerRecordKey,
      this.payer.publicKey,
      councilMint,
      this.payer.publicKey
    )

    const sig = await this.createAndConfirmTransaction([signTxIx])

    return sig
  }

  /** Reject multisig Transaction
   * 
   * @param multiSigKey The public key of the multisig (ID)
   * @param transactionKey The public key of the transaction
   * 
   * 
   * @returns Signature of the transaction
  */
  async rejectTransaction(
    multiSigKey: PublicKey,
    transactionKey: PublicKey,
  ) {
    const realmDetails = await this.splGovernance.getRealmByPubkey(multiSigKey)
    const councilMint = realmDetails.config.councilMint!

    const governanceId = this.splGovernance.pda.governanceAccount({
      realmAccount: multiSigKey, 
      seed: multiSigKey
    }).publicKey;

    const tokenOwnerRecordKey = this.splGovernance.pda.tokenOwnerRecordAccount({
      realmAccount: multiSigKey,
      governingTokenMintAccount: councilMint,
      governingTokenOwner: this.payer.publicKey
    }).publicKey

    const proposalInfo = await this.splGovernance.getProposalByPubkey(transactionKey)

    const signTxIx = await this.splGovernance.castVoteInstruction(
      {deny: {}},
      multiSigKey,
      governanceId,
      transactionKey,
      proposalInfo.tokenOwnerRecord,
      tokenOwnerRecordKey,
      this.payer.publicKey,
      councilMint,
      this.payer.publicKey
    )

    const sig = await this.createAndConfirmTransaction([signTxIx])

    return sig
  }

   /** Execute multisig Transaction
   * 
   * @param transactionKey The public key of the transaction
   * 
   * 
   * @returns Signature of the transaction
  */
  async executeTransaction(
    transactionKey: PublicKey
  ) {
    const status = await this.getTransaction(transactionKey)

    const governanceId = this.splGovernance.pda.governanceAccount({
      realmAccount: status.multiSigKey,
      seed: status.multiSigKey
    }).publicKey

    const nativeTreasuryId = this.splGovernance.pda.nativeTreasuryAccount({
      governanceAccount: governanceId
    }).publicKey;

    const proposalTxId = this.splGovernance.pda.proposalTransactionAccount({
      proposal: transactionKey,
      optionIndex: 0,
      index: 0
    }).publicKey

    const proposalTxAccount = await this.splGovernance.getProposalTransactionByPubkey(proposalTxId)

    if (status.status === TransactionStatus.Succeeded) {
      const accountsForIx = proposalTxAccount.instructions[0].accounts
      accountsForIx.unshift({
        pubkey: proposalTxAccount.instructions[0].programId,
        isSigner: false,
        isWritable: false
      })

      accountsForIx.forEach(account => {
        if (account.pubkey.equals(nativeTreasuryId)) {
          account.isSigner = false
        }
      })

      const executeTxIx = await this.splGovernance.executeTransactionInstruction(
        governanceId,
        transactionKey,
        proposalTxId,
        accountsForIx
      )

      const sig = await this.createAndConfirmTransaction([executeTxIx])
      return sig
    } else {
      throw new Error("The transaction does not succeed.")
    }
  }

  /** Fetch the multisig Transaction
   * @param transactionKey The public key of the transaction
   * 
   * 
   * @returns The Transaction Account
  */
  async getTransaction(
    transactionKey: PublicKey
  ): Promise<Transaction> {
    const proposal = await this.splGovernance.getProposalByPubkey(transactionKey)
    const governanceAccount = await this.splGovernance.getGovernanceAccountByPubkey(proposal.governance)

    return {
      key: proposal.publicKey,
      yesVote: proposal.options[0].voteWeight.toNumber(),
      noVote: proposal.denyVoteWeight!.toNumber(),
      status: 
        proposal.state.succeeded ? 
          TransactionStatus.Succeeded :
        proposal.state.defeated ?
          TransactionStatus.Failed :
          TransactionStatus.Active,
      executed: proposal.executingAt !== null,
      multiSigKey: governanceAccount.realm
    }
  }

  /** Fetch all transactions for the given multisig
   * @param multiSigKey The public key of the transaction
   * 
   * 
   * @returns Transaction Accounts
  */
  async getTransactionsForMultisig(
    multiSigKey: PublicKey
  ): Promise<Transaction[]> {
    const governanceId = this.splGovernance.pda.governanceAccount({
      realmAccount: multiSigKey,
      seed: multiSigKey
    }).publicKey

    const proposals = await this.splGovernance.getProposalsforGovernance(governanceId)
    
    return proposals.map(proposal => ({
      key: proposal.publicKey,
      yesVote: proposal.options[0].voteWeight.toNumber(),
      noVote: proposal.denyVoteWeight!.toNumber(),
      status: 
        proposal.state.succeeded ? 
          TransactionStatus.Succeeded :
        proposal.state.defeated ?
          TransactionStatus.Failed :
          TransactionStatus.Active,
      executed: proposal.executingAt !== null,
      multiSigKey: multiSigKey
    }))
  }
}

export * from "./types";