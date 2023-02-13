var xrpl = require("xrpl");
const Storage = require("./storage.js");
require("dotenv").config();

var throttle = 5
var data = [];

const accountLinesRequest = {
    command: "account_lines",
    account: process.env.GREYHOUND_ISSUER,
    limit: 1000
  };
  
  async function getAccountLines(client, marker) {
    let request = accountLinesRequest;
    if (marker != undefined) {
      request.marker = marker;
    }
    const response = await client.request(request);
    return response.result;
  }


  function AddLines(lines, db, storage) {
    for (let i = 0; i < lines.length; i++) {
         storage.insertRichListTemp(db,lines[i].address,lines[i].balance,lines[i].date);
         var date = storage.formatDate(new Date());
         storage.insertRichListArchive(db,lines[i].address,lines[i].balance,date);
    }
  }

  function ProcessData(lines) {
    for (let i = 0; i < lines.length; i++) {
      //console.log(Math.round(+lines[i].balance * -1))
      data.push({ address: lines[i].account, balance: lines[i].balance * -1, date: Math.floor(Date.now() / 1000) });
    }
  }

async function main() {
    const client = new xrpl.Client(process.env.XRPL_RPC);
    var storage = new Storage();
    var db = storage.getInstance();
  try {
    let marker = undefined;
    let totalAccountLines = 0;
    await client.connect();
    let accountTx = await getAccountLines(client, marker);
    totalAccountLines = accountTx.lines.length;
    console.log(
      "Found " + totalAccountLines + " Total Account Lines...Processing"
    );
    marker = accountTx.marker;
    ProcessData(accountTx.lines);
    while (marker != undefined) {
      await new Promise((r) => setTimeout(r, throttle * 1000));
      accountTx = await getAccountLines(client, marker);
      totalAccountLines = totalAccountLines + accountTx.lines.length;
      console.log(
        "Found " + totalAccountLines + " Total Account Lines...Processing"
      );
      ProcessData(accountTx.lines);
      marker = accountTx.marker;
    }

    //sort desc
    //data = data.sort((a, b) => b.balance - a.balance);
    console.log('Delete RichlistTemp')
    storage.deleteTable(db,'RichListTemp');
    console.log('Add Lines')
    AddLines(data,db,storage);
    console.log('Delete Richlist')
    await storage.deleteTable(db,'RichList');
    console.log('Copy Tables')
    await storage.copyTempToRichList(db);
    console.log('Done')
    await client.disconnect();

  } catch (err) {
    console.log(err);
  }
}

//test()
main();