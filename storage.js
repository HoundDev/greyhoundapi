const sqlite3 = require("sqlite3").verbose();
const fs = require('fs'); 
const { parse } = require('csv-parse');
const moment = require('moment');

class Storage {
  createDatabase() {
    var newdb = new sqlite3.Database("./storage.db", (err) => {
      if (err) {
        console.log("Getting error " + err);
        exit(1);
      }
      this.createTables(newdb);
    });
    return newdb;
  }

  readSnapshotData(db, filename) {
    var csvData=[];
    fs.createReadStream(filename)
    .pipe(parse({delimiter: ','}))
    .on('data', function(csvrow) {
        csvData.push(csvrow);
    })
    .on('end',function() {
      var s = new Storage();
      for(let i = 0; i<csvData.length;i++){
        if(csvData[i][1] != 'balance')
        {
          s.insertSnapshotRecord(db,csvData[i][0],csvData[i][1], 1);
        }
      }

    });
  }

  formatDate(dt)
  {
    return moment(dt).format("YYYY-MM-DD");
  }

  createTables(newdb) {
    newdb.exec(
      `
    CREATE TABLE IF NOT EXISTS Session (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          xrpAddress TEXT NOT NULL,
          sessionID TEXT NOT NULL,
          LoginDateTime INTEGER NOT NULL
      );
      
    CREATE TABLE IF NOT EXISTS RichList (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        xrpAddress TEXT NOT NULL,
        balance REAL NOT NULL,
        LastUpdated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS RichListArchive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      xrpAddress TEXT NOT NULL,
      balance REAL NOT NULL,
      Date TEXT NOT NULL
  );

    CREATE TABLE IF NOT EXISTS RichListTemp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        xrpAddress TEXT NOT NULL,
        balance REAL NOT NULL,
        LastUpdated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        xrpAddress TEXT NOT NULL,
        balance REAL NOT NULL,
        snapshotid INTEGER NOT NULL
    );
      `,
      () => {}
    );
  }

  getInstance() {
    return new sqlite3.Database(
      "./storage.db",
      sqlite3.OPEN_READWRITE,
      (err) => {
        if (err && err.code == "SQLITE_CANTOPEN") {
          console.log(err);
          return;
        } else if (err) {
          console.log("Getting error " + err);
          exit(1);
        }
      }
    );
  }


  insertSnapshotRecord(db, xrpAddress, balance, snapshotId) {
    db.run(
      `INSERT INTO Snapshot(xrpAddress,balance,snapshotid) select ?,?,? WHERE (SELECT COUNT(*) FROM Snapshot WHERE xrpAddress = ?) = 0`,
      [
        xrpAddress,
        balance,
        snapshotId,
        xrpAddress
      ]
    );
  }

  insertNewSession(db, xrpAddress, sessionID, LoginDateTime) {
    db.run(
      `INSERT INTO Session(xrpAddress,sessionID,LoginDateTime) select ?,?,? WHERE (SELECT COUNT(*) FROM Session WHERE xrpAddress = ?) = 0`,
      [
        xrpAddress,
        sessionID,
        LoginDateTime,
        xrpAddress
      ]
    );
  }

  updateSession(db, xrpAddress, sessionID, LoginDateTime) {
    try {
      db.run(
        `UPDATE Session SET sessionID = ?, LoginDateTime = ? WHERE xrpAddress = ?`,
        [sessionID, LoginDateTime, xrpAddress]
      );
    } catch (err) {
      console.log(err);
    }
  }

   copyTempToRichList(db) {
    db.run(
      `INSERT INTO RichList(xrpAddress,balance,LastUpdated) select xrpAddress,balance,LastUpdated from RichListTemp order by balance desc`,
      [
      ]
    );
  }

  copyTempToRichListDaily(db) {
    db.run(
      `INSERT INTO RichListArchive(xrpAddress,balance,Date) select xrpAddress,balance,LastUpdated from RichListTemp order by balance desc`,
      [
      ]
    );
    db.run(
      `INSERT INTO RichList(xrpAddress,balance,LastUpdated) select xrpAddress,balance,LastUpdated from RichListTemp order by balance desc`,
      [
      ]
    )
  }

   insertRichList(db, xrpAddress, balance, LastUpdated) {
    db.run(
      `INSERT INTO RichList(xrpAddress,balance,LastUpdated) select ?,?,?`,
      [
        xrpAddress,
        balance,
        LastUpdated
      ]
    );
  }

  insertRichListArchive(db, xrpAddress, balance, date) {
    db.run(
      `INSERT INTO RichListArchive(xrpAddress,balance,Date) select ?,?,? WHERE (SELECT COUNT(*) FROM RichListArchive WHERE xrpAddress = ? AND Date = ?) = 0`,
      [
        xrpAddress,
        balance,
        date,
        xrpAddress,
        date
      ]
    );
  }

   insertRichListTemp(db, xrpAddress, balance, LastUpdated) {
    db.run(
      `INSERT INTO RichListTemp(xrpAddress,balance,LastUpdated) select ?,?,?`,
      [
        xrpAddress,
        balance,
        LastUpdated
      ]
    );
  }

   deleteTable(db, tableName) {
    db.run(
      `DELETE FROM ` + tableName + `;`,
      []
    );
    db.run(
      `UPDATE SQLITE_SEQUENCE SET SEQ=0 WHERE NAME='` + tableName + `';`,
      []
    );
  }

  async selectSession(db, xrpAddress) {
    return new Promise(function (resolve, reject) {
      let sql = `SELECT sessionID FROM Session WHERE xrpAddress = ? `;
      let returnVal = undefined;

      try {
        db.all(sql, [xrpAddress], (err, rows) => {
          if (err) {
            console.log("Record Exists Error: " + err);
          }
          if (rows.length > 0) {
            resolve(rows);
          } else {
            resolve([]);
          }
        });
      } catch (err) {
        console.log(err);
      }
    });
  }

  async selectRichList(db) {
    return new Promise(function (resolve, reject) {
      let sql = `SELECT * FROM RichList ORDER BY ID asc`;
      let returnVal = undefined;

      try {
        db.all(sql, [], (err, rows) => {
          if (err) {
            console.log("Record Exists Error: " + err);
          }
          if (rows.length > 0) {
            resolve(rows);
          } else {
            resolve([]);
          }
        });
      } catch (err) {
        console.log(err);
      }
    });
  }

  async selectRichListArchive(db) {
    return new Promise(function (resolve, reject) {
      let yesterdayDt = new Date();
      yesterdayDt.setDate(yesterdayDt.getDate() - 1);
      let yesterday = moment(yesterdayDt).format("YYYY-MM-DD");
      let sql = `SELECT * FROM RichListArchive WHERE Date = ? ORDER BY ID asc`;
      let returnVal = undefined;

      try {
        db.all(sql, [yesterday], (err, rows) => {
          if (err) {
            console.log("Record Exists Error: " + err);
          }
          if (rows.length > 0) {
            resolve(rows);
          } else {
            resolve([]);
          }
        });
      } catch (err) {
        console.log(err);
      }
    });
  }

  async selectRank(db,xrpAddress) {
    return new Promise(function (resolve, reject) {
      let sql = `SELECT id FROM RichList WHERE xrpAddress = ? `;
      let returnVal = undefined;

      try {
        db.all(sql, [xrpAddress], (err, rows) => {
          if (err) {
            console.log("Record Exists Error: " + err);
          }
          if (rows.length > 0) {
            resolve(rows[0].id);
          } else {
            resolve([]);
          }
        });
      } catch (err) {
        console.log(err);
      }
    });
  }

  async selectGreyHoundSum(db) {
    return new Promise(function (resolve, reject) {
      let sql = `SELECT SUM(balance) as sum FROM RichList`;
      let returnVal = undefined;

      try {
        db.all(sql, [], (err, rows) => {
          if (err) {
            console.log("Record Exists Error: " + err);
          }
          if (rows.length > 0) {
            resolve(rows);
          } else {
            resolve([]);
          }
        });
      } catch (err) {
        console.log(err);
      }
    });
  }


  async selectTier(db, xrpAddress) {
    return new Promise(function (resolve, reject) {
      let sql = `SELECT balance FROM Snapshot WHERE xrpAddress = ? LIMIT 1`;
      let returnVal = undefined;

      try {
        db.all(sql, [xrpAddress], (err, rows) => {
          if (err) {
            console.log("Record Exists Error: " + err);
          }
          console.log(rows)
          if (rows.length > 0) {
            var bal = rows[0].balance;
            if(bal >= 100000000 && bal < 250000000)
            {
              resolve({ tier: 'Standard', balance: bal});
            }
            if(bal >= 250000000 && bal < 500000000)
            {
              resolve({ tier: 'Rare', balance: bal});
            }
            if(bal >= 500000000 && bal < 1000000000)
            {
              resolve({ tier: 'Elite', balance: bal});
            }
            if(bal >= 1000000000)
            {
              resolve({ tier: 'Legendary', balance: bal});
            }

            resolve({ tier: 'None', balance: 0});
          } else {
            resolve({ tier: 'None', balance: 0});
          }
        });
      } catch (err) {
        console.log(err);
      }
    });
  }


   generateUUID() { // Public Domain/MIT
    var d = new Date().getTime();//Timestamp
    var d2 = ((typeof performance !== 'undefined') && performance.now && (performance.now()*1000)) || 0;//Time in microseconds since page-load or 0 if unsupported
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16;//random number between 0 and 16
        if(d > 0){//Use timestamp until depleted
            r = (d + r)%16 | 0;
            d = Math.floor(d/16);
        } else {//Use microseconds since page-load if supported
            r = (d2 + r)%16 | 0;
            d2 = Math.floor(d2/16);
        }
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}



}

module.exports = Storage;
