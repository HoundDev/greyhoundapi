const xrpl = require("xrpl");
require("dotenv").config();
class XrplHelpers {

  async getAccountInfo(client, xrpAddress) {
    const response = await client.request({
      command: "account_info",
      account: xrpAddress,
      ledger_index: "validated",
    });
    return response.result;
  }

  async getAccountNFTs(client, xrpAddress) {
    const response = await client.request({
      command: "account_nfts",
      account: xrpAddress,
      ledger_index: "validated",
    });
    return response.result;
  }

  async getAccountTransactions(client,xrpAddress){
    const response = await client.request({
        command: "account_tx",
        account: xrpAddress,
        limit:20
      });
      return response.result.transactions;
  }

  async getAccountLines(client,xrpAddress,marker){
    const response = await client.request({
        command: "account_lines",
        account: xrpAddress,
        marker: marker
      });
      return response.result.lines;
  }

  async getTransactionMetadata(client, txnHash) {
    const response = await client.request({
      command: "tx",
      transaction: txnHash,
    });
    return response.result;
  }

  async getAccountSellOffers(client, tokenId)
  {
      let nftSellOffers
        try {
            nftSellOffers = await client.request({
            method: "nft_sell_offers",
            tokenid: tokenId
          })
          } catch (err) {
            console.log("No sell offers.")
        }
        return nftSellOffers.result;
  }
  
  async getTransactionFee(client){
    const response = await client.request({
        command: "fee",
      });
      return response.result.drops.minimum_fee;
  }

  TransactionRequestPayload(xrpAddress) {
    return {
      command: "account_tx",
      account: xrpAddress,
    };
  }

  CreateOfferPayload() {
    return {
      TransactionType: "NFTokenCreateOffer",
      Account: process.env.MULTI_SIG_WALLET_ADDRESS,
      TokenID: "",
      Destination: "",
      Amount: "0",
      Flags: xrpl.NFTokenCreateOfferFlags.tfSellToken,
      Sequence: 0,
      Fee: "1000",
      Memos: [
        {
          Memo: {
            MemoData: "",
          },
        },
      ],
    };
  }

  TokenMintPayload() {
    return {
      TransactionType: "NFTokenMint",
      Account: process.env.MULTI_SIG_WALLET_ADDRESS,
      Flags: xrpl.NFTokenMintFlags.tfTransferable,
      URI: "",
      TokenTaxon: 0,
      Fee: "1000",
      Sequence: 0,
      Memos: [
        {
          Memo: {
            MemoData: "",
          },
        },
      ],
    };
  }

}

module.exports = XrplHelpers;
