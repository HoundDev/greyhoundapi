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
    // let GreyHoundAmount = await storage.selectGreyHoundSum(db);
    // let tierLevel = await storage.selectTier(db, req.body.xrpAddress);
    // let transactions = await xrplHelper.getAccountTransactions(client,req.body.xrpAddress);
    // let account_info = await xrplHelper.getAccountLines(client,process.env.GREYHOUND_ISSUER);
    // let account_lines = await xrplHelper.getAccountLines(client,req.body.xrpAddress);
    // let xrp_balance = await xrplHelper.getBalance(client,req.body.xrpAddress);
    // let tx_fees = await xrplHelper.getTransactionFee(client);
    // let xrpprices = await xrplHelper.getTokenPrice('XRP', 'USD.rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq');
    // let ghprices = await xrplHelper.getTokenPrice('Greyhound.rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ', 'XRP');
    // let curGh = await xrplHelper.getLiveTokenPrice('Greyhound.rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ', 'XRP');
    // let curXrp = await xrplHelper.getLiveXrpPrice();
    // get all data in parallel
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
    res.send({});
  }
});

app.use("/api/getnfts", async function (req, res, next) {
  try {
    const client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    let nfts = await xrplHelper.getAccountNFTs(client, req.body.xrpAddress);
    await client.disconnect();
    res.send(nfts);
  } catch(err) {
    console.log(err)
    res.send({});
  }
});

app.use("/api/registerUser", async function (req, res, next) {
  try {
    //check if user exists
    let user = await storage.checkIfUserExists(db,req.body.address);
    if (user != undefined)
    {
      res.send({success: false, message: "User already exists"});
      console.log("User already exists");
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

async function getBalanceChange(address) {
  const client = new xrpl.Client('wss://xrplcluster.com');
  const time = Math.floor(Date.now() / 1000);
  let time30dayBefore = time - 2592000;
  let URL = 'https://s1.xrplmeta.org/ledger?time=' + time30dayBefore;
  let response = await axios.get(URL);
  let ledger = response.data.sequence;
  console.log(ledger);
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