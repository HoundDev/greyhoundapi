var xrpl = require("xrpl");
const Storage = require("./storage.js");
require("dotenv").config();

var throttle = 5
var data = [];

const accountLinesRequest = {
    command: "account_lines",
    account: process.env.GREYHOUND_ISSUER,
    limit: 400
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
    }
  }

  function ProcessData(lines) {
    for (let i = 0; i < lines.length; i++) {
      data.push({ address: lines[i].account, balance: lines[i].balance * -1, date: Math.floor(Date.now() / 1000) });
    }
  }

async function main() {
    const client = new xrpl.Client("wss://s1.ripple.com");
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
    data.sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance));
    storage.deleteTable(db,'RichListTemp');
    AddLines(data,db,storage);
    storage.deleteTable(db,'RichListDaily');
    storage.copyTempToRichListDaily(db);


  } catch (err) {
    console.log(err);
  } finally {
    await client.disconnect();
  }
  return;
}

main();