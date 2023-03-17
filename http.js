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
const { XrplClient } = require('xrpl-client')
const { derive, sign } = require('xrpl-accountlib')
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
let mariadb = require('mariadb');
const crypto = require('crypto');


const app = express();

const corsOptions = {
  origin: process.env.WHITELIST_URL,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type']
};

app.use(cors(corsOptions));

const PORT = process.env.API_SERVICE_PORT;
const API_SERVICE_URL = process.env.API_SERVICE_URL;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

var db;
var storage;
var xrplHelper;
var cache = new Map();
var cacheURIDATA = new Map();
var priceCache = new Map();
var currentlyMinting = new Map();
//update the price cache every 5 minutes
setInterval(function(){
  if (priceCache.size > 0) {
    priceCache.clear();
    console.log("Price cache cleared");
  }
}, 300000);

// Create a connection pool
var pool = getDb();

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

app.get("/api/greyhoundBalance", async function (req, res, next) {
  try {
    const client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    const greyhoundBalance = await xrplHelper.getAccountLines(client,req.query.address);
    await client.disconnect();
    res.send(greyhoundBalance);
  } catch {
    console.log("Error getting greyhound balance");
    res.send("Error getting greyhound balance");
  }
});

app.use("/api/mainData", async function (req, res, next) {
  try {
    const client = new xrpl.Client(process.env.XRPL_RPC,
      {
        connectionTimeout: 60000
      });
    await client.connect();
    //do the same as above but exclude the prices function and check if the prices are already in cache, if not then get them
    const [GreyHoundAmount, tierLevel, transactions, account_info, account_lines, xrp_balance, tx_fees] = await Promise.all([
      storage.selectGreyHoundSum(db),
      storage.selectTier(db, req.body.xrpAddress),
      xrplHelper.getAccountTransactions(client,req.body.xrpAddress),
      xrplHelper.getAccountLines(client,process.env.GREYHOUND_ISSUER),
      xrplHelper.getAccountLines(client,req.body.xrpAddress),
      xrplHelper.getBalance(client,req.body.xrpAddress),
      xrplHelper.getTransactionFee(client),
    ]);
    if (priceCache.get('xrpprices') === undefined) {
      var xrpprices = await xrplHelper.getTokenPrice('XRP', 'USD.rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq', client);
      priceCache.set('xrpprices', xrpprices);
    } else {
      var xrpprices = priceCache.get('xrpprices');
    }
    if (priceCache.get('ghprices') === undefined) {
      var ghprices = await xrplHelper.getTokenPrice('47726579686F756E640000000000000000000000.rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ', 'XRP', client);
      priceCache.set('ghprices', ghprices);
    } else {
      var ghprices = priceCache.get('ghprices');
    }
    if (priceCache.get('curGh') === undefined) {
      var curGh = await xrplHelper.getLiveTokenPrice('Greyhound.rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ', 'XRP');
      priceCache.set('curGh', curGh);
    } else {
      var curGh = priceCache.get('curGh');
    }
    if (priceCache.get('curXrp') === undefined) {
      var curXrp = await xrplHelper.getLiveXrpPrice();
      priceCache.set('curXrp', curXrp);
    } else {
      var curXrp = priceCache.get('curXrp');
    }
    let token_volume = await getCachedVolume('12m');
    let transaction_buy = await getCachedOrders('buyData');
    let transaction_sell = await getCachedOrders('sellData');
    let change = await getBalanceChange(client, req.body.xrpAddress);
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
    if (err instanceof xrpl.NotConnectedError) {
      console.log("Timeout error");
    }
    res.send({"error": err});
  }
});

function getDb() {
  return mariadb.createPool({
    port: process.env.DB_PORT,
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_SCHEMA
  });
}

function convertHexToStr(hex) {
  var str = '';
  for (var i = 0; i < hex.length; i += 2)
      str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return str;
}

async function getNftImage(id,uri) {
  return
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
      console.log("getting nft" + req.body.address);
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
  const issuer = process.env.GREYHOUND_MINTER;
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
    if('marker' in data.result) {
      payload.marker = data.result.marker;
    }
    else {
      break;
    }
    console.log(nfts);
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
  }

  let results = await Promise.allSettled(promises.map(payload => client.request(payload)));
  for (let i = 0; i < results.length; i++) {
    let data = results[i];
    if (data.status == "rejected") {
      continue;
    }
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

async function getBalanceChange(client, address) {
  const time = Math.floor(Date.now() / 1000);
  const timeBefore = time - process.env.BALANCE_TIME;
  const URL = process.env.XRPL_META_URL + '/ledger?time=' + timeBefore;
  const response = await axios.get(URL);
  const ledger = response.data.sequence;
  const account = await client.request({
    command: 'account_lines',
    account: address,
    ledger_index: ledger,
    connectionTimeout: 10000
    });
  let pastBalance = 0;
  let lines = account.result.lines
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].currency === process.env.GREYHOUND_CURRENCY && lines[i].account === process.env.GREYHOUND_ISSUER) {
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
    if (lines2[i].currency === process.env.GREYHOUND_CURRENCY && lines2[i].account === process.env.GREYHOUND_ISSUER) {
      currentBalance = lines2[i].balance;
    }
  }
  let balanceChangePercent = ((currentBalance - pastBalance) / pastBalance) * 100;
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

async function checkRarity(attributes) { 
    try {
      let URL = "https://bafybeigfu3gqvea75rercpqdyjjs2lnuoyh66mz2rjijrtd7zqfux2wjve.ipfs.w3s.link/traits.json"
      let response = await axios.get(URL);
      let attributesNew = [];
      for (let i = 0; i < attributes.length; i++) {
        let attribute = attributes[i];
        let attributeNew = attribute;
        let trait = response.data.find(trait => trait.label === attribute.trait_type);
        if (trait) {
          let traitValue = trait.traits.find(traitValue => traitValue.label === attribute.value);
          if (traitValue) {
            attributeNew.per = traitValue.percentage;
          }
        }
        attributesNew.push(attributeNew);
      }

      return attributesNew;
      
    } catch (error) {
      console.log(error);
    }
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
        let taxon = nft.NFTokenTaxon;
        if (uri !== undefined) {
        uri = convertHexToStr(uri);
        uri = uri.replace("ipfs://", "https://cloudflare-ipfs.com/ipfs/");
        let dataDict = await axios.get(uri);
        let image = dataDict.data.image;
        let name = dataDict.data.name;
        let description = dataDict.data.description;
        let attributes = dataDict.data.attributes;
        attributes = await checkRarity(attributes);
        let collection = dataDict.data.collection.family;
        let rarity = dataDict.data.rarity;
        let tierNFT = dataDict.data.tier;
        let anim = dataDict.data.animation;
        let animFlag = false
        if (anim !== undefined) {
          image = anim;
          animFlag = true;
        }
        let nftDataDict = {
          "image": image,
          "name": name,
          "attributes": attributes,
          "owner": address,
          "collection":{
            "name": collection,
            "description": description
          },
          "rarity": rarity,
          "tier": tierNFT,
          "anim": animFlag,
          "taxon": taxon
        }
        client.disconnect();
        // console.log(nftDataDict);
        cacheURIDATA[nftId] = nftDataDict;

        res.send(nftDataDict);
        } else {
          // res.send("No URI")
          let nftData = await getNftImage(nftId,undefined);
  
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

app.use("/api/eligible", async function (req, res, next) {
  try {
    console.log(req.query.address);
    let address = req.query.address;
    //check if the address is in the AidropFinal.csv file
    let eligible = await checkEligible(address);
    res.set('Access-Control-Allow-Origin',`${process.env.WHITELIST_URL}`);
    console.log(eligible);
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

//encrypt/decrypt
const encrypt = (text, password) => {
  if (process.versions.openssl <= '1.0.1f') {
      throw new Error('OpenSSL Version too old, vulnerability to Heartbleed');
  }
  // let iv = crypto.randomBytes(IV_LENGTH);
  let iv = process.env.ENC_IV;
  iv = Buffer.from(iv, 'utf8');
  let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(password), iv);
  let encrypted = cipher.update(text);

  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

const decrypt = (text, password) => {
  let textParts = text.split(':');
  
  let iv = Buffer.from(textParts.shift(), 'hex');
  let encryptedText = Buffer.from(textParts.join(':'), 'hex');

  let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(password), iv);
  let decrypted = decipher.update(encryptedText);

  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}
//minting/db endpoints

app.get("/mint/pending", async function (req, res, next) {
  try {
    const address = req.query.address;
    if (currentlyMinting.get(address) === true) {
      res.send({status: "minting"});
      return;
    } 
    console.log(`querying for address: ${address}`);
    const pending = await pool.query("SELECT r.id AS request_id, bt.id AS burnt_id, mt.id AS mint_id, ot.id AS offer_id, ct.id AS claim_id FROM nfts_requests r LEFT JOIN nfts_requests_transactions bt ON bt.request_id = r.id AND bt.`status` = 'tesSUCCESS' AND bt.`action` = 'BURN' LEFT JOIN nfts_requests_transactions mt ON mt.request_id = r.id AND mt.`status` = 'tesSUCCESS' AND mt.`action` = 'MINT' LEFT JOIN nfts_requests_transactions ot ON ot.request_id = r.id AND ot.`status` = 'tesSUCCESS' AND ot.`action` = 'OFFER' LEFT JOIN nfts_requests_transactions ct ON ct.request_id = r.id AND ct.`status` = 'tesSUCCESS' AND ct.`action` = 'CLAIM' WHERE r.wallet = ? AND r.`status` != 'tesSUCCESS' GROUP BY r.id", [address]);
    console.log(pending[0])
    if (pending[0] === undefined) {
      const addedRow = await addToDb(address);
      const pid = addedRow.insertId;
      //it has `n` at the end, so we need to remove it
      if (pid.toString().endsWith('n')) {
        pid = pid.toString().slice(0, -1);
      }
      console.log(pid);
      const encrypted = encrypt(`${pid}`, process.env.ENC_PASSWORD);
      res.send({pending: true, stage: "pending", request_id: encrypted});
      return;
    }
    const objectR = pending[0];
    const pid = objectR.request_id;
    const encryptedPid = encrypt(`${pid}`, process.env.ENC_PASSWORD);

    if (objectR.request_id != null && objectR.claim_id == null && objectR.offer_id == null && objectR.mint_id == null && objectR.burnt_id == null) {
      res.send({pending: true, stage: "pending", request_id: encryptedPid});
    } else if (objectR.burnt_id != null && objectR.mint_id == null && objectR.offer_id == null && objectR.claim_id == null) {
      res.send({pending: true, stage: "burnt", request_id: encryptedPid});
    } else if (objectR.mint_id != null && objectR.offer_id === null && objectR.claim_id === null) {
      // res.send({pending: true, stage: "minted", request_id: objectR.request_id});
      //create offer
      const hash = await pool.query("SELECT hash FROM nfts_requests_transactions WHERE id = ?", [objectR.mint_id]);
      const nftId = await checkHashMint(hash[0].hash);
      const offer = await createNftOffer(nftId, address);

      pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'OFFER', ?, UNIX_TIMESTAMP())", [objectR.request_id, offer]);
      pool.query("UPDATE nfts_requests SET `status` = 'active' WHERE id = ?", [objectR.request_id]);
      
      let nftNum = await pool.query("SELECT nft_id FROM nfts_requests WHERE id = ?", [objectR.request_id]);
      nftNum = nftNum[0].nft_id;
      await updateNftId(parseInt(nftNum-1), nftId);
      
      let nftImage = await pool.query("SELECT cid FROM nfts WHERE num = ?", [nftNum]);
      nftImage = await getNftImageFromURL("https://cloudflare-ipfs.com/ipfs/" + nftImage[0].cid + "/" + nftId + ".json");

      res.send({pending: true, stage: "offered", request_id: encryptedPid, offer: offer,nft_name: nftNum,nft_image: nftImage});
    } else if (objectR.offer_id != null && objectR.claim_id == null) {
      const offerInfo = await pool.query("SELECT rt.hash, r.nft_id, n.cid FROM nfts_requests_transactions rt INNER JOIN nfts_requests r ON r.id = rt.request_id INNER JOIN nfts n ON n.id = r.nft_id WHERE rt.id = ? AND rt.`action` = 'OFFER'", [objectR.offer_id]);
      const {offerHash, nftId, nftImageCID } = offerInfo[0]
      const nftImage = await getNftImageFromURL("https://cloudflare-ipfs.com/ipfs/" + nftImageCID + "/" + nftId + ".json");

      res.send({pending: true, stage: "offered", request_id: encryptedPid, offer: offerHash, nft_name: nftId, nft_image: nftImage});
    } else {
      res.send({pending: false});
    }
    /*
    let object = pending[0];
    if (object.request_id != null) {}
    */
  } catch (error) {
    console.log(error);
  }
});

app.post("/mint/burnt", async function (req, res, next) {
  try {
    let address = req.body.address;
    let txnHash = req.body.txnHash;
    console.log(`updating address: ${address} from pending to burnt`);
    // let pid = 0;
    // let pendingg = await pool.query("SELECT r.id AS request_id, bt.id AS burnt_id, mt.id AS mint_id, ot.id AS offer_id, ct.id AS claim_id FROM nfts_requests r LEFT JOIN nfts_requests_transactions bt ON bt.request_id = r.id AND bt.`status` = 'tesSUCCESS' AND bt.`action` = 'BURN' LEFT JOIN nfts_requests_transactions mt ON mt.request_id = r.id AND mt.`status` = 'tesSUCCESS' AND mt.`action` = 'MINT' LEFT JOIN nfts_requests_transactions ot ON ot.request_id = r.id AND ot.`status` = 'tesSUCCESS' AND ot.`action` = 'OFFER' LEFT JOIN nfts_requests_transactions ct ON ct.request_id = r.id AND ct.`status` = 'tesSUCCESS' AND ct.`action` = 'CLAIM' WHERE r.wallet = ? AND r.`status` != 'tesSUCCESS' GROUP BY r.id", [address]);
    // pid = pendingg[0].request_id;
    let pid = req.body.pid;
    console.log(`pid: ${pid}`)
    //decrypt pid
    pid = decrypt(pid, process.env.ENC_PASSWORD);
    pid = parseInt(pid);
    //check if the same params are already in the db
    let pending = await pool.query("SELECT id FROM nfts_requests_transactions WHERE request_id = ? AND `status` = 'tesSUCCESS' AND `action` = 'BURN' AND hash = ?", [pid, txnHash]);
    if (pending[0] === undefined) {
      //add address to db
      const pending = await pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'BURN', ?, UNIX_TIMESTAMP())", [pid, txnHash]);
      pool.query("UPDATE nfts_requests SET `burn_amount` = 10000000000 WHERE id = ?", [pid]);
      res.send("success");
      return;
    
    res.send({error: "already in db"});
  } catch (error) {
    console.log(error);
  }
});

app.post("/mint/mint_txn", async function (req, res, next) {
try {
      const address = req.body.address;
      currentlyMinting.set(address, true);
      console.log(`updating address: ${address} from burnt to minted`);
      //decrypt pid
      const pid = parseInt( decrypt(req.body.pid, process.env.ENC_PASSWORD) );
      //add address to db
      const rnft = await getRandomNFT();
      console.log('random nft: ' + rnft.cid + '/' + rnft.num + '.json')
      const rnfturl = 'https://cloudflare-ipfs.com/ipfs/' + rnft.cid + '/' + rnft.num + '.json';
      const nftImage = await getNftImageFromURL(rnfturl);
      console.log('nft image: ' + nftImage);
      const cid = 'ipfs://' + rnft.cid + '/' + rnft.num + '.json';
      const txnHash = await mintNft(cid)   
      //add hash to db
      pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'MINT', ?, UNIX_TIMESTAMP())", [pid, txnHash]);
      pool.query("UPDATE nfts_requests SET `nft_id` = ? WHERE id = ?", [rnft.num, pid]);
      const nftId = await checkHashMint(txnHash);
      const offer = await createNftOffer(nftId, address);
      pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'OFFER', ?, UNIX_TIMESTAMP())", [pid, offer]);
      pool.query("UPDATE nfts_requests SET `status` = 'active' WHERE id = ?", [pid]);
      await updateNftId(rnft.id, nftId); //update nft id in db
      res.send({nft_id: nftId, offer: offer, nft_image: nftImage, num: rnft.num});
      //remove from currently minting
      currentlyMinting.delete(address);
} catch (error) {
  console.log(error);
      currentlyMinting.delete(address);
}
});

app.post("/mint/claim_txn", async function (req, res, next) {
    let address = req.body.address;
    let hash = req.body.hash;
    let pid = req.body.pid;
    //decrypt pid
    pid = decrypt(pid, process.env.ENC_PASSWORD);
    pid = parseInt(pid);

    console.log(`updating address: ${address} from offered to claimed`);
    //update in nfts_requests to tesSUCCESS
    pool.query("UPDATE nfts_requests SET `status` = 'tesSUCCESS' WHERE id = ?", [pid]);
    //add hash to db
    pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'CLAIM', ?, UNIX_TIMESTAMP())", [pid, hash])
    res.send({status: 'tesSUCCESS'});
});

async function checkHashMint(minting_hash) {
try {
	  const client = new xrpl.Client(process.env.XRPL_RPC);
	  await client.connect();
	  let submit = await client.request({ command: 'tx', transaction: minting_hash })
	  let NFT_id = null;
	  const encodedURI = submit.result.URI;
	  submit = submit.result;
    console.log(submit);
	  for (let index = 0; index < submit.meta.AffectedNodes.length; index++) {
	    const affectedNode = submit.meta.AffectedNodes[index];
	    let nodeToCheck;
	
	    if( affectedNode.hasOwnProperty('CreatedNode') ){
	      nodeToCheck = affectedNode.CreatedNode.NewFields
	    }
	    else if( affectedNode.hasOwnProperty('ModifiedNode') ){
	      nodeToCheck = affectedNode.ModifiedNode.FinalFields
	    }
	
	    if( nodeToCheck.hasOwnProperty('NFTokens') ){
	      for (let index2 = 0; index2 < nodeToCheck.NFTokens.length; index2++) {
	        const tokenObj = nodeToCheck.NFTokens[index2];
	        if( tokenObj.NFToken.URI == encodedURI ){
	              NFT_id = tokenObj.NFToken.NFTokenID;
	          break;
	        }
	
	      }   
	    }
	  }
	  await client.disconnect();
    console.log("Nft id: " + NFT_id);
	  return NFT_id;
} catch (error) {
	console.log(error);
}}

async function mintNft(cid) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log("Minting NFT: " + cid);
      const client = new XrplClient(process.env.XRPL_RPC);
      const wallet = derive.familySeed(process.env.WALLET_SECRET);
      const address = wallet.address;
      const client2 = new xrpl.Client(process.env.XRPL_RPC);
      await client2.connect();
      const req = await client2.request({ command: 'account_info', account: address })
      const sequence = req.result.account_data.Sequence;

      const mintTransaction = {
        TransactionType: 'NFTokenMint',
        Account: address,
        TransferFee: parseInt("5000"),
        NFTokenTaxon: 1,
        URI: Buffer.from(String(cid), 'utf-8').toString('hex').toUpperCase(),
        Fee: "300",
        Flags: (xrpl.NFTokenMintFlags.tfTransferable + xrpl.NFTokenMintFlags.tfOnlyXRP),
        Sequence: sequence,
        "Memos": [
          {
            "Memo": {
              "MemoType": Buffer.from("NFT", 'utf-8').toString('hex').toUpperCase(),
              "MemoData": Buffer.from("NFT From Greyhound Dashboard!", 'utf-8').toString('hex').toUpperCase()
            }
          }
        ]
      }

      const signed = sign(mintTransaction, wallet);
      console.log('Signed transaction: ', signed.signedTransaction)
      const submit = await client.send(
        {
          command: 'submit',
          tx_blob: signed.signedTransaction
        }
      )

      const val_ledger = submit.validated_ledger_index;

      client.on('ledger', async (ledger) => {
        if (ledger.ledger_index > val_ledger+1) {
          console.log("Transaction result:", submit.tx_json.hash)
          resolve(submit.tx_json.hash);
          client.close();
          await client2.disconnect();
        }
      })


    } catch (error) {
      console.log(error);
      reject(error);
    }
  })
}

async function createNftOffer(nftId,dest) {
try {
	  const secret = process.env.WALLET_SECRET;
	  const client = new xrpl.Client(process.env.XRPL_RPC);
	  await client.connect();
	  const wallet = xrpl.Wallet.fromSeed(secret);
	  const address = wallet.classicAddress;
	
	  let offer_txn_json = {
	    TransactionType: "NFTokenCreateOffer",
	    Account: address,
	    NFTokenID: nftId,
	    Destination: dest,
	    Amount: "1",
      Fee: "300",
      Flags: 1
	  };
	
	  const response = await client.submitAndWait(offer_txn_json, {wallet: wallet})
	  console.log(`\nTransaction submitted-2: ${response.result.hash}`);
    let offer = getNftOffer(response.result.hash);
	
	  await client.disconnect();
	
	  return offer;
} catch (error) {
	console.log(error);
}
}

async function getRandomNFT() {
    let row = await pool.query("SELECT * FROM nfts WHERE nftid IS NULL AND minted=0 ORDER BY RAND() LIMIT 1");
    console.log(row[0]);
    //change minted to 1
    pool.query("UPDATE nfts SET minted = 1 WHERE id = ?", [row[0].id]);
    return row[0];
}

async function updateNftId(id, nftid) {
    pool.query("UPDATE nfts SET nftid = ? WHERE id = ?", [nftid, id]);
}

async function getNftImageFromURL(cid) {
try {
	  const url = `${cid}`;
	  let response = await axios.get(url);
	  // console.log(response);
	  let image = await response.data.image;
	  image = image.replace("ipfs://", "https://cloudflare-ipfs.com/ipfs/");
	  console.log(image);
	  return image;
} catch (error) {
    console.log(error);
}
}

async function getNftOffer(offerHash) {
    let client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    let offer = await client.request({
        command: "tx",
        transaction: offerHash,
        binary: false
    });
    await client.disconnect();
    let affectedNodes = offer.result.meta.AffectedNodes;
    for (let index = 0; index < affectedNodes.length; index++) {
        const affectedNode = affectedNodes[index];
        if (affectedNode.hasOwnProperty('ModifiedNode')) {
          if (affectedNode.ModifiedNode.LedgerEntryType == "NFTokenOffer") {
              offer = affectedNode.ModifiedNode.LedgerIndex;
              break;
          }
        }
        else if (affectedNode.hasOwnProperty('CreatedNode')) {
            if (affectedNode.CreatedNode.LedgerEntryType == "NFTokenOffer") {
                offer = affectedNode.CreatedNode.LedgerIndex;
                break;
            }
        }
    }
    return offer;
}
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

async function addToDb(address) {
  try {
    console.log(`adding address: ${address}`);
    let pending = await pool.query("INSERT INTO nfts_requests (`nft_id`, `wallet`, `burn_amount`, `date_added`, `status`) VALUES (NULL, ?, ?, UNIX_TIMESTAMP(), ?)", [address, 0, "pending"]);
    console.log("added to db")
    return pending;
  } catch (error) {
    console.log(error);
  }
}