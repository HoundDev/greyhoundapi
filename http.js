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
const e = require("express");
const paginate = require("jw-paginate");
require("dotenv").config();

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
    res.send({ pager, pageOfItems, sum });
  } catch {}
});


app.use("/api/mainData", async function (req, res, next) {
  try {
    const client = new xrpl.Client(process.env.XRPL_RPC);
    await client.connect();
    let GreyHoundAmount = await storage.selectGreyHoundSum(db);
    let tierLevel = await storage.selectTier(db, req.body.xrpAddress);
    let transactions = await xrplHelper.getAccountTransactions(client,req.body.xrpAddress);
    let account_info = await xrplHelper.getAccountLines(client,process.env.GREYHOUND_ISSUER);
    let account_lines = await xrplHelper.getAccountLines(client,req.body.xrpAddress);
    const responsePayload = {
      GreyHoundAmount: GreyHoundAmount,
      Transactions: transactions,
      Account_Info: account_info,
      Account_Lines: account_lines,
      UserTier: tierLevel
    }
    await client.disconnect();
    res.send(responsePayload);
  } catch(err) {
    console.log(err)
    res.send({});
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
