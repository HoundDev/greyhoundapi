const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const fs = require("fs");
const path = require('path')
var http = require("http");
var https = require("https");
const { XummSdk } = require("xumm-sdk");
var cors = require("cors");
const bodyParser = require("body-parser");
const xrpl = require("xrpl");
const rateLimit = require('express-rate-limit');
const verifySignature = require('verify-xrpl-signature').verifySignature;
const Storage = require("./storage.js");
const XrplHelpers = require('./xrp');
const log = require('debug')('greyhoundapi')
const e = require("express");
const paginate = require("jw-paginate");
require("dotenv").config();
const axios = require('axios');
const { parse } = require('csv-parse');

// Create Express Server
const app = express();
app.use(cors());

// Configuration
const PORT = process.env.API_SERVICE_PORT;
const API_SERVICE_URL = process.env.API_SERVICE_URL;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

var db;
var storage;
var xrplHelper;
var cache = new Map();
var cacheURIDATA = new Map();

xrplHelper = new XrplHelpers();
if (!fs.existsSync("./storage.db")) {
  storage = new Storage();
  db = storage.createDatabase();
  storage.readSnapshotData(db,'tier1b.csv');
  storage.readSnapshotData(db,'tier500m.csv');
  storage.readSnapshotData(db,'tier250m.csv');
  storage.readSnapshotData(db,'tier100m.csv');
} else{
  storage = new Storage();
  db = storage.getInstance();
}

app.use("/xumm/createpayload", async function (req, res, next) {
  try {
    const Sdk = new XummSdk(
      process.env.XUMM_API_KEY,
      process.env.XUMM_API_SECRET
    );
    const payload = await Sdk.payload.create(req.body, true);
    console.log(payload);
    res.send(payload);
  } catch (err) {
    console.log(err);
  }
});

app.use("/xumm/getpayload", async function (req, res, next) {
  try {
    const Sdk = new XummSdk(
      process.env.XUMM_API_KEY,
      process.env.XUMM_API_SECRET
    );
    const payload = await Sdk.payload.get(req.body.payloadID);
    res.send(payload);
  } catch {}
});

app.use("/xumm/checksig", async function (req, res, next) {
  try {
    let resp = await verifySignature(req.body.hex);
    if(resp.signatureValid === true)
    {
      //generate new guid
      let guid = storage.generateUUID();
      storage.insertNewSession(db,resp.signedBy,guid,Math.floor(Date.now() / 1000))
      storage.updateSession(db,resp.signedBy,guid,Math.floor(Date.now() / 1000))
      res.send({session: guid, xrpAddress:resp.signedBy});
    }
  } catch {}
});

app.use("/api/richlist", async function (req, res, next) {
  try {
    let rows = await storage.selectRichList(db);
    let richListArchive = await storage.selectRichListArchive(db);
    console.log(richListArchive)
    let sum = await storage.selectGreyHoundSum(db);
    let newObj = []
    let tlData = await getCachedTl('tlData');
    let totalTls = await getCachedTl('totalTls');
    let totalHolders = await getCachedTl('totalHolders');
    let holderData = await getCachedTl('holderData');
    let rank = await storage.selectRank(db,req.body.address);
    //Create object
    for(let i = 0;i < rows.length; i++)
    {
       let previousBalanceReturn = undefined;
       let previousBalance = richListArchive.find(x => x.xrpAddress === rows[i].xrpAddress);
       if(previousBalance != undefined)
       {
          previousBalanceReturn = previousBalance.balance;
       }

       newObj.push({id: rows[i].id, xrpAddress: rows[i].xrpAddress, balance: rows[i].balance, LastUpdated: rows[i].LastUpdated, PreviousBalance: previousBalanceReturn})
    }
    //console.log(newObj.length)
  
    // get page from query params or default to first page
    const page = parseInt(req.body.page) || 1;

    // get pager object for specified page
    const pageSize = 100;
    const pager = paginate(newObj.length, page, pageSize);

    // get page of items from items array
    const pageOfItems = newObj.slice(pager.startIndex, pager.endIndex + 1);

    // return pager object and current page of items
    //console.log(pager)
    res.send({ pager, pageOfItems, sum , tlData, totalTls, totalHolders, holderData, rank});
  } catch {}
});

app.use("/api/mainData", async function (req, res, next) {
  try {
    const client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    const [GreyHoundAmount, tierLevel, transactions, account_info, account_lines, xrp_balance, tx_fees, xrpprices, ghprices, curGh, curXrp] = await Promise.all([
      storage.selectGreyHoundSum(db),
      storage.selectTier(db, req.body.xrpAddress),
      xrplHelper.getAccountTransactions(client,req.body.xrpAddress),
      xrplHelper.getAccountLines(client,process.env.GREYHOUND_ISSUER),
      xrplHelper.getAccountLines(client,req.body.xrpAddress),
      xrplHelper.getBalance(client,req.body.xrpAddress),
      xrplHelper.getTransactionFee(client),
      xrplHelper.getTokenPrice('XRP', 'USD.rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq'),
      xrplHelper.getTokenPrice('Greyhound.rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ', 'XRP'),
      xrplHelper.getLiveTokenPrice('Greyhound.rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ', 'XRP'),
      xrplHelper.getLiveXrpPrice()
    ]);
    let token_volume = await getCachedVolume('12m');
    let transaction_buy = await getCachedOrders('buyData');
    let transaction_sell = await getCachedOrders('sellData');
    let change = await getBalanceChange(req.body.xrpAddress);
    const responsePayload = {
      GreyHoundAmount: GreyHoundAmount,
      Transactions: transactions,
      Account_Info: account_info,
      Account_Lines: account_lines,
      UserTier: tierLevel,
      TokenVolume: token_volume,
      TokenBuy: transaction_buy,
      TokenSell: transaction_sell,
      TransactionFee: tx_fees,
      XRPPrices: xrpprices,
      GHPrices: ghprices,
      CurrentGH: curGh,
      CurrentXRP: curXrp,
      Change: change,
      XRPBalance: xrp_balance
    }
    await client.disconnect();
    res.send(responsePayload);
  } catch(err) {
    console.log(err)
    res.send({"error": err});
  }
});

function convertHexToStr(hex) {
  var str = '';
  for (var i = 0; i < hex.length; i += 2)
      str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return str;
}

async function getNftImage(id,uri) {
  if(cache.has(id)) {
    return cache.get(id);
  }

  if (uri !== "" && uri !== undefined) {
      //convert the hex string to a string
      uri = convertHexToStr(uri);
      if (uri.includes("ipfs://")) {
          uri = uri.replace("ipfs://", "https://cloudflare-ipfs.com/ipfs/");
      }
      //get the image from the URI
      let response = await axios.get(uri);
      let data = response.data;
      //find a field named image
      let image = data.image;
      let name = data.name;
      //return the image
      if (image === undefined || image === "") {
          try {
	          let onTheDex = `https://marketplace-api.onxrp.com/api/metadata/${id}`;
	          let imageUrl = `https://marketplace-api.onxrp.com/api/image/${id}`;
            let response = await axios.get(onTheDex);
            let data = response.data;
            let name = data.name;
            cache.set(id, {image: imageUrl, name: name});
            return {image: imageUrl, name: name};
          } catch (error) {
            console.log('skipping')
          }
      }
      if (image !== undefined)  {
      if (image.includes("ipfs://")) {
        image = image.replace("ipfs://", "https://cloudflare-ipfs.com/ipfs/");
      }}
      cache.set(id, {image: image, name: name});
      return {image: image, name: name};
  }
  else {
        try {
	      console.log("on the dex api")
	      let onTheDex = `https://marketplace-api.onxrp.com/api/metadata/${id}`;
	      let imageUrl = `https://marketplace-api.onxrp.com/api/image/${id}`;
	      let response = await axios.get(onTheDex);
	      let data = await response.data;
	      let name = data.name;
        let attr = data.attributes;
        let coll = data.collection;
	      cache.set(id, {image: imageUrl, name: name, attributes: attr, collection: coll});
	      return {image: imageUrl, name: name, attributes: attr, collection: coll};
      } catch (error) {
        console.log('skipping')
      }
  }
}

async function getNftImagesParallel(ids,uris)
{
  let promises = [];
  for (let i = 0; i < ids.length; i++) {
      promises.push(getNftImage(ids[i],uris[i]));
  }
  let results = await Promise.all(promises);
  return results;
}

app.use("/api/getnfts", async function (req, res, next) {
  try {
    const client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    let nfts = await xrplHelper.getAccountNFTs(client, req.body.xrpAddress);
    await client.disconnect();
    let numNfts = nfts.length;
    nfts = nfts;
    let nftDict = {};
    let ids = [];
    let uris = [];
    for (let i = 0; i < numNfts; i++) {
      let nft = nfts[i];
      let nftId = nft.NFTokenID;
      let nftTaxon = nft.NFTokenTaxon;
      let issuer = nft.Issuer;
      nftDict[nftId] = {taxon: nftTaxon, issuer: issuer};
      ids.push(nftId);
      uris.push(nft.URI);
    }
    let images = await getNftImagesParallel(ids,uris);
    for (let i = 0; i < numNfts; i++) {
      nftDict[ids[i]].image = images[i].image;
      nftDict[ids[i]].name = images[i].name;
    }
    res.send(nftDict);
  } catch(err) {
    console.log(err)
    res.send({"error": err});
  }
});

app.use("/api/registerUser", async function (req, res, next) {
  try {
    //check if user exists
    let user = await storage.checkIfUserExists(db,req.body.address);
    if (user != undefined)
    {
      res.send({success: false, message: "User already exists"});
      // console.log("User already exists");
      return;
    }
    let tierLevel = await storage.selectTier(db, req.body.address);
    if (tierLevel.balance != 0) {
        req.body.Eligible_ts_ad = true;
    }
      await storage.insertUser(db, req.body);
      console.log("User registered");
      res.send({success: true});
  } catch(err) {
    console.log(`Error: ${err}`);
    res.send({success: false});
  } 
});

//an endpoint which stores messages sent to the endpoint in a json file
app.use("/api/submit", async function (req, res, next) {
  try {
    //store the request body in a variable and then write it to a json file
    let data = req.body;
    let json = JSON.stringify(data);
    let path = "../.dashboard.cache/data.json"
    //read the file and then append the new data to it
    fs.readFile(path, 'utf8', function readFileCallback(err, file){
      if (err){
          console.log(err);
      } else {
      //parse the file to get the json object
      file = JSON.parse(file); //now it an object
      //add the new data to the object
      file.push(data); //add some data
      //write the new object to the file
      json = JSON.stringify(file); //convert it back to json
      fs.writeFile(path, json, 'utf8', function(err) {
        if(err) {
          console.log(err);
        }
      }); // write it back
      }
    });
    res.send({success: true});
  } catch(err) {
    console.log(err)
    res.send({success: false});
  }
});

app.use("/api/notifs", async function (req, res, next) {
  try {
    let notifs = await getNotifs();
    res.send(notifs);
  } catch(err) {
    console.log(err)
    res.send({success: false});
  }
});

app.use("/api/getNft", async function (req, res, next) {
   try {
      console.log("getting nft")
      let nfts = await getNftOffs(req.body.address);
      console.log(nfts);
      res.send(nfts);
   } catch (error) {
      console.log(error);
      res.send({"error": error});
   }
});

async function getNftOffs(address)
{
  const issuer = "rpZidWw84xGD3dp7F81ajM36NZnJFLpSZW";
  const client = new xrpl.Client(process.env.XRPL_RPC);
  await client.connect();
  let payload = {
    command: "account_nfts",
    account: issuer,
    ledger_index: "current",
    limit: 400
  };
  let dataDict = {};

  while (true) {
    let data = await client.request(payload);
    let nfts = data.result.account_nfts;
    for (let i = 0; i < nfts.length; i++) {
      let nft = nfts[i];
      let nftId = nft.NFTokenID;
      let nftTaxon = nft.NFTokenTaxon;
      let nftIssuer = nft.Issuer;
      let nftURI = nft.URI;
      if (nftIssuer == issuer)
      {
        dataDict[nftId] = {taxon: nftTaxon, uri: nftURI};
      }
    }
    if (data.result.marker == undefined) {
      break;
    }
    payload.marker = data.result.marker;
  }
  let nftIds = Object.keys(dataDict);
  let offers = {};
  let promises = [];
  for (let i = 0; i < nftIds.length; i++) {
    let nftId = nftIds[i];
    let payload = {
      command: "nft_sell_offers",
      nft_id: nftId,
      ledger_index: "validated",
    };
    promises.push(payload);
    // // let data = await client.request(payload);
    // try {
    //   var data = await client.request(payload);
    // } catch (error) {
    //   console.log(error);
    //   continue;
    // }
    // let nftOffers = data.result.offers;
    // for (let j = 0; j < nftOffers.length; j++) {
    //   let offer = nftOffers[j];
    //   let dest = offer.destination;
    //   let index = offer.nft_offer_index;
    //   if (dest == address) {
    //     offers[nftId] = {index: index};
    //   }
    // }
  }

  //make all the requests in parallel
  // let results = await Promise.all(promises.map(payload => client.request(payload)));
  //continue if there is an error
  let results = await Promise.allSettled(promises.map(payload => client.request(payload)));
  for (let i = 0; i < results.length; i++) {
    let data = results[i];
    if (data.status == "rejected") {
      continue;
    }
    console.log(data);
    console.log(data.value.result.offers);
    // let nftOffers = data.result.offers;
    try {
      var nftOffers = data.value.result.offers;
    } catch (error) {
      console.log(error);
      continue;
    }
    for (let j = 0; j < nftOffers.length; j++) {
      let offer = nftOffers[j];
      let dest = offer.destination;
      let index = offer.nft_offer_index;
      if (dest == address) {
        offers[nftIds[i]] = {index: index};
      }
    }
  }
  console.log(offers);
  let nftDict = {};
  for (let i = 0; i < nftIds.length; i++) {
    let nftId = nftIds[i];
    if (nftId in offers) {
      nftDict[nftId] = {taxon: dataDict[nftId].taxon, uri: dataDict[nftId].uri, index: offers[nftId].index};
    }
  }

  let len = Object.keys(nftDict).length;
  return {nfts: nftDict, len: len};  
}

async function getBalanceChange(address) {
  const client = new xrpl.Client('wss://xrplcluster.com');
  const time = Math.floor(Date.now() / 1000);
  let time30dayBefore = time - 2592000;
  let URL = 'https://s1.xrplmeta.org/ledger?time=' + time30dayBefore;
  let response = await axios.get(URL);
  let ledger = response.data.sequence;
  // console.log(ledger);
  await client.connect();
  const account = await client.request({
    command: 'account_lines',
    account: address,
    ledger_index: ledger,
    connectionTimeout: 10000
    });
  let pastBalance = 0;
    // console.log(account);
    let lines = account.result.lines
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].currency === '47726579686F756E640000000000000000000000' && lines[i].account === 'rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ') {
            // console.log(lines[i].balance);
            pastBalance = lines[i].balance;
        }
    }
    const account2 = await client.request({
      command: 'account_lines',
      account: address,
      connectionTimeout: 10000
      });
    let currentBalance = 0;
      
      let lines2 = account2.result.lines
      for (let i = 0; i < lines2.length; i++) {
          if (lines2[i].currency === '47726579686F756E640000000000000000000000' && lines2[i].account === 'rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ') {
              // console.log(lines[i].balance);
              currentBalance = lines2[i].balance;
          }
      }
      let balanceChangePercent = ((currentBalance - pastBalance) / pastBalance) * 100;
      client.disconnect();
      return balanceChangePercent;
}

async function getCachedVolume(range) {
  return new Promise((resolve, reject) => {
    fs.readFile("../.dashboard.cache/volume_data.json", "utf8", (err, jsonString) => {
      if (err) {
        reject(err);
      }
      try {
        const volume = JSON.parse(jsonString);
        resolve(volume[range]);
      } catch (err) {
        reject(err);
      }
    });
  }) 
}

async function getNotifs() {
  return new Promise((resolve, reject) => {
    fs.readFile("../.dashboard.cache/data.json", "utf8", (err, jsonString) => {
      if (err) {
        reject(err);
      }
      try {
        const notifs = JSON.parse(jsonString);
        resolve(notifs);
      } catch (err) {
        reject(err);
      }
    });
  })
}

async function getCachedOrders(orderType) {
  return new Promise((resolve, reject) => {
    fs.readFile("../.dashboard.cache/buy_sell_data.json", "utf8", (err, jsonString) => {
      if (err) {
        reject(err);
      }
      try {
        const marketData = JSON.parse(jsonString);
        resolve(marketData[orderType]);
      } catch (err) {
        reject(err);
      }
    });
  }) 
}

async function getCachedTl(orderType){
  return new Promise((resolve, reject) => {
    fs.readFile("../.dashboard.cache/tls.json", "utf8", (err, jsonString) => {
      if (err) {
        reject(err);
      }
      try {
        const marketData = JSON.parse(jsonString);
        resolve(marketData[orderType]);
      } catch (err) {
        reject(err);
      }
    });
  })
}

async function checkEligible(address){
  //open the AirdropFinal.csv file and check if address is in it
  let eligible = false;
  let csv = await fs.readFileSync('AirdropFinal.csv', 'utf8');
  let lines = csv.split(' ');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].split(',');
    if (line[1] === address) {
      eligible = true;
      break;
    }
  }
  return eligible;
}

app.use("/api/getnftsData", async function (req, res, next) {
  try {
    let nftId = req.body.id;
    //check if nft is in cache
    if (nftId in cacheURIDATA) {
      res.send(cacheURIDATA[nftId]);
    } else {

    let address = req.body.address;
    let client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    let nfts = await xrplHelper.getAccountNFTs(client, address);
    for (let i = 0; i < nfts.length; i++) {
      let nft = nfts[i];
      // console.log(nft);
      if (nft.NFTokenID === nftId) {
        let uri = nft.URI;
        console.log(uri);
        if (uri !== undefined) {
        uri = convertHexToStr(uri);
        uri = uri.replace("ipfs://", "https://cloudflare-ipfs.com/ipfs/");
        let dataDict = await axios.get(uri);
        let image = dataDict.data.image;
        let name = dataDict.data.name;
        let description = dataDict.data.description;
        let attributes = dataDict.data.attributes;
        let collection = dataDict.data.collection.family;
        let nftDataDict = {
          "image": image,
          "name": name,
          "attributes": attributes,
          "owner": address,
          "collection":{
            "name": collection,
            "description": description
          }
        }
        client.disconnect();
        // console.log(nftDataDict);
        cacheURIDATA[nftId] = nftDataDict;
        res.set('Access-Control-Allow-Origin', '*');
        res.send(nftDataDict);
        } else {
          // res.send("No URI")
          let nftData = await getNftImage(nftId,undefined);
          res.set('Access-Control-Allow-Origin', '*');
          let nftDataDict = {
            "image": nftData.image,
            "name": nftData.name,
            "attributes": nftData.attributes,
            "owner": address,
            "collection":{
              "name": nftData.collection.name,
              "description": nftData.collection.description
            }
          }
          cacheURIDATA[nftId] = nftDataDict;
          res.send(nftDataDict);
        }
      }
    }
    client.disconnect();
  }
  } catch (err) {
    console.log(err);
    res.send({error: err});
  }
});

// app.use("/api/eligible", async function (req, res, next) {
//   try {
//     let address = req.body.address;
//     //check if the address is in the AidropFinal.csv file
//     let eligible = await checkEligible(address);
//     res.set('Access-Control-Allow-Origin', '*');
//     res.send(eligible);
//   } catch (err) {
//     console.log(err);
//     res.send(err);
//   }
// });

app.use("/api/eligible", async function (req, res, next) {
  try {
    console.log(req.query.address);
    let address = req.query.address;
    //check if the address is in the AidropFinal.csv file
    let eligible = await checkEligible(address);
    res.set('Access-Control-Allow-Origin', '*');
    console.log(eligible);
    // res.send({eligible: eligible});
    //return 200 if eligible
    if (eligible) {
      res.sendStatus(200);
    }
    //return 404 if not eligible
    else {
      res.sendStatus(404);
    }
  } catch (err) {
    console.log(err);
    res.send(err);
  }
});

//Rate Limiting
const apiLimiter = rateLimit({
	windowMs: 1 * 60 * 1000, // 1 minutes
	max: 10, // Limit each IP to 20 requests per `window` (here, per 15 minutes)
	standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
})

const apiLimiter10 = rateLimit({
	windowMs: 1 * 60 * 1000, // 1 minutes
	max: 10, // Limit each IP to 20 requests per `window` (here, per 15 minutes)
	standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
})

// your express configuration here
app.use('/api', apiLimiter)
// app.use('/eth', apiLimiter10)
app.use('/xumm', apiLimiter10)

var httpServer = http.createServer(app);

httpServer.listen(PORT);