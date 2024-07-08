const xrpl = require("xrpl");
require("dotenv").config();
const axios = require('axios').default;

class XrplHelpers {

  async getTokenPrice(base, quote) {
    try {
      const response = await axios.get('https://api.onthedex.live/public/v1/ohlc?base=' + base + '&quote=' + quote + '&bars=30&interval=D&tf=ISO');
      let body = response['data'];
      let prices = [];
      if ('error' in body) {
        return 0;
      }
      for (var i = 0; i < body.data['ohlc'].length; i++) {
        prices.push(body.data['ohlc'][i].c);
      }
      return prices;
    } catch (error) {
      console.error(error);
      return 0;
    }
  }

  async getLiveTokenPrice(base) {
    try {
      //const url = 'https://api.onthedex.live/public/v1/ohlc?base=' + base + '&quote=XRP&bars=100&interval=60&tf=ISO';
      const url = 'https://api.onthedex.live/public/v1/ohlc?base=' + base + '&quote=XRP&bars=100&interval=D&tf=ISO'; // not enough activity to get hourly data
      const response = await axios.get(url);
      if ('error' in response.data) {
        return 0;
      }
      return response.data.data['ohlc'][response.data.data['ohlc'].length - 1].c;
    } catch (error) {
      console.error(error);
      return 0;
    }
  }

  async getLiveXrpPrice() {
    try {
      const url = 'https://api.mexc.com/api/v3/ticker/24hr';
      const response = await axios.get(url);
      // return response.data.price;
      for (var i = 0; i < response.data.length; i++) {
        if (response.data[i].symbol == 'XRPUSDT') {
          return response.data[i].lastPrice;
        }
      }
    } catch (error) {
      console.error(error);
      return 0;
    }
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
    console.log("Getting NFTs for " + xrpAddress);
    let account_nfts = [];
    var marker = null;
    while (true) {
      var payload = {
        command: "account_nfts",
        account: xrpAddress,
        ledger_index: "validated",
        limit: 400
      }
      if (marker) {
        payload.marker = marker;
      }
      let response = await client.request(payload);
      account_nfts.push(...response.result.account_nfts);
      console.log("Response length: " + response.result);
      if (response.result.marker) {
        marker = response.result.marker;
      } else {
        break;
      }
    }
    return account_nfts;
  }


  async getAccountTransactions(client, xrpAddress) {
    const response = await client.request({
      command: "account_tx",
      account: xrpAddress,
      limit: 20
    });
    return response.result.transactions;
  }

  async getAccountLines(client, xrpAddress, marker) {
    const response = await client.request({
      command: "account_lines",
      account: xrpAddress,
      marker: marker
    });
    return response.result.lines;
  }

  async getGreyhoundBalance(client, xrpAddress, marker) {
    const response = await client.request({
      command: "account_lines",
      peer: process.env.GREYHOUND_ISSUER,
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

  async getAccountSellOffers(client, tokenId) {
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

  async getTransactionFee(client) {
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
