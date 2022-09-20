const axios = require('axios').default;
const sqlite3 = require('sqlite3').verbose();

const url = 'https://api.xrpscan.com/api/v1/account/rJWBaKCpQw47vF4rr7XUNqr34i4CoXqhKJ/trustlines'
const dataDict = {};
const response = axios.get(url)
.then(function (response) {
  for (var i = 0; i < response.data.length; i++) {
    //address
    dataDict[response.data[i].specification.counterparty] = response.data[i].state.balance * -1;
  }
  //sort descending
  var sortable = [];
  for (var vehicle in dataDict) {
    sortable.push([vehicle, dataDict[vehicle]]);
  }
  sortable.sort(function(a, b) {
    return b[1] - a[1];
  });
  console.log(sortable);
  //insert into db
  let db = new sqlite3.Database('storage.db', (err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Connected to the storage database.');
  });
  db.serialize(function() {
    db.run("CREATE TABLE IF NOT EXISTS richlist (id INTEGER PRIMARY KEY AUTOINCREMENT,xrpAddress TEXT NOT NULL,balance REAL NOT NULL,LastUpdated INTEGER NOT NULL)");
    db.run("DELETE FROM richlist");
    var stmt = db.prepare("INSERT INTO richlist (xrpAddress,balance,LastUpdated) VALUES (?,?,?)");
    for (var i = 0; i < sortable.length; i++) {
      stmt.run(sortable[i][0], sortable[i][1], Date.now());
    }
    stmt.finalize();
  });
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Close the database connection.');
  });
})