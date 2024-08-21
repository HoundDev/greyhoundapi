const express = require("express");
const fs = require("fs");
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
const { convertStringToHex } = require("xrpl");
const logging = true

const app = express();

const corsOptions = {
  // origin: process.env.WHITELIST_URL,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Origin', 'X-Auth-Token']
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
const miscCache = new Map();

//update the price cache every 5 minutes
setInterval(function () {
  if (priceCache.size > 0) {
    priceCache.clear();
    console.log("Price cache cleared");
  }
}, 300000); // 5 minutes

//clear miscCache every 2 minutes
setInterval(function () {
  if (miscCache.size > 0) {
    miscCache.clear();
    console.log("Misc cache cleared");
  }
}, 120000); // 2 minutes

//clear uri cache every 30 minutes
setInterval(function () {
  if (cacheURIDATA.size > 0) {
    cacheURIDATA.clear();
    console.log("URI cache cleared");
  }
}, 1800000); // 30 minutes

// Create a connection pool
var pool = getDb();
var poolStaking = getDbStaked();

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

xrplHelper = new XrplHelpers();
if (!fs.existsSync("./storage.db")) {
  storage = new Storage();
  db = storage.createDatabase();
  storage.readSnapshotData(db, 'tier1b.csv');
  storage.readSnapshotData(db, 'tier500m.csv');
  storage.readSnapshotData(db, 'tier250m.csv');
  storage.readSnapshotData(db, 'tier100m.csv');
} else {
  storage = new Storage();
  db = storage.getInstance();
}

app.use("/xumm/createpayload", async function (req, res, next) {
  try {
    const Sdk = new XummSdk(
      process.env.XUMM_API_KEY,
      process.env.XUMM_API_SECRET
    );
    // console.log(req.body);
    const payload = await Sdk.payload.create(req.body, true);
    // console.log(payload);
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
  } catch { }
});

app.use("/xumm/checksig", async function (req, res, next) {
  try {
    let resp = await verifySignature(req.body.hex);
    if (resp.signatureValid === true) {
      //generate new guid
      let guid = storage.generateUUID();
      storage.insertNewSession(db,resp.signedBy,guid,Math.floor(Date.now() / 1000))
      storage.updateSession(db,resp.signedBy,guid,Math.floor(Date.now() / 1000))
      console.log(resp.signedBy)
      //encrypt the address
      let encrypted = encrypt(resp.signedBy,process.env.ENC_PASSWORD);
      console.log(encrypted);
      res.send({session: guid, xrpAddress:resp.signedBy, token: encrypted});
    }
  } catch (err) {
    console.log(err);
  }
});

app.use("/api/richlist", async function (req, res, next) {
  try {
    let rows = await storage.selectRichList(db);
    let richListArchive = await storage.selectRichListArchive(db);
    // console.log(richListArchive)
    let sum = await storage.selectGreyHoundSum(db);
    let newObj = []
    let tlData = await getCachedTl('tlData');
    let totalTls = await getCachedTl('totalTls');
    let totalHolders = await getCachedTl('totalHolders');
    let holderData = await getCachedTl('holderData');
    let rank = await storage.selectRank(db, req.body.address);
    //Create object
    for (let i = 0; i < rows.length; i++) {
      let previousBalanceReturn = undefined;
      let previousBalance = richListArchive.find(x => x.xrpAddress === rows[i].xrpAddress);
      if (previousBalance != undefined) {
        previousBalanceReturn = previousBalance.balance;
      }

      newObj.push({ id: rows[i].id, xrpAddress: rows[i].xrpAddress, balance: rows[i].balance, LastUpdated: rows[i].LastUpdated, PreviousBalance: previousBalanceReturn })
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
    res.send({ pager, pageOfItems, sum, tlData, totalTls, totalHolders, holderData, rank });
  } catch { }
});

app.get("/api/greyhoundBalance", async function (req, res, next) {
  try {
    const client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    const greyhoundBalance = await xrplHelper.getGreyhoundBalance(client, req.query.address);
    await client.disconnect();
    res.send(greyhoundBalance);
  } catch (err) {
    console.log("Error getting greyhound balance");
    res.send("Error getting greyhound balance\n" + err);
  }
});

app.use("/api/mainData", async function (req, res, next) {
  try {
    const client = new xrpl.Client(process.env.XRPL_RPC,
      {
        connectionTimeout: 60000
      });
    await client.connect();
    console.log("Connected to XRPL");
    //do the same as above but exclude the prices function and check if the prices are already in cache, if not then get them
    const [GreyHoundAmount, tierLevel, transactions, account_info, account_lines, xrp_balance, tx_fees] = await Promise.all([
      storage.selectGreyHoundSum(db),
      storage.selectTier(db, req.body.xrpAddress),
      xrplHelper.getAccountTransactions(client, req.body.xrpAddress),
      xrplHelper.getAccountLines(client, process.env.GREYHOUND_ISSUER),
      xrplHelper.getAccountLines(client, req.body.xrpAddress),
      xrplHelper.getBalance(client, req.body.xrpAddress),
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
  } catch (err) {
    console.log(err)
    if (err instanceof xrpl.NotConnectedError) {
      console.log("Timeout error");
    }
    res.send({"error": err});
  }
});

app.use("/api/getHoundBalance", async function (req, res, next) {
  try {
    const client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    const account_lines = await xrplHelper.getAccountLines(client,req.body.xrpAddress);
    await client.disconnect();
    const ghBal = account_lines.find(x => x.currency === process.env.GREYHOUND_CURRENCY && x.account === process.env.GREYHOUND_ISSUER);
    res.send(ghBal);
  } catch {
    console.log("Error getting greyhound balance");
    res.send("Error getting greyhound balance\n" + err);
  }
});

app.use("/api/stakeNft", async function (req, res, next) {
  try {
    const token = req.body.token;
    const nftids = req.body.nfts;
    console.log(nftids);
    console.log(token);

    //decrypt the token
    let decrypted = decrypt(token,process.env.ENC_PASSWORD);
    console.log(decrypted);
    //check if user exists in `users` table
    let user = await poolStaking.query("SELECT * FROM users WHERE address = ?", [decrypted]);
    if (user.length === 0) {
      //add user to `users` table
      await poolStaking.query("INSERT INTO users (xrpAddress) VALUES (?)", [decrypted]);
      user = await poolStaking.query("SELECT * FROM users WHERE address = ?", [decrypted]);
    }
    
    //add all nfts to stakedNfts, userId, nftId
    for (let i = 0; i < nftids.length; i++) {
      await poolStaking.query("INSERT INTO stakedNfts (userId, nftid) VALUES (?, ?)", [user[0].id, nftids[i]]);
    }
    res.send({success: true, message: "NFTs staked"});
  } catch (error) {
    console.log(error);
    res.send({success: false});
  }
});

app.use("/api/getStakedNfts", async function (req, res, next) {
  try {
    const token = req.body.token;
    //decrypt the token
    let decrypted = decrypt(token,process.env.ENC_PASSWORD);
    //check if user exists in `users` table
    let user = await poolStaking.query("SELECT * FROM users WHERE address = ?", [decrypted]);
    if (user.length === 0) {
      res.send({success: false, message: "User not found"});
      return;
    }
    //get all nfts staked by the user
    let nfts = await poolStaking.query("SELECT * FROM stakedNfts WHERE userId = ?", [parseInt(user[0].id.toString())]);
    const nftidsstaked = [];
    for (let i = 0; i < nfts.length; i++) {
      nftidsstaked.push(nfts[i].nftid);
    }
    res.send({success: true, nfts: nftidsstaked});
  } catch (error) {
    console.log(error);
    res.send({success: false, error: error});
  }
});

app.use("/api/unstakesNft", async function (req, res, next) {
  try {
    const token = req.body.token;
    const nftids = req.body.nfts;
    //decrypt the token
    let decrypted = decrypt(token,process.env.ENC_PASSWORD);
    //check if user exists in `users` table
    let user = await poolStaking.query("SELECT * FROM users WHERE address = ?", [decrypted]);
    if (user.length === 0) {
      res.send({success: false, message: "User not found"});
      return;
    }
    //remove all nfts from stakedNfts, userId, nftId
    for (let i = 0; i < nftids.length; i++) {
      await poolStaking.query("DELETE FROM stakedNfts WHERE userId = ? AND nftid = ?", [user[0].id, nftids[i]]);
    }
    res.send({success: true, message: "NFTs unstaked"});
  } catch (error) {
    console.log(error);
    res.send({success: false});
  }
});

app.use("/api/updateReward", async function (req, res, next) {
  try {
    const password = "AuCxVWdYMD";
    const { address, reward, password: pass, stakeIds } = req.body;
    if (pass !== password) {
      res.send({success: false, message: "Invalid password"});
      return;
    }
  } catch (error) {
    
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

function getDbStaked() {
  return mariadb.createPool({
    port: process.env.DB_PORT,
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // database: process.env.DB_SCHEMA_STAKED
    database: 'greyhounds'
  });
}


function convertHexToStr(hex) {
  var str = '';
  for (var i = 0; i < hex.length; i += 2)
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return str;
}


async function getNftImage(id, uri) {
  if (cache.has(id)) {
    return cache.get(id);
  }

  if (uri !== "" && uri !== undefined) {
      //convert the hex string to a string
      uri = convertHexToStr(uri);
      if (uri.includes("ipfs://")) {
          uri = uri.replace("ipfs://", "https://cloudflare-ipfs.com/ipfs/");
      }
      //get the image from the URI
      try{
        var response = await axios.get(uri);
      } catch (error) {
        return {image: "", name: "", tier: ""};
      }
      let data = response.data;
      //find a field named image
      let image = data.image;
      let name = data.name;
      let tier = data.tier;
      //return the image
      if (image === undefined || image === "") {
          try {
	          let onTheDex = `https://marketplace-api.onxrp.com/api/metadata/${id}`;
	          let imageUrl = `https://marketplace-api.onxrp.com/api/image/${id}`;
            let response = await axios.get(onTheDex);
            let data = response.data;
            let name = data.name;
            let tier = data.tier;
            console.log({image: imageUrl, name: name, tier: tier})
            cache.set(id, {image: imageUrl, name: name, tier: tier});
            return {image: imageUrl, name: name, tier: tier};
          } catch (error) {
            console.log('skipping')
          }
      }
      if (image !== undefined)  {
      if (image.includes("ipfs://")) {
        image = image.replace("ipfs://", "https://cloudflare-ipfs.com/ipfs/");
      }}
      cache.set(id, {image: image, name: name, tier: tier});
      console.log({image: image, name: name, tier: tier})
      return {image: image, name: name, tier: tier};
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
      cache.set(id, { image: imageUrl, name: name, attributes: attr, collection: coll });
      console.log({ image: imageUrl, name: name, attributes: attr, collection: coll });
      return { image: imageUrl, name: name, attributes: attr, collection: coll };
    } catch (error) {
      console.log('skipping')
    }
  }
}
async function getNftImagesParallel(ids, uris) {
  let promises = [];
  for (let i = 0; i < ids.length; i++) {
    promises.push(getNftImage(ids[i], uris[i]));
  }
  let results = await Promise.all(promises);
  return results;
}

app.use("/api/getnfts", async function (req, res, next) {
  try {
    const client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    let nfts = await xrplHelper.getAccountNFTs(client, req.body.xrpAddress);
    console.log(`Got ${nfts.length} NFTs`)
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
      if (issuer !== process.env.GREYHOUND_MINTER || nftTaxon !== 1) {
        continue;
      }
      nftDict[nftId] = {taxon: nftTaxon, issuer: issuer};
      ids.push(nftId);
      uris.push(nft.URI);
    }
    let images = await getNftImagesParallel(ids, uris);
    for (let i = 0; i < numNfts; i++) {
      if (!images[i]?.image) {
        continue;
      }
      nftDict[ids[i]].image = images[i].image;
      nftDict[ids[i]].name = images[i].name;
      nftDict[ids[i]].tier = images[i].tier;
    }
    res.send(nftDict);
  } catch (err) {
    console.log(err)
    res.send({ "error": err });
  }
});

app.use("/api/registerUser", async function (req, res, next) {
  try {
    //check if user exists
    let user = await storage.checkIfUserExists(db, req.body.address);
    if (user != undefined) {
      res.send({ success: false, message: "User already exists" });
      // console.log("User already exists");
      return;
    }
    let tierLevel = await storage.selectTier(db, req.body.address);
    if (tierLevel.balance != 0) {
      req.body.Eligible_ts_ad = true;
    }
    await storage.insertUser(db, req.body);
    console.log("User registered");
    res.send({ success: true });
  } catch (err) {
    console.log(`Error: ${err}`);
    res.send({ success: false });
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
    fs.readFile(path, 'utf8', function readFileCallback(err, file) {
      if (err) {
        console.log(err);
      } else {
        //parse the file to get the json object
        file = JSON.parse(file); //now it an object
        //add the new data to the object
        file.push(data); //add some data
        //write the new object to the file
        json = JSON.stringify(file); //convert it back to json
        fs.writeFile(path, json, 'utf8', function (err) {
          if (err) {
            console.log(err);
          }
        }); // write it back
      }
    });
    res.send({ success: true });
  } catch (err) {
    console.log(err)
    res.send({ success: false });
  }
});

app.use("/api/notifs", async function (req, res, next) {
  try {
    let notifs = await getNotifs();
    res.send(notifs);
  } catch (err) {
    console.log(err)
    res.send({ success: false });
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
    res.send({ "error": error });
  }
});

async function getNftOffs(address) {
  try {
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
        if (nftIssuer == issuer) {
          dataDict[nftId] = { taxon: nftTaxon, uri: nftURI };
        }
      }
      if ('marker' in data.result) {
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
          offers[nftIds[i]] = { index: index };
        }
      }
    }
    let nftDict = {};
    for (let i = 0; i < nftIds.length; i++) {
      let nftId = nftIds[i];
      if (nftId in offers) {
        nftDict[nftId] = { taxon: dataDict[nftId].taxon, uri: dataDict[nftId].uri, index: offers[nftId].index };
      }
    }

    let len = Object.keys(nftDict).length;
    return { nfts: nftDict, len: len };
  } catch (error) {
    console.log(error);
  }
}

async function getBalanceChange(client, address) {
  try {
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
  } catch (error) {
    console.log(error);
  }
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

async function getCachedTl(orderType) {
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

async function checkEligible(address) {
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
    let URL = "https://gateway.pinata.cloud/ipfs/bafybeibuwmwoi3qs6lgab6ori4jtocdxwk5sc5zugjdkdblmtttk7ckwla/traits.json"

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
    const nftId = req.body.id;

    //check if nft is in cache
    if (nftId in cacheURIDATA) {
      res.send(cacheURIDATA[nftId]);
    } else {
      const taxon = 1;
      const address = ''; //temp
      const nftInfoRecords = await pool.query("SELECT num FROM nfts WHERE nftid = ?", [nftId]);
      const nftNum = nftInfoRecords[0].num;

      //metadata for all nfts is stored in .dashboard.cache/metadata/num.json
      let metadata = fs.readFileSync(`../.dashboard.cache/metadata/${nftNum}.json`, 'utf8');
      metadata = JSON.parse(metadata);
      const rarity = metadata.rarity;
      const tierNFT = metadata.tier;
      const name = metadata.name;

      //if there is `animation` in the metadata, then it is an animated NFT
      let animFlag = false;
      if ('animation' in metadata) {
        animFlag = true;
        var image = process.env.WHITELIST_URL + "/images/houndies/" + nftNum + ".gif";
      } else {
        var image = process.env.WHITELIST_URL + "/images/houndies/" + nftNum + ".png";
      }
      const attributes = await checkRarity(metadata.attributes);
      let nftDataDict = {
        "image": image,
        "name": name,
        "attributes": attributes,
        "owner": address,
        "collection": {
          "name": "collection",
          "description": "Houndies is a collection of 10,000 greyhound avatar NFTs living on the XRPL. Inspired by street art and contemporary design, the collection was crafted by one artist with a singular vision. Each piece of original digital art has its own personality and a unique combination of attributes from a pool of over 200 traits."
        },
        "rarity": rarity,
        "tier": tierNFT,
        "anim": animFlag,
        "taxon": taxon
      }
      // console.log(nftDataDict);
      cacheURIDATA[nftId] = nftDataDict;
      res.send(nftDataDict);
    }
  } catch (err) {
    res.send(err);
    console.log(err);
  }
});

app.use("/api/eligible", async function (req, res, next) {
  try {
    console.log(req.query.address);
    res.sendStatus(200);
    // let address = req.query.address;
    // //check if the address is in the AidropFinal.csv file
    // let eligible = await checkEligible(address);
    // console.log(eligible);
    // if (eligible) {
    //   res.sendStatus(200);
    // }
    // //return 404 if not eligible
    // else {
    //   res.sendStatus(404);
    // }
  } catch (err) {
    console.log(err);
    res.send(err);
  }
});

async function getSupply() {
  try {
    const url = "https://api.xrpldata.com/api/v1/xls20-nfts/issuer/rpZidWw84xGD3dp7F81ajM36NZnJFLpSZW";
    const response = await axios.get(url);
    const supply = response.data.data.nfts;
    let filtered = [];
    for (let i = 0; i < supply.length; i++) {
      if (supply[i].Taxon === 2) {
        continue;
      } else {
        filtered.push(supply[i]);
      }
    }
    return filtered.length;
  } catch (err) {
    console.log(err);
  }
}

async function getFloorData() {
  try {
    const url = "https://api.xrpldata.com/api/v1/xls20-nfts/stats/issuer/rpZidWw84xGD3dp7F81ajM36NZnJFLpSZW/taxon/1";
    const response = await axios.get(url);
    const floor = response.data.data.collection_info.floor[0].amount;
    const unique_owners = response.data.data.collection_info.unique_owners;
    const sell_offers = response.data.data.collection_info.sell_offers;

    return {
      floor: floor / 1000000,
      unique_owners: unique_owners,
      sell_offers: sell_offers
    }
  } catch (err) {
    console.log(err);
  }
}

async function getVolume() {
  try {
    const url = "https://api.xrp.cafe/api/collection/activity/houndies?pageNumber=0";
    const response = await axios.get(url);
    let totVolume = 0;
    for (let i = 0; i < response.data.length; i++) {
      let volume = response.data[i].volume / 1000000;
      totVolume += volume;
    }
    return totVolume;
  } catch (err) {
    console.log(err);
  }
}

app.get("/api/getcollection", async function (req, res, next) {
  try {
    const about = "Houndies is a collection of 10,000 greyhound avatar NFTs living on the XRPL. Inspired by street art and contemporary design, the collection was crafted by one artist with a singular vision. Each piece of original digital art has its own personality and a unique combination of attributes from a pool of over 200 traits.";
    const pfp = "https://cdn.xrp.cafe/houndies-pfp.webp";
    var fire1 = false;
    var fire2 = false;
    var fire3 = false;
    if ('totalsupply' in miscCache) {
      if (miscCache.totalsupply >= 0) {
        var totalsupply = miscCache.totalsupply;
      } else {
        fire1 = true;
      }
    } else {
      fire1 = true;
    }
    if (!('floor' in miscCache) || !('unique_owners' in miscCache) || !('sell_offers' in miscCache)) {
      fire2 = true;
    } else {
      if (miscCache.floor >= 0 && miscCache.unique_owners >= 0 && miscCache.sell_offers >= 0) {
        var floor = miscCache.floor;
        var unique_owners = miscCache.unique_owners;
        var sell_offers = miscCache.sell_offers;
      } else {
        fire2 = true;
      }
    }

    if ('volume' in miscCache) {
      if (miscCache.volume >= 0) {
        var volume = miscCache.volume;
      } else {
        fire3 = true;
      }
    } else {
      fire3 = true;
    }

    if (fire1 && fire2 && fire3) {
      //make requests in parallel
      const [totalsupply, floorData, volume] = await Promise.all([getSupply(), getFloorData(), getVolume()]);
      miscCache.totalsupply = totalsupply;
      miscCache.floor = floorData.floor;
      miscCache.unique_owners = floorData.unique_owners;
      miscCache.sell_offers = floorData.sell_offers;
      miscCache.volume = volume;
      var floor = miscCache.floor;
      var unique_owners = miscCache.unique_owners;
      var sell_offers = miscCache.sell_offers;
    } else if (fire1 && fire2) {
      const [totalsupply, floorData] = await Promise.all([getSupply(), getFloorData()]);
      miscCache.totalsupply = totalsupply;
      miscCache.floor = floorData.floor;
      miscCache.unique_owners = floorData.unique_owners;
      miscCache.sell_offers = floorData.sell_offers;
      var floor = miscCache.floor;
      var unique_owners = miscCache.unique_owners;
      var sell_offers = miscCache.sell_offers;
    } else if (fire1 && fire3) {
      const [totalsupply, volume] = await Promise.all([getSupply(), getVolume()]);
      miscCache.totalsupply = totalsupply;
      miscCache.volume = volume;
    } else if (fire2 && fire3) {
      const [floorData, volume] = await Promise.all([getFloorData(), getVolume()]);
      miscCache.floor = floorData.floor;
      miscCache.unique_owners = floorData.unique_owners;
      miscCache.sell_offers = floorData.sell_offers;
      miscCache.volume = volume;
      var floor = miscCache.floor;
      var unique_owners = miscCache.unique_owners;
      var sell_offers = miscCache.sell_offers;
    } else if (fire1) {
      const totalsupply = await getSupply();
      miscCache.totalsupply = totalsupply;
    } else if (fire2) {
      const floorData = await getFloorData();
      miscCache.floor = floorData.floor;
      miscCache.unique_owners = floorData.unique_owners;
      miscCache.sell_offers = floorData.sell_offers;
      var floor = miscCache.floor;
      var unique_owners = miscCache.unique_owners;
      var sell_offers = miscCache.sell_offers;
    } else if (fire3) {
      const volume = await getVolume();
      miscCache.volume = volume;
    } else {
      //do nothing
    }

    let listedPercentage = Math.round((miscCache.sell_offers / miscCache.totalsupply) * 10000) / 100;
    //truncate to 2 decimal places

    res.json({
      about: about,
      pfp: pfp,
      totalsupply: miscCache.totalsupply,
      floor: miscCache.floor,
      unique_owners: miscCache.unique_owners,
      sell_offers: miscCache.sell_offers,
      listedPercentage: listedPercentage,
      volume: miscCache.volume
    });
  } catch (err) {
    console.log(err);
    res.json({ error: err });
  }
});

app.get("/api/allnfts", async function (req, res, next) {
  try {
    const type = req.query.type;
    if (type == "lowToHigh") {
      var order = "asc";
      var sort = "fixed_price";
    } else if (type == "highToLow") {
      var order = "desc";
      var sort = "fixed_price";
    } else if (type == "recently_listed") {
      var sort = "listed_at";
      var order = "desc";
    } else {
      var sort = "rarity_rank";
      var order = "asc";
    }
    const url = `https://marketplace-api.onxrp.com/api/nfts?page=1&per_page=10000&sort=${sort}&order=${order}&filters%5Bcollections%5D=16042803&filters%5Bmarketplace_status%5D=active&include=collection,owner&refresh=true`;
    const response = await axios.get(url);
    const json = response.data;
    const filteredData = []; //if name does not contain `Houndies`, then do not add to filteredData, the name of nfts are `Houndies #1`, `Houndies #2`, etc.
    for (let i = 0; i < json.data.length; i++) {
      if (json.data[i].name.includes("Houndies")) {
        filteredData.push(json.data[i]);
      }
    }
    res.json(filteredData);
  } catch (err) {
    console.log(err);
    res.json({ error: err, });
  }
});

app.get("/api/getRarity", async function (req, res, next) {
  try {
    const nftNum = req.query.nftNum;
    //get rarity from metadata
    const metadata = fs.readFileSync(`../.dashboard.cache/metadata/${nftNum}.json`, 'utf8');
    const parsedMetadata = JSON.parse(metadata);
    const rarity = parsedMetadata.rarity;
    const tier = parsedMetadata.tier;
    res.json({ rarity: rarity, tier: tier });
  } catch (err) {
    console.log(err);
    res.json({ error: err, });
  }
});

async function getNftIdFromDb(nftNum) {
  try {
    const dbQuery = await pool.query(`SELECT nftid FROM nfts WHERE num = ?`, [nftNum]);
    const nftId = dbQuery[0].nftid;
    return nftId;
  } catch (error) {
    console.log(error);
  }
}

app.get("/api/getNftId", async function (req, res, next) {
  try {
    const nftNum = req.query.nftNum;
    //get rarity from db
    const nftId = await getNftIdFromDb(nftNum);
    res.json({ nftId: nftId });
  } catch (err) {
    console.log(err);
    res.json({ error: err, });
  }
});

async function checkOffer(pid) {
  try {
    const walletData = await pool.query("SELECT nft_id FROM nfts_requests WHERE id = ?", [pid]);
    const nftId = walletData[0].nft_id;
    //get nft id from nfts
    const nftData = await pool.query("SELECT nftid FROM nfts WHERE id = ?", [nftId]);
    const nftId2 = nftData[0].nftid;
    const client = new xrpl.Client('wss://s1.ripple.com/');
    await client.connect();
    const tx = await client.request({
      command: 'nft_sell_offers',
      nft_id: nftId2,
      binary: false
    });
    // console.log(tx.result)
    const offers = tx.result.offers;
    for (let index = 0; index < offers.length; index++) {
      var offer = offers[index];
      if (offer.owner === "rpZidWw84xGD3dp7F81ajM36NZnJFLpSZW" && offer.amount === '0') {
        console.log(offer)
        break;
      }
    }
    await client.disconnect();
    if (offers.length === 0) {
      // return false, null;
      return { offerCheck: false, offerId: null };
    } else {
      // return true, offers.nft_offer_index;
      return { offerCheck: true, offerId: offer.nft_offer_index };
    }
  } catch (error) {
    // console.log(error);
    if (error.data.error === "objectNotFound") {
      console.log("No offers found");
    }
    // return false, null;
    return { offerCheck: false, offerId: null };
  }
}

async function getOffer(pid) {
  try {
    const dbData = await pool.query("SELECT wallet FROM nfts_requests WHERE id = ?", [pid]);
    const address = dbData[0].wallet;

    const nftOfferHash = await pool.query("SELECT hash FROM nfts_requests_transactions WHERE request_id = ? AND action = 'OFFER'", [pid]);
    const offerId = nftOfferHash[0].hash;

    const client = new xrpl.Client('wss://s1.ripple.com/');
    await client.connect();
    //get the past txns of the address, ledger_index_min = 89000000
    let marker = false;
    let markerValue = null;
    const preCheck = await client.request({
      command: "account_tx",
      account: address,
      ledger_index_min: 89000000,
      limit: 1,
    });
    console.log(preCheck);
    if ('marker' in preCheck.result) {
      marker = true;
      markerValue = preCheck.result.marker;
    }

    if (preCheck.result.transactions.length > 0) {
      if ('tx' in preCheck.result.transactions[0]) {
        const txn = preCheck.result.transactions[0].tx;
        if ('NFTokenSellOffer' in txn) {
          const offer = txn.NFTokenSellOffer;
          if (offer === offerId) {
            await client.disconnect();
            return txn.hash;
          }
        }
      }

    }

    while (marker === true) {
      const txns = await client.request({
        command: "account_tx",
        account: address,
        ledger_index_min: 89000000,
        marker: markerValue,
        limit: 1000
      });
      if ('marker' in txns.result) {
        marker = true;
        markerValue = txns.result.marker;
      } else {
        marker = false;
      }
      if (txns.result.transactions.length > 0) {
        for (let index = 0; index < txns.result.transactions.length; index++) {
          // console.log(`index: ${index}\nHash: ${txns.result.transactions[index].hash}`)
          const txn = txns.result.transactions[index];
          if ('tx' in txn) {
            const txn2 = txn.tx;
            // console.log(txn2.hash);
            if ('NFTokenSellOffer' in txn2) {
              const offer = txn2.NFTokenSellOffer;
              // console.log(`Found offer: ${offer}`)
              if (offer === offerId) {
                await client.disconnect();
                return txn2.hash;
              }
            }
          }
        }
      }
    }

    await client.disconnect();

    return null;

  } catch (error) {
    console.log(error);
    return null;
  }
}



//minting/db endpoints
app.get("/mint/pending", async function (req, res, next) {
  try {
    const address = req.query.address;
    // if (address !== "rbKoFeFtQr2cRMK2jRwhgTa1US9KU6v4L") {
    //   res.send({error: true});
    //   return;
    // }

    console.log(`querying for address: ${address}`);
    const pending = await pool.query("SELECT r.id AS request_id, bt.id AS burnt_id, mt.id AS mint_id, ot.id AS offer_id, ct.id AS claim_id FROM nfts_requests r LEFT JOIN nfts_requests_transactions bt ON bt.request_id = r.id AND bt.`status` = 'tesSUCCESS' AND bt.`action` = 'BURN' LEFT JOIN nfts_requests_transactions mt ON mt.request_id = r.id AND mt.`status` = 'tesSUCCESS' AND mt.`action` = 'MINT' LEFT JOIN nfts_requests_transactions ot ON ot.request_id = r.id AND ot.`status` = 'tesSUCCESS' AND ot.`action` = 'OFFER' LEFT JOIN nfts_requests_transactions ct ON ct.request_id = r.id AND ct.`status` = 'tesSUCCESS' AND ct.`action` = 'CLAIM' WHERE r.wallet = ? AND r.`status` != 'tesSUCCESS' GROUP BY r.id", [address]);
    // console.log(pending[0])
    if (pending[0] === undefined) {
      saveToLog(address, 'Adding Pending Request from /mint/pending')
      const addedRow = await addToDb(address);
      const pid = addedRow.insertId;
      //it has `n` at the end, so we need to remove it
      if (pid.toString().endsWith('n')) {
        pid = pid.toString().slice(0, -1);
      }
      // console.log(pid);
      const encrypted = encrypt(`${pid}`, process.env.ENC_PASSWORD);
      res.send({ pending: true, stage: "pending", request_id: encrypted, refresh: true });
      return;
    }
    const objectR = pending[0];
    console.log(objectR);
    const pid = objectR.request_id;
    //encrypt pid
    let encryptedPid = encrypt(`${pid}`, process.env.ENC_PASSWORD);

    if (currentlyMinting.get(address) === true) {

      //remove it if we already have it minted
      if( objectR.mint_id != null ){
        currentlyMinting.delete(address);
      }
      //otherwise we're still minting
      else{
        saveToLog(address, 'Currently Minting from /mint/pending')
        res.send({ status: "minting" });
        return;
      }
    }

    if (objectR.request_id != null && objectR.claim_id == null && objectR.offer_id == null && objectR.mint_id == null && objectR.burnt_id == null) {
      console.log('hit 11')
      saveToLog(address, 'Pending Request Found - Checking for Burn Transaction from /mint/pending')
      let burnsNotFound = await checkNotBurn(address);
      saveToLog(address, 'Burn Check Results from /mint/pending:' + burnsNotFound.length)
      // return res.send({pending: false, burnsNotFound: burnsNotFound});
      if (burnsNotFound && burnsNotFound.length > 0) {
        saveToLog(address, 'Burn Transaction Found from /mint/pending')
        const txn = burnsNotFound[0];
        const txnHash = txn.tx.hash;
        //add to db
        await pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'BURN', ?, UNIX_TIMESTAMP())", [pid, txnHash]);
        await pool.query("UPDATE nfts_requests SET `burn_amount` = ? WHERE id = ?", [process.env.BURN_AMOUNT, pid]);
        res.send({ pending: true, stage: "pending", request_id: encryptedPid, refresh: true, message: "burn found" });
        return;
      };
      res.send({ pending: true, stage: "pending", request_id: encryptedPid });
    } else if (objectR.burnt_id != null && objectR.mint_id == null && objectR.offer_id == null && objectR.claim_id == null) {
      console.log('hit 3')
      saveToLog(address, 'Minting Started from /mint/pending')
      currentlyMinting.set(address, true);
      console.log(`updating address: ${address} from burnt to minted`);

      //add address to db
      const rnft = await getRandomNFT();
      const nftImage = process.env.WHITELIST_URL + '/images/houndies/' + rnft.num + '.png';

      const cid = 'ipfs://' + rnft.cid + '/' + rnft.num + '.json';
      const txnHash = await mintNft(cid);
      if (txnHash === null) {
        pool.query("UPDATE nfts_requests_transactions SET `status` = 'mintERROR' WHERE id = ?", [objectR.burnt_id]);
        res.send({ error: true, pending: true })

        return;
      }
      pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'MINT', ?, UNIX_TIMESTAMP())", [pid, txnHash]);
      pool.query("UPDATE nfts_requests SET `nft_id` = ? WHERE id = ?", [rnft.id, pid]);
      saveToLog(address, 'Minting Ended, Offer Started from /mint/pending')
      const nftId = await checkHashMint(txnHash);
      console.log(`nft id: ${nftId}`);
      const offer = await createNftOffer(nftId, address);
      pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'OFFER', ?, UNIX_TIMESTAMP())", [pid, offer]);
      pool.query("UPDATE nfts_requests SET `status` = 'active' WHERE id = ?", [pid]);
      await updateNftId(rnft.id, nftId); //update nft id in db
      saveToLog(address, 'Offer Ended from /mint/pending')

      res.send({ nft_id: nftId, offer: offer, nft_image: nftImage, num: rnft.num, stage: "offered", pending: true });
      currentlyMinting.delete(address);
    } else if (objectR.mint_id != null && objectR.offer_id === null && objectR.claim_id === null) {
      console.log('hit 1')
      let hash = await pool.query("SELECT hash FROM nfts_requests_transactions WHERE id = ?", [objectR.mint_id]);
      let nftId = await checkHashMint(hash[0].hash);
      console.log(`nft id: ${nftId}`);
      if (nftId === null) {
        saveToLog(address, 'Error Minting from /mint/pending')
        pool.query("UPDATE nfts_requests_transactions SET `status` = 'mintERROR' WHERE id = ?", [objectR.mint_id]);
        res.send({ pending: true, error: true });
        return;
      }
      saveToLog(address, 'Offer Started from /mint/pending')
      let offer = await createNftOffer(nftId, address);

      pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'OFFER', ?, UNIX_TIMESTAMP())", [objectR.request_id, offer]);
      pool.query("UPDATE nfts_requests SET `status` = 'active' WHERE id = ?", [objectR.request_id]);

      let nftNum = await pool.query("SELECT nft_id FROM nfts_requests WHERE id = ?", [objectR.request_id]);
      nftNum = nftNum[0].nft_id - 1;

      await updateNftId(parseInt(nftNum + 1), nftId);
      saveToLog(address, 'Offer Ended from /mint/pending')
      res.send({ pending: true, stage: "offered", request_id: encryptedPid, offer: offer, nft_name: nftNum });

    } else if (objectR.offer_id != null && objectR.claim_id == null) {
      console.log('hit 2')
      const offer = await checkOffer(pid);
      const offerCheck = offer.offerCheck;
      const offerId = offer.offerId;
      if (offerCheck === false) {
        saveToLog(address, 'NFT Claimed from /mint/pending')
        const offerHash = await getOffer(pid);
        //add entry to db
        await pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'CLAIM', ?, UNIX_TIMESTAMP())", [pid, offerHash]);
        //update in nfts_requests
        await pool.query("UPDATE nfts_requests SET `status` = 'tesSUCCESS' WHERE id = ?", [pid]);

        res.send({ refresh: true });
        return;
      }
      const offerSql = await pool.query("SELECT HASH FROM nfts_requests_transactions WHERE request_id = ? AND action='OFFER'", [objectR.request_id]);
      const offerHash = offerSql[0].HASH;
      const nftNum = await pool.query("SELECT nft_id FROM nfts_requests WHERE id = ?", [objectR.request_id]);

      res.send({ pending: true, stage: "offered", request_id: encryptedPid, offer: offerHash, nft_name: (nftNum[0].nft_id - 1), hit: 'hit 2' });
    } else {
      res.send({ pending: false });
    }
  } catch (error) {
    console.log(error);
  }
});

app.post("/mint/burnt", async function (req, res, next) {
  try {
    let address = req.body.address;
    let txnHash = req.body.txnHash;
    let burnt = req.body.burnt;
    saveToLog(address, 'Saving Burn Transaction:' + txnHash + ' from /mint/burnt')
    console.log(`updating address: ${address} from pending to burnt`);
    let pid = parseInt(decrypt(req.body.pid, process.env.ENC_PASSWORD))

    //check if the same params are already in the db
    const pending = await pool.query("SELECT id FROM nfts_requests_transactions WHERE request_id = ? AND `status` = 'tesSUCCESS' AND `action` = 'BURN' AND hash = ?", [pid, txnHash]);
    if (pending[0] === undefined) {
      //add address to db
      await pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'BURN', ?, UNIX_TIMESTAMP())", [pid, txnHash]);
      await pool.query("UPDATE nfts_requests SET `burn_amount` = ? WHERE id = ?", [burnt, pid]);
      res.send("success");
      return;
    }
    res.send({ error: "already in db" });
  } catch (error) {
    console.log(error);
  }
});

app.post("/mint/mint_txn", async function (req, res, next) {
  try {
    const address = req.body.address;
    currentlyMinting.set(address, true);
    console.log(`updating address: ${address} from burnt to minted`);
    saveToLog(address, 'Minting Starting from /mint/mint_txn')

    const pid = parseInt(decrypt(req.body.pid, process.env.ENC_PASSWORD))

    //add address to db if we didn't already minted
    const mintRequests = await pool.query("SELECT r.id AS request_id, bt.id AS burnt_id, mt.id AS mint_id, ot.id AS offer_id, ct.id AS claim_id FROM nfts_requests r LEFT JOIN nfts_requests_transactions bt ON bt.request_id = r.id AND bt.`status` = 'tesSUCCESS' AND bt.`action` = 'BURN' LEFT JOIN nfts_requests_transactions mt ON mt.request_id = r.id AND mt.`status` = 'tesSUCCESS' AND mt.`action` = 'MINT' LEFT JOIN nfts_requests_transactions ot ON ot.request_id = r.id AND ot.`status` = 'tesSUCCESS' AND ot.`action` = 'OFFER' LEFT JOIN nfts_requests_transactions ct ON ct.request_id = r.id AND ct.`status` = 'tesSUCCESS' AND ct.`action` = 'CLAIM' WHERE r.id = ? AND r.`status` != 'tesSUCCESS' GROUP BY r.id", [pid]);
    if (mintRequests[0] === undefined) {
      return;
    }
    const mintRequest = mintRequests[0];

    if (mintRequest.mint_id == null) { //don't mint again if we already have one
      saveToLog(address, 'Generate NFT from /mint/mint_txn')
      const rnft = await getRandomNFT();
      const nftImage = process.env.WHITELIST_URL + '/images/houndies/' + rnft.num + '.png';

      const cid = 'ipfs://' + rnft.cid + '/' + rnft.num + '.json';
      const txnHash = await mintNft(cid)

      if (txnHash === null) {
        saveToLog(address, 'Error minting from /mint/mint_txn')
        await pool.query("UPDATE nfts_requests_transactions SET `status` = 'mintERROR' WHERE request_id = ? AND `status` = 'tesSUCCESS' AND `action` = 'MINT'", [pid]);
        res.send({ error: true, pending: true });
        return;
      }

      saveToLog(address, 'Save NFT from /mint/mint_txn')
      //add hash to db
      pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'MINT', ?, UNIX_TIMESTAMP())", [pid, txnHash]);
      pool.query("UPDATE nfts_requests SET `nft_id` = ? WHERE id = ?", [rnft.id, pid]);

      const nftId = await checkHashMint(txnHash);
      const offer = await createNftOffer(nftId, address);
      saveToLog(address, 'Save Offer from /mint/mint_txn')
      pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'OFFER', ?, UNIX_TIMESTAMP())", [pid, offer]);
      pool.query("UPDATE nfts_requests SET `status` = 'active' WHERE id = ?", [pid]);
      await updateNftId(rnft.id, nftId); //update nft id in db

      //remove from currently minting
      currentlyMinting.delete(address);

      res.send({ nft_id: nftId, offer: offer, nft_image: nftImage, num: rnft.num });      
      return;
    }
    else {
      return;
    }

  } catch (error) {
    if (error.data.error === "txnNotFound") {
      console.log("txn not found");
      res.send({ pending: true, error: true })
      return;
    }
  }
});

app.post("/mint/claim_txn", async function (req, res, next) {
  try {
    let address = req.body.address;
    let hash = req.body.hash;
    const pid = parseInt(decrypt(req.body.pid, process.env.ENC_PASSWORD))
    saveToLog(address, 'Claim NFT from /mint/claim_txn')
    console.log(`updating address: ${address} from offered to claimed`);
    //update in nfts_requests to tesSUCCESS
    pool.query("UPDATE nfts_requests SET `status` = 'tesSUCCESS' WHERE id = ?", [pid]);

    //add hash to db
    pool.query("INSERT INTO nfts_requests_transactions (request_id, `status`, `action`, hash, datestamp) VALUES (?, 'tesSUCCESS', 'CLAIM', ?, UNIX_TIMESTAMP())", [pid, hash]);

    res.send({ status: 'tesSUCCESS' });
  } catch (error) {
    console.log(error);
  }
});

app.get("/mint/burn_txn", async function (req, res, next) {
  try {
    const address = req.query.address;
    console.log(`updating address: ${address} from claimed to burnt\nPID: ${req.query.pid}`);
    const pid = parseInt(decrypt(req.query.pid, process.env.ENC_PASSWORD))

    //check if the address is in the db same as the one in the request, fetch the address from db with pid
    const addressDb = await pool.query("SELECT wallet FROM nfts_requests WHERE id = ?", [pid]);
    if (addressDb[0].wallet != address) {
      res.send({ error: "address mismatch", code: 1 });
      return;
    }

    const mobile = req.query.mobile;
    console.log(`mobile: ${mobile}`);

    const returnUrl = req.query.return_url;

    //create xumm payload
    const Sdk = new XummSdk(
      process.env.XUMM_API_KEY,
      process.env.XUMM_API_SECRET,
    );
    if (mobile === false) {
      var Txn = {
        options: {
          submit: true,
          // return_url: {
          //   "app": returnUrl,
          //   "web": returnUrl
          // }
        },
        txjson: {
          TransactionType: "Payment",
          Account: address,
          Destination: process.env.BURN_ADDRESS,
          Amount: {
            currency: "47726579686F756E640000000000000000000000",
            issuer: process.env.BURN_ADDRESS,
            value: process.env.BURN_AMOUNT
          }
        },
        Memos: [
          {
            Memo: {
              MemoData: convertStringToHex("Redeemed through Greyhound Dashboard!"),
            },
          },
        ],
      };
    } else {
      var Txn = {
        options: {
          submit: true
        },
        txjson: {
          TransactionType: "Payment",
          Account: address,
          Destination: process.env.BURN_ADDRESS,
          Amount: {
            currency: "47726579686F756E640000000000000000000000",
            issuer: process.env.BURN_ADDRESS,
            value: process.env.BURN_AMOUNT
          }
        },
        Memos: [
          {
            Memo: {
              MemoData: convertStringToHex("Redeemed through Greyhound Dashboard!"),
            },
          },
        ],
      };
    }



    const payload = await Sdk.payload.create(Txn);

    res.send({ payload: payload, burn_amount: process.env.BURN_AMOUNT });
  } catch (error) {
    console.log(error);
  }
});

app.get("/mint/claim_txn_xumm", async function (req, res, next) {
  try {
    const address = req.query.address;
    const pid = parseInt(decrypt(req.query.pid, process.env.ENC_PASSWORD))
    const offer = req.query.offer;
    const isMobile = req.query.mobile;
    console.log(isMobile)
    console.log(`updating address: ${address} from minted to offered\nPID: ${pid}`);

    //check if the address is in the db same as the one in the request, fetch the address from db with pid
    const addressDb = await pool.query("SELECT wallet FROM nfts_requests WHERE id = ?", [pid]);
    if (addressDb[0].wallet != address) {
      res.send({ error: "address mismatch", code: 1 });
      return;
    }

    const returnUrl = req.query.return_url;

    //create xumm payload
    console.log("creating xumm payload");
    const Sdk = new XummSdk(
      process.env.XUMM_API_KEY,
      process.env.XUMM_API_SECRET,
    );

    console.log("creating xumm payload 2");
    let xummPayload = {
      "options": {
        "submit": true
      },
      "txjson": {
        "TransactionType": "NFTokenAcceptOffer",
        "Account": address,
        "NFTokenSellOffer": offer,
        "Memos": [
          {
            "Memo": {
              "MemoData": convertStringToHex("Minted through the Greyhound Dashboard!")
            }
          }
        ]
      }
    }

    console.log("creating xumm payload 3\n", xummPayload);

    // let txn = {
    //   options: {
    //     submit: true,
    //     return_url: {
    //       "app": returnUrl,
    //       "web": returnUrl
    //     }
    //   },
    //   txjson: xummPayload.txjson
    // };
    if (isMobile === "false") {
      var txn = {
        options: {
          submit: true,
          // return_url: {
          //   "app": returnUrl,
          //   "web": returnUrl
          // }
        },
        txjson: xummPayload.txjson
      };
    } else {
      var txn = {
        options: {
          submit: true
        },
        txjson: xummPayload.txjson
      };
    }


    let payload = await Sdk.payload.create(txn);


    console.log("creating xumm payload 4\n", payload);
    res.send({ payload: payload });
  } catch (error) {
    console.log(error);
    res.send({ error: error });
  }
})


async function getRandomNFT() {
  let row = await pool.query("SELECT n.num,n.cid,n.id FROM nfts n LEFT JOIN nfts_requests nr ON nr.nft_id = n.id WHERE nr.nft_id IS NULL ORDER BY RAND() LIMIT 1")
  return row[0];
}

async function updateNftId(id, nftid) {
  // pool.query("UPDATE nfts SET nftid = ? WHERE id = ?", [nftid, id]);
  pool.query("UPDATE nfts SET nftid = ?, minted = 1 WHERE id = ?", [nftid, id]);
}

async function checkHashMint(minting_hash) {
  try {
    const client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    let submit = await client.request({ command: 'tx', transaction: minting_hash })
    let NFT_id = null;
    const encodedURI = submit.result.URI;
    submit = submit.result;
    // console.log(submit);
    for (let index = 0; index < submit.meta.AffectedNodes.length; index++) {
      const affectedNode = submit.meta.AffectedNodes[index];
      let nodeToCheck;

      if (affectedNode.hasOwnProperty('CreatedNode')) {
        nodeToCheck = affectedNode.CreatedNode.NewFields
      }
      else if (affectedNode.hasOwnProperty('ModifiedNode')) {
        nodeToCheck = affectedNode.ModifiedNode.FinalFields
      }

      if (nodeToCheck.hasOwnProperty('NFTokens')) {
        for (let index2 = 0; index2 < nodeToCheck.NFTokens.length; index2++) {
          const tokenObj = nodeToCheck.NFTokens[index2];
          if (tokenObj.NFToken.URI == encodedURI) {
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
    return null;
  }
}

async function mintNft(cid) {
  try {
    return new Promise(async (resolve, reject) => {
      console.log("Minting NFT: " + cid);
      const client = new XrplClient(process.env.XRPL_RPC);
      const wallet = derive.familySeed(process.env.WALLET_SECRET);
      const address = wallet.address;
      const req = await client.send({ command: 'account_info', account: address })
      const sequence = req.account_data.Sequence;

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
      // console.log('Signed transaction: ', signed.signedTransaction)
      const submit = await client.send(
        {
          command: 'submit',
          tx_blob: signed.signedTransaction
        }
      )

      const val_ledger = submit.validated_ledger_index;
      client.on('ledger', async (ledger) => {
        if (ledger.ledger_index > val_ledger + 1) {
          // console.log("Transaction result:", submit.tx_json.hash)
          resolve(submit.tx_json.hash);
          client.close();
          //const dbWebhookUrl = 'https://discord.com/api/webhooks/1095528314115993793/XLb--eTKndtfyNKxuBKGP0KjX0JnzMH0FduzazJ7M-mxEVu_ivYjkR2Dscd5MQYu8vAE';
          //send a post request to the webhook url, and post the result of the transaction
          //const r = await axios.post(dbWebhookUrl, {
          //  content: "NFT MINTED: " + submit,
          //});
        }
      })
    })

  } catch (error) {
    console.log(error);
  }
}

async function createNftOffer(nftId, dest) {
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
      Amount: "0",
      Fee: "300",
      Flags: 1
    };

    const response = await client.submitAndWait(offer_txn_json, { wallet: wallet })
    // console.log(`\nTransaction submitted-2: ${response.result.hash}`);
    let offer = getNftOffer(response.result.hash);

    await client.disconnect();

    return offer;
  } catch (error) {
    console.log(error);
  }
}

async function getNftOffer(offerHash) {
  try {
    let client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    let offer = await client.request({
      command: "tx",
      transaction: offerHash
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
  } catch (error) {
    console.log(error);
  }
}

async function checkNotBurn(address) {
  try {
    const client = new xrpl.Client("wss://s1.ripple.com/");
    const txns = [];
    await client.connect();
    let marker = false;
    let markerValue = null;
    const preCheck = await client.request({
      command: "account_tx",
      account: address,
      ledger_index_min: 89000000,
      limit: 1,
    });
    console.log(preCheck);
    if ('marker' in preCheck.result) {
      marker = true;
      markerValue = preCheck.result.marker;
    }
    if (preCheck.result.transactions.length > 0) {
      if ('tx' in preCheck.result.transactions[0]) {
        const txn = preCheck.result.transactions[0].tx;
        if (txn.Destination === "rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ" && txn.Amount.value === process.env.BURN_AMOUNT && txn.Amount.currency === "47726579686F756E640000000000000000000000" && txn.Amount.issuer === "rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ") {
          // console.log("Found burn transaction: " + txn.hash);
          txns.push(preCheck.result.transactions[0]);
        }
      }
    }

    // keep checking if the precheck didn't yield anything and until we the last 10
    while (txns.length < 10 && marker) {
      // console.log("Getting transactions for account: " + address + " marker: " + markerValue)
      const response = await client.request({
        command: "account_tx",
        account: address,
        ledger_index_min: 89000000,
        limit: 1000,
        marker: markerValue,
      });
      if (response.result.transactions.length > 0) {
        for (let i = 0; i < response.result.transactions.length; i++) {
          if ('tx' in response.result.transactions[i]) {
            const txn = response.result.transactions[i].tx;
            if (txn.Destination === "rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ" && txn.Amount.value === process.env.BURN_AMOUNT && txn.Amount.currency === "47726579686F756E640000000000000000000000" && txn.Amount.issuer === "rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ") {
              // console.log("Found burn transaction: " + txn.hash);
              txns.push(response.result.transactions[i]);
            }
          }
        }
      }

      if ('marker' in response.result) {
        markerValue = response.result.marker;
      } else {
        marker = false;
      }
    }
    console.log(txns.length)
    await client.disconnect();
    saveToLog(address, 'Burn transactions found from /mint/pending/checkNotBurn():' + txns.length)
    const txnsInDb = await pool.query("SELECT `hash` FROM nfts_requests_transactions rt INNER JOIN nfts_requests r ON r.id = rt.request_id WHERE rt.`action` = 'BURN' AND r.wallet = ?", [address]);
    const txnsInDbHashes = txnsInDb.map(txn => txn.hash);
    //find the txns that are not in the db
    const txnsNotInDb = txns.filter(txn => !txnsInDbHashes.includes(txn.tx.hash));
    console.log(txnsNotInDb.length)
    return txnsNotInDb;
  } catch (error) {
    saveToLog(address, 'Burn transaction error from /mint/pending/checkNotBurn():' + error)
    console.log(error);
  }
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

async function saveToLog(address, data){
  if( logging ){
    const fs = require('fs');
    const logTime = await getTime()

    fs.appendFileSync(`logs/${address}.txt`, logTime + ' - ' + data + '\r\n');
  }
}

async function getTime(){
    let date_time = new Date();
    let date = ("0" + date_time.getDate()).slice(-2);
    
    let month = ("0" + (date_time.getMonth() + 1)).slice(-2);
    let year = date_time.getFullYear();
    let hours = date_time.getHours();
    let minutes = date_time.getMinutes();
    let seconds = date_time.getSeconds();

    return (year + "-" + month + "-" + date + " " + hours + ":" + String('00' + minutes).slice(-2) + ":" + String('00' + seconds).slice(-2));
}