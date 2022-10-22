const xrpl = require("xrpl");
require("dotenv").config();
const axios = require('axios').default;

class XrplHelpers {

  async getTokenPrice(base, quote) {
    try {
      const response = await axios.get('https://api.onthedex.live/public/v1/ohlc?base=' + base + '&quote=' + quote + '&bars=30&interval=D&tf=ISO');
      let body       = response['data'];
      let prices     = [];

      for (var i = 0; i < 30; i++) {
        prices.push(body.data.ohlc[i].c);
      }
      return prices;
    } catch (error) {
      console.error(error);
    }
  }

  async getLiveTokenPrice(base){
  const url = 'https://api.onthedex.live/public/v1/ohlc?base=' + base + '&quote=XRP&bars=100&interval=60&tf=ISO';
  const response = await axios.get(url);
  console.log(response.data.data.ohlc[0].c);
  return response.data.data['ohlc'][response.data.data['ohlc'].length - 1].c;
  }

  async getLiveXrpPrice() {
    const url = 'https://api.binance.com/api/v3/ticker/price?symbol=XRPUSDT';
    const response = await axios.get(url);
    return response.data.price;
  }

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

  async getBalance(client, xrpAddress) {
    const response = await client.request({
      command: "account_info",
      account: xrpAddress,
      ledger_index: "validated",
    });
    // return response.result.account_data.Balance;
    //conver to xrp
    return xrpl.dropsToXrp(response.result.account_data.Balance);
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
      return response.result.drops.base_fee;
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
      Account: process.env.GREYHOUND_ISSUER,
      TokenID: "",
      Destination: "",
      Amount: "0",
      Flags: xrpl.NFTokenCreateOfferFlags.tfSellNFToken,
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
      Account: process.env.GREYHOUND_ISSUER,
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
